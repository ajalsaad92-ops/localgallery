import { useEffect, useRef, useState } from "react";
import { Play } from "lucide-react";
import type { GalleryItem } from "@/lib/galleryItem";
import { cachedThumb, loadThumb } from "@/lib/thumbs";
import { cachedRemoteThumb, getRemoteThumb } from "@/lib/remoteThumbs";
import { ZoomableImage } from "./ZoomableImage";

/**
 * One page of the viewer.
 *
 * The thumbnail is shown immediately underneath so a swipe never lands on a
 * blank frame; the full-size image fades in on top once decoded. Videos get a
 * real <video> element rather than an <img>, which cannot render them.
 */
export function Slide({
  photo, active, overrideSrc,
}: {
  photo: GalleryItem;
  active: boolean;
  overrideSrc?: string;
}) {
  const [poster, setPoster] = useState<string | undefined>(
    () => cachedThumb(photo.id) ?? cachedRemoteThumb(photo.id),
  );
  const [loaded, setLoaded] = useState(false);
  const [playing, setPlaying] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (poster) return;
    let alive = true;
    const load = photo.provider === "device"
      ? loadThumb(photo.id, 512)
      : getRemoteThumb(photo.id);
    void load.then((u) => { if (alive && u) setPoster(u); });
    return () => { alive = false; };
  }, [photo.id, photo.provider, poster]);

  // Swiping away from a playing video must stop it.
  useEffect(() => {
    if (!active) {
      videoRef.current?.pause();
      setPlaying(false);
    }
  }, [active]);

  const src = overrideSrc ?? photo.fullSrc;
  const isVideo = photo.kind === "video";

  if (isVideo) {
    return (
      <div className="relative grid h-full w-full place-items-center">
        {!playing && (
          <>
            {poster && (
              <img src={poster} alt="" className="absolute inset-0 h-full w-full object-contain" />
            )}
            <button
              onClick={(e) => {
                e.stopPropagation();
                setPlaying(true);
                window.setTimeout(() => void videoRef.current?.play(), 0);
              }}
              aria-label="تشغيل"
              className="press relative grid h-16 w-16 place-items-center rounded-full bg-black/60 text-white backdrop-blur"
            >
              <Play className="h-7 w-7 fill-current" />
            </button>
          </>
        )}
        {playing && src && (
          <video
            ref={videoRef}
            src={src}
            poster={poster}
            controls
            playsInline
            preload="metadata"
            className="h-full w-full object-contain"
            onClick={(e) => e.stopPropagation()}
          />
        )}
        {playing && !src && (
          <p className="px-8 text-center text-sm text-white/70">
            الفيديو غير محمّل بعد — أعد المحاولة بعد لحظات.
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="relative h-full w-full">
      {poster && !loaded && (
        <img
          src={poster}
          alt=""
          className="absolute inset-0 h-full w-full object-contain blur-[1px]"
        />
      )}
      {src ? (
        <ZoomableImage
          src={src}
          alt={photo.name}
          onLoad={() => setLoaded(true)}
        />
      ) : (
        !poster && <div className="grid h-full w-full place-items-center text-white/50">…</div>
      )}
    </div>
  );
}
