/** @jest-environment jsdom */

import "@testing-library/jest-dom";
import { act, fireEvent, render, screen } from "@testing-library/react";
import messages from "../../../messages/settings/integrations/en/page.json";
import type { Source } from "@/types/supabase";
import { MetaAdsIntegration } from "./meta-ads-integration";
import { IntegrationDetailsPanel } from "./integration-details-panel";
import * as metaAdsClient from "@/lib/meta-ads/connect-meta-ads-mcp-client";

jest.mock("@/lib/meta-ads/connect-meta-ads-mcp-client", () => ({
  ...jest.requireActual("@/lib/meta-ads/connect-meta-ads-mcp-client"),
  fetchMetaAdsMcpSession: jest.fn(),
}));

jest.mock("next-intl", () => ({
  useTranslations:
    (namespace: string) => (key: string, values?: { count?: number }) => {
      const value = `${namespace}.${key}`
        .split(".")
        .reduce<unknown>(
          (current, part) =>
            current && typeof current === "object"
              ? (current as Record<string, unknown>)[part]
              : undefined,
          messages
        );
      return typeof value === "string"
        ? value.replace("{count}", String(values?.count ?? ""))
        : key;
    },
}));
jest.mock("swr", () => ({
  __esModule: true,
  default: (
    _key: unknown,
    _fetcher: unknown,
    options: { fallbackData: unknown }
  ) => ({
    data: options.fallbackData,
    mutate: jest.fn(),
  }),
  useSWRConfig: () => ({ mutate: jest.fn() }),
}));
jest.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
}));
jest.mock("next/dynamic", () => ({
  __esModule: true,
  default: () => () => null,
}));
jest.mock("./meta-ads-mcp-connect-button", () => ({
  MetaAdsMcpConnectButton: ({
    label,
    disabled,
    intent,
  }: {
    label: React.ReactNode;
    disabled?: boolean;
    intent?: string;
  }) => (
    <button disabled={disabled} data-intent={intent}>
      {label}
    </button>
  ),
}));

const accounts = [
  { id: "act_111", account_id: "111", name: "DemoShop main" },
  { id: "act_222", account_id: "222", name: "DemoShop second" },
];

function source(credentials: Record<string, unknown>): Source {
  return {
    id: "source-1",
    created_at: "2026-09-16T00:00:00.000Z",
    company_id: "company-1",
    workspace_id: "workspace-1",
    type: "meta_ads",
    name: "Meta Ads",
    credentials: { has_access_token: true, ...credentials },
  } as Source;
}

