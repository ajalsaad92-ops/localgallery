import { useEffect, useState } from "react";
import { liveQuery } from "dexie";
import { photoDb, type MediaAsset } from "@/lib/photoDb";

type Filter =
  | { kind: "unsynced-device" }
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
        case "unsynced-device":
          return rows.filter((r) => r.provider === "device" && r.syncedAt == null);
        case "telegram-remote":
          return rows.filter((r) => r.remoteMessageId != null);
        default:
          return rows;
      }
    }).subscribe({ next: setAssets });
    return () => sub.unsubscribe();
  }, [kind]);

  return assets;
}
