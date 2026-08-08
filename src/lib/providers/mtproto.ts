/**
 * Telegram user-account login (MTProto) — runs fully inside the app.
 * Nothing is sent anywhere except Telegram's own servers.
 * The session string is stored locally in IndexedDB (kv table).
 */
import { photoDb, MAX_UPLOAD_MB } from "@/lib/photoDb";
import { parseCaptionKey, resolveOriginalDate } from "@/lib/captionMeta";
import { LARGE_FILE_THRESHOLD, MAX_UPLOADABLE_BYTES, forEachPart } from "@/lib/uploadParts";



const KEY_SESSION = "tg:user:session";
const KEY_API = "tg:user:api";

export interface MtprotoCreds {
  apiId: number;
  apiHash: string;
}

export interface MtprotoAccount {
  id: string;
  firstName?: string;
  username?: string;
  phone?: string;
}

export async function getSavedCreds(): Promise<MtprotoCreds | null> {
  const raw = await photoDb.kv.get(KEY_API);
  if (!raw?.value) return null;
  try {
    const v = JSON.parse(raw.value) as MtprotoCreds;
    return v.apiId && v.apiHash ? v : null;
  } catch {
    return null;
  }
}

export async function saveCreds(creds: MtprotoCreds) {
  await photoDb.kv.put({ key: KEY_API, value: JSON.stringify(creds) });
}

export async function getSavedSession(): Promise<string | null> {
  const raw = await photoDb.kv.get(KEY_SESSION);
  return raw?.value || null;
}

export async function clearAccount() {
  await photoDb.kv.delete(KEY_SESSION);
  cached = null;
  entityCache = null;
}

// --- client -----------------------------------------------------------------
type AnyClient = {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  invoke(req: unknown): Promise<unknown>;
  sendCode(
    creds: { apiId: number; apiHash: string },
    phone: string,
  ): Promise<{ phoneCodeHash: string; isCodeViaApp: boolean }>;
  getMe(): Promise<{ id: unknown; firstName?: string; username?: string; phone?: string }>;
  session: { save(): string };
};

let cached: AnyClient | null = null;
// Ticks fire every few seconds; a slow reconnect would otherwise let two
// of them build separate clients and open two sessions on one account.
let connecting: Promise<AnyClient | null> | null = null;

async function buildClient(session: string, creds: MtprotoCreds): Promise<AnyClient> {
  const { TelegramClient } = await import("telegram");
  const { StringSession } = await import("telegram/sessions");
  return new TelegramClient(new StringSession(session), creds.apiId, creds.apiHash, {
    // Locking the screen puts the device into Doze and the socket is dropped.
    // Three attempts used to exhaust themselves in seconds and leave the client
    // permanently dead; keep retrying with a real backoff instead.
    connectionRetries: 100,
    retryDelay: 2000,
    autoReconnect: true,
    useWSS: true,
    // Uploads are what matter here — don't let a stalled request block them.
    requestRetries: 5,
    timeout: 30,
  }) as unknown as AnyClient;
}

/** gramjs exposes `connected`; treat anything else as unusable. */
function isAlive(c: AnyClient | null): boolean {
  return !!c && (c as unknown as { connected?: boolean }).connected === true;
}

async function persist(client: AnyClient) {
  await photoDb.kv.put({ key: KEY_SESSION, value: client.session.save() });
}

/** Returns a connected client for an already-authorized account, or null. */
/**
 * A connected client, or null when no account is linked.
 *
 * The cached instance is verified every time. Locking the screen drops the
 * socket, and the previous version handed the dead client back forever after —
 * so uploads stopped the first time the phone slept and never resumed until
 * the app was force-restarted. Reconnect, and rebuild if that fails.
 */
export async function getClient(): Promise<AnyClient | null> {
  if (connecting) return connecting;
  connecting = acquireClient().finally(() => { connecting = null; });
  return connecting;
}