describe("MetaAdsIntegration account discovery", () => {
  it("keeps details open and restores controls after a failed readiness check", async () => {
    let rejectCheck!: (error: Error) => void;
    const request = new Promise<never>((_resolve, reject) => {
      rejectCheck = reject;
    });
    const fetchSession = jest
      .mocked(metaAdsClient.fetchMetaAdsMcpSession)
      .mockReturnValueOnce(request);
    render(
      <MetaAdsIntegration
        workspaceId="workspace-1"
        source={source({
          ad_accounts: accounts,
          mcp_readiness: {
            state: "provider_unreachable",
            canRead: false,
            canWrite: false,
            grantedScopes: [],
            requiredScopes: [],
            missingScopes: [],
            missingReadScopes: [],
            missingWriteScopes: [],
            accessibleAdAccountIds: [],
            accessibleAdAccountsTruncated: false,
            reconnectRequired: false,
          },
        })}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Connection details" }));
    fireEvent.click(screen.getByRole("button", { name: "Check AI access" }));
    expect(fetchSession).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      probe: true,
    });
    expect(screen.getByRole("button", { name: "Checking…" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Manage access" })
    ).toBeDisabled();
    expect(
      screen.getByRole("combobox", { name: "Selected account" })
    ).toBeDisabled();
    await act(async () => {
      rejectCheck(new Error("Temporary provider failure"));
      await request.catch(() => undefined);
    });
    expect(
      screen.getByRole("button", { name: "Check AI access" })
    ).toBeEnabled();
    expect(screen.getByRole("button", { name: "Manage access" })).toBeEnabled();
    expect(
      screen.getByRole("button", { name: "Connection details" })
    ).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Available")).toBeInTheDocument();
    fetchSession.mockReset();
  });

  it("does not let an older rollout flag hide a new authorization failure", () => {
    render(
      <MetaAdsIntegration
        workspaceId="workspace-1"
        source={source({
          ad_accounts: accounts,
          mcp_readiness: {
            state: "expired",
            canRead: false,
            canWrite: false,
            grantedScopes: [],
            requiredScopes: [],
            missingScopes: [],
            missingReadScopes: [],
            missingWriteScopes: [],
            accessibleAdAccountIds: [],
            accessibleAdAccountsTruncated: false,
            reconnectRequired: true,
            provider: {
              selectedAccountEnabled: false,
              warnings: ["account_not_enabled"],
            },
          },
        })}
      />
    );
    expect(screen.getByText("Access needed")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Update AI access" })
    ).toBeEnabled();
    expect(screen.queryByText("Not yet available")).not.toBeInTheDocument();
  });
  it.each([{ graphReady: true }, { graphReady: false }])(
    "explains Meta account rollout separately from Graph reporting (%j)",
    ({ graphReady }) => {
      render(
        <MetaAdsIntegration
          workspaceId="workspace-1"
          source={source({
            ad_accounts: accounts,
            ...(graphReady ? {} : { scope: "public_profile" }),
            mcp_readiness: {
              state: "asset_unavailable",
              canRead: false,
              canWrite: false,
              grantedScopes: [
                "ads_mcp_management",
                "ads_read",
                "ads_management",
              ],
              requiredScopes: [],
              missingScopes: [],
              missingReadScopes: [],
              missingWriteScopes: [],
              accessibleAdAccountIds: ["act_111"],
              accessibleAdAccountsTruncated: false,
              reconnectRequired: false,
              provider: {
                selectedAccountEnabled: false,
                warnings: ["account_not_enabled"],
              },
            },
          })}
        />
      );
      expect(screen.getByText("Not yet available")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Check again" })).toBeEnabled();
      expect(
        screen.queryByRole("button", { name: "Enable AI ad management" })
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Update AI access" })
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: /Reconnect/ })
      ).not.toBeInTheDocument();
      if (graphReady) {
        expect(screen.getByText("Available")).toBeInTheDocument();
        expect(
          screen.getByText(
            "Meta has not enabled AI ad tools for this account yet. Campaign triggers and reporting remain available through the Meta Ads integration."
          )
        ).toBeInTheDocument();
      } else {
        expect(
          screen.getByText(
            "Meta has not enabled AI ad tools for this account yet. Campaign reporting has its own access status above."
          )
        ).toBeInTheDocument();
        expect(screen.queryByText("Available")).not.toBeInTheDocument();
      }
      fireEvent.click(
        screen.getByRole("button", { name: "Connection details" })
      );
      expect(
        screen.getByText("Meta has not enabled AI ad tools for this account")
      ).toBeVisible();
      expect(
        screen.getByText(
          "Meta is gradually enabling AI ad tools across ad accounts. This account is not enabled yet."
        )
      ).toBeVisible();
      expect(
        screen.queryByText("Selected ad account is unavailable")
      ).not.toBeInTheDocument();
      expect(
        screen.queryByText(
          "Choose an account accessible to both the Graph connection and Ads MCP."
        )
      ).not.toBeInTheDocument();
    }
  );

  it.each([{ otherWarnings: [] }, { otherWarnings: ["expiry_unknown"] }])(
    "presents supported protocol negotiation as information and preserves other warnings (%j)",
    ({ otherWarnings }) => {
      render(
        <MetaAdsIntegration
          workspaceId="workspace-1"
          source={source({
            ad_accounts: accounts,
            mcp_readiness: {
              state: "ready",
              canRead: true,
              canWrite: true,
              grantedScopes: [
                "ads_mcp_management",
                "ads_read",
                "ads_management",
              ],
              requiredScopes: [],
              missingScopes: [],
              missingReadScopes: [],
              missingWriteScopes: [],
              accessibleAdAccountIds: ["act_111"],
              accessibleAdAccountsTruncated: false,
              reconnectRequired: false,
              provider: {
                protocolEra: "legacy",
                protocolVersion: "2025-06-18",
                warnings: ["provider_protocol_fallback", ...otherWarnings],
              },
            },
          })}
        />
      );
      fireEvent.click(
        screen.getByRole("button", { name: "Connection details" })
      );
      expect(
        screen.getByText(
          "Meta connected using a supported protocol version. No action is needed."
        )
      ).toBeVisible();
      if (otherWarnings.length) {
        expect(screen.getByText("Readiness warnings")).toBeVisible();
        expect(
          screen.getByText("Meta did not provide a verifiable token expiry.")
        ).toBeVisible();
      } else {
        expect(
          screen.queryByText("Readiness warnings")
        ).not.toBeInTheDocument();
      }
    }
  );

  it("offers one reporting connection without requiring AI management", () => {
    render(<MetaAdsIntegration workspaceId="workspace-1" />);
    expect(screen.getByText("Meta Ads is not connected")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Connect Meta Ads" })
    ).toHaveAttribute("data-intent", "reporting");
    expect(
      screen.getByText("Campaign triggers and reporting")
    ).toBeInTheDocument();
    expect(screen.getByText("AI ad management")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Enable AI ad management" })
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows both authorized accounts after successful discovery", () => {
    render(
      <MetaAdsIntegration
        workspaceId="workspace-1"
        source={source({ ad_accounts: accounts })}
      />
    );
    expect(screen.getByText("Meta Ads is connected")).toBeInTheDocument();
    expect(screen.getByText("Available ad accounts: 2")).toBeInTheDocument();
    expect(
      screen.getByRole("combobox", { name: "Selected account" })
    ).toHaveTextContent("DemoShop main (111)");
    expect(
      screen.getByRole("button", { name: "Manage access" })
    ).toHaveAttribute("data-intent", "reporting");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("describes a healthy reporting-only MCP connection without promising campaign changes", () => {
    render(
      <MetaAdsIntegration
        workspaceId="workspace-1"
        source={source({
          ad_accounts: accounts,
          mcp_readiness: {
            state: "ready",
            canRead: true,
            canWrite: false,
            grantedScopes: ["ads_mcp_management", "ads_read"],
            requiredScopes: ["ads_mcp_management", "ads_read"],
            missingScopes: [],
            missingReadScopes: [],
            missingWriteScopes: ["ads_management"],
            accessibleAdAccountIds: ["act_111", "act_222"],
            accessibleAdAccountsTruncated: false,
            reconnectRequired: false,
          },
        })}
      />
    );

    expect(screen.getByText("Reporting only")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Airi can analyze your ads. Enable management to review and approve campaign changes in chat."
      )
    ).toBeInTheDocument();
    expect(screen.queryByText("Ads MCP is ready")).not.toBeInTheDocument();
    expect(
      screen.queryByText(/can run live reporting and propose campaign changes/)
    ).not.toBeInTheDocument();
  });

  it.each([{ adAccounts: [] }, { adAccounts: accounts }])(
    "reports a stored discovery error without exposing provider details (%j)",
    ({ adAccounts }) => {
      render(
        <MetaAdsIntegration
          workspaceId="workspace-1"
          source={source({
            ad_accounts: adAccounts,
            ad_accounts_error: "Provider failed with access_token=secret",
          })}
        />
      );
      expect(screen.getByText("Meta Ads needs attention")).toBeInTheDocument();
      expect(
        screen.queryByText("Meta Ads is connected")
      ).not.toBeInTheDocument();
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Choose Manage access and select the ad accounts you want to use."
      );
      expect(screen.queryByText(/access_token=secret/)).not.toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Manage access" })
      ).toBeInTheDocument();
    }
  );

  it("explains an empty account inventory instead of claiming the integration is ready", () => {
    render(
      <MetaAdsIntegration
        workspaceId="workspace-1"
        source={source({ ad_accounts: [] })}
      />
    );
    expect(screen.getByText("Meta Ads needs attention")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Meta did not return any ad accounts."
    );
    expect(screen.queryByText("Meta Ads is connected")).not.toBeInTheDocument();
  });

  it("keeps reconnect disabled in previews with a discovery failure", () => {
    render(
      <MetaAdsIntegration
        workspaceId="workspace-1"
        source={source({ ad_accounts: [] })}
        connectionActionsDisabled
      />
    );
    expect(
      screen.getByRole("button", { name: "Manage access" })
    ).toBeDisabled();
    expect(
      screen.queryByRole("link", { name: "Manage access" })
    ).not.toBeInTheDocument();
  });

  it("keeps technical permissions collapsed while reporting remains usable", () => {
    render(
      <MetaAdsIntegration
        workspaceId="workspace-1"
        source={source({
          ad_accounts: accounts,
          mcp_readiness: {
            state: "missing_scopes",
            canRead: false,
            canWrite: false,
            grantedScopes: ["ads_read"],
            requiredScopes: ["ads_mcp_management"],
            missingScopes: ["ads_mcp_management"],
            missingReadScopes: ["ads_mcp_management"],
            missingWriteScopes: ["ads_management"],
            accessibleAdAccountIds: [],
            accessibleAdAccountsTruncated: false,
            reconnectRequired: true,
          },
        })}
      />
    );
    expect(
      screen.getByText("Campaign triggers and reporting")
    ).toBeInTheDocument();
    expect(screen.getByText("Available")).toBeInTheDocument();
    expect(screen.queryByText("ads_mcp_management")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Connection details" }));
    expect(screen.getByText("ads_mcp_management")).toBeVisible();
  });

  it("keeps the selected account visible when access is lost instead of switching silently", () => {
    render(
      <MetaAdsIntegration
        workspaceId="workspace-1"
        source={source({
          ad_accounts: accounts,
          selected_ad_account_id: "act_999",
        })}
      />
    );
    expect(
      screen.getByRole("combobox", { name: "Selected account" })
    ).toHaveTextContent("act_999");
    expect(
      screen.getByText(
        "Your selected account is no longer available. Choose another account or update access."
      )
    ).toBeInTheDocument();
  });

  it("offers a check without another consent when the AI provider is temporarily unavailable", () => {
    render(
      <MetaAdsIntegration
        workspaceId="workspace-1"
        source={source({
          ad_accounts: accounts,
          mcp_readiness: {
            state: "provider_unreachable",
            canRead: false,
            canWrite: false,
            grantedScopes: ["ads_read", "ads_mcp_management"],
            requiredScopes: [],
            missingScopes: [],
            missingReadScopes: [],
            missingWriteScopes: [],
            accessibleAdAccountIds: [],
            accessibleAdAccountsTruncated: false,
            reconnectRequired: false,
          },
        })}
      />
    );
    expect(
      screen.getByRole("button", { name: "Check AI access" })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Enable AI ad management" })
    ).not.toBeInTheDocument();
    expect(screen.getByText("Available")).toBeInTheDocument();
  });

  it("does not claim campaign readiness from a cached account when reporting access expired", () => {
    render(
      <MetaAdsIntegration
        workspaceId="workspace-1"
        source={source({
          ad_accounts: accounts,
          expires_at: "2000-01-01T00:00:00.000Z",
        })}
      />
    );
    expect(screen.queryByText("Available")).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Access needs to be updated"
    );
    expect(screen.queryByText(/token/i)).not.toBeInTheDocument();
  });

  it.each([
    ["ads_permissions_missing", "Meta Ads access was not granted"],
    [
      "token_verification_failed",
      "Meta Ads authorization could not be verified",
    ],
    ["ad_accounts_unavailable", "Ad accounts could not be loaded"],
    ["no_ad_accounts", "No ad accounts are available"],
    ["token_exchange_failed", "Meta Ads connection could not be completed"],
    ["mcp_token_exchange_failed", "AI ad access could not be updated"],
    ["ad_accounts_failed", "Ad accounts could not be loaded"],
    ["unknown_provider_error", "Meta Ads connection error"],
  ])("explains the OAuth failure %s", (error, title) => {
    render(
      <IntegrationDetailsPanel
        sources={[]}
        emailIntegrationEnabled
        emailProviderStatus="disconnected"
        workspaceId="workspace-1"
        selectedIntegrationId="meta_ads"
        error={error}
        errorDetails="Provider token=secret"
      />
    );
    expect(screen.getByText(title)).toBeInTheDocument();
    expect(screen.queryByText(/token=secret/)).not.toBeInTheDocument();
  });
});
