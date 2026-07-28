// Native bridge — thin wrapper over Capacitor plugins with web fallbacks.
// All checks are runtime-safe: the app still works in a browser (web mode).
import { Capacitor, registerPlugin } from "@capacitor/core";
import { Camera, CameraResultType, CameraSource, type Photo } from "@capacitor/camera";
import { LocalNotifications, type PermissionStatus as LNStatus } from "@capacitor/local-notifications";
import { Geolocation } from "@capacitor/geolocation";
import { Share } from "@capacitor/share";
import { Filesystem, Directory } from "@capacitor/filesystem";
import { Haptics, ImpactStyle } from "@capacitor/haptics";
import { Preferences } from "@capacitor/preferences";
import { logPerm } from "./diagnostics";

export const isNative = () => Capacitor.isNativePlatform();
export const platform = () => Capacitor.getPlatform(); // "ios" | "android" | "web"

type NativePermissionState = "granted" | "denied" | "prompt" | "prompt-with-rationale" | "unknown";

export type SyncCommand = "pause" | "resume" | "stop";

interface LocalGalleryMediaPlugin {
  checkGalleryPermissions(): Promise<{ media: NativePermissionState }>;
  requestGalleryPermissions(): Promise<{ media: NativePermissionState }>;
  scanGallery(options?: { offset?: number; limit?: number }): Promise<{
    total?: number;
    items: NativeGalleryAsset[];
  }>;
  installApk(options: { url: string }): Promise<{ ok: boolean }>;
  startSyncService(options: { title: string; text: string }): Promise<{ ok: boolean }>;
  updateSyncService(options: { title: string; text: string; progress?: number; max?: number }): Promise<{ ok: boolean }>;
  stopSyncService(): Promise<{ ok: boolean }>;
  checkBatteryOptimization(): Promise<{ ignoring: boolean }>;
  requestBatteryOptimizationExemption(): Promise<{ ignoring: boolean; requested?: boolean }>;
  addListener(
    event: "syncCommand",
    cb: (data: { action: SyncCommand }) => void,
  ): Promise<{ remove: () => Promise<void> }>;
}

/**
 * Single registration for the whole app. Registering the same plugin name from
 * more than one module makes Capacitor warn ("already registered") and drops
 * the second instance, so every consumer must import this one.
 */
export const LocalGalleryMedia = registerPlugin<LocalGalleryMediaPlugin>("LocalGalleryMedia");


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

// ------- Camera --------------------------------------------------------------
async function photoToFile(p: Photo, prefix: string): Promise<File | null> {
  if (!p.webPath) return null;
  const res = await fetch(p.webPath);
  const blob = await res.blob();
  const ext = p.format ?? "jpg";
  const name = `${prefix}-${Date.now()}.${ext}`;
  return new File([blob], name, { type: blob.type || `image/${ext}`, lastModified: Date.now() });
}

export async function takePhoto(): Promise<File | null> {
  if (!isNative()) return null;
  const photo = await Camera.getPhoto({
    quality: 92,
    resultType: CameraResultType.Uri,
    source: CameraSource.Camera,
    saveToGallery: false,
    correctOrientation: true,
  });
  return photoToFile(photo, "camera");
}

export async function pickFromGallery(limit = 0): Promise<File[]> {
  if (!isNative()) return [];
  // limit: 0 = unlimited on Android/iOS (Capacitor Camera v5+)
  const { photos } = await Camera.pickImages({ quality: 92, limit });
  const files: File[] = [];
  for (const p of photos) {
    const f = await photoToFile(p as unknown as Photo, "picked");
    if (f) files.push(f);
  }
  return files;
}

export async function requestCameraPermission(): Promise<boolean> {
  if (!isNative()) return false;
  logPerm("perm", "camera: request start");
  const res = await Camera.requestPermissions({ permissions: ["camera", "photos"] });
  const granted = res.camera === "granted" || res.photos === "granted";
  logPerm("perm", `camera: ${granted ? "granted" : "denied"}`, res, granted ? "info" : "warn");
  return granted;
}

