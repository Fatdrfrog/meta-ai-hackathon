/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { fireEvent, render, screen, act } from "@testing-library/react";
import { CarouselCardsScroller } from "./carousel-cards-scroller";
import { installMatchMedia } from "@/test-support/dom-test-utils";

describe("CarouselCardsScroller", () => {
  const originalMatchMedia = window.matchMedia;
  afterEach(() => {
    window.matchMedia = originalMatchMedia;
  });

  function mount(
    interactive = true,
    reducedMotion = false,
    persistentNavigation = false
  ) {
    installMatchMedia(() => reducedMotion);
    const result = render(
      <CarouselCardsScroller
        interactive={interactive}
        persistentNavigation={persistentNavigation}
        viewportClassName="viewport"
        previousLabel="Previous product"
        nextLabel="Next product"
      >
        <div>First product</div>
        <div>Second product</div>
      </CarouselCardsScroller>
    );
    const viewport =
      result.container.querySelector<HTMLDivElement>(".viewport")!;
    Object.defineProperties(viewport, {
      scrollWidth: { value: 408, configurable: true },
      clientWidth: { value: 300, configurable: true },
    });
    viewport.scrollBy = jest.fn();
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    return viewport;
  }

  it("shows navigation only for reachable products and responds to native scrolling", () => {
    const viewport = mount();
    expect(viewport.className).toContain("overflow-x-auto");
    expect(viewport.className).toContain("overflow-y-hidden");
    expect(viewport.className).not.toContain("overflow-x-scroll");
    expect(viewport.className).not.toContain("pb-1.5");
    expect(
      screen.queryByRole("button", { name: "Previous product" })
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Next product" }));
    expect(viewport.scrollBy).toHaveBeenCalledWith({
      left: 208,
      behavior: "smooth",
    });
    viewport.scrollLeft = 108;
    fireEvent.scroll(viewport);
    expect(
      screen.queryByRole("button", { name: "Next product" })
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Previous product" }));
    expect(viewport.scrollBy).toHaveBeenCalledWith({
      left: -208,
      behavior: "smooth",
    });
  });

  it("moves immediately when reduced motion is requested", () => {
    const viewport = mount(true, true);
    fireEvent.click(screen.getByRole("button", { name: "Next product" }));
    expect(viewport.scrollBy).toHaveBeenCalledWith({
      left: 208,
      behavior: "instant",
    });
  });

  it("retains stable navigation controls at each boundary when requested", () => {
    const viewport = mount(true, false, true);
    expect(
      screen.getByRole("button", { name: "Previous product" })
    ).toBeDisabled();
    const next = screen.getByRole("button", { name: "Next product" });
    expect(next).toBeEnabled();
    viewport.scrollLeft = 108;
    fireEvent.scroll(viewport);
    expect(next).toBeInTheDocument();
    expect(next).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Previous product" })
    ).toBeEnabled();
  });

  it("does not create hidden tab stops or dead controls in decorative previews", () => {
    const viewport = mount(false);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(viewport).toHaveAttribute("tabindex", "-1");
  });

  it("notifies when the carousel viewport moves", () => {
    const onViewportChange = jest.fn();
    render(
      <CarouselCardsScroller onViewportChange={onViewportChange}>
        <div>First product</div>
        <div>Second product</div>
      </CarouselCardsScroller>
    );
    const viewport = screen.getByTestId("carousel-cards-viewport");
    fireEvent.scroll(viewport);
    expect(onViewportChange).toHaveBeenCalled();
  });
});
