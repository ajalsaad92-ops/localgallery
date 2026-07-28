export async function probe() {
  const H = await import("telegram/Helpers");
  const { TelegramClient } = await import("telegram");
  const { StringSession } = await import("telegram/sessions");
  const c = new TelegramClient(new StringSession(""), 123, "abc", { connectionRetries: 1, useWSS: true });
  const rnd = H.generateRandomBytes(16);
  const sha = await H.sha256(Buffer.from("x"));
  return { rnd: rnd.length, sha: sha.length, client: !!c };
}
