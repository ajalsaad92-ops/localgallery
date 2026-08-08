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
  /** Original blob when imported through the browser file picker. */
  blob?: Blob;
  /** Native MediaStore URL. Metadata only — bytes stay in the phone gallery. */
  localUri?: string;
  /** Stable content signature used to avoid uploading the same file twice. */
  contentKey?: string;
  /** Album folder on the phone, used for the folders view. */
  bucket?: string;
  remoteMessageId?: number;
  /** Channel/group id the message lives in. */
  remoteChatId?: string;
  /** Set once the local asset has been uploaded successfully. */
  syncedAt?: number;
  /**
   * @deprecated Previews live in the `thumbs` table since v14 — an inline
   * base64 string here is loaded by every full-table read.
   */
  posterDataUrl?: string;
}

/** Preview JPEG for a remote item, kept out of the asset row on purpose. */
export interface ThumbRow {
  id: string;
  dataUrl: string;
}

export interface KV {
  key: string;
  value: string;
}

/**
 * One row per upload that started but has not been confirmed locally yet.
 *
 * There is exactly one window in which this app can send the same photo twice:
 * Telegram accepts the file, and the phone dies (or Android kills the process)
 * before the asset row is marked as synced. The journal survives that, and the
 * next sync pass settles it against the channel's own captions instead of
 * blindly uploading again.
 */
export interface UploadJournalRow {
  /** contentKey of the asset — the same value stamped into the caption. */
  key: string;
  assetId: string;
  chatId: string;
  name: string;
  startedAt: number;
}

export type SyncMode = "manual" | "auto";

export interface SyncSettings {
  mode: SyncMode;
  wifiOnly: boolean;
  maxFileMb: number;
  paused: boolean;
  /** Drop the local blob from IndexedDB right after a successful upload. */
  freeBlobAfterSync: boolean;
  /** How many files to send at once. Bounded by memory, not just by count. */
  parallelUploads: number;
}

/**
 * Upload ceiling.
 *
 * This used to be 400 MB because gramjs held every byte of a file in memory
 * before sending it. The uploader streams the blob part by part now, so the
 * binding constraint is Telegram's own limit of 4000 parts × 512 KB.
 */
export const MAX_UPLOAD_MB = 1900;

/**
 * Default cut-off, well below the ceiling on purpose: a multi-gigabyte video
 * would hold a slot for hours on a phone connection. Raise it in Settings.
 */
export const DEFAULT_MAX_FILE_MB = 400;

export const DEFAULT_SYNC_SETTINGS: SyncSettings = {
  mode: "auto",
  wifiOnly: true,
  maxFileMb: DEFAULT_MAX_FILE_MB,
  paused: false,
  freeBlobAfterSync: true,
  parallelUploads: 4,
};

class PhotoDatabase extends Dexie {
  assets!: Table<MediaAsset, string>;
  kv!: Table<KV, string>;
  thumbs!: Table<ThumbRow, string>;
  uploads!: Table<UploadJournalRow, string>;

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

    // v14: preview JPEGs move out of the asset row.
    //
    // They were stored inline as base64, and every live query does a full
    // toArray() — so each gallery update deserialized tens of megabytes of
    // image data. That is what made the Telegram tab crawl and what pushed the
    // WebView into out-of-memory kills. Rows are metadata again; previews are
    // fetched per visible tile.
    this.version(14)
      .stores({
        assets: "id, provider, date, syncedAt, contentKey, remoteMessageId, remoteChatId",
        kv: "key",
        thumbs: "id",
      })
      .upgrade(async (tx) => {
        const assets = tx.table("assets");
        const thumbs = tx.table("thumbs");
        // Stream it. Reading them all first would be the very out-of-memory
        // load this migration exists to remove — and a failed upgrade makes
        // every later open() reject, leaving the app permanently broken.
        let batch: { id: string; dataUrl: string }[] = [];
        const flush = async () => {
          if (!batch.length) return;
          await thumbs.bulkPut(batch);
          batch = [];
        };
        await assets.toCollection().modify((a: MediaAsset) => {
          if (typeof a.posterDataUrl !== "string") return;
          batch.push({ id: a.id, dataUrl: a.posterDataUrl });
          a.posterDataUrl = undefined;
        });
        // `modify` collects synchronously; write what it gathered.
        for (let i = 0; i < batch.length; i += 200) {
          await thumbs.bulkPut(batch.slice(i, i + 200));
        }
        await flush();
      });

    // v15: index the album folder for the folders view. This has to be its own
    // version — v14 already shipped, and Dexie only applies a version's schema
    // to databases that have not reached it yet.
    this.version(15).stores({
      assets:
        "id, provider, date, syncedAt, contentKey, remoteMessageId, remoteChatId, bucket",
      kv: "key",
      thumbs: "id",
    });

    // v16: a phone file stays "device" forever. Earlier builds re-labelled the
    // row as "telegram-remote" once it uploaded, which made the channel tab
    // show the same photo twice — once from the local row, once from the
    // imported message. Put those rows back where they belong.
    this.version(16).upgrade(async (tx) => {
      await tx.table("assets").toCollection().modify((a: MediaAsset) => {
        if (a.provider === "telegram-remote" && a.localUri && !a.id.startsWith("tgm-")) {
          a.provider = "device";
        }
      });
    });

    // v17: the in-flight upload journal. A new table (like a new index) needs
    // its own version() — Dexie never re-applies a version the user already
    // reached, so adding `uploads` to v15 would leave existing installs
    // without the table and every journal write would throw.
    this.version(17).stores({
      assets:
        "id, provider, date, syncedAt, contentKey, remoteMessageId, remoteChatId, bucket",
      kv: "key",
      thumbs: "id",
      uploads: "key, chatId, startedAt",
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
