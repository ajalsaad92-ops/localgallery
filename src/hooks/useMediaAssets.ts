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
    }).subscribe({ next: setAssets });
    return () => sub.unsubscribe();
  }, [kind]);

  return assets;
}
