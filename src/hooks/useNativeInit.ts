import { useEffect } from "react";
import { App } from "@capacitor/app";
import { StatusBar, Style } from "@capacitor/status-bar";
import { SplashScreen } from "@capacitor/splash-screen";
import { Network } from "@capacitor/network";
import { isNative } from "@/lib/native";
import { runSyncCycle } from "@/lib/syncEngine";
import { canScanDeviceGallery, scanDeviceGallery } from "@/lib/deviceMedia";

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

    const appSub = App.addListener("appStateChange", (s) => {
      if (s.isActive) void catchUp();
    });

    const netSub = Network.addListener("networkStatusChange", (s) => {
      if (s.connected) void runSyncCycle();
    });

    return () => {
      window.clearTimeout(first);
      void appSub.then((h) => h.remove()).catch(() => undefined);
      void netSub.then((h) => h.remove()).catch(() => undefined);
    };
  }, []);
}
