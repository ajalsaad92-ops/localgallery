import { useEffect, useState } from "react";
import { toast } from "sonner";
import { ArrowRight, BatteryCharging, Download, Loader2, Trash2 } from "lucide-react";
import { photoDb, DEFAULT_MAX_FILE_MB, MAX_UPLOAD_MB } from "@/lib/photoDb";
import { useSyncSettings } from "@/hooks/useSyncEngine";
import { MAX_PARALLEL_UPLOADS, setSyncSettings } from "@/lib/syncEngine";
import { cn } from "@/lib/utils";
import { checkForUpdate, launchApkInstall, APP_VERSION, type UpdateInfo } from "@/lib/ota";
import {
  isIgnoringBatteryOptimizations, requestBatteryExemption, isNative, tap,
  storageUsage, clearAppCache, type StorageReport,
} from "@/lib/native";
import { TelegramAccountCard } from "./TelegramAccountCard";

interface Props {
  onBack: () => void;
}

export function SettingsPage({ onBack }: Props) {
  const settings = useSyncSettings();
  const [checking, setChecking] = useState(false);
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [batteryOk, setBatteryOk] = useState(true);

  useEffect(() => {
    if (!isNative()) return;
    let alive = true;
    void isIgnoringBatteryOptimizations().then((v) => alive && setBatteryOk(v));
    return () => { alive = false; };
  }, []);

  const checkUpdate = async () => {
    setChecking(true);
    try {
      const info = await checkForUpdate();
      setUpdate(info);
      toast[info.available ? "success" : "info"](
        info.available ? "يوجد تحديث جديد 🎉" : "أنت على أحدث نسخة",
      );
    } finally {
      setChecking(false);
    }
  };

  const reset = async () => {
    await photoDb.delete();
    location.reload();
  };

  return (
    <div className="min-h-full pb-28 safe-top">
      <header className="sticky top-0 z-30 flex items-center gap-2 border-b border-border/60 bg-background/95 px-3 py-3 backdrop-blur">
        <button
          onClick={() => { void tap("light"); onBack(); }}
          className="press grid h-9 w-9 place-items-center rounded-full hover:bg-secondary"
          aria-label="رجوع"
        >
          <ArrowRight className="h-5 w-5" />
        </button>
        <h1 className="text-base font-bold">الإعدادات</h1>
      </header>

      <div className="mx-auto max-w-2xl space-y-5 p-4">
        <TelegramAccountCard />

        <section className="rounded-2xl border border-border bg-card p-4">
          <h2 className="mb-3 text-sm font-bold">المزامنة</h2>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-2">
              <ModeButton
                active={settings.mode === "auto"}
                label="تلقائي"
                hint="يرفع وحده"
                onClick={() => setSyncSettings({ mode: "auto", paused: false })}
              />
              <ModeButton
                active={settings.mode === "manual"}
                label="يدوي"
                hint="بضغطة زر"
                onClick={() => setSyncSettings({ mode: "manual" })}
              />
            </div>

            <Toggle
              label="واي-فاي فقط"
              hint="لا يستهلك باقة الإنترنت"
              checked={settings.wifiOnly}
              onChange={(v) => setSyncSettings({ wifiOnly: v })}
            />
            <Toggle
              label="حرّر المساحة بعد الرفع"
              hint="يزيل النسخة من ذاكرة التطبيق — الصورة تبقى في استوديو الهاتف"
              checked={settings.freeBlobAfterSync}
              onChange={(v) => setSyncSettings({ freeBlobAfterSync: v })}
            />

            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">
                ملفات تُرفع معاً: {settings.parallelUploads}
              </label>
              <input
                type="range" min={1} max={MAX_PARALLEL_UPLOADS} step={1}
                value={Math.min(settings.parallelUploads, MAX_PARALLEL_UPLOADS)}
                onChange={(e) => setSyncSettings({ parallelUploads: Number(e.target.value) })}
                className="w-full accent-primary"
              />
              <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">
                الملفات تُرسل على أجزاء، فالرقم العالي لا يستهلك ذاكرة إضافية.
                لكن كل الملفات تشترك في اتصال واحد مع تيليجرام: إن بدأ يطلب
                التمهّل، يقلّل التطبيق العدد تلقائياً ثم يرفعه ثانية.
              </p>
            </div>

            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">
                أقصى حجم للملف: {Math.min(settings.maxFileMb || DEFAULT_MAX_FILE_MB, MAX_UPLOAD_MB)} م.ب
              </label>
              <input
                type="range"
                min={25}
                max={MAX_UPLOAD_MB}
                step={25}
                value={Math.min(settings.maxFileMb || DEFAULT_MAX_FILE_MB, MAX_UPLOAD_MB)}
                onChange={(e) => setSyncSettings({ maxFileMb: Number(e.target.value) })}
                className="w-full accent-primary"
              />
              <p className="text-[11px] text-muted-foreground">
                الملفات الأكبر تُتخطّى. الحد الأعلى هنا هو حدّ تيليجرام نفسه.
              </p>
            </div>
          </div>
        </section>

        {isNative() && !batteryOk && (
          <section className="rounded-2xl border border-amber-500/40 bg-amber-500/10 p-4">
            <div className="mb-2 flex items-center gap-2 text-sm font-bold text-amber-400">
              <BatteryCharging className="h-4 w-4" />
              المزامنة قد تتوقف في الخلفية
            </div>
            <p className="mb-3 text-xs text-muted-foreground">
              أندرويد يوقف التطبيق لتوفير البطارية. استثنِ التطبيق ليكمل الرفع والشاشة مطفأة.
            </p>
            <button
              onClick={async () => {
                await requestBatteryExemption();
                setBatteryOk(await isIgnoringBatteryOptimizations());
              }}
              className="press rounded-full bg-amber-500 px-4 py-2 text-sm font-bold text-black"
            >
              استثناء التطبيق
            </button>
          </section>
        )}

        <StorageSection />

        <section className="rounded-2xl border border-border bg-card p-4">
          <h2 className="mb-1 text-sm font-bold">التحديث</h2>
          <p className="mb-3 text-xs text-muted-foreground">
            النسخة الحالية {APP_VERSION}
            {update?.latestVersion ? ` · الأحدث ${update.latestVersion}` : ""}
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={checkUpdate}
              disabled={checking}
              className="press flex items-center gap-1.5 rounded-full bg-secondary px-4 py-2 text-sm font-semibold disabled:opacity-50"
            >
              {checking && <Loader2 className="h-4 w-4 animate-spin" />}
              فحص التحديث
            </button>
            {update?.available && update.apkUrl && (
              <button
                onClick={() => launchApkInstall(update.apkUrl!)}
                className="press flex items-center gap-1.5 rounded-full bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground"
              >
                <Download className="h-4 w-4" />
                تثبيت
              </button>
            )}
          </div>
        </section>

        <section className="rounded-2xl border border-destructive/30 bg-destructive/5 p-4">
          <h2 className="mb-2 text-sm font-bold text-destructive">إعادة تعيين</h2>
          <p className="mb-3 text-xs text-muted-foreground">
            يمسح بيانات التطبيق فقط — لا يمس صور الاستوديو ولا ما رُفع إلى تيليجرام.
          </p>
          <button
            onClick={reset}
            className="press rounded-full bg-destructive px-4 py-2 text-sm font-semibold text-destructive-foreground"
          >
            حذف بيانات التطبيق
          </button>
        </section>
      </div>
    </div>
  );
}

