import { describe, expect, it, vi, beforeAll } from "vitest";
import { useState } from "react";
import { render, screen, act, fireEvent } from "@testing-library/react";
import { PhotoGrid } from "./PhotoGrid";
import type { GalleryItem } from "@/lib/galleryItem";

vi.mock("@/lib/native", () => ({
  tap: () => Promise.resolve(),
  isNative: () => false,
  LocalGalleryMedia: { getThumbnail: () => Promise.reject(new Error("web")) },
}));

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
  it("renders tiles for assets that arrive after the first render", async () => {
    // Assets load asynchronously, so the grid's first render is always empty.
    // It must still measure itself, or it stays blank forever once they land.
    const { rerender } = render(
      <PhotoGrid photos={[]} onOpen={() => {}} emptyContent={<p>لا شيء</p>} />,
    );
    expect(screen.getByText("لا شيء")).toBeInTheDocument();

    rerender(<PhotoGrid photos={[item("a"), item("b")]} onOpen={() => {}} />);

    // Measurement is batched into a frame, so the tiles land asynchronously.
    expect(await screen.findByLabelText("a.jpg")).toBeInTheDocument();
    expect(screen.getByLabelText("b.jpg")).toBeInTheDocument();
  });

  it("renders tiles when assets are present on the first render", async () => {
    render(<PhotoGrid photos={[item("solo")]} onOpen={() => {}} />);
    expect(await screen.findByLabelText("solo.jpg")).toBeInTheDocument();
  });

  it("shows the empty state when there is nothing to render", () => {
    render(<PhotoGrid photos={[]} onOpen={() => {}} emptyContent={<p>فارغ</p>} />);
    expect(screen.getByText("فارغ")).toBeInTheDocument();
  });

  it("keeps the item selected after a long-press releases", async () => {
    // Releasing a long-press also fires a click. If that click is not
    // swallowed it toggles the item straight back off and selection mode
    // exits, making multi-select unreachable. The harness mirrors the real
    // parent: entering selection actually updates the `selected` prop, which
    // is what makes the follow-up click take the toggle branch.
    function Harness() {
      const [selected, setSelected] = useState<Set<string> | null>(null);
      return (
        <>
          <span data-testid="count">{selected ? selected.size : -1}</span>
          <PhotoGrid
            photos={[item("a"), item("b")]}
            onOpen={() => {}}
            selected={selected}
            onEnterSelection={(id) => setSelected(new Set([id]))}
            onToggleSelect={(id) =>
              setSelected((cur) => {
                const next = new Set(cur ?? []);
                if (next.has(id)) next.delete(id);
                else next.add(id);
                return next.size === 0 ? null : next;
              })
            }
          />
        </>
      );
    }

    render(<Harness />);
    const tile = await screen.findByLabelText("a.jpg");

    fireEvent.pointerDown(tile);
    await act(async () => { await new Promise((r) => setTimeout(r, 450)); });
    fireEvent.pointerUp(tile);
    fireEvent.click(tile);

    // One item selected — not zero, and not back out of selection mode.
    expect(screen.getByTestId("count").textContent).toBe("1");
  });

  it("toggles on a plain tap once selection is active", async () => {
    const onToggleSelect = vi.fn();
    render(
      <PhotoGrid
        photos={[item("a")]}
        onOpen={() => {}}
        selected={new Set(["a"])}
        onToggleSelect={onToggleSelect}
      />,
    );
    fireEvent.click(await screen.findByLabelText("a.jpg"));
    expect(onToggleSelect).toHaveBeenCalledWith("a");
  });
});
