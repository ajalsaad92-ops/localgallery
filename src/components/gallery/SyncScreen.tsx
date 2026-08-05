import { useEffect, useMemo, useState } from "react";
import { CheckCircle2 } from "lucide-react";
import { useMediaAssets } from "@/hooks/useMediaAssets";
import { useGalleryView, useSelection, onThisDay } from "@/hooks/useGalleryView";
import { useUpdateWatcher } from "@/hooks/useUpdateWatcher";
import { launchApkInstall } from "@/lib/ota";
import { Memories } from "./Memories";
import { UpdateBanner } from "./UpdateBanner";
import { getSavedTarget, type MtTarget } from "@/lib/providers/mtproto";
import { PhotoGrid } from "./PhotoGrid";
import { Lightbox } from "./Lightbox";
import { UploadFab } from "./UploadFab";
import { EmptyState } from "./EmptyState";
import { StatusPill } from "./StatusPill";
import { FilterBar } from "./FilterBar";
import { SelectionBar } from "./SelectionBar";
import { useGridDensity } from "@/hooks/useGridDensity";
import { runViewTransition } from "@/lib/viewTransition";
import { deleteGalleryItems, tap } from "@/lib/native";
import { forgetThumb } from "@/lib/thumbs";
import { photoDb } from "@/lib/photoDb";
import { toast } from "sonner";

/** Everything that lives on this phone: uploaded or not. */
export function SyncScreen({ onSelectionChange }: { onSelectionChange?: (on: boolean) => void }) {
  const assets = useMediaAssets({ kind: "device" });
  const view = useGalleryView(assets);
  const sel = useSelection();
  const { density } = useGridDensity();
  const [lightbox, setLightbox] = useState<number | null>(null);
  const [target, setTarget] = useState<MtTarget | null>(null);
  const { update, dismiss } = useUpdateWatcher();

  useEffect(() => {
    let alive = true;
    void getSavedTarget().then((t) => alive && setTarget(t));
    return () => { alive = false; };
  }, []);

  useEffect(() => onSelectionChange?.(sel.selecting), [sel.selecting, onSelectionChange]);

  const pendingIds = useMemo(
    () => new Set(assets.filter((a) => a.syncedAt == null).map((a) => a.id)),
    [assets],
  );

  const selectedIds = useMemo(() => (sel.selected ? [...sel.selected] : []), [sel.selected]);

  const removeOne = async (id: string) => {
    const n = await deleteGalleryItems([id]);
    if (n > 0) {
      forgetThumb(id);
      await photoDb.assets.delete(id);
      toast.success("حُذف");
      setLightbox(null);
    }
  };

  return (
    <div className="min-h-full pb-32">
      {/*
        One short row instead of the old block. The 46px count, the subtitle and
        the status strip together ate roughly a quarter of the screen before any
        photo appeared.
      */}
      <header className="safe-top flex items-center gap-3 px-4 pb-1 pt-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-1.5">
            <span className="text-[19px] font-black leading-none tabular-nums">
              {view.items.length.toLocaleString("ar")}
            </span>
            <span className="truncate text-[11px] font-semibold text-muted-foreground">
              {pendingIds.size > 0
                ? `· ${pendingIds.size.toLocaleString("ar")} بانتظار الرفع`
                : "· كل شيء محفوظ ✨"}
            </span>
          </div>
        </div>
        <UploadFab compact />
      </header>

      {update?.apkUrl && (
        <UpdateBanner
          version={update.latestVersion ?? ""}
          onInstall={() => void launchApkInstall(update.apkUrl!)}
          onLater={dismiss}
        />
      )}

      <StatusPill />

      {!target && (
        <div className="mx-4 mb-2 rounded-2xl border border-primary/40 bg-primary/10 p-3 text-[12px] font-semibold">
          اربط حسابك واختر قناة الحفظ من «ضبط» لتبدأ المزامنة.
        </div>
      )}

      <FilterBar
        filter={view.filter}
        onFilter={view.setFilter}
        sort={view.sort}
        onSort={view.setSort}
        counts={view.counts}
        query={view.query}
        onQuery={view.setQuery}
        buckets={view.buckets}
        bucket={view.bucket}
        onBucket={view.setBucket}
      />

      {view.filter === "all" && !view.query && !view.bucket && (
        <Memories
          assets={onThisDay(assets)}
          onOpen={(id) => {
            const i = view.items.findIndex((p) => p.id === id);
            if (i >= 0) runViewTransition(() => setLightbox(i));
          }}
        />
      )}

      <div className="px-2">
        <PhotoGrid
          photos={view.items}
          density={density}
          selected={sel.selected}
          onToggleSelect={sel.toggle}
          onEnterSelection={sel.start}
          pendingIds={pendingIds}
          onOpen={(i) => { void tap("light"); runViewTransition(() => setLightbox(i)); }}
          activeId={lightbox != null ? view.items[lightbox]?.id : null}
          emptyContent={
            <EmptyState
              icon={CheckCircle2}
              title={view.filter === "duplicates" ? "لا مكررات" : "لا شيء هنا"}
              body={
                view.filter === "duplicates"
                  ? "لم نعثر على صور مكررة في مكتبتك."
                  : "أي صورة تلتقطها ستظهر هنا وتُرفع تلقائياً."
              }
            />
          }
        />
      </div>

      {lightbox != null && (
        <Lightbox
          photos={view.items}
          index={lightbox}
          onIndexChange={setLightbox}
          onClose={() => setLightbox(null)}
          onDelete={(p) => void removeOne(p.id)}
        />
      )}

      {sel.selecting && (
        <SelectionBar
          ids={selectedIds}
          total={view.items.length}
          deviceOnly
          onClear={sel.clear}
          onSelectAll={() => sel.selectAll(view.items.map((i) => i.id))}
        />
      )}
    </div>
  );
}
