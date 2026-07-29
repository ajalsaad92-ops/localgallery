/**
 * Telegram-only sync engine.
 * Reads device assets that have not been uploaded yet (syncedAt undefined),
 * uploads them via the user's Telegram bot, then marks them synced and
 * (optionally) frees the local blob from IndexedDB.
 * Nothing leaves the device except the request to api.telegram.org.
 */
import {
  photoDb,
  DEFAULT_SYNC_SETTINGS,
  type MediaAsset,
  type SyncSettings,
} from "@/lib/photoDb";
import { telegramSendDocument } from "@/lib/providers/telegram";
import { notify } from "@/lib/notifications";
import {
  startSyncForegroundService,
  updateSyncForegroundService,
  stopSyncForegroundService,
} from "@/lib/native";
import { Network } from "@capacitor/network";
import { logSync } from "@/lib/diagnostics";



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

// --- Live progress subscription --------------------------------------------
export interface SyncProgress {
  running: boolean;
  total: number;
  done: number;
  failed: number;
  currentName?: string;
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

function isOnline() {
  return typeof navigator === "undefined" ? true : navigator.onLine;
}
async function isWifiLike(): Promise<boolean> {
  // Prefer Capacitor Network on device — navigator.connection lies inside WebView.
  try {
    const s = await Network.getStatus();
    if (!s.connected) return false;
    return s.connectionType === "wifi";
  } catch {
    const c = (navigator as unknown as { connection?: { type?: string; effectiveType?: string } }).connection;
    if (!c) return true;
    if (c.type) return c.type === "wifi" || c.type === "ethernet";
    return c.effectiveType === "4g" || c.effectiveType === "wifi";
  }
}


async function readBlob(asset: MediaAsset): Promise<Blob> {
  if (asset.blob) {
    logSync("read", `blob from IndexedDB: ${asset.name}`, { bytes: asset.blob.size });
    return asset.blob;
  }
  if (asset.localUri) {
    // Videos (and big files) come from MediaStore content:// URIs proxied by
    // the WebView. fetch() can fail there, so fall back to XHR which handles
    // the capacitor scheme + large streams better.
    try {
      const response = await fetch(asset.localUri);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const b = await response.blob();
      logSync("read", `local uri read via fetch: ${asset.name}`, { bytes: b.size, mime: b.type });
      if (b.size > 0) return b;
      logSync("read", `fetch returned 0 bytes, trying XHR: ${asset.name}`, undefined, "warn");
    } catch (e) {
      logSync("read", `fetch failed for ${asset.name}, trying XHR`, e, "warn");
    }
    const b = await new Promise<Blob | null>((resolve) => {
      try {
        const xhr = new XMLHttpRequest();
        xhr.open("GET", asset.localUri!);
        xhr.responseType = "blob";
        xhr.onload = () => resolve(xhr.status < 400 ? (xhr.response as Blob) : null);
        xhr.onerror = () => resolve(null);
        xhr.send();
      } catch { resolve(null); }
    });
    if (b && b.size > 0) {
      logSync("read", `local uri read via XHR: ${asset.name}`, { bytes: b.size });
      return b;
    }
    throw new Error(`تعذر قراءة الملف المحلي (${asset.kind ?? "?"}): ${asset.name}`);
  }
  throw new Error(`لا يوجد ملف محلي للرفع: ${asset.name}`);
}

async function uploadOne(asset: MediaAsset, botToken: string, chatId: string, freeBlob: boolean) {
  const blob = await readBlob(asset);
  const file = new File([blob], asset.name, { type: asset.mime || blob.type || "application/octet-stream" });
  logSync("upload", `bot upload start: ${asset.name}`, { bytes: file.size, mime: file.type, kind: asset.kind });
  const res = await telegramSendDocument(botToken, chatId, file, {
    // Stamp the original capture time into the caption so the viewer can
    // restore the real date instead of the Telegram upload date.
    caption: buildCaption(asset.name, originalDateOf(asset)),
  });
  logSync("upload", `bot upload ok: ${asset.name}`, { messageId: res.messageId });
  const patch: Partial<MediaAsset> = {
    provider: "telegram-remote",
    syncedAt: Date.now(),
    remoteFileId: res.fileId,
    remoteMessageId: res.messageId,
  };
  if (freeBlob) {
    patch.blob = undefined;
    patch.localUri = undefined;
  }
  await photoDb.assets.update(asset.id, patch);
}


/** Upload through the linked personal account (no bot involved). */
async function uploadOneViaAccount(asset: MediaAsset, freeBlob: boolean) {
  const { uploadToTarget } = await import("@/lib/providers/mtproto");
  const blob = await readBlob(asset);
  const file = new File([blob], asset.name, { type: asset.mime || blob.type || "application/octet-stream" });
  logSync("upload", `account upload start: ${asset.name}`, { bytes: file.size, mime: file.type, kind: asset.kind });
  const res = await uploadToTarget(file, undefined, buildCaption(asset.name, originalDateOf(asset)));
  logSync("upload", `account upload ok: ${asset.name}`, res);
  const patch: Partial<MediaAsset> = {
    provider: "telegram-remote",
    syncedAt: Date.now(),
    remoteMessageId: res.messageId,
    remoteChatId: res.chatId,
  };
  if (freeBlob) {
    patch.blob = undefined;
    patch.localUri = undefined;
  }
  await photoDb.assets.update(asset.id, patch);
}


export async function runSyncCycle(): Promise<{ processed: number; failed: number }> {
  if (progress.running) { logSync("cycle", "skipped: already running"); return { processed: 0, failed: 0 }; }

  const settings = await getSyncSettings();
  if (settings.paused) { logSync("cycle", "skipped: sync is paused"); return { processed: 0, failed: 0 }; }
  if (!isOnline()) { logSync("cycle", "skipped: device offline", undefined, "warn"); return { processed: 0, failed: 0 }; }
  if (settings.wifiOnly && !(await isWifiLike())) {
    logSync("cycle", "skipped: wifi-only is on and connection is not wifi", undefined, "warn");
    return { processed: 0, failed: 0 };
  }

  // Personal account (MTProto) wins when a target channel is selected —
  // no bot token required, and files up to 2 GB are allowed.
  const { getSavedTarget, getClient } = await import("@/lib/providers/mtproto");
  const target = await getSavedTarget();
  let client: unknown = null;
  try { client = await getClient(); }
  catch (e) { logSync("cycle", "MTProto client failed to connect", e, "error"); }
  const accountReady = !!target && !!client;

  const cfg = await photoDb.providers.get("telegram");
  const botReady = !!cfg?.configured && !!cfg?.botToken && !!cfg?.chatId;
  logSync("cycle", "start", {
    mode: settings.mode, wifiOnly: settings.wifiOnly, freeBlob: settings.freeBlobAfterSync,
    accountReady, target: target?.title ?? null, botReady,
  });
  if (!accountReady && !botReady) {
    logSync("cycle", "skipped: no upload target (link the account + pick a channel, or configure the bot)", undefined, "warn");
    return { processed: 0, failed: 0 };
  }


  const allAssets = await photoDb.assets.toArray();
  // Signature of everything already living on Telegram, so a re-indexed copy of
  // the same file is marked synced instead of uploaded a second time.
  const sig = (a: MediaAsset) => `${a.name}|${a.size}`;
  const uploaded = new Set(
    allAssets.filter((a) => a.syncedAt != null || a.remoteFileId).map(sig),
  );

  const deviceAssets = allAssets.filter((a) => a.provider === "device");
  const candidates = deviceAssets.filter(
    (a) => a.syncedAt == null && (a.blob || a.localUri),
  );
  const noSource = deviceAssets.filter((a) => a.syncedAt == null && !a.blob && !a.localUri);
  logSync("scan", "queue built", {
    totalAssets: allAssets.length,
    deviceAssets: deviceAssets.length,
    videos: deviceAssets.filter((a) => a.kind === "video").length,
    candidates: candidates.length,
    candidateVideos: candidates.filter((a) => a.kind === "video").length,
    skippedNoLocalSource: noSource.length,
  });
  if (noSource.length) {
    logSync("scan", `${noSource.length} assets have no blob/localUri — cannot upload`,
      noSource.slice(0, 10).map((a) => `${a.kind}:${a.name}`), "warn");
  }
  const unsynced: MediaAsset[] = [];
  for (const a of candidates) {
    if (uploaded.has(sig(a))) {
      // Already on Telegram under another local id — just retire the duplicate.
      await photoDb.assets.update(a.id, { syncedAt: Date.now(), blob: undefined });
      logSync("dedupe", `already on Telegram, marked synced: ${a.name}`);
      continue;
    }
    uploaded.add(sig(a));
    unsynced.push(a);
  }
  if (unsynced.length === 0) { logSync("cycle", "nothing to upload"); return { processed: 0, failed: 0 }; }



  emit({ running: true, total: unsynced.length, done: 0, failed: 0, currentName: undefined, lastError: undefined });
  void startSyncForegroundService("جاري المزامنة", `0 / ${unsynced.length}`);
  let done = 0;
  let failed = 0;
  try {
    for (const asset of unsynced) {
      const now = await getSyncSettings();
      if (now.paused) { logSync("cycle", "paused mid-run — stopping"); break; }
      if (now.maxFileMb > 0 && asset.size > now.maxFileMb * 1024 * 1024) {
        failed++;
        logSync("skip", `over size limit: ${asset.name}`, { sizeMb: Math.round(asset.size / 1048576), limitMb: now.maxFileMb }, "warn");
        emit({ failed, lastError: `تجاوز الحد: ${asset.name}` });
        continue;
      }
      emit({ currentName: asset.name });
      void updateSyncForegroundService(
        "جاري المزامنة",
        `${done + 1} / ${unsynced.length} · ${asset.name}`,
        done,
        unsynced.length,
      );
      const t0 = Date.now();
      try {
        if (accountReady) await uploadOneViaAccount(asset, now.freeBlobAfterSync);
        else await uploadOne(asset, cfg!.botToken!, cfg!.chatId!, now.freeBlobAfterSync);
        done++;
        logSync("item", `uploaded ${asset.kind ?? "file"}: ${asset.name}`, { ms: Date.now() - t0 });
        emit({ done });

      } catch (e) {
        failed++;
        logSync("item", `FAILED ${asset.kind ?? "file"}: ${asset.name}`, {
          error: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
          mime: asset.mime, sizeMb: Math.round(asset.size / 1048576),
          hasBlob: !!asset.blob, hasLocalUri: !!asset.localUri,
          via: accountReady ? "mtproto" : "bot",
          ms: Date.now() - t0,
        }, "error");
        emit({ failed, lastError: e instanceof Error ? e.message : String(e) });
      }
    }
  } finally {
    emit({ running: false, currentName: undefined });
    void stopSyncForegroundService();
    logSync("cycle", "finished", { done, failed, total: unsynced.length });
  }


  if (done > 0 || failed > 0) {
    try {
      await notify({
        title: failed > 0 ? "انتهت المزامنة مع أخطاء" : "اكتملت المزامنة",
        body: `${done} نجحت · ${failed} فشلت`,
        tag: "sync-status",
        onlyWhenHidden: true,
      });
    } catch { /* best-effort */ }
  }
  return { processed: done, failed };
}
