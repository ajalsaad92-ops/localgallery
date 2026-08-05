import { useEffect, useState } from "react";
import { liveQuery } from "dexie";
import { photoDb, type MediaAsset } from "@/lib/photoDb";

type Filter =
  | { kind: "device" }
  | { kind: "telegram-remote" }
  | { kind: "all" };

/** Live view of the asset table, newest first. */
export function useMediaAssets(filter: Filter = { kind: "all" }): MediaAsset[] {
  const [assets, setAssets] = useState<MediaAsset[]>([]);
  const kind = filter.kind;

  useEffect(() => {
    const sub = liveQuery(async () => {
      const rows = await photoDb.assets.orderBy("date").reverse().toArray();
      switch (kind) {
        case "device":
          // Everything physically on this phone, uploaded or not.
          return rows.filter((r) => r.provider === "device");
        case "telegram-remote":
          // Only the channel index. A local row is never mirrored here, so a
          // photo can no longer show up twice.
          return rows.filter((r) => r.provider === "telegram-remote");
        default:
          return rows;
      }
    }).subscribe({ next: setAssets });
    return () => sub.unsubscribe();
  }, [kind]);

  return assets;
}
