import { useEffect, useMemo, useState } from "react";
import { Copy, Trash2, Bug, AlertTriangle, Download, Share2 } from "lucide-react";
import { toast } from "sonner";
import {
  buildDiagnosticsReport,
  clearDiagnostics,
  subscribeDiagnostics,
  type DiagEntry,
  type DiagLevel,
} from "@/lib/diagnostics";
import { cn } from "@/lib/utils";
import { confirmDialog } from "@/lib/confirmDialog";
import { nativeShareText, saveBlobToDevice, isNative } from "@/lib/native";

/**
 * Warnings + errors only. Info logs stream to devtools console but are not
 * stored so the phone stays responsive.
 */
type FilterKey = DiagLevel | "all" | "flow";

const LEVELS: { key: FilterKey; label: string }[] = [
  { key: "all", label: "الكل" },
  { key: "error", label: "أخطاء" },
  { key: "warn", label: "تحذيرات" },
  { key: "flow", label: "المزامنة/تليكرام" },
];

export function DiagnosticsPanel() {
  const [entries, setEntries] = useState<DiagEntry[]>([]);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [filter, setFilter] = useState<FilterKey>("all");

  useEffect(() => subscribeDiagnostics(setEntries), []);

  const filtered = useMemo(() => {
    if (filter === "all") return entries;
    if (filter === "flow") return entries.filter((e) => e.category === "sync" || e.category === "tg");
    return entries.filter((e) => e.level === filter);
  }, [entries, filter]);


  const copyReport = async () => {
    const report = buildDiagnosticsReport();
    try {
      await navigator.clipboard.writeText(report);
      toast.success("تم نسخ التقرير");
    } catch {
      const ta = document.createElement("textarea");
      ta.value = report;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); toast.success("تم النسخ"); }
      catch { toast.error("تعذّر النسخ"); }
      finally { document.body.removeChild(ta); }
    }
  };

  const downloadReport = async () => {
    const report = buildDiagnosticsReport();
    const blob = new Blob([report], { type: "text/plain;charset=utf-8" });
    const name = `telemetry-${new Date().toISOString().replace(/[:.]/g, "-")}.log`;
    if (isNative()) {
      const uri = await saveBlobToDevice(name, blob);
      if (uri) { toast.success(`حُفظ: ${name}`); return; }
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    toast.success("تم التنزيل");
  };

  const shareReport = async () => {
    const report = buildDiagnosticsReport();
    try {
      const ok = await nativeShareText("Telemetry Report", report);
      if (!ok) await copyReport();
    } catch {
      await copyReport();
    }
  };

  const clear = async () => {
    if (!(await confirmDialog({ title: "مسح السجلات", message: "مسح كل السجلات؟", destructive: true, confirmText: "مسح" }))) return;
    await clearDiagnostics();
    toast.success("تم المسح");
  };

  const errors = entries.filter((e) => e.level === "error").length;
  const warns = entries.filter((e) => e.level === "warn").length;

  return (
    <div className="rounded-2xl border border-border bg-card">
      <div className="flex items-center gap-2 border-b border-border/60 p-3">
        <Bug className="h-4 w-4 text-primary shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium">التشخيصات</p>
          <p className="text-[11px] text-muted-foreground">
            {errors} خطأ · {warns} تحذير
          </p>
        </div>
      </div>

      <div className="grid grid-cols-4 gap-1.5 border-b border-border/60 p-2">
        <button
          onClick={copyReport}
          className="flex items-center justify-center gap-1 rounded-full bg-primary px-2 py-2 text-xs font-semibold text-primary-foreground"
        >
          <Copy className="h-3.5 w-3.5" /> نسخ
        </button>
        <button
          onClick={downloadReport}
          className="flex items-center justify-center gap-1 rounded-full bg-secondary px-2 py-2 text-xs font-semibold"
        >
          <Download className="h-3.5 w-3.5" /> تنزيل
        </button>
        <button
          onClick={shareReport}
          className="flex items-center justify-center gap-1 rounded-full bg-secondary px-2 py-2 text-xs font-semibold"
        >
          <Share2 className="h-3.5 w-3.5" /> مشاركة
        </button>
        <button
          onClick={clear}
          className="flex items-center justify-center gap-1 rounded-full bg-secondary px-2 py-2 text-xs font-semibold text-destructive"
        >
          <Trash2 className="h-3.5 w-3.5" /> مسح
        </button>
      </div>

      <div className="flex gap-1.5 border-b border-border/60 p-2">
        {LEVELS.map((c) => (
          <button
            key={c.key}
            onClick={() => setFilter(c.key)}
            className={cn(
              "flex-1 rounded-full px-2.5 py-1.5 text-[11px] font-medium transition",
              filter === c.key ? "bg-primary text-primary-foreground" : "bg-secondary text-muted-foreground",
            )}
          >
            {c.label}
          </button>
        ))}
      </div>

      <div className="max-h-[70vh] overflow-y-auto">
        {filtered.length === 0 ? (
          <p className="p-6 text-center text-xs text-muted-foreground">
            لا يوجد أي خطأ أو تحذير 🎉
          </p>
        ) : (
          <ul className="divide-y divide-border/60 text-xs">
            {[...filtered].reverse().map((e, idx) => {
              const isOpen = expanded === idx;
              const color = e.level === "error" ? "text-destructive" : "text-amber-500";
              return (
                <li key={idx} className="p-2.5">
                  <button
                    onClick={() => setExpanded(isOpen ? null : idx)}
                    className="flex w-full items-start gap-2 text-start"
                  >
                    <AlertTriangle className={cn("mt-0.5 h-3.5 w-3.5 shrink-0", color)} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate">
                        <span className="font-mono text-[10px] text-muted-foreground">
                          {e.category ?? "app"}·{e.scope}
                        </span>
                        {" "}<span className="font-medium">{e.message}</span>
                      </p>
                      <p className="text-[10px] text-muted-foreground" dir="ltr">
                        {new Date(e.ts).toLocaleTimeString()}
                      </p>
                    </div>
                  </button>
                  {isOpen && e.detail && (
                    <pre className="mt-1.5 max-h-60 overflow-auto rounded-lg bg-secondary/60 p-2 text-[10px] leading-relaxed" dir="ltr">
                      {e.detail}
                    </pre>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
