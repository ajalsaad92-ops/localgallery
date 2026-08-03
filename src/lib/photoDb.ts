// Local-only metadata storage (IndexedDB via Dexie).
// Nothing leaves the device except uploads to the user's own Telegram account.
import Dexie, { type Table } from "dexie";
import type { ExifData } from "./exif";

export type ProviderKind = "device" | "telegram-remote";

export interface MediaAsset {
  id: string;
  provider: ProviderKind;
  name: string;
  size: number;
  mime: string;
  width?: number;
  height?: number;
  date: number;
  createdAt: number;
  exif?: ExifData;
  kind?: "image" | "video";
  duration?: number;
  posterDataUrl?: string;
  /** Original blob when imported through the browser file picker. */
  blob?: Blob;
  /** Native MediaStore URL. Metadata only — bytes stay in the phone gallery. */
  localUri?: string;
  /** Stable content signature used to avoid uploading the same file twice. */
  contentKey?: string;
  remoteMessageId?: number;
  /** Channel/group id the message lives in. */
  remoteChatId?: string;
  /** Set once the local asset has been uploaded successfully. */
  syncedAt?: number;
}

export interface KV {
  key: string;
  value: string;
}

export type SyncMode = "manual" | "auto";

export interface SyncSettings {
  mode: SyncMode;
  wifiOnly: boolean;
  maxFileMb: number;
  paused: boolean;
  /** Drop the local blob from IndexedDB right after a successful upload. */
  freeBlobAfterSync: boolean;
}

/**
 * Telegram accepts up to 2 GB per file, but the upload path has to hold the
 * bytes in memory and an Android WebView is killed long before that. 400 MB is
 * the largest size that still survives reliably on a mid-range phone.
 */
export const MAX_UPLOAD_MB = 400;

export const DEFAULT_SYNC_SETTINGS: SyncSettings = {
  mode: "auto",
  wifiOnly: true,
  maxFileMb: MAX_UPLOAD_MB,
  paused: false,
  freeBlobAfterSync: true,
};

class PhotoDatabase extends Dexie {
  assets!: Table<MediaAsset, string>;
  kv!: Table<KV, string>;

  constructor() {
    super("localgallery-pro");
    // Old versions are kept so upgrading users don't hit a schema mismatch.
    this.version(1).stores({ states: "id, favorite, archived, trashedAt" });
    this.version(11).stores({
      states: "id, favorite, archived, trashedAt, importedAt, locked",
      providers: "kind, configured",
      assets: "id, provider, date, createdAt",
      kv: "key",
      topicRules: "id, priority, kind",
      syncJobs: "id, status, createdAt, updatedAt",
      albums: "id, kind, key, updatedAt",
      albumMembers: "id, albumId, assetId, addedAt",
      embeddings: "id, modelId, updatedAt",
      faces: "id, assetId, personId, detectedAt, modelId, sourceStamp",
      persons: "id, updatedAt, hidden",
      ocr: "id, updatedAt",
    });
    this.version(12).stores({
      states: null, topicRules: null, syncJobs: null, albums: null,
      albumMembers: null, embeddings: null, faces: null, persons: null, ocr: null,
      providers: "kind, configured",
      assets: "id, provider, date, syncedAt, remoteFileId",
      kv: "key",
    });
    // v13: the Telegram bot path is gone — drop the providers table, and index
    // assets by contentKey so duplicate detection is a lookup, not a full scan.
    this.version(13)
      .stores({
        providers: null,
        assets: "id, provider, date, syncedAt, contentKey, remoteMessageId",
        kv: "key",
      })
      .upgrade(async (tx) => {
        const assets = tx.table("assets");
        // Bot-era remote rows are addressed by a bot file_id the app can no
        // longer resolve. Drop them; the channel re-import repopulates them.
        const stale = await assets
          .filter(
            (a: MediaAsset) =>
              a.provider === "telegram-remote" && a.remoteMessageId == null,
          )
          .primaryKeys();
        if (stale.length) await assets.bulkDelete(stale);

        // Backfill the content key for everything that survived.
        await assets.toCollection().modify((a: MediaAsset) => {
          if (!a.contentKey) a.contentKey = contentKeyOf(a);
        });
      });
  }
}

export const photoDb = new PhotoDatabase();

/**
 * Stable identity for a file, independent of its MediaStore id.
 * Name + size alone collide on screenshots, so the capture date is included.
 */
export function contentKeyOf(a: { name: string; size: number; date?: number }): string {
  return `${a.name}|${a.size}|${a.date ?? 0}`;
}
