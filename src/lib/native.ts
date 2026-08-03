// Native bridge — thin wrapper over Capacitor plugins with web fallbacks.
// Every check is runtime-safe: the app still runs in a plain browser.
import { Capacitor, registerPlugin } from "@capacitor/core";
import { LocalNotifications } from "@capacitor/local-notifications";
import { Filesystem, Directory } from "@capacitor/filesystem";
import { Haptics, ImpactStyle, NotificationType } from "@capacitor/haptics";
import { Preferences } from "@capacitor/preferences";

export const isNative = () => Capacitor.isNativePlatform();
export const platform = () => Capacitor.getPlatform(); // "ios" | "android" | "web"

type NativePermissionState = "granted" | "denied" | "prompt" | "prompt-with-rationale" | "unknown";

/** "tick" is the background heartbeat emitted by the foreground service. */
export type SyncCommand = "pause" | "resume" | "stop" | "tick";

export interface NativeGalleryAsset {
  id: string;
  name: string;
  mime: string;
  size: number;
  date: number;
  width?: number;
  height?: number;
  duration?: number;
  kind: "image" | "video";
  webPath: string;
}

interface LocalGalleryMediaPlugin {
  checkGalleryPermissions(): Promise<{ media: NativePermissionState }>;
  requestGalleryPermissions(): Promise<{ media: NativePermissionState }>;
  scanGallery(options?: { offset?: number; limit?: number; since?: number }): Promise<{
    total?: number;
    items: NativeGalleryAsset[];
  }>;
  getThumbnail(options: { id: string; size?: number }): Promise<{
    dataUrl: string; width: number; height: number;
  }>;
  shareItems(options: { ids: string[]; title?: string }): Promise<{ ok: boolean }>;
  deleteItems(options: { ids: string[] }): Promise<{ deleted: number }>;
  installApk(options: { url: string }): Promise<{ ok: boolean }>;
  startSyncService(options: { title: string; text: string }): Promise<{ ok: boolean }>;
  updateSyncService(options: {
    title: string; text: string; progress?: number; max?: number;
  }): Promise<{ ok: boolean }>;
  stopSyncService(): Promise<{ ok: boolean }>;
  /** Keeps the service alive between queues so background sync can resume. */
  setBackgroundSync(options: { enabled: boolean }): Promise<{ ok: boolean }>;
  checkBatteryOptimization(): Promise<{ ignoring: boolean }>;
  requestBatteryOptimizationExemption(): Promise<{ ignoring: boolean; requested?: boolean }>;
  addListener(
    event: "syncCommand",
    cb: (data: { action: SyncCommand }) => void,
  ): Promise<{ remove: () => Promise<void> }>;
}

/**
 * Single registration for the whole app. Registering the same plugin name from
 * more than one module makes Capacitor warn and drop the second instance.
 */
export const LocalGalleryMedia = registerPlugin<LocalGalleryMediaPlugin>("LocalGalleryMedia");

// ------- Device gallery -------------------------------------------------------
export async function requestGalleryPermission(): Promise<boolean> {
  if (!isNative()) return false;
  try {
    const res = await LocalGalleryMedia.requestGalleryPermissions();
    return res.media === "granted";
  } catch {
    return false;
  }
}

export async function checkGalleryPermission(): Promise<"granted" | "denied" | "prompt" | "unknown"> {
  if (!isNative()) return "unknown";
  try {
    const res = await LocalGalleryMedia.checkGalleryPermissions();
    return res.media === "prompt-with-rationale" ? "prompt" : (res.media as "granted" | "denied" | "prompt");
  } catch {
    return "unknown";
  }
}

/** One page of the device gallery. `since` limits it to newer items only. */
export async function scanNativeGalleryBatch(offset = 0, limit = 200, since = 0) {
  if (!isNative()) return { total: 0, items: [] as NativeGalleryAsset[] };
  return LocalGalleryMedia.scanGallery({ offset, limit, since });
}

/** Opens the system share sheet (WhatsApp, Telegram, mail…) for gallery items. */
export async function shareGalleryItems(assetIds: string[], title = "مشاركة"): Promise<boolean> {
  if (!isNative() || assetIds.length === 0) return false;
  const ids = assetIds.map((a) => a.replace(/^device-/, ""));
  try {
    return !!(await LocalGalleryMedia.shareItems({ ids, title })).ok;
  } catch {
    return false;
  }
}

/** Asks the OS to delete items; Android 11+ shows its own confirmation. */
export async function deleteGalleryItems(assetIds: string[]): Promise<number> {
  if (!isNative() || assetIds.length === 0) return 0;
  const ids = assetIds.map((a) => a.replace(/^device-/, ""));
  try {
    return (await LocalGalleryMedia.deleteItems({ ids })).deleted ?? 0;
  } catch {
    return 0;
  }
}

export async function installApkFromUrl(url: string): Promise<boolean> {
  if (!isNative()) return false;
  const res = await LocalGalleryMedia.installApk({ url });
  return !!res.ok;
}

