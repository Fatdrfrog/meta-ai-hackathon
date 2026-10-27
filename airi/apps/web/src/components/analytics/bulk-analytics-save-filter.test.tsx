/**
 * @jest-environment jsdom
 */

import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { NextIntlClientProvider } from "next-intl";
import * as React from "react";
import type { ReactElement } from "react";
import { toast } from "sonner";
import { SWRConfig } from "swr";
import englishAnalytics from "../../../messages/analytics/en/page.json";
import kazakhAnalytics from "../../../messages/analytics/kz/page.json";
import englishMessages from "../../../messages/en.json";
import kazakhMessages from "../../../messages/kz.json";
import { BulkAnalytics } from "./bulk-analytics";
import { useBulkAnalyticsFormatters } from "./bulk-analytics-formatters";
import { installMatchMedia } from "@/test-support/dom-test-utils";

const mockLoggerError = jest.fn();

jest.mock("@icecore/shared/lib/logger", () => ({
  createLogger: () => ({
    error: (...args: unknown[]) => mockLoggerError(...args),
  }),
}));

jest.mock("next-intl", () => {
  const intl = jest.requireActual("@/test-support/next-intl-test-utils");
  return intl.createMessagesNextIntlMock({
    raw: true,
    format: (
      message: string | undefined,
      values: Record<string, string | number> | undefined,
      { key, locale }: { key: string; locale: string }
    ) => {
      if (message === undefined) return key;

      const plural = message.match(
        /^\{count, plural, one \{(.+)\} other \{(.+)\}\}$/
      );
      if (plural && typeof values?.count === "number") {
        const intlLocale = locale === "kz" ? "kk-KZ" : locale;
        const branch = values.count === 1 ? plural[1] : plural[2];
        return branch.replace(
          "#",
          new Intl.NumberFormat(intlLocale).format(values.count)
        );
      }

      return intl.replacePassedValues(message, values);
    },
  });
});

jest.mock("sonner", () => ({
  toast: {
    success: jest.fn(),
    error: jest.fn(),
  },
}));

jest.mock("next/dynamic", () => ({
  __esModule: true,
  default: () =>
    function DynamicChartMock() {
      return null;
    },
}));

jest.mock("@/components/requests/conversation-detail-drawer", () => ({
  ConversationDetailDrawer: () => null,
}));

const mockSpendSummary = jest.fn();
jest.mock("@/components/analytics/whatsapp-spend-summary", () => ({
  WhatsAppSpendSummary: (props: unknown) => {
    mockSpendSummary(props);
    return null;
  },
}));

const analyticsResponse = {
  generatedAt: "2026-05-05T09:00:00.000Z",
  window: {
    days: 14,
    startDate: "2026-04-21T09:00:00.000Z",
    endDate: "2026-05-05T09:00:00.000Z",
    replyWindowHours: 168,
  },
  filters: { templates: [], campaigns: [] },
  summary: {
    totalAccepted: 0,
    uniqueConversations: 0,
    replied: 0,
    notReplied: 0,
    totalReplies: 0,
    replyRate: 0,
    avgReplyDelayMinutes: null,
    firstSentAt: null,
    lastSentAt: null,
  },
  byTemplate: [],
  daily: [],
  replyCategories: [],
  detectedRuns: [],
  topConversations: [],
  records: [],
  note: "",
};

const disabledOverviewResponse = {
  generatedAt: "2026-05-05T09:00:00.000Z",
  window: analyticsResponse.window,
  filters: { templates: [], campaigns: [] },
  overview: {
    status: "disabled",
    reason: "conversation_overview_temporarily_disabled",
  },
  byTemplate: [],
  daily: [],
  replyCategories: [],
  detectedRuns: [],
  topConversations: [],
  records: [],
  pageInfo: { limit: 100, hasMore: false, nextCursor: null },
  note: "Conversation-pool overview is temporarily disabled.",
};

// Recipient rows and exports are bound to the overview's retained observation.
const observation = {
  snapshotToken: "snapshot-1",
  dataQuality: {
    complete: true,
    reasons: [],
    observedAt: "2026-05-05T09:00:00.000Z",
    snapshotToken: "snapshot-1",
  },
};

