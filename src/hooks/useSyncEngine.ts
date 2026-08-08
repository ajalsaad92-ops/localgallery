import { useEffect, useState } from "react";
import { liveQuery } from "dexie";
import { photoDb, DEFAULT_SYNC_SETTINGS, type SyncSettings } from "@/lib/photoDb";
import {
  getSyncSettings,
  runSyncCycle,
  setSyncSettings,
  subscribeSync,
  type SyncProgress,
} from "@/lib/syncEngine";
import { LocalGalleryMedia, isNative, setBackgroundSync } from "@/lib/native";

export function useSyncSettings(): SyncSettings {
  const [settings, setSettings] = useState<SyncSettings>(DEFAULT_SYNC_SETTINGS);
  useEffect(() => {
    let alive = true;
    void getSyncSettings().then((s) => alive && setSettings(s));
    const sub = liveQuery(() => photoDb.kv.get("syncSettings")).subscribe({
      next: (raw) => {
        if (!alive) return;
        if (!raw?.value) return setSettings(DEFAULT_SYNC_SETTINGS);
        try {
          setSettings({ ...DEFAULT_SYNC_SETTINGS, ...JSON.parse(raw.value) });
        } catch {
          setSettings(DEFAULT_SYNC_SETTINGS);
        }
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

/**
 * The app-wide sync loop. Mount once.
 *
 * Foreground timers are only a fallback: the real driver on device is the
 * native foreground service, which heartbeats through the plugin because the
 * WebView freezes its own timers as soon as the app leaves the screen.
 */
export function useSyncLoop() {
  const settings = useSyncSettings();
  const autoOn = !settings.paused && settings.mode === "auto";

  // Arm or disarm the resident background watcher to match the setting.
  useEffect(() => {
    void setBackgroundSync(autoOn);
  }, [autoOn]);

  useEffect(() => {
    if (!autoOn) return;
    // Kick a cycle when new device assets land.
    const sub = liveQuery(() =>
      photoDb.assets.where("provider").equals("device").count(),
    ).subscribe({ next: () => { void runSyncCycle(); } });

    const tick = window.setInterval(() => { void runSyncCycle(); }, 60_000);
    return () => { sub.unsubscribe(); window.clearInterval(tick); };
  }, [autoOn]);

  useEffect(() => {
    const on = () => void runSyncCycle();
    window.addEventListener("online", on);
    // Coming back to the app is the one moment a stalled queue must not be
    // left waiting for the next heartbeat.
    const onVisible = () => {
      if (document.visibilityState === "visible") void runSyncCycle();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("online", on);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  // Commands and the background heartbeat coming from the native service.
  useEffect(() => {
    if (!isNative()) return;
    let cleanup: (() => void) | null = null;

    void (async () => {
      try {
        const handle = await LocalGalleryMedia.addListener("syncCommand", ({ action }) => {
          if (action === "pause") void setSyncSettings({ paused: true });
          else if (action === "stop") void setSyncSettings({ paused: true, mode: "manual" });
          else if (action === "resume") {
            void setSyncSettings({ paused: false }).then(() => runSyncCycle());
          } else if (action === "tick") {
            // Heartbeat: JS timers are throttled in the background, so this is
            // what actually keeps the queue moving.
            void runSyncCycle();
          }
        });
        cleanup = () => { void handle.remove(); };
      } catch {
        /* plugin missing (web) */
      }
    })();

    return () => cleanup?.();
  }, []);
}
