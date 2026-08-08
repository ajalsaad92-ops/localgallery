import { useEffect, useState } from "react";
import { liveQuery } from "dexie";
import { photoDb, type MediaAsset } from "@/lib/photoDb";

type Filter =
  | { kind: "device" }
  | { kind: "telegram-remote" }
  | { kind: "all" };

/**
 * How long results are allowed to be stale.
 *
 * Dexie re-runs a liveQuery on every write to the tables it touched, and a
 * backup writes one row per uploaded file. At a hundred files in flight that
 * was hundreds of full-table reads a minute, each one re-sorting the entire
 * library and re-rendering the grid — the app being "جامد" was mostly this.
 * Sorting is by capture date, so a second of lag is invisible.
 */
const COALESCE_MS = 1200;

/** Live view of the asset table, newest first. */
export function useMediaAssets(filter: Filter = { kind: "all" }): MediaAsset[] {
  const [assets, setAssets] = useState<MediaAsset[]>([]);
  const kind = filter.kind;

  useEffect(() => {
    // Trailing throttle: the first result paints at once, later bursts are
    // collapsed into one repaint per window.
    let timer: ReturnType<typeof setTimeout> | null = null;
    let latest: MediaAsset[] | null = null;
    let lastPaint = 0;
    let alive = true;

    const paint = () => {
      timer = null;
      if (!alive || !latest) return;
      lastPaint = Date.now();
      setAssets(latest);
      latest = null;
    };

    const push = (rows: MediaAsset[]) => {
      latest = rows;
      const due = lastPaint + COALESCE_MS - Date.now();
      if (due <= 0) return paint();
      if (!timer) timer = setTimeout(paint, due);
    };

    const sub = liveQuery(async () => {
      const rows = await photoDb.assets.orderBy("date").reverse().toArray();
      switch (kind) {
        case "device":
          // Everything physically on this phone, uploaded or not.
          return rows.filter((r) => r.provider === "device");
        case "telegram-remote": {
          // Only the channel index, and only the channel that is selected right
          // now. Records left over from a previously chosen channel used to
          // stay on screen, which is why the counts looked wrong after
          // switching and photos appeared that were not in the new channel.
          const target = await photoDb.kv.get("tg:user:target");
          let chatId: string | null = null;
          try {
            chatId = target?.value ? (JSON.parse(target.value) as { id: string }).id : null;
          } catch {
            chatId = null;
          }
          return rows.filter(
            (r) =>
              r.provider === "telegram-remote" &&
              (chatId == null || r.remoteChatId === chatId),
          );
        }
        default:
          return rows;
      }
    }).subscribe({ next: push });

    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
      sub.unsubscribe();
    };
  }, [kind]);

  return assets;
}
