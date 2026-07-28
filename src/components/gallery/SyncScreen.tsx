import { useEffect, useMemo, useState } from "react";
import { Loader2, Pause, Play, Zap } from "lucide-react";
import { useMediaAssets } from "@/hooks/useMediaAssets";
import { useProviders } from "@/hooks/useProviders";
import { useSyncProgress, useSyncSettings } from "@/hooks/useSyncEngine";
import { runSyncCycle, setSyncSettings } from "@/lib/syncEngine";
import { PhotoGrid } from "./PhotoGrid";
import { Lightbox } from "./Lightbox";
import { UploadFab } from "./UploadFab";
import { EmptyState } from "./EmptyState";
import { useGridDensity } from "@/hooks/useGridDensity";
import { runViewTransition } from "@/lib/viewTransition";
import type { MockPhoto } from "@/lib/mockPhotos";

export function SyncScreen() {
  const assets = useMediaAssets({ kind: "unsynced-device" });
  const { providers } = useProviders();
  const tg = providers.get("telegram");
  const progress = useSyncProgress();
  const settings = useSyncSettings();
  const { density } = useGridDensity();
  const [lightbox, setLightbox] = useState<number | null>(null);
  const [urls, setUrls] = useState<Map<string, string>>(new Map());

  useEffect(() => {
    const next = new Map<string, string>();
    for (const a of assets) {
      if (a.blob) next.set(a.id, URL.createObjectURL(a.blob));
    }
    setUrls(next);
    return () => next.forEach((u) => URL.revokeObjectURL(u));
  }, [assets]);

  const photos = useMemo<MockPhoto[]>(() => assets.map((a) => {
    const url = urls.get(a.id) ?? a.localUri;
    return {
      id: a.id, seed: a.id,
      width: a.width ?? 400, height: a.height ?? 400,
      date: new Date(a.date), name: a.name,
      thumbSrc: (a.kind === "video" ? a.posterDataUrl : url) ?? url,
      fullSrc: url,
      kind: a.kind === "video" ? "video" : "image",
      duration: a.duration, mime: a.mime, provider: a.provider,
    };
  }), [assets, urls]);

  const tgReady = !!tg?.configured && !!tg.botToken && !!tg.chatId;
  const pct = progress.total > 0
    ? Math.round(((progress.done + progress.failed) / progress.total) * 100)
    : 0;

  return (
    <div className="min-h-full pb-32">
      <header className="hero-glow safe-top px-5 pb-5 pt-4">
        <p className="text-[11px] font-black uppercase tracking-[0.25em] text-primary">TELEGALLERY</p>
        <div className="mt-2 flex items-end justify-between gap-3">
          <div className="min-w-0">
            <h1 className="headline text-[44px] tabular-nums">
              {assets.length}
            </h1>
            <p className="text-sm font-semibold text-muted-foreground">
              {progress.running
                ? `جارٍ الرفع ${progress.done}/${progress.total}`
                : assets.length === 0 ? "كل شيء مزامَن" : "عنصر بانتظار الرفع"}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <UploadFab compact />
            <button
              onClick={() => runSyncCycle()}
              disabled={!tgReady || progress.running || assets.length === 0}
              className="flex items-center gap-2 rounded-full bg-hot px-5 py-3 text-sm font-black text-primary-foreground shadow-[var(--shadow-fab)] transition active:scale-95 disabled:opacity-40 disabled:shadow-none"
            >
              {progress.running
                ? <Loader2 className="h-4 w-4 animate-spin" />
                : <Zap className="h-4 w-4 fill-current" />}
              ارفع الآن
            </button>
          </div>
        </div>

        {progress.running && (
          <div className="mt-4">
            <div className="h-2 w-full overflow-hidden rounded-full bg-secondary">
              <div className="h-full bg-hot transition-all duration-300" style={{ width: `${pct}%` }} />
            </div>
            <p className="mt-1.5 truncate text-[11px] text-muted-foreground">
              {progress.currentName}
            </p>
          </div>
        )}
      </header>

      {!tgReady && (
        <div className="mx-4 mb-3 rounded-2xl border border-primary/40 bg-primary/10 p-4 text-sm font-semibold text-foreground">
          اربط بوت تليكرام والقناة من تبويب «ضبط» لتبدأ المزامنة.
        </div>
      )}

      <div className="mx-4 mb-3 flex items-center justify-between gap-3 rounded-2xl border border-border bg-card p-3">
        <div className="text-xs">
          <div className="font-black">
            {settings.paused ? "المزامنة متوقفة" : settings.mode === "auto" ? "مزامنة تلقائية" : "مزامنة يدوية"}
          </div>
          <div className="text-muted-foreground">
            {settings.wifiOnly ? "واي-فاي فقط" : "أي شبكة"} · حجم غير محدود
          </div>
        </div>
        <button
          onClick={() => setSyncSettings({ paused: !settings.paused })}
          className="flex items-center gap-1.5 rounded-full bg-secondary px-4 py-2 text-xs font-black"
        >
          {settings.paused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
          {settings.paused ? "استئناف" : "إيقاف مؤقت"}
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
              title="لا شيء بانتظار المزامنة"
              body="استورد من معرض هاتفك ثم ارفع — كل عنصر يُرفع يختفي من هنا ويظهر في تبويب «عرض»."
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
