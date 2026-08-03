// The shape the gallery UI renders. Built from a MediaAsset by each screen.

export interface GalleryItem {
  id: string;
  width: number;
  height: number;
  date: Date;
  name: string;
  /** Grid thumbnail. */
  thumbSrc?: string;
  /** Full-size source, resolved lazily for remote items. */
  fullSrc?: string;
  /** Poster frame for videos and HEIC. */
  posterSrc?: string;
  provider?: "device" | "telegram-remote";
  size?: number;
  kind?: "image" | "video";
  /** Seconds. */
  duration?: number;
  mime?: string;
}

export interface DateGroup {
  label: string;
  items: GalleryItem[];
}

const dayFormatter = new Intl.DateTimeFormat("ar", {
  year: "numeric", month: "long", day: "numeric", weekday: "long",
});

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/** Group photos into "today / yesterday / full date" buckets, newest first. */
export function groupByDate(photos: GalleryItem[]): DateGroup[] {
  const today = startOfDay(new Date());
  const yesterday = today - 86_400_000;

  const groups = new Map<string, GalleryItem[]>();
  for (const p of photos) {
    const day = startOfDay(p.date);
    const label =
      day === today ? "اليوم"
      : day === yesterday ? "أمس"
      : dayFormatter.format(p.date);
    const arr = groups.get(label);
    if (arr) arr.push(p);
    else groups.set(label, [p]);
  }
  return Array.from(groups, ([label, items]) => ({ label, items }));
}
