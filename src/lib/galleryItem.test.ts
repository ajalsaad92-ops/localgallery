import { describe, expect, it } from "vitest";
import { contentKeyOf } from "./photoDb";
import { groupByDate, type GalleryItem } from "./galleryItem";

const item = (id: string, date: Date): GalleryItem => ({
  id, width: 100, height: 100, date, name: id,
});

describe("contentKeyOf", () => {
  it("treats the same file re-indexed under a new id as one item", () => {
    const a = contentKeyOf({ name: "IMG_0001.jpg", size: 1024, date: 1_700_000_000_000 });
    const b = contentKeyOf({ name: "IMG_0001.jpg", size: 1024, date: 1_700_000_000_000 });
    expect(a).toBe(b);
  });

  it("keeps two different photos apart when name and size collide", () => {
    // The old key was name+size only, so this pair was silently deduped and
    // the second photo was marked synced without ever being uploaded.
    const a = contentKeyOf({ name: "IMG_0001.jpg", size: 1024, date: 1_700_000_000_000 });
    const b = contentKeyOf({ name: "IMG_0001.jpg", size: 1024, date: 1_700_000_999_000 });
    expect(a).not.toBe(b);
  });

  it("separates different files taken at the same moment", () => {
    const a = contentKeyOf({ name: "a.jpg", size: 10, date: 1 });
    const b = contentKeyOf({ name: "b.jpg", size: 10, date: 1 });
    expect(a).not.toBe(b);
  });
});

describe("groupByDate", () => {
  it("labels today and yesterday relatively", () => {
    const now = new Date();
    const yesterday = new Date(now.getTime() - 86_400_000);
    const groups = groupByDate([item("a", now), item("b", yesterday)]);
    expect(groups.map((g) => g.label)).toEqual(["اليوم", "أمس"]);
  });

  it("keeps items of one day in a single group", () => {
    const d = new Date(2024, 4, 1, 9);
    const later = new Date(2024, 4, 1, 21);
    const groups = groupByDate([item("a", d), item("b", later)]);
    expect(groups).toHaveLength(1);
    expect(groups[0].items).toHaveLength(2);
  });

  it("preserves the order it was given", () => {
    const groups = groupByDate([
      item("new", new Date(2024, 4, 2)),
      item("old", new Date(2024, 3, 1)),
    ]);
    expect(groups[0].items[0].id).toBe("new");
    expect(groups[1].items[0].id).toBe("old");
  });
});
