import { Cloud, Settings as SettingsIcon, UploadCloud } from "lucide-react";
import { cn } from "@/lib/utils";
import { tap } from "@/lib/native";

export type Tab = "sync" | "telegram" | "settings";

const TABS: { id: Tab; label: string; icon: typeof UploadCloud }[] = [
  { id: "sync", label: "مزامنة", icon: UploadCloud },
  { id: "telegram", label: "معرضي", icon: Cloud },
  { id: "settings", label: "ضبط", icon: SettingsIcon },
];

interface MobileNavProps {
  active: Tab;
  onChange: (t: Tab) => void;
}

export function MobileNav({ active, onChange }: MobileNavProps) {
  return (
    <nav className="fixed bottom-0 left-0 right-0 z-40 safe-bottom px-3 pb-3">
      <div className="mx-auto flex max-w-md items-center gap-1 rounded-full border border-border bg-card/90 p-1.5 shadow-2xl shadow-black/60 backdrop-blur-xl">
        {TABS.map((t) => {
          const Icon = t.icon;
          const on = active === t.id;
          return (
            <button
              key={t.id}
              onClick={() => {
                if (on) return;
                void tap("light");
                onChange(t.id);
              }}
              aria-current={on ? "page" : undefined}
              className={cn(
                "press relative flex flex-1 items-center justify-center gap-2 rounded-full px-3 py-2.5 text-[13px] font-extrabold",
                on
                  ? "bg-hot text-primary-foreground shadow-[var(--shadow-fab)]"
                  : "text-muted-foreground",
              )}
            >
              <Icon className={cn("h-[18px] w-[18px] transition-transform", on && "scale-110")} />
              {t.label}
            </button>
          );
        })}
      </div>
    </nav>
  );
}
