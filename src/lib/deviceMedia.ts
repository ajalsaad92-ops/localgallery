// Device gallery indexing.
//
// Only metadata is stored — the bytes stay in the phone's gallery and are read
// on demand at upload time. The first run walks the whole library; every run
// after that only asks MediaStore for items newer than the last one seen, so
// reopening the app is instant no matter how many photos there are.
import { Capacitor } from "@capacitor/core";
import { photoDb, contentKeyOf, type MediaAsset } from "./photoDb";
import { extractExif } from "./exif";
import { isVideoMime } from "./video";
import {
  requestGalleryPermission,
  scanNativeGalleryBatch,
  type NativeGalleryAsset,
} from "./native";

export const canScanDeviceGallery = () => Capacitor.isNativePlatform();

const WATERMARK_KEY = "scan:watermark";

async function getWatermark(): Promise<number> {
  const row = await photoDb.kv.get(WATERMARK_KEY);
  const n = Number(row?.value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

async function setWatermark(ms: number) {
  await photoDb.kv.put({ key: WATERMARK_KEY, value: String(ms) });
}

/** Import files chosen through a browser file input (web builds). */
export async function importWebFiles(files: File[]): Promise<number> {
  let inserted = 0;
  for (const file of files) {
    const id = `web-${file.size}-${file.lastModified}-${file.name}`;
    if (await photoDb.assets.get(id)) continue;

    const isVideo = isVideoMime(file.type);
    let width: number | undefined;
    let height: number | undefined;
    let date = file.lastModified || Date.now();
    let posterDataUrl: string | undefined;
    let duration: number | undefined;

    try {
      if (isVideo) {
        const { extractVideoMeta } = await import("./video");
        const m = await extractVideoMeta(file);
        width = m.width; height = m.height;
        duration = m.duration; posterDataUrl = m.posterDataUrl;
      } else {
        const exif = await extractExif(file);
        width = exif.width; height = exif.height;
        date = exif.dateTaken ?? date;
      }
    } catch {
      /* metadata is optional — the file must still import */
    }

    const asset: MediaAsset = {
      id,
      provider: "device",
      name: file.name,
      size: file.size,
      mime: file.type || (isVideo ? "video/*" : "image/*"),
      width, height,
      date,
      createdAt: Date.now(),
      kind: isVideo ? "video" : "image",
      blob: file,
      contentKey: contentKeyOf({ name: file.name, size: file.size, date }),
      ...(posterDataUrl ? { posterDataUrl } : {}),
      ...(duration ? { duration } : {}),
    };
    await photoDb.assets.put(asset);
    inserted++;
  }
  return inserted;
}

/** Insert one MediaStore row, skipping anything already indexed or uploaded. */
async function insertNativeAsset(
  item: NativeGalleryAsset,
  knownKeys: Set<string>,
): Promise<boolean> {
  const id = `device-${item.id}`;
  const date = item.date || Date.now();
  const key = contentKeyOf({ name: item.name, size: item.size, date });

  // The same photo reappears with a fresh MediaStore id after a restore or a
  // folder move. Never index — or re-upload — it twice.
  if (knownKeys.has(key)) return false;
  if (await photoDb.assets.get(id)) {
    knownKeys.add(key);
    return false;
  }

  await photoDb.assets.put({
    id,
    provider: "device",
    name: item.name,
    size: item.size,
    mime: item.mime || (item.kind === "video" ? "video/*" : "image/*"),
    width: item.width,
    height: item.height,
    date,
    createdAt: Date.now(),
    kind: item.kind,
    duration: item.duration,
    localUri: item.webPath,
    contentKey: key,
  });
  knownKeys.add(key);
  return true;
}

let scanning = false;

/**
 * Index the device gallery.
 *
 * @param onProgress called with the number of items indexed so far
 * @param full      ignore the watermark and re-walk the entire library
 */
export async function scanDeviceGallery(
  onProgress?: (indexed: number) => void,
  full = false,
): Promise<number> {
  if (!canScanDeviceGallery() || scanning) return 0;
  if (!(await requestGalleryPermission().catch(() => false))) return 0;

  scanning = true;
  try {
    const since = full ? 0 : await getWatermark();
    // One lookup instead of a per-item scan.
    const knownKeys = new Set(
      (await photoDb.assets.toArray()).map((a) => a.contentKey ?? contentKeyOf(a)),
    );

    const PAGE = 200;
    let offset = 0;
    let inserted = 0;
    let newestSeen = since;

    for (;;) {
      const batch = await scanNativeGalleryBatch(offset, PAGE, since);
      const items = batch.items ?? [];
      if (items.length === 0) break;

      for (const item of items) {
        if (item.date > newestSeen) newestSeen = item.date;
        if (await insertNativeAsset(item, knownKeys)) inserted++;
      }
      onProgress?.(inserted);

      offset += items.length;
      if (items.length < PAGE) break;
    }

    // Rewind a minute so an item written during the scan isn't missed.
    if (newestSeen > 0) await setWatermark(Math.max(0, newestSeen - 60_000));
    return inserted;
  } finally {
    scanning = false;
  }
}
