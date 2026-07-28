// Device gallery import. Native Android builds use a real MediaStore bridge
// that reads the whole gallery after permission; the OS picker remains only as
// a browser/native fallback.
import { Capacitor } from "@capacitor/core";
import { Camera } from "@capacitor/camera";
import { photoDb, type MediaAsset } from "./photoDb";
import { extractExif } from "./exif";
import { extractVideoMeta, isVideoMime } from "./video";
import { requestGalleryPermission, scanNativeGalleryBatch, type NativeGalleryAsset } from "./native";
import { logNative, logIdb, mark } from "./diagnostics";

export const canScanDeviceGallery = () => Capacitor.isNativePlatform();

async function uriToFile(webPath: string, fallbackName: string): Promise<File | null> {
  try {
    const res = await fetch(webPath);
    const blob = await res.blob();
    const ext = (blob.type.split("/")[1] || "jpg").split(";")[0];
    const name = fallbackName.includes(".") ? fallbackName : `${fallbackName}.${ext}`;
    return new File([blob], name, { type: blob.type || `image/${ext}`, lastModified: Date.now() });
  } catch (e) {
    logNative("scan", "uriToFile failed", { webPath, err: String(e) });
    return null;
  }
}

async function insertFileAsset(file: File, id: string, meta?: Partial<NativeGalleryAsset>): Promise<boolean> {
  if (await photoDb.assets.get(id)) return false;

  const isVideo = meta?.kind === "video" || isVideoMime(file.type);
  let width = meta?.width;
  let height = meta?.height;
  let dateTaken = meta?.date || file.lastModified || Date.now();
  let posterDataUrl: string | undefined;
  let duration = meta?.duration;
  let exif: Awaited<ReturnType<typeof extractExif>> | undefined;

  try {
    if (isVideo) {
      const m = await extractVideoMeta(file);
      width = width ?? m.width;
      height = height ?? m.height;
      duration = duration ?? m.duration;
      posterDataUrl = m.posterDataUrl;
    } else if (!width || !height) {
      exif = await extractExif(file);
      width = exif.width;
      height = exif.height;
      dateTaken = exif.dateTaken ?? dateTaken;
    }
  } catch {
    /* metadata is optional — the file must still import */
  }

  const asset: MediaAsset = {
    id,
    provider: "device",
    name: file.name,
    size: file.size,
    mime: file.type || meta?.mime || (isVideo ? "video/*" : "image/*"),
    width,
    height,
    date: dateTaken,
    createdAt: Date.now(),
    kind: isVideo ? "video" : "image",
    blob: file,
    ...(posterDataUrl ? { posterDataUrl } : {}),
    ...(duration ? { duration } : {}),
    ...(exif ? { exif } : {}),
  };

  await photoDb.assets.put(asset);
  return true;
}

async function insertNativeAsset(item: NativeGalleryAsset): Promise<boolean> {
  const id = `device-${item.id}`;
  if (await photoDb.assets.get(id)) return false;
  // Content-level dedupe: the same photo can reappear with a new MediaStore id
  // (re-import, restored backup, moved folder). Never index/upload it twice.
  if (item.date) {
    const sameDay = await photoDb.assets.where("date").equals(item.date).toArray();
    if (sameDay.some((a) => a.name === item.name && a.size === item.size)) return false;
  }

  const asset: MediaAsset = {
    id,
    provider: "device",
    name: item.name,
    size: item.size,
    mime: item.mime || (item.kind === "video" ? "video/*" : "image/*"),
    width: item.width,
    height: item.height,
    date: item.date || Date.now(),
    createdAt: Date.now(),
    kind: item.kind,
    duration: item.duration,
    localUri: item.webPath,
  };
  await photoDb.assets.put(asset);
  return true;
}

async function importNativeGallery(onProgress?: (done: number, total: number) => void, max = 0): Promise<{ inserted: number; total: number }> {
  const batchSize = 60;
  let offset = 0;
  let inserted = 0;
  let total = 0;

  while (max === 0 || offset < max) {
    const limit = max > 0 ? Math.min(batchSize, max - offset) : batchSize;
    const batch = await scanNativeGalleryBatch(offset, limit);
    const items = batch.items ?? [];
    total = batch.total ?? Math.max(total, offset + items.length);
    if (items.length === 0) break;

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      onProgress?.(Math.min(offset + i, total), total);
      const imported = await insertNativeAsset(item);
      if (imported) inserted++;
    }

    offset += items.length;
    if (items.length < limit) break;
  }

  onProgress?.(total, total);
  return { inserted, total };
}

/**
 * Opens the OS gallery multi-select. `limit: 0` means unlimited on Android/iOS.
 * Every selected item is imported as a MediaAsset with its blob persisted in
 * IndexedDB, so it renders in the gallery immediately and survives reloads.
 */
export async function scanDeviceGallery(
  onProgress?: (done: number, total: number) => void,
  max = 0,
): Promise<number> {
  if (!canScanDeviceGallery()) return 0;
  const t = mark();
  logNative("scan", "device gallery import start");

  const granted = await requestGalleryPermission().catch(() => false);
  if (!granted) {
    logNative("scan", "gallery permission not granted — abort");
    return 0;
  }

  let picked: { webPath?: string; format?: string; path?: string }[] = [];
  try {
    try {
      const nativeResult = await importNativeGallery(onProgress, max);
      logNative("scan", "native full-gallery import complete", nativeResult);
      if (nativeResult.total > 0) {
        if (nativeResult.inserted > 0) logIdb("assets", `inserted ${nativeResult.inserted} native gallery assets`);
        return nativeResult.inserted;
      }
    } catch (e) {
      logNative("scan", "native full-gallery import failed; falling back to picker", e);
    }

    const res = await Camera.pickImages({ quality: 92, limit: max });
    picked = res.photos ?? [];
  } catch (e) {
    logNative("scan", "pickImages failed", e);
    return 0;
  }

  const total = picked.length;
  logNative("scan", `user selected ${total} items`);
  let inserted = 0;

  for (let i = 0; i < picked.length; i++) {
    const p = picked[i];
    onProgress?.(i, total);
    if (!p.webPath) continue;
    const name = p.path?.split("/").pop() ?? `photo-${Date.now()}-${i}.${p.format ?? "jpg"}`;
    const file = await uriToFile(p.webPath, name);
    if (!file) continue;

    const id = `device-${file.size}-${file.lastModified}-${file.name}`;
    if (await insertFileAsset(file, id)) inserted++;
  }

  onProgress?.(total, total);
  logNative("scan", "import complete", { ms: t(), inserted, total });
  if (inserted > 0) logIdb("assets", `inserted ${inserted} device assets`);
  return inserted;
}

/** No-op on this build — device assets already carry their blob. */
export async function resolveDeviceMedia(): Promise<string | null> {
  return null;
}
