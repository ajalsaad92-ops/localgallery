import { useEffect } from "react";
import { App } from "@capacitor/app";
import { StatusBar, Style } from "@capacitor/status-bar";
import { SplashScreen } from "@capacitor/splash-screen";
import { Network } from "@capacitor/network";
import { isNative } from "@/lib/native";
import { runSyncCycle } from "@/lib/syncEngine";
import { canScanDeviceGallery, scanDeviceGallery } from "@/lib/deviceMedia";
import { reconcileDeletions } from "@/lib/pendingDeletes";
import { toast } from "sonner";

/**
 * Index newly added photos, then upload whatever that turned up.
 * The scan itself is incremental — MediaStore is only asked for items newer
 * than the last one seen, so this stays cheap on a 20k-photo library.
 */
async function catchUp() {
  if (!canScanDeviceGallery()) return;
  try {
    const inserted = await scanDeviceGallery();
    if (inserted > 0) await runSyncCycle();
  } catch {
    /* a failed scan must never break the app */
  }
}

const PURGE_FLAG = "thumbs:purged:v1";

/**
 * One-time repair for previews that are really whole files.
 *
 * A thumbnail request that asked for a size a message did not have made gramjs
 * return the original document, and it was stored base64-encoded — which is
 * where the app's gigabytes of "data" went. Runs once, in the background, well
 * after the first paint.
 */
async function repairThumbStore() {
  try {
    const { photoDb } = await import("@/lib/photoDb");
    if ((await photoDb.kv.get(PURGE_FLAG))?.value) return;
    const { purgeOversizedThumbs } = await import("@/lib/remoteThumbs");
    const { removed, bytes } = await purgeOversizedThumbs();
    await photoDb.kv.put({ key: PURGE_FLAG, value: "1" });
    if (removed > 0) {
      toast.success(
        `حُرِّر ${(bytes / 1073741824).toFixed(2)} غ.ب — ${removed} «معاينة» كانت ملفات كاملة`,
      );
    }
  } catch {
    /* best effort — never block startup */
  }
}

export function useNativeInit() {
  useEffect(() => {
    if (!isNative()) return;

    void (async () => {
      await StatusBar.setOverlaysWebView({ overlay: true }).catch(() => undefined);
      await StatusBar.setStyle({ style: Style.Dark }).catch(() => undefined);
      await StatusBar.setBackgroundColor({ color: "#00000000" }).catch(() => undefined);
      void SplashScreen.hide({ fadeOutDuration: 250 }).catch(() => undefined);
    })();

    const first = window.setTimeout(() => { void catchUp(); }, 800);
    // After the UI has settled — this walks the preview table.
    const repair = window.setTimeout(() => { void repairThumbStore(); }, 4000);

    const appSub = App.addListener("appStateChange", (s) => {
      if (!s.isActive) return;
      // Returning to the app is also when the system delete dialog has closed,
      // so settle any parked deletions before re-indexing.
      void (async () => {
        const removed = await reconcileDeletions().catch(() => 0);
        if (removed > 0) toast.success(`حُذف ${removed} عنصر`);
        await catchUp();
      })();
    });

    const netSub = Network.addListener("networkStatusChange", (s) => {
      if (s.connected) void runSyncCycle();
    });

    return () => {
      window.clearTimeout(first);
      window.clearTimeout(repair);
      void appSub.then((h) => h.remove()).catch(() => undefined);
      void netSub.then((h) => h.remove()).catch(() => undefined);
    };
  }, []);
}
