import { useEffect, useState } from "react";
import { photoDb, type MediaAsset } from "@/lib/photoDb";

/**
 * Import the media history of the selected channel through the linked personal
 * account. Metadata lands first so the grid fills immediately; previews stream
 * in afterwards.
 */
export async function importChannelHistory(limit = 0): Promise<number> {
  const { fetchChannelMedia } = await import("@/lib/providers/mtproto");
  return fetchChannelMedia(limit, async (item) => {
    const id = `tgm-${item.chatId}-${item.messageId}`;
    const base: Partial<MediaAsset> = {
      provider: "telegram-remote",
      remoteMessageId: item.messageId,
      remoteChatId: item.chatId,
      name: item.name,
      size: item.size,
      mime: item.mime,
      kind: item.kind,
      width: item.width,
      height: item.height,
      duration: item.duration,
      date: item.date || Date.now(),
    };
    // Never wipe a poster that was already downloaded.
    if (item.thumbDataUrl) base.posterDataUrl = item.thumbDataUrl;

    const existing = await photoDb.assets.get(id);
    if (existing) await photoDb.assets.update(id, base);
    else await photoDb.assets.put({ id, createdAt: Date.now(), ...base } as MediaAsset);
  });
}

/**
 * Download the small Telegram-side preview for every remote asset that has
 * none yet, a few at a time so the grid fills progressively.
 */
let hydrating = false;

export async function hydrateThumbnails(
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  if (hydrating) return;
  hydrating = true;
  try {
    const { fetchMessageThumb } = await import("@/lib/providers/mtproto");
    const pending = (await photoDb.assets.toArray()).filter(
      (a) => a.provider === "telegram-remote" && !a.posterDataUrl && a.remoteMessageId != null,
    );
    const total = pending.length;
    if (total === 0) return;

    let done = 0;
    const queue = [...pending];
    const workers = Array.from({ length: 4 }, async () => {
      for (;;) {
        const a = queue.shift();
        if (!a) return;
        try {
          const url = await fetchMessageThumb(a.remoteMessageId!);
          if (url) await photoDb.assets.update(a.id, { posterDataUrl: url });
        } catch {
          /* keep going */
        }
        onProgress?.(++done, total);
      }
    });
    await Promise.all(workers);
  } finally {
    hydrating = false;
  }
}

/** Stream the full bytes of a remote asset, decoding HEIC when needed. */
export async function resolveRemoteUrl(
  asset: MediaAsset,
  onProgress?: (received: number, total: number) => void,
): Promise<string | null> {
  if (asset.remoteMessageId == null) return null;
  const { downloadMessageBlob } = await import("@/lib/providers/mtproto");
  const blob = await downloadMessageBlob(asset.remoteMessageId, {
    fallbackMime: asset.mime,
    onProgress,
  });
  if (!blob) return null;

  // Android WebView cannot render HEIC — decode it to JPEG on device.
  const { isHeic, heicBlobToJpegUrl } = await import("@/lib/heic");
  if (isHeic(blob.type, asset.name)) {
    const jpeg = await heicBlobToJpegUrl(blob, asset.id);
    if (jpeg) return jpeg;
  }
  return URL.createObjectURL(blob);
}

/**
 * Object URLs for locally-held blobs. Remote items are fetched on demand when
 * the lightbox opens, so nothing is downloaded just to fill the grid.
 */
export function useLocalBlobUrls(assets: MediaAsset[]): Map<string, string> {
  const [urls, setUrls] = useState<Map<string, string>>(new Map());

  useEffect(() => {
    const next = new Map<string, string>();
    for (const a of assets) {
      if (a.blob) next.set(a.id, URL.createObjectURL(a.blob));
    }
    setUrls(next);
    return () => next.forEach((u) => URL.revokeObjectURL(u));
  }, [assets]);

  return urls;
}
