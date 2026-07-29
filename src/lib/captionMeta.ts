/**
 * Original-capture-time preservation.
 *
 * Telegram stamps every message with the *upload* time, so a channel read back
 * later shows "today" for a photo taken years ago. To keep the real timestamp
 * we embed it in the message caption when uploading, and parse it back (with a
 * filename fallback) when reading the channel history.
 */

const TAG = "#lgts";

/** Caption sent with every uploaded file: readable date + machine tag. */
export function buildCaption(name: string, takenAtMs: number): string {
  const ts = Number.isFinite(takenAtMs) && takenAtMs > 0 ? Math.round(takenAtMs) : Date.now();
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  const human = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return `${name}\n📅 ${human}\n${TAG}:${ts}`;
}

/** Read back the embedded timestamp, if this app uploaded the file. */
export function parseCaptionTs(caption?: string | null): number | undefined {
  if (!caption) return undefined;
  const m = caption.match(/#lgts:(\d{10,16})/);
  if (!m) return undefined;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

const toMs = (y: number, mo: number, d: number, h = 0, mi = 0, s = 0) => {
  const t = new Date(y, mo - 1, d, h, mi, s).getTime();
  if (!Number.isFinite(t)) return undefined;
  // Reject nonsense (before 1990 / more than a day in the future).
  if (t < 631152000000 || t > Date.now() + 86400000) return undefined;
  return t;
};

/**
 * Camera filenames carry the capture date on virtually every phone:
 * IMG_20240501_123456, PXL_20240501_123456789, VID-20240501-WA0001,
 * Screenshot_2024-05-01-12-33-44, photo_2024-05-01_12-33-44, 20240501_123456.
 */
export function parseNameTs(name?: string | null): number | undefined {
  if (!name) return undefined;
  const s = name.replace(/\.[a-z0-9]{2,5}$/i, "");

  let m = s.match(/(\d{4})[-_.]?(\d{2})[-_.]?(\d{2})[-_.T ]?(\d{2})[-_.:]?(\d{2})[-_.:]?(\d{2})/);
  if (m) {
    const t = toMs(+m[1], +m[2], +m[3], +m[4], +m[5], +m[6]);
    if (t) return t;
  }
  m = s.match(/(\d{4})[-_.]?(\d{2})[-_.]?(\d{2})/);
  if (m) {
    const t = toMs(+m[1], +m[2], +m[3]);
    if (t) return t;
  }
  // Unix-ms embedded by some exporters.
  m = s.match(/\b(1[0-9]{12})\b/);
  if (m) {
    const t = Number(m[1]);
    if (t > 631152000000 && t < Date.now() + 86400000) return t;
  }
  return undefined;
}

/** Best available original date for a Telegram message. */
export function resolveOriginalDate(opts: {
  caption?: string | null;
  name?: string | null;
  messageDateMs: number;
}): number {
  return (
    parseCaptionTs(opts.caption) ??
    parseNameTs(opts.name) ??
    opts.messageDateMs ??
    Date.now()
  );
}
