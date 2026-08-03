import { Buffer } from "buffer";
import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./index.css";
import { registerSW } from "./lib/pwa/registerSW";

// MTProto (gramjs) expects Node-style globals in the browser/WebView.
const g = globalThis as unknown as { Buffer?: typeof Buffer; global?: unknown };
if (!g.Buffer) g.Buffer = Buffer;
if (!g.global) g.global = globalThis;

// An unhandled rejection can tear down the Android WebView. Nothing in this app
// depends on one propagating, so swallow it and keep the UI alive.
window.addEventListener("unhandledrejection", (e) => e.preventDefault());

createRoot(document.getElementById("root")!).render(<App />);

void registerSW();
