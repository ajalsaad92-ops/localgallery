/**
 * HEIC/HEIF decoding for display. Android WebView cannot render HEIC in <img>,
 * so we decode it to JPEG locally (libheif-wasm through heic2any). Everything
 * runs on-device; no bytes leave the phone.
 */

export const isHeicMime = (mime?: string | null) => /image\/(heic|heif)/i.test(mime ?? "");
export const isHeicName = (name?: string | null) => /\.(heic|heif)$/i.test(name ?? "");
export const isHeic = (mime?: string | null, name?: string | null) =>
  isHeicMime(mime) || isHeicName(name);

const cache = new Map<string, string>();

/** Convert a HEIC blob into a displayable JPEG object URL (cached by key). */
export async function heicBlobToJpegUrl(blob: Blob, cacheKey?: string): Promise<string | null> {
  if (cacheKey && cache.has(cacheKey)) return cache.get(cacheKey)!;
  try {
    const mod = await import("heic2any");
    const heic2any = (mod.default ?? mod) as (o: {
      blob: Blob;
      toType?: string;
      quality?: number;
    }) => Promise<Blob | Blob[]>;
    const out = await heic2any({ blob, toType: "image/jpeg", quality: 0.92 });
    const jpeg = Array.isArray(out) ? out[0] : out;
    const url = URL.createObjectURL(jpeg);
    if (cacheKey) cache.set(cacheKey, url);
    return url;
  } catch (e) {
    console.warn("heic decode failed", e);
    return null;
  }
}

/** Fetch a URL and decode it if it turns out to be HEIC. */
export async function heicUrlToJpegUrl(src: string, cacheKey?: string): Promise<string | null> {
  if (cacheKey && cache.has(cacheKey)) return cache.get(cacheKey)!;
  try {
    const res = await fetch(src);
    if (!res.ok) return null;
    return await heicBlobToJpegUrl(await res.blob(), cacheKey);
  } catch {
    return null;
  }
}
