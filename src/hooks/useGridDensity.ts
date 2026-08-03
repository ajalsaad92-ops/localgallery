import { useCallback, useEffect, useState } from "react";

export type GridDensity = "large" | "comfortable" | "compact";

const KEY = "lgp-grid-density";

export function useGridDensity(initial: GridDensity = "comfortable") {
  const [density, setDensityState] = useState<GridDensity>(() => {
    if (typeof window === "undefined") return initial;
    const v = window.localStorage.getItem(KEY);
    return v === "large" || v === "compact" || v === "comfortable" ? v : initial;
  });

  useEffect(() => {
    try {
      window.localStorage.setItem(KEY, density);
    } catch {
      /* ignore quota */
    }
  }, [density]);

  const setDensity = useCallback((d: GridDensity) => setDensityState(d), []);
  return { density, setDensity };
}

/** Target cell size per density — column count follows from the width. */
const TARGET_PX: Record<GridDensity, number> = {
  large: 190,
  comfortable: 130,
  compact: 96,
};

/** Column count for a given container width. */
export function columnsFor(density: GridDensity, width: number): number {
  if (width <= 0) return 3;
  return Math.max(2, Math.round(width / TARGET_PX[density]));
}
