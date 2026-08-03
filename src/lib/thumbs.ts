/**
 * Thumbnail service for device media.
 *
 * The grid used to point <img> at the original content:// URI. That decoded a
 * full multi-megapixel bitmap for every ~130px cell (slow, memory-hungry) and
 * produced a broken image for videos, which an <img> cannot render at all.
 *
 * MediaStore already keeps small thumbnails, so ask the native layer for one
 * per item. Requests are capped and cached, and because the grid is
 * virtualized only the tiles near the viewport ever ask.
 */
import { LocalGalleryMedia, isNative } from "./native";

const MAX_CACHE = 600;
const MAX_PARALLEL = 4;

const cache = new Map<string, string>();
const inflight = new Map<string, Promise<string | null>>();
const failed = new Set<string>();
let active = 0;
const waiting: (() => void)[] = [];

function slot(): Promise<void> {
  if (active < MAX_PARALLEL) {
    active++;
    return Promise.resolve();
  }
  return new Promise((r) => waiting.push(() => { active++; r(); }));
}

function release() {
  active--;
  waiting.shift()?.();
}

/** Most-recently-used wins; the oldest entries are dropped first. */
function remember(id: string, dataUrl: string) {
  if (cache.size >= MAX_CACHE) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(id, dataUrl);
}

export function cachedThumb(assetId: string): string | undefined {
  const key = nativeId(assetId);
  const hit = cache.get(key);
  if (hit) {
    // Refresh recency.
    cache.delete(key);
    cache.set(key, hit);
  }
  return hit;
}

/** `device-image-42` → `image-42`, which is what the native side indexes by. */
function nativeId(assetId: string): string {
  return assetId.replace(/^device-/, "");
}

export async function loadThumb(assetId: string, size = 256): Promise<string | null> {
  if (!isNative()) return null;
  const key = nativeId(assetId);
  if (!/^(image|video)-\d+$/.test(key)) return null;

  const hit = cachedThumb(assetId);
  if (hit) return hit;
  if (failed.has(key)) return null;

  const running = inflight.get(key);
  if (running) return running;

  const task = (async () => {
    await slot();
    try {
      const res = await LocalGalleryMedia.getThumbnail({ id: key, size });
      if (res?.dataUrl) {
        remember(key, res.dataUrl);
        return res.dataUrl;
      }
      failed.add(key);
      return null;
    } catch {
      // Missing thumbnails are normal (corrupt file, pending media scan).
      failed.add(key);
      return null;
    } finally {
      release();
      inflight.delete(key);
    }
  })();

  inflight.set(key, task);
  return task;
}

/** Called after a delete so a recycled MediaStore id can't show a stale image. */
export function forgetThumb(assetId: string) {
  const key = nativeId(assetId);
  cache.delete(key);
  failed.delete(key);
}