async function acquireClient(): Promise<AnyClient | null> {
  if (cached) {
    if (isAlive(cached)) return cached;
    try {
      await cached.connect();
      if (isAlive(cached)) return cached;
    } catch {
      /* fall through to a fresh client */
    }
    try { await cached.disconnect(); } catch { /* ignore */ }
    cached = null;
  }

  const creds = await getSavedCreds();
  const session = await getSavedSession();
  if (!creds || !session) return null;

  const client = await buildClient(session, creds);
  await client.connect();
  if (!isAlive(client)) return null;
  cached = client;
  return client;
}

/** Drops the cached client so the next call reconnects from scratch. */
export async function resetClient() {
  const c = cached;
  cached = null;
  connecting = null;
  try { await c?.disconnect(); } catch { /* ignore */ }
}

export async function currentAccount(): Promise<MtprotoAccount | null> {
  try {
    const client = await getClient();
    if (!client) return null;
    const me = await client.getMe();
    return {
      id: String(me.id),
      firstName: me.firstName,
      username: me.username,
      phone: me.phone,
    };
  } catch {
    return null;
  }
}

// --- login flow -------------------------------------------------------------
let pending: { client: AnyClient; phone: string; hash: string } | null = null;

export async function requestCode(creds: MtprotoCreds, phone: string) {
  await saveCreds(creds);
  const client = await buildClient("", creds);
  await client.connect();
  const res = await client.sendCode(creds, phone);
  pending = { client, phone, hash: res.phoneCodeHash };
  return { viaApp: res.isCodeViaApp };
}

/** @returns "ok" when signed in, "password" when 2FA is required. */
export async function submitCode(code: string): Promise<"ok" | "password"> {
  if (!pending) throw new Error("ابدأ بطلب رمز التحقق أولاً");
  const { Api } = await import("telegram");
  try {
    await pending.client.invoke(
      new Api.auth.SignIn({
        phoneNumber: pending.phone,
        phoneCodeHash: pending.hash,
        phoneCode: code.trim(),
      }),
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("SESSION_PASSWORD_NEEDED")) return "password";
    throw e;
  }
  await finish();
  return "ok";
}

export async function submitPassword(password: string) {
  if (!pending) throw new Error("ابدأ بطلب رمز التحقق أولاً");
  const { Api } = await import("telegram");
  const { computeCheck } = await import("telegram/Password");
  const pwd = await pending.client.invoke(new Api.account.GetPassword());
  await pending.client.invoke(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    new Api.auth.CheckPassword({ password: await computeCheck(pwd as any, password) }),
  );
  await finish();
}

async function finish() {
  if (!pending) return;
  await persist(pending.client);
  cached = pending.client;
  pending = null;
}

export async function logout() {
  try {
    const client = await getClient();
    if (client) {
      const { Api } = await import("telegram");
      await client.invoke(new Api.auth.LogOut());
      await client.disconnect();
    }
  } catch {
    /* best-effort */
  }
  await clearAccount();
}

// --- target channel / group --------------------------------------------------
const KEY_TARGET = "tg:user:target";

export interface MtTarget {
  id: string;
  title: string;
  username?: string;
}

export async function getSavedTarget(): Promise<MtTarget | null> {
  const raw = await photoDb.kv.get(KEY_TARGET);
  if (!raw?.value) return null;
  try { return JSON.parse(raw.value) as MtTarget; } catch { return null; }
}

export async function saveTarget(t: MtTarget | null) {
  entityCache = null;
  if (!t) await photoDb.kv.delete(KEY_TARGET);
  else await photoDb.kv.put({ key: KEY_TARGET, value: JSON.stringify(t) });
}

