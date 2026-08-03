import { useEffect, useState } from "react";
import {
  Check, ChevronDown, HardDrive, Images, Loader2, Pause, Play, Trash2, Video,
} from "lucide-react";
import { photoDb } from "@/lib/photoDb";
import { useSyncProgress, useSyncSettings } from "@/hooks/useSyncEngine";
import { runSyncCycle, setSyncSettings } from "@/lib/syncEngine";
import { deleteGalleryItems, tap } from "@/lib/native";
import { markPendingDeletes } from "@/lib/pendingDeletes";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

interface Stats {
  pending: number;
  pendingBytes: number;
  uploaded: number;
  uploadedBytes: number;
  photos: number;
  videos: number;
  /** Bytes still on the phone that already live on Telegram. */
  reclaimable: number;
  reclaimableIds: string[];
}

const fmt = (bytes: number) => {
  if (bytes <= 0) return "0";
  const gb = bytes / 1073741824;
  if (gb >= 1) return `${gb.toFixed(1)} غ.ب`;
  return `${Math.round(bytes / 1048576)} م.ب`;
};

async function computeStats(): Promise<Stats> {
  const rows = await photoDb.assets.toArray();
  const s: Stats = {
    pending: 0, pendingBytes: 0, uploaded: 0, uploadedBytes: 0,
    photos: 0, videos: 0, reclaimable: 0, reclaimableIds: [],
  };
  for (const a of rows) {
    if (a.kind === "video") s.videos++; else s.photos++;
    const synced = a.syncedAt != null || a.remoteMessageId != null;
    if (synced) {
      s.uploaded++;
      s.uploadedBytes += a.size || 0;
      // Safe to remove from the phone: it is already on Telegram.
      if (a.provider === "device" && a.localUri) {
        s.reclaimable += a.size || 0;
        s.reclaimableIds.push(a.id);
      }
    } else if (a.provider === "device") {
      s.pending++;
      s.pendingBytes += a.size || 0;
    }
  }
  return s;
}

/**
 * One compact strip replacing the three separate bars the app used to stack
 * (queue count, sync mode, pause). Tap to expand into the full picture:
 * what is uploaded, what is waiting, and how much space can be reclaimed.
 */
export function StatusPill() {
  const progress = useSyncProgress();
  const settings = useSyncSettings();
  const [open, setOpen] = useState(false);
  const [stats, setStats] = useState<Stats | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open && !progress.running) return;
    // Recompute when the panel opens and when a run ends — not on a timer.
    // toArray() deserializes every row, and this sits on the screen whose
    // slowness prompted the rewrite.
    let alive = true;
    void computeStats().then((s) => alive && setStats(s));
    return () => { alive = false; };
  }, [open, progress.running]);

  const pct =
    progress.total > 0
      ? Math.round(((progress.done + (progress.currentFraction ?? 0)) / progress.total) * 100)
      : 0;

  const label = progress.running
    ? `يرفع ${progress.done + 1} من ${progress.total}`
    : settings.paused
      ? "المزامنة متوقفة"
      : settings.mode === "auto"
        ? "المزامنة تعمل"
        : "مزامنة يدوية";

  const freeSpace = async () => {
    if (!stats?.reclaimableIds.length) return;
    setBusy(true);
    try {
      // The OS owns the confirmation on Android 11+, so record the intent and
      // let the focus-return reconcile decide what actually went.
      await markPendingDeletes(stats.reclaimableIds);
      await deleteGalleryItems(stats.reclaimableIds);
    } catch {
      toast.error("تعذّر الحذف");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-4 mb-2 overflow-hidden rounded-2xl border border-border bg-card">
      {/* Collapsed strip — deliberately tiny. */}
      <button
        onClick={() => { void tap("light"); setOpen((v) => !v); }}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-[11px] font-bold"
      >
        {progress.running ? (
          <Loader2 className="h-3 w-3 shrink-0 animate-spin text-primary" />
        ) : settings.paused ? (
          <Pause className="h-3 w-3 shrink-0 text-muted-foreground" />
        ) : (
          <span className="relative flex h-2 w-2 shrink-0">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-hot opacity-70" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-hot" />
          </span>
        )}

        <span className="truncate">{label}</span>

        {progress.running && (
          <span className="ms-auto flex items-center gap-2">
            <span className="h-1 w-16 overflow-hidden rounded-full bg-secondary">
              <span
                className="block h-full rounded-full bg-hot transition-[width] duration-300"
                style={{ width: `${pct}%` }}
              />
            </span>
          </span>
        )}

        <ChevronDown
          className={cn("h-3.5 w-3.5 shrink-0 transition-transform", !progress.running && "ms-auto", open && "rotate-180")}
        />
      </button>

      {open && (
        <div className="space-y-3 border-t border-border/60 p-3">
          <div className="grid grid-cols-2 gap-2 text-[11px]">
            <Stat icon={Check} label="مرفوعة" value={`${stats?.uploaded ?? 0}`} sub={fmt(stats?.uploadedBytes ?? 0)} />
            <Stat icon={HardDrive} label="بالانتظار" value={`${stats?.pending ?? 0}`} sub={fmt(stats?.pendingBytes ?? 0)} />
            <Stat icon={Images} label="صور" value={`${stats?.photos ?? 0}`} />
            <Stat icon={Video} label="فيديو" value={`${stats?.videos ?? 0}`} />
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => { void tap("medium"); void setSyncSettings({ paused: !settings.paused }); }}
              className="press flex items-center gap-1.5 rounded-full bg-secondary px-3 py-1.5 text-[11px] font-bold"
            >
              {settings.paused ? <Play className="h-3 w-3" /> : <Pause className="h-3 w-3" />}
              {settings.paused ? "استئناف" : "إيقاف مؤقت"}
            </button>
            <button
              onClick={() => { void tap("medium"); void runSyncCycle(); }}
              disabled={progress.running}
              className="press rounded-full bg-secondary px-3 py-1.5 text-[11px] font-bold disabled:opacity-40"
            >
              ارفع الآن
            </button>
          </div>

          {stats && stats.reclaimable > 0 && (
            <div className="rounded-xl border border-primary/30 bg-primary/5 p-2.5">
              <div className="mb-1.5 text-[11px] font-bold">
                يمكنك تفريغ {fmt(stats.reclaimable)}
              </div>
              <p className="mb-2 text-[10px] leading-relaxed text-muted-foreground">
                {stats.reclaimableIds.length} عنصراً محفوظة في تيليجرام وما زالت نسخة منها في
                هاتفك. حذفها من الهاتف لا يمسّ النسخة المرفوعة.
              </p>
              <button
                onClick={freeSpace}
                disabled={busy}
                className="press flex items-center gap-1.5 rounded-full bg-primary px-3 py-1.5 text-[11px] font-bold text-primary-foreground disabled:opacity-50"
              >
                {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
                فرّغ المساحة
              </button>
            </div>
          )}

          {progress.lastError && (
            <p className="truncate text-[10px] text-destructive">{progress.lastError}</p>
          )}
        </div>
      )}
    </div>
  );
}

function Stat({
  icon: Icon, label, value, sub,
}: { icon: typeof Check; label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl bg-secondary/60 p-2">
      <div className="flex items-center gap-1.5 text-muted-foreground">
        <Icon className="h-3 w-3" />
        {label}
      </div>
      <div className="mt-0.5 text-sm font-black tabular-nums">{value}</div>
      {sub && <div className="text-[10px] text-muted-foreground">{sub}</div>}
    </div>
  );
}
