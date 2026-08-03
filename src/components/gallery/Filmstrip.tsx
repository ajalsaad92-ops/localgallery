import { useEffect, useRef } from "react";
import type { GalleryItem } from "@/lib/galleryItem";
import { cn } from "@/lib/utils";
import { Thumb } from "./Thumb";

const CELL = 44;
const GAP = 4;
/** Only these many neighbours are mounted; the rest is spacer. */
const WINDOW = 24;

/**
 * The strip of neighbouring frames under the viewer, like the stock gallery.
 * It is what makes the viewer read as a position in a list rather than a
 * single isolated picture.
 */
export function Filmstrip({
  photos, index, onPick,
}: {
  photos: GalleryItem[];
  index: number;
  onPick: (i: number) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);

  const from = Math.max(0, index - WINDOW);
  const to = Math.min(photos.length, index + WINDOW + 1);

  // Keep the active frame centred as the user swipes through the viewer.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    // The leading spacer stands in for the frames before `from`.
    const target = index * (CELL + GAP) - el.clientWidth / 2 + CELL / 2;
    el.scrollTo({ left: Math.max(0, target), behavior: "smooth" });
  }, [index]);

  if (photos.length < 2) return null;

  return (
    <div
      ref={scroller}
      dir="ltr"
      className="flex items-center overflow-x-auto px-4 pb-1"
      style={{ gap: GAP, scrollbarWidth: "none" }}
      onClick={(e) => e.stopPropagation()}
    >
      {from > 0 && <div style={{ width: from * (CELL + GAP) }} className="shrink-0" />}

      {photos.slice(from, to).map((p, i) => {
        const real = from + i;
        const on = real === index;
        return (
          <button
            key={p.id}
            onClick={() => onPick(real)}
            aria-label={p.name}
            aria-current={on}
            className={cn(
              "shrink-0 overflow-hidden rounded-md transition-all duration-150",
              on ? "ring-2 ring-white" : "opacity-55",
            )}
            style={{
              width: on ? CELL + 8 : CELL,
              height: on ? CELL + 8 : CELL,
            }}
          >
            <Thumb photo={p} />
          </button>
        );
      })}

      {to < photos.length && (
        <div style={{ width: (photos.length - to) * (CELL + GAP) }} className="shrink-0" />
      )}
    </div>
  );
}
