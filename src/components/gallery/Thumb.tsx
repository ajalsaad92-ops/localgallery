import { useEffect, useState, useSyncExternalStore } from "react";
import { cachedThumb, loadThumb } from "@/lib/thumbs";
import {
  cachedRemoteThumb, getRemoteThumb, thumbsVersion, watchRemoteThumbs,
} from "@/lib/remoteThumbs";
import type { GalleryItem } from "@/lib/galleryItem";

/**
 * One tile image.
 *
 * The choice of source is "are the bytes on this phone", NOT which provider
 * owns the row: an uploaded photo becomes `telegram-remote` while its file
 * stays in the gallery. Getting that wrong sends the tile back to the original
 * content:// URI — a full-size decode per cell, and nothing at all for video.
 */
export function Thumb({ photo }: { photo: GalleryItem }) {
  const local = !!photo.localUri;
  // Re-read once hydration lands, otherwise tiles that mounted before their
  // preview existed stay blank.
  const version = useSyncExternalStore(watchRemoteThumbs, thumbsVersion, thumbsVersion);

  const [src, setSrc] = useState<string | undefined>(() =>
    local ? cachedThumb(photo.id) : cachedRemoteThumb(photo.id),
  );

  useEffect(() => {
    let alive = true;

    if (local) {
      const hit = cachedThumb(photo.id);
      if (hit) { setSrc(hit); return; }
      void loadThumb(photo.id).then((url) => {
        if (!alive) return;
        // Stills can fall back to the original bytes; video cannot.
        setSrc(url ?? (photo.kind === "video" ? undefined : photo.localUri));
      });
      return () => { alive = false; };
    }

    const hit = cachedRemoteThumb(photo.id);
    if (hit) { setSrc(hit); return; }
    void getRemoteThumb(photo.id).then((url) => {
      if (alive && url) setSrc(url);
    });
    return () => { alive = false; };
  }, [photo.id, photo.localUri, photo.kind, local, version]);

  if (!src) {
    return <div className="h-full w-full animate-pulse bg-secondary" />;
  }

  return (
    <img
      src={src}
      alt=""
      loading="lazy"
      decoding="async"
      draggable={false}
      className="h-full w-full object-cover"
      onError={() => setSrc(undefined)}
    />
  );
}
