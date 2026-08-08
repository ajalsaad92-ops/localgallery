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
  MAX_UPLOAD_MB,
  type MediaAsset,
  type SyncSettings,
} from "@/lib/photoDb";
import { uploadMemoryCost } from "@/lib/uploadParts";
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

/**
 * When the running pass last showed a sign of life.
 *
 * `runSyncCycle` refuses to start while another pass is running, and a pass
 * that wedges — a promise that never settles because the socket died in a way
 * gramjs did not surface — used to block every later tick until the app was
 * restarted. This is the timestamp the watchdog reads.
 */
let lastActivity = 0;

/**
 * Passes are numbered so a retired one cannot talk over its replacement:
 * its late emits, its notification updates and its remaining queue items are
 * all dropped once `runGeneration` has moved on.
 */
let runGeneration = 0;

export function subscribeSync(cb: (p: SyncProgress) => void): () => void {
  listeners.add(cb);
  cb(progress);
  return () => listeners.delete(cb);
}

function emit(patch: Partial<SyncProgress>) {
  lastActivity = Date.now();
  progress = { ...progress, ...patch };
  listeners.forEach((cb) => cb(progress));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** "٣٠ دقيقة" / "٤٥ ثانية" — a wait a person can read. */
function floodWaitText(seconds: number): string {
  if (seconds < 90) return `${seconds} ثانية`;
  const mins = Math.round(seconds / 60);
  return `${mins} دقيقة`;
}

/** Errors worth retrying: the socket, the radio, or Telegram being busy. */
function isTransient(msg: string): boolean {
  return /disconnect|not connected|timeout|timedout|network|socket|closed|econn|fetch|offline|flood/i.test(
    msg,
  );
}

/**
 * One reconnect for the whole pool.
 *
 * A dropped socket surfaces in every worker at once. Before this, the first
 * one to notice aborted the entire pass and the other ninety-nine files were
 * counted as failures; now they all wait here while a single reconnect runs.
 */
let reconnectGate: Promise<boolean> | null = null;

async function ensureConnection(): Promise<boolean> {
  if (reconnectGate) return reconnectGate;
  reconnectGate = (async () => {
    const { getClient, resetClient } = await import("@/lib/providers/mtproto");
    await resetClient();
    for (let attempt = 0; attempt < 4; attempt++) {
      await sleep(Math.min(15000, 1500 * 2 ** attempt));
      lastActivity = Date.now();
      if (!(await isOnline())) continue;
      const client = await getClient().catch(() => null);
      if (client) return true;
    }
    return false;
  })();
  const result = reconnectGate;
  void result.finally(() => {
    if (reconnectGate === result) reconnectGate = null;
  });
  return result;
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
  chatId: string,
  onFraction: (f: number) => void,
  isCancelled: () => boolean,
) {
  const { uploadToTarget } = await import("@/lib/providers/mtproto");
  const blob = await readBlob(asset);
  const file = new File([blob], asset.name, {
    type: asset.mime || blob.type || "application/octet-stream",
  });
  const key = asset.contentKey ?? contentKeyOf(asset);

  // Journal first. If the process is killed between Telegram accepting the
  // file and the row update below, this is the only trace that the upload may
  // already have happened — without it the next pass sends the photo again.
  await photoDb.uploads.put({
    key, assetId: asset.id, chatId, name: asset.name, startedAt: Date.now(),
  });

  const res = await uploadToTarget(
    file,
    onFraction,
    buildCaption(asset.name, originalDateOf(asset), key),
    { isCancelled },
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
  await photoDb.uploads.delete(key);
}

/**
 * Close out uploads that were interrupted after Telegram accepted the file.
 *
 * Reads the channel's newest captions and matches them against the journal:
 * a key that is already up there marks the local row synced, a key that is not
 * simply clears the journal entry so the file is queued again. Only runs when
 * something was actually left in flight, so a healthy app never pays for it.
 */
async function settleInterruptedUploads(chatId: string): Promise<number> {
  const all = await photoDb.uploads.where("chatId").equals(chatId).toArray();
  // Only rows old enough to be genuinely abandoned. A pass that just aborted
  // leaves one row per file it had in flight, and the next pass follows five
  // seconds later — scanning the channel each time would cost six API calls
  // every five seconds and earn flood-waits of its own. A retry that succeeds
  // clears its own row long before this.
  const rows = all.filter((r) => Date.now() - r.startedAt > 90_000);
  if (rows.length === 0) return 0;

  let found: Map<string, number>;
  try {
    const { fetchRecentCaptionKeys } = await import("@/lib/providers/mtproto");
    const oldest = Math.min(...rows.map((r) => r.startedAt));
    found = await fetchRecentCaptionKeys(oldest - 60_000);
  } catch {
    // Offline or the channel is unreachable — keep the journal for next time.
    return 0;
  }

  let adopted = 0;
  for (const row of rows) {
    const messageId = found.get(row.key);
    if (messageId != null) {
      await photoDb.assets.update(row.assetId, {
        syncedAt: Date.now(),
        remoteMessageId: messageId,
        remoteChatId: chatId,
        contentKey: row.key,
      });
      adopted++;
    }
    await photoDb.uploads.delete(row.key);
  }
  return adopted;
}

/**
 * Looser identity for files the channel holds without one of our own keys.
 *
 * The stamped `contentKey` includes the capture date, and a re-index can hand
 * the same photo a slightly different date (MediaStore's `date_taken` vs. the
 * value derived from the filename). Name plus exact byte count is the fallback
 * — deliberately not used against keys we stamped ourselves, where the date is
 * known to be reliable.
 */
function looseKeyOf(a: { name: string; size: number }): string {
  return `${a.name}|${a.size}`;
}

export interface QueuePlan {
  /** Files to send, in order. */
  queue: MediaAsset[];
  /** Files the channel already holds — mark them synced, do not resend. */
  adopt: { asset: MediaAsset; key: string }[];
}

/**
 * Decide what actually has to be uploaded into `chatId`.
 *
 * Three ways a file counts as "already there":
 *   1. the row is marked synced to this channel;
 *   2. its content key is on a message in this channel (any local id);
 *   3. same filename and byte-exact size as something in this channel whose
 *      key this app did not stamp — see looseKeyOf for why the date alone
 *      cannot be trusted there.
 */
export function planQueue(
  allAssets: MediaAsset[],
  chatId: string,
  isBlocked: (id: string) => boolean = () => false,
): QueuePlan {
  const here = new Set<string>();
  const loose = new Set<string>();
  for (const a of allAssets) {
    const inChannel =
      (a.provider === "telegram-remote" && a.remoteChatId === chatId) ||
      isInChannel(a, chatId);
    if (!inChannel) continue;
    here.add(a.contentKey ?? contentKeyOf(a));
    if (!a.contentKey && a.size > 0 && a.name) loose.add(looseKeyOf(a));
  }

  const plan: QueuePlan = { queue: [], adopt: [] };
  for (const a of allAssets) {
    if (a.provider !== "device") continue;
    if (!a.blob && !a.localUri) continue;
    if (isInChannel(a, chatId)) continue;
    if (isBlocked(a.id)) continue;

    const key = a.contentKey ?? contentKeyOf(a);
    if (here.has(key) || (a.size > 0 && loose.has(looseKeyOf(a)))) {
      plan.adopt.push({ asset: a, key });
      continue;
    }
    here.add(key);
    // Two rows for the same bytes in one pass (a re-index gave the file a
    // second id) would otherwise both be sent.
    if (a.size > 0) loose.add(looseKeyOf(a));
    plan.queue.push(a);
  }
  return plan;
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

/**
 * Runs tasks with a bounded number in flight, under two byte budgets.
 *
 * `sizeOf` is the JS heap an item holds (its parts, now that uploads stream).
 * `rawOf` is the whole file, which lives in the WebView's blob store rather
 * than the heap — invisible to the first budget, but the phone pays for it all
 * the same, so a hundred half-gigabyte videos must not start at once.
 */
export async function runPool<T>(
  items: T[],
  sizeOf: (item: T) => number,
  worker: (item: T) => Promise<void>,
  opts: {
    concurrency: number;
    maxBytesInFlight: number;
    stop: () => boolean;
    rawOf?: (item: T) => number;
    maxRawInFlight?: number;
  },
) {
  let next = 0;
  let bytesInFlight = 0;
  let rawInFlight = 0;
  const active = new Set<Promise<void>>();
  const rawOf = opts.rawOf ?? (() => 0);
  const maxRaw = opts.maxRawInFlight ?? Number.POSITIVE_INFINITY;

  const launch = (item: T) => {
    const bytes = sizeOf(item);
    const raw = rawOf(item);
    bytesInFlight += bytes;
    rawInFlight += raw;
    const p = worker(item).finally(() => {
      bytesInFlight -= bytes;
      rawInFlight -= raw;
      active.delete(p);
    });
    active.add(p);
  };

  while (next < items.length && !opts.stop()) {
    const item = items[next];
    // Always allow one, otherwise a single huge file would deadlock the pool.
    const room =
      active.size === 0 ||
      (active.size < opts.concurrency &&
        bytesInFlight + sizeOf(item) <= opts.maxBytesInFlight &&
        rawInFlight + rawOf(item) <= maxRaw);
    if (!room) {
      await Promise.race(active);
      continue;
    }
    next++;
    launch(item);
  }
  await Promise.all(active);
}

/** Ceiling the settings slider is allowed to reach. */
export const MAX_PARALLEL_UPLOADS = 100;

/**
 * Heap budget for everything in flight.
 *
 * With the streaming uploader a file costs its parts, not its length, so this
 * no longer silently caps the parallel limit the way the old 192 MB / whole-
 * file rule did (four 50 MB videos and the pool was full).
 */
const MAX_BYTES_IN_FLIGHT = 96 * 1024 * 1024;

/**
 * Ceiling on the *whole files* held open at once.
 *
 * Reading a MediaStore item gives back a Blob, and its bytes sit in the
 * WebView's blob store until the upload finishes — off the JS heap, so the
 * budget above never sees them. At around 3 MB a photo this still allows a
 * hundred at a time; big videos naturally get fewer slots.
 */
const MAX_RAW_BYTES_IN_FLIGHT = 320 * 1024 * 1024;

/** A pass with no sign of life for this long is treated as wedged. */
const STUCK_MS = 4 * 60 * 1000;

/** Attempts per file inside one pass, reconnecting between them. */
const MAX_ATTEMPTS = 3;

/**
 * Files that keep failing pass after pass (corrupt, unreadable, deleted
 * underneath us) are parked so the queue can drain. Cleared on app restart.
 */
const failStreak = new Map<string, number>();
const GIVE_UP_AFTER = 3;

/**
 * How many files this app is currently willing to send at once.
 *
 * Starts at whatever the user asked for and backs off when Telegram answers
 * with FLOOD_WAIT — a hundred parallel uploads share one MTProto connection,
 * so past a point more workers means more waiting, not more speed.
 */
let adaptiveCap = MAX_PARALLEL_UPLOADS;

export async function runSyncCycle(): Promise<{ processed: number; failed: number }> {
  if (progress.running) {
    // A pass that never settles used to block every later tick until the app
    // was restarted — the try/finally only ever covered throws, not hangs.
    if (Date.now() - lastActivity < STUCK_MS) return { processed: 0, failed: 0 };
    runGeneration++;
    const { resetClient } = await import("@/lib/providers/mtproto");
    await resetClient().catch(() => {});
    progress = { ...progress, running: false };
  }

  // Cheap indexed count first. An armed-but-idle app ticks every few seconds
  // and must not deserialize the whole library each time.
  if ((await photoDb.assets.where("provider").equals("device").count()) === 0) {
    return { processed: 0, failed: 0 };
  }

  // Telegram is still counting down a flood-wait. Starting a pass now would
  // only queue files behind a gate that cannot open yet.
  const { floodCooldownMs } = await import("@/lib/providers/mtproto");
  const cooling = floodCooldownMs();
  if (cooling > 0) {
    emit({ lastError: `تيليجرام يطلب الانتظار ${floodWaitText(Math.ceil(cooling / 1000))}` });
    return { processed: 0, failed: 0 };
  }

  const settings = await getSyncSettings();
  if (settings.paused) {
    // Drop the "uploading" notification so a paused app is not left with a
    // five-second heartbeat and a wake lock for nothing.
    void stopSyncForegroundService();
    return { processed: 0, failed: 0 };
  }
  // Same demotion as above whenever the pass cannot run. A backlog keeps the
  // service in its active state — five-second heartbeats — and without this a
  // night with no Wi-Fi would tick, wake the page and hold the locks until
  // morning. The `online` event, the idle heartbeat and coming back to the app
  // all restart it.
  if (!(await isOnline())) {
    void stopSyncForegroundService();
    return { processed: 0, failed: 0 };
  }
  if (settings.wifiOnly && !(await isWifi())) {
    void stopSyncForegroundService();
    return { processed: 0, failed: 0 };
  }

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
  const gen = ++runGeneration;
  const current = () => gen === runGeneration;
  const emitRun = (patch: Partial<SyncProgress>) => { if (current()) emit(patch); };

  emit({ running: true });
  let done = 0;
  let failed = 0;
  let queued = 0;
  let connected = false;

  try {
    const { getClient, takeFloodPressure, isFloodPause } =
      await import("@/lib/providers/mtproto");
    const client = await getClient().catch(() => null);
    if (!client) return { processed: 0, failed: 0 };
    connected = true;

    // Telegram pushed back last pass → send fewer at once this time, and creep
    // back up while it stays quiet.
    adaptiveCap = takeFloodPressure() > 0
      ? Math.max(2, Math.floor(adaptiveCap / 2))
      : Math.min(MAX_PARALLEL_UPLOADS, adaptiveCap + 4);

    await settleInterruptedUploads(target.id);

    const allAssets = await photoDb.assets.toArray();

    // Only what is in THIS channel counts as uploaded. Picking a different
    // channel has to start its own backup rather than inherit the last one's,
    // which is why an empty channel used to stay empty while the counters
    // insisted everything was already done.
    const plan = planQueue(
      allAssets,
      target.id,
      (id) => (failStreak.get(id) ?? 0) >= GIVE_UP_AFTER,
    );
    for (const { asset, key } of plan.adopt) {
      await photoDb.assets.update(asset.id, {
        syncedAt: Date.now(),
        remoteChatId: target.id,
        blob: undefined,
        contentKey: key,
      });
    }

    const queue = plan.queue;
    if (queue.length === 0) return { processed: 0, failed: 0 };
    queued = queue.length;

    emitRun({
      running: true, total: queue.length, done: 0, failed: 0,
      currentName: undefined, currentFraction: undefined, lastError: undefined,
    });
    void startSyncForegroundService("جارٍ رفع صورك", `0 / ${queue.length}`);

    let abort = false;
    const stopped = () => abort || !current();
    const fractions = new Map<string, number>();

    // A hundred uploaders reporting every 128 KB part would re-render the
    // whole UI thousands of times a minute — which is itself enough to stall a
    // backgrounded WebView. Coalesce into one update every half second.
    let reportTimer: ReturnType<typeof setTimeout> | null = null;
    let lastReport = 0;
    const flush = () => {
      lastReport = Date.now();
      reportTimer = null;
      const vals = [...fractions.values()];
      emitRun({
        done, failed,
        currentFraction: vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : undefined,
      });
    };
    const report = () => {
      lastActivity = Date.now();
      const wait = 500 - (Date.now() - lastReport);
      if (wait <= 0) return flush();
      if (!reportTimer) reportTimer = setTimeout(flush, wait);
    };

    let lastNotif = 0;
    const notifyProgress = () => {
      if (Date.now() - lastNotif < 1500) return;
      lastNotif = Date.now();
      if (!current()) return;
      void updateSyncForegroundService(
        "جارٍ رفع صورك", `${done} من ${queue.length}`, done, queue.length,
      );
    };

    await runPool(
      queue,
      (a) => uploadMemoryCost(a.size || 0),
      async (asset) => {
        const now = await getSyncSettings();
        if (now.paused) { abort = true; return; }

        const cap = Math.min(now.maxFileMb > 0 ? now.maxFileMb : MAX_UPLOAD_MB, MAX_UPLOAD_MB);
        if (asset.size > cap * 1024 * 1024) {
          failed++;
          failStreak.set(asset.id, GIVE_UP_AFTER); // never worth retrying
          emitRun({ failed, lastError: `أكبر من الحد (${cap} م.ب): ${asset.name}` });
          return;
        }

        emitRun({ currentName: asset.name });
        fractions.set(asset.id, 0);
        try {
          for (let attempt = 1; ; attempt++) {
            try {
              await uploadOne(
                asset, now.freeBlobAfterSync, target.id,
                (f) => { fractions.set(asset.id, f); report(); },
                stopped,
              );
              done++;
              failStreak.delete(asset.id);
              notifyProgress();
              return;
            } catch (e) {
              if (stopped()) return;
              const paused = isFloodPause(e);
              if (paused != null) {
                // Telegram asked for a long wait. That is not this file's
                // fault: leave its retry budget alone, stand the whole pass
                // down and let the heartbeat come back when the wait is over.
                abort = true;
                emitRun({ lastError: `تيليجرام يطلب الانتظار ${floodWaitText(paused)}` });
                return;
              }
              const msg = e instanceof Error ? e.message : String(e);
              if (!isTransient(msg) || attempt >= MAX_ATTEMPTS) {
                failed++;
                failStreak.set(asset.id, (failStreak.get(asset.id) ?? 0) + 1);
                emitRun({ failed, lastError: msg });
                return;
              }
              // A dropped socket surfaces in every worker at once. One shared
              // reconnect, then this file starts over — the pass used to die
              // here and take the rest of the queue with it.
              emitRun({ lastError: msg });
              if (!(await ensureConnection())) { abort = true; return; }
            }
          }
        } finally {
          fractions.delete(asset.id);
          report();
        }
      },
      {
        concurrency: Math.max(
          1,
          Math.min(MAX_PARALLEL_UPLOADS, settings.parallelUploads, adaptiveCap),
        ),
        maxBytesInFlight: MAX_BYTES_IN_FLIGHT,
        rawOf: (a) => Math.max(a.size || 0, 1),
        maxRawInFlight: MAX_RAW_BYTES_IN_FLIGHT,
        stop: stopped,
      },
    );
  } finally {
    if (current()) {
      emit({ running: false, currentName: undefined, currentFraction: undefined });
      // Telegram was never reached — leave the notification (and therefore the
      // heartbeat) exactly as it was, or a backlog would be demoted to "idle"
      // on nothing more than a bad minute of Wi-Fi.
      if (connected) {
        if (queued - done - failed > 0) {
          // Files are still waiting: keep the service in its active state so
          // the heartbeat stays fast and the queue resumes in seconds.
          // Dropping to idle here is what used to end a backup silently — in
          // manual mode the service even stopped itself, leaving nothing alive
          // to restart it.
          void updateSyncForegroundService(
            "المزامنة متوقفة مؤقتاً",
            `${done} من ${queued} — سيُعاد المحاولة`,
            done,
            queued,
          );
        } else {
          void stopSyncForegroundService();
        }
      }
    }
  }

  // Only announce the end of a queue that actually ended. A pass that stopped
  // half way will be resumed by the next heartbeat and must stay quiet.
  if (queued - done - failed <= 0 && (done > 0 || failed > 0)) {
    const { legacyFallbackCount } = await import("@/lib/providers/mtproto");
    // Should always be zero. If it is not, the streaming uploader is producing
    // something Telegram rejects and the slow path is carrying the backup.
    const fellBack = legacyFallbackCount();
    void notify(
      failed > 0 ? "انتهت المزامنة مع أخطاء" : "اكتملت المزامنة 🎉",
      (failed > 0 ? `${done} نجحت · ${failed} فشلت` : `رُفعت ${done} عنصراً`) +
        (fellBack > 0 ? ` · ${fellBack} بالمسار الاحتياطي` : ""),
    );
  }
  return { processed: done, failed };
}
