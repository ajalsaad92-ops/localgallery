/**
 * Deletions awaiting the system's confirmation dialog.
 *
 * On Android 11+ the OS owns the confirm sheet and never reports the outcome
 * back to the app, so nothing can be assumed at call time. The ids are parked
 * here, and reconciled against MediaStore when the app regains focus — which
 * is exactly when the dialog has closed, whichever button was pressed.
 */
import { photoDb } from "./photoDb";
import { forgetThumb } from "./thumbs";

const KEY = "pending:deletes";

export async function markPendingDeletes(ids: string[]) {
  if (!ids.length) return;
  const existing = await readPending();
  const merged = [...new Set([...existing, ...ids])];
  await photoDb.kv.put({ key: KEY, value: JSON.stringify(merged) });
}

async function readPending(): Promise<string[]> {
  const row = await photoDb.kv.get(KEY);
  if (!row?.value) return [];
  try {
    const v = JSON.parse(row.value);
    return Array.isArray(v) ? (v as string[]) : [];
  } catch {
    return [];
  }
}

/**
 * Re-checks MediaStore for anything a delete request was issued for.
 * @returns how many rows actually disappeared.
 */
export async function reconcileDeletions(): Promise<number> {
  const ids = await readPending();
  if (!ids.length) return 0;
  await photoDb.kv.delete(KEY);

  const before = await photoDb.assets.count();
  const { scanDeviceGallery } = await import("./deviceMedia");
  await scanDeviceGallery(undefined, true, ids);
  const after = await photoDb.assets.count();

  ids.forEach(forgetThumb);
  return Math.max(0, before - after);
}
