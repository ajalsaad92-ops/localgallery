// Central diagnostics & runtime telemetry.
//
// Captures a full session log so the user can copy/share a Production-grade
// audit report covering: environment, timeline, touches, permissions, AI ops,
// IndexedDB writes, performance, native events, network calls, and errors.
//
// Ring buffer in-memory + IndexedDB persistence via Dexie (photoDb.kv).

import { photoDb } from "./photoDb";
import { Capacitor } from "@capacitor/core";

export type DiagLevel = "info" | "warn" | "error";
export type DiagCategory =
  | "env"
  | "timeline"
  | "touch"
  | "perm"
  | "ai"
  | "idb"
  | "perf"
  | "native"
  | "net"
  | "sync"
  | "tg"
  | "error"
  | "app";


export interface DiagEntry {
  ts: number;
  level: DiagLevel;
  scope: string;
  message: string;
  detail?: string;
  category?: DiagCategory;
}

const BUFFER_MAX = 500;
const KV_KEY = "diagnostics:log";
const KV_ENV_KEY = "diagnostics:env";
const buffer: DiagEntry[] = [];
const listeners = new Set<(entries: DiagEntry[]) => void>();
let hydrated = false;
let persistTimer: number | null = null;
let sessionStart = Date.now();
let envSnapshot: Record<string, unknown> = {};

function emit() {
  const snap = [...buffer];
  for (const l of listeners) l(snap);
}

function schedulePersist() {
  if (persistTimer != null) return;
  persistTimer = window.setTimeout(async () => {
    persistTimer = null;
    try {
      await photoDb.kv.put({ key: KV_KEY, value: JSON.stringify(buffer.slice(-BUFFER_MAX)) });
    } catch { /* ignore */ }
  }, 800);
}

async function hydrate() {
  if (hydrated) return;
  hydrated = true;
  try {
    const row = await photoDb.kv.get(KV_KEY);
    if (row?.value) {
      const parsed = JSON.parse(row.value) as DiagEntry[];
      if (Array.isArray(parsed)) buffer.push(...parsed.slice(-BUFFER_MAX));
      emit();
    }
    const env = await photoDb.kv.get(KV_ENV_KEY);
    if (env?.value) envSnapshot = JSON.parse(env.value);
  } catch { /* ignore */ }
}

function safeStringify(v: unknown) {
  try { return JSON.stringify(v, null, 2); } catch { return String(v); }
}

/**
 * Describe anything the console was given. Plain JSON.stringify turns Errors,
 * DOM events and Capacitor rejections into a useless "{}" because their fields
 * are non-enumerable — this digs the real message out instead.
 */
export function describeValue(v: unknown, depth = 0): string {
  if (v == null) return String(v);
  if (typeof v === "string") return v;
  if (typeof v !== "object") return String(v);

  if (v instanceof Error) {
    const extra = Object.getOwnPropertyNames(v)
      .filter((k) => !["name", "message", "stack"].includes(k))
      .map((k) => `${k}=${String((v as unknown as Record<string, unknown>)[k])}`)
      .join(" ");
    return `${v.name}: ${v.message}${extra ? ` (${extra})` : ""}${v.stack ? `\n${v.stack}` : ""}`;
  }
  if (typeof ErrorEvent !== "undefined" && v instanceof ErrorEvent) {
    return `ErrorEvent: ${v.message} @ ${v.filename}:${v.lineno}:${v.colno}${v.error ? `\n${describeValue(v.error, depth + 1)}` : ""}`;
  }
  if (typeof PromiseRejectionEvent !== "undefined" && v instanceof PromiseRejectionEvent) {
    return `UnhandledRejection: ${describeValue(v.reason, depth + 1)}`;
  }
  if (typeof Event !== "undefined" && v instanceof Event) {
    const t = v.target as { src?: string; currentSrc?: string; tagName?: string } | null;
    return `Event<${v.type}>${t?.tagName ? ` on ${t.tagName.toLowerCase()}` : ""}${t?.currentSrc || t?.src ? ` src=${t.currentSrc || t.src}` : ""}`;
  }

  const obj = v as Record<string, unknown>;
  // Capacitor / fetch style rejections: keep the useful fields even when the
  // object is otherwise empty.
  const known = ["message", "errorMessage", "error", "code", "status", "statusText", "name", "data"]
    .filter((k) => obj[k] != null)
    .map((k) => `${k}: ${typeof obj[k] === "object" && depth < 2 ? describeValue(obj[k], depth + 1) : String(obj[k])}`);
  if (known.length) return known.join(" · ");

  const json = safeStringify(v);
  if (json && json !== "{}") return json;
  // Truly opaque object — fall back to whatever its own props / toString say.
  const props = Object.getOwnPropertyNames(v);
  if (props.length) {
    return props.slice(0, 12)
      .map((k) => { try { return `${k}: ${String(obj[k])}`; } catch { return `${k}: ?`; } })
      .join(" · ");
  }
  const s = Object.prototype.toString.call(v);
  try { const own = String(v); if (own !== "[object Object]") return own; } catch { /* ignore */ }
  return s;
}


