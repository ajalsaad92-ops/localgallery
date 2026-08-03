import { useCallback, useEffect, useMemo, useState } from "react";
import { CloudOff, Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { useMediaAssets } from "@/hooks/useMediaAssets";
import {
  importChannelHistory,
  hydrateThumbnails,
  resolveRemoteUrl,
} from "@/hooks/useTelegramFeed";
import { getSavedTarget, getClient, type MtTarget } from "@/lib/providers/mtproto";
import { PhotoGrid } from "./PhotoGrid";
import { Lightbox } from "./Lightbox";
import { EmptyState } from "./EmptyState";
import { useGridDensity } from "@/hooks/useGridDensity";
import { runViewTransition } from "@/lib/viewTransition";
import { tap } from "@/lib/native";
import type { GalleryItem } from "@/lib/galleryItem";

export function TelegramScreen() {
  const assets = useMediaAssets({ kind: "telegram-remote" });
  const { density } = useGridDensity();

  const [target, setTarget] = useState<MtTarget | null>(null);
  const [ready, setReady] = useState(false);
  const [fullUrls, setFullUrls] = useState<Map<string, string>>(new Map());
  const [lightbox, setLightbox] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [autoRan, setAutoRan] = useState(false);
  const [thumbs, setThumbs] = useState<{ done: number; total: number } | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const t = await getSavedTarget();
      const c = await getClient().catch(() => null);
      if (!alive) return;
      setTarget(t);
      setReady(!!t && !!c);
    })();
    return () => { alive = false; };
  }, []);

  const photos = useMemo<GalleryItem[]>(
    () =>
      assets.map((a) => {
        const poster = a.posterDataUrl;
        const full = fullUrls.get(a.id);
        const isVideo = a.kind === "video";
        const heic = /image\/(heic|heif)/i.test(a.mime) || /\.(heic|heif)$/i.test(a.name);
        // HEIC and video have no directly renderable bytes in the grid — show
        // the JPEG preview Telegram already stores.
        return {
          id: a.id,
          width: a.width ?? 400,
          height: a.height ?? 400,
          date: new Date(a.date),
          name: a.name,
          thumbSrc: heic || isVideo ? poster : (poster ?? full),
          fullSrc: full,
          posterSrc: poster,
          kind: isVideo ? "video" : "image",
          duration: a.duration,
          mime: a.mime,
          provider: a.provider,
        };
      }),
    [assets, fullUrls],
  );

  const runImport = useCallback(async (announce: boolean) => {
    setBusy(true);
    try {
      const n = await importChannelHistory(0);
      if (announce) toast.success(`قرأت ${n} عنصراً`);
      setBusy(false);
      setThumbs({ done: 0, total: 0 });
      await hydrateThumbnails((done, total) => setThumbs({ done, total }));
    } catch (e) {
      if (announce) toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      setThumbs(null);
    }
  }, []);

  // Read the channel as soon as the account and target are ready.
  useEffect(() => {
    if (!ready || autoRan) return;
    setAutoRan(true);
    void runImport(false);
  }, [ready, autoRan, runImport]);

  /** Remote bytes are fetched on demand, only when an item is opened. */
  const openAt = async (i: number) => {
    void tap("light");
    const a = assets[i];
    if (a && !fullUrls.has(a.id) && a.remoteMessageId != null) {
      const id = a.kind === "video" ? toast.loading("جارٍ التحميل…") : undefined;
      try {
        const url = await resolveRemoteUrl(a, (received, total) => {
          if (!id || !total) return;
          toast.loading(`جارٍ التحميل… ${Math.round((received / total) * 100)}%`, { id });
        });
        if (url) setFullUrls((m) => new Map(m).set(a.id, url));
        if (id) toast.dismiss(id);
      } catch {
        if (id) toast.error("تعذّر تحميل الملف", { id });
      }
    }
    runViewTransition(() => setLightbox(i));
  };

  return (
    <div className="min-h-full pb-32">
      <header className="hero-glow safe-top px-5 pb-4 pt-5">
        <div className="flex items-end justify-between gap-3">
          <div className="min-w-0">
            <h1 className="headline text-[52px] leading-none tabular-nums">{assets.length}</h1>
            <p className="mt-1 truncate text-sm font-semibold text-muted-foreground">
              {thumbs
                ? `يحمّل المعاينات ${thumbs.done}/${thumbs.total}`
                : busy
                  ? "يقرأ المحفوظات…"
                  : (target?.title ?? "لم تُختر قناة بعد")}
            </p>
          </div>
          <button
            onClick={() => { void tap("medium"); void runImport(true); }}
            disabled={!ready || busy}
            className="press flex shrink-0 items-center gap-2 rounded-full bg-hot px-5 py-3 text-sm font-black text-primary-foreground shadow-[var(--shadow-fab)] disabled:opacity-40 disabled:shadow-none"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            تحديث
          </button>
        </div>
      </header>

      {!ready && (
        <div className="mx-4 mb-3 rounded-2xl border border-primary/40 bg-primary/10 p-4 text-sm font-semibold">
          اربط حسابك واختر قناة الحفظ من «ضبط» لعرض صور القناة.
        </div>
      )}

      <div className="px-2">
        <PhotoGrid
          photos={photos}
          onOpen={(i) => void openAt(i)}
          density={density}
          activeId={lightbox != null ? photos[lightbox]?.id : null}
          emptyContent={
            ready ? (
              <EmptyState
                icon={CloudOff}
                title="القناة فارغة"
                body="ارفع صورك من تبويب «مزامنة» وستظهر هنا مباشرة."
              />
            ) : null
          }
        />
      </div>

      {lightbox != null && (
        <Lightbox
          photos={photos}
          index={lightbox}
          onIndexChange={setLightbox}
          onClose={() => setLightbox(null)}
          showDownload
        />
      )}
    </div>
  );
}
