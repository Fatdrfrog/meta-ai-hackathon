/** @jest-environment jsdom */

import { render } from "@testing-library/react";
import {
  ConditionalWidgetLoader,
  shouldLoadWidgetOnHost,
} from "./conditional-widget-loader";

const mockUsePathname = jest.fn();

jest.mock("next/navigation", () => ({
  usePathname: () => mockUsePathname(),
}));

const widgetLoaderSelector =
  'script[src^="https://widget.airi.chat/loader.js"]';
const currentWidgetLoaderSelector =
  'script[src="https://widget.airi.chat/loader.js?v=20260508"]';

type WidgetWindow = Window & {
  __AIRI_WIDGET_LOADED__?: boolean;
  __ICECORE_WIDGET_LOADED__?: boolean;
};

describe("ConditionalWidgetLoader", () => {
  const originalForceWidgetInDev = process.env.NEXT_PUBLIC_FORCE_WIDGET_IN_DEV;

  beforeEach(() => {
    mockUsePathname.mockReset();
    document.head.innerHTML = "";
    document.body.innerHTML = "";
    delete process.env.NEXT_PUBLIC_FORCE_WIDGET_IN_DEV;
    delete (window as WidgetWindow).__AIRI_WIDGET_LOADED__;
    delete (window as WidgetWindow).__ICECORE_WIDGET_LOADED__;
  });

  afterAll(() => {
    if (originalForceWidgetInDev === undefined) {
      delete process.env.NEXT_PUBLIC_FORCE_WIDGET_IN_DEV;
    } else {
      process.env.NEXT_PUBLIC_FORCE_WIDGET_IN_DEV = originalForceWidgetInDev;
    }
  });

  it("does not load the public widget on the login page", () => {
    mockUsePathname.mockReturnValue("/login");

    render(<ConditionalWidgetLoader />);

    expect(document.querySelector(widgetLoaderSelector)).toBeNull();
    expect(document.getElementById("airi-widget-host")).toBeNull();
  });

  it("loads the public widget on marketing pages when explicitly forced", () => {
    process.env.NEXT_PUBLIC_FORCE_WIDGET_IN_DEV = "true";
    mockUsePathname.mockReturnValue("/");

    render(<ConditionalWidgetLoader />);

    const script =
      document.querySelector<HTMLScriptElement>(widgetLoaderSelector);
    expect(script).not.toBeNull();
    expect(script?.src).toBe("https://widget.airi.chat/loader.js?v=20260508");
    expect(script?.dataset.clientKey).toBe(
      "widget_ae31aeac8e113a9e8c22d2fce36985c9"
    );
  });

  it("replaces stale public widget loader URLs when explicitly forced", () => {
    process.env.NEXT_PUBLIC_FORCE_WIDGET_IN_DEV = "true";
    mockUsePathname.mockReturnValue("/");

    const staleScript = document.createElement("script");
    staleScript.src = "https://widget.airi.chat/loader.js";
    staleScript.setAttribute(
      "data-client-key",
      "widget_ae31aeac8e113a9e8c22d2fce36985c9"
    );
    document.body.appendChild(staleScript);

    render(<ConditionalWidgetLoader />);

    expect(document.querySelectorAll(widgetLoaderSelector)).toHaveLength(1);
    expect(document.querySelector(currentWidgetLoaderSelector)).not.toBeNull();
  });

  it("clears both current and legacy widget loaded flags when leaving public pages", () => {
    process.env.NEXT_PUBLIC_FORCE_WIDGET_IN_DEV = "true";
    mockUsePathname.mockReturnValue("/");

    const { rerender } = render(<ConditionalWidgetLoader />);
    (window as WidgetWindow).__AIRI_WIDGET_LOADED__ = true;
    (window as WidgetWindow).__ICECORE_WIDGET_LOADED__ = true;

    mockUsePathname.mockReturnValue("/login");
    rerender(<ConditionalWidgetLoader />);

    expect((window as WidgetWindow).__AIRI_WIDGET_LOADED__).toBe(false);
    expect((window as WidgetWindow).__ICECORE_WIDGET_LOADED__).toBe(false);
  });

  it("loads the widget on airi.chat's own help center", () => {
    process.env.NEXT_PUBLIC_FORCE_WIDGET_IN_DEV = "true";
    mockUsePathname.mockReturnValue("/airichat/kb/article-1");

    render(<ConditionalWidgetLoader />);

    expect(document.querySelector(widgetLoaderSelector)).not.toBeNull();
  });

  // Regression: airi.chat's sales chat appeared on customers' help centers.
  it.each(["/test12/kb", "/acme/kb/article-1", "/airichat-clone/kb"])(
    "does not load airi.chat's widget on a customer's help center (%s)",
    pathname => {
      process.env.NEXT_PUBLIC_FORCE_WIDGET_IN_DEV = "true";
      mockUsePathname.mockReturnValue(pathname);

      render(<ConditionalWidgetLoader />);

      expect(document.querySelector(widgetLoaderSelector)).toBeNull();
    }
  );

  it.each(["/get-started", "/integrations", "/knowledge-base", "/performance"])(
    "does not load the widget on removed docs pages (%s)",
    pathname => {
      process.env.NEXT_PUBLIC_FORCE_WIDGET_IN_DEV = "true";
      mockUsePathname.mockReturnValue(pathname);

      render(<ConditionalWidgetLoader />);

      expect(document.querySelector(widgetLoaderSelector)).toBeNull();
    }
  );

  it("does not load the public widget on Vercel preview hosts by default", () => {
    expect(
      shouldLoadWidgetOnHost(
        "nest-ai-front-8q6yj82dg-fatdrfrogs-projects.vercel.app"
      )
    ).toBe(false);
  });

  it("loads the public widget on canonical marketing hosts", () => {
    expect(shouldLoadWidgetOnHost("www.airi.chat")).toBe(true);
    expect(shouldLoadWidgetOnHost("airi.chat")).toBe(true);
  });
});
