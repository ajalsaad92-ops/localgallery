/**
 * Telegram user-account login (MTProto) — runs fully inside the app.
 * Nothing is sent anywhere except Telegram's own servers.
 * The session string is stored locally in IndexedDB (kv table).
 */
import { photoDb } from "@/lib/photoDb";
import { logTg } from "@/lib/diagnostics";


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

async function buildClient(session: string, creds: MtprotoCreds): Promise<AnyClient> {
  const { TelegramClient } = await import("telegram");
  const { StringSession } = await import("telegram/sessions");
  return new TelegramClient(new StringSession(session), creds.apiId, creds.apiHash, {
    connectionRetries: 3,
    useWSS: true,
  }) as unknown as AnyClient;
}

async function persist(client: AnyClient) {
  await photoDb.kv.put({ key: KEY_SESSION, value: client.session.save() });
}

/** Returns a connected client for an already-authorized account, or null. */
export async function getClient(): Promise<AnyClient | null> {
  if (cached) return cached;
  const creds = await getSavedCreds();
  const session = await getSavedSession();
  if (!creds || !session) return null;
  const client = await buildClient(session, creds);
  await client.connect();
  cached = client;
  return client;
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const d of dialogs as any[]) {
    const e = d.entity;
    if (!e) continue;
    const isChannel = d.isChannel || d.isGroup;
    const isMe = d.isUser && e.self;
    if (!isChannel && !isMe) continue;
    if (isChannel && e.broadcast && e.adminRights == null && !e.creator) continue;
    out.push({
      id: String(e.id),
      title: isMe ? "الرسائل المحفوظة" : (d.title || e.title || e.username || String(e.id)),
      username: e.username ?? undefined,
    });
  }
  return out;
}

/** Resolve a stored target id back into a usable entity (cache-aware). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function resolveEntity(client: any, target: MtTarget): Promise<any> {
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

/** Upload a file straight from the user account (no bot, up to 2GB). */
export async function uploadToTarget(
  file: File,
  onProgress?: (fraction: number) => void,
): Promise<{ messageId: number; chatId: string }> {
  const client = await getClient();
  if (!client) throw new Error("لم يتم ربط الحساب الشخصي بعد");
  const target = await getSavedTarget();
  if (!target) throw new Error("اختر قناة الحفظ من الإعدادات أولاً");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const c = client as any;
  const entity = await resolveEntity(c, target);
  const big = file.size > 10 * 1024 * 1024;
  logTg("upload", `sendFile → ${target.title}`, { name: file.name, mime: file.type, bytes: file.size });
  try {
    const msg = await c.sendFile(entity, {
      file,
      forceDocument: true,
      // More workers keep large videos from stalling on a single connection.
      workers: big ? 4 : 1,
      progressCallback: onProgress ? (p: number) => onProgress(p) : undefined,
    });
    logTg("upload", `sendFile ok`, { name: file.name, messageId: Number(msg.id) });
    return { messageId: Number(msg.id), chatId: target.id };
  } catch (e) {
    logTg("upload", `sendFile failed: ${file.name}`, e, "error");
    throw e;
  }

}

export interface MtMediaItem {
  messageId: number;
  chatId: string;
  date: number;
  name: string;
  size: number;
  mime: string;
  kind: "image" | "video";
  width?: number;
  height?: number;
  duration?: number;
  thumbDataUrl?: string;
}

const toDataUrl = (bytes: Uint8Array, mime = "image/jpeg") => {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return `data:${mime};base64,${btoa(bin)}`;
};

/** Read the full media history of the selected channel (bot-free). */
export async function fetchChannelMedia(
  limit = 200,
  onItem?: (item: MtMediaItem) => Promise<void> | void,
): Promise<number> {
  const client = await getClient();
  if (!client) { logTg("feed", "no linked account", undefined, "warn"); throw new Error("لم يتم ربط الحساب الشخصي بعد"); }
  const target = await getSavedTarget();
  if (!target) { logTg("feed", "no target channel selected", undefined, "warn"); throw new Error("اختر قناة الحفظ أولاً"); }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const c = client as any;
  logTg("feed", `reading history of "${target.title}"`, { id: target.id, limit });
  const entity = await resolveEntity(c, target);
  const messages = await c.getMessages(entity, { limit });
  logTg("feed", `got ${messages.length} messages`);
  let count = 0;
  let skippedNoMedia = 0;
  let skippedMime = 0;
  let thumbFails = 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const m of messages as any[]) {
    const doc = m.document;
    const photo = m.photo;
    if (!doc && !photo) { skippedNoMedia++; continue; }
    const mime: string = doc?.mimeType ?? "image/jpeg";
    const isVideo = mime.startsWith("video/");
    const isImage = mime.startsWith("image/") || (!doc && !!photo);
    if (!isVideo && !isImage) { skippedMime++; continue; }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const attrs: any[] = doc?.attributes ?? [];
    const nameAttr = attrs.find((a) => a.fileName);
    const videoAttr = attrs.find((a) => a.duration != null && a.w != null);
    const imgAttr = attrs.find((a) => a.w != null && a.duration == null);

    let thumbDataUrl: string | undefined;
    // Largest available thumbnail first; some documents only carry index 0.
    for (const thumb of [-1, 0]) {
      try {
        const buf = await c.downloadMedia(m, { thumb });
        if (buf && buf.length) { thumbDataUrl = toDataUrl(new Uint8Array(buf)); break; }
      } catch { /* try the next thumb index */ }
    }
    // Plain photos have no document thumb — pull the (small) photo itself.
    if (!thumbDataUrl && photo && !doc) {
      try {
        const buf = await c.downloadMedia(m);
        if (buf && buf.length) thumbDataUrl = toDataUrl(new Uint8Array(buf));
      } catch (e) { thumbFails++; logTg("feed", `thumb failed for msg ${m.id}`, e, "warn"); }
    }
    if (!thumbDataUrl) thumbFails++;

    const item: MtMediaItem = {
      messageId: Number(m.id),
      chatId: target.id,
      date: Number(m.date ?? 0) * 1000,
      name: nameAttr?.fileName ?? `tg-${m.id}${isVideo ? ".mp4" : ".jpg"}`,
      size: Number(doc?.size ?? 0),
      mime,
      kind: isVideo ? "video" : "image",
      width: videoAttr?.w ?? imgAttr?.w,
      height: videoAttr?.h ?? imgAttr?.h,
      duration: videoAttr?.duration,
      thumbDataUrl,
    };
    await onItem?.(item);
    count++;
  }
  logTg("feed", "history read complete", { imported: count, skippedNoMedia, skippedMime, thumbFails });
  return count;
}


/** Download the full bytes of a stored message (for the lightbox / save). */
export async function downloadMessageBlob(messageId: number): Promise<Blob | null> {
  const client = await getClient();
  if (!client) return null;
  const target = await getSavedTarget();
  if (!target) return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const c = client as any;
  const entity = await resolveEntity(c, target);
  const [msg] = await c.getMessages(entity, { ids: [messageId] });
  if (!msg) return null;
  const buf = await c.downloadMedia(msg);
  if (!buf) return null;
  const mime = msg.document?.mimeType ?? "image/jpeg";
  return new Blob([new Uint8Array(buf)], { type: mime });
}
