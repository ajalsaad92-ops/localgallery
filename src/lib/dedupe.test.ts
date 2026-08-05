import { describe, expect, it } from "vitest";
import { contentKeyOf, type MediaAsset } from "./photoDb";

const asset = (over: Partial<MediaAsset>): MediaAsset => ({
  id: "x",
  provider: "device",
  name: "IMG_1.jpg",
  size: 100,
  mime: "image/jpeg",
  date: 1000,
  createdAt: 0,
  ...over,
});

/** Mirrors the view split in useMediaAssets. */
const phoneView = (rows: MediaAsset[]) => rows.filter((r) => r.provider === "device");
const channelView = (rows: MediaAsset[]) => rows.filter((r) => r.provider === "telegram-remote");

/** Mirrors the upload queue in runSyncCycle. */
function uploadQueue(rows: MediaAsset[]): MediaAsset[] {
  const onTelegram = new Set(
    rows
      .filter((a) => a.syncedAt != null || a.provider === "telegram-remote")
      .map((a) => a.contentKey ?? contentKeyOf(a)),
  );
  return rows.filter(
    (a) =>
      a.provider === "device" &&
      a.syncedAt == null &&
      (a.blob || a.localUri) &&
      !onTelegram.has(a.contentKey ?? contentKeyOf(a)),
  );
}

describe("phone and channel stay separate", () => {
  it("shows an uploaded photo once in each tab, never twice in one", () => {
    // The upload keeps the row on the phone side and the channel import adds
    // its own record. Re-labelling the local row is what used to double it up.
    const rows = [
      asset({ id: "device-image-1", localUri: "content://1", syncedAt: 5, remoteMessageId: 90 }),
      asset({ id: "tgm-c-90", provider: "telegram-remote", remoteMessageId: 90, remoteChatId: "c" }),
    ];
    expect(phoneView(rows).map((r) => r.id)).toEqual(["device-image-1"]);
    expect(channelView(rows).map((r) => r.id)).toEqual(["tgm-c-90"]);
  });

  it("never re-uploads a file the channel already holds", () => {
    const key = contentKeyOf({ name: "IMG_1.jpg", size: 100, date: 1000 });
    const rows = [
      // Re-indexed after a restore: fresh id, no syncedAt, same bytes.
      asset({ id: "device-image-77", localUri: "content://77", contentKey: key }),
      asset({
        id: "tgm-c-90", provider: "telegram-remote",
        remoteMessageId: 90, remoteChatId: "c", contentKey: key,
      }),
    ];
    expect(uploadQueue(rows)).toEqual([]);
  });

  it("still queues a genuinely new photo", () => {
    const rows = [
      asset({ id: "device-image-2", name: "IMG_2.jpg", localUri: "content://2" }),
      asset({ id: "tgm-c-90", provider: "telegram-remote", remoteMessageId: 90 }),
    ];
    expect(uploadQueue(rows).map((r) => r.id)).toEqual(["device-image-2"]);
  });

  it("keeps channel-only photos out of the upload queue", () => {
    // Photos that were in the channel before this app existed must never be
    // treated as something to upload.
    const rows = [
      asset({ id: "tgm-c-1", provider: "telegram-remote", remoteMessageId: 1 }),
      asset({ id: "tgm-c-2", provider: "telegram-remote", remoteMessageId: 2 }),
    ];
    expect(uploadQueue(rows)).toEqual([]);
    expect(channelView(rows)).toHaveLength(2);
  });
});
