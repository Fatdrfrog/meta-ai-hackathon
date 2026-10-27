/**
 * @jest-environment jsdom
 */

import "@testing-library/jest-dom";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Banner } from "./banner";

const getExplicitConsentStatus = jest.fn();
const optInCapturing = jest.fn();
const optOutCapturing = jest.fn();
const loadPostHogClientMock = jest.fn();
let mockPathname = "/";
let mockLocale = "en";

jest.mock("next/navigation", () => ({
  usePathname: () => mockPathname,
}));

jest.mock("next-intl", () => ({
  useTranslations: (namespace: string) => (key: string) => {
    const messages = jest.requireActual(`../../messages/${mockLocale}.json`);
    return `${namespace}.${key}`
      .split(".")
      .reduce<unknown>(
        (value, part) => (value as Record<string, unknown>)[part],
        messages
      );
  },
}));

jest.mock("@/lib/posthog/client", () => ({
  loadPostHogClient: (...args: unknown[]) => loadPostHogClientMock(...args),
  getPostHogConsentStorageKey: () => null,
  getInitializedPostHogClient: () => null,
  syncPostHogIdentity: jest.fn(),
}));

describe("Banner", () => {
  beforeEach(() => {
    mockPathname = "/";
    mockLocale = "en";
    window.localStorage.clear();
    getExplicitConsentStatus.mockReset();
    optInCapturing.mockReset();
    optOutCapturing.mockReset();
    loadPostHogClientMock.mockReset();
    loadPostHogClientMock.mockResolvedValue({
      get_explicit_consent_status: getExplicitConsentStatus,
      opt_in_capturing: optInCapturing,
      opt_out_capturing: optOutCapturing,
    });
    getExplicitConsentStatus.mockReturnValue("pending");
  });

  afterEach(() => {
    cleanup();
    document.getElementById("landing-consent-slot")?.remove();
    jest.restoreAllMocks();
  });

  function addLandingSlot(ready = true) {
    const slot = document.createElement("div");
    slot.id = "landing-consent-slot";
    if (ready) slot.dataset.landingConsentReady = "true";
    document.body.appendChild(slot);
    return slot;
  }

  it.each([
    "/login",
    "/login/password",
    "/setup",
    "/setup/profile",
    "/onboarding",
    "/onboarding/workspace",
    "/auth/callback",
  ])("keeps the consent prompt hidden on the route %s", async pathname => {
    mockPathname = pathname;

    render(<Banner />);

    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByText(/tracking cookies/i)).not.toBeInTheDocument();
  });

  it("shows pending landing consent inside the normal-flow page slot", async () => {
    const slot = addLandingSlot();
    const { container } = render(<Banner />);

    const accept = await within(slot).findByRole("button", {
      name: "Accept cookies",
    });

    expect(container).toBeEmptyDOMElement();
    expect(slot).toContainElement(accept);
    expect(slot.querySelector(".fixed")).toBeNull();
    expect(within(slot).getByText(/improve airi.chat/i)).toBeInTheDocument();
  });

  it("still offers a persisted consent choice when PostHog is not configured", async () => {
    loadPostHogClientMock.mockResolvedValue(null);
    const slot = addLandingSlot();
    const user = userEvent.setup();
    const { unmount } = render(<Banner />);

    await user.click(
      await within(slot).findByRole("button", { name: "Decline" })
    );
    expect(slot).toBeEmptyDOMElement();
    expect(window.localStorage.getItem("airi_tracking_consent")).toBe("0");

    unmount();
    render(<Banner />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(slot).toBeEmptyDOMElement();
  });

  it("waits for a delayed landing slot without showing a fixed fallback", async () => {
    const disconnect = jest.spyOn(MutationObserver.prototype, "disconnect");
    render(<Banner />);

    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(disconnect).not.toHaveBeenCalled();

    let slot!: HTMLDivElement;
    await act(async () => {
      slot = addLandingSlot();
    });

    expect(
      within(slot).getByRole("button", { name: "Accept cookies" })
    ).toBeInTheDocument();
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it("leaves the server-rendered slot empty until the landing page marks it ready", async () => {
    const slot = addLandingSlot(false);
    const disconnect = jest.spyOn(MutationObserver.prototype, "disconnect");
    render(<Banner />);
    await act(async () => {
      await Promise.resolve();
    });

    expect(getExplicitConsentStatus).toHaveBeenCalledTimes(1);
    expect(slot).toBeEmptyDOMElement();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(disconnect).not.toHaveBeenCalled();

    await act(async () => {
      slot.dataset.landingConsentReady = "true";
    });

    expect(
      within(slot).getByRole("button", { name: "Accept cookies" })
    ).toBeInTheDocument();
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it("disconnects a pending slot observer when the banner unmounts", async () => {
    const observe = jest.spyOn(MutationObserver.prototype, "observe");
    const disconnect = jest.spyOn(MutationObserver.prototype, "disconnect");
    const { unmount } = render(<Banner />);
    await act(async () => {
      await Promise.resolve();
    });

    expect(observe).toHaveBeenCalledWith(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-landing-consent-ready"],
    });
    expect(disconnect).not.toHaveBeenCalled();

    unmount();

    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["Accept cookies", optInCapturing, optOutCapturing],
    ["Decline", optOutCapturing, optInCapturing],
  ] as const)(
    "%s persists the same PostHog consent choice and dismisses the strip",
    async (name, expectedConsentCall, oppositeConsentCall) => {
      const user = userEvent.setup();
      const slot = addLandingSlot();
      render(<Banner />);

      await user.click(await within(slot).findByRole("button", { name }));

      expect(expectedConsentCall).toHaveBeenCalledTimes(1);
      expect(oppositeConsentCall).not.toHaveBeenCalled();
      expect(loadPostHogClientMock).toHaveBeenCalledTimes(2);
      expect(slot).toBeEmptyDOMElement();
    }
  );

  it.each(["granted", "denied"])(
    "does not render a landing prompt after persisted consent is %s",
    async status => {
      getExplicitConsentStatus.mockReturnValue(status);
      const slot = addLandingSlot();
      const observe = jest.spyOn(MutationObserver.prototype, "observe");
      render(<Banner />);
      await act(async () => {
        await Promise.resolve();
      });

      expect(slot).toBeEmptyDOMElement();
      expect(observe).not.toHaveBeenCalled();
    }
  );

  it("preserves the fixed banner on other public routes", async () => {
    mockPathname = "/about";
    const slot = addLandingSlot();
    const { container } = render(<Banner />);

    await screen.findByText(/tracking cookies/i);

    expect(container.firstElementChild).toHaveClass("fixed", "bottom-4");
    expect(slot).toBeEmptyDOMElement();
  });

  it.each(["en", "ru", "kz"])(
    "uses translated marketplace cookie copy and preserves the declined choice in %s",
    async locale => {
      mockPathname = "/whatsapp-templates";
      mockLocale = locale;
      const messages = jest.requireActual(`../../messages/${locale}.json`);
      const consent = messages.LandingPage.cookieConsent;
      const user = userEvent.setup();
      const { container } = render(<Banner />);

      const decline = await screen.findByRole("button", {
        name: consent.decline,
      });
      expect(screen.getByRole("alert")).toBeVisible();
      expect(screen.getByRole("alert").textContent).toBe(consent.description);
      expect(
        screen.getByRole("button", { name: consent.accept })
      ).toBeVisible();
      expect(container.firstElementChild).toHaveClass("fixed", "bottom-4");

      await user.click(decline);
      expect(window.localStorage.getItem("airi_tracking_consent")).toBe("0");
      expect(optOutCapturing).toHaveBeenCalledTimes(1);
      expect(optInCapturing).not.toHaveBeenCalled();
      expect(container).toBeEmptyDOMElement();
    }
  );

  it("moves the pending prompt from the landing slot to the existing route fallback", async () => {
    const slot = addLandingSlot();
    const { container, rerender } = render(<Banner />);
    await within(slot).findByRole("button", { name: "Accept cookies" });

    mockPathname = "/about";
    rerender(<Banner />);

    expect(slot).toBeEmptyDOMElement();
    expect(container.firstElementChild).toHaveClass("fixed", "bottom-4");
    expect(loadPostHogClientMock).toHaveBeenCalledTimes(1);
  });

  it("cleans up the delayed-slot observer when navigating away", async () => {
    const disconnect = jest.spyOn(MutationObserver.prototype, "disconnect");
    const { container, rerender } = render(<Banner />);
    await act(async () => {
      await Promise.resolve();
    });

    mockPathname = "/about";
    rerender(<Banner />);

    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(container.firstElementChild).toHaveClass("fixed", "bottom-4");
  });
});
