import { useCallback, useState } from "react";
import { MobileNav, type Tab } from "@/components/gallery/MobileNav";
import { SyncScreen } from "@/components/gallery/SyncScreen";
import { TelegramScreen } from "@/components/gallery/TelegramScreen";
import { SettingsPage } from "@/components/gallery/SettingsPage";
import { PermissionsWizard } from "@/components/gallery/PermissionsWizard";
import { useSyncLoop } from "@/hooks/useSyncEngine";
import { useNativeInit } from "@/hooks/useNativeInit";
import { useBackButton } from "@/hooks/useBackButton";

const TAB_KEY = "ui:activeTab";

function loadTab(): Tab {
  try {
    const v = localStorage.getItem(TAB_KEY);
    if (v === "sync" || v === "telegram" || v === "settings") return v;
  } catch {
    /* noop */
  }
  return "sync";
}

const Index = () => {
  const [tab, setTabState] = useState<Tab>(loadTab);
  const [selecting, setSelecting] = useState(false);
  useSyncLoop();
  useNativeInit();

  const setTab = useCallback((next: Tab) => {
    setTabState(next);
    try {
      localStorage.setItem(TAB_KEY, next);
    } catch {
      /* noop */
    }
  }, []);

  const back = useCallback(() => {
    if (tab !== "sync") {
      setTab("sync");
      return true;
    }
    return false;
  }, [tab, setTab]);
  useBackButton(back);

  return (
    <div className="min-h-screen bg-background text-foreground" dir="rtl">
      <main className="min-h-screen">
        {/* Both feeds stay mounted so scroll position survives tab switches. */}
        <div style={{ display: tab === "sync" ? "block" : "none" }}>
          <SyncScreen onSelectionChange={setSelecting} />
        </div>
        <div style={{ display: tab === "telegram" ? "block" : "none" }}>
          <TelegramScreen />
        </div>
        {tab === "settings" && <SettingsPage onBack={() => setTab("sync")} />}
      </main>

      {/* The selection bar takes the tab bar's place while items are picked. */}
      {tab !== "settings" && !selecting && <MobileNav active={tab} onChange={setTab} />}
      <PermissionsWizard />
    </div>
  );
};

export default Index;
