import { useState } from "react";
import {
  ArrowDownWideNarrow, Check, CloudOff, Copy, Crop, Folder, Images, Search, Video, X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { tap } from "@/lib/native";

export type MediaFilter = "all" | "photos" | "videos" | "screenshots" | "pending" | "duplicates";
export type SortOrder = "newest" | "oldest" | "largest";

const FILTERS: { id: MediaFilter; label: string; icon: typeof Images }[] = [
  { id: "all", label: "الكل", icon: Images },
  { id: "photos", label: "صور", icon: Images },
  { id: "videos", label: "فيديو", icon: Video },
  { id: "screenshots", label: "لقطات الشاشة", icon: Crop },
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
  query?: string;
  onQuery?: (q: string) => void;
  buckets?: { name: string; count: number }[];
  bucket?: string | null;
  onBucket?: (b: string | null) => void;
}

export function FilterBar({
  filter, onFilter, sort, onSort, counts, hide = [],
  query = "", onQuery, buckets = [], bucket = null, onBucket,
}: Props) {
  const [searching, setSearching] = useState(false);
  const [folders, setFolders] = useState(false);

  const cycleSort = () => {
    void tap("light");
    const i = SORTS.findIndex((s) => s.id === sort);
    onSort(SORTS[(i + 1) % SORTS.length].id);
  };

  if (searching) {
    return (
      <div className="mb-2 flex items-center gap-2 px-4">
        <div className="flex flex-1 items-center gap-2 rounded-full bg-secondary px-3 py-2">
          <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <input
            autoFocus
            value={query}
            onChange={(e) => onQuery?.(e.target.value)}
            placeholder="ابحث بالاسم أو الشهر أو السنة…"
            className="min-w-0 flex-1 bg-transparent text-[12px] font-semibold outline-none"
          />
        </div>
        <button
          onClick={() => { void tap("light"); onQuery?.(""); setSearching(false); }}
          aria-label="إغلاق البحث"
          className="press grid h-9 w-9 shrink-0 place-items-center rounded-full bg-secondary"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    );
  }

  if (folders) {
    return (
      <div className="mb-2 px-4">
        <div className="mb-1.5 flex items-center justify-between">
          <span className="text-[11px] font-black">مجلدات الهاتف</span>
          <button
            onClick={() => { void tap("light"); setFolders(false); }}
            className="press text-[11px] font-bold text-muted-foreground"
          >
            تم
          </button>
        </div>
        <div dir="rtl" className="flex gap-1.5 overflow-x-auto" style={{ scrollbarWidth: "none" }}>
          <button
            onClick={() => { void tap("light"); onBucket?.(null); }}
            className={cn(
              "press shrink-0 rounded-full px-3 py-1.5 text-[11px] font-bold",
              bucket === null ? "bg-foreground text-background" : "bg-secondary text-muted-foreground",
            )}
          >
            الكل
          </button>
          {buckets.map((b) => (
            <button
              key={b.name}
              onClick={() => { void tap("light"); onBucket?.(b.name); }}
              className={cn(
                "press flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-[11px] font-bold",
                bucket === b.name ? "bg-foreground text-background" : "bg-secondary text-muted-foreground",
              )}
            >
              {b.name}
              <span className="opacity-60 tabular-nums">{b.count}</span>
            </button>
          ))}
        </div>
      </div>
    );
  }

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

      {onQuery && (
        <button
          onClick={() => { void tap("light"); setSearching(true); }}
          aria-label="بحث"
          className="press grid h-8 w-8 shrink-0 place-items-center rounded-full bg-secondary text-muted-foreground"
        >
          <Search className="h-3.5 w-3.5" />
        </button>
      )}

      {onBucket && buckets.length > 1 && (
        <button
          onClick={() => { void tap("light"); setFolders(true); }}
          aria-label="مجلدات"
          className={cn(
            "press grid h-8 w-8 shrink-0 place-items-center rounded-full",
            bucket ? "bg-foreground text-background" : "bg-secondary text-muted-foreground",
          )}
        >
          <Folder className="h-3.5 w-3.5" />
        </button>
      )}

      <button
        onClick={cycleSort}
        title={SORTS.find((s) => s.id === sort)?.label}
        aria-label={SORTS.find((s) => s.id === sort)?.label}
        className="press grid h-8 w-8 shrink-0 place-items-center rounded-full bg-secondary text-muted-foreground"
      >
        <ArrowDownWideNarrow className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
