/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as React from "react";
import type { ReactElement } from "react";
import { SWRConfig } from "swr";
import { getAiriBulkCampaignDraftStorageKey } from "@/lib/airi-chats/bulk-campaign-draft";
import { BulkCampaignsPageClient } from "./bulk-campaigns-page-client";

jest.mock("next/dynamic", () => ({
  __esModule: true,
  default: (
    loader: () => Promise<unknown>,
    options?: { loading?: () => unknown }
  ) => {
    function DynamicMock(props: Record<string, unknown>) {
      const [Component, setComponent] = React.useState<unknown>(null);

      React.useEffect(() => {
        let mounted = true;
        void loader().then(loaded => {
          const resolved =
            loaded && typeof loaded === "object" && "default" in loaded
              ? (loaded as { default?: unknown }).default
              : loaded;
          if (mounted) setComponent(() => resolved);
        });
        return () => {
          mounted = false;
        };
      }, []);

      if (Component) {
        return React.createElement(Component as never, props);
      }

      return options?.loading
        ? React.createElement(React.Fragment, null, options.loading() as never)
        : null;
    }

    return DynamicMock;
  },
}));

const routerReplace = jest.fn();

jest.mock("next/navigation", () => ({
  useRouter: () => ({
    replace: routerReplace,
  }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/panel/w/workspace-1/bulk-campaigns",
}));

const builderMock = jest.fn(
  (props: {
    emailEnabled: boolean;
    recipientSource:
      | "manual"
      | {
          type: "bulk_analytics";
          filters: Record<string, unknown>;
        };
    registeredUsersAudience?: { total: number } | null;
    onChannelChange?: (channel: "whatsapp" | "telegram" | "email") => void;
    initialDraft?: unknown;
    audienceSourceSlot?: React.ReactNode;
  }) => {
    const [draft, setDraft] = React.useState("");
    return (
      <div data-testid="builder">
        <input
          aria-label="Campaign draft"
          value={draft}
          onChange={event => setDraft(event.target.value)}
        />
        {props.audienceSourceSlot}
        <span>
          {props.recipientSource === "manual"
            ? "manual"
            : `filter:${props.recipientSource.filters.status}`}
        </span>
        <span data-testid="builder-recipient-days">
          {props.recipientSource === "manual"
            ? ""
            : String(props.recipientSource.filters.days ?? "")}
        </span>
        <span>{props.emailEnabled ? "email-enabled" : "email-disabled"}</span>
        <span data-testid="builder-draft-title">
          {String(
            (props.initialDraft as { title?: string } | null)?.title ?? ""
          )}
        </span>
        <button
          type="button"
          onClick={() => props.onChannelChange?.("telegram")}
        >
          mock telegram
        </button>
        <button
          type="button"
          onClick={() => props.onChannelChange?.("whatsapp")}
        >
          mock whatsapp
        </button>
        <button type="button" onClick={() => props.onChannelChange?.("email")}>
          mock email
        </button>
      </div>
    );
  }
);

const campaignHistoryMock = jest.fn(
  ({
    workspaceId,
    onViewAnalytics,
  }: {
    workspaceId: string;
    onViewAnalytics?: (campaignId: string) => void;
  }) => (
    <div data-testid="campaign-history">
      <span>{workspaceId}</span>
      <button
        type="button"
        onClick={() => onViewAnalytics?.("campaign-deep-link")}
      >
        view analytics
      </button>
    </div>
  )
);

const bulkAnalyticsMock = jest.fn(
  ({
    initialCampaignIds,
    onSendToAudience,
  }: {
    initialCampaignIds?: string[];
    onSendToAudience?: (filters: Record<string, unknown>) => void;
  }) => (
    <div data-testid="analytics">
      <span data-testid="analytics-campaign-ids">
        {(initialCampaignIds || []).join(",")}
      </span>
      <button
        type="button"
        onClick={() =>
          onSendToAudience?.({
            days: "21",
            status: "all",
            conversationScope: "campaign_sends",
          })
        }
      >
        send to audience
      </button>
    </div>
  )
);

jest.mock("./campaign-blast-content", () => ({
  CampaignBlastContent: (props: unknown) => builderMock(props as never),
}));

jest.mock("./campaign-history", () => ({
  CampaignHistory: (props: unknown) => campaignHistoryMock(props as never),
}));

jest.mock("@/components/analytics/bulk-analytics", () => ({
  BulkAnalytics: (props: unknown) => bulkAnalyticsMock(props as never),
}));

jest.mock("next-intl", () => ({
  useLocale: () => "en-US",
  useTranslations: () => (key: string) => key,
}));

function renderWithSWR(ui: ReactElement) {
  return render(
    <SWRConfig value={{ provider: () => new Map() }}>{ui}</SWRConfig>
  );
}

function mockSavedFilters(filters: unknown[]) {
  global.fetch = jest.fn(
    async () =>
      ({
        ok: true,
        json: async () => ({ filters }),
      }) as Response
  ) as jest.Mock;
}

function mockSavedFiltersFailure() {
  global.fetch = jest.fn(
    async () =>
      ({
        ok: false,
        json: async () => ({ error: "Failed to load saved filters" }),
      }) as Response
  ) as jest.Mock;
}

describe("BulkCampaignsPageClient", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    window.localStorage.clear();
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      value: jest.fn(),
    });
    mockSavedFilters([
      {
        id: "filter-1",
        name: "Dormant leads",
        filters: { days: "30", status: "not_replied" },
        created_at: "2026-05-05T08:00:00.000Z",
        updated_at: "2026-05-05T09:00:00.000Z",
        created_by: "user-1",
      },
      {
        id: "filter-2",
        name: "Campaign sends only",
        filters: {
          days: "14",
          status: "all",
          conversationScope: "campaign_sends",
        },
        created_at: "2026-05-05T08:00:00.000Z",
        updated_at: "2026-05-05T09:00:00.000Z",
        created_by: "user-1",
      },
    ]);
  });

  it("passes an Airi bulk campaign draft into the builder when requested", async () => {
    window.localStorage.setItem(
      getAiriBulkCampaignDraftStorageKey("workspace-1"),
      JSON.stringify({
        id: "airi-bulk:pricing-lead-win-back",
        workspaceId: "workspace-1",
        title: "Pricing lead win-back",
        channel: "whatsapp",
        campaignName: "Pricing lead win-back",
        goal: "Recover warm leads.",
        angle: "Helpful follow-up",
        recipientSourceSummary: "Warm WhatsApp leads",
        templateSelection: {
          name: "pricing_lead_win_back",
          language: "en",
          category: "MARKETING",
        },
        templateReadiness: "needs_template_approval",
      })
    );

    renderWithSWR(
      <BulkCampaignsPageClient
        workspaceId="workspace-1"
        days={14}
        initialTab="campaigns"
        emailEnabled={false}
        openAiriBulkDraftOnMount
      />
    );

    expect((await screen.findByTestId("builder-draft-title")).textContent).toBe(
      "Pricing lead win-back"
    );
    expect(builderMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        initialDraft: expect.objectContaining({
          title: "Pricing lead win-back",
          channel: "whatsapp",
        }),
      })
    );
  });

  it("selects a saved audience before explicitly applying it", async () => {
    renderWithSWR(
      <BulkCampaignsPageClient
        workspaceId="workspace-1"
        days={14}
        initialTab="campaigns"
        emailEnabled={false}
      />
    );

    expect((await screen.findByTestId("builder")).textContent).toContain(
      "manual"
    );
    expect(
      screen.getByRole("heading", { level: 1 }).closest(".overflow-x-hidden")
    ).not.toBeNull();
    const audienceSelect = await screen.findByRole("combobox", {
      name: "filters.sourceLabel",
    });

    fireEvent.click(audienceSelect);
    fireEvent.click(
      await screen.findByRole("option", { name: /Dormant leads/ })
    );

    expect(screen.getByTestId("builder").textContent).toContain("manual");
    expect(
      (
        screen.getByRole("button", {
          name: "filters.apply",
        }) as HTMLButtonElement
      ).disabled
    ).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "filters.apply" }));

    await waitFor(() =>
      expect(screen.getByTestId("builder").textContent).toContain(
        "filter:not_replied"
      )
    );
    expect(screen.getByRole("button", { name: "filters.clear" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "filters.clear" }));

    await waitFor(() =>
      expect(screen.getByTestId("builder").textContent).toContain("manual")
    );
    expect(screen.queryByRole("button", { name: "filters.clear" })).toBeNull();
  });

  it("marks limited audiences in the selector and manages deletion separately", async () => {
    const user = userEvent.setup();
    renderWithSWR(
      <BulkCampaignsPageClient
        workspaceId="workspace-1"
        days={14}
        initialTab="campaigns"
        emailEnabled={false}
      />
    );

    fireEvent.click(
      await screen.findByRole("combobox", { name: "filters.sourceLabel" })
    );
    expect(
      await screen.findByRole("option", { name: /Dormant leads/ })
    ).toBeTruthy();
    expect(screen.getByText("filters.limitedBadge")).toBeTruthy();
    expect(
      screen.getByRole("option", { name: "Campaign sends only" })
    ).toBeTruthy();
    fireEvent.click(
      screen.getByRole("option", { name: "Campaign sends only" })
    );

    await user.click(screen.getByRole("button", { name: "filters.manage" }));
    expect(
      await screen.findAllByRole("menuitem", { name: "filters.deleteAria" })
    ).toHaveLength(2);
  });

  it("uses manual recipients and hides saved filters after switching the builder to Telegram", async () => {
    renderWithSWR(
      <BulkCampaignsPageClient
        workspaceId="workspace-1"
        days={14}
        initialTab="campaigns"
        emailEnabled={false}
      />
    );

    fireEvent.click(
      await screen.findByRole("combobox", { name: "filters.sourceLabel" })
    );
    fireEvent.click(
      await screen.findByRole("option", { name: /Dormant leads/ })
    );
    fireEvent.click(screen.getByRole("button", { name: "filters.apply" }));
    await waitFor(() =>
      expect(screen.getByTestId("builder").textContent).toContain(
        "filter:not_replied"
      )
    );

    fireEvent.click(screen.getByRole("button", { name: "mock telegram" }));

    await waitFor(() =>
      expect(screen.getByTestId("builder").textContent).toContain("manual")
    );
    expect(
      screen.queryByRole("combobox", { name: "filters.sourceLabel" })
    ).toBeNull();
  });

  it("hides the manual source button when there are no saved filters", async () => {
    mockSavedFilters([]);

    renderWithSWR(
      <BulkCampaignsPageClient
        workspaceId="workspace-1"
        days={14}
        initialTab="campaigns"
        emailEnabled={false}
      />
    );

    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    expect(
      screen.queryByRole("combobox", { name: "filters.sourceLabel" })
    ).toBeNull();
    expect((await screen.findByTestId("builder")).textContent).toContain(
      "manual"
    );
  });

  it("does not show saved filter load failures in the campaign tab", async () => {
    mockSavedFiltersFailure();

    renderWithSWR(
      <BulkCampaignsPageClient
        workspaceId="workspace-1"
        days={14}
        initialTab="campaigns"
        emailEnabled={false}
      />
    );

    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    expect(screen.queryByText("Failed to load saved filters")).toBeNull();
    expect(screen.queryByText("filters.empty")).toBeNull();
    expect(
      screen.queryByRole("combobox", { name: "filters.sourceLabel" })
    ).toBeNull();
    expect((await screen.findByTestId("builder")).textContent).toContain(
      "manual"
    );
  });

  it("shows campaign history in the campaign tab for post-send delivery errors", async () => {
    renderWithSWR(
      <BulkCampaignsPageClient
        workspaceId="workspace-1"
        days={14}
        initialTab="campaigns"
        emailEnabled={false}
      />
    );

    expect(
      (await screen.findByTestId("campaign-history")).textContent
    ).toContain("workspace-1");
    expect(screen.queryByText("description")).toBeNull();
    expect(screen.queryByText("filters.appliedHint")).toBeNull();
  });

  it("syncs analytics tab + campaign deep link into the URL", async () => {
    renderWithSWR(
      <BulkCampaignsPageClient
        workspaceId="workspace-1"
        days={14}
        initialTab="campaigns"
        emailEnabled={false}
      />
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "view analytics" })
    );

    await waitFor(() =>
      expect(screen.getByTestId("analytics-campaign-ids").textContent).toBe(
        "campaign-deep-link"
      )
    );
    expect(routerReplace).toHaveBeenCalledWith(
      "?tab=analytics&campaignId=campaign-deep-link",
      { scroll: false }
    );
  });

  it("applies analytics send-to-audience filters as ephemeral recipient source", async () => {
    renderWithSWR(
      <BulkCampaignsPageClient
        workspaceId="workspace-1"
        days={14}
        initialTab="analytics"
        emailEnabled={false}
        initialCampaignIds={["campaign-1"]}
      />
    );

    expect(await screen.findByTestId("analytics")).toBeTruthy();
    expect(screen.getByTestId("analytics-campaign-ids").textContent).toBe(
      "campaign-1"
    );

    fireEvent.click(screen.getByRole("button", { name: "send to audience" }));

    await waitFor(() =>
      expect(screen.getByTestId("builder").textContent).toContain("filter:all")
    );
    expect(screen.getByTestId("builder-recipient-days").textContent).toBe("21");
    expect(
      screen.getByRole("combobox", { name: "filters.sourceLabel" })
    ).toBeTruthy();
    expect(screen.queryByText("filters.appliedHint")).toBeNull();
    expect(screen.getByRole("button", { name: "filters.clear" })).toBeTruthy();
    expect(routerReplace).toHaveBeenCalledWith("?tab=campaigns", {
      scroll: false,
    });
  });

  it("renders only the analytics tab content when requested", async () => {
    renderWithSWR(
      <BulkCampaignsPageClient
        workspaceId="workspace-1"
        days={14}
        initialTab="analytics"
        emailEnabled={false}
      />
    );

    const analytics = await screen.findByTestId("analytics");
    expect(builderMock).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
    // Bulk analytics sits on the shared analytics surface without the
    // analytics section navigation.
    expect(analytics.closest("[data-analytics-content]")).not.toBeNull();
    expect(screen.queryByRole("navigation")).toBeNull();
    expect(
      screen.getByRole("tab", { name: "tabs.campaigns" }).querySelector("svg")
    ).toBeNull();
    expect(
      screen.getByRole("tab", { name: "tabs.analytics" }).querySelector("svg")
    ).toBeNull();
  });

  it("preserves a campaign draft when switching through the analytics shell", async () => {
    const user = userEvent.setup();
    renderWithSWR(
      <BulkCampaignsPageClient
        workspaceId="workspace-1"
        days={14}
        emailEnabled={false}
      />
    );
    const draft = await screen.findByRole("textbox", {
      name: "Campaign draft",
    });
    fireEvent.change(draft, { target: { value: "Unsaved campaign copy" } });
    expect(
      screen.getByRole("tab", { name: "tabs.campaigns" }).querySelector("svg")
    ).not.toBeNull();
    await user.click(screen.getByRole("tab", { name: "tabs.analytics" }));
    const analytics = await screen.findByTestId("analytics");
    const analyticsPanel = analytics.closest("[role=tabpanel]");
    expect(analytics.closest("[data-analytics-content]")).not.toBeNull();
    expect(analyticsPanel?.hasAttribute("hidden")).toBe(false);
    await user.click(screen.getByRole("tab", { name: "tabs.campaigns" }));
    expect(
      (
        screen.getByRole("textbox", {
          name: "Campaign draft",
        }) as HTMLInputElement
      ).value
    ).toBe("Unsaved campaign copy");
    expect(analyticsPanel?.hasAttribute("hidden")).toBe(true);
  });

  it("offers registered app users for connected email campaigns", async () => {
    renderWithSWR(
      <BulkCampaignsPageClient
        workspaceId="workspace-1"
        days={14}
        initialTab="campaigns"
        emailEnabled
        registeredUsersAudience={{
          enabled: true,
          total: 12,
          totalAuthUsers: 13,
          skippedUnconfirmed: 1,
          skippedInvalidEmail: 0,
          skippedAnonymous: 0,
          skippedDuplicate: 0,
          preview: [],
        }}
      />
    );

    expect((await screen.findByTestId("builder")).textContent).toContain(
      "email-enabled"
    );

    fireEvent.click(screen.getByRole("button", { name: "mock email" }));

    expect(
      screen.queryByRole("button", { name: "Registered users" })
    ).toBeNull();
    expect(builderMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        recipientSource: "manual",
        registeredUsersAudience: expect.objectContaining({ total: 12 }),
      })
    );
  });

  it("does not offer registered-user email audiences before email is connected", async () => {
    renderWithSWR(
      <BulkCampaignsPageClient
        workspaceId="workspace-1"
        days={14}
        initialTab="campaigns"
        emailEnabled={false}
        registeredUsersAudience={{
          enabled: true,
          total: 12,
          totalAuthUsers: 13,
          skippedUnconfirmed: 1,
          skippedInvalidEmail: 0,
          skippedAnonymous: 0,
          skippedDuplicate: 0,
          preview: [],
        }}
      />
    );

    expect((await screen.findByTestId("builder")).textContent).toContain(
      "email-disabled"
    );

    fireEvent.click(screen.getByRole("button", { name: "mock email" }));

    expect(
      screen.queryByRole("button", { name: "Registered users" })
    ).toBeNull();
  });
});
