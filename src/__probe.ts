export async function probe() {
  const m = await import("telegram");
  return typeof m.TelegramClient;
}