export function logDiag(
  level: DiagLevel,
  scope: string,
  message: string,
  detail?: unknown,
  category: DiagCategory = "app",
) {
  // Info is normally console-only so the phone stays responsive, BUT the
  // sync + telegram flows are always recorded: they are the two things the
  // user needs a precise trace of when nothing shows up / nothing uploads.
  const keepInfo = category === "sync" || category === "tg";
  if (level === "info" && !keepInfo) {
    // eslint-disable-next-line no-console
    console.log(`[${category}·${scope}]`, message, detail ?? "");
    return;
  }

  const entry: DiagEntry = {
    ts: Date.now(),
    level,
    scope,
    message,
    category,
    detail: detail == null ? undefined : detail instanceof Error
      ? `${detail.name}: ${detail.message}\n${detail.stack ?? ""}`
      : typeof detail === "string" ? detail : safeStringify(detail),
  };
  buffer.push(entry);
  if (buffer.length > BUFFER_MAX) buffer.splice(0, buffer.length - BUFFER_MAX);
  // eslint-disable-next-line no-console
  console[level === "error" ? "error" : level === "warn" ? "warn" : "log"](
    `[${category}·${scope}]`, message, detail ?? "",
  );

  emit();
  schedulePersist();
}

// Category helpers -----------------------------------------------------------
export const logTimeline = (scope: string, msg: string, d?: unknown) => logDiag("info", scope, msg, d, "timeline");
export const logTouch    = (scope: string, msg: string, d?: unknown) => logDiag("info", scope, msg, d, "touch");
export const logPerm     = (scope: string, msg: string, d?: unknown, lvl: DiagLevel = "info") => logDiag(lvl, scope, msg, d, "perm");
export const logAI       = (scope: string, msg: string, d?: unknown, lvl: DiagLevel = "info") => logDiag(lvl, scope, msg, d, "ai");
export const logIdb      = (scope: string, msg: string, d?: unknown, lvl: DiagLevel = "info") => logDiag(lvl, scope, msg, d, "idb");
export const logPerf     = (scope: string, msg: string, d?: unknown) => logDiag("info", scope, msg, d, "perf");
export const logNative   = (scope: string, msg: string, d?: unknown) => logDiag("info", scope, msg, d, "native");
export const logNet      = (scope: string, msg: string, d?: unknown, lvl: DiagLevel = "info") => logDiag(lvl, scope, msg, d, "net");
export const logError    = (scope: string, msg: string, d?: unknown) => logDiag("error", scope, msg, d, "error");
/** Sync-engine trace — always kept, even at info level. */
export const logSync     = (scope: string, msg: string, d?: unknown, lvl: DiagLevel = "info") => logDiag(lvl, scope, msg, d, "sync");
/** Telegram (bot + personal account) trace — always kept, even at info level. */
export const logTg       = (scope: string, msg: string, d?: unknown, lvl: DiagLevel = "info") => logDiag(lvl, scope, msg, d, "tg");


// Small helper for timed operations. Usage: const t = mark(); ...; logPerf("ocr","done",{ms:t()})
export function mark(): () => number {
  const start = performance.now();
  return () => Math.round(performance.now() - start);
}

