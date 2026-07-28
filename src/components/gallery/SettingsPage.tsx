import { useEffect, useState } from "react";
import { toast } from "sonner";
import { ArrowRight, Bug, Check, ExternalLink, Loader2 } from "lucide-react";
import { photoDb } from "@/lib/photoDb";
import { saveProviderConfig, setActiveProvider } from "@/lib/providers";
import { telegramTest } from "@/lib/providers/telegram";
import { useProviders } from "@/hooks/useProviders";
import { useSyncSettings } from "@/hooks/useSyncEngine";
import { setSyncSettings } from "@/lib/syncEngine";
import { cn } from "@/lib/utils";
import { checkForUpdate, launchApkInstall, type UpdateInfo } from "@/lib/ota";
import { TelegramAccountCard } from "./TelegramAccountCard";

interface Props { onBack: () => void; onOpenDiagnostics: () => void }

export function SettingsPage({ onBack, onOpenDiagnostics }: Props) {
  const { providers } = useProviders();
  const tg = providers.get("telegram");
  const settings = useSyncSettings();

  const [botToken, setBotToken] = useState(tg?.botToken ?? "");
  const [chatId, setChatId] = useState(tg?.chatId ?? "");
  const [testing, setTesting] = useState(false);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);

  useEffect(() => {
    if (tg?.botToken != null) setBotToken(tg.botToken);
    if (tg?.chatId != null) setChatId(tg.chatId);
  }, [tg?.botToken, tg?.chatId]);

  const save = async () => {
    if (!botToken.trim() || !chatId.trim()) {
      toast.error("أدخل البوت والشات");
      return;
    }
    await saveProviderConfig({
      kind: "telegram", configured: true,
      botToken: botToken.trim(), chatId: chatId.trim(),
    });
    await setActiveProvider("telegram");
    toast.success("تم الحفظ");
  };

  const test = async () => {
    if (!botToken || !chatId) return;
    setTesting(true);
    try {
      const chat = await telegramTest(botToken.trim(), chatId.trim());
      toast.success(`متصل بـ ${chat.title ?? chat.username ?? chat.id}`);
    } catch (e) {
      toast.error("فشل الاتصال: " + (e instanceof Error ? e.message : String(e)));
    } finally { setTesting(false); }
  };

  const reset = async () => {
    await photoDb.delete();
    location.reload();
  };

  const checkUpdate = async () => {
    setCheckingUpdate(true);
    try {
      const info = await checkForUpdate();
      setUpdateInfo(info);
      if (info.available) toast.success("يوجد تحديث جديد");
      else toast.info("لا يوجد تحديث أحدث حالياً");
    } finally {
      setCheckingUpdate(false);
    }
  };

  return (
    <div className="min-h-full pb-28 safe-top">
      <header className="sticky top-0 z-30 flex items-center gap-2 border-b border-border/60 bg-background/95 px-3 py-3 backdrop-blur">
        <button onClick={onBack} className="grid h-9 w-9 place-items-center rounded-full hover:bg-secondary">
          <ArrowRight className="h-5 w-5" />
        </button>
        <h1 className="text-base font-bold">الإعدادات</h1>
      </header>

      <div className="mx-auto max-w-2xl space-y-6 p-4">
        {/* How it works */}
        <section className="rounded-2xl border border-primary/30 bg-primary/5 p-4 text-xs leading-relaxed">
          <h2 className="mb-2 text-sm font-bold text-primary">كيف يعمل التطبيق؟</h2>
          <ol className="list-decimal space-y-1.5 pr-4 text-foreground">
            <li>يستورد صور/فيديوهات المعرض من زر «+» في تبويب المزامنة.</li>
            <li>يرفعها إلى بوت تليكرام الخاص بك (يدوي أو تلقائي).</li>
            <li>بعد المزامنة يمكنك حذفها من الاستوديو لتوفير المساحة.</li>
            <li>تبويب «معرض تليكرام» يعرض كل صورة رُفعت (حتى المرفوعة قبلاً).</li>
          </ol>
        </section>

        <TelegramAccountCard />

        {/* Bot */}
        <section className="rounded-2xl border border-border bg-card p-4">
          <h2 className="mb-1 text-sm font-bold">إعداد بوت تليكرام</h2>
          <details className="mb-3 rounded-lg bg-secondary/50 p-3 text-[11px] leading-relaxed">
            <summary className="cursor-pointer font-semibold text-foreground">شرح خطوة بخطوة (اضغط)</summary>
            <ol className="mt-2 list-decimal space-y-1.5 pr-4 text-muted-foreground">
              <li>افتح <b>@BotFather</b> في تليكرام واكتب <code dir="ltr">/newbot</code>، سيعطيك <b>Bot Token</b>.</li>
              <li>
                <b>مهم جداً:</b> اكتب <code dir="ltr">/setprivacy</code> في BotFather → اختر البوت → اضغط <b>Disable</b>.
                بدون هذه الخطوة، البوت لن يرى الرسائل داخل المجموعة حتى لو كان أدمن!
              </li>
              <li>أضف البوت لمجموعتك واجعله أدمن.</li>
              <li>أرسل أي رسالة في المجموعة، ثم افتح رابط: <code className="break-all" dir="ltr">https://api.telegram.org/bot&lt;TOKEN&gt;/getUpdates</code> وانسخ <code dir="ltr">chat.id</code> (رقم سالب للمجموعات).</li>
              <li>ألصق التوكن والـ Chat ID أدناه واضغط «اختبار الاتصال».</li>
            </ol>
            <p className="mt-2 text-yellow-400">
              ⚠️ الصور القديمة المرسلة قبل إضافة البوت لا يمكن استرجاعها — قيد من تليكرام. لعرضها: أعد توجيهها للبوت مباشرة.
            </p>
          </details>

          <div className="space-y-2">
            <label className="block text-xs font-medium text-muted-foreground">Bot Token</label>
            <input
              value={botToken} onChange={(e) => setBotToken(e.target.value)}
              placeholder="123456:ABC-DEF..." dir="ltr"
              className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm font-mono"
            />
            <label className="block text-xs font-medium text-muted-foreground">Chat ID</label>
            <input
              value={chatId} onChange={(e) => setChatId(e.target.value)}
              placeholder="-1001234567890" dir="ltr"
              className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm font-mono"
            />
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              onClick={save}
              className="flex items-center gap-1.5 rounded-full bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground"
            >
              <Check className="h-4 w-4" /> حفظ
            </button>
            <button
              onClick={test} disabled={testing}
              className="flex items-center gap-1.5 rounded-full bg-secondary px-4 py-2 text-sm font-semibold disabled:opacity-50"
            >
              {testing && <Loader2 className="h-4 w-4 animate-spin" />}
              اختبار الاتصال
            </button>
            <a
              href="https://t.me/BotFather?start=setprivacy"
              target="_blank" rel="noreferrer"
              onClick={() => {
                try { navigator.clipboard.writeText("/setprivacy"); toast.info("نُسخ /setprivacy — ألصقه في BotFather"); } catch { /* noop */ }
              }}
              className="flex items-center gap-1.5 rounded-full bg-secondary px-4 py-2 text-sm font-semibold"
            >
              <ExternalLink className="h-4 w-4" /> فتح BotFather
            </a>
          </div>
          <p className="mt-2 text-[11px] text-muted-foreground">
            زر «فتح BotFather» يفتح تليكرام وينسخ الأمر <code dir="ltr">/setprivacy</code> — ألصقه، اختر البوت، ثم Disable. لا يمكن للتطبيق تنفيذ ذلك تلقائياً لأن الأمر لا يوفّره Bot API — بل عبر محادثة BotFather فقط.
          </p>
        </section>

        {/* Sync */}
        <section className="rounded-2xl border border-border bg-card p-4">
          <h2 className="mb-3 text-sm font-bold">المزامنة</h2>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2">
              <ModeButton active={settings.mode === "auto"} label="تلقائي" onClick={() => setSyncSettings({ mode: "auto" })} />
              <ModeButton active={settings.mode === "manual"} label="يدوي" onClick={() => setSyncSettings({ mode: "manual" })} />
            </div>
            <Toggle
              label="واي-فاي فقط"
              checked={settings.wifiOnly}
              onChange={(v) => setSyncSettings({ wifiOnly: v })}
            />
            <Toggle
              label="حرّر المساحة المحلية بعد الرفع"
              hint="يزيل الملف من قاعدة بيانات التطبيق بعد رفعه (يبقى في استوديو الهاتف)"
              checked={settings.freeBlobAfterSync}
              onChange={(v) => setSyncSettings({ freeBlobAfterSync: v })}
            />
            <Toggle
              label="إيقاف مؤقت"
              checked={settings.paused}
              onChange={(v) => setSyncSettings({ paused: v })}
            />
            <Toggle
              label="حجم الملفات مفتوح"
              hint="لن يمنع التطبيق أي حجم؛ إذا رفض تليكرام ملفاً ضخماً سيظهر الخطأ في التشخيصات."
              checked={settings.maxFileMb === 0}
              onChange={(v) => setSyncSettings({ maxFileMb: v ? 0 : 2000 })}
            />
            {settings.maxFileMb > 0 && (
              <div>
                <label className="block text-xs font-medium text-muted-foreground">الحد الأقصى لحجم الملف: {settings.maxFileMb} MB</label>
                <input
                  type="range" min={10} max={2000} step={10}
                  value={settings.maxFileMb}
                  onChange={(e) => setSyncSettings({ maxFileMb: Number(e.target.value) })}
                  className="w-full"
                />
              </div>
            )}
          </div>
        </section>

        {/* Updates */}
        <section className="rounded-2xl border border-border bg-card p-4">
          <h2 className="mb-2 text-sm font-bold">تحديث التطبيق</h2>
          <p className="mb-3 text-xs text-muted-foreground">
            يتحقق من آخر APK مبني في GitHub ويفتح مُثبّت أندرويد مباشرة. إذا ظهر خطأ توقيع، يجب تثبيت كل الإصدارات القادمة من نفس GitHub Action.
          </p>
          {updateInfo && (
            <div className="mb-3 rounded-xl bg-secondary p-3 text-xs">
              الحالي: {updateInfo.currentVersion}
              {updateInfo.latestVersion ? ` · الأخير: ${updateInfo.latestVersion}` : ""}
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <button
              onClick={checkUpdate}
              disabled={checkingUpdate}
              className="flex items-center gap-1.5 rounded-full bg-secondary px-4 py-2 text-sm font-semibold disabled:opacity-50"
            >
              {checkingUpdate && <Loader2 className="h-4 w-4 animate-spin" />}
              فحص التحديث
            </button>
            {updateInfo?.available && updateInfo.apkUrl && (
              <button
                onClick={() => launchApkInstall(updateInfo.apkUrl!)}
                className="rounded-full bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground"
              >
                تثبيت التحديث
              </button>
            )}
          </div>
        </section>

        {/* Diagnostics */}
        <section className="rounded-2xl border border-border bg-card p-4">
          <h2 className="mb-2 text-sm font-bold">مراقب الأخطاء</h2>
          <p className="mb-3 text-xs text-muted-foreground">
            يسجّل الأخطاء والتحذيرات فقط لتوفير الأداء. افتحه في صفحة كاملة.
          </p>
          <button
            onClick={onOpenDiagnostics}
            className="flex items-center gap-1.5 rounded-full bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground"
          >
            <Bug className="h-4 w-4" /> فتح مراقب الأخطاء
          </button>
        </section>

        {/* Danger */}
        <section className="rounded-2xl border border-destructive/30 bg-destructive/5 p-4">
          <h2 className="mb-2 text-sm font-bold text-destructive">إعادة تعيين</h2>
          <p className="mb-3 text-xs text-muted-foreground">
            سيمسح كل بيانات التطبيق (لا يمس صور الاستوديو ولا تليكرام).
          </p>
          <button
            onClick={reset}
            className="rounded-full bg-destructive px-4 py-2 text-sm font-semibold text-destructive-foreground"
          >
            حذف بيانات التطبيق
          </button>
        </section>
      </div>
    </div>
  );
}

function ModeButton({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "rounded-xl border px-3 py-2 text-sm font-semibold transition",
        active ? "border-primary bg-primary/10 text-primary" : "border-border bg-background text-foreground",
      )}
    >
      {label}
    </button>
  );
}

function Toggle({ label, hint, checked, onChange }: {
  label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-3">
      <div className="min-w-0 flex-1">
        <div className="text-sm">{label}</div>
        {hint && <div className="text-[11px] text-muted-foreground">{hint}</div>}
      </div>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-1 h-5 w-5 accent-primary"
      />
    </label>
  );
}
