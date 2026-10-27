/**
 * @jest-environment jsdom
 */

import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { useIntegrations } from "@/hooks/use-integrations";
import {
  getWhatsAppReconnectDefaultTab,
  isWhatsAppBusinessAppConnection,
} from "@/lib/whatsapp/connection-repair-mode";
import { WhatsAppIntegration } from "./whatsapp-integration";

let mockSearchParams = new URLSearchParams();
const mockFormProps = jest.fn();

const mockUseIntegrations = useIntegrations as jest.MockedFunction<
  typeof useIntegrations
>;

jest.mock("next/navigation", () => ({
  useSearchParams: () => mockSearchParams,
}));

jest.mock("next/link", () => ({
  __esModule: true,
  default: ({
    href,
    children,
    ...props
  }: {
    href: string;
    children: ReactNode;
  }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

jest.mock("next-intl", () => ({
  useTranslations: (namespace: string) => {
    const messages: Record<string, string> = {
      "WhatsAppIntegration.whatsAppConnected": "Connected",
      "WhatsAppIntegration.whatsAppReconnectTitle":
        "Restore your WhatsApp connection",
      "WhatsAppIntegration.whatsAppReconnectPrompt":
        "Confirm access in WhatsApp to restore the connection.",
      "WhatsAppIntegration.connectionManaged":
        "Connection managed automatically",
      "WhatsAppIntegration.connectedSummaryLabel":
        "WhatsApp connection summary",
      "WhatsAppIntegration.repairToggle": "Repair connection",
      "WhatsAppIntegration.repairHide": "Done",
      "WhatsAppIntegration.repairTitle": "Reconnect without deleting data",
      "WhatsAppIntegration.repairDescription":
        "Refresh Meta access for this source.",
      "WhatsAppIntegration.repairCloudDescription":
        "Use Cloud API to refresh permissions.",
      "WhatsAppIntegration.existingInventory.button": "Choose existing number",
      "WhatsAppIntegration.reconnectWhatsapp": "Reconnect WhatsApp",
      "WhatsAppIntegration.tabs.embedded": "Cloud API",
      "WhatsAppIntegration.tabs.qr": "Business app",
      "WhatsAppIntegration.summary.quality": "Quality {quality}",
      "WhatsAppIntegration.summary.phone": "{phone}",
      "WhatsAppIntegration.summary.catalog": "Catalog access",
      "WhatsAppIntegration.branching.question": "WhatsApp connection type",
      "WhatsAppIntegration.branching.helper":
        "Both options use Meta Embedded Signup.",
      "WhatsAppIntegration.branching.recommended": "Recommended",
      "WhatsAppIntegration.branching.optionYes.description":
        "Connect an existing WhatsApp Business app number.",
      "WhatsAppIntegration.branching.optionNo.description":
        "Create a Cloud API identity without the WhatsApp Business app.",
      "WhatsAppIntegration.cloudApi.title":
        "Meta will ask for the WhatsApp identity",
      "WhatsAppIntegration.cloudApi.button": "Continue",
      "WhatsAppIntegration.cloudApi.footer":
        "Choose a display name or add a number in Meta.",
      "WhatsAppIntegration.existingInventory.title":
        "Use another number from this company",
      "WhatsAppIntegration.existingInventory.description":
        "Choose an unlinked phone number for this workspace.",
      "WhatsAppIntegration.accessVerify.checking":
        "Checking Meta app readiness...",
      "WhatsAppIntegration.accessVerify.blockedTitle":
        "App Review blocks Embedded Signup",
      "WhatsAppIntegration.accessVerify.blockedBody":
        "Your Meta App needs Advanced Access for whatsapp_business_management.",
      "WhatsAppIntegration.accessVerify.endpointUnavailable":
        "Could not reach access verification endpoint.",
      "WhatsAppIntegration.accessVerify.checkFailed":
        "Access verification check failed.",
      "WhatsAppIntegration.docs.label": "Docs",
      "WhatsAppIntegration.docs.title": "Meta documentation",
      "WhatsAppIntegration.docs.description":
        "Open the relevant Meta guides in a new tab.",
      "WhatsAppIntegration.docs.cloudApi": "Cloud API",
      "WhatsAppIntegration.docs.cloudApiDescription":
        "Messaging, phone numbers, and platform basics.",
      "WhatsAppIntegration.docs.coexistence": "Business app coexistence",
      "WhatsAppIntegration.docs.coexistenceDescription":
        "Use the WhatsApp Business app and Cloud API together.",
      "WhatsAppIntegration.docs.coexistenceReconnect":
        "Reconnect offboarded coexistence",
      "WhatsAppIntegration.docs.coexistenceReconnectDescription":
        "Meta's automatic reconnect flow for device changes.",
      "WhatsAppIntegration.docs.embeddedSignup": "Embedded Signup",
      "WhatsAppIntegration.docs.embeddedSignupDescription":
        "How businesses grant your app access.",
      "WhatsAppIntegration.docs.catalog": "Catalogs",
      "WhatsAppIntegration.docs.catalogDescription":
        "Product catalogs and commerce messaging.",
      "WhatsAppIntegration.docs.marketing": "Marketing Messages",
      "WhatsAppIntegration.docs.marketingDescription":
        "Meta onboarding and Marketing Messages API.",
    };

    return (key: string, values?: Record<string, string>) => {
      const template = messages[`${namespace}.${key}`] ?? key;
      if (!values) return template;
      return Object.entries(values).reduce(
        (text, [name, value]) => text.replace(`{${name}}`, value),
        template
      );
    };
  },
}));

jest.mock("@/components/integrations/embedded-signup-button", () => ({
  EmbeddedSignupButton: ({
    label,
    disabled,
  }: {
    label: string;
    disabled?: boolean;
  }) => (
    <button type="button" disabled={disabled}>
      {label}
    </button>
  ),
}));

const mockCompanyLimits = jest.fn();
jest.mock("@/hooks/use-company-limits", () => ({
  useCompanyLimits: (workspaceId: string | null) => ({
    data: workspaceId ? mockCompanyLimits() : undefined,
  }),
}));

jest.mock("@/components/billing/plan-upgrade-dialog", () => ({
  PlanUpgradeDialog: ({ open, reason }: { open: boolean; reason?: string }) =>
    open ? <div role="dialog">upgrade {reason}</div> : null,
}));

jest.mock("@/components/integrations/embedded-signup-with-qr", () => ({
  EmbeddedSignupWithQR: () => <div>Business app setup</div>,
}));

jest.mock("@/components/integrations/whatsapp-integration-form", () => ({
  WhatsAppIntegrationForm: (props: unknown) => {
    mockFormProps(props);
    return <div>WhatsApp settings</div>;
  },
}));

jest.mock("@/lib/whatsapp/prefill-helper", () => ({
  getBusinessPrefillData: jest.fn(() => new Promise(() => undefined)),
}));

jest.mock("@/lib/whatsapp/connection-repair-mode", () => ({
  getWhatsAppReconnectDefaultTab: jest.fn(() => "embedded"),
  isWhatsAppBusinessAppConnection: jest.fn(() => false),
  withoutPartnerRemovalOverrides: jest.requireActual(
    "@/lib/whatsapp/connection-repair-mode"
  ).withoutPartnerRemovalOverrides,
}));

jest.mock("@/hooks/use-integrations", () => ({
  useIntegrations: jest.fn(() => ({
    sources: [],
    removedWhatsAppSource: null,
    emailSources: [],
    emailIntegrationEnabled: false,
    emailProviderStatus: "disconnected",
    emailProviderConnected: false,
    hasCompanyWhatsAppInventory: true,
    isLoading: false,
    isError: undefined,
    mutate: jest.fn(),
  })),
}));

describe("WhatsAppIntegration repair UX", () => {
  beforeEach(() => {
    mockCompanyLimits.mockReturnValue(undefined);
    mockSearchParams = new URLSearchParams();
    mockFormProps.mockClear();
    jest.mocked(getWhatsAppReconnectDefaultTab).mockClear();
    jest.mocked(isWhatsAppBusinessAppConnection).mockClear();
    mockUseIntegrations.mockReturnValue({
      sources: [],
      removedWhatsAppSource: null,
      emailSources: [],
      emailIntegrationEnabled: false,
      emailProviderStatus: "disconnected",
      emailProviderConnected: false,
      hasCompanyWhatsAppInventory: true,
      isLoading: false,
      isError: undefined,
      mutate: jest.fn(),
    });
  });

  it("preselects coexistence setup from the workspace creation URL", async () => {
    mockSearchParams = new URLSearchParams(
      "integration=whatsapp&whatsapp_mode=coexistence"
    );
    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ verified: true }),
      } as unknown as Response)
    );

    render(<WhatsAppIntegration workspaceId="workspace-1" />);

    expect(await screen.findByText("Business app setup")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Business app/ })).toBeChecked();
    expect(
      screen.getByRole("link", { name: "Choose existing number" })
    ).toHaveAttribute(
      "href",
      "/panel/w/workspace-1/settings/integrations/whatsapp/select?source=existing"
    );
  });

  it("defaults to Cloud API (Phone Number First) when no whatsapp_mode is set", async () => {
    mockUseIntegrations.mockReturnValue({
      sources: [],
      removedWhatsAppSource: null,
      emailSources: [],
      emailIntegrationEnabled: false,
      emailProviderStatus: "disconnected",
      emailProviderConnected: false,
      hasCompanyWhatsAppInventory: false,
      isLoading: false,
      isError: undefined,
      mutate: jest.fn(),
    });
    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ verified: true }),
      } as unknown as Response)
    );

    render(<WhatsAppIntegration workspaceId="workspace-1" />);

    expect(
      await screen.findByRole("radio", { name: /Cloud API/ })
    ).toBeChecked();
    expect(screen.getByText("Continue")).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "Choose existing number" })
    ).not.toBeInTheDocument();
  });

  it("uses business-facing repair mode names", async () => {
    render(
      <WhatsAppIntegration
        workspaceId="workspace-1"
        source={
          {
            id: "source-1",
            type: "whatsapp",
            credentials: {
              access_token: "token",
              phone_number_id: "phone-1",
              waba_id: "waba-1",
              token_expires_at: "2099-01-01T00:00:00.000Z",
              display_phone_number: "+7 701 000 00 00",
              quality_rating: "GREEN",
              catalog_ids: ["catalog-1"],
            },
          } as never
        }
      />
    );

    await screen.findByText("WhatsApp settings");

    expect(
      screen.getByRole("region", { name: "WhatsApp connection summary" })
    ).toBeInTheDocument();
    expect(screen.getByText("Quality GREEN")).toBeInTheDocument();
    expect(screen.getByText("+7 701 000 00 00")).toBeInTheDocument();
    expect(screen.getByText("Catalog access")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Docs" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Repair connection" }));

    expect(screen.getByRole("tab", { name: /Cloud API/ })).toBeInTheDocument();
    expect(
      screen.getByRole("tab", { name: /Business app/ })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Reconnect WhatsApp" })
    ).toBeInTheDocument();
  });

  it.each([undefined, null])(
    "keeps source settings accessible without an expiry: %s",
    async token_expires_at => {
      render(
        <WhatsAppIntegration
          workspaceId="workspace-1"
          source={
            {
              id: "source-1",
              type: "whatsapp",
              credentials: {
                access_token: "token",
                phone_number_id: "phone-1",
                waba_id: "waba-1",
                token_expires_at,
              },
            } as never
          }
        />
      );

      expect(await screen.findByText("WhatsApp settings")).toBeInTheDocument();
      expect(
        screen.getByRole("region", { name: "WhatsApp connection summary" })
      ).toBeInTheDocument();
      expect(screen.queryByText("Token expired.")).not.toBeInTheDocument();
    }
  );

  it.each([5, 14])(
    "keeps settings available while automatically maintaining a connection due in %s days",
    async days => {
      render(
        <WhatsAppIntegration
          workspaceId="workspace-1"
          source={
            {
              id: "source-1",
              type: "whatsapp",
              credentials: {
                access_token: "token",
                phone_number_id: "phone-1",
                waba_id: "waba-1",
                token_expires_at: new Date(
                  Date.now() + days * 86_400_000
                ).toISOString(),
              },
            } as never
          }
        />
      );

      expect(await screen.findByText("WhatsApp settings")).toBeInTheDocument();
      expect(
        screen.getByText("Connection managed automatically")
      ).toBeInTheDocument();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Reconnect WhatsApp" })
      ).not.toBeInTheDocument();
    }
  );

  it.each([
    {
      meta_diagnostics_reconnect_reason: "meta_authorization",
      webhook_requires_reconnect: true,
    },
    {
      token_expires_at: "2000-01-01T00:00:00.000Z",
      token_verified_at: "2000-01-02T00:00:00.000Z",
      token_is_valid: false,
    },
    {
      coexistence_reonboarding_status: "removed",
      cloud_api_messaging_suspended: true,
    },
  ])(
    "keeps settings available when confirmed recovery needs user action: %j",
    async credentials => {
      render(
        <WhatsAppIntegration
          workspaceId="workspace-1"
          source={
            {
              id: "source-1",
              type: "whatsapp",
              credentials: {
                access_token: "token",
                phone_number_id: "phone-1",
                waba_id: "waba-1",
                ...credentials,
              },
            } as never
          }
        />
      );

      expect(await screen.findByText("WhatsApp settings")).toBeInTheDocument();
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Restore your WhatsApp connection"
      );
      expect(screen.getByRole("alert")).not.toHaveTextContent(
        /token|days|paused/i
      );
      const restore = screen.getByRole("button", {
        name: "Reconnect WhatsApp",
      });
      expect(restore).toHaveAttribute("aria-expanded", "false");
      fireEvent.click(restore);
      expect(screen.getByRole("button", { name: "Done" })).toHaveAttribute(
        "aria-expanded",
        "true"
      );
      expect(
        screen.getByRole("tab", { name: /Cloud API/ })
      ).toBeInTheDocument();
      expect(screen.getByText("WhatsApp settings")).toBeInTheDocument();
    }
  );

  it("offers the reconnect panel for a partner-removed source the integrations list hides", async () => {
    const removedSource = {
      id: "source-removed",
      type: "whatsapp",
      credentials: {
        phone_number_id: "phone-1",
        waba_id: "waba-1",
        is_on_biz_app: true,
        coexistence_mode: true,
        partner_app_installed: false,
        coexistence_reonboarding_status: "removed",
        cloud_api_messaging_suspended: true,
      },
    };
    mockSearchParams = new URLSearchParams("type=whatsapp&reconnect=1");
    mockUseIntegrations.mockReturnValue({
      sources: [],
      removedWhatsAppSource: removedSource as never,
      emailSources: [],
      emailIntegrationEnabled: false,
      emailProviderStatus: "disconnected",
      emailProviderConnected: false,
      hasCompanyWhatsAppInventory: true,
      isLoading: false,
      isError: undefined,
      mutate: jest.fn(),
    });

    render(<WhatsAppIntegration workspaceId="workspace-1" />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Restore your WhatsApp connection"
    );
    expect(screen.getByRole("button", { name: "Done" })).toHaveAttribute(
      "aria-expanded",
      "true"
    );
    expect(
      screen.queryByRole("link", { name: "Choose existing number" })
    ).not.toBeInTheDocument();
    // Tab, badge and settings rows ignore the flags PARTNER_REMOVED forced.
    const removalView = expect.objectContaining({
      coexistence_reonboarding_status: "removed",
      is_on_biz_app: true,
      coexistence_mode: undefined,
      partner_app_installed: undefined,
    });
    expect(getWhatsAppReconnectDefaultTab).toHaveBeenLastCalledWith(
      removalView
    );
    expect(isWhatsAppBusinessAppConnection).toHaveBeenLastCalledWith(
      removalView
    );
    expect(mockFormProps).toHaveBeenLastCalledWith(
      expect.objectContaining({ credentialsProps: removalView })
    );
  });

  it("gives an active source its stored connection flags", async () => {
    const credentials = {
      access_token: "token",
      phone_number_id: "phone-1",
      waba_id: "waba-1",
      token_expires_at: "2099-01-01T00:00:00.000Z",
      coexistence_mode: true,
      partner_app_installed: true,
    };
    render(
      <WhatsAppIntegration
        workspaceId="workspace-1"
        source={{ id: "source-1", type: "whatsapp", credentials } as never}
      />
    );

    await screen.findByText("WhatsApp settings");

    expect(getWhatsAppReconnectDefaultTab).toHaveBeenLastCalledWith(
      credentials
    );
    expect(mockFormProps).toHaveBeenLastCalledWith(
      expect.objectContaining({ credentialsProps: credentials })
    );
  });

  it("opens recovery controls from the panel alert without hiding settings", async () => {
    mockSearchParams = new URLSearchParams("type=whatsapp&reconnect=1");
    render(
      <WhatsAppIntegration
        workspaceId="workspace-1"
        source={
          {
            id: "source-1",
            type: "whatsapp",
            credentials: {
              access_token: "token",
              phone_number_id: "phone-1",
              waba_id: "waba-1",
              meta_diagnostics_reconnect_reason: "meta_authorization",
              webhook_requires_reconnect: true,
            },
          } as never
        }
      />
    );

    expect(await screen.findByText("WhatsApp settings")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Cloud API/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Done" })).toHaveAttribute(
      "aria-expanded",
      "true"
    );
  });

  it("opens recovery when the panel alert changes the URL on the current settings page", async () => {
    const source = {
      id: "source-1",
      type: "whatsapp",
      credentials: {
        phone_number_id: "phone-1",
        waba_id: "waba-1",
        meta_diagnostics_reconnect_reason: "meta_authorization",
        webhook_requires_reconnect: true,
      },
    } as never;
    const { rerender } = render(
      <WhatsAppIntegration workspaceId="workspace-1" source={source} />
    );
    await screen.findByText("WhatsApp settings");
    expect(
      screen.getByRole("button", { name: "Reconnect WhatsApp" })
    ).toHaveAttribute("aria-expanded", "false");

    mockSearchParams = new URLSearchParams("type=whatsapp&reconnect=1");
    rerender(<WhatsAppIntegration workspaceId="workspace-1" source={source} />);
    expect(await screen.findByRole("button", { name: "Done" })).toHaveAttribute(
      "aria-expanded",
      "true"
    );
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(
      screen.getByRole("button", { name: "Reconnect WhatsApp" })
    ).toHaveAttribute("aria-expanded", "false");
  });
});