// ------- Foreground sync service ---------------------------------------------
export async function startSyncForegroundService(title: string, text: string): Promise<boolean> {
  if (!isNative()) return false;
  try {
    return !!(await LocalGalleryMedia.startSyncService({ title, text })).ok;
  } catch {
    return false;
  }
}

export async function updateSyncForegroundService(
  title: string, text: string, progress?: number, max?: number,
): Promise<void> {
  if (!isNative()) return;
  try {
    await LocalGalleryMedia.updateSyncService({ title, text, progress, max });
  } catch { /* noop */ }
}

export async function stopSyncForegroundService(): Promise<void> {
  if (!isNative()) return;
  try {
    await LocalGalleryMedia.stopSyncService();
  } catch { /* noop */ }
}

/**
 * Turns the always-on background watcher on or off. While enabled the native
 * service stays resident and heartbeats into JS, so uploads continue after the
 * app is swiped away or the screen locks.
 */
export async function setBackgroundSync(enabled: boolean): Promise<void> {
  if (!isNative()) return;
  try {
    await LocalGalleryMedia.setBackgroundSync({ enabled });
  } catch { /* noop */ }
}

// ------- Battery optimization -------------------------------------------------
export async function isIgnoringBatteryOptimizations(): Promise<boolean> {
  if (!isNative()) return true;
  try {
    return !!(await LocalGalleryMedia.checkBatteryOptimization()).ignoring;
  } catch {
    return false;
  }
}

export async function requestBatteryExemption(): Promise<boolean> {
  if (!isNative()) return true;
  try {
    return !!(await LocalGalleryMedia.requestBatteryOptimizationExemption()).ignoring;
  } catch {
    return false;
  }
}

// ------- Notifications --------------------------------------------------------
export async function requestNotifPermission(): Promise<boolean> {
  if (!isNative()) {
    if (!("Notification" in globalThis)) return false;
    return (await Notification.requestPermission()) === "granted";
  }
  const res = await LocalNotifications.requestPermissions();
  return res.display === "granted";
}

export async function checkNotifPermission(): Promise<"granted" | "denied" | "prompt" | "unknown"> {
  if (!isNative()) {
    if (!("Notification" in globalThis)) return "unknown";
    return Notification.permission as "granted" | "denied" | "prompt";
  }
  const res = await LocalNotifications.checkPermissions();
  return (res.display as never) ?? "prompt";
}

let notifCounter = 1;

/**
 * One notification API for the whole app. On device this goes through
 * LocalNotifications — the same channel the permission was granted for.
 */
export async function notify(title: string, body: string): Promise<void> {
  try {
    if (isNative()) {
      await LocalNotifications.schedule({
        notifications: [{ id: notifCounter++, title, body }],
      });
    } else if ("Notification" in globalThis && Notification.permission === "granted") {
      new Notification(title, { body });
    }
  } catch { /* best effort */ }
}

// ------- Saving files ---------------------------------------------------------
function toBase64(bytes: Uint8Array): string {
  // Chunked — String.fromCharCode(...bigArray) blows the call stack.
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

export async function saveBlobToDevice(name: string, blob: Blob): Promise<string | null> {
  if (!isNative()) return null;
  const base64 = toBase64(new Uint8Array(await blob.arrayBuffer()));
  // Documents is not always writable on Android 13+ — fall back progressively.
  const dirs = [Directory.Documents, Directory.External, Directory.Data];
  let lastErr: unknown = null;
  for (const directory of dirs) {
    try {
      const res = await Filesystem.writeFile({ path: name, data: base64, directory, recursive: true });
      return res.uri;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("تعذّر حفظ الملف");
}

/** Native download that bypasses WebView fetch() limits on large files. */
export async function downloadUrlToDevice(url: string, name: string): Promise<string | null> {
  if (!isNative()) return null;
  const res = await Filesystem.downloadFile({
    url, path: name, directory: Directory.Documents, recursive: true,
  });
  return res.path ?? null;
}

// ------- Haptics --------------------------------------------------------------
export async function tap(style: "light" | "medium" | "heavy" = "light") {
  if (!isNative()) return;
  try {
    await Haptics.impact({
      style:
        style === "heavy" ? ImpactStyle.Heavy
        : style === "medium" ? ImpactStyle.Medium
        : ImpactStyle.Light,
    });
  } catch { /* noop */ }
}

/** Short buzz pattern for success / failure moments. */
export async function buzz(kind: "success" | "warning" | "error" = "success") {
  if (!isNative()) return;
  try {
    await Haptics.notification({
      type:
        kind === "error" ? NotificationType.Error
        : kind === "warning" ? NotificationType.Warning
        : NotificationType.Success,
    });
  } catch { /* noop */ }
}

// ------- Preferences (native-safe KV) ----------------------------------------
export async function prefGet(key: string): Promise<string | null> {
  if (!isNative()) return localStorage.getItem(key);
  return (await Preferences.get({ key })).value;
}

export async function prefSet(key: string, value: string): Promise<void> {
  if (!isNative()) {
    localStorage.setItem(key, value);
    return;
  }
  await Preferences.set({ key, value });
}
