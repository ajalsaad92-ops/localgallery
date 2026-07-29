import { useEffect, useRef, useState } from "react";
import { liveQuery } from "dexie";
import { photoDb, type MediaAsset } from "@/lib/photoDb";
import {
  telegramGetUpdates,
  telegramGetFilePath,
  telegramFileUrl,
} from "@/lib/providers/telegram";
import { logNative, logTg } from "@/lib/diagnostics";

const OFFSET_KEY = "tg:updates:offset";

interface TelegramMessagePhoto { file_id: string; width: number; height: number; file_size?: number }
interface TelegramThumb { file_id?: string; width?: number; height?: number }
interface TelegramMessageDocument {
  file_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
  thumb?: TelegramThumb;
  thumbnail?: TelegramThumb;
}
interface TelegramMessageVideo {
  file_id: string;
  width: number;
  height: number;
  duration?: number;
  mime_type?: string;
  file_size?: number;
  thumb?: TelegramThumb;
  thumbnail?: TelegramThumb;
}
interface RawUpdate {
  update_id: number;
  message?: {
    message_id: number;
    date: number;
    photo?: TelegramMessagePhoto[];
    document?: TelegramMessageDocument;
    video?: TelegramMessageVideo;
    caption?: string;
  };
  channel_post?: RawUpdate["message"];
}

const thumbId = (t?: TelegramThumb | null) => t?.file_id;

async function insertFromUpdate(u: RawUpdate) {
  const msg = u.message ?? u.channel_post;
  if (!msg) return;
  // Telegram's message date is the upload time — prefer the original capture
  // time we embedded in the caption (or the camera filename).
  const date = resolveOriginalDate({
    caption: msg.caption,
    name: msg.document?.file_name,
    messageDateMs: (msg.date ?? Math.floor(Date.now() / 1000)) * 1000,
  });


  const put = async (partial: Partial<MediaAsset> & { id: string; remoteFileId: string }) => {
    const syncedLocal = await photoDb.assets.where("remoteFileId").equals(partial.remoteFileId).first();
    if (syncedLocal) {
      const { id: _ignored, ...patch } = partial;
      await photoDb.assets.update(syncedLocal.id, {
        ...patch,
        provider: "telegram-remote",
        remoteMessageId: msg.message_id,
      });
      return;
    }
    const existing = await photoDb.assets.get(partial.id);
    if (existing) return;
    const asset: MediaAsset = {
      name: `tg-${partial.remoteFileId.slice(0, 12)}`,
      size: 0,
      mime: "image/jpeg",
      date,
      createdAt: Date.now(),
      provider: "telegram-remote",
      remoteMessageId: msg.message_id,
      ...partial,
    } as MediaAsset;
    await photoDb.assets.put(asset);
  };

  if (msg.photo?.length) {
    const largest = msg.photo[msg.photo.length - 1];
    await put({
      id: `tg-${largest.file_id}`,
      remoteFileId: largest.file_id,
      width: largest.width,
      height: largest.height,
      size: largest.file_size ?? 0,
      kind: "image",
      mime: "image/jpeg",
    });
  }
  if (msg.document && msg.document.mime_type?.startsWith("image/")) {
    await put({
      id: `tg-${msg.document.file_id}`,
      remoteFileId: msg.document.file_id,
      thumbFileId: thumbId(msg.document.thumb ?? msg.document.thumbnail),
      width: msg.document.thumb?.width,
      height: msg.document.thumb?.height,
      size: msg.document.file_size ?? 0,
      name: msg.document.file_name ?? `tg-${msg.document.file_id.slice(0, 8)}`,
      kind: "image",
      mime: msg.document.mime_type,
    });
  }
  if (msg.document && msg.document.mime_type?.startsWith("video/")) {
    await put({
      id: `tg-${msg.document.file_id}`,
      remoteFileId: msg.document.file_id,
      thumbFileId: thumbId(msg.document.thumb ?? msg.document.thumbnail),
      size: msg.document.file_size ?? 0,
      name: msg.document.file_name ?? `tg-${msg.document.file_id.slice(0, 8)}`,
      kind: "video",
      mime: msg.document.mime_type,
    });
  }
  if (msg.video) {
    await put({
      id: `tg-${msg.video.file_id}`,
      remoteFileId: msg.video.file_id,
      thumbFileId: thumbId(msg.video.thumb ?? msg.video.thumbnail),
      width: msg.video.width,
      height: msg.video.height,
      duration: msg.video.duration,
      size: msg.video.file_size ?? 0,
      kind: "video",
      mime: msg.video.mime_type ?? "video/mp4",
    });
  }
}

/**
 * Polls Telegram getUpdates on mount and every `intervalMs`. Persists the
 * last update_id in kv so we don't re-ingest on reload. Every image/video
 * message becomes a telegram-remote MediaAsset that the gallery can render.
 */
