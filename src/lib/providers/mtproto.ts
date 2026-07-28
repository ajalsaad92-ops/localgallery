/**
 * Telegram user-account login (MTProto) — runs fully inside the app.
 * Nothing is sent anywhere except Telegram's own servers.
 * The session string is stored locally in IndexedDB (kv table).
 */
import { photoDb } from "@/lib/photoDb";

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
