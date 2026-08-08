import { useCallback, useEffect, useMemo, useState } from "react";
import { CloudOff, Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { useMediaAssets } from "@/hooks/useMediaAssets";
import { useGalleryView } from "@/hooks/useGalleryView";
import {
  importChannelHistory, hydrateThumbnails, resolveRemoteUrl,
} from "@/hooks/useTelegramFeed";
import { getSavedTarget, getClient, type MtTarget } from "@/lib/providers/mtproto";
import { PhotoGrid } from "./PhotoGrid";
import { Lightbox } from "./Lightbox";
import { EmptyState } from "./EmptyState";
import { FilterBar } from "./FilterBar";
import { useGridDensity } from "@/hooks/useGridDensity";
import { runViewTransition } from "@/lib/viewTransition";
import { tap } from "@/lib/native";

/** Full-size downloads kept open at once — each one is a whole file. */
const OPEN_FILE_CACHE = 6;

/** The channel feed — what already lives on Telegram. */
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

  const urlFor = useCallback(
    (a: { id: string }) => fullUrls.get(a.id),
    [fullUrls],
  );
  const view = useGalleryView(assets, { urlFor });

  // Re-check on every mount: the channel can be changed from Settings while
  // this screen is alive, and its contents must follow.
  useEffect(() => {
    let alive = true;
    const check = async () => {
      const t = await getSavedTarget();
      const c = await getClient().catch(() => null);
      if (!alive) return;
      setTarget((prev) => {
        if (prev?.id !== t?.id) setAutoRan(false);
        return t;
      });
      setReady(!!t && !!c);
    };
    void check();
    // Every four seconds this called getClient(), which reconnects when the
    // socket is down — competing with the uploader for the same client while a
    // backup runs. The channel only changes when the user changes it, so a
    // slower poll plus a check on return to the app is plenty.
    const id = window.setInterval(() => void check(), 30_000);
    const onVisible = () => { if (document.visibilityState === "visible") void check(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive = false;
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  const runImport = useCallback(async (announce: boolean, withThumbs: boolean) => {
    setBusy(true);
    try {
      const n = await importChannelHistory(0);
      if (announce) toast.success(`قرأت ${n} عنصراً`);
      setBusy(false);
      // Downloading thousands of previews is heavy enough to get the WebView's
      // renderer killed, and it used to start on its own the moment this tab
      // was shown — which, because the app reopens on the last tab, meant it
      // started before the user could do anything. It runs on a tap now.
      if (!withThumbs) return;
      setThumbs({ done: 0, total: 0 });
      await hydrateThumbnails((done, total) => setThumbs({ done, total }));
    } catch (e) {
      if (announce) toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      setThumbs(null);
    }
  }, []);

  useEffect(() => {
    if (!ready || autoRan) return;
    setAutoRan(true);
    void runImport(false, false);
  }, [ready, autoRan, runImport]);

  /** Remote bytes are streamed on demand, only when an item is opened. */
  const openAt = async (i: number) => {
    void tap("light");
    const asset = view.assets[i];
    if (asset && !fullUrls.has(asset.id) && asset.remoteMessageId != null) {
      const id = asset.kind === "video" ? toast.loading("جارٍ التحميل…") : undefined;
      try {
        const url = await resolveRemoteUrl(asset, (received, total) => {
          if (!id || !total) return;
          toast.loading(`جارٍ التحميل… ${Math.round((received / total) * 100)}%`, { id });
        });
        if (url) {
          setFullUrls((m) => {
            const next = new Map(m).set(asset.id, url);
            // Each entry pins a whole downloaded file in the WebView's blob
            // store. Browsing a channel used to pin every photo opened, for as
            // long as the app lived; keep a handful and release the rest.
            while (next.size > OPEN_FILE_CACHE) {
              const oldest = next.keys().next().value;
              if (oldest === undefined) break;
              const stale = next.get(oldest);
              if (stale) URL.revokeObjectURL(stale);
              next.delete(oldest);
            }
            return next;
          });
        }
        if (id) toast.dismiss(id);
      } catch {
        if (id) toast.error("تعذّر تحميل الملف", { id });
      }
    }
    runViewTransition(() => setLightbox(i));
  };

  const subtitle = useMemo(() => {
    if (thumbs) return `يحمّل المعاينات ${thumbs.done}/${thumbs.total}`;
    if (busy) return "يقرأ المحفوظات…";
    return target?.title ?? "لم تُختر قناة بعد";
  }, [thumbs, busy, target]);

  return (
    <div className="min-h-full pb-32">
      <header className="hero-glow safe-top px-5 pb-3 pt-5">
        <div className="flex items-end justify-between gap-3">
          <div className="min-w-0">
            <h1 className="headline text-[46px] leading-none tabular-nums">{view.items.length}</h1>
            <p className="mt-0.5 truncate text-sm font-semibold text-muted-foreground">{subtitle}</p>
          </div>
          <button
            onClick={() => { void tap("medium"); void runImport(true, true); }}
            disabled={!ready || busy}
            className="press flex shrink-0 items-center gap-2 rounded-full bg-hot px-5 py-3 text-sm font-black text-primary-foreground shadow-[var(--shadow-fab)] disabled:opacity-40 disabled:shadow-none"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            تحديث
          </button>
        </div>
      </header>

      {!ready && (
        <div className="mx-4 mb-2 rounded-2xl border border-primary/40 bg-primary/10 p-3 text-[12px] font-semibold">
          اربط حسابك واختر قناة الحفظ من «ضبط» لعرض صور القناة.
        </div>
      )}

      <FilterBar
        filter={view.filter}
        onFilter={view.setFilter}
        sort={view.sort}
        onSort={view.setSort}
        counts={view.counts}
        hide={["pending", "duplicates"]}
      />

      <div className="px-2">
        <PhotoGrid
          photos={view.items}
          onOpen={(i) => void openAt(i)}
          density={density}
          activeId={lightbox != null ? view.items[lightbox]?.id : null}
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
          photos={view.items}
          index={lightbox}
          onIndexChange={setLightbox}
          onClose={() => setLightbox(null)}
          showDownload
        />
      )}
    </div>
  );
}
