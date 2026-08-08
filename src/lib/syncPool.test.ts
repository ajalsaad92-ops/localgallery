import { describe, expect, it } from "vitest";
import { contentKeyOf, type MediaAsset } from "./photoDb";
import { planQueue, runPool } from "./syncEngine";

const asset = (over: Partial<MediaAsset>): MediaAsset => ({
  id: "x", provider: "device", name: "IMG.jpg", size: 100,
  mime: "image/jpeg", date: 1, createdAt: 0, ...over,
});

const queueFor = (rows: MediaAsset[], chat: string) => planQueue(rows, chat).queue;

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
    expect(planQueue(withRemote, "new").adopt.map((a) => a.asset.id)).toEqual(["d9"]);
  });
});

describe("duplicate protection", () => {
  it("does not resend when the channel copy has a different date", () => {
    // The remote row was read back from a message with no #lgk caption, so its
    // key was derived from the filename — a date that need not match the one
    // MediaStore reports for the same file.
    const rows = [
      asset({ id: "d1", localUri: "u1", name: "IMG_20240501_120000.jpg", size: 2048, date: 111 }),
      asset({
        id: "tgm-c-9", provider: "telegram-remote", remoteChatId: "c",
        name: "IMG_20240501_120000.jpg", size: 2048, date: 222,
      }),
    ];
    expect(queueFor(rows, "c")).toEqual([]);
  });

  it("sends the same photo once when the phone indexed it twice", () => {
    const rows = [
      asset({ id: "d1", localUri: "u1", name: "IMG_9.jpg", size: 5000, date: 10 }),
      asset({ id: "d2", localUri: "u2", name: "IMG_9.jpg", size: 5000, date: 11 }),
    ];
    expect(queueFor(rows, "c").map((r) => r.id)).toEqual(["d1"]);
  });

  it("still sends a different photo that happens to share a name", () => {
    const rows = [
      asset({ id: "d1", localUri: "u1", name: "IMG_9.jpg", size: 5000 }),
      asset({
        id: "tgm-c-9", provider: "telegram-remote", remoteChatId: "c",
        name: "IMG_9.jpg", size: 4096,
      }),
    ];
    expect(queueFor(rows, "c").map((r) => r.id)).toEqual(["d1"]);
  });

  it("trusts a stamped key over a name collision", () => {
    // Same name and size, but the channel copy carries this app's own key for
    // *another* file — the loose match must not swallow this upload.
    const rows = [
      asset({ id: "d1", localUri: "u1", name: "IMG_9.jpg", size: 5000, date: 10 }),
      asset({
        id: "tgm-c-9", provider: "telegram-remote", remoteChatId: "c",
        name: "IMG_9.jpg", size: 5000, contentKey: "IMG_9.jpg|5000|999",
      }),
    ];
    expect(queueFor(rows, "c").map((r) => r.id)).toEqual(["d1"]);
  });

  it("leaves files with no bytes and blocked files out of the queue", () => {
    const rows = [
      asset({ id: "d0", name: "gone.jpg" }), // no blob, no localUri
      asset({ id: "d1", localUri: "u1", name: "bad.jpg" }),
      asset({ id: "d2", localUri: "u2", name: "ok.jpg" }),
    ];
    expect(planQueue(rows, "c", (id) => id === "d1").queue.map((r) => r.id)).toEqual(["d2"]);
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

  it("caps whole files held open, not just heap", async () => {
    // Streaming made the heap cost tiny, so this is the budget that actually
    // decides how many large videos start together.
    let raw = 0;
    let peak = 0;
    const items = [40, 40, 40, 40, 40];
    await runPool(items, () => 1, async (b) => {
      raw += b; peak = Math.max(peak, raw);
      await new Promise((r) => setTimeout(r, 5));
      raw -= b;
    }, {
      concurrency: 100, maxBytesInFlight: 1e9, stop: () => false,
      rawOf: (b) => b, maxRawInFlight: 100,
    });
    expect(peak).toBeLessThanOrEqual(100);
  });

  it("lets a hundred small files run at once", async () => {
    let inFlight = 0;
    let peak = 0;
    const items = Array.from({ length: 100 }, () => 3 * 1024 * 1024);
    await runPool(items, () => 128 * 1024 * 2, async () => {
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 2));
      inFlight--;
    }, {
      concurrency: 100,
      maxBytesInFlight: 96 * 1024 * 1024,
      rawOf: (b) => b,
      maxRawInFlight: 320 * 1024 * 1024,
      stop: () => false,
    });
    expect(peak).toBe(100);
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
