import { useCallback, useEffect, useRef, useState } from "react";
import { tap } from "@/lib/native";
import { cn } from "@/lib/utils";

export interface ScrubMark {
  /** Document offset of the first row in this period. */
  top: number;
  label: string;
  year: number;
}

/**
 * Vertical date rail for jumping across a large library.
 *
 * With ten thousand photos, reaching last year means a very long flick. Drag
 * the rail and the grid follows the date under your thumb.
 */
export function Scrubber({
  marks,
  gridTop,
  gridHeight,
}: {
  marks: ScrubMark[];
  gridTop: number;
  gridHeight: number;
}) {
  const railRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const [ratio, setRatio] = useState(0);
  const lastLabel = useRef("");

  // Follow the page while idle so the handle shows where you actually are.
  useEffect(() => {
    if (dragging) return;
    const onScroll = () => {
      const max = Math.max(1, gridHeight - window.innerHeight);
      setRatio(Math.min(1, Math.max(0, (window.scrollY - gridTop) / max)));
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [dragging, gridTop, gridHeight]);

  const apply = useCallback(
    (clientY: number) => {
      const rail = railRef.current;
      if (!rail) return;
      const r = rail.getBoundingClientRect();
      const t = Math.min(1, Math.max(0, (clientY - r.top) / r.height));
      setRatio(t);
      const max = Math.max(1, gridHeight - window.innerHeight);
      window.scrollTo({ top: gridTop + t * max });
    },
    [gridTop, gridHeight],
  );

  // Which period the handle is over right now.
  const activeIdx = (() => {
    if (!marks.length) return -1;
    const y = gridTop + ratio * Math.max(1, gridHeight - window.innerHeight);
    let idx = 0;
    for (let i = 0; i < marks.length; i++) if (marks[i].top + gridTop <= y + 80) idx = i;
    return idx;
  })();

  const activeLabel = marks[activeIdx]?.label ?? "";
  useEffect(() => {
    if (dragging && activeLabel && activeLabel !== lastLabel.current) {
      lastLabel.current = activeLabel;
      void tap("light");
    }
  }, [dragging, activeLabel]);

  if (marks.length < 3) return null;

  // One tick per year keeps the rail readable on a decade-long library.
  const years = marks.filter((m, i) => i === 0 || m.year !== marks[i - 1].year);

  return (
    <div
      ref={railRef}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        setDragging(true);
        apply(e.clientY);
      }}
      onPointerMove={(e) => { if (dragging) apply(e.clientY); }}
      onPointerUp={() => setDragging(false)}
      onPointerCancel={() => setDragging(false)}
      className="fixed inset-y-0 left-0 z-30 w-9 touch-none"
      aria-label="شريط التاريخ"
    >
      <div className="relative h-full py-24">
        {years.map((m) => {
          const p =
            gridHeight > 0 ? Math.min(1, Math.max(0, m.top / Math.max(1, gridHeight))) : 0;
          return (
            <span
              key={m.year}
              style={{ top: `${p * 100}%` }}
              className="pointer-events-none absolute left-1 -translate-y-1/2 text-[9px] font-black tabular-nums text-muted-foreground/70"
            >
              {m.year}
            </span>
          );
        })}

        <span
          style={{ top: `${ratio * 100}%` }}
          className={cn(
            "pointer-events-none absolute left-0 h-8 w-1 -translate-y-1/2 rounded-full transition-colors",
            dragging ? "bg-hot" : "bg-muted-foreground/40",
          )}
        />

        {dragging && activeLabel && (
          <span
            style={{ top: `${ratio * 100}%` }}
            className="pointer-events-none absolute left-10 -translate-y-1/2 whitespace-nowrap rounded-full bg-foreground px-3 py-1.5 text-xs font-black text-background shadow-xl"
          >
            {activeLabel}
          </span>
        )}
      </div>
    </div>
  );
}
