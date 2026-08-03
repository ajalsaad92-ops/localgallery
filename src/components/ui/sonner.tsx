import { Toaster as Sonner } from "sonner";

type ToasterProps = React.ComponentProps<typeof Sonner>;

const Toaster = (props: ToasterProps) => (
  <Sonner
    theme="dark"
    position="top-center"
    duration={3200}
    style={{ marginTop: "env(safe-area-inset-top)" }}
    toastOptions={{
      classNames: {
        toast:
          "group toast rounded-2xl border-border bg-card text-foreground shadow-2xl shadow-black/50",
        description: "text-muted-foreground",
        actionButton: "bg-primary text-primary-foreground",
        cancelButton: "bg-muted text-muted-foreground",
      },
    }}
    {...props}
  />
);

export { Toaster };
