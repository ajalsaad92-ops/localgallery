import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Keeps one bad render from taking the whole app down.
 *
 * An uncaught error unmounts the React tree, which in a Capacitor shell leaves
 * a blank WebView that reads as "the app closed itself". Showing a recoverable
 * screen instead means a transient failure never looks like a crash.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[app] render failed", error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div
        dir="rtl"
        className="fixed inset-0 z-[100] flex flex-col items-center justify-center gap-4 bg-background p-8 text-center"
      >
        <div className="text-5xl">🙈</div>
        <h1 className="text-lg font-black">حدث خطأ غير متوقع</h1>
        <p className="max-w-xs text-xs leading-relaxed text-muted-foreground">
          صورك وإعداداتك سليمة. أعد المحاولة — وإن تكرر الخطأ أعد تشغيل التطبيق.
        </p>
        <button
          onClick={() => this.setState({ error: null })}
          className="press rounded-full bg-primary px-6 py-3 text-sm font-black text-primary-foreground"
        >
          إعادة المحاولة
        </button>
        <button
          onClick={() => window.location.reload()}
          className="text-xs font-semibold text-muted-foreground underline"
        >
          إعادة تحميل التطبيق
        </button>
      </div>
    );
  }
}
