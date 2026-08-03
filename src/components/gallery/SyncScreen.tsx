import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, CloudUpload, Loader2, Pause, Play } from "lucide-react";
import { useMediaAssets } from "@/hooks/useMediaAssets";
import { useSyncProgress, useSyncSettings } from "@/hooks/useSyncEngine";
import { runSyncCycle, setSyncSettings } from "@/lib/syncEngine";
import { useLocalBlobUrls } from "@/hooks/useTelegramFeed";
import { getSavedTarget, type MtTarget } from "@/lib/providers/mtproto";
import { PhotoGrid } from "./PhotoGrid";
import { Lightbox } from "./Lightbox";
import { UploadFab } from "./UploadFab";
import { EmptyState } from "./EmptyState";
import { useGridDensity } from "@/hooks/useGridDensity";
import { runViewTransition } from "@/lib/viewTransition";
import { tap } from "@/lib/native";
import type { GalleryItem } from "@/lib/galleryItem";

export function SyncScreen() {
  const assets = useMediaAssets({ kind: "unsynced-device" });
  const progress = useSyncProgress();
  const settings = useSyncSettings();
  const { density } = useGridDensity();
  const blobUrls = useLocalBlobUrls(assets);
  const [lightbox, setLightbox] = useState<number | null>(null);
  const [target, setTarget] = useState<MtTarget | null>(null);

  useEffect(() => {
    let alive = true;
    void getSavedTarget().then((t) => alive && setTarget(t));
    return () => { alive = false; };
  }, [progress.running]);

  const photos = useMemo<GalleryItem[]>(
    () =>
      assets.map((a) => {
        const url = blobUrls.get(a.id) ?? a.localUri;
        return {
          id: a.id,
          width: a.width ?? 400,
          height: a.height ?? 400,
          date: new Date(a.date),
          name: a.name,
          thumbSrc: (a.kind === "video" ? a.posterDataUrl : url) ?? url,
          fullSrc: url,
          kind: a.kind === "video" ? "video" : "image",
          duration: a.duration,
          mime: a.mime,
          provider: a.provider,
        };
      }),
    [assets, blobUrls],
  );

  const ready = !!target;
  const pct =
    progress.total > 0
      ? Math.round(((progress.done + (progress.currentFraction ?? 0)) / progress.total) * 100)
      : 0;

  const toggle = () => {
    void tap("medium");
    void setSyncSettings({ paused: !settings.paused });
  };

  return (
    <div className="min-h-full pb-32">
      <header className="hero-glow safe-top px-5 pb-4 pt-5">
        <div className="flex items-end justify-between gap-3">
          <div className="min-w-0">
            <h1 className="headline text-[52px] leading-none tabular-nums">{assets.length}</h1>
            <p className="mt-1 text-sm font-semibold text-muted-foreground">
              {progress.running
                ? `يرفع ${progress.done + 1} من ${progress.total}`
                : assets.length === 0
                  ? "كل شيء محفوظ ✨"
                  : assets.length === 1
                    ? "عنصر بانتظار الرفع"
                    : "عنصر بانتظار الرفع"}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <UploadFab compact />
            <button
              onClick={() => { void tap("medium"); void runSyncCycle(); }}
              disabled={!ready || progress.running || assets.length === 0}
              className="press flex items-center gap-2 rounded-full bg-hot px-5 py-3 text-sm font-black text-primary-foreground shadow-[var(--shadow-fab)] disabled:opacity-40 disabled:shadow-none"
            >
              {progress.running ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <CloudUpload className="h-4 w-4" />
              )}
              ارفع
            </button>
          </div>
        </div>

        {progress.running && (
          <div className="mt-4">
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-secondary">
              <div
                className="h-full rounded-full bg-hot transition-[width] duration-300 ease-out"
                style={{ width: `${pct}%` }}
              />
            </div>
            <p className="mt-1.5 truncate text-[11px] text-muted-foreground">
              {progress.currentName}
            </p>
          </div>
        )}
      </header>

      {!ready && (
        <div className="mx-4 mb-3 rounded-2xl border border-primary/40 bg-primary/10 p-4 text-sm font-semibold">
          اربط حسابك واختر قناة الحفظ من «ضبط» لتبدأ المزامنة.
        </div>
      )}

      <div className="mx-4 mb-3 flex items-center justify-between gap-3 rounded-2xl border border-border bg-card p-3">
        <div className="min-w-0 text-xs">
          <div className="flex items-center gap-1.5 font-black">
            {!settings.paused && settings.mode === "auto" && (
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-hot opacity-70" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-hot" />
              </span>
            )}
            {settings.paused
              ? "المزامنة متوقفة"
              : settings.mode === "auto"
                ? "المزامنة تعمل تلقائياً"
                : "مزامنة يدوية"}
          </div>
          <div className="truncate text-muted-foreground">
            {settings.wifiOnly ? "واي-فاي فقط" : "أي شبكة"}
            {target ? ` · ${target.title}` : ""}
          </div>
        </div>
        <button onClick={toggle} className="press flex shrink-0 items-center gap-1.5 rounded-full bg-secondary px-4 py-2 text-xs font-black">
          {settings.paused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
          {settings.paused ? "تشغيل" : "إيقاف"}
        </button>
      </div>

      <div className="px-2">
        <PhotoGrid
          photos={photos}
          onOpen={(i) => runViewTransition(() => setLightbox(i))}
          density={density}
          activeId={lightbox != null ? photos[lightbox]?.id : null}
          emptyContent={
            <EmptyState
              icon={CheckCircle2}
              title="كل صورك محفوظة"
              body="أي صورة جديدة تلتقطها سترفع تلقائياً — حتى لو كان التطبيق مغلقاً."
            />
          }
        />
      </div>

      {lightbox != null && (
        <Lightbox
          photos={photos}
          index={lightbox}
          onIndexChange={setLightbox}
          onClose={() => setLightbox(null)}
        />
      )}
    </div>
  );
}