const LABELS: Record<string, string> = {
  databases: "قاعدة بيانات التطبيق",
  webview_profile: "تخزين الويب‑فيو (الفهرس والمعاينات)",
  webview_blobs: "ملفات مؤقتة للرفع",
  cache: "ذاكرة مؤقتة",
  external_cache: "ذاكرة مؤقتة خارجية",
  files: "ملفات",
  code_cache: "كود مؤقت",
  app_webview: "ويب‑فيو (الإجمالي)",
  shared_prefs: "إعدادات",
};

const bytes = (n: number) => {
  if (n >= 1073741824) return `${(n / 1073741824).toFixed(2)} غ.ب`;
  if (n >= 1048576) return `${Math.round(n / 1048576)} م.ب`;
  return `${Math.round(n / 1024)} ك.ب`;
};

/**
 * Where the app's disk usage goes.
 *
 * Exists because "the app is holding 8 GB" is not something anyone should have
 * to guess at — including me.
 */
function StorageSection() {
  const [report, setReport] = useState<StorageReport | null>(null);
  const [working, setWorking] = useState(false);

  const refresh = () => { void storageUsage().then(setReport); };
  useEffect(() => { if (isNative()) refresh(); }, []);

  if (!isNative()) return null;

  // Biggest first, and skip the rounding noise. `app_webview` is dropped
  // because its two interesting halves are listed separately.
  const rows = Object.entries(report?.dirs ?? {})
    .filter(([k, v]) => v > 1024 * 512 && k !== "app_webview")
    .sort((a, b) => b[1] - a[1]);

  const clean = async () => {
    setWorking(true);
    try {
      const freed = await clearAppCache();
      const dropped = await photoDb.thumbs.count();
      await photoDb.thumbs.clear();
      toast.success(
        `فُرّغ ${bytes(freed)}${dropped ? ` · حُذفت ${dropped} معاينة مخزّنة` : ""}`,
      );
      refresh();
    } finally {
      setWorking(false);
    }
  };

  // Same repair the app runs once on its own, on demand.
  const repair = async () => {
    setWorking(true);
    try {
      const { purgeOversizedThumbs } = await import("@/lib/remoteThumbs");
      const { removed, bytes: freed } = await purgeOversizedThumbs();
      toast[removed ? "success" : "info"](
        removed
          ? `حُذفت ${removed} «معاينة» كانت ملفات كاملة — ${bytes(freed)}`
          : "لا توجد معاينات معطوبة",
      );
      refresh();
    } finally {
      setWorking(false);
    }
  };

  return (
    <section className="rounded-2xl border border-border bg-card p-4">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-bold">مساحة التطبيق</h2>
        <span className="text-sm font-black tabular-nums">
          {report ? bytes(report.total) : "…"}
        </span>
      </div>

      <div className="mb-3 space-y-1">
        {rows.map(([key, value]) => (
          <div key={key} className="flex items-center justify-between text-[11px]">
            <span className="text-muted-foreground">{LABELS[key] ?? key}</span>
            <span className="tabular-nums">{bytes(value)}</span>
          </div>
        ))}
        {rows.length === 0 && (
          <p className="text-[11px] text-muted-foreground">لا شيء يُذكر.</p>
        )}
      </div>

      <p className="mb-2 text-[10px] leading-relaxed text-muted-foreground">
        التنظيف يحذف الملفات المؤقتة والمعاينات المخزّنة فقط. لا يمسّ صورك ولا
        فهرس التطبيق — المعاينات تُنزَّل ثانية عند تصفّح القناة.
      </p>
      <div className="flex flex-wrap gap-2">
        <button
          onClick={clean}
          disabled={working}
          className="press flex items-center gap-1.5 rounded-full bg-secondary px-4 py-2 text-sm font-semibold disabled:opacity-50"
        >
          {working ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
          تنظيف
        </button>
        <button
          onClick={repair}
          disabled={working}
          className="press rounded-full bg-secondary px-4 py-2 text-sm font-semibold disabled:opacity-50"
        >
          إصلاح المعاينات المعطوبة
        </button>
      </div>
    </section>
  );
}

function ModeButton({
  active, label, hint, onClick,
}: { active: boolean; label: string; hint: string; onClick: () => void }) {
  return (
    <button
      onClick={() => { void tap("light"); onClick(); }}
      className={cn(
        "press rounded-xl border px-3 py-2.5 text-right transition",
        active
          ? "border-primary bg-primary/10 text-primary"
          : "border-border bg-background text-foreground",
      )}
    >
      <div className="text-sm font-bold">{label}</div>
      <div className="text-[11px] opacity-70">{hint}</div>
    </button>
  );
}

function Toggle({
  label, hint, checked, onChange,
}: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={() => { void tap("light"); onChange(!checked); }}
      className="flex w-full items-start justify-between gap-3 text-right"
    >
      <span className="min-w-0 flex-1">
        <span className="block text-sm">{label}</span>
        {hint && <span className="block text-[11px] text-muted-foreground">{hint}</span>}
      </span>
      <span
        className={cn(
          "mt-0.5 flex h-6 w-11 shrink-0 items-center rounded-full p-0.5 transition-colors",
          checked ? "bg-primary" : "bg-secondary",
        )}
      >
        <span
          className={cn(
            "h-5 w-5 rounded-full bg-white shadow transition-transform",
            checked ? "-translate-x-5" : "translate-x-0",
          )}
        />
      </span>
    </button>
  );
}
