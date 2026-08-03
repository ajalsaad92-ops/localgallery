import { useState } from "react";
import { CloudUpload, Loader2, Share2, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { photoDb } from "@/lib/photoDb";
import { deleteGalleryItems, shareGalleryItems, tap, buzz } from "@/lib/native";
import { runSyncCycle } from "@/lib/syncEngine";
import { markPendingDeletes } from "@/lib/pendingDeletes";

interface Props {
  ids: string[];
  onClear: () => void;
  onSelectAll: () => void;
  total: number;
  /** Device items can be shared/deleted natively; remote ones cannot. */
  deviceOnly: boolean;
}

/** Action bar shown while items are selected, replacing the tab bar. */
export function SelectionBar({ ids, onClear, onSelectAll, total, deviceOnly }: Props) {
  const [busy, setBusy] = useState(false);

  const share = async () => {
    void tap("medium");
    if (!deviceOnly) { toast.info("المشاركة متاحة لصور الهاتف حالياً"); return; }
    if (ids.length > 30) { toast.info("اختر ٣٠ عنصراً أو أقل للمشاركة"); return; }
    if (!(await shareGalleryItems(ids, `${ids.length} عنصر`))) toast.error("تعذّرت المشاركة");
  };

  const remove = async () => {
    void tap("heavy");
    setBusy(true);
    try {
      // Android 11+ shows its own confirmation and never reports the outcome,
      // so park the ids and reconcile once the app regains focus.
      await markPendingDeletes(ids);
      await deleteGalleryItems(ids);
      void buzz("success");
      onClear();
    } catch {
      toast.error("تعذّر الحذف");
    } finally {
      setBusy(false);
    }
  };

  const uploadNow = async () => {
    void tap("medium");
    setBusy(true);
    try {
      // Un-pause anything the user explicitly picked, then run a cycle.
      await photoDb.assets.where("id").anyOf(ids).modify({ syncedAt: undefined });
      void runSyncCycle();
      toast.success("أُضيفت إلى قائمة الرفع");
      onClear();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-x-0 bottom-0 z-50 safe-bottom px-3 pb-3">
      <div className="mx-auto flex max-w-md items-center gap-1 rounded-full border border-border bg-card/95 p-1.5 shadow-2xl shadow-black/60 backdrop-blur-xl">
        <button onClick={() => { void tap("light"); onClear(); }} className="press grid h-11 w-11 place-items-center rounded-full text-muted-foreground" aria-label="إلغاء">
          <X className="h-5 w-5" />
        </button>

        <button
          onClick={() => { void tap("light"); onSelectAll(); }}
          className="press shrink-0 rounded-full px-2 text-[12px] font-black tabular-nums"
        >
          {ids.length} / {total}
        </button>

        <div className="flex flex-1 items-center justify-end gap-1">
          <Action icon={Share2} label="مشاركة" onClick={share} disabled={busy || !ids.length} />
          {deviceOnly && (
            <Action icon={CloudUpload} label="ارفع" onClick={uploadNow} disabled={busy || !ids.length} />
          )}
          <Action
            icon={busy ? Loader2 : Trash2}
            label="حذف"
            onClick={remove}
            disabled={busy || !ids.length || !deviceOnly}
            danger
            spinning={busy}
          />
        </div>
      </div>
    </div>
  );
}

function Action({
  icon: Icon, label, onClick, disabled, danger, spinning,
}: {
  icon: typeof Share2;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  spinning?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      className={`press flex flex-col items-center gap-0.5 rounded-full px-3 py-1.5 text-[10px] font-bold disabled:opacity-35 ${
        danger ? "text-destructive" : "text-foreground"
      }`}
    >
      <Icon className={`h-[18px] w-[18px] ${spinning ? "animate-spin" : ""}`} />
      {label}
    </button>
  );
}
