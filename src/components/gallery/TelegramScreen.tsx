import { useEffect, useMemo, useState } from "react";
import { Loader2, RefreshCw, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { useMediaAssets } from "@/hooks/useMediaAssets";
import { useProviders } from "@/hooks/useProviders";
import { useTelegramFeed, useRemoteAssetUrls } from "@/hooks/useTelegramFeed";
import { photoDb } from "@/lib/photoDb";
import { PhotoGrid } from "./PhotoGrid";
import { Lightbox } from "./Lightbox";
import { useGridDensity } from "@/hooks/useGridDensity";
import { runViewTransition } from "@/lib/viewTransition";
import type { MockPhoto } from "@/lib/mockPhotos";

export function TelegramScreen() {
  const { providers } = useProviders();
  const tg = providers.get("telegram");
  const ready = !!tg?.configured && !!tg.botToken;
  const [pollTick, setPollTick] = useState(0);
  const { lastError, lastPolledAt } = useTelegramFeed(ready, 15000, pollTick);
  const assets = useMediaAssets({ kind: "telegram-remote" });
  const urls = useRemoteAssetUrls(assets);
  const { density } = useGridDensity();
  const [lightbox, setLightbox] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  const photos = useMemo<MockPhoto[]>(() => assets.map((a) => {
    const full = urls.full.get(a.id);
    const thumb = urls.thumb.get(a.id);
    const isHeic = /image\/(heic|heif)/i.test(a.mime);
    const isVideo = a.kind === "video";
    // HEIC can't render in <img>. Videos have no image bytes.
    // Use the JPEG thumbnail Telegram already sends for both.
    const displayThumb = (isHeic || isVideo) ? (thumb ?? a.posterDataUrl) : (thumb ?? full);
    const displayFull = isHeic ? (thumb ?? full) : full;
    return {
      id: a.id, seed: a.id,
      width: a.width ?? 400, height: a.height ?? 400,
      date: new Date(a.date), name: a.name,
      thumbSrc: displayThumb ?? full,
      fullSrc: isVideo ? full : displayFull,
      posterSrc: thumb,
      kind: isVideo ? "video" : "image",
      duration: a.duration, mime: a.mime, provider: a.provider,
    };
  }), [assets, urls]);

  useEffect(() => {
    if (!busy) return;
    const t = setTimeout(() => setBusy(false), 2500);
    return () => clearTimeout(t);
  }, [busy]);

  const refresh = () => { setBusy(true); setPollTick((t) => t + 1); };

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
          أضف بوت تليكرام من «ضبط» لعرض صور القناة.
        </div>
      )}
      {lastError && (
        <div className="mx-4 mb-3 rounded-2xl border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive-foreground">
          خطأ من تليكرام: {lastError}
        </div>
      )}

      {ready && assets.length === 0 && (
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
          onOpen={(i) => runViewTransition(() => setLightbox(i))}
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
