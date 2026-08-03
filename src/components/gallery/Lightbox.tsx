import { useCallback, useEffect, useRef, useState } from "react";
import { Download, Info, Share2, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import type { GalleryItem } from "@/lib/galleryItem";
import { cn } from "@/lib/utils";
import { runViewTransition } from "@/lib/viewTransition";
import { pushBackHandler } from "@/lib/backStack";
import {
  isNative, saveBlobToDevice, downloadUrlToDevice,
  shareGalleryItems, tap,
} from "@/lib/native";
import { isHeic, heicUrlToJpegUrl } from "@/lib/heic";
import { Slide } from "./Slide";
import { Filmstrip } from "./Filmstrip";

interface LightboxProps {
  photos: GalleryItem[];
  index: number;
  onClose: () => void;
  onIndexChange: (i: number) => void;
  /** Enables the download button (remote items). */
  showDownload?: boolean;
  onDelete?: (photo: GalleryItem) => void;
}

/** Distance, in fractions of the screen, needed to commit a swipe. */
const COMMIT = 0.22;

/**
 * Full-screen viewer.
 *
 * Renders the previous and next item alongside the current one and moves the
 * whole track with the finger, so a half-drag shows half of the neighbour —
 * the gallery reads as one continuous list instead of isolated pictures.
 */
export function Lightbox({
  photos, index, onClose, onIndexChange, showDownload, onDelete,
}: LightboxProps) {
  const photo = photos[index];
  const [dx, setDx] = useState(0);
  const [animating, setAnimating] = useState(false);
  const [chrome, setChrome] = useState(true);
  const [info, setInfo] = useState(false);
  const drag = useRef<{ x: number; y: number; active: boolean } | null>(null);

  const go = useCallback(
    (next: number) => {
      if (next < 0 || next >= photos.length) return;
      onIndexChange(next);
    },
    [photos.length, onIndexChange],
  );

  const close = useCallback(() => runViewTransition(() => onClose()), [onClose]);

  useEffect(() => pushBackHandler(() => { close(); return true; }), [close]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
      else if (e.key === "ArrowLeft") go(index + 1);
      else if (e.key === "ArrowRight") go(index - 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index, go, close]);

  useEffect(() => { setDx(0); setInfo(false); }, [index]);

  // ---- swipe -----------------------------------------------------------------
  const onPointerDown = (e: React.PointerEvent) => {
    if (animating) return;
    drag.current = { x: e.clientX, y: e.clientY, active: false };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const mx = e.clientX - d.x;
    const my = e.clientY - d.y;
    if (!d.active) {
      if (Math.abs(mx) < 8 && Math.abs(my) < 8) return;
      // Vertical intent belongs to the page, not the carousel.
      if (Math.abs(my) > Math.abs(mx)) { drag.current = null; return; }
      d.active = true;
    }
    // Resist at the ends so the list feels bounded.
    const atStart = index === 0 && mx > 0;
    const atEnd = index === photos.length - 1 && mx < 0;
    setDx(atStart || atEnd ? mx * 0.25 : mx);
  };

  const settle = (target: number, then: () => void) => {
    setAnimating(true);
    setDx(target);
    window.setTimeout(() => {
      setAnimating(false);
      setDx(0);
      then();
    }, 220);
  };

  const onPointerUp = () => {
    const d = drag.current;
    drag.current = null;
    if (!d?.active) return;
    const w = window.innerWidth;
    if (dx < -w * COMMIT && index < photos.length - 1) {
      void tap("light");
      settle(-w, () => go(index + 1));
    } else if (dx > w * COMMIT && index > 0) {
      void tap("light");
      settle(w, () => go(index - 1));
    } else {
      settle(0, () => undefined);
    }
  };

  // ---- HEIC ------------------------------------------------------------------
  const isHeicItem = isHeic(photo?.mime, photo?.name);
  const [heicUrl, setHeicUrl] = useState<string | null>(null);
  useEffect(() => {
    setHeicUrl(null);
    if (!isHeicItem || !photo?.fullSrc) return;
    let alive = true;
    void heicUrlToJpegUrl(photo.fullSrc, photo.id).then((u) => { if (alive) setHeicUrl(u); });
    return () => { alive = false; };
  }, [photo?.id, photo?.fullSrc, isHeicItem]);

  if (!photo) return null;

  // ---- actions ---------------------------------------------------------------
  const share = async () => {
    void tap("medium");
    if (photo.provider === "device") {
      if (await shareGalleryItems([photo.id], photo.name)) return;
    }
    if (!photo.fullSrc) { toast.error("الملف غير محمّل بعد"); return; }
    try {
      const blob = await (await fetch(photo.fullSrc)).blob();
      const file = new File([blob], photo.name, { type: blob.type || "image/jpeg" });
      const nav = navigator as Navigator & {
        canShare?: (d: { files: File[] }) => boolean;
        share?: (d: { files: File[]; title?: string }) => Promise<void>;
      };
      if (nav.canShare?.({ files: [file] }) && nav.share) {
        await nav.share({ files: [file], title: photo.name });
        return;
      }
      toast.error("المشاركة غير مدعومة هنا");
    } catch {
      toast.error("تعذّرت المشاركة");
    }
  };

  const download = async () => {
    if (!photo.fullSrc) return;
    void tap("medium");
    const filename = photo.name || `media-${Date.now()}.jpg`;
    try {
      if (isNative() && /^https?:/i.test(photo.fullSrc)) {
        const path = await downloadUrlToDevice(photo.fullSrc, filename);
        if (path) { toast.success("حُفظ في المستندات"); return; }
      }
      const blob = await (await fetch(photo.fullSrc)).blob();
      if (isNative()) {
        const uri = await saveBlobToDevice(filename, blob);
        if (uri) { toast.success("حُفظ في المستندات"); return; }
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = filename;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      toast.error("تعذّر التنزيل: " + (e instanceof Error ? e.message : String(e)));
    }
  };

  const w = typeof window !== "undefined" ? window.innerWidth : 0;
  const neighbours = [index - 1, index, index + 1].filter((i) => i >= 0 && i < photos.length);

  return (
    <div className="fixed inset-0 z-[60] flex flex-col bg-black">
      {/* Track: prev / current / next move together with the finger. */}
      <div
        className="absolute inset-0 touch-pan-y"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onClick={() => setChrome((v) => !v)}
      >
        {neighbours.map((i) => (
          <div
            key={photos[i].id}
            className="absolute inset-0"
            style={{
              transform: `translate3d(${(i - index) * w + dx}px,0,0)`,
              transition: animating ? "transform 220ms cubic-bezier(0.22,1,0.36,1)" : "none",
            }}
          >
            <Slide
              photo={photos[i]}
              active={i === index}
              overrideSrc={i === index ? heicUrl ?? undefined : undefined}
            />
          </div>
        ))}
      </div>

      {/* Chrome */}
      <div
        className={cn(
          "pointer-events-none absolute inset-x-0 top-0 z-10 bg-gradient-to-b from-black/70 to-transparent pb-10 pt-2 transition-opacity safe-top",
          chrome ? "opacity-100" : "opacity-0",
        )}
      >
        <div className="pointer-events-auto flex items-center justify-between px-3">
          <button onClick={close} className="press grid h-10 w-10 place-items-center rounded-full bg-white/10 text-white" aria-label="إغلاق">
            <X className="h-5 w-5" />
          </button>
          <div className="text-xs font-semibold text-white/80 tabular-nums">
            {index + 1} / {photos.length}
          </div>
          <button onClick={() => { void tap("light"); setInfo((v) => !v); }} className="press grid h-10 w-10 place-items-center rounded-full bg-white/10 text-white" aria-label="معلومات">
            <Info className="h-5 w-5" />
          </button>
        </div>
      </div>

      <div
        className={cn(
          "pointer-events-none absolute inset-x-0 bottom-0 z-10 bg-gradient-to-t from-black/85 to-transparent pt-12 transition-opacity safe-bottom",
          chrome ? "opacity-100" : "opacity-0",
        )}
      >
        {info && (
          <div className="pointer-events-auto mx-4 mb-3 rounded-2xl bg-black/70 p-3 text-[11px] leading-relaxed text-white/85 backdrop-blur" dir="rtl">
            <div className="mb-1 truncate font-bold text-white">{photo.name}</div>
            <div>{photo.date.toLocaleString("ar")}</div>
            {photo.width && photo.height ? <div>{photo.width} × {photo.height}</div> : null}
            {photo.size ? <div>{(photo.size / 1048576).toFixed(1)} م.ب</div> : null}
          </div>
        )}

        <div className="pointer-events-auto">
          <Filmstrip photos={photos} index={index} onPick={go} />
        </div>

        <div className="pointer-events-auto flex items-center justify-around px-6 pb-2 pt-3">
          <Action icon={Share2} label="مشاركة" onClick={share} />
          {showDownload && <Action icon={Download} label="حفظ" onClick={download} />}
          {onDelete && (
            <Action
              icon={Trash2}
              label="حذف"
              onClick={() => { void tap("heavy"); onDelete(photo); }}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function Action({
  icon: Icon, label, onClick,
}: { icon: typeof Share2; label: string; onClick: () => void }) {
  return (
    <button onClick={onClick} className="press flex flex-col items-center gap-1 px-3 py-1 text-white">
      <Icon className="h-5 w-5" />
      <span className="text-[10px] font-semibold">{label}</span>
    </button>
  );
}