/** All channels/groups (and Saved Messages) the account can post media to. */
export async function listTargets(): Promise<MtTarget[]> {
  const client = await getClient();
  if (!client) throw new Error("لم يتم ربط الحساب الشخصي بعد");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dialogs = await (client as any).getDialogs({ limit: 200 });
  const out: MtTarget[] = [];
  const seen = new Set<string>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const d of dialogs as any[]) {
    const e = d.entity;
    if (!e) continue;
    const isChannel = d.isChannel || d.isGroup;
    const isMe = d.isUser && e.self;
    if (!isChannel && !isMe) continue;
    if (isChannel && e.broadcast && e.adminRights == null && !e.creator) continue;
    const id = String(e.id);
    if (seen.has(id)) continue; // a chat can surface twice (folders/archive)
    seen.add(id);
    out.push({
      id,
      title: isMe ? "الرسائل المحفوظة" : (d.title || e.title || e.username || id),
      username: e.username ?? undefined,
    });
  }
  return out;
}

/**
 * Last resolved channel, kept because every upload needs it.
 *
 * With a hundred files in flight this was a hundred resolve calls per pass —
 * a good way to earn a FLOOD_WAIT before a single byte is sent. The entity
 * carries an account-scoped access hash, so it stays valid across reconnects;
 * only a different account or channel invalidates it.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let entityCache: { id: string; entity: any } | null = null;

/** Resolve a stored target id back into a usable entity (cache-aware). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function resolveEntity(client: any, target: MtTarget): Promise<any> {
  if (entityCache && entityCache.id === target.id) return entityCache.entity;
  const entity = await resolveEntityUncached(client, target);
  entityCache = { id: target.id, entity };
  return entity;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function resolveEntityUncached(client: any, target: MtTarget): Promise<any> {
  try {
    if (target.username) return await client.getEntity(target.username);
    return await client.getEntity(BigInt(target.id));
  } catch {
    // Entity not in the session cache yet — walk dialogs once to warm it up.
    const dialogs = await client.getDialogs({ limit: 200 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const hit = (dialogs as any[]).find((d) => d.entity && String(d.entity.id) === target.id);
    if (!hit) throw new Error("تعذر الوصول إلى القناة المختارة");
    return hit.entity;
  }
}

// --- flood-wait pressure ------------------------------------------------------
// Telegram answers "too many requests" with FLOOD_WAIT_<seconds>. The uploader
// waits it out silently, but the sync engine needs to know it happened so it
// can send fewer files at once on the next pass — otherwise raising the
// parallel limit makes the backup *slower* and looks like a hang.
let floodHits = 0;

/** Flood-waits seen since the last call, then resets the counter. */
export function takeFloodPressure(): number {
  const n = floodHits;
  floodHits = 0;
  return n;
}

