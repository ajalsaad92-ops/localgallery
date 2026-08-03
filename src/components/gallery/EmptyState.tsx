import { Images, type LucideIcon } from "lucide-react";

interface Props {
  title: string;
  body: string;
  icon?: LucideIcon;
  action?: React.ReactNode;
}

export function EmptyState({ title, body, icon: Icon = Images, action }: Props) {
  return (
    <div className="mx-auto mt-6 max-w-md px-6 py-12 text-center">
      <div className="mx-auto mb-5 grid h-16 w-16 place-items-center rounded-2xl bg-hot text-primary-foreground shadow-[var(--shadow-fab)]">
        <Icon className="h-8 w-8" />
      </div>
      <div className="headline mb-2 text-xl">{title}</div>
      <div className="text-sm leading-relaxed text-muted-foreground">{body}</div>
      {action && <div className="mt-6 flex justify-center">{action}</div>}
    </div>
  );
}
