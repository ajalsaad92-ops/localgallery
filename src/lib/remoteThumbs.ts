/**
 * Preview cache for Telegram items.
 *
 * The JPEGs used to sit inline on the asset row, so every live query pulled
 * the whole library's image data into memory on each update. They now live in
 * their own table and are read one tile at a time, with a small in-memory LRU
 * on top so scrolling back is instant.
 */
import { photoDb } from "./photoDb";

const MAX_CACHE = 400;
const cache = new Map<string, string>();
const inflight = new Map<string, Promise<string | null>>();
const missing = new Set<string>();

function remember(id: string, dataUrl: string) {
  if (cache.size >= MAX_CACHE) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(id, dataUrl);
}

export function cachedRemoteThumb(id: string): string | undefined {
  const hit = cache.get(id);
  if (hit) {
    cache.delete(id);
    cache.set(id, hit);
  }
  return hit;
}

export async function getRemoteThumb(id: string): Promise<string | null> {
  const hit = cachedRemoteThumb(id);
  if (hit) return hit;
  if (missing.has(id)) return null;

  const running = inflight.get(id);
  if (running) return running;

  const task = (async () => {
    try {
      const row = await photoDb.thumbs.get(id);
      if (row?.dataUrl) {
        remember(id, row.dataUrl);
        return row.dataUrl;
      }
      missing.add(id);
      return null;
    } catch {
      return null;
    } finally {
      inflight.delete(id);
    }
  })();

  inflight.set(id, task);
  return task;
}

/**
 * Bumped whenever a preview lands, so tiles that already rendered a
 * placeholder know to look again. Without it a tile that mounted before its
 * thumbnail was downloaded stays a skeleton until it is scrolled out of view
 * and back — which is most of the grid right after a channel import.
 */
let version = 0;
const watchers = new Set<() => void>();

export function thumbsVersion() {
  return version;
}

export function watchRemoteThumbs(cb: () => void): () => void {
  watchers.add(cb);
  return () => watchers.delete(cb);
}

let notifyScheduled = false;
function notifyWatchers() {
  // Hydration writes in bursts; collapse them into one repaint.
  if (notifyScheduled) return;
  notifyScheduled = true;
  setTimeout(() => {
    notifyScheduled = false;
    version++;
    watchers.forEach((cb) => cb());
  }, 250);
}

export async function putRemoteThumb(id: string, dataUrl: string) {
  await photoDb.thumbs.put({ id, dataUrl });
  missing.delete(id);
  remember(id, dataUrl);
  notifyWatchers();
}

/** Ids that still need a preview downloaded. */
export async function thumbIdsPresent(): Promise<Set<string>> {
  return new Set(await photoDb.thumbs.toCollection().primaryKeys());
}

export async function dropRemoteThumbs(ids: string[]) {
  if (!ids.length) return;
  await photoDb.thumbs.bulkDelete(ids);
  ids.forEach((id) => { cache.delete(id); missing.delete(id); });
}