const richAnalyticsResponse = {
  ...analyticsResponse,
  ...observation,
  filters: {
    templates: [],
    campaigns: [
      {
        id: "campaign-1",
        name: "RAW Campaign 01",
        templateName: "RAW_TEMPLATE_01",
        sentAt: "2026-05-05T09:00:00.000Z",
        totalRecipients: 12345,
        successfulSends: 12300,
        failedSends: 45,
      },
    ],
  },
  summary: {
    totalAccepted: 12345,
    uniqueConversations: 10000,
    replied: 3086,
    notReplied: 9259,
    totalReplies: 4321,
    replyRate: 0.25,
    read: 9000,
    readRate: 0.729,
    delivered: 12000,
    deliveryRate: 0.972,
    failed: 345,
    failedRate: 0.028,
    estimatedCost: 1234.5,
    costPerReply: 0.4,
    avgReplyDelayMinutes: 90,
    firstSentAt: "2026-04-21T09:00:00.000Z",
    lastSentAt: "2026-05-05T09:00:00.000Z",
  },
  compare: {
    window: {
      startDate: "2026-04-07T09:00:00.000Z",
      endDate: "2026-04-21T09:00:00.000Z",
    },
    summary: {
      totalAccepted: 12000,
      uniqueConversations: 9800,
      replied: 1543,
      notReplied: 10457,
      totalReplies: 2500,
      replyRate: 0.125,
      read: 8000,
      readRate: 0.6,
      delivered: 11000,
      deliveryRate: 0.9,
      failed: 1000,
      failedRate: 0.1,
      estimatedCost: 1000,
      costPerReply: 0.65,
      avgReplyDelayMinutes: 120,
      firstSentAt: "2026-04-07T09:00:00.000Z",
      lastSentAt: "2026-04-21T09:00:00.000Z",
    },
    outcomes: [],
  },
};

const recordsResponse = {
  generatedAt: analyticsResponse.generatedAt,
  ...observation,
  records: [],
  pageInfo: { limit: 100, hasMore: true, nextCursor: "cursor-2" },
};

const catalogs = {
  en: {
    BulkAnalytics: englishAnalytics.BulkAnalytics,
    Pagination: englishMessages.Pagination,
  },
  kz: {
    BulkAnalytics: kazakhAnalytics.BulkAnalytics,
    Pagination: kazakhMessages.Pagination,
  },
};

function renderWithSWR(
  ui: ReactElement,
  locale: keyof typeof catalogs = "en",
  cache?: Map<string, Record<string, unknown>>
) {
  return render(
    <NextIntlClientProvider locale={locale} messages={catalogs[locale]}>
      <SWRConfig
        value={{
          provider: () => cache ?? new Map(),
          dedupingInterval: 0,
          shouldRetryOnError: false,
        }}
      >
        {ui}
      </SWRConfig>
    </NextIntlClientProvider>
  );
}

function installFetchMock(mock: jest.Mock) {
  global.fetch = mock as typeof fetch;
  Object.defineProperty(window, "fetch", {
    writable: true,
    value: mock,
  });
}

function jsonResponse(payload: unknown, ok = true): Response {
  return {
    ok,
    json: async () => payload,
  } as Response;
}

type UserEventInstance = ReturnType<typeof userEvent.setup>;
type AnalyticsCatalog =
  (typeof catalogs)[keyof typeof catalogs]["BulkAnalytics"];

/** Previous-period comparison is an explicit, separately loaded request. */
async function enableComparison(
  user: UserEventInstance,
  translations: AnalyticsCatalog
) {
  await user.click(
    await screen.findByRole("checkbox", { name: translations.compare.previous })
  );
  await waitFor(() =>
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("view=compare")
    )
  );
  await waitFor(() =>
    expect(
      screen.queryByText(translations.operations.comparisonLoading)
    ).toBeNull()
  );
}

/** The campaign cost card keeps its explanation and delta in a popover. */
async function findCostCard(translations: AnalyticsCatalog) {
  return (await screen.findByText(translations.reports.campaignCost))
    .parentElement!;
}

async function openCostDetails(user: UserEventInstance, costCard: HTMLElement) {
  await user.click(within(costCard).getByRole("button"));
  return screen.findByRole("dialog");
}

