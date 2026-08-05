import { Sparkles } from "lucide-react";
import type { MediaAsset } from "@/lib/photoDb";
import { Thumb } from "./Thumb";
import { tap } from "@/lib/native";

/** "On this day" strip — the same calendar day in earlier years. */
export function Memories({
  assets, onOpen,
}: {
  assets: MediaAsset[];
  onOpen: (id: string) => void;
}) {
  if (assets.length === 0) return null;
  const years = new Set(assets.map((a) => new Date(a.date).getFullYear()));

  return (
    <section className="mb-3">
      <div className="mb-1.5 flex items-center gap-1.5 px-4">
        <Sparkles className="h-3.5 w-3.5 text-hot" />
        <span className="text-[11px] font-black">في مثل هذا اليوم</span>
        <span className="text-[10px] font-semibold text-muted-foreground">
          {[...years].sort((a, b) => b - a).join(" · ")}
        </span>
      </div>
      <div dir="rtl" className="flex gap-2 overflow-x-auto px-4" style={{ scrollbarWidth: "none" }}>
        {assets.slice(0, 24).map((a) => (
          <button
            key={a.id}
            onClick={() => { void tap("light"); onOpen(a.id); }}
            aria-label={a.name}
            className="press relative h-24 w-20 shrink-0 overflow-hidden rounded-xl bg-secondary"
          >
            <Thumb
              photo={{
                id: a.id,
                width: a.width ?? 100,
                height: a.height ?? 100,
                date: new Date(a.date),
                name: a.name,
                kind: a.kind === "video" ? "video" : "image",
                localUri: a.localUri,
                thumbSrc: a.localUri,
                provider: a.provider,
              }}
            />
            <span className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent px-1.5 pb-1 pt-3 text-[9px] font-black text-white">
              {new Date(a.date).getFullYear()}
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}
