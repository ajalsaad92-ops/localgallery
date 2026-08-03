import { Toaster } from "@/components/ui/sonner";
import Index from "./pages/Index";

// One screen, navigated by tabs and the hardware back button. A router would
// only add browser-style history to something that is not a browser.
const App = () => (
  <>
    <Index />
    <Toaster position="top-center" richColors />
  </>
);

export default App;
