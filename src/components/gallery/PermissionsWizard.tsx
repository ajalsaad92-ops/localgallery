import { useEffect, useState } from "react";
import { Bell, Images, Shield, ChevronLeft } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
  isNative, prefGet, prefSet,
  requestNotifPermission, checkNotifPermission, checkGalleryPermission,
  requestGalleryPermission, isIgnoringBatteryOptimizations, requestBatteryExemption,
} from "@/lib/native";
import { canScanDeviceGallery, scanDeviceGallery } from "@/lib/deviceMedia";

const KEY = "lp:wizard:done";

export function PermissionsWizard() {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      if (!isNative()) {
        const done = await prefGet(KEY);
        if (!done) setOpen(true);
        return;
      }
      try {
        const [g, n] = await Promise.all([checkGalleryPermission(), checkNotifPermission()]);
        if (g !== "granted" || n !== "granted") setOpen(true);
      } catch { setOpen(true); }
    })();
  }, []);

  if (!open) return null;

  const skip = async () => { await prefSet(KEY, "skipped"); setOpen(false); };

  const finish = async () => {
    setBusy(true);
    try {
      if (isNative()) {
        // Gallery first (needed for indexing), then notifications (foreground
        // service), then battery exemption so sync survives a locked screen.
        await requestGalleryPermission().catch(() => false);
        await requestNotifPermission().catch(() => false);
        if (!(await isIgnoringBatteryOptimizations().catch(() => true))) {
          await requestBatteryExemption().catch(() => false);
        }
      } else if ("Notification" in window && Notification.permission === "default") {
        try { await Notification.requestPermission(); } catch { /* ignore */ }
      }
      await prefSet(KEY, "1");
      toast.success("جاهز");
      if (canScanDeviceGallery()) {
        void scanDeviceGallery().catch(() => undefined);
      }
    } finally { setBusy(false); setOpen(false); }
  };


  return (
    <div className="fixed inset-0 z-[80] flex flex-col bg-background text-foreground safe-top safe-bottom">
      <div className="flex-1 overflow-y-auto px-6 py-10">
        <div className="mx-auto max-w-md space-y-6 text-center">
          <div className="mx-auto grid h-20 w-20 place-items-center rounded-3xl bg-primary/15">
            <Images className="h-10 w-10 text-primary" />
          </div>
          <div>
            <h1 className="text-2xl font-bold">مزامنة صور تليكرام</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              استورد من معرض هاتفك، ازامنها لبوت تليكرام، وتصفّحها من هناك — بدون أي سحابة أخرى.
            </p>
          </div>
          <div className="grid gap-3 text-right">
            <Row icon={Images} title="الوصول للمعرض" desc="لاختيار الصور التي ستُزامَن." />
            <Row icon={Bell} title="الإشعارات" desc="لتنبيهك عند انتهاء المزامنة." />
            <Row icon={Shield} title="خصوصية" desc="لا يُرسل شيء إلا لبوت تليكرام الخاص بك." />
          </div>
        </div>
      </div>
      <div className="flex items-center justify-between gap-3 border-t border-border p-4">
        <button onClick={skip} className="text-sm text-muted-foreground">تخطي</button>
        <button
          disabled={busy}
          onClick={finish}
          className={cn("flex items-center gap-2 rounded-full bg-primary px-6 py-3 text-sm font-semibold text-primary-foreground", busy && "opacity-60")}
        >
          متابعة
          <ChevronLeft className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

function Row({ icon: Icon, title, desc }: { icon: typeof Bell; title: string; desc: string }) {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-border bg-card p-3">
      <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
        <Icon className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">{title}</div>
        <div className="text-[11px] text-muted-foreground">{desc}</div>
      </div>
    </div>
  );
}
