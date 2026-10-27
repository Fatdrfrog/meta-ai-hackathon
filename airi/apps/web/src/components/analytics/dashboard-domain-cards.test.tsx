/** @jest-environment jsdom */

import "@testing-library/jest-dom";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { SWRConfig } from "swr";
import { DashboardDomainCard } from "./dashboard-domain-cards";

const messages: Record<string, string> = {
  "DashboardClientPage.board.domain.window": "Last 30 days",
  "DashboardClientPage.board.domain.aiScope": "All AI calls",
  "DashboardClientPage.board.domain.campaignScope": "All campaign recipients",
  "DashboardClientPage.board.domain.openReport": "Open detailed report",
  "DashboardClientPage.board.domain.loading": "Loading summary…",
  "DashboardClientPage.board.domain.unavailable": "Summary unavailable",
  "DashboardClientPage.board.domain.emptyAi": "No AI activity in this period",
  "DashboardClientPage.board.domain.emptyCampaigns":
    "No campaign sends in this period",
  "DashboardClientPage.board.domain.loadFailed": "Could not load this summary",
  "DashboardClientPage.board.domain.retry": "Retry",
  "DashboardClientPage.board.domain.notAvailable": "Not available",
  "DashboardClientPage.board.domain.aiErrors": "AI call errors",
  "DashboardClientPage.board.domain.campaignReplyWindow":
    "Replies within 7 days of each send",
  "LlmAnalytics.warehouse.cards.llmCalls.title": "AI calls",
  "LlmAnalytics.warehouse.spend.cards.totalSpend.title": "AI spend",
  "BulkAnalytics.summary.acceptedSends": "Accepted sends",
  "BulkAnalytics.summary.replied": "Replied",
  "BulkAnalytics.funnel.delivered": "Delivered",
};

jest.mock("next-intl", () => ({
  useLocale: () => "en",
  useTranslations: (namespace: string) => (key: string) =>
    messages[`${namespace}.${key}`] ?? `${namespace}.${key}`,
}));

const aiResponse = {
  days: 30,
  analytics: {
    totals: {
      safeConversationalReplies: 0,
      ragTurns: 2,
      groundedRecoveryUsage: 0,
      genericClarificationUsage: 0,
      lowConfidenceUnderstandingResults: 0,
    },
    rates: {
      groundedRecoveryRate: 0,
      genericClarificationRate: 0,
      lowConfidenceRate: 0,
      safeReplyShare: 0,
    },
    trends: [],
    breakdowns: {
      fallbackActions: [],
      fallbackReasons: [],
      resultTypes: [],
      channels: [],
      safeReplyKinds: [],
      lowConfidenceKinds: [],
    },
    sampleInfo: { eventCount: 2, limited: false },
  },
  warehouse: {
    overview: { trace_count: "1234", error_count: "3" },
    spend: {
      workspace: { overview: { trace_count: "1234", total_cost_usd: "0.004" } },
    },
    source: "bigquery",
  },
};

const campaignResponse = {
  generatedAt: "2026-10-01T00:00:00.000Z",
  window: {
    days: 30,
    startDate: "2026-09-01T00:00:00.000Z",
    endDate: "2026-10-01T00:00:00.000Z",
    replyWindowHours: 168,
  },
  filters: { templates: [], campaigns: [] },
  summary: {
    totalAccepted: 80,
    uniqueConversations: 70,
    replied: 20,
    notReplied: 60,
    totalReplies: 25,
    replyRate: 0.25,
    delivered: 60,
    avgReplyDelayMinutes: 5,
    firstSentAt: null,
    lastSentAt: null,
  },
  overview: { status: "ready" },
  byTemplate: [],
  daily: [],
  replyCategories: [],
  detectedRuns: [],
  topConversations: [],
  records: [],
  note: "",
};

const originalFetch = global.fetch;
const resolvedDateOptions = Intl.DateTimeFormat().resolvedOptions();

function response(data: unknown, ok = true) {
  return { ok, json: async () => data } as Response;
}

function show(kind: "ai_usage" | "campaigns", workspaceId = "workspace-1") {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <DashboardDomainCard kind={kind} workspaceId={workspaceId} />
    </SWRConfig>
  );
}

function metric(title: string) {
  return within(
    screen.getByText(title).closest('[data-slot="card"]') as HTMLElement
  );
}

beforeEach(() => {
  jest.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockReturnValue({
    ...resolvedDateOptions,
    timeZone: "UTC",
  });
});

afterEach(() => {
  global.fetch = originalFetch;
  jest.restoreAllMocks();
});

