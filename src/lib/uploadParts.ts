/**
 * Chunking maths for the Telegram upload path.
 *
 * Kept free of gramjs imports on purpose: the sync engine needs the memory
 * cost of a queued file *synchronously* (to size the pool) while the uploader
 * needs the same numbers to cut the blob, and pulling the whole MTProto client
 * into that decision would load megabytes of code just to divide two numbers.
 *
 * Values mirror Telegram's rules: a part size must divide 512 KB, every part
 * except the last has to be exactly that size, and one file may not exceed
 * MAX_PARTS parts.
 */

/** Telegram switches to the "big file" API — and a different RPC — above this. */
export const LARGE_FILE_THRESHOLD = 10 * 1024 * 1024;

/** Hard ceiling on `fileTotalParts` for a single upload. */
export const MAX_PARTS = 4000;

/** Part size in bytes, following gramjs/Telegram's own thresholds. */
export function partSizeFor(size: number): number {
  if (size < 100 * 1024 * 1024) return 128 * 1024;
  if (size < 750 * 1024 * 1024) return 256 * 1024;
  return 512 * 1024;
}

export function partCountFor(size: number): number {
  const part = partSizeFor(size);
  return Math.max(1, Math.ceil(size / part));
}

/** Largest file the 4000-part ceiling still allows: 512 KB × 4000 ≈ 1.95 GB. */
export const MAX_UPLOADABLE_BYTES = 512 * 1024 * MAX_PARTS;

/**
 * How many parts of one file to push at the same time.
 *
 * Small photos are a single part, so extra workers would only add queue
 * bookkeeping; long videos benefit from filling the socket.
 */
export function partWorkersFor(size: number): number {
  if (size <= LARGE_FILE_THRESHOLD) return 1;
  return Math.min(4, Math.max(2, Math.ceil(size / (16 * 1024 * 1024))));
}

/**
 * Bytes one in-flight upload holds in the JS heap.
 *
 * This is the number the pool budgets against. Before the streaming uploader
 * it was the *whole file* — gramjs buffered every byte before sending — which
 * is why the parallel limit had to stay in single digits. Now a file costs its
 * parts in flight (counted twice: the slice we read plus the serialized copy
 * the sender holds until the part is acknowledged).
 */
export function uploadMemoryCost(size: number): number {
  return partSizeFor(size) * partWorkersFor(size) * 2;
}

/**
 * Walk a blob part by part, handing each slice to `onPart`.
 *
 * Only `workers` slices are read — and therefore held — at a time, which is
 * the whole reason a hundred uploads can now run together. Parts are numbered
 * from zero and every one but the last is exactly `partSizeFor(size)` long,
 * as Telegram requires.
 */
export async function forEachPart(
  blob: Blob,
  onPart: (part: number, total: number, bytes: ArrayBuffer) => Promise<void>,
  opts: { workers?: number; isCancelled?: () => boolean } = {},
): Promise<number> {
  const size = blob.size;
  const partSize = partSizeFor(size);
  const total = partCountFor(size);
  const workers = Math.max(1, Math.min(opts.workers ?? partWorkersFor(size), total));

  for (let i = 0; i < total; i += workers) {
    if (opts.isCancelled?.()) throw new Error("USER_CANCELED");
    const batch: Promise<void>[] = [];
    for (let part = i; part < Math.min(i + workers, total); part++) {
      const start = part * partSize;
      const end = Math.min(start + partSize, size);
      batch.push(
        blob.slice(start, end).arrayBuffer().then((bytes) => onPart(part, total, bytes)),
      );
    }
    await Promise.all(batch);
  }
  return total;
}
