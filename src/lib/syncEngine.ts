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
    provider: "telegram-remote",
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

/** Number of device assets still waiting to be uploaded. */
export async function pendingCount(): Promise<number> {
  const rows = await photoDb.assets.where("provider").equals("device").toArray();
  return rows.filter((a) => a.syncedAt == null && (a.blob || a.localUri)).length;
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

  // The upload target must be linked before anything is queued. The client is
  // built lazily so an idle app never opens a Telegram connection.
  const { getSavedTarget, getClient } = await import("@/lib/providers/mtproto");
  const target = await getSavedTarget();
  if (!target) return { processed: 0, failed: 0 };

  // Claim the run before the slow client acquisition — a reconnect can take
  // minutes, and ticks keep arriving the whole time.
  emit({ running: true });
  let client: unknown = null;
  try {
    client = await getClient();
  } catch {
    emit({ running: false });
    return { processed: 0, failed: 0 };
  }
  if (!client) {
    emit({ running: false });
    return { processed: 0, failed: 0 };
  }

  const allAssets = await photoDb.assets.toArray();
  // Everything already on Telegram, keyed by content, so a re-indexed copy of
  // the same file is retired instead of uploaded twice.
  const uploaded = new Set(
    allAssets
      .filter((a) => a.syncedAt != null || a.remoteMessageId != null)
      .map((a) => a.contentKey ?? contentKeyOf(a)),
  );

  const candidates = allAssets.filter(
    (a) => a.provider === "device" && a.syncedAt == null && (a.blob || a.localUri),
  );

  const queue: MediaAsset[] = [];
  for (const a of candidates) {
    const key = a.contentKey ?? contentKeyOf(a);
    if (uploaded.has(key)) {
      await photoDb.assets.update(a.id, {
        syncedAt: Date.now(),
        blob: undefined,
        contentKey: key,
      });
      continue;
    }
    uploaded.add(key);
    queue.push(a);
  }
  if (queue.length === 0) {
    emit({ running: false });
    return { processed: 0, failed: 0 };
  }

  emit({
    running: true, total: queue.length, done: 0, failed: 0,
    currentName: undefined, currentFraction: undefined, lastError: undefined,
  });
  void startSyncForegroundService("جارٍ رفع صورك", `0 / ${queue.length}`);

  let done = 0;
  let failed = 0;
  try {
    for (const asset of queue) {
      const now = await getSyncSettings();
      if (now.paused) break;

      if (now.maxFileMb > 0 && asset.size > now.maxFileMb * 1024 * 1024) {
        failed++;
        emit({ failed, lastError: `أكبر من الحد (${now.maxFileMb} م.ب): ${asset.name}` });
        continue;
      }

      emit({ currentName: asset.name, currentFraction: 0 });
      void updateSyncForegroundService(
        "جارٍ رفع صورك",
        `${done + 1} من ${queue.length} · ${asset.name}`,
        done,
        queue.length,
      );

      try {
        await uploadOne(asset, now.freeBlobAfterSync, (f) => emit({ currentFraction: f }));
        done++;
        emit({ done, currentFraction: 1 });
      } catch (e) {
        failed++;
        const msg = e instanceof Error ? e.message : String(e);
        emit({ failed, lastError: msg });

        // A dropped socket fails every remaining item in milliseconds and would
        // burn the whole queue. Rebuild the client and stop this pass; the
        // heartbeat starts a fresh one with a healthy connection.
        if (/disconnect|not connected|timeout|network|socket/i.test(msg)) {
          const { resetClient } = await import("@/lib/providers/mtproto");
          await resetClient();
          break;
        }
      }
    }
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
