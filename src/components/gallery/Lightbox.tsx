import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Download, ExternalLink, X } from "lucide-react";
import { toast } from "sonner";
import type { MockPhoto } from "@/lib/mockPhotos";
import { cn } from "@/lib/utils";
import { ZoomableImage } from "./ZoomableImage";
import { runViewTransition } from "@/lib/viewTransition";
import { pushBackHandler } from "@/lib/backStack";
import { isNative, saveBlobToDevice, downloadUrlToDevice } from "@/lib/native";
import { isHeic, heicUrlToJpegUrl } from "@/lib/heic";


interface LightboxProps {
  photos: MockPhoto[];
  index: number;
  onClose: () => void;
  onIndexChange: (i: number) => void;
  /** Optional: enables the download button (Telegram viewer). */
  showDownload?: boolean;
}

/**
 * Full-screen lightbox with:
 * - Horizontal swipe between photos (touch + arrow keys).
 * - Pinch/zoom via ZoomableImage.
 * - Shared-element morph via View Transitions API.
 */
export function Lightbox({ photos, index, onClose, onIndexChange, showDownload }: LightboxProps) {
  const photo = photos[index];
  const [zoomed, setZoomed] = useState(false);
  const [heicUrl, setHeicUrl] = useState<string | null>(null);
  const [decoding, setDecoding] = useState(false);
  const [videoError, setVideoError] = useState(false);
  const dragRef = useRef<{ startX: number; startY: number; dx: number } | null>(null);
  const [dx, setDx] = useState(0);


  const goto = useCallback((next: number) => {
    if (next < 0 || next >= photos.length) return;
    runViewTransition(() => onIndexChange(next));
  }, [photos.length, onIndexChange]);

  const close = useCallback(() => {
    runViewTransition(() => onClose());
  }, [onClose]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
      else if (e.key === "ArrowLeft") goto(index - 1);
      else if (e.key === "ArrowRight") goto(index + 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index, goto, close]);

  useEffect(() => { setDx(0); setVideoError(false); }, [index]);

  // Android hardware back closes the lightbox instead of exiting the tab.
  useEffect(() => pushBackHandler(() => { close(); return true; }), [close]);

  const onTouchStart = (e: React.TouchEvent) => {
    if (zoomed || e.touches.length !== 1) return;
    dragRef.current = { startX: e.touches[0].clientX, startY: e.touches[0].clientY, dx: 0 };
  };
  const onTouchMove = (e: React.TouchEvent) => {
    if (zoomed || !dragRef.current || e.touches.length !== 1) return;
    const t = e.touches[0];
    const dxNow = t.clientX - dragRef.current.startX;
    const dyNow = t.clientY - dragRef.current.startY;
    // Vertical intent: let the scroll happen
    if (Math.abs(dyNow) > Math.abs(dxNow) + 12) return;
    dragRef.current.dx = dxNow;
    setDx(dxNow);
  };
  const onTouchEnd = () => {
    if (!dragRef.current) return;
    const width = window.innerWidth;
    const threshold = Math.min(120, width * 0.2);
    const d = dragRef.current.dx;
    dragRef.current = null;
    if (d < -threshold) goto(index + 1);
    else if (d > threshold) goto(index - 1);
    setDx(0);
  };

  const download = async () => {
    if (!photo?.fullSrc) return;
    const filename = photo.name || `photo-${Date.now()}.jpg`;
    try {
      // On native Android, WebView `fetch()` frequently fails for large
      // Telegram file URLs with "Failed to fetch". Prefer the native
      // Filesystem downloader which uses a real HTTP client.
      if (isNative() && /^https?:/i.test(photo.fullSrc)) {
        const path = await downloadUrlToDevice(photo.fullSrc, filename);
        if (path) { toast.success("حُفظ في المستندات"); return; }
      }
      const res = await fetch(photo.fullSrc);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      if (isNative()) {
        const uri = await saveBlobToDevice(filename, blob);
        if (uri) { toast.success("حُفظ في المستندات"); return; }
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = filename;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
      toast.success("تم التنزيل");
    } catch (e) {
      toast.error("تعذّر التنزيل: " + (e instanceof Error ? e.message : String(e)));
    }
  };

  const isVideo = photo?.kind === "video";
  const isHeicItem = isHeic(photo?.mime, photo?.name);

  // HEIC never renders in a WebView <img>. Decode it locally to JPEG.
  useEffect(() => {
    setHeicUrl(null);
    if (!isHeicItem || !photo?.fullSrc) return;
    let alive = true;
    setDecoding(true);
    void heicUrlToJpegUrl(photo.fullSrc, photo.id)
      .then((u) => { if (alive) setHeicUrl(u); })
      .finally(() => { if (alive) setDecoding(false); });
    return () => { alive = false; };
  }, [photo?.id, photo?.fullSrc, isHeicItem]);

  // The HEIC decode may already have happened upstream (Telegram reader), so
  // fall back to the original bytes when the local decode returns nothing.
  const imageSrc = heicUrl ?? photo?.fullSrc ?? null;

  // Exotic formats (tiff, dng, bmp on some devices) fail silently inside the
  // WebView — probe first so we can offer the "save & open" escape hatch.
  const [imgError, setImgError] = useState(false);
  useEffect(() => {
    setImgError(false);
    if (isVideo || !imageSrc) return;
    let alive = true;
    const probe = new Image();
    probe.onerror = () => { if (alive) setImgError(true); };
    probe.src = imageSrc;
    return () => { alive = false; probe.onerror = null; };
  }, [imageSrc, isVideo]);

  if (!photo) return null;

  const openExternally = async () => {
    if (!photo.fullSrc) return;
    const filename = photo.name || `media-${Date.now()}`;
    try {
      if (isNative()) {
        const path = await downloadUrlToDevice(photo.fullSrc, filename);
        if (path) { toast.success("حُفظ في المستندات — افتحه من مدير الملفات"); return; }
      }
      window.open(photo.fullSrc, "_blank");
    } catch (e) {
      toast.error("تعذّر الفتح: " + (e instanceof Error ? e.message : String(e)));
    }
  };


  return (
    <div className="fixed inset-0 z-[60] flex flex-col bg-black/95 backdrop-blur safe-top safe-bottom">
      <div className="flex items-center justify-between px-3 py-2">
        <button
          onClick={close}
          className="grid h-10 w-10 place-items-center rounded-full bg-white/10 text-white hover:bg-white/20"
          aria-label="إغلاق"
        >
          <X className="h-5 w-5" />
        </button>
        <div className="text-xs text-white/70">
          {index + 1} / {photos.length}
        </div>
        <div className="flex items-center gap-2">
          {(isVideo || isHeicItem) && (
            <button
              onClick={openExternally}
              className="grid h-10 w-10 place-items-center rounded-full bg-white/10 text-white hover:bg-white/20"
              aria-label="فتح خارجياً"
              title="فتح خارجياً"
            >
              <ExternalLink className="h-5 w-5" />
            </button>
          )}
          {showDownload ? (
            <button
              onClick={download}
              className="grid h-10 w-10 place-items-center rounded-full bg-white/10 text-white hover:bg-white/20"
              aria-label="تنزيل"
            >
              <Download className="h-5 w-5" />
            </button>
          ) : <div className="h-10 w-10" />}
        </div>
      </div>

      <div
        className="relative flex-1 select-none overflow-hidden"
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
      >
        <div
          className="flex h-full w-full items-center justify-center"
          style={{
            transform: `translate3d(${dx}px, 0, 0)`,
            transition: dragRef.current ? "none" : "transform 0.25s ease-out",
          }}
        >
          {isVideo && photo.fullSrc ? (
            videoError ? (
              <div className="flex flex-col items-center gap-3 p-6 text-center text-white/80">
                {photo.posterSrc && (
                  <img src={photo.posterSrc} alt={photo.name} className="max-h-[60vh] rounded-lg" />
                )}
                <p className="text-xs text-white/60">
                  ترميز هذا الفيديو غير مدعوم داخل التطبيق — احفظه وشغّله بمشغّل الهاتف.
                </p>
                <button
                  onClick={openExternally}
                  className="flex items-center gap-1.5 rounded-full bg-white/15 px-4 py-2 text-sm font-semibold"
                >
                  <ExternalLink className="h-4 w-4" /> حفظ وفتح خارجياً
                </button>
              </div>
            ) : (
              <video
                key={photo.id}
                src={photo.fullSrc}
                poster={photo.posterSrc}
                controls
                autoPlay
                playsInline
                // Videos arrive as a local blob: URL — full buffering keeps
                // seeking smooth inside the Android WebView.
                preload="auto"
                className="max-h-full max-w-full rounded-lg shadow-2xl"
                style={{ viewTransitionName: `photo-${photo.id}` }}
                onError={() => setVideoError(true)}
              />
            )
          ) : isHeicItem && decoding ? (
            <div className="flex flex-col items-center gap-3 p-6 text-center text-white/80">
              {photo.posterSrc && (
                <img
                  src={photo.posterSrc}
                  alt={photo.name}
                  className="max-h-[70vh] max-w-full rounded-lg shadow-2xl"
                />
              )}
              <p className="text-xs text-white/60">جارٍ فك ترميز HEIC…</p>
            </div>
          ) : imageSrc && !imgError ? (
            <div className="h-full w-full" style={{ viewTransitionName: `photo-${photo.id}` }}>
              <ZoomableImage
                src={imageSrc}
                alt={photo.name}
                onZoomChange={setZoomed}
              />
            </div>
          ) : imageSrc ? (
            <div className="flex flex-col items-center gap-3 p-6 text-center text-white/80">
              {photo.posterSrc && (
                <img src={photo.posterSrc} alt={photo.name} className="max-h-[60vh] rounded-lg" />
              )}
              <p className="text-xs text-white/60">
                هذه الصيغة غير مدعومة للعرض داخل التطبيق — احفظها وافتحها بمعرض الهاتف.
              </p>
              <button
                onClick={openExternally}
                className="flex items-center gap-1.5 rounded-full bg-white/15 px-4 py-2 text-sm font-semibold"
              >
                <ExternalLink className="h-4 w-4" /> حفظ وفتح خارجياً
              </button>
            </div>
          ) : (
            <div className="text-sm text-white/60">جارٍ التحميل…</div>
          )}
        </div>

        {index > 0 && (
          <button
            onClick={() => goto(index - 1)}
            className={cn(
              "absolute left-2 top-1/2 hidden -translate-y-1/2 rounded-full bg-black/40 p-2 text-white md:block",
              zoomed && "opacity-0",
            )}
            aria-label="السابق"
          >
            <ChevronLeft className="h-6 w-6" />
          </button>
        )}
        {index < photos.length - 1 && (
          <button
            onClick={() => goto(index + 1)}
            className={cn(
              "absolute right-2 top-1/2 hidden -translate-y-1/2 rounded-full bg-black/40 p-2 text-white md:block",
              zoomed && "opacity-0",
            )}
            aria-label="التالي"
          >
            <ChevronRight className="h-6 w-6" />
          </button>
        )}
      </div>
    </div>
  );
}
