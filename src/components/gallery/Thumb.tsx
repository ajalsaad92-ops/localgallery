import { useEffect, useState } from "react";
import { cachedThumb, loadThumb } from "@/lib/thumbs";
import type { GalleryItem } from "@/lib/galleryItem";

/**
 * One tile image. Prefers a MediaStore thumbnail for device items — pointing
 * <img> at the original content:// URI decodes a full-size bitmap per cell and
 * cannot render video at all.
 */
export function Thumb({ photo }: { photo: GalleryItem }) {
  const device = photo.provider === "device";
  const [src, setSrc] = useState<string | undefined>(() =>
    device ? cachedThumb(photo.id) ?? photo.posterSrc : photo.thumbSrc ?? photo.posterSrc,
  );

  useEffect(() => {
    if (!device) {
      setSrc(photo.thumbSrc ?? photo.posterSrc);
      return;
    }
    const hit = cachedThumb(photo.id);
    if (hit) {
      setSrc(hit);
      return;
    }
    let alive = true;
    void loadThumb(photo.id).then((url) => {
      if (!alive) return;
      // Still images can fall back to the original; video cannot.
      setSrc(url ?? (photo.kind === "video" ? undefined : photo.thumbSrc));
    });
    return () => { alive = false; };
  }, [photo.id, photo.thumbSrc, photo.posterSrc, photo.kind, device]);

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
