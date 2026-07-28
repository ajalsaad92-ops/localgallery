// Local-only metadata storage (IndexedDB via Dexie).
// Nothing is sent to any server except the user's Telegram bot.
import Dexie, { type Table } from "dexie";
import type { ExifData } from "./exif";

export type ProviderKind = "device" | "telegram" | "telegram-remote";

export interface ProviderConfig {
  kind: ProviderKind;
  configured: boolean;
  botToken?: string;
  chatId?: string;
}

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
  /** Original blob when imported from the device. Removed once synced to save space. */
  blob?: Blob;
  /** Native MediaStore/WebView URL for device media. Metadata only; media bytes stay in the phone gallery. */
  localUri?: string;
  /** Telegram fileId once uploaded / when discovered in the remote feed. */
  remoteFileId?: string;
  remoteMessageId?: number;
  /** Channel/group id the message lives in (MTProto user-account mode). */
  remoteChatId?: string;
  remoteFilePath?: string;

  /** Small JPEG thumbnail Telegram serves for HEIC/RAW documents and videos. */
  thumbFileId?: string;
  thumbFilePath?: string;
  /** Set when the local device asset has been successfully uploaded to Telegram. */
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
  /** When true, the local blob is dropped from IndexedDB right after a successful upload. */
  freeBlobAfterSync: boolean;
}

export const DEFAULT_SYNC_SETTINGS: SyncSettings = {
  mode: "manual",
  wifiOnly: true,
  // 0 = unlimited. Telegram itself may still reject files above its Bot API limit.
  maxFileMb: 0,
  paused: true,
  freeBlobAfterSync: true,
};

class PhotoDatabase extends Dexie {
  providers!: Table<ProviderConfig, ProviderKind>;
  assets!: Table<MediaAsset, string>;
  kv!: Table<KV, string>;

  constructor() {
    super("localgallery-pro");
    // Keep old versions so users upgrading don't hit a schema-mismatch error.
    // Only the latest version is used by the app.
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
    // v12: strip everything except providers/assets/kv, add syncedAt index.
    this.version(12).stores({
      states: null,
      topicRules: null,
      syncJobs: null,
      albums: null,
      albumMembers: null,
      embeddings: null,
      faces: null,
      persons: null,
      ocr: null,
      providers: "kind, configured",
      assets: "id, provider, date, syncedAt, remoteFileId",
      kv: "key",
    });
  }
}

export const photoDb = new PhotoDatabase();
