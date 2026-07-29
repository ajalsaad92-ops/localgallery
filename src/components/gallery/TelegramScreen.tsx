import { useEffect, useMemo, useState } from "react";
import { Loader2, RefreshCw, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { useMediaAssets } from "@/hooks/useMediaAssets";
import { useProviders } from "@/hooks/useProviders";
import {
  useTelegramFeed,
  useRemoteAssetUrls,
  importChannelHistory,
  hydrateThumbnails,
  resolveRemoteUrl,
} from "@/hooks/useTelegramFeed";

import { getSavedTarget, getClient, type MtTarget } from "@/lib/providers/mtproto";
import { photoDb } from "@/lib/photoDb";
import { PhotoGrid } from "./PhotoGrid";
import { Lightbox } from "./Lightbox";
import { useGridDensity } from "@/hooks/useGridDensity";
import { runViewTransition } from "@/lib/viewTransition";
import type { MockPhoto } from "@/lib/mockPhotos";

export function TelegramScreen() {
  const { providers } = useProviders();
  const tg = providers.get("telegram");
  const botReady = !!tg?.configured && !!tg.botToken;
  const [target, setTarget] = useState<MtTarget | null>(null);
  const [accountReady, setAccountReady] = useState(false);
  const [extraFull, setExtraFull] = useState<Map<string, string>>(new Map());
  const ready = botReady || accountReady;

  useEffect(() => {
    let alive = true;
    (async () => {
      const t = await getSavedTarget();
      const c = await getClient();
      if (!alive) return;
      setTarget(t);
      setAccountReady(!!t && !!c);
    })();
    return () => { alive = false; };
  }, []);
  const [pollTick, setPollTick] = useState(0);
  const { lastError, lastPolledAt } = useTelegramFeed(botReady, 15000, pollTick);
  const assets = useMediaAssets({ kind: "telegram-remote" });
  const urls = useRemoteAssetUrls(assets);
  const { density } = useGridDensity();
  const [lightbox, setLightbox] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [autoRan, setAutoRan] = useState(false);
  const [thumbing, setThumbing] = useState(false);
  const [thumbProgress, setThumbProgress] = useState({ done: 0, total: 0 });


  const photos = useMemo<MockPhoto[]>(() => assets.map((a) => {
    const full = urls.full.get(a.id) ?? extraFull.get(a.id);
    const thumb = urls.thumb.get(a.id) ?? a.posterDataUrl;
    const heic = /image\/(heic|heif)/i.test(a.mime) || /\.(heic|heif)$/i.test(a.name);
    const isVideo = a.kind === "video";
    // HEIC/video have no directly renderable bytes in the grid — show the
    // JPEG preview Telegram already stores. The lightbox decodes the original.
    const displayThumb = (heic || isVideo) ? (thumb ?? a.posterDataUrl) : (thumb ?? full);
    return {
      id: a.id, seed: a.id,
      width: a.width ?? 400, height: a.height ?? 400,
      date: new Date(a.date), name: a.name,
      thumbSrc: displayThumb ?? full,
      fullSrc: full,
      posterSrc: thumb ?? a.posterDataUrl,
      kind: isVideo ? "video" : "image",
      duration: a.duration, mime: a.mime, provider: a.provider,
    };
  }), [assets, urls, extraFull]);


  useEffect(() => {
    if (!busy) return;
    const t = setTimeout(() => setBusy(false), 2500);
    return () => clearTimeout(t);
  }, [busy]);

  const runImport = async (announce: boolean) => {
    setBusy(true);
    try {
      const n = await importChannelHistory(0);
      if (announce) toast.success(`تمت قراءة ${n} عنصراً من ${target?.title ?? "القناة"}`);
      setBusy(false);
      // Previews stream in after the metadata so the grid is never empty.
      setThumbing(true);
      await hydrateThumbnails((done, total) => setThumbProgress({ done, total }));
      setThumbing(false);
    } catch (e) {
      setBusy(false);
      setThumbing(false);
      if (announce) toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  // Auto-read the channel as soon as the account + target are ready.
  useEffect(() => {
    if (!accountReady || autoRan) return;
    setAutoRan(true);
    void runImport(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountReady, autoRan]);

  const refresh = async () => {
    setPollTick((t) => t + 1);
    if (accountReady) await runImport(true);
  };


  /** MTProto items stream on demand — fetch the full file when opening it. */
  const openAt = async (i: number) => {
    const a = assets[i];
    if (a && !a.remoteFileId && a.remoteMessageId && !extraFull.has(a.id)) {
      try {
        const url = await resolveRemoteUrl(a);
        if (url) setExtraFull((m) => new Map(m).set(a.id, url));
      } catch { /* keep the thumbnail */ }
    }
    runViewTransition(() => setLightbox(i));
  };

  const resync = async () => {
    setBusy(true);
    // Reset the stored update offset so the next poll asks Telegram for the
    // full window it still remembers (~24h). Historical messages from before
    // the bot was added are NOT retrievable — that's a Telegram Bot API limit.
    await photoDb.kv.delete("tg:updates:offset");
    setPollTick((t) => t + 1);
    toast.info("سيقوم البوت بجلب كل ما يتذكره تليكرام (آخر 24 ساعة).");
  };

  return (
    <div className="min-h-full pb-32">
      <header className="hero-glow safe-top px-5 pb-5 pt-4">
        <p className="text-[11px] font-black uppercase tracking-[0.25em] text-primary">CHANNEL FEED</p>
        <div className="mt-2 flex items-end justify-between gap-3">
          <div className="min-w-0">
            <h1 className="headline text-[44px] tabular-nums">{assets.length}</h1>
            <p className="text-sm font-semibold text-muted-foreground">
              {lastPolledAt ? "من قناة تليكرام · محدَّث" : "بانتظار الرسائل"}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={resync}
              disabled={!ready || busy}
              className="grid h-11 w-11 place-items-center rounded-full bg-secondary disabled:opacity-40"
              title="إعادة الفهرسة"
            >
              <RotateCcw className="h-4 w-4" />
            </button>
            <button
              onClick={refresh}
              disabled={!ready || busy}
              className="flex items-center gap-2 rounded-full bg-hot px-5 py-3 text-sm font-black text-primary-foreground shadow-[var(--shadow-fab)] transition active:scale-95 disabled:opacity-40 disabled:shadow-none"
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              تحديث
            </button>
          </div>
        </div>
      </header>

      {!ready && (
        <div className="mx-4 mb-3 rounded-2xl border border-primary/40 bg-primary/10 p-4 text-sm font-semibold">
          اربط حسابك الشخصي واختر قناة الحفظ من «ضبط» لعرض كل صور القناة (بدون بوت).
        </div>
      )}
      {lastError && (
        <div className="mx-4 mb-3 rounded-2xl border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive-foreground">
          خطأ من تليكرام: {lastError}
        </div>
      )}

      {accountReady && (
        <div className="mx-4 mb-3 rounded-2xl border border-border bg-card px-4 py-3 text-xs font-semibold">
          القناة الحالية: <span className="text-primary">{target?.title}</span>
          {thumbing
            ? ` · جارٍ تحميل المعاينات ${thumbProgress.done}/${thumbProgress.total}`
            : busy
              ? " · جارٍ قراءة المحفوظات…"
              : " · اضغط «تحديث» لإعادة القراءة."}
        </div>

      )}

      {botReady && !accountReady && assets.length === 0 && (
        <div className="mx-4 mt-4 rounded-xl border border-border bg-card p-4 text-xs leading-relaxed text-muted-foreground">
          <p className="mb-2 font-semibold text-foreground">لماذا لا أرى صوري القديمة؟</p>
          <p className="mb-2">
            هذا قيد من تليكرام نفسه: البوت لا يستطيع قراءة الرسائل التي أُرسلت قبل إضافته،
            ولا يوجد أي API يمكّن البوت من تصفح محفوظات المجموعة/القناة.
          </p>
          <p className="mb-2 font-semibold text-foreground">الحل الوحيد لاستيراد القديم:</p>
          <ol className="list-decimal space-y-1 pr-4">
            <li>افتح المجموعة/القناة في تليكرام.</li>
            <li>اضغط على كل صورة/فيديو قديم → مشاركة → أرسل للبوت مباشرة.</li>
            <li>ستظهر الصورة هنا خلال ثوانٍ.</li>
          </ol>
          <p className="mt-3">
            كل الصور الجديدة التي ترفعها من هذا التطبيق أو ترسلها للبوت ستظهر تلقائياً.
          </p>
        </div>
      )}

      <div className="px-2 py-3">
        <PhotoGrid
          photos={photos}
          onOpen={(i) => void openAt(i)}
          density={density}
          activeId={lightbox != null ? photos[lightbox]?.id : null}
          emptyContent={null}
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
