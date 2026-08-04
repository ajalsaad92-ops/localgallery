import { Toaster } from "@/components/ui/sonner";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import Index from "./pages/Index";

// One screen, navigated by tabs and the hardware back button. A router would
// only add browser-style history to something that is not a browser.
const App = () => (
  <>
    <ErrorBoundary>
      <Index />
    </ErrorBoundary>
    <Toaster position="top-center" richColors />
  </>
);

export default App;
