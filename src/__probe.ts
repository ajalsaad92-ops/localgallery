export async function probe() {
  const { TelegramClient, Api } = await import("telegram");
  const { StringSession } = await import("telegram/sessions");
  const { computeCheck } = await import("telegram/Password");
  const c = new TelegramClient(new StringSession(""), 123, "abc", { connectionRetries: 1, useWSS: true });
  return [typeof TelegramClient, typeof Api.auth.SignIn, typeof computeCheck, typeof c.session.save()].join(",");
}
