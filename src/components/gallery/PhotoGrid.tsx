import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Play } from "lucide-react";
import { groupByDate, type GalleryItem } from "@/lib/galleryItem";
import { formatDuration } from "@/lib/video";
import { cn } from "@/lib/utils";
import { tap } from "@/lib/native";
import { columnsFor, type GridDensity } from "@/hooks/useGridDensity";

interface PhotoGridProps {
  photos: GalleryItem[];
  onOpen: (index: number) => void;
  activeId?: string | null;
  density?: GridDensity;
  emptyContent?: React.ReactNode;
}

/** Rows are square cells, so height is predictable without measuring. */
const GAP = 3;
const HEADER_H = 44;
/** Extra screens rendered above and below the viewport. */
const OVERSCAN = 1.5;

type Row =
  | { kind: "header"; label: string; top: number; height: number }
  | { kind: "items"; items: GalleryItem[]; top: number; height: number };

function useViewport(ref: React.RefObject<HTMLDivElement>) {
  const [state, setState] = useState({ width: 0, scrollY: 0, height: 0 });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const measure = () => {
      setState({
        width: el.clientWidth,
        // The page itself scrolls, so position the window against the element.
        scrollY: -el.getBoundingClientRect().top,
        height: window.innerHeight,
      });
    };

    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    window.addEventListener("scroll", measure, { passive: true });
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("scroll", measure);
      window.removeEventListener("resize", measure);
    };
  }, [ref]);

  return state;
}

/**
 * Date-grouped photo grid that only mounts the rows near the viewport.
 *
 * A library of 20k photos would otherwise create 20k DOM nodes at once, which
 * is what made the app freeze on a real phone. Total height is computed up
 * front so the scrollbar stays honest.
 */
export function PhotoGrid({
  photos,
  onOpen,
  activeId,
  density = "comfortable",
  emptyContent,
}: PhotoGridProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const { width, scrollY, height } = useViewport(hostRef);
  const cols = columnsFor(density, width);

  const indexOf = useMemo(() => {
    const map = new Map<string, number>();
    photos.forEach((p, i) => map.set(p.id, i));
    return map;
  }, [photos]);

  const { rows, totalHeight } = useMemo(() => {
    if (width === 0) return { rows: [] as Row[], totalHeight: 0 };
    const cell = (width - GAP * (cols - 1)) / cols;
    const out: Row[] = [];
    let top = 0;

    for (const group of groupByDate(photos)) {
      out.push({ kind: "header", label: group.label, top, height: HEADER_H });
      top += HEADER_H;
      for (let i = 0; i < group.items.length; i += cols) {
        const items = group.items.slice(i, i + cols);
        const h = cell + GAP;
        out.push({ kind: "items", items, top, height: h });
        top += h;
      }
      top += GAP * 2;
    }
    return { rows: out, totalHeight: top };
  }, [photos, cols, width]);

  const visible = useMemo(() => {
    if (rows.length === 0) return rows;
    const pad = height * OVERSCAN;
    const from = scrollY - pad;
    const to = scrollY + height + pad;
    return rows.filter((r) => r.top + r.height >= from && r.top <= to);
  }, [rows, scrollY, height]);

  const lastOpenAt = useRef(0);
  const handleOpen = useCallback(
    (idx: number) => {
      const now = Date.now();
      if (now - lastOpenAt.current < 250) return;
      lastOpenAt.current = now;
      void tap("light");
      onOpen(idx);
    },
    [onOpen],
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
      {visible.map((row) =>
        row.kind === "header" ? (
          <h2
            key={`h-${row.label}`}
            dir="rtl"
            className="absolute inset-x-0 flex items-end px-2 pb-2 text-[13px] font-bold text-foreground/90"
            style={{ top: row.top, height: row.height }}
          >
            {row.label}
          </h2>
        ) : (
          <div
            key={`r-${row.items[0].id}`}
            className="absolute inset-x-0 flex"
            style={{ top: row.top, height: cell, gap: GAP }}
          >
            {row.items.map((photo) => {
              const idx = indexOf.get(photo.id)!;
              return (
                <button
                  key={photo.id}
                  onClick={() => handleOpen(idx)}
                  aria-label={photo.name}
                  className={cn(
                    "group relative overflow-hidden rounded-[10px] bg-secondary",
                    "transition-transform duration-150 active:scale-[0.94]",
                    "focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  )}
                  style={{
                    width: cell,
                    height: cell,
                    viewTransitionName: activeId === photo.id ? `photo-${photo.id}` : undefined,
                  }}
                >
                  {photo.thumbSrc ? (
                    <img
                      src={photo.thumbSrc}
                      alt=""
                      loading="lazy"
                      decoding="async"
                      draggable={false}
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <div className="h-full w-full animate-pulse bg-secondary" />
                  )}

                  {photo.kind === "video" && (
                    <>
                      <span className="pointer-events-none absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-t from-black/55 to-transparent" />
                      <span className="pointer-events-none absolute bottom-1.5 left-1.5 flex items-center gap-1 text-[10px] font-bold text-white">
                        <Play className="h-3 w-3 fill-current" />
                        {photo.duration ? formatDuration(photo.duration) : null}
                      </span>
                    </>
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
