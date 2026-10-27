/**
 * @jest-environment jsdom
 */

import "@testing-library/jest-dom";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { WhatsAppReconnectBannerClient } from "./reconnect-banner-client";

const mockCapture = jest.fn();
const mockLoadPostHogClient = jest.fn();
const mockUseSWR = jest.fn();

jest.mock("@/lib/posthog/client", () => ({
  loadPostHogClient: (...args: unknown[]) => mockLoadPostHogClient(...args),
}));

jest.mock("swr", () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockUseSWR(...args),
}));

jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

jest.mock("next-intl", () => ({
  useTranslations: () => {
    const messages: Record<string, string> = {
      removedTitle: "WhatsApp was disconnected",
      warningTitle: "Restore your WhatsApp connection",
      expiredTitle: "Restore your WhatsApp connection",
      body: "Confirm access in WhatsApp to restore the connection.",
      removedBodyWithPhone:
        "+7 701 000 00 00 is no longer connected to airi.chat. Cloud API messages are paused.",
      cta: "Reconnect",
      dismissWorkspace: "Dismiss for everyone in this workspace",
      dismissError: "Could not dismiss the alert. Try again.",
    };
    return (key: string) => messages[key] ?? key;
  },
}));

const removedStatus = {
  state: "removed" as const,
  daysUntilExpiry: null,
  wabaId: "waba-1",
  displayPhoneNumber: "+7 701 000 00 00",
  reconnectMethod: "embedded" as const,
  partnerRemoval: {
    sourceId: "source-1",
    removedAt: "2026-08-20T08:00:00.000Z",
    alertDismissed: false,
    reason: "BUSINESS_DOWNGRADE",
    initiatedBy: "USER",
  },
};

describe("WhatsAppReconnectBannerClient", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    window.sessionStorage.clear();
    global.fetch = jest.fn();
    mockLoadPostHogClient.mockResolvedValue({ capture: mockCapture });
    mockUseSWR.mockReturnValue({ data: undefined, mutate: jest.fn() });
  });

  it("renders a distinct persistent alert for a partner removal", async () => {
    render(
      <WhatsAppReconnectBannerClient
        workspaceId="workspace-1"
        companyId="company-1"
        status={removedStatus}
      />
    );

    expect(
      await screen.findByText("WhatsApp was disconnected")
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "+7 701 000 00 00 is no longer connected to airi.chat. Cloud API messages are paused."
      )
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Reconnect/ })).toHaveAttribute(
      "href",
      "/panel/w/workspace-1/settings/integrations?type=whatsapp&reconnect=1"
    );
    expect(
      screen.getByRole("button", {
        name: "Dismiss for everyone in this workspace",
      })
    ).toBeInTheDocument();
  });

  it("does not render a workspace-dismissed removal in the initial HTML", () => {
    const html = renderToString(
      <WhatsAppReconnectBannerClient
        workspaceId="workspace-1"
        companyId="company-1"
        status={{
          ...removedStatus,
          partnerRemoval: {
            ...removedStatus.partnerRemoval,
            alertDismissed: true,
          },
        }}
      />
    );

    expect(html).not.toContain("WhatsApp was disconnected");
  });

  it("persists a workspace-wide dismissal before hiding the removal alert", async () => {
    const user = userEvent.setup();
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({ acknowledged: true }),
    });
    render(
      <WhatsAppReconnectBannerClient
        workspaceId="workspace-1"
        companyId="company-1"
        status={removedStatus}
      />
    );

    await user.click(
      screen.getByRole("button", {
        name: "Dismiss for everyone in this workspace",
      })
    );

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/whatsapp/reconnect-status",
        expect.objectContaining({
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            workspaceId: "workspace-1",
            sourceId: "source-1",
            removedAt: "2026-08-20T08:00:00.000Z",
          }),
        })
      );
    });
    expect(
      screen.queryByText("WhatsApp was disconnected")
    ).not.toBeInTheDocument();
  });

  it("keeps the removal alert visible when acknowledgement fails", async () => {
    const user = userEvent.setup();
    (global.fetch as jest.Mock).mockResolvedValue({ ok: false });
    render(
      <WhatsAppReconnectBannerClient
        workspaceId="workspace-1"
        companyId="company-1"
        status={removedStatus}
      />
    );

    await user.click(
      screen.getByRole("button", {
        name: "Dismiss for everyone in this workspace",
      })
    );

    expect(
      await screen.findByText("Could not dismiss the alert. Try again.")
    ).toBeInTheDocument();
    expect(screen.getByText("WhatsApp was disconnected")).toBeInTheDocument();
  });

  it("surfaces a partner removal received while the panel remains open", async () => {
    mockUseSWR.mockReturnValue({ data: removedStatus, mutate: jest.fn() });

    render(
      <WhatsAppReconnectBannerClient
        workspaceId="workspace-1"
        companyId="company-1"
        status={{
          state: "healthy",
          daysUntilExpiry: 30,
          reconnectMethod: "embedded",
        }}
      />
    );

    expect(
      await screen.findByText("WhatsApp was disconnected")
    ).toBeInTheDocument();
  });

  it("keeps an unknown token expiry silent while monitoring for removals", async () => {
    render(
      <WhatsAppReconnectBannerClient
        workspaceId="workspace-1"
        companyId="company-1"
        status={{
          state: "unknown",
          daysUntilExpiry: null,
          reconnectMethod: "embedded",
        }}
      />
    );

    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("keeps automatic connection maintenance silent", async () => {
    render(
      <WhatsAppReconnectBannerClient
        workspaceId="workspace-1"
        status={{
          state: "maintaining",
          daysUntilExpiry: 5,
          reconnectMethod: "embedded",
        }}
      />
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(mockCapture).not.toHaveBeenCalled();
  });

  it("shows an actionable connection recovery without technical expiry copy", async () => {
    render(
      <WhatsAppReconnectBannerClient
        workspaceId="workspace-1"
        status={{
          state: "action_required",
          daysUntilExpiry: 5,
          reconnectMethod: "embedded",
        }}
      />
    );
    expect(
      await screen.findByText("Restore your WhatsApp connection")
    ).toBeInTheDocument();
    expect(
      screen.getByText("Confirm access in WhatsApp to restore the connection.")
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Reconnect/ })).toBeInTheDocument();
    expect(screen.getByRole("alert")).not.toHaveTextContent(
      /token|days|paused/i
    );
  });

  it("does not duplicate analytics when polling returns the same removal", async () => {
    const { rerender } = render(
      <WhatsAppReconnectBannerClient
        workspaceId="workspace-1"
        companyId="company-1"
        status={removedStatus}
      />
    );
    await waitFor(() => expect(mockCapture).toHaveBeenCalledTimes(1));

    mockUseSWR.mockReturnValue({
      data: {
        ...removedStatus,
        partnerRemoval: { ...removedStatus.partnerRemoval },
      },
      mutate: jest.fn(),
    });
    rerender(
      <WhatsAppReconnectBannerClient
        workspaceId="workspace-1"
        companyId="company-1"
        status={removedStatus}
      />
    );
    await act(async () => {
      await Promise.resolve();
    });

    expect(mockCapture).toHaveBeenCalledTimes(1);
  });
});
