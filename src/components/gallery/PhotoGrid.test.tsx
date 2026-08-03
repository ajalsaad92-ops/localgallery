import { describe, expect, it, vi, beforeAll } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { PhotoGrid } from "./PhotoGrid";
import type { GalleryItem } from "@/lib/galleryItem";

vi.mock("@/lib/native", () => ({ tap: () => Promise.resolve() }));

beforeAll(() => {
  // jsdom has no layout engine and no ResizeObserver.
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as never;
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get: () => 400,
  });
});

const item = (id: string): GalleryItem => ({
  id,
  width: 100,
  height: 100,
  date: new Date(),
  name: `${id}.jpg`,
  thumbSrc: `blob:${id}`,
});

describe("PhotoGrid", () => {
  it("renders tiles for assets that arrive after the first render", () => {
    // Assets load asynchronously, so the grid's first render is always empty.
    // It must still measure itself, or it stays blank forever once they land.
    const { rerender } = render(
      <PhotoGrid photos={[]} onOpen={() => {}} emptyContent={<p>لا شيء</p>} />,
    );
    expect(screen.getByText("لا شيء")).toBeInTheDocument();

    act(() => {
      rerender(<PhotoGrid photos={[item("a"), item("b")]} onOpen={() => {}} />);
    });

    expect(screen.getByLabelText("a.jpg")).toBeInTheDocument();
    expect(screen.getByLabelText("b.jpg")).toBeInTheDocument();
  });

  it("renders tiles when assets are present on the first render", () => {
    render(<PhotoGrid photos={[item("solo")]} onOpen={() => {}} />);
    expect(screen.getByLabelText("solo.jpg")).toBeInTheDocument();
  });

  it("shows the empty state when there is nothing to render", () => {
    render(<PhotoGrid photos={[]} onOpen={() => {}} emptyContent={<p>فارغ</p>} />);
    expect(screen.getByText("فارغ")).toBeInTheDocument();
  });
});
