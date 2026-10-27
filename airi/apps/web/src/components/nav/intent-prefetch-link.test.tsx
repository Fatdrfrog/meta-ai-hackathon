/**
 * @jest-environment jsdom
 */

import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import type { Route } from "next";
import { createRef, type ComponentProps } from "react";
import { IntentPrefetchLink } from "./intent-prefetch-link";

const mockLinkPrefetch = jest.fn();

jest.mock("next/link", () => {
  const actual = jest.requireActual("next/link");
  const ActualLink = actual.default as typeof import("next/link").default;
  function RecordingLink(props: ComponentProps<typeof ActualLink>) {
    mockLinkPrefetch(props.prefetch);
    return <ActualLink {...props} />;
  }
  return { __esModule: true, ...actual, default: RecordingLink };
});

const href = "/panel/w/workspace-1/kb" as Route;

function lastPrefetch() {
  return mockLinkPrefetch.mock.calls.at(-1)?.[0];
}

describe("IntentPrefetchLink", () => {
  beforeEach(() => {
    mockLinkPrefetch.mockClear();
  });

  it("does not prefetch just because the link is on screen", () => {
    render(<IntentPrefetchLink href={href}>Knowledge base</IntentPrefetchLink>);

    expect(
      screen.getByRole("link", { name: "Knowledge base" })
    ).toHaveAttribute("href", href);
    expect(mockLinkPrefetch.mock.calls.map(([value]) => value)).toEqual([
      false,
    ]);
  });

  it.each([
    ["hover", (link: HTMLElement) => fireEvent.mouseEnter(link)],
    ["keyboard focus", (link: HTMLElement) => fireEvent.focus(link)],
    ["touch", (link: HTMLElement) => fireEvent.touchStart(link)],
  ])("switches to the default prefetch on %s", (_label, showIntent) => {
    render(<IntentPrefetchLink href={href}>Knowledge base</IntentPrefetchLink>);

    showIntent(screen.getByRole("link"));

    expect(lastPrefetch()).toBeNull();
  });

  it("keeps an explicit full prefetch for after intent", () => {
    render(
      <IntentPrefetchLink href={href} prefetch>
        Knowledge base
      </IntentPrefetchLink>
    );
    expect(lastPrefetch()).toBe(false);

    fireEvent.mouseEnter(screen.getByRole("link"));

    expect(lastPrefetch()).toBe(true);
  });

  it("never prefetches a link that opted out", () => {
    render(
      <IntentPrefetchLink href={href} prefetch={false}>
        Widget analytics
      </IntentPrefetchLink>
    );

    fireEvent.mouseEnter(screen.getByRole("link"));
    fireEvent.focus(screen.getByRole("link"));

    expect(
      mockLinkPrefetch.mock.calls.every(([value]) => value === false)
    ).toBe(true);
  });

  it("keeps the caller's handlers and ref", () => {
    const onMouseEnter = jest.fn();
    const onFocus = jest.fn();
    const onTouchStart = jest.fn();
    const ref = createRef<HTMLAnchorElement>();
    render(
      <IntentPrefetchLink
        ref={ref}
        href={href}
        onMouseEnter={onMouseEnter}
        onFocus={onFocus}
        onTouchStart={onTouchStart}
      >
        Knowledge base
      </IntentPrefetchLink>
    );
    const link = screen.getByRole("link");

    fireEvent.mouseEnter(link);
    fireEvent.focus(link);
    fireEvent.touchStart(link);

    expect(onMouseEnter).toHaveBeenCalledTimes(1);
    expect(onFocus).toHaveBeenCalledTimes(1);
    expect(onTouchStart).toHaveBeenCalledTimes(1);
    expect(ref.current).toBe(link);
  });
});