function floodSeconds(e: unknown): number | null {
  const seconds = (e as { seconds?: number })?.seconds;
  if (typeof seconds === "number" && seconds > 0) return seconds;
  const msg = e instanceof Error ? e.message : String(e ?? "");
  const m = msg.match(/FLOOD_WAIT_(\d+)/);
  return m ? Number(m[1]) : null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Send one file part, retrying the way gramjs does internally.
 *
 * A dropped socket is not an error here: the client reconnects on its own, so
 * the part is simply sent again. Only a genuine RPC failure propagates.
 */
async function sendPart(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  c: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  request: any,
): Promise<void> {
  let netRetries = 0;
  for (;;) {
    try {
      const sender = await c.getSender(c.session.dcId);
      await sender.send(request);
      return;
    } catch (e) {
      const wait = floodSeconds(e);
      if (wait != null) {
        floodHits++;
        // Anything beyond a few minutes means the account is being throttled
        // hard; fail the file so the queue moves on and retries later.
        if (wait > 300) throw e;
        await sleep(wait * 1000 + 500);
        continue; // waiting out a flood is not one of the network retries
      }
      const msg = e instanceof Error ? e.message : String(e);
      if (netRetries < 5 && /disconnect|not connected|timeout|network|socket|closed/i.test(msg)) {
        netRetries++;
        await sleep(1000 * netRetries);
        continue;
      }
      throw e;
    }
  }
}

/**
 * Push a blob to Telegram in parts and return the handle `sendFile` accepts.
 *
 * The bytes are read one slice at a time straight out of the Blob, so a 300 MB
 * video costs a few hundred kilobytes of heap instead of 300 MB. That is what
 * makes a three-digit parallel limit survivable — before this, every worker
 * held its entire file in memory and four large videos at once were enough to
 * have Android kill the WebView mid-backup.
 */
async function uploadInParts(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  c: any,
  blob: Blob,
  name: string,
  onProgress?: (fraction: number) => void,
  isCancelled?: () => boolean,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  const { Api } = await import("telegram");
  const { generateRandomBytes, readBigIntFromBuffer } = await import("telegram/Helpers");
  const { Buffer } = await import("buffer");

  const isLarge = blob.size > LARGE_FILE_THRESHOLD;
  const fileId = readBigIntFromBuffer(generateRandomBytes(8), true, true);

  let sent = 0;
  onProgress?.(0);

  const partCount = await forEachPart(
    blob,
    async (part, total, chunk) => {
      const bytes = Buffer.from(chunk);
      await sendPart(
        c,
        isLarge
          ? new Api.upload.SaveBigFilePart({
              fileId, filePart: part, fileTotalParts: total, bytes,
            })
          : new Api.upload.SaveFilePart({ fileId, filePart: part, bytes }),
      );
      sent++;
      onProgress?.(sent / total);
    },
    { isCancelled },
  );

  return isLarge
    ? new Api.InputFileBig({ id: fileId, parts: partCount, name })
    : new Api.InputFile({ id: fileId, parts: partCount, name, md5Checksum: "" });
}

/**
 * Upload a file straight from the user account.
 *
 * The bytes are streamed part by part (see `uploadInParts`), so the ceiling is
 * Telegram's own 4000-part limit rather than the WebView's heap. Anything
 * larger is rejected up front with a readable message.
 */
export async function uploadToTarget(
  file: File,
  onProgress?: (fraction: number) => void,
  caption?: string,
  opts?: { isCancelled?: () => boolean },
): Promise<{ messageId: number; chatId: string }> {
  const limit = Math.min(MAX_UPLOAD_MB * 1024 * 1024, MAX_UPLOADABLE_BYTES);
  if (file.size > limit) {
    throw new Error(
      `الملف ${Math.round(file.size / 1048576)} م.ب — الحد الأقصى ${Math.floor(limit / 1048576)} م.ب`,
    );
  }
  if (file.size === 0) throw new Error(`ملف فارغ: ${file.name}`);

  const client = await getClient();
  if (!client) throw new Error("لم يتم ربط الحساب الشخصي بعد");
  const target = await getSavedTarget();
  if (!target) throw new Error("اختر قناة الحفظ من الإعدادات أولاً");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const c = client as any;
  const entity = await resolveEntity(c, target);

  let msg: { id: unknown };
  try {
    const handle = await uploadInParts(c, file, file.name, onProgress, opts?.isCancelled);

    // sendFile short-circuits when it is handed an already-uploaded file
    // handle: no second read of the bytes, and the filename attribute is taken
    // from the handle's own `name`.
    msg = await withFloodRetry<{ id: unknown }>(() =>
      c.sendFile(entity, {
        file: handle,
        forceDocument: true,
        // Caption carries the original capture timestamp so the gallery can
        // show the real date instead of the Telegram upload date.
        caption,
      }),
    );
  } catch (e) {
    if (!isPartError(e) || file.size > LEGACY_FALLBACK_MAX) throw e;
    // Insurance. If Telegram rejects the parts this app assembled, fall back to
    // the path gramjs drives itself — slower and memory-hungry, which is why it
    // is capped by size, but a working backup beats a correct one that is not
    // running. If this ever shows up in the log, the streaming path is wrong.
    legacyFallbacks++;
    msg = await sendViaGramjs(c, entity, file, onProgress, caption);
  }
  return { messageId: Number(msg.id), chatId: target.id };
}

/** Errors that mean "the assembled file was not acceptable". */
function isPartError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e ?? "");
  return /FILE_PART|FILE_PARTS_INVALID|MEDIA_INVALID|FILE_REFERENCE/i.test(msg);
}

