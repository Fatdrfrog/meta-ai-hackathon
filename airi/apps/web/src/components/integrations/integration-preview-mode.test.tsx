/**
 * @jest-environment jsdom
 */

import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { GoogleCalendarIntegration } from "./google-calendar-integration";
import { IntegrationDetailsPanel } from "./integration-details-panel";
import { IntegrationSetupGuide } from "./integration-setup-guide";

jest.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: jest.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

jest.mock("swr", () => ({
  useSWRConfig: () => ({ mutate: jest.fn() }),
}));

jest.mock("sonner", () => ({
  toast: {
    error: jest.fn(),
    success: jest.fn(),
  },
}));

jest.mock("next/link", () => ({
  __esModule: true,
  default: ({
    href,
    children,
    ...props
  }: {
    href: string;
    children: React.ReactNode;
    [key: string]: unknown;
  }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

jest.mock("next-intl", () => ({
  useTranslations: () => {
    const translate = (key: string, values?: Record<string, string>) => {
      const template =
        (
          {
            connectedTitle: "Calendar connected",
            disconnectedTitle: "Calendar disconnected",
            connectedDescription: "Connected description",
            disconnectedDescription: "Disconnected description",
            connectedBadge: "Connected",
            connect: "Connect Google Calendar",
            reconnect: "Reconnect Google Calendar",
            disconnect: "Disconnect",
            toast: "Toast",
          } as Record<string, string>
        )[key] ?? key;

      if (!values) return template;

      return Object.entries(values).reduce(
        (text, [name, value]) => text.replace(`{${name}}`, value),
        template
      );
    };

    translate.raw = () => ({
      badge: "Guide",
      title: "Telegram setup",
      description: "Create the bot and connect it after signing in.",
      primaryAction: "Open BotFather",
      secondaryAction: "Open dashboard",
      tipsTitle: "Tips",
      steps: [
        {
          title: "Create bot",
          description: "Copy the token from BotFather.",
        },
      ],
      tips: ["Keep the token private."],
      nextSteps: {
        title: "Next steps",
        description: "Use the connected mode below.",
        modes: {
          coexistence: {
            label: "Business app coexistence",
            title: "Business app next steps",
            description: "Sync 1:1 chats with airi.chat.",
            steps: [
              {
                title: "Import history",
                description: "Start history sync from this page.",
              },
            ],
            limitationsTitle: "Not available in airi.chat",
            limitations: ["Group chats", "Voice/video calls", "Catalogs"],
          },
          cloud_api: {
            label: "Full Cloud API",
            title: "Cloud API next steps",
            description: "Use airi.chat as the main inbox.",
            steps: [
              {
                title: "Check phone readiness",
                description: "Confirm status is ready.",
              },
            ],
            limitationsTitle: "Business app note",
            limitations: ["Business app is not the reply surface"],
          },
        },
        status: {
          trigger: "Your business current status",
          loading: "Fetching Meta status...",
          error: "Could not load Meta status.",
          refresh: "Refresh",
          unknown: "Unknown",
          yes: "Yes",
          no: "No",
          webhookReady: "Ready",
          webhookMissing: "Missing {count}",
          fields: {
            phone: "Phone",
            verifiedName: "Verified name",
            displayName: "Display name",
            phoneRegistration: "Phone registration",
            twoStepPin: "2-step PIN",
            quality: "Quality",
            messagingLimit: "Messaging limit",
            accountReview: "Account review",
            businessVerification: "Business verification",
            webhooks: "Webhooks",
          },
        },
      },
    });

    return translate;
  },
}));

describe("integration preview mode", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.clearAllMocks();
  });

  it("disables OAuth connection controls instead of linking to connect routes", () => {
    render(
      <GoogleCalendarIntegration
        workspaceId="landing-preview"
        connectionActionsDisabled
      />
    );

    expect(
      screen.getByRole("button", { name: /connect google calendar/i })
    ).toBeDisabled();
    expect(
      screen.queryByRole("link", { name: /connect google calendar/i })
    ).not.toBeInTheDocument();
  });

  it("keeps provider info links active and routes app-only links to login", () => {
    render(
      <IntegrationSetupGuide
        integrationId="telegram"
        workspaceId="landing-preview"
        secondaryActionHref="/login"
      />
    );

    expect(
      screen.getByRole("link", { name: /open botfather/i })
    ).toHaveAttribute("href", "https://t.me/BotFather");
    expect(
      screen.getByRole("link", { name: /open dashboard/i })
    ).toHaveAttribute("href", "/login");
  });

  it("keeps compact preview guides link-focused without setup steps or tips", () => {
    render(
      <IntegrationSetupGuide
        integrationId="telegram"
        workspaceId="landing-preview"
        secondaryActionHref="/login"
        presentation="landingCompact"
      />
    );

    expect(
      screen.getByRole("link", { name: /open botfather/i })
    ).toHaveAttribute("href", "https://t.me/BotFather");
    expect(
      screen.queryByRole("link", { name: /open dashboard/i })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("Copy the token from BotFather.")
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Tips")).not.toBeInTheDocument();
  });

  it("keeps compact detail summaries descriptive without status or app links", () => {
    render(
      <IntegrationDetailsPanel
        sources={[]}
        emailIntegrationEnabled
        emailProviderStatus="disconnected"
        workspaceId="landing-preview"
        selectedIntegrationId="whatsapp"
        secondaryActionHref="/login"
        connectionActionsDisabled
        presentation="landingCompact"
      />
    );

    expect(
      screen.getByRole("heading", { name: "whatsapp.name" })
    ).toBeInTheDocument();
    expect(screen.getByText("whatsapp.description")).toBeInTheDocument();
    expect(screen.queryByText("status.disconnected")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: /open dashboard/i })
    ).not.toBeInTheDocument();
  });

  it("shows connected WhatsApp coexistence next steps and loads business status on demand", async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        connected: true,
        status: {
          display_phone_number: "+7 701 000 00 00",
          verified_name: "Airi Support",
          name_status: "APPROVED",
          phone_registered: true,
          two_step_pin_enabled: true,
          quality_rating: "GREEN",
          whatsapp_business_manager_messaging_limit: "TIER_1K",
          account_review_status: "APPROVED",
          business_verification_status: "VERIFIED",
          webhook_missing_required_fields: ["history"],
        },
      }),
    });
    global.fetch = fetchMock as never;

    render(
      <IntegrationSetupGuide
        integrationId="whatsapp"
        workspaceId="workspace-1"
        source={
          {
            id: "source-1",
            type: "whatsapp",
            credentials: {
              access_token: "token",
              phone_number_id: "phone-1",
              waba_id: "waba-1",
              coexistence_mode: true,
            },
          } as never
        }
      />
    );

    expect(screen.getByText("Business app next steps")).toBeInTheDocument();
    expect(screen.getByText("Group chats")).toBeInTheDocument();
    expect(screen.getByText("Voice/video calls")).toBeInTheDocument();
    expect(screen.queryByText("Tips")).not.toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "Your business current status" })
    );

    expect(await screen.findByText("+7 701 000 00 00")).toBeInTheDocument();
    expect(screen.getByText("Airi Support")).toBeInTheDocument();
    expect(screen.getByText("Missing 1")).toBeInTheDocument();
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/whatsapp/onboarding?workspaceId=workspace-1"
      )
    );
  });
});