export async function checkCameraPermission(): Promise<"granted" | "denied" | "prompt" | "unknown"> {
  if (!isNative()) return "unknown";
  const res = await Camera.checkPermissions();
  const state = (res.camera as never) ?? "prompt";
  logPerm("perm", `camera check: ${state}`, res);
  return state;
}

// ------- Full device gallery --------------------------------------------------
export async function requestGalleryPermission(): Promise<boolean> {
  if (!isNative()) return false;
  logPerm("perm", "gallery: request start");
  try {
    const res = await LocalGalleryMedia.requestGalleryPermissions();
    const granted = res.media === "granted";
    logPerm("perm", `gallery: ${granted ? "granted" : res.media}`, res, granted ? "info" : "warn");
    return granted;
  } catch (err) {
    logPerm("perm", "gallery: native plugin missing, fallback to Camera photos", err, "warn");
    const res = await Camera.requestPermissions({ permissions: ["photos"] });
    const granted = res.photos === "granted";
    logPerm("perm", `gallery(fallback): ${granted ? "granted" : "denied"}`, res, granted ? "info" : "warn");
    return granted;
  }
}

export async function checkGalleryPermission(): Promise<"granted" | "denied" | "prompt" | "unknown"> {
  if (!isNative()) return "unknown";
  try {
    const res = await LocalGalleryMedia.checkGalleryPermissions();
    const state = res.media === "prompt-with-rationale" ? "prompt" : (res.media as "granted" | "denied" | "prompt");
    logPerm("perm", `gallery check: ${state}`, res);
    return state;
  } catch {
    try {
      const res = await Camera.checkPermissions();
      return (res.photos as never) ?? "prompt";
    } catch {
      return "unknown";
    }
  }
}

export async function scanNativeGalleryBatch(offset = 0, limit = 80) {
  if (!isNative()) return { total: 0, items: [] as NativeGalleryAsset[] };
  return LocalGalleryMedia.scanGallery({ offset, limit });
}

export async function installApkFromUrl(url: string): Promise<boolean> {
  if (!isNative()) return false;
  const res = await LocalGalleryMedia.installApk({ url });
  return !!res.ok;
}

// ------- Foreground sync service --------------------------------------------
export async function startSyncForegroundService(title: string, text: string): Promise<boolean> {
  if (!isNative()) return false;
  try {
    const r = await LocalGalleryMedia.startSyncService({ title, text });
    return !!r.ok;
  } catch { return false; }
}
export async function updateSyncForegroundService(title: string, text: string, progress?: number, max?: number): Promise<void> {
  if (!isNative()) return;
  try { await LocalGalleryMedia.updateSyncService({ title, text, progress, max }); }
  catch { /* noop */ }
}
export async function stopSyncForegroundService(): Promise<void> {
  if (!isNative()) return;
  try { await LocalGalleryMedia.stopSyncService(); } catch { /* noop */ }
}

// ------- Battery optimization (keep syncing while the screen is off) ---------
export async function isIgnoringBatteryOptimizations(): Promise<boolean> {
  if (!isNative()) return true;
  try { return !!(await LocalGalleryMedia.checkBatteryOptimization()).ignoring; }
  catch { return false; }
}
export async function requestBatteryExemption(): Promise<boolean> {
  if (!isNative()) return true;
  logPerm("perm", "battery: request exemption");
  try {
    const r = await LocalGalleryMedia.requestBatteryOptimizationExemption();
    return !!r.ignoring;
  } catch { return false; }
}


// ------- Local notifications --------------------------------------------------
export async function requestNotifPermission(): Promise<boolean> {
  logPerm("perm", "notif: request start");
  if (!isNative()) {
    const granted = "Notification" in globalThis
      ? (await Notification.requestPermission()) === "granted"
      : false;
    logPerm("perm", `notif(web): ${granted ? "granted" : "denied"}`, undefined, granted ? "info" : "warn");
    return granted;
  }
  const res: LNStatus = await LocalNotifications.requestPermissions();
  const granted = res.display === "granted";
  logPerm("perm", `notif: ${granted ? "granted" : res.display}`, res, granted ? "info" : "warn");
  return granted;
}

