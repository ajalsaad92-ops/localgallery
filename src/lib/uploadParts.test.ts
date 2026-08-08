import { Blob as NodeBlob, Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import {
  LARGE_FILE_THRESHOLD,
  MAX_PARTS,
  MAX_UPLOADABLE_BYTES,
  forEachPart,
  partCountFor,
  partSizeFor,
  partWorkersFor,
  uploadMemoryCost,
} from "./uploadParts";

const MB = 1024 * 1024;

describe("part sizing", () => {
  it("uses Telegram's own thresholds", () => {
    expect(partSizeFor(2 * MB)).toBe(128 * 1024);
    expect(partSizeFor(99 * MB)).toBe(128 * 1024);
    expect(partSizeFor(300 * MB)).toBe(256 * 1024);
    expect(partSizeFor(900 * MB)).toBe(512 * 1024);
  });

  it("only ever picks a size that divides 512 KB", () => {
    for (const size of [1, 5 * MB, 150 * MB, 1500 * MB]) {
      expect((512 * 1024) % partSizeFor(size)).toBe(0);
    }
  });

  it("keeps every allowed file under the 4000-part ceiling", () => {
    expect(partCountFor(MAX_UPLOADABLE_BYTES)).toBeLessThanOrEqual(MAX_PARTS);
    expect(partCountFor(1900 * MB)).toBeLessThanOrEqual(MAX_PARTS);
    expect(partCountFor(99 * MB)).toBeLessThanOrEqual(MAX_PARTS);
  });

  it("counts an empty-ish file as one part", () => {
    expect(partCountFor(0)).toBe(1);
    expect(partCountFor(10)).toBe(1);
  });

  it("covers the whole file, last part included", () => {
    const size = 5 * MB + 7;
    expect(partCountFor(size) * partSizeFor(size)).toBeGreaterThanOrEqual(size);
    expect((partCountFor(size) - 1) * partSizeFor(size)).toBeLessThan(size);
  });
});

describe("walking a blob in parts", () => {
  const bytesOf = (n: number) => {
    const a = new Uint8Array(n);
    for (let i = 0; i < n; i++) a[i] = i % 251;
    return a;
  };
  // jsdom's Blob has no arrayBuffer(); Node's does, and so does every WebView
  // this app runs in.
  const blobOf = (bytes: Uint8Array) => new NodeBlob([bytes]) as unknown as Blob;

  it("sends every byte exactly once, in order", async () => {
    const raw = bytesOf(300 * 1024); // 3 parts at 128 KB, last one short
    const seen: { part: number; bytes: Uint8Array }[] = [];
    const total = await forEachPart(
      blobOf(raw),
      async (part, _total, chunk) => { seen.push({ part, bytes: new Uint8Array(chunk) }); },
      { workers: 1 },
    );

    expect(total).toBe(3);
    expect(seen.map((s) => s.part)).toEqual([0, 1, 2]);
    // Telegram rejects an upload whose parts are not all the declared size.
    expect(seen[0].bytes.length).toBe(128 * 1024);
    expect(seen[1].bytes.length).toBe(128 * 1024);
    expect(seen[2].bytes.length).toBe(300 * 1024 - 2 * 128 * 1024);

    const rebuilt = new Uint8Array(300 * 1024);
    let at = 0;
    for (const s of seen) { rebuilt.set(s.bytes, at); at += s.bytes.length; }
    // Element-wise deep equality over 300k entries takes seconds and made this
    // time out; a byte compare answers the same question immediately.
    expect(Buffer.from(rebuilt).equals(Buffer.from(raw))).toBe(true);
  });

  it("reports the same total to every part", async () => {
    const totals = new Set<number>();
    await forEachPart(blobOf(bytesOf(400 * 1024)), async (_p, total) => {
      totals.add(total);
    }, { workers: 2 });
    expect([...totals]).toEqual([4]);
  });

  it("holds no more than `workers` slices at a time", async () => {
    let open = 0;
    let peak = 0;
    await forEachPart(blobOf(bytesOf(8 * 128 * 1024)), async () => {
      open++; peak = Math.max(peak, open);
      await new Promise((r) => setTimeout(r, 1));
      open--;
    }, { workers: 2 });
    expect(peak).toBeLessThanOrEqual(2);
  });

  it("stops as soon as the pass is cancelled", async () => {
    let count = 0;
    let cancelled = false;
    await expect(
      forEachPart(blobOf(bytesOf(10 * 128 * 1024)), async () => {
        count++;
        if (count >= 2) cancelled = true;
      }, { workers: 1, isCancelled: () => cancelled }),
    ).rejects.toThrow(/USER_CANCELED/);
    expect(count).toBeLessThan(10);
  });
});

describe("memory budget", () => {
  it("charges a file for its parts, not its length", () => {
    // The whole point of streaming: a 300 MB video must not reserve 300 MB.
    expect(uploadMemoryCost(300 * MB)).toBeLessThan(5 * MB);
    expect(uploadMemoryCost(1500 * MB)).toBeLessThan(5 * MB);
  });

  it("leaves room for a hundred photos at once", () => {
    const budget = 96 * MB;
    expect(uploadMemoryCost(4 * MB) * 100).toBeLessThan(budget);
  });

  it("gives long files more workers than single-part ones", () => {
    expect(partWorkersFor(LARGE_FILE_THRESHOLD)).toBe(1);
    expect(partWorkersFor(50 * MB)).toBeGreaterThan(1);
    expect(partWorkersFor(500 * MB)).toBeLessThanOrEqual(4);
  });
});