describe("BulkAnalytics save filter", () => {
  it("keeps missing or invalid currency unavailable while preserving actual zero", () => {
    const { result } = renderHook(() => useBulkAnalyticsFormatters(), {
      wrapper: ({ children }) => (
        <NextIntlClientProvider locale="en" messages={catalogs.en}>
          {children}
        </NextIntlClientProvider>
      ),
    });

    for (const value of [null, undefined, NaN, Infinity, -Infinity]) {
      expect(result.current.formatUsd(value)).toBe(
        englishAnalytics.BulkAnalytics.units.notAvailable
      );
      expect(
        result.current.formatSignedDelta(value, 1, { currency: true })
      ).toBeNull();
      expect(
        result.current.formatSignedDelta(1, value, { currency: true })
      ).toBeNull();
    }
    expect(result.current.formatUsd(0)).toBe("$0.00");
    expect(result.current.formatUsd(-1)).toBe("-$1.00");
  });

  it.each([
    {
      current: null,
      previous: 1000,
      replied: 3086,
      expected: "Not priced",
      delta: null,
    },
    {
      current: null,
      previous: null,
      replied: 0,
      expected: "Not priced",
      delta: null,
    },
    {
      current: 0,
      previous: null,
      replied: 3086,
      expected: "$0.00",
      delta: null,
    },
    {
      current: 0,
      previous: 1000,
      replied: 3086,
      expected: "$0.00",
      delta: "-$1,000.00 vs prior",
    },
  ])(
    "shows cost $current against $previous without inventing missing measurements",
    async ({ current, previous, replied, expected, delta }) => {
      const costResponse = {
        ...richAnalyticsResponse,
        summary: {
          ...richAnalyticsResponse.summary,
          estimatedCost: current,
          costPerReply: current === null ? null : 0,
          replied,
          replyRate: replied / richAnalyticsResponse.summary.totalAccepted,
          notReplied: richAnalyticsResponse.summary.totalAccepted - replied,
        },
        compare: {
          ...richAnalyticsResponse.compare,
          summary: {
            ...richAnalyticsResponse.compare.summary,
            estimatedCost: previous,
          },
        },
      };
      installFetchMock(
        jest.fn(async (input: RequestInfo | URL) =>
          jsonResponse(
            String(input).includes("view=records")
              ? recordsResponse
              : costResponse
          )
        ) as jest.Mock
      );
      const user = userEvent.setup();
      const translations = englishAnalytics.BulkAnalytics;
      renderWithSWR(
        <BulkAnalytics
          workspaceId={`workspace-cost-${current}-${previous}`}
          days={14}
        />
      );

      const costCard = await findCostCard(translations);
      expect(within(costCard).getByText(expected)).toBeTruthy();
      expect(
        within(costCard).getByRole("button", {
          name:
            current === null
              ? translations.funnel.costNotPricedDetail
              : `${expected} / reply`,
        })
      ).toBeTruthy();
      expect(within(costCard).queryByText(/n\/a/)).toBeNull();

      await enableComparison(user, translations);
      const costDetails = await openCostDetails(user, costCard);
      expect(within(costDetails).queryByText(/n\/a/)).toBeNull();
      if (delta) {
        expect(within(costDetails).getByText(delta)).toBeTruthy();
      } else {
        expect(within(costDetails).queryByText(/vs prior/)).toBeNull();
      }
    }
  );

  it("says there are no replies yet instead of a per-reply cost", async () => {
    const costResponse = {
      ...richAnalyticsResponse,
      summary: {
        ...richAnalyticsResponse.summary,
        estimatedCost: 12.5,
        costPerReply: null,
        replied: 0,
        replyRate: 0,
        notReplied: richAnalyticsResponse.summary.totalAccepted,
      },
    };
    installFetchMock(
      jest.fn(async (input: RequestInfo | URL) =>
        jsonResponse(
          String(input).includes("view=records")
            ? recordsResponse
            : costResponse
        )
      ) as jest.Mock
    );
    const user = userEvent.setup();
    const translations = englishAnalytics.BulkAnalytics;
    renderWithSWR(
      <BulkAnalytics workspaceId="workspace-cost-no-replies" days={14} />
    );

    const costCard = await findCostCard(translations);
    expect(within(costCard).getByText("$12.50")).toBeTruthy();
    expect(
      within(costCard).getByRole("button", {
        name: translations.funnel.costPerReplyUnavailable,
      })
    ).toBeTruthy();
    const costDetails = await openCostDetails(user, costCard);
    expect(
      within(costDetails).getByText(translations.funnel.costPerReplyUnavailable)
    ).toBeTruthy();
    expect(within(costCard).queryByText(/n\/a/)).toBeNull();
  });

  it("explains unpriced WhatsApp cost and shows Meta's account spend for the window", async () => {
    installFetchMock(
      jest.fn(async (input: RequestInfo | URL) =>
        jsonResponse(
          String(input).includes("view=records")
            ? recordsResponse
            : {
                ...richAnalyticsResponse,
                summary: {
                  ...richAnalyticsResponse.summary,
                  estimatedCost: null,
                  costPerReply: null,
                  unknownCostCount: 239,
                },
              }
        )
      ) as jest.Mock
    );
    const user = userEvent.setup();
    const translations = englishAnalytics.BulkAnalytics;
    renderWithSWR(<BulkAnalytics workspaceId="workspace-unpriced" days={14} />);

    const costCard = await findCostCard(translations);
    expect(within(costCard).getByText("Not priced")).toBeTruthy();
    expect(
      within(costCard).getByRole("button", {
        name: "239 delivered messages have no verified price",
      })
    ).toBeTruthy();
    const costDetails = await openCostDetails(user, costCard);
    expect(
      within(costDetails).getByText(translations.funnel.costNotPricedNote)
    ).toBeTruthy();
    expect(within(costDetails).queryByText(/vs prior/)).toBeNull();

    // Meta's account spend loads only when its report is opened.
    expect(mockSpendSummary).not.toHaveBeenCalled();
    await user.keyboard("{Escape}");
    await user.click(
      screen.getByRole("tab", { name: translations.reports.accountSpend })
    );
    expect(mockSpendSummary).toHaveBeenLastCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-unpriced",
        period: {
          from: richAnalyticsResponse.window.startDate,
          to: richAnalyticsResponse.window.endDate,
        },
      })
    );
  });

  it("keeps the server-only web logger out of the client bundle", () => {
    const source = readFileSync(require.resolve("./bulk-analytics"), "utf8");

    expect(source).not.toContain("@/lib/logger");
  });

  beforeEach(() => {
    jest.clearAllMocks();
    installMatchMedia();
    installFetchMock(
      jest.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/bulk?") && url.includes("view=records")) {
          return jsonResponse({
            generatedAt: analyticsResponse.generatedAt,
            records: [],
            pageInfo: { limit: 100, hasMore: false, nextCursor: null },
          });
        }
        if (url.includes("/bulk-campaign-filters")) {
          return jsonResponse({ filter: { id: "filter-1" } });
        }
        return jsonResponse(analyticsResponse);
      }) as jest.Mock
    );
  });

  it("requests campaign send analytics by default", async () => {
    renderWithSWR(<BulkAnalytics workspaceId="workspace-1" days={14} />);

    await waitFor(() =>
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining("view=overview")
      )
    );

    const overviewUrl = (global.fetch as jest.Mock).mock.calls
      .map(([input]) => String(input))
      .find(url => url.includes("/bulk?") && url.includes("view=overview"));

    expect(overviewUrl).toContain("conversationScope=campaign_sends");
    expect(overviewUrl).toContain("compare=off");
    expect(overviewUrl).not.toContain("compare=previous");
  });

  it("hides the wa_ prefix on recipient table labels", async () => {
    installFetchMock(
      jest.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("view=records")) {
          return jsonResponse({
            generatedAt: richAnalyticsResponse.generatedAt,
            ...observation,
            records: [
              {
                id: "msg-1",
                messageId: "wamid.1",
                conversationId: "conv-1",
                recipient: "wa_77001234567",
                templateName: "promo",
                sentAt: "2026-09-01T10:00:00.000Z",
                firstReplyAt: null,
                firstReplyText: "hello",
                replyCount: 1,
                replyDelayMinutes: 2,
                replied: true,
                replyCategory: "other",
                conversationStatus: "open",
                isReadByManager: false,
              },
            ],
            pageInfo: { limit: 100, hasMore: false, nextCursor: null },
          });
        }
        return jsonResponse(richAnalyticsResponse);
      }) as jest.Mock
    );

    renderWithSWR(<BulkAnalytics workspaceId="workspace-wa" days={14} />);

    // The desktop table and the mobile cards both label the recipient.
    expect((await screen.findAllByText("77001234567")).length).toBeGreaterThan(
      0
    );
    expect(screen.queryByText("wa_77001234567")).toBeNull();
  });

  it("exports loaded analytics tables as Excel", async () => {
    const createObjectURL = jest.fn(() => "blob:export");
    const revokeObjectURL = jest.fn();
    const originalCreateObjectURL = URL.createObjectURL;
    const originalRevokeObjectURL = URL.revokeObjectURL;
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = revokeObjectURL;
    const click = jest
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);

    // A complete export needs a complete, retained observation.
    installFetchMock(
      jest.fn(async (input: RequestInfo | URL) =>
        jsonResponse(
          String(input).includes("view=records")
            ? {
                ...recordsResponse,
                pageInfo: { limit: 100, hasMore: false, nextCursor: null },
              }
            : { ...analyticsResponse, ...observation }
        )
      ) as jest.Mock
    );

    try {
      renderWithSWR(<BulkAnalytics workspaceId="workspace-export" days={14} />);
      const exportButton = await screen.findByRole("button", {
        name: "Export Excel",
      });
      await waitFor(() =>
        expect((exportButton as HTMLButtonElement).disabled).toBe(false)
      );
      fireEvent.click(exportButton);
      await waitFor(() => expect(createObjectURL).toHaveBeenCalled());
      expect(click).toHaveBeenCalled();
    } finally {
      click.mockRestore();
      URL.createObjectURL = originalCreateObjectURL;
      URL.revokeObjectURL = originalRevokeObjectURL;
    }
  });

  it("shows disabled overview state without requesting records", async () => {
    installFetchMock(
      jest.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("view=records")) {
          throw new Error("records should not be requested");
        }
        return jsonResponse(disabledOverviewResponse);
      }) as jest.Mock
    );

    renderWithSWR(<BulkAnalytics workspaceId="workspace-disabled" days={14} />);

    await waitFor(() => expect(global.fetch).toHaveBeenCalled());

    expect(
      await screen.findByText("Conversation overview is paused")
    ).toBeTruthy();

    const urls = (global.fetch as jest.Mock).mock.calls.map(([input]) =>
      String(input)
    );
    expect(urls.some(url => url.includes("view=records"))).toBe(false);
  });

  it("saves the current analytics filters under the entered name", async () => {
    renderWithSWR(<BulkAnalytics workspaceId="workspace-1" days={14} />);

    expect(
      await screen.findByText("No accepted sends in this period")
    ).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "Save filter" }));
    fireEvent.change(screen.getByLabelText("Filter name"), {
      target: { value: "Dormant leads" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/workspaces/workspace-1/bulk-campaign-filters",
        expect.objectContaining({
          method: "POST",
          body: expect.stringContaining("Dormant leads"),
        })
      )
    );
  });

  it.each(["en", "kz"] as const)(
    "toggles the %s more-filters disclosure and keeps entered filters",
    async locale => {
      const translations = catalogs[locale].BulkAnalytics;
      const filters = translations.filters;
      const phrase = "RAW retained phrase";
      const removePhraseName =
        translations.accessibility.removeMessagePhrase.replace(
          "{phrase}",
          phrase
        );
      renderWithSWR(
        <BulkAnalytics
          workspaceId={`workspace-disclosure-${locale}`}
          days={14}
        />,
        locale
      );

      expect(
        await screen.findByText(translations.empty.noSendsTitle)
      ).toBeTruthy();
      expect(screen.queryByLabelText(filters.engagementLabel)).toBeNull();

      // The accessible name is the visible label; aria-expanded carries the
      // state (WCAG 2.5.3, label in name).
      const disclosure = screen.getByRole("button", {
        name: filters.more,
      });
      expect(disclosure.textContent?.trim()).toBe(filters.more);
      expect(disclosure.getAttribute("aria-expanded")).toBe("false");
      expect(disclosure.hasAttribute("aria-controls")).toBe(false);
      fireEvent.click(disclosure);

      expect(disclosure.textContent?.trim()).toBe(filters.hideMore);
      expect(screen.getByRole("button", { name: filters.hideMore })).toBe(
        disclosure
      );
      expect(disclosure.getAttribute("aria-expanded")).toBe("true");
      expect(disclosure.getAttribute("aria-controls")).toBe(
        "bulk-analytics-more-filters"
      );
      const moreFilters = document.getElementById(
        "bulk-analytics-more-filters"
      );
      expect(moreFilters).not.toBeNull();
      expect(
        moreFilters!.contains(screen.getByLabelText(filters.engagementLabel))
      ).toBe(true);
      expect(
        moreFilters!.contains(screen.getByLabelText(filters.conversationsLabel))
      ).toBe(true);

      fireEvent.change(screen.getByLabelText(filters.messageTextLabel), {
        target: { value: phrase },
      });
      fireEvent.click(
        screen.getByRole("button", {
          name: translations.accessibility.addMessagePhrase,
        })
      );
      expect(
        screen.getByRole("button", { name: removePhraseName })
      ).toBeTruthy();
      await waitFor(() =>
        expect(global.fetch).toHaveBeenCalledWith(
          expect.stringContaining("messageContains=RAW+retained+phrase")
        )
      );

      fireEvent.click(disclosure);
      expect(disclosure.getAttribute("aria-expanded")).toBe("false");
      expect(screen.queryByLabelText(filters.engagementLabel)).toBeNull();
      expect(
        screen.queryByRole("button", { name: removePhraseName })
      ).toBeNull();
      fireEvent.click(disclosure);
      expect(
        screen.getByRole("button", { name: removePhraseName })
      ).toBeTruthy();
      expect(screen.getByLabelText(filters.engagementLabel)).toBeTruthy();
    }
  );

  it("applies message phrases with Add or Enter without a competing Apply button", async () => {
    renderWithSWR(<BulkAnalytics workspaceId="workspace-phrases" days={14} />);
    await screen.findByText("No accepted sends in this period");
    expect(screen.queryByRole("button", { name: "Apply" })).toBeNull();

    // Message phrases live with the advanced filters.
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    const input = screen.getByLabelText("Message text");
    fireEvent.change(input, { target: { value: "First phrase" } });
    const addPhrase = screen.getByRole("button", {
      name: "Add message phrase",
    });
    expect(addPhrase.textContent?.trim()).toBeTruthy();
    fireEvent.click(addPhrase);
    await waitFor(() =>
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining("messageContains=First+phrase")
      )
    );

    fireEvent.change(input, { target: { value: "Second phrase" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining("messageContains=First+phrase%2C+Second+phrase")
      )
    );

    const removePhrase = screen.getByRole("button", {
      name: "Remove message phrase First phrase",
    });
    expect(removePhrase.textContent?.trim()).toBeTruthy();
    fireEvent.click(removePhrase);
    await waitFor(() =>
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining("messageContains=Second+phrase")
      )
    );
  });

  it("opens on recipients and renders insights only when their tab is chosen", async () => {
    installFetchMock(
      jest.fn(async (input: RequestInfo | URL) =>
        jsonResponse(
          String(input).includes("view=records")
            ? recordsResponse
            : richAnalyticsResponse
        )
      ) as jest.Mock
    );
    const user = userEvent.setup();
    const translations = englishAnalytics.BulkAnalytics;
    renderWithSWR(<BulkAnalytics workspaceId="workspace-details" days={14} />);

    const recipientsTable = await screen.findByRole("table", {
      name: "Recent accepted WhatsApp sends",
    });
    expect(
      screen.queryByRole("heading", { name: translations.templatesTable.title })
    ).toBeNull();
    expect(screen.getAllByRole("button", { name: "Refresh" })).toHaveLength(1);
    const recipientsTab = screen.getByRole("tab", {
      name: translations.reports.recipients,
    });
    const insightsTab = screen.getByRole("tab", {
      name: translations.reports.insights,
    });
    expect(recipientsTab.getAttribute("aria-selected")).toBe("true");
    expect(insightsTab.getAttribute("aria-selected")).toBe("false");
    expect(
      insightsTab.compareDocumentPosition(recipientsTable) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();

    await user.click(insightsTab);
    expect(insightsTab.getAttribute("aria-selected")).toBe("true");
    expect(
      screen.getByRole("heading", { name: translations.templatesTable.title })
    ).toBeTruthy();
    expect(
      screen.queryByRole("table", { name: "Recent accepted WhatsApp sends" })
    ).toBeNull();

    await user.click(recipientsTab);
    expect(
      screen.queryByRole("heading", { name: translations.templatesTable.title })
    ).toBeNull();
    expect(
      screen.getByRole("table", { name: "Recent accepted WhatsApp sends" })
    ).toBeTruthy();
  });

  it("localizes period and message phrase accessibility labels in Kazakh", async () => {
    renderWithSWR(<BulkAnalytics workspaceId="workspace-kz" days={14} />, "kz");

    expect(
      await screen.findByText("Бұл кезеңде қабылданған жіберілім жоқ")
    ).toBeTruthy();
    fireEvent.click(
      await screen.findByRole("button", { name: "Кезең: Соңғы 14 күн" })
    );
    expect(
      screen.getByRole("group", { name: "Кезеңнің дайын аралықтары" })
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Тағы" }));
    const phraseInput = screen.getByLabelText("Хабарлама мәтіні");
    fireEvent.change(phraseInput, { target: { value: "RAW VIP phrase" } });
    fireEvent.click(
      screen.getByRole("button", { name: "Хабарлама тіркесін қосу" })
    );
    expect(
      screen.getByRole("button", {
        name: "RAW VIP phrase хабарлама тіркесін жою",
      })
    ).toBeTruthy();
    await waitFor(() =>
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining("messageContains=RAW+VIP+phrase")
      )
    );
    await act(async () => {
      await Promise.all(
        (global.fetch as jest.Mock).mock.results.map(result => result.value)
      );
    });
  });

  it("localizes a valid non-preset day period in Kazakh", async () => {
    renderWithSWR(
      <BulkAnalytics workspaceId="workspace-kz-custom-days" days={45} />,
      "kz"
    );

    expect(
      await screen.findByRole("button", { name: "Кезең: Соңғы 45 күн" })
    ).toBeTruthy();
  });

  it("uses the shared localized pagination accessibility labels", async () => {
    installFetchMock(
      jest.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        return jsonResponse(
          url.includes("view=records") ? recordsResponse : richAnalyticsResponse
        );
      }) as jest.Mock
    );

    renderWithSWR(<BulkAnalytics workspaceId="workspace-kz" days={14} />, "kz");

    expect(
      await screen.findByRole("button", { name: "Алдыңғы бетке өту" })
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Келесі бетке өту" })
    ).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: "Алдыңғы бетке өту" })
        .textContent?.trim()
    ).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: "Келесі бетке өту" })
        .textContent?.trim()
    ).toBeTruthy();
  });

  it("owns generic localized load and save errors", async () => {
    const providerDiagnostic = "PROVIDER_DIAGNOSTIC_RAW_451";
    const sentinelError = new Error(providerDiagnostic);
    const overviewParams = new URLSearchParams({
      replyWindowHours: "168",
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
      days: "14",
      conversationScope: "campaign_sends",
      compare: "off",
      view: "overview",
    });
    const overviewUrl = `/api/workspaces/workspace-load-error/analytics/bulk?${overviewParams.toString()}`;
    const { unmount } = renderWithSWR(
      <BulkAnalytics workspaceId="workspace-load-error" days={14} />,
      "kz",
      new Map([
        [
          overviewUrl,
          {
            error: new Error(providerDiagnostic),
            isLoading: false,
            isValidating: false,
          },
        ],
      ])
    );

    expect(
      screen.getByText("Жаппай аналитиканы жүктеу мүмкін болмады.")
    ).toBeTruthy();
    expect(screen.queryByText(providerDiagnostic)).toBeNull();
    unmount();

    installFetchMock(
      jest.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("bulk-campaign-filters")) {
          return Promise.reject(sentinelError);
        }
        return jsonResponse(analyticsResponse);
      }) as jest.Mock
    );
    renderWithSWR(
      <BulkAnalytics workspaceId="workspace-save-error" days={14} />,
      "kz"
    );

    expect(
      await screen.findByText("Бұл кезеңде қабылданған жіберілім жоқ")
    ).toBeTruthy();
    fireEvent.click(
      await screen.findByRole("button", { name: "Фильтрді сақтау" })
    );
    fireEvent.change(screen.getByLabelText("Фильтр атауы"), {
      target: { value: "RAW user filter name" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Сақтау" }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Фильтрді сақтау мүмкін болмады")
    );
    expect(toast.error).not.toHaveBeenCalledWith(providerDiagnostic);
    expect(mockLoggerError).toHaveBeenCalledTimes(1);
    expect(mockLoggerError.mock.calls[0]?.[1]).toBe(sentinelError);
    expect(mockLoggerError).toHaveBeenCalledWith(
      "bulk_analytics.filter_save_failed",
      sentinelError,
      { workspaceId: "workspace-save-error" }
    );
  });

  it("formats dates, numbers, USD, durations, and percentage points for kz", async () => {
    installFetchMock(
      jest.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        return jsonResponse(
          url.includes("view=records") ? recordsResponse : richAnalyticsResponse
        );
      }) as jest.Mock
    );

    const user = userEvent.setup();
    renderWithSWR(<BulkAnalytics workspaceId="workspace-kz" days={14} />, "kz");

    expect((await screen.findAllByText(/12\s345/)).length).toBeGreaterThan(0);
    expect(screen.getByText(/1\s234,50\s\$/)).toBeTruthy();
    expect(screen.getByText("1,5 сағ")).toBeTruthy();
    expect(screen.getAllByText(/05 мам\./).length).toBeGreaterThan(0);
    await enableComparison(user, kazakhAnalytics.BulkAnalytics);
    expect(screen.getByText(/ · \+12,5 п\.т\. алдыңғыға$/)).toBeTruthy();
  });

  it("normalizes a tiny negative percentage delta with localized zero units", async () => {
    const tinyNegativeReplyRateResponse = {
      ...richAnalyticsResponse,
      compare: {
        ...richAnalyticsResponse.compare,
        summary: {
          ...richAnalyticsResponse.compare.summary,
          replyRate: richAnalyticsResponse.summary.replyRate + 1e-10,
        },
      },
    };
    installFetchMock(
      jest.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        return jsonResponse(
          url.includes("view=records")
            ? recordsResponse
            : tinyNegativeReplyRateResponse
        );
      }) as jest.Mock
    );

    const user = userEvent.setup();
    renderWithSWR(
      <BulkAnalytics workspaceId="workspace-zero-pp" days={14} />,
      "kz"
    );

    await enableComparison(user, kazakhAnalytics.BulkAnalytics);
    expect(screen.getByText(/ · 0,0 п\.т\. алдыңғыға$/)).toBeTruthy();
    expect(screen.queryByText(/-0,0 п\.т\./)).toBeNull();
  });

  it("normalizes a tiny negative cost delta with localized zero units", async () => {
    const tinyNegativeCostResponse = {
      ...richAnalyticsResponse,
      compare: {
        ...richAnalyticsResponse.compare,
        summary: {
          ...richAnalyticsResponse.compare.summary,
          estimatedCost: richAnalyticsResponse.summary.estimatedCost + 1e-10,
        },
      },
    };
    installFetchMock(
      jest.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        return jsonResponse(
          url.includes("view=records")
            ? recordsResponse
            : tinyNegativeCostResponse
        );
      }) as jest.Mock
    );

    const user = userEvent.setup();
    const translations = kazakhAnalytics.BulkAnalytics;
    renderWithSWR(
      <BulkAnalytics workspaceId="workspace-zero-currency" days={14} />,
      "kz"
    );

    await enableComparison(user, translations);
    const costDetails = await openCostDetails(
      user,
      await findCostCard(translations)
    );
    expect(within(costDetails).getByText(/^0,00\s\$ алдыңғыға$/)).toBeTruthy();
    expect(within(costDetails).queryByText(/-0/)).toBeNull();
  });

  it("shows the canonical localized recent-campaign hint with raw campaign names", async () => {
    installFetchMock(
      jest.fn(async () =>
        jsonResponse({
          ...analyticsResponse,
          filters: richAnalyticsResponse.filters,
        })
      ) as jest.Mock
    );

    renderWithSWR(<BulkAnalytics workspaceId="workspace-kz" days={14} />, "kz");

    expect(
      await screen.findByText("Осы воркспейстегі соңғы кампаниялар:")
    ).toBeTruthy();
    expect(screen.getByText(/RAW Campaign 01 · 05 мам\./)).toBeTruthy();
  });
});