describe("DashboardDomainCard", () => {
  it("loads actual AI call counts and precise USD spend with explicit independent scope", async () => {
    const fetchMock = jest.fn(async (_url: RequestInfo | URL) =>
      response(aiResponse)
    );
    global.fetch = fetchMock;
    show("ai_usage", "workspace/one");

    await screen.findByText("AI calls");
    expect(metric("AI calls").getByText("1,234")).toBeVisible();
    expect(metric("AI spend").getByText("$0.004")).toBeVisible();
    expect(metric("AI call errors").getByText("3")).toBeVisible();
    expect(screen.getByText("Last 30 days")).toBeVisible();
    expect(screen.getByText("All AI calls")).toBeVisible();
    expect(
      screen.getByRole("link", { name: "Open detailed report" })
    ).toHaveAttribute("href", "/panel/w/workspace%2Fone/analytics/llm");
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "/api/analytics/llm?workspaceId=workspace%2Fone&days=30"
    );
  });

  it("does not substitute operator events or zero for unavailable warehouse AI data", async () => {
    global.fetch = jest.fn(async () =>
      response({ ...aiResponse, warehouse: { source: "disabled" } })
    );
    show("ai_usage");

    expect(await screen.findByText("Summary unavailable")).toBeVisible();
    expect(screen.queryByText("AI calls")).not.toBeInTheDocument();
  });

  it("keeps missing AI metrics unavailable alongside valid call counts", async () => {
    global.fetch = jest.fn(async () =>
      response({
        ...aiResponse,
        warehouse: { overview: { trace_count: 4 }, source: "bigquery" },
      })
    );
    show("ai_usage");

    await screen.findByText("AI calls");
    expect(metric("AI calls").getByText("4")).toBeVisible();
    expect(metric("AI spend").getByText("Not available")).toBeVisible();
    expect(metric("AI call errors").getByText("Not available")).toBeVisible();
  });

  it("shows unavailable when a successful response has no summary payload", async () => {
    global.fetch = jest.fn(async () => response(null));
    show("ai_usage");

    expect(await screen.findByText("Summary unavailable")).toBeVisible();
  });

  it("shows a genuine empty AI period when all recorded summary values are zero", async () => {
    global.fetch = jest.fn(async () =>
      response({
        ...aiResponse,
        warehouse: {
          overview: { trace_count: 0, error_count: 0 },
          spend: { workspace: { overview: { total_cost_usd: 0 } } },
          source: "bigquery",
        },
      })
    );
    show("ai_usage");

    expect(
      await screen.findByText("No AI activity in this period")
    ).toBeVisible();
  });

  it("keeps accepted campaign sends distinct from delivered recipients", async () => {
    const fetchMock = jest.fn(async (_url: RequestInfo | URL) =>
      response(campaignResponse)
    );
    global.fetch = fetchMock;
    show("campaigns");

    await screen.findByText("Accepted sends");
    expect(metric("Accepted sends").getByText("80")).toBeVisible();
    expect(metric("Delivered").getByText("60")).toBeVisible();
    expect(metric("Replied").getByText("20")).toBeVisible();
    expect(screen.getByText("All campaign recipients")).toBeVisible();
    expect(
      screen.getByText("Replies within 7 days of each send")
    ).toBeVisible();
    expect(
      screen.getByRole("link", { name: "Open detailed report" })
    ).toHaveAttribute("href", "/panel/w/workspace-1/analytics/bulk");
    const url = new URL(
      String(fetchMock.mock.calls[0]?.[0]),
      "https://airi.chat"
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      days: "30",
      replyWindowHours: "168",
      timezone: "UTC",
      conversationScope: "campaign_sends",
      view: "overview",
      compare: "off",
    });
  });

  it("does not infer delivered counts when provider delivery data is absent", async () => {
    global.fetch = jest.fn(async () =>
      response({
        ...campaignResponse,
        summary: { ...campaignResponse.summary, delivered: null },
      })
    );
    show("campaigns");

    await screen.findByText("Accepted sends");
    expect(metric("Delivered").getByText("Not available")).toBeVisible();
  });

  it.each([
    { ...campaignResponse, summary: undefined },
    { ...campaignResponse, overview: { status: "disabled" } },
  ])(
    "shows unavailable for a campaign report without a usable summary",
    async data => {
      global.fetch = jest.fn(async () => response(data));
      show("campaigns");

      expect(await screen.findByText("Summary unavailable")).toBeVisible();
      expect(screen.queryByText("Accepted sends")).not.toBeInTheDocument();
    }
  );

  it("shows an empty campaign period rather than fabricated activity", async () => {
    global.fetch = jest.fn(async () =>
      response({
        ...campaignResponse,
        summary: {
          ...campaignResponse.summary,
          totalAccepted: 0,
          replied: 0,
          delivered: 0,
        },
      })
    );
    show("campaigns");

    expect(
      await screen.findByText("No campaign sends in this period")
    ).toBeVisible();
  });

  it("keeps the reporting scope and link visible while data loads", () => {
    global.fetch = jest.fn(() => new Promise<Response>(() => {}));
    show("campaigns");

    expect(screen.getByRole("status")).toHaveTextContent("Loading summary…");
    expect(screen.getByText("Last 30 days")).toBeVisible();
    expect(
      screen.getByRole("link", { name: "Open detailed report" })
    ).toBeVisible();
  });

  it("allows a failed AI summary request to be retried without automatic retry churn", async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(response({}, false))
      .mockResolvedValueOnce(response(aiResponse));
    show("ai_usage");

    await screen.findByText("Could not load this summary");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("1,234")).toBeVisible();
  });
});