export async function checkNotifPermission(): Promise<"granted" | "denied" | "prompt" | "unknown"> {
  if (!isNative()) {
    if (!("Notification" in globalThis)) return "unknown";
    return Notification.permission as "granted" | "denied" | "prompt";
  }
  const res = await LocalNotifications.checkPermissions();
  const state = (res.display as never) ?? "prompt";
  logPerm("perm", `notif check: ${state}`, res);
  return state;
}

let notifCounter = 1;
export async function notify(title: string, body: string) {
  try {
    if (isNative()) {
      await LocalNotifications.schedule({
        notifications: [
          {
            id: notifCounter++,
            title,
            body,
            smallIcon: "ic_stat_icon_config_sample",
            schedule: { at: new Date(Date.now() + 100) },
          },
        ],
      });
    } else if ("Notification" in globalThis && Notification.permission === "granted") {
      new Notification(title, { body });
    }
  } catch {
    // silent
  }
}

// ------- Geolocation ---------------------------------------------------------
export async function requestLocationPermission(): Promise<boolean> {
  if (!isNative()) return false;
  logPerm("perm", "location: request start");
  const res = await Geolocation.requestPermissions();
  const granted = res.location === "granted";
  logPerm("perm", `location: ${granted ? "granted" : res.location}`, res, granted ? "info" : "warn");
  return granted;
}

export async function checkLocationPermission(): Promise<"granted" | "denied" | "prompt" | "unknown"> {
  if (!isNative()) return "unknown";
  const res = await Geolocation.checkPermissions();
  const state = (res.location as never) ?? "prompt";
  logPerm("perm", `location check: ${state}`, res);
  return state;
}

// ------- Native share --------------------------------------------------------
export async function nativeShareText(title: string, text: string, url?: string) {
  if (!isNative()) {
    if ("share" in navigator) {
      await (navigator as Navigator & { share: (d: ShareData) => Promise<void> }).share({ title, text, url });
      return true;
    }
    return false;
  }
  await Share.share({ title, text, url });
  return true;
}

// ------- Save file to device (Downloads-like) --------------------------------
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
  const buf = await blob.arrayBuffer();
  const base64 = toBase64(new Uint8Array(buf));
  // Documents is not always writable on Android 13+ — fall back to the app's
  // external directory, then to internal storage.
  const dirs = [Directory.Documents, Directory.External, Directory.Data];
  let lastErr: unknown = null;
  for (const directory of dirs) {
    try {
      const res = await Filesystem.writeFile({ path: name, data: base64, directory, recursive: true });
      return res.uri;
    } catch (e) { lastErr = e; }
  }
  throw lastErr instanceof Error ? lastErr : new Error("تعذّر حفظ الملف");
}

/** Save text and open the native share sheet with the actual file attached. */
export async function shareTextAsFile(name: string, text: string): Promise<boolean> {
  if (!isNative()) return false;
  const uri = await saveBlobToDevice(name, new Blob([text], { type: "text/plain;charset=utf-8" }));
  if (!uri) return false;
  await Share.share({ title: name, url: uri });
  return true;
}

/**
 * Native-safe download: bypasses WebView `fetch()` which fails with
 * "Failed to fetch" for large Telegram file URLs on Android.
 */
export async function downloadUrlToDevice(url: string, name: string): Promise<string | null> {
  if (!isNative()) return null;
  const res = await Filesystem.downloadFile({
    url,
    path: name,
    directory: Directory.Documents,
    recursive: true,
  });
  return res.path ?? null;
}

// ------- Haptics -------------------------------------------------------------
export async function tap(style: "light" | "medium" | "heavy" = "light") {
  if (!isNative()) return;
  try {
    await Haptics.impact({
      style:
        style === "heavy" ? ImpactStyle.Heavy : style === "medium" ? ImpactStyle.Medium : ImpactStyle.Light,
    });
  } catch { /* noop */ }
}

// ------- Preferences (native-safe KV) ---------------------------------------
export async function prefGet(key: string): Promise<string | null> {
  if (!isNative()) return localStorage.getItem(key);
  const { value } = await Preferences.get({ key });
  return value;
}
export async function prefSet(key: string, value: string): Promise<void> {
  if (!isNative()) return localStorage.setItem(key, value);
  await Preferences.set({ key, value });
}
