import { describe, expect, it } from "vitest";
import { contentKeyOf, type MediaAsset } from "./photoDb";
import { runPool } from "./syncEngine";

const asset = (over: Partial<MediaAsset>): MediaAsset => ({
  id: "x", provider: "device", name: "IMG.jpg", size: 100,
  mime: "image/jpeg", date: 1, createdAt: 0, ...over,
});

/** Mirrors isInChannel + the queue filter in runSyncCycle. */
const inChannel = (a: MediaAsset, chat: string) =>
  a.syncedAt != null && a.remoteChatId === chat;

const queueFor = (rows: MediaAsset[], chat: string) => {
  const here = new Set(
    rows
      .filter((a) => (a.provider === "telegram-remote" && a.remoteChatId === chat) || inChannel(a, chat))
      .map((a) => a.contentKey ?? contentKeyOf(a)),
  );
  return rows.filter(
    (a) =>
      a.provider === "device" &&
      (a.blob || a.localUri) &&
      !inChannel(a, chat) &&
      !here.has(a.contentKey ?? contentKeyOf(a)),
  );
};

describe("per-channel backup", () => {
  const rows = [
    asset({ id: "d1", localUri: "u1", name: "a.jpg", syncedAt: 5, remoteChatId: "old" }),
    asset({ id: "d2", localUri: "u2", name: "b.jpg", syncedAt: 6, remoteChatId: "old" }),
  ];

  it("re-uploads everything when the target moves to an empty channel", () => {
    // The old build treated syncedAt as global, so a freshly picked channel
    // stayed empty while the app insisted the backup was complete.
    expect(queueFor(rows, "fresh").map((r) => r.id)).toEqual(["d1", "d2"]);
  });

  it("uploads nothing again for the channel that already has them", () => {
    expect(queueFor(rows, "old")).toEqual([]);
  });

  it("skips a file the channel already holds under another id", () => {
    const key = contentKeyOf({ name: "a.jpg", size: 100, date: 1 });
    const withRemote = [
      asset({ id: "d9", localUri: "u9", name: "a.jpg", contentKey: key }),
      asset({ id: "tgm-new-1", provider: "telegram-remote", remoteChatId: "new", contentKey: key }),
    ];
    expect(queueFor(withRemote, "new")).toEqual([]);
  });
});

describe("upload pool", () => {
  it("never exceeds the concurrency limit", async () => {
    let inFlight = 0;
    let peak = 0;
    const items = Array.from({ length: 20 }, (_, i) => i);
    await runPool(items, () => 1, async () => {
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
    }, { concurrency: 4, maxBytesInFlight: 1e9, stop: () => false });
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1);
  });

  it("caps the bytes held in memory at once", async () => {
    let bytes = 0;
    let peak = 0;
    const items = [50, 50, 50, 50, 50];
    await runPool(items, (b) => b, async (b) => {
      bytes += b; peak = Math.max(peak, bytes);
      await new Promise((r) => setTimeout(r, 5));
      bytes -= b;
    }, { concurrency: 10, maxBytesInFlight: 120, stop: () => false });
    expect(peak).toBeLessThanOrEqual(120);
  });

  it("still runs a single item larger than the whole budget", async () => {
    const seen: number[] = [];
    await runPool([500], (b) => b, async (b) => { seen.push(b); },
      { concurrency: 4, maxBytesInFlight: 100, stop: () => false });
    expect(seen).toEqual([500]);
  });

  it("stops starting new work once aborted", async () => {
    let started = 0;
    let abort = false;
    await runPool(Array.from({ length: 30 }, (_, i) => i), () => 1, async () => {
      started++;
      if (started >= 3) abort = true;
      await new Promise((r) => setTimeout(r, 2));
    }, { concurrency: 2, maxBytesInFlight: 1e9, stop: () => abort });
    expect(started).toBeLessThan(30);
  });

  it("completes every item when nothing aborts", async () => {
    const done: number[] = [];
    await runPool(Array.from({ length: 25 }, (_, i) => i), () => 1, async (i) => {
      await new Promise((r) => setTimeout(r, 1));
      done.push(i);
    }, { concurrency: 5, maxBytesInFlight: 1e9, stop: () => false });
    expect(done).toHaveLength(25);
  });
});