export function useTelegramFeed(enabled: boolean, intervalMs = 15000, trigger: number = 0) {
  const running = useRef(false);
  const [lastError, setLastError] = useState<string | null>(null);
  const [lastPolledAt, setLastPolledAt] = useState<number | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    const poll = async () => {
      if (running.current) return;
      running.current = true;
      try {
        const cfg = await photoDb.providers.get("telegram");
        if (!cfg?.botToken) return;
        const offsetRaw = await photoDb.kv.get(OFFSET_KEY);
        const offset = offsetRaw?.value ? Number(offsetRaw.value) + 1 : undefined;
        const updates = (await telegramGetUpdates(cfg.botToken, offset)) as unknown as RawUpdate[];
        for (const u of updates) {
          await insertFromUpdate(u);
        }
        if (updates.length) {
          const maxId = Math.max(...updates.map((u) => u.update_id));
          await photoDb.kv.put({ key: OFFSET_KEY, value: String(maxId) });
        }
        setLastError(null);
        setLastPolledAt(Date.now());
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setLastError(msg);
        logNative("telegram-feed", msg, "warn");
      } finally {
        running.current = false;
      }
    };

    void poll();
    const id = window.setInterval(() => { if (!cancelled) void poll(); }, intervalMs);
    return () => { cancelled = true; window.clearInterval(id); };
  }, [enabled, intervalMs, trigger]);

  return { lastError, lastPolledAt };
}

/**
 * Import the full media history of the selected channel through the linked
 * personal account (MTProto). Unlike the bot feed this reaches old messages.
 */
export async function importChannelHistory(limit = 0): Promise<number> {
  const { fetchChannelMedia } = await import("@/lib/providers/mtproto");
  let added = 0;
  let updated = 0;
  const n = await fetchChannelMedia(limit, async (item) => {
    const id = `tgm-${item.chatId}-${item.messageId}`;
    const existing = await photoDb.assets.get(id);
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
    // Never wipe a poster we already downloaded.
    if (item.thumbDataUrl) base.posterDataUrl = item.thumbDataUrl;
    if (existing) { await photoDb.assets.update(id, base); updated++; }
    else { await photoDb.assets.put({ id, createdAt: Date.now(), ...base } as MediaAsset); added++; }
  });
  logTg("import", "channel history stored", { scanned: n, added, updated });
  return n;
}

/**
 * Download the small Telegram-side preview for every remote asset that has
 * none yet. Runs with a small concurrency so the grid fills in progressively
 * instead of blocking the import.
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
      (a) => a.provider === "telegram-remote" && !a.posterDataUrl && !a.remoteFileId && a.remoteMessageId,
    );
    logTg("import", `hydrating ${pending.length} thumbnails`);
    let done = 0;
    const workers = Array.from({ length: 4 }, async () => {
      for (;;) {
        const a = pending.shift();
        if (!a) return;
        try {
          const url = await fetchMessageThumb(a.remoteMessageId!);
          if (url) await photoDb.assets.update(a.id, { posterDataUrl: url });
        } catch { /* keep going */ }
        onProgress?.(++done, pending.length + done);
      }
    });
    await Promise.all(workers);
    logTg("import", `thumbnails hydrated`, { done });
  } finally {
    hydrating = false;
  }
}



/** Resolve a full-size URL for a remote asset (getFile → file/bot). */
export async function resolveRemoteUrl(asset: MediaAsset): Promise<string | null> {
  // Personal-account items have no bot file id — stream them through MTProto.
  if (!asset.remoteFileId && asset.remoteMessageId && asset.remoteChatId) {
    const { downloadMessageBlob } = await import("@/lib/providers/mtproto");
    const blob = await downloadMessageBlob(asset.remoteMessageId);
    return blob ? URL.createObjectURL(blob) : null;
  }
  if (!asset.remoteFileId) return null;
  const cfg = await photoDb.providers.get("telegram");
  if (!cfg?.botToken) return null;
  if (asset.remoteFilePath) return telegramFileUrl(cfg.botToken, asset.remoteFilePath);
  const path = await telegramGetFilePath(cfg.botToken, asset.remoteFileId);
  await photoDb.assets.update(asset.id, { remoteFilePath: path });
  return telegramFileUrl(cfg.botToken, path);
}


export async function resolveThumbUrl(asset: MediaAsset): Promise<string | null> {
  if (!asset.thumbFileId) return null;
  const cfg = await photoDb.providers.get("telegram");
  if (!cfg?.botToken) return null;
  if (asset.thumbFilePath) return telegramFileUrl(cfg.botToken, asset.thumbFilePath);
  try {
    const path = await telegramGetFilePath(cfg.botToken, asset.thumbFileId);
    await photoDb.assets.update(asset.id, { thumbFilePath: path });
    return telegramFileUrl(cfg.botToken, path);
  } catch { return null; }
}

export interface RemoteUrls { full: Map<string, string>; thumb: Map<string, string> }

export function useRemoteAssetUrls(assets: MediaAsset[]): RemoteUrls {
  const [urls, setUrls] = useState<RemoteUrls>({ full: new Map(), thumb: new Map() });
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const full = new Map(urls.full);
      const thumb = new Map(urls.thumb);
      let changed = false;
      for (const a of assets) {
        // Thumbnails: always resolve when Telegram sent one (HEIC + videos).
        if (a.thumbFileId && !thumb.has(a.id)) {
          const t = await resolveThumbUrl(a);
          if (cancelled) return;
          if (t) { thumb.set(a.id, t); changed = true; }
        }
        if (full.has(a.id)) continue;
        if (a.remoteFileId) {
          try {
            const url = await resolveRemoteUrl(a);
            if (cancelled) return;
            if (url) { full.set(a.id, url); changed = true; }
          } catch { /* skip */ }
          continue;
        }
        if (a.blob) {
          full.set(a.id, URL.createObjectURL(a.blob));
          changed = true;
        }
      }
      if (changed && !cancelled) setUrls({ full, thumb });
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assets]);
  return urls;
}

export { insertFromUpdate as _insertFromUpdate };