/** Files above this are never retried the old way — it buffers the whole file. */
const LEGACY_FALLBACK_MAX = 64 * 1024 * 1024;

let legacyFallbacks = 0;

/** How many uploads had to fall back. Non-zero means the fast path is broken. */
export function legacyFallbackCount(): number {
  return legacyFallbacks;
}

async function sendViaGramjs(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  c: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  entity: any,
  file: File,
  onProgress?: (fraction: number) => void,
  caption?: string,
): Promise<{ id: unknown }> {
  const { CustomFile } = await import("telegram/client/uploads");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const custom = new CustomFile(file.name, bytes.length, file.name, bytes as unknown as Buffer);
  return withFloodRetry<{ id: unknown }>(() =>
    c.sendFile(entity, {
      file: custom,
      forceDocument: true,
      caption,
      workers: file.size > LARGE_FILE_THRESHOLD ? 4 : 1,
      progressCallback: onProgress ? (p: number) => onProgress(p) : undefined,
    }),
  );
}

/** Wait out a flood-wait on the message send itself, not just on the parts. */
async function withFloodRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const wait = floodSeconds(e);
      if (wait == null || wait > 300 || attempt >= 3) throw e;
      floodHits++;
      await sleep(wait * 1000 + 500);
    }
  }
}

/**
 * Caption keys of the newest messages in the target channel.
 *
 * Used to settle uploads that were interrupted between "Telegram accepted the
 * file" and "the local row was marked synced" — the one window where the app
 * can genuinely send the same photo twice.
 */
export async function fetchRecentCaptionKeys(
  sinceMs: number,
  maxMessages = 600,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const client = await getClient();
  if (!client) return out;
  const target = await getSavedTarget();
  if (!target) return out;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const c = client as any;
  const entity = await resolveEntity(c, target);

  let offsetId = 0;
  let scanned = 0;
  while (scanned < maxMessages) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const page: any[] = await c.getMessages(entity, {
      limit: Math.min(100, maxMessages - scanned),
      offsetId,
    });
    if (!page || page.length === 0) break;
    for (const m of page) {
      const key = parseCaptionKey(m.message ?? m.caption ?? "");
      if (key && !out.has(key)) out.set(key, Number(m.id));
    }
    scanned += page.length;
    const last = page[page.length - 1];
    const lastDateMs = Number(last.date ?? 0) * 1000;
    // Journal entries are minutes old at most — stop as soon as the page is
    // older than the oldest interrupted upload.
    if (lastDateMs && lastDateMs < sinceMs) break;
    const lastId = Number(last.id);
    if (!Number.isFinite(lastId) || lastId <= 1 || lastId === offsetId) break;
    offsetId = lastId;
  }
  return out;
}


export interface MtMediaItem {
  messageId: number;
  chatId: string;
  date: number;
  /** Telegram upload time (kept for reference/debugging). */
  uploadedAt?: number;
  name: string;
  size: number;

  mime: string;
  kind: "image" | "video";
  width?: number;
  height?: number;
  duration?: number;
  thumbDataUrl?: string;
  /** Content key stamped into the caption at upload time, when present. */
  contentKey?: string;
}

const toDataUrl = (bytes: Uint8Array, mime = "image/jpeg") => {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return `data:${mime};base64,${btoa(bin)}`;
};

const MIME_BY_EXT: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp",
  gif: "image/gif", bmp: "image/bmp", tif: "image/tiff", tiff: "image/tiff",
  heic: "image/heic", heif: "image/heif", avif: "image/avif", dng: "image/x-adobe-dng",
  mp4: "video/mp4", m4v: "video/mp4", mov: "video/quicktime", mkv: "video/x-matroska",
  webm: "video/webm", avi: "video/x-msvideo", "3gp": "video/3gpp",
};

