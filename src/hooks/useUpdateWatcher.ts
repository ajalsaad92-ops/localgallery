import { useCallback, useEffect, useState } from "react";
import { checkForUpdate, type UpdateInfo } from "@/lib/ota";
import { notify, prefGet, prefSet } from "@/lib/native";

const LAST_CHECK = "ota:lastCheck";
const NOTIFIED_FOR = "ota:notifiedFor";
const EVERY_MS = 6 * 60 * 60 * 1000;

/**
 * Quietly looks for a newer release and tells the user once per version.
 *
 * Nothing installs on its own — the notification and the in-app banner are
 * both just offers. Deciding when to update stays with the user.
 */
export function useUpdateWatcher() {
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [dismissed, setDismissed] = useState(false);

  const run = useCallback(async (force = false) => {
    try {
      if (!force) {
        const last = Number((await prefGet(LAST_CHECK)) ?? 0);
        if (Date.now() - last < EVERY_MS) return;
      }
      await prefSet(LAST_CHECK, String(Date.now()));

      const info = await checkForUpdate();
      if (!info.available || !info.latestVersion) return;
      setUpdate(info);

      // One notification per version, never a repeat nag.
      if ((await prefGet(NOTIFIED_FOR)) !== info.latestVersion) {
        await prefSet(NOTIFIED_FOR, info.latestVersion);
        void notify(
          `تحديث جديد ${info.latestVersion} ✨`,
          "افتح التطبيق للتثبيت — أنت تقرّر متى.",
        );
      }
    } catch {
      /* offline is normal */
    }
  }, []);

  useEffect(() => {
    // Give the gallery a moment to paint before touching the network.
    const t = window.setTimeout(() => void run(), 6000);
    const id = window.setInterval(() => void run(), EVERY_MS);
    return () => { window.clearTimeout(t); window.clearInterval(id); };
  }, [run]);

  return {
    update: dismissed ? null : update,
    dismiss: () => setDismissed(true),
    recheck: () => run(true),
  };
}
