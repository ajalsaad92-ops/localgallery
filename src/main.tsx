import { Buffer } from "buffer";
import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./index.css";
import { registerSW } from "./lib/pwa/registerSW";
import { installGlobalDiagHandlers } from "./lib/diagnostics";

// MTProto (gramjs) expects Node-style globals in the browser/WebView.
const g = globalThis as unknown as { Buffer?: typeof Buffer; global?: unknown };
if (!g.Buffer) g.Buffer = Buffer;
if (!g.global) g.global = globalThis;


installGlobalDiagHandlers();
createRoot(document.getElementById("root")!).render(<App />);

void registerSW();

