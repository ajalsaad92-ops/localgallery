import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, CloudUpload, Play } from "lucide-react";
import { groupByDate, type GalleryItem } from "@/lib/galleryItem";
import { formatDuration } from "@/lib/video";
import { cn } from "@/lib/utils";
import { tap } from "@/lib/native";
import { columnsFor, type GridDensity } from "@/hooks/useGridDensity";
import { Thumb } from "./Thumb";
import { Scrubber, type ScrubMark } from "./Scrubber";

interface PhotoGridProps {
  photos: GalleryItem[];
  onOpen: (index: number) => void;
  activeId?: string | null;
  density?: GridDensity;
  emptyContent?: React.ReactNode;
  /** Selection mode: when non-null the grid selects instead of opening. */
  selected?: Set<string> | null;
  onToggleSelect?: (id: string) => void;
  onEnterSelection?: (id: string) => void;
  /** Marks items still waiting to upload. */
  pendingIds?: Set<string>;
  /** Shows the date rail for jumping across a long library. */
  scrubber?: boolean;
}

const GAP = 3;
const HEADER_H = 44;
/** Extra screens rendered above and below the viewport. */
const OVERSCAN = 1.5;

type Row =
  | { kind: "header"; label: string; count: number; top: number; height: number }
  | { kind: "items"; items: GalleryItem[]; top: number; height: number };

/** Quantise the scroll position so a render happens per step, not per pixel. */
const SCROLL_STEP = 60;

function useViewport(ref: React.RefObject<HTMLDivElement>) {
  const [box, setBox] = useState({ width: 0, top: 0, height: 0 });
  const [scrollY, setScrollY] = useState(0);

  // Geometry changes only on resize — never while scrolling.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const remeasure = () => {
      const r = el.getBoundingClientRect();
      setBox({
        width: el.clientWidth,
        top: r.top + window.scrollY,
        height: window.innerHeight,
      });
    };
    remeasure();
    const ro = new ResizeObserver(remeasure);
    ro.observe(el);
    window.addEventListener("resize", remeasure);
    window.addEventListener("orientationchange", remeasure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", remeasure);
      window.removeEventListener("orientationchange", remeasure);
    };
  }, [ref]);

  // Scrolling reads window.scrollY only. Calling getBoundingClientRect() here
  // forced a full synchronous layout of thousands of positioned tiles on every
  // frame — that was the stutter, not the images.
  useEffect(() => {
    let frame = 0;
    const onScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        setScrollY((prev) => {
          const next = window.scrollY;
          return Math.abs(next - prev) >= SCROLL_STEP ? next : prev;
        });
      });
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener("scroll", onScroll);
    };
  }, []);

  return { width: box.width, height: box.height, scrollY: scrollY - box.top, gridTop: box.top };
}

/**
 * Date-grouped photo grid that only mounts the rows near the viewport.
 *
 * A 20k-photo library would otherwise create 20k DOM nodes at once. Total
 * height is computed up front so the scrollbar stays honest.
 */
