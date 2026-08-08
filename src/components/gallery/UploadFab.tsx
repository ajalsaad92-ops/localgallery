import { useRef, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import {
  canScanDeviceGallery,
  scanDeviceGallery,
  importWebFiles,
} from "@/lib/deviceMedia";
import { buzz, tap } from "@/lib/native";

interface Props {
  compact?: boolean;
}

export function UploadFab({ compact }: Props) {
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const rescan = async () => {
    void tap("medium");
    setBusy(true);
    try {
      // An explicit tap means "look again", so ignore the incremental
      // watermark and re-walk the whole library.
      const n = await scanDeviceGallery(undefined, true);
      if (n === 0) toast.info("لا توجد صور جديدة");
      else {
        void buzz("success");
        toast.success(`أُضيفت ${n} صورة`);
      }
    } catch (e) {
      void buzz("error");
      toast.error("فشل الاستيراد: " + (e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(false);
    }
  };

  const onWebFiles = async (list: FileList | null) => {
    if (!list?.length) return;
    setBusy(true);
    try {
      const n = await importWebFiles(Array.from(list));
      toast.success(`أُضيف ${n} عنصر`);
    } catch (e) {
      toast.error("فشل الاستيراد: " + (e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(false);
    }
  };

  const trigger = () => {
    if (canScanDeviceGallery()) void rescan();
    else fileInput.current?.click();
  };

  const Icon = busy ? Loader2 : RefreshCw;

  return (
    <>
      <input
        ref={fileInput}
        type="file"
        multiple
        accept="image/*,video/*"
        className="hidden"
        onChange={(e) => onWebFiles(e.currentTarget.files)}
      />

      {/*
        A bare photo-stack icon read as "open the studio" and nobody could tell
        what it did. It rescans the phone for new photos, so it says so.
      */}
      <button
        disabled={busy}
        onClick={trigger}
        aria-label="بحث عن صور جديدة في الهاتف"
        title="بحث عن صور جديدة في الهاتف"
        className={
          compact
            ? "press flex h-[38px] items-center gap-1.5 rounded-full bg-secondary px-3 text-[12px] font-bold text-foreground disabled:opacity-60"
            : "press fixed bottom-24 left-4 z-40 flex h-12 items-center gap-2 rounded-full bg-primary px-4 text-sm font-bold text-primary-foreground shadow-fab disabled:opacity-60"
        }
      >
        <Icon className={busy ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
        {busy ? "يبحث…" : "تحديث"}
      </button>
    </>
  );
}
