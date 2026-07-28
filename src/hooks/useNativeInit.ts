import { useEffect } from "react";
import { App } from "@capacitor/app";
import { StatusBar, Style } from "@capacitor/status-bar";
import { SplashScreen } from "@capacitor/splash-screen";
import { Network } from "@capacitor/network";
import { isNative } from "@/lib/native";
import { runSyncCycle } from "@/lib/syncEngine";
import { canScanDeviceGallery, scanDeviceGallery } from "@/lib/deviceMedia";
import { logNative, logTimeline } from "@/lib/diagnostics";

/** Full-gallery indexing, at most once per app session, never blocking the UI. */
let scanning = false;
async function backgroundScan() {
  if (scanning || !canScanDeviceGallery()) return;
  scanning = true;
  try {
    const inserted = await scanDeviceGallery();
    logNative("scan", `background gallery scan done (+${inserted})`);
    if (inserted > 0) void runSyncCycle().catch(() => undefined);
  } catch (e) {
    logNative("scan", "background gallery scan failed", e);
  } finally {
    scanning = false;
  }
}


export function useNativeInit() {
  useEffect(() => {
    if (!isNative()) return;
    logTimeline("native", "init begin");

    void (async () => {
      try {
        await StatusBar.setOverlaysWebView({ overlay: true }).catch(() => undefined);
        await StatusBar.setStyle({ style: Style.Dark }).catch(() => undefined);
        await StatusBar.setBackgroundColor({ color: "#00000000" }).catch(() => undefined);
      } catch { /* ignore */ }
      void SplashScreen.hide({ fadeOutDuration: 250 }).catch(() => undefined);
    })();

    const runSync = () => { void runSyncCycle().catch(() => undefined); };

    const appSub = App.addListener("appStateChange", (s) => {
      logNative("app", `state ${s.isActive ? "active" : "background"}`);
      if (s.isActive) runSync();
    });
    const netSub = Network.addListener("networkStatusChange", (s) => {
      logNative("network", `${s.connected ? "online" : "offline"} (${s.connectionType})`);
      if (s.connected) runSync();
    });

    return () => {
      void appSub.then((h) => h.remove()).catch(() => undefined);
      void netSub.then((h) => h.remove()).catch(() => undefined);
    };
  }, []);
}
