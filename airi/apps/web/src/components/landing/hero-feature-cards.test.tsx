/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { HeroFeatureCards } from "./hero-feature-cards";
import { HERO_WORKFLOWS } from "./hero-workflow-definitions";
import { renderToString } from "react-dom/server.node";

let mockReducedMotion = false;
let mockMobile = false;
let motionListeners = new Set<() => void>();
const originalMatchMedia = window.matchMedia;
const originalAnimate = Element.prototype.animate;
let animations: {
  element: Element;
  keyframes: Keyframe[];
  options: KeyframeAnimationOptions;
  currentTime: number;
  cancel: jest.Mock;
}[] = [];

const sequenceBounds = {
  x: 0,
  y: 0,
  top: 0,
  left: 0,
  right: 400,
  bottom: 1000,
  width: 400,
  height: 1000,
  toJSON: () => ({}),
};
jest.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => mockMobile }));
jest.mock("./hero-feature-card-previews", () => ({
  HeroFeatureCardPreview: ({ kind }: { kind: string }) => (
    <div data-preview-kind={kind} />
  ),
}));

describe("HeroFeatureCards", () => {
  beforeEach(() => {
    mockReducedMotion = false;
    mockMobile = false;
    motionListeners = new Set();
    animations = [];
    Element.prototype.animate = jest.fn(function (
      this: Element,
      keyframes: Keyframe[] | PropertyIndexedKeyframes | null,
      options?: number | KeyframeAnimationOptions
    ) {
      const animation = {
        element: this,
        keyframes: keyframes as Keyframe[],
        options: options as KeyframeAnimationOptions,
        currentTime: 0,
        cancel: jest.fn(),
      };
      animations.push(animation);
      return animation as unknown as Animation;
    });
    window.matchMedia = jest.fn(
      (query: string): MediaQueryList => ({
        matches:
          query === "(prefers-reduced-motion: reduce)" && mockReducedMotion,
        media: query,
        onchange: null,
        addListener: jest.fn(),
        removeListener: jest.fn(),
        addEventListener: (_event: string, listener: unknown) =>
          motionListeners.add(listener as () => void),
        removeEventListener: (_event: string, listener: unknown) =>
          motionListeners.delete(listener as () => void),
        dispatchEvent: jest.fn(),
      })
    );
  });
  afterEach(() => {
    window.matchMedia = originalMatchMedia;
    Element.prototype.animate = originalAnimate;
    jest.restoreAllMocks();
  });
  it("renders one readable story on the server without hidden desktop loops", () => {
    const html = renderToString(<HeroFeatureCards />);
    const document = new DOMParser().parseFromString(html, "text/html");
    expect(document.querySelectorAll("article")).toHaveLength(1);
    expect(
      document.querySelector("[data-testid=hero-scroll-track]")
    ).toBeNull();
    expect(document.querySelector("[data-motion-control]")).toBeNull();
    expect(
      document.querySelector("article")?.getAttribute("data-feature-card")
    ).toBe("interactive");
  });
  it("keeps six original stories accessible and hides only loop copies", () => {
    render(<HeroFeatureCards />);
    expect(screen.getAllByRole("article")).toHaveLength(6);
    const copies = screen.getAllByTestId("hero-scroll-copy");
    expect(copies).toHaveLength(4);
    for (const copy of copies) {
      expect(copy).toHaveAttribute("aria-hidden", "true");
      expect(copy).toHaveAttribute("inert");
    }
  });
  it.each([60, 120, 144])(
    "preserves subpixel position when pausing and browsing at %i Hz",
    fps => {
      const frames = new Map<number, FrameRequestCallback>();
      let nextFrame = 0;
      jest
        .spyOn(window, "requestAnimationFrame")
        .mockImplementation(callback => {
          frames.set(++nextFrame, callback);
          return nextFrame;
        });
      jest.spyOn(window, "cancelAnimationFrame").mockImplementation(id => {
        frames.delete(id);
      });
      jest
        .spyOn(HTMLElement.prototype, "getBoundingClientRect")
        .mockReturnValue(sequenceBounds);
      const { container, unmount } = render(<HeroFeatureCards />);
      const columns = container.querySelectorAll<HTMLElement>(
        "[data-column-viewport]"
      );
      // Consume the showcase's one-time focus reconciliation frame.
      act(() => {
        for (const [id, callback] of Array.from(frames)) {
          frames.delete(id);
          callback(0);
        }
      });
      expect(frames.size).toBe(0);
      expect(animations).toHaveLength(2);
      for (const animation of animations) {
        expect(animation.options).toMatchObject({
          duration: 25000,
          iterations: Infinity,
          easing: "linear",
        });
        animation.currentTime += 1000 / fps;
      }
      const column = columns[0].closest("[data-scroll-direction]")!;
      let nativePosition = columns[0].scrollTop;
      // Model the browser's whole-pixel scroll quantization, absent from jsdom.
      Object.defineProperty(columns[0], "scrollTop", {
        configurable: true,
        get: () => nativePosition,
        set: (value: number) => {
          nativePosition = Math.round(value);
        },
      });
      const firstAnimation = animations[0];
      const otherAnimation = animations[1];
      const track = screen.getAllByTestId("hero-scroll-track")[0];
      const position = () =>
        nativePosition -
        Number(
          track.style.transform.match(
            /translate3d\(0, ([-\d.e]+)px, 0\)/
          )?.[1] ?? 0
        );
      fireEvent.pointerEnter(column, { pointerType: "mouse" });
      expect(firstAnimation.cancel).toHaveBeenCalledTimes(1);
      expect(otherAnimation.cancel).not.toHaveBeenCalled();
      expect(position()).toBeCloseTo(1000 - 40 / fps, 6);
      columns[0].scrollTop += 120;
      fireEvent.scroll(columns[0]);
      expect(position()).toBeCloseTo(1120 - 40 / fps, 6);
      fireEvent.pointerLeave(column);
      const resumed = animations.at(-1)!;
      expect(resumed.element).toBe(track);
      expect(resumed.currentTime).toBeCloseTo(
        firstAnimation.currentTime - 3000,
        6
      );
      unmount();
      expect(resumed.cancel).toHaveBeenCalledTimes(1);
      expect(otherAnimation.cancel).toHaveBeenCalledTimes(1);
      expect(frames.size).toBe(0);
    }
  );
  it("cancels hidden animations and resumes their phase without catch-up", () => {
    jest
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockReturnValue(sequenceBounds);
    const hidden = jest.spyOn(document, "hidden", "get").mockReturnValue(false);
    render(<HeroFeatureCards />);
    const original = [...animations];
    original.forEach(animation => {
      animation.currentTime += 1234;
    });
    hidden.mockReturnValue(true);
    fireEvent(document, new Event("visibilitychange"));
    original.forEach(animation =>
      expect(animation.cancel).toHaveBeenCalledTimes(1)
    );
    hidden.mockReturnValue(false);
    fireEvent(document, new Event("visibilitychange"));
    expect(animations).toHaveLength(4);
    for (const index of [0, 1]) {
      expect(animations[index + 2].currentTime).toBeCloseTo(
        original[index].currentTime,
        6
      );
    }
  });
  it("pauses only the hovered column and preserves the shared manual pause", () => {
    render(<HeroFeatureCards />);
    const tracks = screen.getAllByTestId("hero-scroll-track");
    const first = tracks[0].closest("[data-scroll-direction]")!;
    fireEvent.pointerEnter(first, { pointerType: "mouse" });
    expect(tracks[0]).toHaveAttribute("data-paused", "true");
    expect(tracks[1]).toHaveAttribute("data-paused", "false");
    fireEvent.click(screen.getByRole("button", { name: "pause" }));
    fireEvent.pointerLeave(first);
    for (const track of screen.getAllByTestId("hero-scroll-track"))
      expect(track).toHaveAttribute("data-paused", "true");
    fireEvent.click(screen.getByRole("button", { name: "play" }));
    for (const track of screen.getAllByTestId("hero-scroll-track"))
      expect(track).toHaveAttribute("data-paused", "false");
  });
  it("pauses only the focused column and lets keyboard and horizontal wheel input browse it", () => {
    const { container } = render(<HeroFeatureCards />);
    const viewports = container.querySelectorAll<HTMLElement>(
      "[data-column-viewport]"
    );
    const viewport = viewports[0];
    Object.defineProperty(viewport, "clientHeight", { value: 600 });
    viewport.scrollTop = 500;
    fireEvent.focus(viewport);
    const tracks = screen.getAllByTestId("hero-scroll-track");
    expect(tracks[0]).toHaveAttribute("data-paused", "true");
    expect(tracks[1]).toHaveAttribute("data-paused", "false");
    fireEvent.keyDown(viewport, { key: "ArrowDown" });
    expect(viewport.scrollTop).toBe(830);
    fireEvent.keyDown(viewport, { key: "ArrowUp" });
    expect(viewport.scrollTop).toBe(500);
    fireEvent.wheel(viewport, { deltaX: 120, deltaY: 0 });
    expect(viewport.scrollTop).toBe(620);
    fireEvent.wheel(viewport, { deltaX: -120, deltaY: 0 });
    expect(viewport.scrollTop).toBe(500);
    expect(viewports[1].scrollTop).toBe(0);
    const column = viewport.closest("[data-scroll-direction]") as HTMLElement;
    fireEvent.click(within(column).getByRole("button", { name: "scrollDown" }));
    expect(viewport.scrollTop).toBe(830);
    fireEvent.click(within(column).getByRole("button", { name: "scrollUp" }));
    expect(viewport.scrollTop).toBe(500);
    fireEvent.blur(viewport, { relatedTarget: document.body });
    expect(tracks[0]).toHaveAttribute("data-paused", "false");
  });
  it("keeps only the headline above each product preview", () => {
    const { container } = render(<HeroFeatureCards />);
    for (const header of container.querySelectorAll(".cardHeader")) {
      expect(header.querySelector("h3")).not.toBeNull();
      expect(header.querySelector("p, .cardLabel")).toBeNull();
    }
  });
  it("suspends both columns while focus is in the showcase", () => {
    render(<HeroFeatureCards />);
    fireEvent.focus(screen.getByRole("button", { name: "pause" }));
    for (const track of screen.getAllByTestId("hero-scroll-track"))
      expect(track).toHaveAttribute("data-paused", "true");
    fireEvent.blur(screen.getByRole("button", { name: "pause" }), {
      relatedTarget: document.body,
    });
    for (const track of screen.getAllByTestId("hero-scroll-track"))
      expect(track).toHaveAttribute("data-paused", "false");
  });
  it("observes the current showcase after changing between desktop and mobile", () => {
    const originalObserver = global.IntersectionObserver;
    const observers: { observe: jest.Mock; disconnect: jest.Mock }[] = [];
    global.IntersectionObserver = jest.fn().mockImplementation(() => {
      const observer = { observe: jest.fn(), disconnect: jest.fn() };
      observers.push(observer);
      return observer;
    });
    try {
      const { rerender, unmount } = render(<HeroFeatureCards />);
      const desktopObserver = observers.at(-1)!;
      expect(desktopObserver.observe).toHaveBeenCalledWith(
        screen.getByTestId("hero-showcase")
      );
      mockMobile = true;
      rerender(<HeroFeatureCards />);
      expect(desktopObserver.disconnect).toHaveBeenCalled();
      const mobileObserver = observers.at(-1)!;
      expect(mobileObserver).not.toBe(desktopObserver);
      expect(mobileObserver.observe).toHaveBeenCalledWith(
        screen.getByTestId("hero-showcase")
      );
      mockMobile = false;
      rerender(<HeroFeatureCards />);
      expect(mobileObserver.disconnect).toHaveBeenCalled();
      expect(observers.at(-1)!.observe).toHaveBeenCalledWith(
        screen.getByTestId("hero-showcase")
      );
      unmount();
      expect(observers.at(-1)!.disconnect).toHaveBeenCalled();
    } finally {
      global.IntersectionObserver = originalObserver;
    }
  });
  it("makes reduced-motion stories static without clipped loop copies", () => {
    mockReducedMotion = true;
    render(<HeroFeatureCards />);
    expect(screen.getByTestId("hero-showcase")).toHaveAttribute(
      "data-static",
      "true"
    );
    expect(screen.queryByTestId("hero-scroll-copy")).not.toBeInTheDocument();
    expect(screen.getAllByRole("article")).toHaveLength(6);
    expect(
      screen.queryByRole("button", { name: "pause" })
    ).not.toBeInTheDocument();
  });
  it("clears transient interaction pauses after a breakpoint change but preserves manual pause", () => {
    const { rerender } = render(<HeroFeatureCards />);
    fireEvent.focus(screen.getByRole("button", { name: "pause" }));
    fireEvent.pointerEnter(screen.getByTestId("hero-showcase"), {
      pointerType: "mouse",
    });
    mockMobile = true;
    rerender(<HeroFeatureCards />);
    mockMobile = false;
    rerender(<HeroFeatureCards />);
    expect(screen.getAllByTestId("hero-scroll-track")[0]).toHaveAttribute(
      "data-paused",
      "false"
    );
    fireEvent.click(screen.getByRole("button", { name: "pause" }));
    mockMobile = true;
    rerender(<HeroFeatureCards />);
    mockMobile = false;
    rerender(<HeroFeatureCards />);
    expect(screen.getAllByTestId("hero-scroll-track")[0]).toHaveAttribute(
      "data-paused",
      "true"
    );
  });
  it("responds when the browser motion preference changes without a page reload", () => {
    render(<HeroFeatureCards />);
    expect(screen.getAllByTestId("hero-scroll-copy")).toHaveLength(4);
    act(() => {
      mockReducedMotion = true;
      motionListeners.forEach(listener => listener());
    });
    expect(screen.getByTestId("hero-showcase")).toHaveAttribute(
      "data-static",
      "true"
    );
    expect(screen.queryByTestId("hero-scroll-copy")).not.toBeInTheDocument();
    act(() => {
      mockReducedMotion = false;
      motionListeners.forEach(listener => listener());
    });
    expect(screen.getAllByTestId("hero-scroll-copy")).toHaveLength(4);
  });
  it("lets mobile visitors reach every workflow without autoplay", () => {
    mockMobile = true;
    render(<HeroFeatureCards />);
    expect(screen.queryByTestId("hero-scroll-track")).not.toBeInTheDocument();
    const seen = new Set<string>();
    for (let index = 0; index < HERO_WORKFLOWS.length; index++) {
      seen.add(screen.getByRole("article").getAttribute("data-feature-card")!);
      fireEvent.click(screen.getByRole("button", { name: "next" }));
    }
    expect(seen.size).toBe(9);
    expect(screen.getByRole("article")).toHaveAttribute(
      "data-feature-card",
      "interactive"
    );
  });
  it("reconciles focus when motion preferences remove a focused control", async () => {
    render(<HeroFeatureCards />);
    act(() => screen.getByRole("button", { name: "pause" }).focus());
    act(() => {
      mockReducedMotion = true;
      motionListeners.forEach(listener => listener());
    });
    act(() => {
      mockReducedMotion = false;
      motionListeners.forEach(listener => listener());
    });
    await waitFor(() =>
      expect(screen.getAllByTestId("hero-scroll-track")[0]).toHaveAttribute(
        "data-paused",
        "false"
      )
    );
    act(() => screen.getByRole("button", { name: "explore" }).focus());
    act(() => {
      mockReducedMotion = true;
      motionListeners.forEach(listener => listener());
    });
    act(() => {
      mockReducedMotion = false;
      motionListeners.forEach(listener => listener());
    });
    await waitFor(() =>
      expect(screen.getAllByTestId("hero-scroll-track")[0]).toHaveAttribute(
        "data-paused",
        "true"
      )
    );
  });
  it("opens all workflows in the existing dialog and changes the selected example", () => {
    render(<HeroFeatureCards />);
    fireEvent.click(screen.getByRole("button", { name: "explore" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.click(
      within(dialog).getByRole("button", { name: /cards.voice.badge/ })
    );
    expect(
      within(dialog).getByRole("heading", { name: "cards.voice.title" })
    ).toBeInTheDocument();
    expect(within(dialog).getByText("reviewNote")).toBeInTheDocument();
  });
  it("lets the compact chooser reach every example and resets a scrolled story", () => {
    render(<HeroFeatureCards />);
    fireEvent.click(screen.getByRole("button", { name: "explore" }));
    const dialog = screen.getByRole("dialog");
    const chooser = within(dialog).getByRole("combobox", {
      name: "workflowLabel",
    });
    for (const workflow of HERO_WORKFLOWS) {
      const story = dialog.querySelector<HTMLElement>("#workflow-detail")!;
      story.scrollTop = 300;
      fireEvent.change(chooser, { target: { value: workflow.id } });
      expect(
        within(dialog).getByRole("heading", {
          name: `cards.${workflow.id}.title`,
        })
      ).toBeInTheDocument();
      expect(story.scrollTop).toBe(0);
    }
    expect(within(dialog).getByRole("button", { name: "close" })).toBeVisible();
  });
});
