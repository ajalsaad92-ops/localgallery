import { useEffect, useState } from "react";
import { liveQuery } from "dexie";
import {
  photoDb,
  DEFAULT_SYNC_SETTINGS,
  type SyncSettings,
} from "@/lib/photoDb";
import {
  getSyncSettings,
  runSyncCycle,
  subscribeSync,
  type SyncProgress,
} from "@/lib/syncEngine";

export function useSyncSettings(): SyncSettings {
  const [settings, setSettings] = useState<SyncSettings>(DEFAULT_SYNC_SETTINGS);
  useEffect(() => {
    let alive = true;
    void getSyncSettings().then((s) => alive && setSettings(s));
    const sub = liveQuery(() => photoDb.kv.get("syncSettings")).subscribe({
      next: (raw) => {
        if (!alive) return;
        if (!raw?.value) return setSettings(DEFAULT_SYNC_SETTINGS);
        try { setSettings({ ...DEFAULT_SYNC_SETTINGS, ...JSON.parse(raw.value) }); }
        catch { setSettings(DEFAULT_SYNC_SETTINGS); }
      },
    });
    return () => { alive = false; sub.unsubscribe(); };
  }, []);
  return settings;
}

export function useSyncProgress(): SyncProgress {
  const [p, setP] = useState<SyncProgress>({ running: false, total: 0, done: 0, failed: 0 });
  useEffect(() => subscribeSync(setP), []);
  return p;
}

/** Long-lived sync loop. Mount once. */
export function useSyncLoop() {
  const settings = useSyncSettings();
  useEffect(() => {
    if (settings.paused || settings.mode !== "auto") return;
    // Trigger when new device assets appear.
    const sub = liveQuery(() =>
      photoDb.assets.where("provider").equals("device").count(),
    ).subscribe({
      next: () => { void runSyncCycle(); },
    });
    // Periodic tick so uploads resume even without new imports (e.g. after
    // network came back, or a failed cycle left items behind).
    const tick = window.setInterval(() => { void runSyncCycle(); }, 60_000);
    return () => { sub.unsubscribe(); window.clearInterval(tick); };
  }, [settings.paused, settings.mode]);

  useEffect(() => {
    const on = () => void runSyncCycle();
    window.addEventListener("online", on);
    return () => window.removeEventListener("online", on);
  }, []);

  // Listen for pause/resume/stop actions coming from the persistent notification.
  useEffect(() => {
    let cleanup: (() => void) | null = null;
    (async () => {
      try {
        const { Capacitor } = await import("@capacitor/core");
        if (!Capacitor.isNativePlatform()) return;
        // Reuse the single registration from native.ts — registering the same
        // plugin name twice makes Capacitor warn and ignore this instance.
        const { LocalGalleryMedia } = await import("@/lib/native");
        const handle = await LocalGalleryMedia.addListener("syncCommand", async ({ action }) => {
          const { setSyncSettings, runSyncCycle } = await import("@/lib/syncEngine");
          if (action === "pause") await setSyncSettings({ paused: true });
          else if (action === "resume") { await setSyncSettings({ paused: false }); void runSyncCycle(); }
          else if (action === "stop") await setSyncSettings({ paused: true });
        });
        cleanup = () => { void handle.remove(); };
      } catch { /* web / plugin missing */ }
    })();
    return () => { cleanup?.(); };
  }, []);
}


