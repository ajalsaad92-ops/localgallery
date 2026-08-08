/**
 * Telegram sync engine — personal account (MTProto) only.
 *
 * Reads device assets that have not been uploaded yet, sends them to the
 * channel the user picked, then marks them synced and (optionally) frees the
 * local blob. Nothing leaves the device except the upload to Telegram.
 *
 * Designed to keep running while the app is in the background: the Android
 * foreground service stays alive for the whole queue and pings this module on
 * a heartbeat, because the WebView throttles its own timers once backgrounded.
 */
import {
  photoDb,
  contentKeyOf,
  DEFAULT_SYNC_SETTINGS,
  type MediaAsset,
  type SyncSettings,
} from "@/lib/photoDb";
import {
  notify,
  startSyncForegroundService,
  updateSyncForegroundService,
  stopSyncForegroundService,
} from "@/lib/native";
import { Network } from "@capacitor/network";
import { buildCaption, parseNameTs } from "@/lib/captionMeta";

/** Best-known original capture time for a device asset. */
function originalDateOf(a: MediaAsset): number {
  return a.exif?.dateTaken ?? parseNameTs(a.name) ?? a.date ?? a.createdAt ?? Date.now();
}

const SETTINGS_KEY = "syncSettings";

export async function getSyncSettings(): Promise<SyncSettings> {
  const raw = await photoDb.kv.get(SETTINGS_KEY);
  if (!raw?.value) return DEFAULT_SYNC_SETTINGS;
  try {
    return { ...DEFAULT_SYNC_SETTINGS, ...JSON.parse(raw.value) };
  } catch {
    return DEFAULT_SYNC_SETTINGS;
  }
}

export async function setSyncSettings(patch: Partial<SyncSettings>) {
  const cur = await getSyncSettings();
  const next = { ...cur, ...patch };
  await photoDb.kv.put({ key: SETTINGS_KEY, value: JSON.stringify(next) });
  return next;
}

// --- Live progress subscription ---------------------------------------------
export interface SyncProgress {
  running: boolean;
  total: number;
  done: number;
  failed: number;
  currentName?: string;
  /** 0..1 for the file currently uploading. */
  currentFraction?: number;
  lastError?: string;
}

let progress: SyncProgress = { running: false, total: 0, done: 0, failed: 0 };
const listeners = new Set<(p: SyncProgress) => void>();

export function subscribeSync(cb: (p: SyncProgress) => void): () => void {
  listeners.add(cb);
  cb(progress);
  return () => listeners.delete(cb);
}

function emit(patch: Partial<SyncProgress>) {
  progress = { ...progress, ...patch };
  listeners.forEach((cb) => cb(progress));
}

async function isOnline(): Promise<boolean> {
  try {
    return (await Network.getStatus()).connected;
  } catch {
    return typeof navigator === "undefined" ? true : navigator.onLine;
  }
}

async function isWifi(): Promise<boolean> {
  try {
    const s = await Network.getStatus();
    return s.connected && s.connectionType === "wifi";
  } catch {
    return true;
  }
}

/** Read the bytes for one asset, from IndexedDB or the MediaStore URI. */
async function readBlob(asset: MediaAsset): Promise<Blob> {
  if (asset.blob) return asset.blob;
  if (!asset.localUri) throw new Error(`لا يوجد ملف محلي للرفع: ${asset.name}`);

  // Videos come from content:// URIs proxied by the WebView, where fetch()
  // sometimes returns an empty body — XHR handles those streams correctly.
  try {
    const response = await fetch(asset.localUri);
    if (response.ok) {
      const b = await response.blob();
      if (b.size > 0) return b;
    }
  } catch {
    /* fall through to XHR */
  }

  const b = await new Promise<Blob | null>((resolve) => {
    try {
      const xhr = new XMLHttpRequest();
      xhr.open("GET", asset.localUri!);
      xhr.responseType = "blob";
      xhr.onload = () => resolve(xhr.status < 400 ? (xhr.response as Blob) : null);
      xhr.onerror = () => resolve(null);
      xhr.send();
    } catch {
      resolve(null);
    }
  });
  if (b && b.size > 0) return b;
  throw new Error(`تعذّر قراءة الملف المحلي: ${asset.name}`);
}