/** Best-effort media MIME from a filename extension. */
export function mimeFromName(name?: string | null): string | null {
  const ext = (name ?? "").split(".").pop()?.toLowerCase() ?? "";
  return MIME_BY_EXT[ext] ?? null;
}

/** Cache of raw messages so thumbnails can be fetched lazily afterwards. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const msgCache = new Map<number, any>();

/**
 * Read the media history of the selected channel (bot-free).
 * METADATA ONLY — no bytes are downloaded here, so 1000+ items land in the
 * grid within seconds. Thumbnails are fetched afterwards by `fetchMessageThumb`.
 */
export async function fetchChannelMedia(
  limit = 0,
  onItem?: (item: MtMediaItem) => Promise<void> | void,
): Promise<number> {
  const client = await getClient();
  if (!client) throw new Error("لم يتم ربط الحساب الشخصي بعد");
  const target = await getSavedTarget();
  if (!target) throw new Error("اختر قناة الحفظ أولاً");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const c = client as any;
  // limit <= 0 means "read the whole channel".
  const cap = limit && limit > 0 ? limit : Number.MAX_SAFE_INTEGER;
  const entity = await resolveEntity(c, target);

  let count = 0;
  let scanned = 0;
  let skippedNoMedia = 0;
  let skippedMime = 0;
  let offsetId = 0;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handle = async (m: any) => {
    // gramjs exposes .document/.photo getters, but forwarded/album items are
    // sometimes only reachable through .media.
    const doc = m.document ?? m.media?.document ?? null;
    const photo = m.photo ?? m.media?.photo ?? null;
    if (!doc && !photo) { skippedNoMedia++; return; }
    // Documents sent as generic files (application/octet-stream) still count
    // when the filename looks like media.
    const nameGuess: string = (doc?.attributes ?? []).find((a: { fileName?: string }) => a.fileName)?.fileName ?? "";
    const rawMime: string = doc?.mimeType ?? "image/jpeg";
    // Telegram reports uploaded documents as octet-stream — derive the real
    // type from the filename so the viewer knows how to render it.
    const mime = /^(image|video)\//i.test(rawMime) ? rawMime : (mimeFromName(nameGuess) ?? rawMime);
    const isVideo = mime.startsWith("video/");
    const isImage = mime.startsWith("image/") || (!doc && !!photo);
    const looksMedia = /\.(jpe?g|png|webp|gif|bmp|tiff?|heic|heif|avif|dng|mp4|mov|mkv|webm|avi|3gp|m4v)$/i.test(nameGuess);
    if (!isVideo && !isImage && !looksMedia) { skippedMime++; return; }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const attrs: any[] = doc?.attributes ?? [];
    const nameAttr = attrs.find((a) => a.fileName);
    const videoAttr = attrs.find((a) => a.duration != null && a.w != null);
    const imgAttr = attrs.find((a) => a.w != null && a.duration == null);
    // Plain photos carry their dimensions on the largest PhotoSize.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sizes: any[] = photo?.sizes ?? [];
    const biggest = sizes.filter((s) => s.w != null).sort((a, b) => a.w - b.w).pop();

    const isVideoFinal = isVideo || /\.(mp4|mov|mkv|webm|avi)$/i.test(nameGuess);
    msgCache.set(Number(m.id), m);
    const fileName: string = nameAttr?.fileName ?? `tg-${m.id}${isVideoFinal ? ".mp4" : ".jpg"}`;
    const caption: string = m.message ?? m.caption ?? "";
    const item: MtMediaItem = {
      messageId: Number(m.id),
      chatId: target.id,
      // Telegram's message date is the *upload* time. Prefer the original
      // capture time embedded in the caption, then the camera filename.
      date: resolveOriginalDate({
        caption,
        name: fileName,
        messageDateMs: Number(m.date ?? 0) * 1000,
      }),
      uploadedAt: Number(m.date ?? 0) * 1000,
      contentKey: parseCaptionKey(caption),
      name: fileName,
      size: Number(doc?.size ?? 0),
      mime,
      kind: isVideoFinal ? "video" : "image",
      width: videoAttr?.w ?? imgAttr?.w ?? biggest?.w,
      height: videoAttr?.h ?? imgAttr?.h ?? biggest?.h,
      duration: videoAttr?.duration,
    };

    try { await onItem?.(item); count++; }
    catch { /* one bad message must not abort the import */ }
  };

  // Page manually from newest to oldest: one getMessages call caps out and
  // silently returns few rows on big channels. Each page is stored right away
  // so the grid keeps filling while older pages are still loading.
  for (;;) {
    if (scanned >= cap) break;
    const pageSize = Math.min(100, cap - scanned);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const page: any[] = await c.getMessages(entity, { limit: pageSize, offsetId });
    if (!page || page.length === 0) break;
    for (const m of page) await handle(m);
    scanned += page.length;
    const lastId = Number(page[page.length - 1].id);
    if (!Number.isFinite(lastId) || lastId <= 1 || lastId === offsetId) break;
    offsetId = lastId;
  }

  return count;
}