export function PhotoGrid({
  photos,
  onOpen,
  activeId,
  density = "comfortable",
  emptyContent,
  selected = null,
  onToggleSelect,
  onEnterSelection,
  pendingIds,
  scrubber = true,
}: PhotoGridProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const { width, scrollY, height, gridTop } = useViewport(hostRef);
  const cols = columnsFor(density, width);
  const selecting = selected !== null;

  const indexOf = useMemo(() => {
    const map = new Map<string, number>();
    photos.forEach((p, i) => map.set(p.id, i));
    return map;
  }, [photos]);

  const { rows, totalHeight, marks } = useMemo(() => {
    if (width === 0) return { rows: [] as Row[], totalHeight: 0, marks: [] as ScrubMark[] };
    const cell = (width - GAP * (cols - 1)) / cols;
    const out: Row[] = [];
    const scrubMarks: ScrubMark[] = [];
    let top = 0;
    let lastPeriod = "";

    for (const group of groupByDate(photos)) {
      const first = group.items[0]?.date;
      if (first) {
        const period = `${first.getFullYear()}-${first.getMonth()}`;
        if (period !== lastPeriod) {
          lastPeriod = period;
          scrubMarks.push({
            top,
            year: first.getFullYear(),
            label: first.toLocaleDateString("ar", { month: "long", year: "numeric" }),
          });
        }
      }
      out.push({
        kind: "header", label: group.label, count: group.items.length,
        top, height: HEADER_H,
      });
      top += HEADER_H;
      for (let i = 0; i < group.items.length; i += cols) {
        out.push({
          kind: "items",
          items: group.items.slice(i, i + cols),
          top,
          height: cell + GAP,
        });
        top += cell + GAP;
      }
      top += GAP * 2;
    }
    return { rows: out, totalHeight: top, marks: scrubMarks };
  }, [photos, cols, width]);

  const visible = useMemo(() => {
    if (rows.length === 0) return rows;
    const pad = height * OVERSCAN;
    return rows.filter((r) => r.top + r.height >= scrollY - pad && r.top <= scrollY + height + pad);
  }, [rows, scrollY, height]);

  const lastOpenAt = useRef(0);
  const longPress = useRef<number | null>(null);
  // A long-press is followed by a click on release. Without this the
  // click would immediately toggle the item back off and exit selection.
  const suppressClick = useRef(false);
  // After a long-press, sliding the finger keeps selecting — picking twenty
  // photos should not mean twenty separate taps.
  const painting = useRef(false);
  const painted = useRef<Set<string>>(new Set());

  const activate = useCallback(
    (photo: GalleryItem, idx: number) => {
      if (suppressClick.current) {
        suppressClick.current = false;
        return;
      }
      if (selecting) {
        void tap("light");
        onToggleSelect?.(photo.id);
        return;
      }
      const now = Date.now();
      if (now - lastOpenAt.current < 250) return;
      lastOpenAt.current = now;
      void tap("light");
      onOpen(idx);
    },
    [selecting, onToggleSelect, onOpen],
  );

  const startLongPress = useCallback(
    (photo: GalleryItem) => {
      if (selecting) return;
      longPress.current = window.setTimeout(() => {
        longPress.current = null;
        suppressClick.current = true;
        painting.current = true;
        painted.current = new Set([photo.id]);
        void tap("medium");
        onEnterSelection?.(photo.id);
      }, 400);
    },
    [selecting, onEnterSelection],
  );

  const cancelLongPress = useCallback(() => {
    if (longPress.current != null) {
      clearTimeout(longPress.current);
      longPress.current = null;
    }
  }, []);

  const endPaint = useCallback(() => {
    painting.current = false;
    painted.current.clear();
  }, []);

  /** While painting, whichever tile is under the finger joins the selection. */
  const paintAt = useCallback(
    (clientX: number, clientY: number) => {
      if (!painting.current) return;
      const el = document
        .elementFromPoint(clientX, clientY)
        ?.closest<HTMLElement>("[data-photo-id]");
      const id = el?.dataset.photoId;
      if (!id || painted.current.has(id)) return;
      painted.current.add(id);
      void tap("light");
      onToggleSelect?.(id);
    },
    [onToggleSelect],
  );

  const cell = width > 0 ? (width - GAP * (cols - 1)) / cols : 0;

  // The host stays mounted even while empty. Assets arrive asynchronously, so
  // an early return here would mean the ref is never attached and the width is
  // never measured — leaving the grid permanently blank once they load.
  return (
    <div
      ref={hostRef}
      className="relative w-full"
      style={{ height: photos.length ? totalHeight : undefined }}
      dir="ltr"
    >
      {photos.length === 0 && emptyContent}

      {scrubber && photos.length > 60 && (
        <Scrubber marks={marks} gridTop={gridTop} gridHeight={totalHeight} />
      )}

      {visible.map((row) =>
        row.kind === "header" ? (
          <div
            key={`h-${row.label}`}
            dir="rtl"
            className="absolute inset-x-0 flex items-end justify-between px-3 pb-2"
            style={{ top: row.top, height: row.height }}
          >
            <span className="text-[13px] font-bold text-foreground/90">{row.label}</span>
            <span className="text-[11px] font-semibold text-muted-foreground">{row.count}</span>
          </div>
        ) : (
          <div
            key={`r-${row.items[0].id}`}
            className="absolute inset-x-0 flex touch-pan-y"
            style={{ top: row.top, height: cell, gap: GAP }}
          >
            {row.items.map((photo) => {
              const idx = indexOf.get(photo.id)!;
              const isSel = selected?.has(photo.id) ?? false;
              return (
                <button
                  key={photo.id}
                  onClick={() => activate(photo, idx)}
                  onPointerDown={() => startLongPress(photo)}
                  onPointerUp={() => { cancelLongPress(); endPaint(); }}
                  onPointerCancel={() => { cancelLongPress(); endPaint(); }}
                  onPointerMove={(e) => {
                    // Any real movement means this is a drag, not a long-press.
                    if (!painting.current) cancelLongPress();
                    else paintAt(e.clientX, e.clientY);
                  }}
                  onContextMenu={(e) => e.preventDefault()}
                  data-photo-id={photo.id}
                  aria-label={photo.name}
                  aria-pressed={selecting ? isSel : undefined}
                  className={cn(
                    "group relative overflow-hidden bg-secondary",
                    "transition-[transform,border-radius] duration-150",
                    isSel ? "scale-[0.86] rounded-2xl" : "rounded-[10px] active:scale-[0.94]",
                  )}
                  style={{ width: cell, height: cell }}
                >
                  <span
                    style={{
                      viewTransitionName:
                        activeId === photo.id ? `photo-${photo.id}` : undefined,
                    }}
                    className="block h-full w-full"
                  >
                    <Thumb photo={photo} />
                  </span>

                  {photo.kind === "video" && (
                    <>
                      <span className="pointer-events-none absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-t from-black/60 to-transparent" />
                      <span className="pointer-events-none absolute bottom-1.5 left-1.5 flex items-center gap-1 text-[10px] font-bold text-white drop-shadow">
                        <Play className="h-3 w-3 fill-current" />
                        {photo.duration ? formatDuration(photo.duration) : null}
                      </span>
                    </>
                  )}

                  {pendingIds?.has(photo.id) && !selecting && (
                    <span className="pointer-events-none absolute right-1.5 top-1.5 grid h-5 w-5 place-items-center rounded-full bg-black/55 text-white backdrop-blur">
                      <CloudUpload className="h-3 w-3" />
                    </span>
                  )}

                  {selecting && (
                    <span
                      className={cn(
                        "pointer-events-none absolute right-1.5 top-1.5 grid h-6 w-6 place-items-center rounded-full border-2 transition",
                        isSel
                          ? "border-primary bg-primary text-primary-foreground"
                          : "border-white/80 bg-black/25",
                      )}
                    >
                      {isSel && <Check className="h-3.5 w-3.5" strokeWidth={3} />}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        ),
      )}
    </div>
  );
}
