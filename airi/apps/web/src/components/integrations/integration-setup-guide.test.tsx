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
import { IntegrationSetupGuide } from "./integration-setup-guide";
import type { Source } from "@/types/supabase";

jest.mock("next-intl", () => ({
  useTranslations: (namespace: string) => {
    const messages = jest.requireActual(
      "../../../messages/settings/integrations/en/page.json"
    );
    const translate = (key: string) =>
      `${namespace}.${key}`
        .split(".")
        .reduce((value, part) => value[part], messages);
    translate.raw = translate;
    return translate;
  },
}));

describe("connected WhatsApp setup status", () => {
  const originalFetch = global.fetch;
  const source = {
    id: "source-1",
    type: "whatsapp",
    credentials: {
      phone_number_id: "phone-1",
      waba_id: "waba-1",
      access_token: "token",
      phone_registered: true,
      phone_registration_status: "REGISTERED",
    },
  } as Source;

  beforeEach(() => {
    global.fetch = jest
      .fn()
      .mockImplementation(() => new Promise(() => undefined));
  });
  afterEach(() => {
    global.fetch = originalFetch;
    jest.useRealTimers();
  });

  const showGuide = (currentSource = source) => {
    const result = render(
      <IntegrationSetupGuide
        integrationId="whatsapp"
        workspaceId="workspace-1"
        source={currentSource}
      />
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Your business current status" })
    );
    return result;
  };

  it("stops after a failed initial check and retries only when requested", async () => {
    const fetchMock = global.fetch as jest.Mock;
    fetchMock.mockResolvedValueOnce({
      ok: false,
      json: async () => ({ error: "Meta unavailable" }),
    });
    showGuide();
    await act(async () => {});
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["disconnected", { connected: false, status: null }, "Disconnected"],
    ["unknown", { connected: true, status: {} }, "Status unknown"],
    [
      "coexistence needing reconnect",
      {
        connected: true,
        status: {
          account_health: { state: "reconnecting", reasons: [] },
          webhook_requires_reconnect: true,
          webhook_missing_required_fields: [],
          webhook_fields_last_checked_at: "2026-09-06T00:00:00Z",
        },
      },
      "Reconnecting",
    ],
  ])("never labels %s status Ready", async (_, payload, expected) => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => payload,
    });
    showGuide();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /Your business current status/ })
      ).toHaveTextContent(expected)
    );
    expect(screen.queryByText("Ready")).not.toBeInTheDocument();
  });

  it("honors explicit unregistered status over saved registration evidence", async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        connected: true,
        status: {
          phone_registered: false,
          phone_registration_status: "VERIFIED",
          platform_type: "CLOUD_API",
        },
      }),
    });
    showGuide();
    const label = await screen.findByText("Phone registration");
    expect(
      within(label.closest('[data-slot="item"]') as HTMLElement).getByText("No")
    ).toBeInTheDocument();
  });

  it("shows cached status during provider cooldown without retrying automatically", async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        connected: true,
        status: {
          display_phone_number: "+15555550123",
          account_health: { state: "unknown", reasons: [] },
        },
        meta_refresh: {
          outcome: "cooldown",
          requested: true,
          performed: false,
          cooldown_until: "2099-01-01T00:00:00Z",
        },
      }),
    });
    showGuide();
    expect(
      await screen.findByText(/Meta is rate-limiting status checks/)
    ).toBeInTheDocument();
    expect(screen.getByText("+15555550123")).toBeInTheDocument();
    expect(global.fetch).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Refresh" })).toBeDisabled()
    );
  });

  it("does not mark webhooks ready without a verified app subscription", async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        connected: true,
        status: {
          webhook_subscribed: false,
          webhook_missing_required_fields: [],
          webhook_fields_last_checked_at: "2026-09-06T00:00:00Z",
        },
      }),
    });
    showGuide();
    const label = await screen.findByText("Webhooks");
    expect(
      within(label.closest('[data-slot="item"]') as HTMLElement).getByText(
        "Unknown"
      )
    ).toBeInTheDocument();
  });

  it("retains returned status and cooldown on an HTTP rate-limit response", async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: false,
      json: async () => ({
        connected: true,
        status: {
          display_phone_number: "+15555550123",
        },
        error: "Rate limited",
        meta_refresh: {
          outcome: "rate_limited",
          cooldown_until: "2099-01-01T00:00:00Z",
        },
      }),
    });
    showGuide();
    expect(
      await screen.findByText(/Meta is rate-limiting status checks/)
    ).toBeInTheDocument();
    expect(screen.getByText("+15555550123")).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Refresh" })).toBeDisabled()
    );
  });

  it("shows live verified webhook coverage despite a stale legacy subscription flag", async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        connected: true,
        status: {
          webhook_subscribed: false,
          waba_selected_app_matches_config: true,
          webhook_missing_required_fields: [],
          webhook_fields_last_checked_at: "2026-09-06T00:00:00Z",
        },
      }),
    });
    showGuide();
    const label = await screen.findByText("Webhooks");
    expect(
      within(label.closest('[data-slot="item"]') as HTMLElement).getByText(
        "Ready"
      )
    ).toBeInTheDocument();
  });

  it.each(["minimum_interval", "in_progress"])(
    "shows a deferred %s response without turning cached status into an error",
    async outcome => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: false,
        json: async () => ({
          connected: true,
          status: {
            display_phone_number: "+15555550123",
            account_health: { state: "unknown", reasons: [] },
          },
          error: "Status check deferred",
          meta_refresh: { outcome, performed: false, requested: true },
        }),
      });
      showGuide();
      expect(await screen.findByText("+15555550123")).toBeInTheDocument();
      expect(
        screen.queryByText("Status check deferred")
      ).not.toBeInTheDocument();
      expect(
        screen.getByText(/A recent Meta status is still being used/)
      ).toBeInTheDocument();
      expect(global.fetch).toHaveBeenCalledTimes(1);
    }
  );
});

describe("setup guide before connecting", () => {
  it.each(["whatsapp", "telegram", "instagram"] as const)(
    "links the %s guide's secondary action to customer chats",
    integrationId => {
      render(
        <IntegrationSetupGuide
          integrationId={integrationId}
          workspaceId="workspace-1"
        />
      );

      expect(
        screen.getByRole("link", { name: "Open customer chats" })
      ).toHaveAttribute("href", "/panel/w/workspace-1/requests");
    }
  );

  it("describes the current WhatsApp connection choices", () => {
    render(
      <IntegrationSetupGuide
        integrationId="whatsapp"
        workspaceId="workspace-1"
      />
    );

    expect(
      screen.getByText("Choose Cloud API or the Business app")
    ).toBeInTheDocument();
    expect(screen.queryByText(/OAuth/)).not.toBeInTheDocument();
    expect(screen.queryByText(/\bQR\b/)).not.toBeInTheDocument();
  });
});