// Public subscription -------------------------------------------------------
export function subscribeDiagnostics(cb: (entries: DiagEntry[]) => void) {
  void hydrate();
  cb([...buffer]);
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

export function getDiagnostics(): DiagEntry[] { return [...buffer]; }

export async function clearDiagnostics() {
  buffer.length = 0;
  try { await photoDb.kv.delete(KV_KEY); } catch { /* ignore */ }
  emit();
}

// ---------- Environment metadata -------------------------------------------
async function captureEnvironment(): Promise<Record<string, unknown>> {
  const nav = (typeof navigator !== "undefined" ? navigator : ({} as Navigator));
  const scr = typeof screen !== "undefined" ? screen : ({} as Screen);
  const mem = (performance as unknown as { memory?: { jsHeapSizeLimit: number; totalJSHeapSize: number; usedJSHeapSize: number } }).memory;
  const conn = (nav as Navigator & { connection?: { effectiveType?: string; downlink?: number; rtt?: number; saveData?: boolean } }).connection;

  const env: Record<string, unknown> = {
    generatedAt: new Date().toISOString(),
    sessionId: sessionStart,
    ua: nav.userAgent ?? "",
    platform: Capacitor.getPlatform?.() ?? nav.platform ?? "",
    isNative: Capacitor.isNativePlatform?.() ?? false,
    language: nav.language ?? "",
    languages: nav.languages ?? [],
    online: nav.onLine,
    hardwareConcurrency: (nav as Navigator).hardwareConcurrency,
    deviceMemoryGB: (nav as Navigator & { deviceMemory?: number }).deviceMemory,
    screen: {
      width: scr.width, height: scr.height,
      availWidth: scr.availWidth, availHeight: scr.availHeight,
      dpr: window.devicePixelRatio, colorDepth: scr.colorDepth,
      orientation: (scr.orientation && { type: scr.orientation.type, angle: scr.orientation.angle }) || undefined,
    },
    viewport: { w: window.innerWidth, h: window.innerHeight },
    connection: conn ? { effectiveType: conn.effectiveType, downlink: conn.downlink, rtt: conn.rtt, saveData: conn.saveData } : undefined,
    memory: mem ? { usedMB: Math.round(mem.usedJSHeapSize / 1048576), totalMB: Math.round(mem.totalJSHeapSize / 1048576), limitMB: Math.round(mem.jsHeapSizeLimit / 1048576) } : undefined,
    storage: undefined as unknown,
    battery: undefined as unknown,
    build: {
      mode: import.meta.env?.MODE,
      dev: import.meta.env?.DEV,
      prod: import.meta.env?.PROD,
    },
  };

  try {
    const est = await (nav.storage?.estimate?.() ?? Promise.resolve(undefined));
    if (est) env.storage = { quotaMB: Math.round((est.quota ?? 0) / 1048576), usageMB: Math.round((est.usage ?? 0) / 1048576) };
  } catch { /* ignore */ }

  try {
    const bat = await (nav as Navigator & { getBattery?: () => Promise<{ level: number; charging: boolean }> }).getBattery?.();
    if (bat) env.battery = { level: Math.round(bat.level * 100), charging: bat.charging };
  } catch { /* ignore */ }

  try {
    // Optional Capacitor Device plugin — only if installed
    const mod = await import(/* @vite-ignore */ "@capacitor/device").catch(() => null);
    if (mod?.Device) {
      const info = await mod.Device.getInfo();
      const battery = await mod.Device.getBatteryInfo().catch(() => undefined);
      env.device = { ...info };
      if (battery) env.battery = { level: Math.round((battery.batteryLevel ?? 0) * 100), charging: battery.isCharging };
    }
  } catch { /* ignore */ }

  envSnapshot = env;
  try { await photoDb.kv.put({ key: KV_ENV_KEY, value: JSON.stringify(env) }); } catch { /* ignore */ }
  return env;
}

export function getEnvironmentSnapshot(): Record<string, unknown> { return { ...envSnapshot }; }

// ---------- Report builder --------------------------------------------------
function fmtTs(ts: number): string {
  const rel = Math.max(0, ts - sessionStart);
  const mm = String(Math.floor(rel / 60000)).padStart(2, "0");
  const ss = String(Math.floor((rel % 60000) / 1000)).padStart(2, "0");
  const ms = String(rel % 1000).padStart(3, "0");
  return `[${mm}:${ss}.${ms}]`;
}

function section(title: string, lines: string[]): string {
  return `\n## ${title}\n${lines.length ? lines.join("\n") : "(none)"}\n`;
}

function renderEntries(entries: DiagEntry[]): string[] {
  return entries.map((e) => {
    const detail = e.detail ? `\n    ${e.detail.replace(/\n/g, "\n    ")}` : "";
    return `${fmtTs(e.ts)} ${e.level.toUpperCase().padEnd(5)} ${e.scope}: ${e.message}${detail}`;
  });
}

export function buildDiagnosticsReport(): string {
  const byCat = (c: DiagCategory) => buffer.filter((e) => e.category === c);
  const counts = {
    total: buffer.length,
    errors: buffer.filter((e) => e.level === "error").length,
    warns: buffer.filter((e) => e.level === "warn").length,
  };

  const header = [
    `# LocalGallery Pro — Runtime Telemetry Report`,
    `Generated: ${new Date().toISOString()}`,
    `Session started: ${new Date(sessionStart).toISOString()}`,
    `Duration: ${Math.round((Date.now() - sessionStart) / 1000)}s`,
    `Entries: ${counts.total} (errors: ${counts.errors}, warns: ${counts.warns})`,
    "",
  ].join("\n");

  return header
    + section("1. Environment Metadata", [safeStringify(envSnapshot)])
    + section("2. Timeline Log", renderEntries(byCat("timeline")))
    + section("3. Touch / Interaction Log", renderEntries(byCat("touch")))
    + section("4. Permissions Log", renderEntries(byCat("perm")))
    + section("5. AI Processing Log", renderEntries(byCat("ai")))
    + section("6. IndexedDB Activity Log", renderEntries(byCat("idb")))
    + section("7. Performance Log", renderEntries(byCat("perf")))
    + section("8. Native Behavior Log", renderEntries(byCat("native")))
    + section("9. Network Log", renderEntries(byCat("net")))
    + section("9a. Sync Engine Trace", renderEntries(byCat("sync")))
    + section("9b. Telegram Trace", renderEntries(byCat("tg")))

    + section("10. Error Log", renderEntries(byCat("error").concat(buffer.filter((e) => e.level === "error" && e.category !== "error"))))
    + section("Appendix: Full Chronological Log", renderEntries(buffer));
}

// ---------- Global installers ----------------------------------------------
let installed = false;
export function installGlobalDiagHandlers() {
  if (installed || typeof window === "undefined") return;
  installed = true;
  sessionStart = Date.now();

  void hydrate();
  void captureEnvironment().then((env) => logDiag("info", "env", "environment captured", env, "env"));

  // Errors ------------------------------------------------------------------
  window.addEventListener("error", (e) => {
    logDiag("error", "window", e.message || "unknown error", e.error ?? e.filename, "error");
  });
  window.addEventListener("unhandledrejection", (e) => {
    logDiag("error", "promise", "unhandled rejection", e.reason, "error");
  });

  // Console mirroring (warn + error only, to avoid recursion floods) --------
  const origWarn = console.warn.bind(console);
  const origErr = console.error.bind(console);
  console.warn = (...args: unknown[]) => {
    origWarn(...args);
    try {
      const msg = args.map((a) => (typeof a === "string" ? a : safeStringify(a))).join(" ");
      if (!msg.includes("[") || !msg.includes("·")) {
        buffer.push({ ts: Date.now(), level: "warn", scope: "console", message: msg.slice(0, 500), category: "error" });
        emit(); schedulePersist();
      }
    } catch { /* ignore */ }
  };
  console.error = (...args: unknown[]) => {
    origErr(...args);
    try {
      const msg = args.map((a) => (typeof a === "string" ? a : safeStringify(a))).join(" ");
      if (!msg.includes("[") || !msg.includes("·")) {
        buffer.push({ ts: Date.now(), level: "error", scope: "console", message: msg.slice(0, 500), category: "error" });
        emit(); schedulePersist();
      }
    } catch { /* ignore */ }
  };

  // Touch / click -----------------------------------------------------------
  const describeTarget = (t: EventTarget | null): string => {
    if (!(t instanceof Element)) return "unknown";
    const tag = t.tagName.toLowerCase();
    const id = t.id ? `#${t.id}` : "";
    const cls = typeof t.className === "string" && t.className ? `.${t.className.trim().split(/\s+/).slice(0, 2).join(".")}` : "";
    const label = t.getAttribute("aria-label") || t.getAttribute("title") || (t.textContent || "").trim().slice(0, 40);
    return `${tag}${id}${cls}${label ? ` "${label}"` : ""}`;
  };
  // Dedupe pointerdown + synthetic click so a single tap doesn't consume two
  // ring-buffer slots and starve AI/pipeline entries.
  let lastPointerAt = 0;
  window.addEventListener("pointerdown", (e) => {
    lastPointerAt = Date.now();
    logTouch("pointer", `${e.pointerType} @(${Math.round(e.clientX)},${Math.round(e.clientY)})`, describeTarget(e.target));
  }, { passive: true, capture: true });
  window.addEventListener("click", (e) => {
    if (Date.now() - lastPointerAt < 800) return;
    logTouch("click", `@(${Math.round(e.clientX)},${Math.round(e.clientY)})`, describeTarget(e.target));
  }, { capture: true });

  // Visibility / lifecycle --------------------------------------------------
  document.addEventListener("visibilitychange", () => {
    logTimeline("visibility", document.visibilityState);
  });
  window.addEventListener("pageshow", () => logTimeline("lifecycle", "pageshow"));
  window.addEventListener("pagehide", () => logTimeline("lifecycle", "pagehide"));
  window.addEventListener("resize", () => logTimeline("viewport", `resize ${window.innerWidth}x${window.innerHeight}`));
  screen.orientation?.addEventListener?.("change", () => logNative("orientation", screen.orientation.type));

  // Network egress ----------------------------------------------------------
  const origFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method || (input instanceof Request ? input.method : "GET")).toUpperCase();
    const start = performance.now();
    try {
      const res = await origFetch(input as RequestInfo, init);
      const dur = Math.round(performance.now() - start);
      logNet("fetch", `${method} ${res.status} ${url} (${dur}ms)`, undefined, res.ok ? "info" : "warn");
      return res;
    } catch (err) {
      const dur = Math.round(performance.now() - start);
      logNet("fetch", `${method} FAIL ${url} (${dur}ms)`, err, "error");
      throw err;
    }
  };

  // XHR wrap ----------------------------------------------------------------
  try {
    const OrigXHR = window.XMLHttpRequest;
    const wrap = function () {
      const xhr = new OrigXHR();
      let _url = ""; let _method = "GET"; let _start = 0;
      const origOpen = xhr.open;
      xhr.open = function (m: string, u: string, ...rest: unknown[]) {
        _method = m.toUpperCase(); _url = u;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return origOpen.call(this, m, u, ...(rest as any));
      } as typeof xhr.open;
      xhr.addEventListener("loadstart", () => { _start = performance.now(); });
      xhr.addEventListener("loadend", () => {
        const dur = Math.round(performance.now() - _start);
        logNet("xhr", `${_method} ${xhr.status} ${_url} (${dur}ms)`, undefined, xhr.status >= 400 || xhr.status === 0 ? "warn" : "info");
      });
      return xhr;
    } as unknown as typeof XMLHttpRequest;
    window.XMLHttpRequest = wrap;
  } catch { /* ignore */ }

  // Periodic memory sample --------------------------------------------------
  const memInterval = window.setInterval(() => {
    const mem = (performance as unknown as { memory?: { usedJSHeapSize: number; totalJSHeapSize: number } }).memory;
    if (mem) logPerf("memory", `used ${Math.round(mem.usedJSHeapSize / 1048576)}MB / total ${Math.round(mem.totalJSHeapSize / 1048576)}MB`);
  }, 15000);
  window.addEventListener("beforeunload", () => window.clearInterval(memInterval));

  logDiag("info", "app", "diagnostics initialized", { session: new Date(sessionStart).toISOString() }, "app");
  logTimeline("app", "launch");
}
