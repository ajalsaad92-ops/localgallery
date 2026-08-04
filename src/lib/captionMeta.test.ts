import { describe, expect, it } from "vitest";
import { buildCaption, parseCaptionKey, parseCaptionTs } from "./captionMeta";

describe("caption round-trip", () => {
  it("recovers the content key it stamped", () => {
    // This is what makes a re-upload impossible after an interrupted run: the
    // key comes back from Telegram and matches the local row exactly.
    const key = "IMG_0001.jpg|123456|1700000000000";
    const caption = buildCaption("IMG_0001.jpg", 1700000000000, key);
    expect(parseCaptionKey(caption)).toBe(key);
  });

  it("survives names with spaces, pipes and unicode", () => {
    const key = "صورة العائلة 2024|987|1700000000000";
    expect(parseCaptionKey(buildCaption("صورة العائلة 2024", 1, key))).toBe(key);
  });

  it("still carries the original timestamp alongside the key", () => {
    const ts = 1700000000000;
    const caption = buildCaption("a.jpg", ts, "a.jpg|1|2");
    expect(parseCaptionTs(caption)).toBe(ts);
  });

  it("returns undefined for captions written by anything else", () => {
    expect(parseCaptionKey("just a normal caption")).toBeUndefined();
    expect(parseCaptionKey(undefined)).toBeUndefined();
    expect(parseCaptionKey(null)).toBeUndefined();
  });

  it("omits the key tag when none is given", () => {
    expect(buildCaption("a.jpg", 1700000000000)).not.toContain("#lgk");
  });
});
