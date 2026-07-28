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
  let blob = asset.blob;
  if (!blob && asset.localUri) {
    const response = await fetch(asset.localUri);
    if (!response.ok) throw new Error(`تعذر قراءة الملف المحلي: ${response.status}`);
    blob = await response.blob();
  }
  if (!blob) throw new Error("لا يوجد ملف محلي للرفع");
  return blob;
}

async function uploadOne(asset: MediaAsset, botToken: string, chatId: string, freeBlob: boolean) {
  const blob = await readBlob(asset);
  const file = new File([blob], asset.name, { type: asset.mime || blob.type || "application/octet-stream" });
  const res = await telegramSendDocument(botToken, chatId, file);
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
  const res = await uploadToTarget(file);
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
  if (progress.running) return { processed: 0, failed: 0 };

  const settings = await getSyncSettings();
  if (settings.paused) return { processed: 0, failed: 0 };
  if (!isOnline()) return { processed: 0, failed: 0 };
  if (settings.wifiOnly && !(await isWifiLike())) return { processed: 0, failed: 0 };

  // Personal account (MTProto) wins when a target channel is selected —
  // no bot token required, and files up to 2 GB are allowed.
  const { getSavedTarget, getClient } = await import("@/lib/providers/mtproto");
  const target = await getSavedTarget();
  const accountReady = !!target && !!(await getClient());

  const cfg = await photoDb.providers.get("telegram");
  const botReady = !!cfg?.configured && !!cfg?.botToken && !!cfg?.chatId;
  if (!accountReady && !botReady) return { processed: 0, failed: 0 };


  const allAssets = await photoDb.assets.toArray();
  // Signature of everything already living on Telegram, so a re-indexed copy of
  // the same file is marked synced instead of uploaded a second time.
  const sig = (a: MediaAsset) => `${a.name}|${a.size}`;
  const uploaded = new Set(
    allAssets.filter((a) => a.syncedAt != null || a.remoteFileId).map(sig),
  );

  const candidates = allAssets.filter(
    (a) => a.provider === "device" && a.syncedAt == null && (a.blob || a.localUri),
  );
  const unsynced: MediaAsset[] = [];
  for (const a of candidates) {
    if (uploaded.has(sig(a))) {
      // Already on Telegram under another local id — just retire the duplicate.
      await photoDb.assets.update(a.id, { syncedAt: Date.now(), blob: undefined });
      continue;
    }
    uploaded.add(sig(a));
    unsynced.push(a);
  }
  if (unsynced.length === 0) return { processed: 0, failed: 0 };


  emit({ running: true, total: unsynced.length, done: 0, failed: 0, currentName: undefined, lastError: undefined });
  void startSyncForegroundService("جاري المزامنة", `0 / ${unsynced.length}`);
  let done = 0;
  let failed = 0;
  try {
    for (const asset of unsynced) {
      const now = await getSyncSettings();
      if (now.paused) break;
      if (now.maxFileMb > 0 && asset.size > now.maxFileMb * 1024 * 1024) {
        failed++;
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
      try {
        if (accountReady) await uploadOneViaAccount(asset, now.freeBlobAfterSync);
        else await uploadOne(asset, cfg!.botToken!, cfg!.chatId!, now.freeBlobAfterSync);
        done++;
        emit({ done });

      } catch (e) {
        failed++;
        emit({ failed, lastError: e instanceof Error ? e.message : String(e) });
      }
    }
  } finally {
    emit({ running: false, currentName: undefined });
    void stopSyncForegroundService();
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
