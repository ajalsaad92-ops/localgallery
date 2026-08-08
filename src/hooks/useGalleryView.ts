import { useMemo, useState } from "react";
import { contentKeyOf, type MediaAsset } from "@/lib/photoDb";
import type { GalleryItem } from "@/lib/galleryItem";
import type { MediaFilter, SortOrder } from "@/components/gallery/FilterBar";

/**
 * Two files are "the same picture" when their content key matches. Only groups
 * of two or more are returned, so the duplicates view shows exactly the items
 * a user could safely thin out.
 */
function duplicateIds(assets: MediaAsset[]): Set<string> {
  const byKey = new Map<string, string[]>();
  for (const a of assets) {
    const k = a.contentKey ?? contentKeyOf(a);
    const arr = byKey.get(k);
    if (arr) arr.push(a.id);
    else byKey.set(k, [a.id]);
  }
  const dupes = new Set<string>();
  for (const ids of byKey.values()) {
    if (ids.length > 1) ids.forEach((id) => dupes.add(id));
  }
  return dupes;
}

/** MediaAsset → what the grid and the viewer render. */
export const toGalleryItem = (a: MediaAsset, thumb?: string): GalleryItem => ({
  id: a.id,
  width: a.width ?? 400,
  height: a.height ?? 400,
  date: new Date(a.date),
  name: a.name,
  thumbSrc: thumb ?? a.localUri,
  localUri: a.localUri,
  fullSrc: thumb ?? a.localUri,
  kind: a.kind === "video" ? "video" : "image",
  duration: a.duration,
  mime: a.mime,
  size: a.size,
  provider: a.provider,
});

/** Folders whose contents are noise in a photo timeline. */
const SCREENSHOT_RE = /screenshot|لقطات|screen ?shots?|captures?/i;

export const isScreenshot = (a: MediaAsset) =>
  SCREENSHOT_RE.test(a.bucket ?? "") || SCREENSHOT_RE.test(a.name);

/** Photos taken on this calendar day in an earlier year. */
export function onThisDay(assets: MediaAsset[], now = new Date()): MediaAsset[] {
  const d = now.getDate();
  const m = now.getMonth();
  const y = now.getFullYear();
  return assets
    .filter((a) => {
      const t = new Date(a.date);
      return t.getDate() === d && t.getMonth() === m && t.getFullYear() < y;
    })
    .sort((x, z) => z.date - x.date);
}

export interface GalleryView {
  filter: MediaFilter;
  setFilter: (f: MediaFilter) => void;
  sort: SortOrder;
  setSort: (s: SortOrder) => void;
  items: GalleryItem[];
  assets: MediaAsset[];
  counts: Partial<Record<MediaFilter, number>>;
  query: string;
  setQuery: (q: string) => void;
  /** Album folders present in the library, largest first. */
  buckets: { name: string; count: number }[];
  bucket: string | null;
  setBucket: (b: string | null) => void;
}

/** Filtering, sorting and duplicate detection shared by both galleries. */
export function useGalleryView(
  assets: MediaAsset[],
  opts: { defaultFilter?: MediaFilter; urlFor?: (a: MediaAsset) => string | undefined } = {},
): GalleryView {
  const [filter, setFilter] = useState<MediaFilter>(opts.defaultFilter ?? "all");
  const [sort, setSort] = useState<SortOrder>("newest");
  const [query, setQuery] = useState("");
  const [bucket, setBucket] = useState<string | null>(null);
  const urlFor = opts.urlFor;

  const dupes = useMemo(
    () => (filter === "duplicates" ? duplicateIds(assets) : new Set<string>()),
    [assets, filter],
  );

  const counts = useMemo<Partial<Record<MediaFilter, number>>>(() => {
    let photos = 0, videos = 0, pending = 0, shots = 0;
    for (const a of assets) {
      const shot = isScreenshot(a);
      if (shot) shots++;
      if (a.kind === "video") videos++;
      else if (!shot) photos++;
      if (a.provider === "device" && a.syncedAt == null) pending++;
    }
    return { all: assets.length - shots, photos, videos, pending, screenshots: shots };
  }, [assets]);

  const buckets = useMemo(() => {
    const counts = new Map<string, number>();
    for (const a of assets) {
      if (!a.bucket) continue;
      counts.set(a.bucket, (counts.get(a.bucket) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((x, z) => z.count - x.count);
  }, [assets]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const rows = assets.filter((a) => {
      if (bucket && a.bucket !== bucket) return false;
      if (q) {
        const when = new Date(a.date);
        const haystack = [
          a.name,
          a.bucket ?? "",
          String(when.getFullYear()),
          when.toLocaleDateString("ar", { month: "long", year: "numeric" }),
          when.toLocaleDateString("en", { month: "long" }),
        ].join(" ").toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      switch (filter) {
        case "photos": return a.kind !== "video" && !isScreenshot(a);
        case "videos": return a.kind === "video";
        case "screenshots": return isScreenshot(a);
        case "pending": return a.provider === "device" && a.syncedAt == null;
        case "duplicates": return dupes.has(a.id);
        // The main timeline stays clean: screenshots live in their own filter.
        default: return !isScreenshot(a);
      }
    });

    const sorted = [...rows];
    if (sort === "oldest") sorted.sort((x, y) => x.date - y.date);
    else if (sort === "largest") sorted.sort((x, y) => (y.size || 0) - (x.size || 0));
    else sorted.sort((x, y) => y.date - x.date);
    return sorted;
  }, [assets, filter, sort, dupes, query, bucket]);

  const items = useMemo(
    () => filtered.map((a) => toGalleryItem(a, urlFor?.(a))),
    [filtered, urlFor],
  );

  return {
    filter, setFilter, sort, setSort, items, assets: filtered, counts,
    query, setQuery, buckets, bucket, setBucket,
  };
}

/** Multi-select state for a grid. */
export function useSelection() {
  const [selected, setSelected] = useState<Set<string> | null>(null);

  return {
    selected,
    selecting: selected !== null,
    start: (id: string) => setSelected(new Set([id])),
    clear: () => setSelected(null),
    toggle: (id: string) =>
      setSelected((cur) => {
        if (!cur) return new Set([id]);
        const next = new Set(cur);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next.size === 0 ? null : next;
      }),
    selectAll: (ids: string[]) =>
      setSelected((cur) => (cur && cur.size === ids.length ? new Set([ids[0]]) : new Set(ids))),
  };
}
