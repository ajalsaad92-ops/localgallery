import { useRef, useState } from "react";
import { Images, Loader2 } from "lucide-react";
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

  const Icon = busy ? Loader2 : Images;

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

      <button
        disabled={busy}
        onClick={trigger}
        aria-label="تحديث المعرض"
        className={
          compact
            ? "press grid h-[46px] w-[46px] place-items-center rounded-full bg-secondary text-foreground disabled:opacity-60"
            : "press fixed bottom-24 left-4 z-40 grid h-14 w-14 place-items-center rounded-full bg-primary text-primary-foreground shadow-fab disabled:opacity-60"
        }
      >
        <Icon className={busy ? "h-5 w-5 animate-spin" : "h-5 w-5"} />
      </button>
    </>
  );
}