async function uploadOne(
  asset: MediaAsset,
  freeBlob: boolean,
  onFraction: (f: number) => void,
) {
  const { uploadToTarget } = await import("@/lib/providers/mtproto");
  const blob = await readBlob(asset);
  const file = new File([blob], asset.name, {
    type: asset.mime || blob.type || "application/octet-stream",
  });
  const key = asset.contentKey ?? contentKeyOf(asset);
  const res = await uploadToTarget(
    file,
    onFraction,
    buildCaption(asset.name, originalDateOf(asset), key),
  );

  const patch: Partial<MediaAsset> = {
    // provider stays "device". Flipping it made the same photo appear twice in
    // the channel tab — once as the local row, once as the imported message.
    syncedAt: Date.now(),
    remoteMessageId: res.messageId,
    remoteChatId: res.chatId,
    contentKey: key,
  };
  // freeBlobAfterSync is about the IndexedDB copy. Native items never had one
  // — their bytes live in the phone gallery — so clearing localUri would only
  // hide the photo from the device tab and make "reclaim space" impossible.
  if (freeBlob) patch.blob = undefined;
  await photoDb.assets.update(asset.id, patch);
}

/**
 * Has this file already reached *this* channel?
 *
 * `syncedAt` alone is not enough: it only says the file went somewhere. Pick a
 * different channel and every photo still looked uploaded, so nothing was sent
 * and the new channel stayed empty while the counters claimed otherwise.
 */
function isInChannel(a: MediaAsset, chatId: string): boolean {
  return a.syncedAt != null && a.remoteChatId === chatId;
}

/** Device assets still waiting to reach the selected channel. */
export async function pendingCount(): Promise<number> {
  const { getSavedTarget } = await import("@/lib/providers/mtproto");
  const target = await getSavedTarget();
  const rows = await photoDb.assets.where("provider").equals("device").toArray();
  return rows.filter(
    (a) => (a.blob || a.localUri) && !(target && isInChannel(a, target.id)),
  ).length;
}

/** Runs tasks with a bounded number in flight, plus a cap on bytes in memory. */
export async function runPool<T>(
  items: T[],
  sizeOf: (item: T) => number,
  worker: (item: T) => Promise<void>,
  opts: { concurrency: number; maxBytesInFlight: number; stop: () => boolean },
) {
  let next = 0;
  let bytesInFlight = 0;
  const active = new Set<Promise<void>>();

  const launch = (item: T) => {
    const bytes = sizeOf(item);
    bytesInFlight += bytes;
    const p = worker(item).finally(() => {
      bytesInFlight -= bytes;
      active.delete(p);
    });
    active.add(p);
  };

  while (next < items.length && !opts.stop()) {
    const item = items[next];
    const bytes = sizeOf(item);
    // Always allow one, otherwise a single huge file would deadlock the pool.
    const room =
      active.size === 0 ||
      (active.size < opts.concurrency && bytesInFlight + bytes <= opts.maxBytesInFlight);
    if (!room) {
      await Promise.race(active);
      continue;
    }
    next++;
    launch(item);
  }
  await Promise.all(active);
}