/**
 * Fetch a small preview for one message. Tries the cheap cached thumbnails
 * first and only falls back to the smallest real photo size.
 */
export async function fetchMessageThumb(messageId: number): Promise<string | null> {
  const client = await getClient();
  if (!client) return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const c = client as any;
  let m = msgCache.get(messageId);
  if (!m) {
    const target = await getSavedTarget();
    if (!target) return null;
    const entity = await resolveEntity(c, target);
    const [fetched] = await c.getMessages(entity, { ids: [messageId] });
    if (!fetched) return null;
    m = fetched;
    msgCache.set(messageId, m);
  }
  // thumb index 0 = smallest cached JPEG (documents AND photos support it).
  for (const thumb of [0, 1, -1]) {
    try {
      const buf = await c.downloadMedia(m, { thumb });
      if (buf && buf.length) return toDataUrl(new Uint8Array(buf));
    } catch { /* next size */ }
  }
  return null;
}




/** Download the full bytes of a stored message (for the lightbox / save). */
export async function downloadMessageBlob(
  messageId: number,
  opts?: { fallbackMime?: string; onProgress?: (received: number, total: number) => void },
): Promise<Blob | null> {
  const client = await getClient();
  if (!client) return null;
  const target = await getSavedTarget();
  if (!target) return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const c = client as any;
  const entity = await resolveEntity(c, target);
  const [msg] = await c.getMessages(entity, { ids: [messageId] });
  if (!msg) return null;
  const buf = await c.downloadMedia(msg, {
    progressCallback: opts?.onProgress
      ? (received: unknown, total: unknown) => opts.onProgress!(Number(received), Number(total))
      : undefined,
  });
  if (!buf) return null;
  // Files uploaded as documents often come back as application/octet-stream,
  // which makes <video>/<img> refuse to render. Prefer a concrete media type.
  const raw: string = msg.document?.mimeType ?? "";
  const name: string =
    (msg.document?.attributes ?? []).find((a: { fileName?: string }) => a.fileName)?.fileName ?? "";
  const guess = guessMimeFromName(name);
  const mime =
    raw && raw !== "application/octet-stream" ? raw : (guess ?? opts?.fallbackMime ?? "image/jpeg");
  return new Blob([new Uint8Array(buf)], { type: mime });
}

function guessMimeFromName(name: string): string | undefined {
  const ext = name.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "mp4": case "m4v": return "video/mp4";
    case "mov": return "video/quicktime";
    case "webm": return "video/webm";
    case "mkv": return "video/x-matroska";
    case "3gp": return "video/3gpp";
    case "avi": return "video/x-msvideo";
    case "jpg": case "jpeg": return "image/jpeg";
    case "png": return "image/png";
    case "webp": return "image/webp";
    case "gif": return "image/gif";
    case "heic": return "image/heic";
    case "heif": return "image/heif";
    default: return undefined;
  }
}
