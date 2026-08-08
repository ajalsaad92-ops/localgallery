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

/*
 * gramjs calls window.alert() from its TypeNotFoundError constructor
 * (telegram/errors/Common.js) — on Android that is a system dialog the user has
 * to dismiss, mid-backup, reading "Missing MTProto Entity … ID 0".
 *
 * ID 0 means the reader hit four zero bytes: the MTProto stream is out of sync
 * and every later response on that socket is suspect. Swallowing the dialog
 * alone would only make the wedge silent, so drop the client too — the next
 * sync cycle builds a fresh one.
 */
window.alert = (message?: unknown) => {
  const text = String(message ?? "");
  console.warn("[suppressed alert]", text);
  if (/MTProto|TL definition/i.test(text)) {
    void import("./lib/providers/mtproto").then((m) => m.resetClient()).catch(() => {});
  }
};

createRoot(document.getElementById("root")!).render(<App />);

void registerSW();
