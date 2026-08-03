import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

interface ZoomableImageProps {
  src: string;
  alt: string;
  className?: string;
  /** Called with true when scale > 1 (pan/zoom locked in). */
  onZoomChange?: (zoomed: boolean) => void;
  onLoad?: () => void;
}

/**
 * Pinch-zoom + pan for Lightbox. Supports:
 * - Two-finger pinch (touch) with focal-point anchoring.
 * - Ctrl/⌘ + wheel zoom (desktop trackpads).
 * - Double-tap/click to toggle 1× ↔ 2.5×.
 * - Single-finger drag to pan when zoomed.
 *
 * Deliberately self-contained: no external gesture libs.
 */
export function ZoomableImage({ src, alt, className, onZoomChange, onLoad }: ZoomableImageProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const [tx, setTx] = useState(0);
  const [ty, setTy] = useState(0);

  // Reset when source changes (navigating between photos).
  useEffect(() => {
    setScale(1);
    setTx(0);
    setTy(0);
  }, [src]);

  useEffect(() => {
    onZoomChange?.(scale > 1.02);
  }, [scale, onZoomChange]);

  const MIN = 1;
  const MAX = 5;

  // --- Touch state ---
  const pinchRef = useRef<{
    startDist: number;
    startScale: number;
    startTx: number;
    startTy: number;
    focalX: number;
    focalY: number;
  } | null>(null);
  const panRef = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);
  const lastTapRef = useRef(0);

  const applyZoomAt = (nextScale: number, focalX: number, focalY: number) => {
    const box = wrapRef.current?.getBoundingClientRect();
    if (!box) return;
    const s = Math.max(MIN, Math.min(MAX, nextScale));
    // Anchor the focal point on-screen: new_t = focal - (focal - old_t) * (s / oldScale)
    const cx = focalX - box.left - box.width / 2;
    const cy = focalY - box.top - box.height / 2;
    const ratio = s / scale;
    const nx = cx - (cx - tx) * ratio;
    const ny = cy - (cy - ty) * ratio;
    setScale(s);
    setTx(s === 1 ? 0 : nx);
    setTy(s === 1 ? 0 : ny);
  };

  const onTouchStart = (e: React.TouchEvent) => {
    if (e.touches.length === 2) {
      const [a, b] = [e.touches[0], e.touches[1]];
      const dx = b.clientX - a.clientX;
      const dy = b.clientY - a.clientY;
      pinchRef.current = {
        startDist: Math.hypot(dx, dy),
        startScale: scale,
        startTx: tx,
        startTy: ty,
        focalX: (a.clientX + b.clientX) / 2,
        focalY: (a.clientY + b.clientY) / 2,
      };
    } else if (e.touches.length === 1 && scale > 1) {
      panRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY, tx, ty };
    }
  };

  const onTouchMove = (e: React.TouchEvent) => {
    if (e.touches.length === 2 && pinchRef.current) {
      e.preventDefault();
      const [a, b] = [e.touches[0], e.touches[1]];
      const dist = Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY);
      const p = pinchRef.current;
      const next = Math.max(MIN, Math.min(MAX, p.startScale * (dist / p.startDist)));
      // Anchor using the initial focal point.
      const box = wrapRef.current?.getBoundingClientRect();
      if (!box) return;
      const cx = p.focalX - box.left - box.width / 2;
      const cy = p.focalY - box.top - box.height / 2;
      const ratio = next / p.startScale;
      setScale(next);
      setTx(next === 1 ? 0 : cx - (cx - p.startTx) * ratio);
      setTy(next === 1 ? 0 : cy - (cy - p.startTy) * ratio);
    } else if (e.touches.length === 1 && panRef.current && scale > 1) {
      e.preventDefault();
      const p = panRef.current;
      setTx(p.tx + (e.touches[0].clientX - p.x));
      setTy(p.ty + (e.touches[0].clientY - p.y));
    }
  };

  const onTouchEnd = (e: React.TouchEvent) => {
    pinchRef.current = null;
    if (e.touches.length === 0) panRef.current = null;
    // Double-tap toggle.
    if (e.changedTouches.length === 1) {
      const now = Date.now();
      if (now - lastTapRef.current < 280) {
        const t = e.changedTouches[0];
        if (scale > 1.02) {
          setScale(1);
          setTx(0);
          setTy(0);
        } else {
          applyZoomAt(2.5, t.clientX, t.clientY);
        }
        lastTapRef.current = 0;
      } else {
        lastTapRef.current = now;
      }
    }
  };

  const onWheel = (e: React.WheelEvent) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    const delta = -e.deltaY * 0.0025;
    applyZoomAt(scale * (1 + delta), e.clientX, e.clientY);
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    if (scale > 1.02) {
      setScale(1);
      setTx(0);
      setTy(0);
    } else {
      applyZoomAt(2.5, e.clientX, e.clientY);
    }
  };

  // Mouse drag pan while zoomed.
  const mouseRef = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);
  const onMouseDown = (e: React.MouseEvent) => {
    if (scale <= 1) return;
    mouseRef.current = { x: e.clientX, y: e.clientY, tx, ty };
  };
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!mouseRef.current) return;
      const p = mouseRef.current;
      setTx(p.tx + (e.clientX - p.x));
      setTy(p.ty + (e.clientY - p.y));
    };
    const onUp = () => {
      mouseRef.current = null;
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  return (
    <div
      ref={wrapRef}
      className="relative flex h-full w-full items-center justify-center overflow-hidden touch-none"
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      onWheel={onWheel}
      onDoubleClick={onDoubleClick}
      onMouseDown={onMouseDown}
      style={{ cursor: scale > 1 ? "grab" : "zoom-in" }}
    >
      <img
        src={src}
        alt={alt}
        draggable={false}
        onLoad={onLoad}
        className={cn("vt-active-photo max-h-full max-w-full select-none rounded-lg shadow-2xl", className)}
        style={{
          transform: `translate3d(${tx}px, ${ty}px, 0) scale(${scale})`,
          transformOrigin: "center center",
          transition: mouseRef.current || pinchRef.current || panRef.current ? "none" : "transform 0.2s ease-out",
          willChange: "transform",
        }}
      />
    </div>
  );
}
