import { useEffect, useState } from "react";
import { BatteryCharging, Bell, ChevronLeft, Images, Loader2, ShieldCheck } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  isNative, prefGet, prefSet, tap, buzz,
  requestNotifPermission, checkNotifPermission,
  checkGalleryPermission, requestGalleryPermission,
  isIgnoringBatteryOptimizations, requestBatteryExemption,
} from "@/lib/native";
import { canScanDeviceGallery, scanDeviceGallery } from "@/lib/deviceMedia";

const KEY = "lp:wizard:done";

export function PermissionsWizard() {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      if (!isNative()) {
        if (!(await prefGet(KEY))) setOpen(true);
        return;
      }
      try {
        const [gallery, notif] = await Promise.all([
          checkGalleryPermission(),
          checkNotifPermission(),
        ]);
        if (gallery !== "granted" || notif !== "granted") setOpen(true);
      } catch {
        setOpen(true);
      }
    })();
  }, []);

  if (!open) return null;

  const skip = async () => {
    void tap("light");
    await prefSet(KEY, "skipped");
    setOpen(false);
  };

  const finish = async () => {
    void tap("medium");
    setBusy(true);
    try {
      if (isNative()) {
        // Gallery first (needed to index), then notifications (the background
        // service needs one), then the battery exemption that keeps it alive.
        await requestGalleryPermission().catch(() => false);
        await requestNotifPermission().catch(() => false);
        if (!(await isIgnoringBatteryOptimizations().catch(() => true))) {
          await requestBatteryExemption().catch(() => false);
        }
      } else if ("Notification" in window && Notification.permission === "default") {
        await Notification.requestPermission().catch(() => undefined);
      }
      await prefSet(KEY, "1");
      void buzz("success");
      if (canScanDeviceGallery()) void scanDeviceGallery().catch(() => undefined);
    } finally {
      setBusy(false);
      setOpen(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[80] flex flex-col bg-background text-foreground safe-top safe-bottom">
      <div className="flex-1 overflow-y-auto px-6 py-10">
        <div className="mx-auto max-w-md space-y-7 text-center">
          <div className="mx-auto grid h-20 w-20 place-items-center rounded-3xl bg-hot text-primary-foreground shadow-[var(--shadow-fab)]">
            <Images className="h-10 w-10" />
          </div>
          <div>
            <h1 className="headline text-2xl">صورك، محفوظة تلقائياً</h1>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
              كل صورة تلتقطها تُرفع إلى قناتك الخاصة في تيليجرام — بدون أي سحابة أخرى،
              وبدون أن تفتح التطبيق.
            </p>
          </div>
          <div className="grid gap-3 text-right">
            <Row icon={Images} title="الوصول للمعرض" desc="ليعرف أي صور يرفعها." />
            <Row icon={Bell} title="الإشعارات" desc="لعرض تقدّم الرفع وتنبيهك عند انتهائه." />
            <Row icon={BatteryCharging} title="تشغيل في الخلفية" desc="ليكمل الرفع والشاشة مطفأة." />
            <Row icon={ShieldCheck} title="خصوصية كاملة" desc="لا يُرسل شيء إلا لحسابك أنت." />
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between gap-3 border-t border-border p-4">
        <button onClick={skip} className="press px-3 py-2 text-sm text-muted-foreground">
          لاحقاً
        </button>
        <button
          disabled={busy}
          onClick={finish}
          className={cn(
            "press flex items-center gap-2 rounded-full bg-hot px-6 py-3 text-sm font-black text-primary-foreground shadow-[var(--shadow-fab)]",
            busy && "opacity-60",
          )}
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          يلا نبدأ
          <ChevronLeft className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

function Row({ icon: Icon, title, desc }: { icon: typeof Bell; title: string; desc: string }) {
  return (
    <div className="flex items-start gap-3 rounded-2xl border border-border bg-card p-3">
      <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary">
        <Icon className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-bold">{title}</div>
        <div className="text-[11px] text-muted-foreground">{desc}</div>
      </div>
    </div>
  );
}