export async function runSyncCycle(): Promise<{ processed: number; failed: number }> {
  if (progress.running) return { processed: 0, failed: 0 };

  // Cheap indexed count first. An armed-but-idle app ticks every few seconds
  // and must not deserialize the whole library each time.
  if ((await photoDb.assets.where("provider").equals("device").count()) === 0) {
    return { processed: 0, failed: 0 };
  }

  const settings = await getSyncSettings();
  if (settings.paused) return { processed: 0, failed: 0 };
  if (!(await isOnline())) return { processed: 0, failed: 0 };
  if (settings.wifiOnly && !(await isWifi())) return { processed: 0, failed: 0 };

  const { getSavedTarget } = await import("@/lib/providers/mtproto");
  const target = await getSavedTarget();
  if (!target) return { processed: 0, failed: 0 };

  // Claim the run before the slow client acquisition — a reconnect can take
  // minutes and ticks keep arriving throughout.
  //
  // Everything below is inside try/finally. The flag used to be raised before
  // an unguarded stretch of database work: one throw there left it up forever,
  // so every later cycle exited at the guard above and uploading simply
  // stopped until the app was restarted.
  emit({ running: true });
  let done = 0;
  let failed = 0;

  try {
    const { getClient, resetClient } = await import("@/lib/providers/mtproto");
    const client = await getClient().catch(() => null);
    if (!client) return { processed: 0, failed: 0 };

    const allAssets = await photoDb.assets.toArray();

    // Only what is in THIS channel counts as uploaded. Picking a different
    // channel has to start its own backup rather than inherit the last one's,
    // which is why an empty channel used to stay empty while the counters
    // insisted everything was already done.
    const here = new Set(
      allAssets
        .filter(
          (a) =>
            (a.provider === "telegram-remote" && a.remoteChatId === target.id) ||
            isInChannel(a, target.id),
        )
        .map((a) => a.contentKey ?? contentKeyOf(a)),
    );

    const candidates = allAssets.filter(
      (a) => a.provider === "device" && (a.blob || a.localUri) && !isInChannel(a, target.id),
    );

    const queue: MediaAsset[] = [];
    for (const a of candidates) {
      const key = a.contentKey ?? contentKeyOf(a);
      if (here.has(key)) {
        // Already in this channel under another id — adopt it, don't resend.
        await photoDb.assets.update(a.id, {
          syncedAt: Date.now(),
          remoteChatId: target.id,
          blob: undefined,
          contentKey: key,
        });
        continue;
      }
      here.add(key);
      queue.push(a);
    }
    if (queue.length === 0) return { processed: 0, failed: 0 };

    emit({
      running: true, total: queue.length, done: 0, failed: 0,
      currentName: undefined, currentFraction: undefined, lastError: undefined,
    });
    void startSyncForegroundService("جارٍ رفع صورك", `0 / ${queue.length}`);

    let abort = false;
    const fractions = new Map<string, number>();
    const report = () => {
      // Several files are in flight, so the shown percentage is their mean.
      const vals = [...fractions.values()];
      emit({
        done, failed,
        currentFraction: vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : undefined,
      });
    };

    await runPool(
      queue,
      (a) => Math.max(a.size || 0, 1),
      async (asset) => {
        const now = await getSyncSettings();
        if (now.paused) { abort = true; return; }

        if (now.maxFileMb > 0 && asset.size > now.maxFileMb * 1024 * 1024) {
          failed++;
          emit({ failed, lastError: `أكبر من الحد (${now.maxFileMb} م.ب): ${asset.name}` });
          return;
        }

        emit({ currentName: asset.name });
        fractions.set(asset.id, 0);
        try {
          await uploadOne(asset, now.freeBlobAfterSync, (f) => {
            fractions.set(asset.id, f);
            report();
          });
          done++;
          void updateSyncForegroundService(
            "جارٍ رفع صورك", `${done} من ${queue.length}`, done, queue.length,
          );
        } catch (e) {
          failed++;
          const msg = e instanceof Error ? e.message : String(e);
          emit({ failed, lastError: msg });
          // A dropped socket fails every remaining item in milliseconds.
          // Rebuild the client and end this pass; the heartbeat starts a
          // healthy one.
          if (/disconnect|not connected|timeout|network|socket/i.test(msg)) {
            abort = true;
            await resetClient();
          }
        } finally {
          fractions.delete(asset.id);
          report();
        }
      },
      {
        concurrency: Math.max(1, Math.min(10, settings.parallelUploads)),
        // gramjs buffers each file in memory, so bound the total in flight no
        // matter how many slots are free.
        maxBytesInFlight: 192 * 1024 * 1024,
        stop: () => abort,
      },
    );
  } finally {
    emit({ running: false, currentName: undefined, currentFraction: undefined });
    void stopSyncForegroundService();
  }

  if (done > 0 || failed > 0) {
    void notify(
      failed > 0 ? "انتهت المزامنة مع أخطاء" : "اكتملت المزامنة 🎉",
      failed > 0 ? `${done} نجحت · ${failed} فشلت` : `رُفعت ${done} عنصراً`,
    );
  }
  return { processed: done, failed };
}
