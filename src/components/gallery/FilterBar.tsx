import { ArrowDownWideNarrow, Check, CloudOff, Copy, Images, Video } from "lucide-react";
import { cn } from "@/lib/utils";
import { tap } from "@/lib/native";

export type MediaFilter = "all" | "photos" | "videos" | "pending" | "duplicates";
export type SortOrder = "newest" | "oldest" | "largest";

const FILTERS: { id: MediaFilter; label: string; icon: typeof Images }[] = [
  { id: "all", label: "الكل", icon: Images },
  { id: "photos", label: "صور", icon: Images },
  { id: "videos", label: "فيديو", icon: Video },
  { id: "pending", label: "لم تُرفع", icon: CloudOff },
  { id: "duplicates", label: "مكررات", icon: Copy },
];

const SORTS: { id: SortOrder; label: string }[] = [
  { id: "newest", label: "الأحدث أولاً" },
  { id: "oldest", label: "الأقدم أولاً" },
  { id: "largest", label: "الأكبر حجماً" },
];

interface Props {
  filter: MediaFilter;
  onFilter: (f: MediaFilter) => void;
  sort: SortOrder;
  onSort: (s: SortOrder) => void;
  counts?: Partial<Record<MediaFilter, number>>;
  /** Hide filters that make no sense on the remote feed. */
  hide?: MediaFilter[];
}

export function FilterBar({ filter, onFilter, sort, onSort, counts, hide = [] }: Props) {
  const cycleSort = () => {
    void tap("light");
    const i = SORTS.findIndex((s) => s.id === sort);
    onSort(SORTS[(i + 1) % SORTS.length].id);
  };

  return (
    <div className="mb-2 flex items-center gap-2 px-4">
      <div
        dir="rtl"
        className="flex flex-1 gap-1.5 overflow-x-auto"
        style={{ scrollbarWidth: "none" }}
      >
        {FILTERS.filter((f) => !hide.includes(f.id)).map((f) => {
          const on = filter === f.id;
          const n = counts?.[f.id];
          return (
            <button
              key={f.id}
              onClick={() => { void tap("light"); onFilter(f.id); }}
              className={cn(
                "press flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-[11px] font-bold transition",
                on
                  ? "bg-foreground text-background"
                  : "bg-secondary text-muted-foreground",
              )}
            >
              {on ? <Check className="h-3 w-3" /> : <f.icon className="h-3 w-3" />}
              {f.label}
              {n != null && n > 0 && (
                <span className={cn("tabular-nums", on ? "opacity-70" : "opacity-60")}>{n}</span>
              )}
            </button>
          );
        })}
      </div>

      <button
        onClick={cycleSort}
        title={SORTS.find((s) => s.id === sort)?.label}
        aria-label={SORTS.find((s) => s.id === sort)?.label}
        className="press flex shrink-0 items-center gap-1 rounded-full bg-secondary px-2.5 py-1.5 text-[11px] font-bold text-muted-foreground"
      >
        <ArrowDownWideNarrow className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
