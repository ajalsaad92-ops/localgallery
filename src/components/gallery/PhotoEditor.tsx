import { useEffect, useRef, useState } from "react";
import {
  Check, Contrast, Crop, RotateCcw, RotateCw, Sun, X,
} from "lucide-react";
import { toast } from "sonner";
import type { GalleryItem } from "@/lib/galleryItem";
import { saveBlobToDevice, tap, buzz, isNative } from "@/lib/native";
import { cn } from "@/lib/utils";

type Ratio = "free" | "1:1" | "4:3" | "16:9";

const RATIOS: { id: Ratio; label: string; value: number | null }[] = [
  { id: "free", label: "حر", value: null },
  { id: "1:1", label: "مربّع", value: 1 },
  { id: "4:3", label: "٤:٣", value: 4 / 3 },
  { id: "16:9", label: "١٦:٩", value: 16 / 9 },
];

/**
 * On-device edits: rotate, crop to a ratio, brightness and contrast.
 *
 * The original is never touched — the result is written as a new file, so an
 * edit can never lose the photo it came from.
 */
export function PhotoEditor({
  photo, onClose,
}: {
  photo: GalleryItem;
  onClose: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [ready, setReady] = useState(false);
  const [rotation, setRotation] = useState(0);
  const [ratio, setRatio] = useState<Ratio>("free");
  const [brightness, setBrightness] = useState(100);
  const [contrast, setContrast] = useState(100);
  const [saving, setSaving] = useState(false);

  const src = photo.fullSrc ?? photo.localUri;

  useEffect(() => {
    if (!src) return;
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => { imgRef.current = img; setReady(true); };
    img.onerror = () => toast.error("تعذّر فتح الصورة للتعديل");
    img.src = src;
    return () => { img.onload = null; img.onerror = null; };
  }, [src]);

  /** Draws the current settings; also used to produce the saved file. */
  const draw = (canvas: HTMLCanvasElement) => {
    const img = imgRef.current;
    if (!img) return;

    const turned = rotation % 180 !== 0;
    const srcW = turned ? img.naturalHeight : img.naturalWidth;
    const srcH = turned ? img.naturalWidth : img.naturalHeight;

    const target = RATIOS.find((r) => r.id === ratio)?.value ?? null;
    let outW = srcW;
    let outH = srcH;
    if (target) {
      if (srcW / srcH > target) outW = Math.round(srcH * target);
      else outH = Math.round(srcW / target);
    }

    canvas.width = outW;
    canvas.height = outH;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.filter = `brightness(${brightness}%) contrast(${contrast}%)`;
    ctx.translate(outW / 2, outH / 2);
    ctx.rotate((rotation * Math.PI) / 180);
    ctx.drawImage(img, -img.naturalWidth / 2, -img.naturalHeight / 2);
  };

  useEffect(() => {
    const c = canvasRef.current;
    if (ready && c) draw(c);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, rotation, ratio, brightness, contrast]);

  const save = async () => {
    const img = imgRef.current;
    if (!img) return;
    setSaving(true);
    try {
      const out = document.createElement("canvas");
      draw(out);
      const blob = await new Promise<Blob | null>((res) =>
        out.toBlob((b) => res(b), "image/jpeg", 0.92),
      );
      if (!blob) throw new Error("encode failed");

      const base = photo.name.replace(/\.[^.]+$/, "");
      const name = `${base}-edited.jpg`;
      if (isNative()) {
        await saveBlobToDevice(name, blob);
      } else {
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url; a.download = name;
        document.body.appendChild(a); a.click(); a.remove();
        URL.revokeObjectURL(url);
      }
      void buzz("success");
      toast.success("حُفظت نسخة معدّلة — الأصل كما هو");
      onClose();
    } catch {
      toast.error("تعذّر الحفظ");
    } finally {
      setSaving(false);
    }
  };

  const dirty = rotation !== 0 || ratio !== "free" || brightness !== 100 || contrast !== 100;

  return (
    <div className="fixed inset-0 z-[70] flex flex-col bg-black safe-top safe-bottom">
      <div className="flex items-center justify-between px-3 py-2">
        <button onClick={() => { void tap("light"); onClose(); }} aria-label="إلغاء"
          className="press grid h-10 w-10 place-items-center rounded-full bg-white/10 text-white">
          <X className="h-5 w-5" />
        </button>
        <span className="text-xs font-black text-white/80">تعديل</span>
        <button
          onClick={save}
          disabled={!ready || saving || !dirty}
          aria-label="حفظ"
          className="press grid h-10 w-10 place-items-center rounded-full bg-primary text-primary-foreground disabled:opacity-35"
        >
          <Check className="h-5 w-5" />
        </button>
      </div>

      <div className="flex flex-1 items-center justify-center overflow-hidden p-3">
        {ready ? (
          <canvas ref={canvasRef} className="max-h-full max-w-full object-contain" />
        ) : (
          <span className="text-sm text-white/50">جارٍ التحميل…</span>
        )}
      </div>

      <div className="space-y-3 px-4 pb-3">
        <div className="flex items-center justify-center gap-2">
          <Tool icon={RotateCcw} label="يسار" onClick={() => { void tap("light"); setRotation((r) => (r - 90 + 360) % 360); }} />
          <Tool icon={RotateCw} label="يمين" onClick={() => { void tap("light"); setRotation((r) => (r + 90) % 360); }} />
        </div>

        <div dir="rtl" className="flex items-center justify-center gap-1.5">
          <Crop className="h-3.5 w-3.5 text-white/50" />
          {RATIOS.map((r) => (
            <button
              key={r.id}
              onClick={() => { void tap("light"); setRatio(r.id); }}
              className={cn(
                "press rounded-full px-3 py-1.5 text-[11px] font-bold",
                ratio === r.id ? "bg-white text-black" : "bg-white/10 text-white/70",
              )}
            >
              {r.label}
            </button>
          ))}
        </div>

        <Slider icon={Sun} label="الإضاءة" value={brightness} onChange={setBrightness} />
        <Slider icon={Contrast} label="التباين" value={contrast} onChange={setContrast} />
      </div>
    </div>
  );
}

function Tool({
  icon: Icon, label, onClick,
}: { icon: typeof RotateCw; label: string; onClick: () => void }) {
  return (
    <button onClick={onClick} aria-label={label}
      className="press flex flex-col items-center gap-1 rounded-xl bg-white/10 px-4 py-2 text-white">
      <Icon className="h-4 w-4" />
      <span className="text-[10px] font-bold">{label}</span>
    </button>
  );
}

function Slider({
  icon: Icon, label, value, onChange,
}: {
  icon: typeof Sun;
  label: string;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="flex items-center gap-2">
      <Icon className="h-3.5 w-3.5 shrink-0 text-white/50" />
      <span className="w-12 shrink-0 text-[10px] font-bold text-white/70">{label}</span>
      <input
        type="range" min={50} max={150} step={1} value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-1 flex-1 accent-primary"
      />
      <span className="w-8 shrink-0 text-end text-[10px] tabular-nums text-white/50">
        {value - 100 > 0 ? `+${value - 100}` : value - 100}
      </span>
    </label>
  );
}
