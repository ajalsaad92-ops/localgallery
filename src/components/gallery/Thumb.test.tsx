import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { Thumb } from "./Thumb";
import type { GalleryItem } from "@/lib/galleryItem";

const loadThumb = vi.fn();
const getRemoteThumb = vi.fn();

vi.mock("@/lib/thumbs", () => ({
  cachedThumb: () => undefined,
  loadThumb: (...a: unknown[]) => loadThumb(...a),
}));

vi.mock("@/lib/remoteThumbs", () => ({
  cachedRemoteThumb: () => undefined,
  getRemoteThumb: (...a: unknown[]) => getRemoteThumb(...a),
  thumbsVersion: () => 0,
  watchRemoteThumbs: () => () => {},
}));

const item = (over: Partial<GalleryItem>): GalleryItem => ({
  id: "device-image-7",
  width: 100,
  height: 100,
  date: new Date(0),
  name: "a.jpg",
  kind: "image",
  ...over,
});

beforeEach(() => {
  loadThumb.mockReset().mockResolvedValue("data:image/jpeg;base64,LOCAL");
  getRemoteThumb.mockReset().mockResolvedValue(null);
});

describe("Thumb source routing", () => {
  it("uses the MediaStore thumbnail for an uploaded photo that is still on the phone", async () => {
    // After upload the row flips to provider "telegram-remote" while the file
    // stays in the gallery. Routing on provider sent the tile back to the raw
    // content:// URI — the original slowness, and a broken tile for video.
    render(
      <Thumb
        photo={item({
          provider: "telegram-remote",
          localUri: "content://media/external/file/7",
          thumbSrc: "content://media/external/file/7",
        })}
      />,
    );
    await waitFor(() => expect(loadThumb).toHaveBeenCalled());
    expect(getRemoteThumb).not.toHaveBeenCalled();
    const img = await screen.findByRole("presentation", { hidden: true });
    expect(img.getAttribute("src")).toBe("data:image/jpeg;base64,LOCAL");
  });

  it("never falls back to the raw file for a local video", async () => {
    loadThumb.mockResolvedValue(null);
    const { container } = render(
      <Thumb
        photo={item({
          kind: "video",
          provider: "telegram-remote",
          localUri: "content://media/external/file/9",
          thumbSrc: "content://media/external/file/9",
        })}
      />,
    );
    await waitFor(() => expect(loadThumb).toHaveBeenCalled());
    // A placeholder is correct here; <img src="content://…video"> renders broken.
    expect(container.querySelector("img")).toBeNull();
  });

  it("asks the remote cache for an item with no local file", async () => {
    getRemoteThumb.mockResolvedValue("data:image/jpeg;base64,REMOTE");
    render(<Thumb photo={item({ id: "tgm-1-2", provider: "telegram-remote" })} />);
    await waitFor(() => expect(getRemoteThumb).toHaveBeenCalledWith("tgm-1-2"));
    expect(loadThumb).not.toHaveBeenCalled();
  });
});
