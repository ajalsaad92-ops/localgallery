import { Download, X } from "lucide-react";
import { tap } from "@/lib/native";

/** Offers a newer build. Never installs on its own — the choice stays yours. */
export function UpdateBanner({
  version, onInstall, onLater,
}: {
  version: string;
  onInstall: () => void;
  onLater: () => void;
}) {
  return (
    <div className="mx-4 mb-2 flex items-center gap-2 rounded-2xl border border-primary/40 bg-primary/10 px-3 py-2">
      <Download className="h-4 w-4 shrink-0 text-primary" />
      <span className="min-w-0 flex-1 truncate text-[11px] font-bold">
        تحديث جديد متاح {version}
      </span>
      <button
        onClick={() => { void tap("medium"); onInstall(); }}
        className="press shrink-0 rounded-full bg-primary px-3 py-1.5 text-[11px] font-black text-primary-foreground"
      >
        تثبيت
      </button>
      <button
        onClick={() => { void tap("light"); onLater(); }}
        aria-label="لاحقاً"
        className="press grid h-7 w-7 shrink-0 place-items-center rounded-full text-muted-foreground"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