describe("WhatsAppIntegration first-run guidance", () => {
  const connectedSource = (createdAt: string) =>
    ({
      id: "source-1",
      type: "whatsapp",
      created_at: createdAt,
      credentials: {
        access_token: "token",
        phone_number_id: "phone-1",
        waba_id: "waba-1",
        display_phone_number: "+7 701 000 00 01",
      },
    }) as never;

  beforeEach(() => {
    mockSearchParams = new URLSearchParams();
    mockCompanyLimits.mockReturnValue(undefined);
    mockUseIntegrations.mockReturnValue({
      sources: [],
      removedWhatsAppSource: null,
      emailSources: [],
      emailIntegrationEnabled: false,
      emailProviderStatus: "disconnected",
      emailProviderConnected: false,
      hasCompanyWhatsAppInventory: false,
      isLoading: false,
      isError: undefined,
      mutate: jest.fn(),
    });
    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ verified: true }),
      } as unknown as Response)
    );
  });

  it("explains a plan limit before Meta opens and offers the plans", async () => {
    mockCompanyLimits.mockReturnValue({
      subscriptionType: "free",
      trialExpired: false,
      whatsappNumberLimit: 1,
      whatsappNumberCount: 1,
      integrationConnectionLimit: null,
      integrationConnectionCounts: {},
      channelTypes: ["whatsapp"],
      channelExhausted: false,
    });

    render(<WhatsAppIntegration workspaceId="workspace-1" />);

    expect(await screen.findByText("capacity.title")).toBeInTheDocument();
    expect(
      screen.getByText("capacity.reasons.whatsapp_number_limit")
    ).toBeInTheDocument();
    expect(screen.queryByText("Continue")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "capacity.upgrade" }));
    expect(screen.getByRole("dialog")).toHaveTextContent(
      "upgrade feature_limit"
    );
  });

  it("asks for a trial upgrade when the trial has ended", async () => {
    mockCompanyLimits.mockReturnValue({
      subscriptionType: "free",
      trialExpired: true,
    });

    render(<WhatsAppIntegration workspaceId="workspace-1" />);

    expect(
      await screen.findByText("capacity.reasons.trial_expired")
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "capacity.upgrade" }));
    expect(screen.getByRole("dialog")).toHaveTextContent(
      "upgrade trial_expired"
    );
  });

  it("keeps Cloud API signup open when the access check fails", async () => {
    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: false,
        status: 500,
        json: () => Promise.resolve({ error: "api_error" }),
      } as unknown as Response)
    );

    render(<WhatsAppIntegration workspaceId="workspace-1" />);

    const continueButton = await screen.findByText("Continue");
    await screen.findByRole("radio", { name: /Cloud API/ });
    expect(continueButton).toBeEnabled();
    expect(
      screen.queryByText("accessVerify.blockedTitle")
    ).not.toBeInTheDocument();
  });

  it("does not hold the Continue button while the access check runs", () => {
    global.fetch = jest.fn(() => new Promise<Response>(() => undefined));

    render(<WhatsAppIntegration workspaceId="workspace-1" />);

    expect(screen.getByText("Continue")).toBeEnabled();
  });

  it("points a fresh connection at templates and Bulk campaigns", async () => {
    render(
      <WhatsAppIntegration
        workspaceId="workspace-1"
        source={connectedSource(new Date().toISOString())}
      />
    );

    expect(await screen.findByText("nextStep.title")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "nextStep.createTemplate" })
    ).toHaveAttribute(
      "href",
      "/panel/w/workspace-1/messengers/whatsapp-templates?create=1"
    );
    expect(
      screen.getByRole("link", { name: "nextStep.openBulk" })
    ).toHaveAttribute("href", "/panel/w/workspace-1/bulk-campaigns");
  });

  it("leaves long-standing connections without the first-send card", async () => {
    render(
      <WhatsAppIntegration
        workspaceId="workspace-1"
        source={connectedSource("2026-01-01T00:00:00.000Z")}
      />
    );

    expect(await screen.findByText("WhatsApp settings")).toBeInTheDocument();
    expect(screen.queryByText("nextStep.title")).not.toBeInTheDocument();
  });
});
