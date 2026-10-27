/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import {
  fireEvent,
  render,
  screen,
  within,
  waitFor,
} from "@testing-library/react";
import messages from "../../../messages/analytics/en/page.json";
import panelMessages from "../../../messages/panel/en/page.json";
import { JourneyAnalytics } from "./journey-analytics";
import {
  normalizeDashboardCustomCalendarRange,
  resolveDashboardCalendarDays,
} from "@/lib/dashboard-comparison";
import { installMatchMedia } from "@/test-support/dom-test-utils";
const calendarLabels = () =>
  resolveDashboardCalendarDays(
    30,
    Intl.DateTimeFormat().resolvedOptions().timeZone,
    new Date(Date.now())
  );
const cohortWindow = () => {
  const labels = calendarLabels();
  const exact = normalizeDashboardCustomCalendarRange(
    labels.from,
    labels.to,
    Intl.DateTimeFormat().resolvedOptions().timeZone
  );
  return {
    start: exact.start.toISOString(),
    end: exact.endExclusive.toISOString(),
    observationDays: 30,
  };
};

let mockCards = ["acquisition"];
jest.mock("@/components/dashboard/dashboard-board-controller", () => ({
  OutcomesBoardController: ({
    children,
  }: {
    children: (props: unknown) => React.ReactNode;
  }) =>
    children({
      cards: mockCards.map(id => ({ id, width: 4, height: 1 })),
      editing: false,
      onCardsChange: jest.fn(),
      toolbar: null,
    }),
}));
jest.mock("@/components/dashboard/dashboard-board-grid", () => ({
  DashboardBoardGrid: ({
    cards,
    renderCard,
  }: {
    cards: Array<{ id: string }>;
    renderCard: (id: string) => React.ReactNode;
  }) => (
    <div>
      {cards.map(card => (
        <div key={card.id}>{renderCard(card.id)}</div>
      ))}
    </div>
  ),
}));
const mockSWR = jest.fn(),
  mockMutate = jest.fn();
jest.mock("swr", () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockSWR(...args),
}));
jest.mock("next-intl", () => ({
  useLocale: () => "en",
  useTranslations:
    (namespace: string) =>
    (key: string, values: Record<string, string | number> = {}) => {
      let result: unknown =
        namespace === "SectionCards"
          ? panelMessages.SectionCards
          : messages.AnalyticsOutcomes;
      for (const part of key.split("."))
        result = (result as Record<string, unknown>)[part];
      if (typeof result !== "string")
        throw new Error(`Missing analytics translation: ${key}`);
      return result.replace(/\{(\w+)\}/g, (_, name) => String(values[name]));
    },
}));
jest.mock("@/components/analytics/charts/LineChart", () => ({
  LineChart: () => null,
}));
const acquisition = {
  window: { observationDays: 30 },
  policy: { qualifiedStageKeys: ["qualified"], revision: 0 },
  coverage: {
    status: "ready",
    truncated: false,
    identityMissing: 0,
    projectedThrough: "2026-10-01T00:00:00Z",
    conversionThrough: "2026-10-01T00:00:00Z",
  },
  cohorts: [
    {
      kind: "ad",
      sourceId: "source",
      adId: "ad1",
      entries: 2,
      engaged: 1,
      qualified: 1,
      qualifiedPaid: 1,
      booked: 0,
      paid: 1,
      pendingObservation: 1,
      currencies: [
        {
          currency: "USD",
          sales: 1,
          refunds: 0,
          grossRevenue: 100,
          refundedRevenue: 0,
          netRevenue: 100,
        },
      ],
    },
  ],
  flows: [],
  retention: [],
  retentionMissingIdentity: 0,
};
const whatsapp = {
  delivery: {
    accepted: 1,
    delivered: 0,
    read: 0,
    replied: 0,
    failed: 0,
    pending: 1,
    byOrigin: [],
    topErrors: [],
    dailyDelivery: [],
    bySourcePhoneTemplate: [],
    breakdownTruncated: false,
  },
  pricing: { free: 0, unknown: 1, providerAccounts: [] },
  templates: [
    {
      accountKey: "account",
      sourceName: "Store WhatsApp",
      providerWindow: {
        start: "2026-09-01T00:00:00Z",
        end: "2026-10-02T00:00:00Z",
      },
      templateStatus: "activation_required",
      fetchedAt: null,
      templates: [],
    },
  ],
  health: [
    {
      sourceId: "source",
      sourceName: "Store WhatsApp",
      phoneQuality: null,
      portfolioLimit: null,
      accountStatus: "unknown",
      webhookStatus: "unknown",
      lastVerifiedAt: null,
      verificationFreshness: "unknown",
      templateIssues: null,
      activationStatus: "required",
      history: [],
    },
  ],
};
function mount(...blocks: string[]) {
  mockCards = blocks.length ? blocks : ["acquisition"];
  const result = render(
    <JourneyAnalytics workspaceId="workspace" memberId="member" />
  );
  // Data-contract tests inspect details. Default disclosure is tested separately.
  for (const detail of result.container.querySelectorAll("details"))
    detail.open = true;
  return result;
}
beforeEach(() => {
  jest.clearAllMocks();
  mockCards = ["acquisition"];
  mockSWR.mockImplementation((url: string | null) => ({
    data: !url
      ? undefined
      : url.includes("/acquisition?")
        ? acquisition
        : url.includes("/whatsapp?")
          ? whatsapp
          : url.endsWith("/policy")
            ? {
                qualifiedStageKeys: ["qualified"],
                revision: 0,
                stages: [{ key: "qualified", name: "Qualified" }],
                canEdit: false,
              }
            : url.includes("/service-lifecycle?")
              ? {
                  coverage: {
                    state: "not_started",
                    firstObservedAt: null,
                    historyGapAt: null,
                  },
                  observed: {},
                  bySource: [],
                  groupsTruncated: false,
                }
              : url.includes("/chat-leakage?")
                ? {
                    asOf: "2026-10-01T00:00:00Z",
                    counts: {
                      needsReply: 1,
                      agedUnanswered: 0,
                      stalled: 0,
                      handoff: 0,
                    },
                    groups: [
                      {
                        sourceId: null,
                        adId: "ad1",
                        ownerId: null,
                        eligibleCustomers: 1,
                        counts: { needsReply: 1, stalled: 0 },
                      },
                    ],
                    audience: [
                      {
                        conversationId: "conversation",
                        customerName: "Alice",
                        stageName: "Qualified lead",
                        ownerName: "Nora",
                        stageKey: "qualified",
                        adId: "ad1",
                        ownerId: null,
                        waitSeconds: 3600,
                        followUp: { kind: "reply" },
                      },
                    ],
                  }
                : {
                    advertisement: {
                      metaInsights: {
                        partial: false,
                        dateStart: calendarLabels().from,
                        dateStop: calendarLabels().to,
                        reporting: {
                          workspaceTimeZone:
                            Intl.DateTimeFormat().resolvedOptions().timeZone,
                        },
                        accounts: [],
                        topAds: [{ adId: "ad1", currency: "USD", spend: 100 }],
                      },
                    },
                  },
    mutate: mockMutate,
    isLoading: false,
  }));
});
test("defines observation and withholds efficiency on a young cohort", () => {
  mount();
  expect(screen.getByText(/outcomes within 30 days/)).toBeInTheDocument();
  expect(screen.queryByText("1×")).not.toBeInTheDocument();
  expect(screen.getByRole("checkbox", { name: "Qualified" })).toBeDisabled();
});
test("waiting lead records preserve the exact actionable chat link", () => {
  mount("attention");
  expect(screen.getByRole("link", { name: "Open chat" })).toHaveAttribute(
    "href",
    "/panel/w/workspace/requests?conversation=conversation"
  );
});
test("provider activation and missing quality are visible without invented zeros", () => {
  mount("health");
  expect(screen.getByText("Activation required")).toBeInTheDocument();
  expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  expect(screen.getByText(/never enabled automatically/)).toBeInTheDocument();
});

test("retained health distinguishes configuration and delivery measurement times", () => {
  const previous = mockSWR.getMockImplementation();
  mockSWR.mockImplementation((url: string | null) => {
    const result = previous?.(url);
    return url?.includes("/whatsapp?")
      ? {
          ...result,
          data: {
            ...whatsapp,
            health: [
              {
                ...whatsapp.health[0],
                history: [
                  {
                    day: "2026-10-02",
                    observedAt: "2026-10-02T03:00:00Z",
                    deliveryObservedAt: "2026-10-02T01:00:00Z",
                    phoneQuality: "GREEN",
                    portfolioLimit: "1000",
                    accountStatus: "healthy",
                    webhookStatus: "healthy",
                    templateIssues: null,
                    pending7d: 2,
                    failed7d: 1,
                  },
                ],
              },
            ],
          },
        }
      : result;
  });
  mount("health");
  expect(
    screen.getByRole("columnheader", { name: "Health observed" })
  ).toBeInTheDocument();
  expect(
    screen.getByRole("columnheader", { name: "Delivery observed" })
  ).toBeInTheDocument();
  const row = screen.getByRole("row", { name: /2026-10-02 GREEN 1000/ });
  expect(within(row).getByText("Configured")).toBeInTheDocument();
  expect(within(row).getAllByText("—")).toHaveLength(1);
});

test("template effectiveness shows unsupported read and click coverage as blanks", () => {
  const previous = mockSWR.getMockImplementation();
  mockSWR.mockImplementation((url: string | null) => {
    const result = previous?.(url);
    return url?.includes("/whatsapp?")
      ? {
          ...result,
          data: {
            ...whatsapp,
            templates: [
              {
                ...whatsapp.templates[0],
                templateStatus: "available",
                providerWindow: {
                  start: "2026-10-01T00:00:00Z",
                  end: "2026-10-02T00:00:00Z",
                },
                templates: [
                  {
                    name: "Login",
                    language: "en",
                    status: "APPROVED",
                    category: "AUTHENTICATION",
                    quality: null,
                    sent: 3,
                    delivered: 2,
                    read: null,
                    clicked: null,
                    uniqueClicked: null,
                    quickReplyClicked: null,
                    readRate: null,
                    clickRate: null,
                    cost: null,
                    costPerDelivered: null,
                    currency: "USD",
                  },
                ],
              },
            ],
          },
        }
      : result;
  });
  mount("templates");
  expect(screen.getByText(/Whole WhatsApp account:/)).toBeInTheDocument();
  const row = screen.getByRole("row", {
    name: /Login · en APPROVED AUTHENTICATION/,
  });
  expect(within(row).getAllByText("—")).toHaveLength(9);
  expect(within(row).queryByText("0")).not.toBeInTheDocument();
});
test.each([
  [true, "Enable template insights"],
  [false, "Only a workspace admin can turn on template insights."],
])(
  "an account waiting for insights activation offers the owner action (admin %s)",
  (canManage, text) => {
    // The confirm dialog picks a drawer on narrow screens.
    installMatchMedia();
    const previous = mockSWR.getMockImplementation();
    mockSWR.mockImplementation((url: string | null) =>
      url?.endsWith("/whatsapp/insights")
        ? { data: canManage, isLoading: false, mutate: mockMutate }
        : previous?.(url)
    );
    mount("templates");
    expect(
      screen.getByText(/Insights activation required ·/)
    ).toBeInTheDocument();
    expect(screen.getByText(text)).toBeInTheDocument();
  }
);
test("report errors offer a localized retry", async () => {
  mockSWR.mockImplementation(() => ({
    error: new Error("private"),
    mutate: mockMutate,
    isLoading: false,
  }));
  mount();
  expect(screen.getByText(/This report is unavailable/)).toBeInTheDocument();
  fireEvent.click(screen.getAllByRole("button", { name: "Refresh" }).at(-1)!);
  expect(mockMutate).toHaveBeenCalled();
  await waitFor(() =>
    expect(screen.getAllByRole("button", { name: "Refresh" })[0]).toBeEnabled()
  );
  expect(screen.queryByText("private")).not.toBeInTheDocument();
});
test("source selection applies one exact source to acquisition and actionable leads", () => {
  mount("acquisition", "attention");
  fireEvent.change(screen.getByRole("combobox", { name: "Source" }), {
    target: { value: "source" },
  });
  expect(
    mockSWR.mock.calls.some(
      ([url]) =>
        typeof url === "string" &&
        url.includes("/acquisition?") &&
        url.includes("sourceId=source")
    )
  ).toBe(true);

  expect(
    mockSWR.mock.calls.some(
      ([url]) =>
        typeof url === "string" &&
        url.includes("/chat-leakage?") &&
        url.includes("sourceIds=source")
    )
  ).toBe(true);
});

it("drills into the exact unassigned segment instead of dropping null filters", () => {
  mount("attention");
  fireEvent.click(screen.getByRole("button", { name: "View leads" }));
  expect(
    mockSWR.mock.calls.some(
      ([url]) =>
        typeof url === "string" &&
        url.includes("sourceIds=__none__") &&
        url.includes("ownerIds=__none__") &&
        url.includes("adIds=ad1")
    )
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Clear segment" }));
});

it("explicit provider refresh bypasses cached reads and keeps the result in SWR", async () => {
  global.fetch = jest
    .fn()
    .mockResolvedValue({ ok: true, json: async () => whatsapp });
  mount("delivery");
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await waitFor(() =>
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("&refresh=1")
    )
  );
  await waitFor(() =>
    expect(mockMutate).toHaveBeenCalledWith(whatsapp, { revalidate: false })
  );
});

it("refreshes independent reports and service history when the provider refresh fails", async () => {
  const previous = mockSWR.getMockImplementation();
  const originalFetch = global.fetch;
  const acquisitionRefresh = jest.fn().mockResolvedValue(undefined);
  const attentionRefresh = jest.fn().mockResolvedValue(undefined);
  const dashboardRefresh = jest.fn().mockResolvedValue(undefined);
  const clock = jest
    .spyOn(Date, "now")
    .mockReturnValue(Date.parse("2026-10-02T10:00:00Z"));
  global.fetch = jest.fn().mockRejectedValue(new Error("provider_unavailable"));
  mockSWR.mockImplementation((url: string | null) => ({
    ...previous?.(url),
    mutate: url?.includes("/acquisition?")
      ? acquisitionRefresh
      : url?.includes("/chat-leakage?")
        ? attentionRefresh
        : url?.startsWith("/api/dashboard?")
          ? dashboardRefresh
          : mockMutate,
  }));
  try {
    mount("acquisition", "attention", "delivery", "health");
    clock.mockReturnValue(Date.parse("2026-10-02T10:05:00Z"));
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => {
      expect(acquisitionRefresh).toHaveBeenCalledTimes(1);
      expect(attentionRefresh).toHaveBeenCalledTimes(1);
      expect(dashboardRefresh).toHaveBeenCalledTimes(1);
      expect(screen.getByRole("button", { name: "Refresh" })).toBeEnabled();
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Some reports could not refresh"
      );
      const url = mockSWR.mock.calls
        .filter(
          ([key]) =>
            typeof key === "string" && key.includes("/service-lifecycle?")
        )
        .at(-1)![0];
      expect(new URL(url, "https://airi.chat").searchParams.get("end")).toBe(
        "2026-10-02T10:05:00.000Z"
      );
    });
  } finally {
    clock.mockRestore();
    global.fetch = originalFetch;
  }
});

it("keeps customer, stage and owner labels aligned with their columns", () => {
  mount("attention");
  const row = screen.getByRole("row", {
    name: /Alice Qualified lead ad1 Nora/,
  });
  const cells = within(row).getAllByRole("cell");
  expect(cells).toHaveLength(7);
  expect(cells[0]).toHaveTextContent("Alice");
  expect(cells[1]).toHaveTextContent("Qualified lead");
  expect(cells[3]).toHaveTextContent("Nora");
});

it("shows recorded return only for a mature matching ad with stable WhatsApp destination", () => {
  const previous = mockSWR.getMockImplementation();
  mockSWR.mockImplementation((url: string | null) => {
    const result = previous?.(url);
    if (url?.includes("/acquisition?"))
      return {
        ...result,
        data: {
          ...acquisition,
          window: cohortWindow(),
          cohorts: [{ ...acquisition.cohorts[0], pendingObservation: 0 }],
        },
      };
    if (url?.includes("/api/dashboard?")) {
      const meta = result.data.advertisement.metaInsights;
      return {
        ...result,
        data: {
          advertisement: {
            metaInsights: {
              ...meta,
              topAds: meta.topAds.map((ad: object) => ({
                ...ad,
                destination: "whatsapp",
                destinationUpdatedAt: "2026-08-01T00:00:00Z",
              })),
            },
          },
        },
      };
    }
    return result;
  });
  mount();
  expect(screen.getByText("1×")).toBeInTheDocument();
});
it("withholds return when one ad spans multiple local source cohorts", () => {
  const previous = mockSWR.getMockImplementation();
  mockSWR.mockImplementation((url: string | null) => {
    const result = previous?.(url);
    if (url?.includes("/acquisition?"))
      return {
        ...result,
        data: {
          ...acquisition,
          window: cohortWindow(),
          cohorts: [
            { ...acquisition.cohorts[0], pendingObservation: 0 },
            {
              ...acquisition.cohorts[0],
              sourceId: "another-source",
              pendingObservation: 0,
            },
          ],
        },
      };
    if (url?.includes("/api/dashboard?")) {
      const meta = result.data.advertisement.metaInsights;
      return {
        ...result,
        data: {
          advertisement: {
            metaInsights: {
              ...meta,
              topAds: meta.topAds.map((ad: object) => ({
                ...ad,
                destination: "whatsapp",
                destinationUpdatedAt: "2026-08-01T00:00:00Z",
              })),
            },
          },
        },
      };
    }
    return result;
  });
  mount();
  expect(screen.queryByText("1×")).not.toBeInTheDocument();
});

it("shows the qualified-to-paid intersection only with mature complete qualification history", () => {
  const previous = mockSWR.getMockImplementation();
  mockSWR.mockImplementation((url: string | null) => {
    const result = previous?.(url);
    if (url?.includes("/acquisition?"))
      return {
        ...result,
        data: {
          ...acquisition,
          window: cohortWindow(),
          coverage: {
            ...acquisition.coverage,
            qualificationHistory: {
              state: "streaming",
              history: "since_activation",
              snapshotRecovery: "complete",
              firstObservedAt: "2026-08-01T00:00:00Z",
            },
          },
          cohorts: [
            {
              ...acquisition.cohorts[0],
              qualified: 2,
              paid: 2,
              qualifiedPaid: 1,
              pendingObservation: 0,
            },
          ],
        },
      };
    return result;
  });
  mount();
  expect(
    screen.getByRole("columnheader", { name: "Qualified to paid, %" })
  ).toBeInTheDocument();
  expect(screen.getByRole("cell", { name: "50%" })).toBeInTheDocument();
  for (const header of screen.getAllByRole("columnheader"))
    expect(header).toHaveAttribute("scope", "col");
});

it("refreshes service history through the current time within the selected source", async () => {
  const clock = jest
    .spyOn(Date, "now")
    .mockReturnValue(Date.parse("2026-10-02T10:00:00Z"));
  global.fetch = jest
    .fn()
    .mockResolvedValue({ ok: true, json: async () => whatsapp });
  try {
    mount("health");
    fireEvent.change(screen.getByRole("combobox", { name: "Source" }), {
      target: { value: "source" },
    });
    const beforeUrl = mockSWR.mock.calls
      .filter(
        ([url]) =>
          typeof url === "string" && url.includes("/service-lifecycle?")
      )
      .at(-1)![0];
    expect(
      new URL(beforeUrl, "https://airi.chat").searchParams.get("sourceId")
    ).toBe("source");
    clock.mockReturnValue(Date.parse("2026-10-02T10:05:00Z"));
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => {
      const afterUrl = mockSWR.mock.calls
        .filter(
          ([url]) =>
            typeof url === "string" && url.includes("/service-lifecycle?")
        )
        .at(-1)![0];
      const after = new URL(afterUrl, "https://airi.chat");
      expect(after.searchParams.get("end")).toBe("2026-10-02T10:05:00.000Z");
      expect(after.searchParams.get("sourceId")).toBe("source");
    });
  } finally {
    clock.mockRestore();
  }
});

it("announces initial report loading to assistive technology", () => {
  const previous = mockSWR.getMockImplementation();
  mockSWR.mockImplementation((url: string | null) =>
    url?.includes("/acquisition?")
      ? { data: undefined, isLoading: true, mutate: mockMutate }
      : previous?.(url)
  );
  mount();
  expect(screen.getByRole("region", { name: "Acquisition" })).toHaveAttribute(
    "aria-busy",
    "true"
  );
  expect(screen.getByRole("status")).toHaveTextContent("Loading");
});

it("requests the same calendar days and canonical timezone for spend and acquisition", () => {
  mount();
  const acquisitionUrl = new URL(
    mockSWR.mock.calls.find(
      ([url]) => typeof url === "string" && url.includes("/acquisition?")
    )![0],
    "https://airi.chat"
  );
  const spendUrl = new URL(
    mockSWR.mock.calls.find(
      ([url]) => typeof url === "string" && url.includes("/api/dashboard?")
    )![0],
    "https://airi.chat"
  );
  expect(spendUrl.searchParams.get("timezone")).toBe(
    acquisitionUrl.searchParams.get("timeZone")
  );
  expect(spendUrl.searchParams.has("timeZone")).toBe(false);
  expect(spendUrl.searchParams.get("from")).toBe(
    acquisitionUrl.searchParams.get("from")
  );
  expect(spendUrl.searchParams.get("to")).toBe(
    acquisitionUrl.searchParams.get("to")
  );
  const before = acquisitionUrl.searchParams.get("to")!;
  fireEvent.click(screen.getByRole("checkbox", { name: "Use mature cohorts" }));
  const matureUrl = new URL(
    mockSWR.mock.calls
      .filter(
        ([url]) => typeof url === "string" && url.includes("/acquisition?")
      )
      .at(-1)![0],
    "https://airi.chat"
  );
  expect(
    Date.parse(before) - Date.parse(matureUrl.searchParams.get("to")!)
  ).toBeGreaterThanOrEqual(31 * 86400000);
});

it("withholds efficiency if calendar spend and entry windows disagree", () => {
  const previous = mockSWR.getMockImplementation();
  mockSWR.mockImplementation((url: string | null) => {
    const result = previous?.(url);
    if (url?.includes("/acquisition?"))
      return {
        ...result,
        data: {
          ...acquisition,
          window: cohortWindow(),
          cohorts: [{ ...acquisition.cohorts[0], pendingObservation: 0 }],
        },
      };
    if (url?.includes("/api/dashboard?"))
      return {
        ...result,
        data: {
          advertisement: {
            metaInsights: {
              ...result.data.advertisement.metaInsights,
              dateStart: "2020-01-01",
              topAds: [
                {
                  adId: "ad1",
                  currency: "USD",
                  spend: 100,
                  destination: "whatsapp",
                  destinationUpdatedAt: "2020-01-01",
                },
              ],
            },
          },
        },
      };
    return result;
  });
  mount();
  expect(screen.queryByText("1×")).not.toBeInTheDocument();
});

it("keeps default evidence visible and closes wide details", () => {
  mockCards = ["acquisition"];
  render(<JourneyAnalytics workspaceId="workspace" memberId="member" />);
  const report = screen.getByRole("region", { name: "Acquisition" });
  expect(within(report).getByText("Entries", { selector: "dt" })).toBeVisible();
  expect(screen.getByRole("table")).not.toBeVisible();
  expect(
    within(screen.getByRole("combobox", { name: "Period" })).getByRole(
      "option",
      {
        name: "30 days",
      }
    )
  ).toBeInTheDocument();
  expect(
    screen.queryByText(
      "Follow new entries through engagement, qualification and confirmed outcomes, then act on waiting leads."
    )
  ).not.toBeInTheDocument();
});

it.each([
  { status: "partial", truncated: false, zero: "—" },
  { status: "ready", truncated: true, zero: "—" },
  { status: "ready", truncated: false, zero: "0" },
])(
  "keeps lead details consistent with $status coverage and truncation=$truncated",
  ({ status, truncated, zero }) => {
    const previous = mockSWR.getMockImplementation();
    mockSWR.mockImplementation((url: string | null) => {
      const result = previous?.(url);
      return url?.includes("/chat-leakage?")
        ? {
            ...result,
            data: {
              ...result.data,
              status,
              truncated,
              counts: { ...result.data.counts, needsReply: 0, stalled: 3 },
              groups: [
                {
                  sourceId: "source",
                  sourceName: "Store",
                  adId: "ad1",
                  ownerId: "owner",
                  ownerName: "Nora",
                  counts: { needsReply: 0, stalled: 3 },
                },
              ],
            },
          }
        : result;
    });
    mount("attention");
    const row = screen.getByRole("row", { name: /Store ad1 Nora/ });
    const cells = within(row).getAllByRole("cell");
    expect(cells[3]).toHaveTextContent(zero);
    expect(cells[4]).toHaveTextContent("3");
    const report = screen.getByRole("region", { name: "Waiting leads" });
    expect(
      within(report).getByText("Needs reply", { selector: "dt" })
        .nextElementSibling
    ).toHaveTextContent(zero);
  }
);

it("does not present incomplete empty acquisition history as measured zero", () => {
  const previous = mockSWR.getMockImplementation();
  mockSWR.mockImplementation((url: string | null) =>
    url?.includes("/acquisition?")
      ? {
          ...previous?.(url),
          data: {
            ...acquisition,
            cohorts: [],
            coverage: { ...acquisition.coverage, status: "backfilling" },
          },
        }
      : previous?.(url)
  );
  mount();
  const report = screen.getByRole("region", { name: "Acquisition" });
  for (const metric of report.querySelectorAll("dd"))
    expect(metric).toHaveTextContent("—");
  expect(within(report).getByRole("status")).toHaveTextContent(
    "Counts are incomplete"
  );
});

it("does not claim no leads when a partial scan has an empty audience page", () => {
  const previous = mockSWR.getMockImplementation();
  mockSWR.mockImplementation((url: string | null) =>
    url?.includes("/chat-leakage?")
      ? {
          ...previous?.(url),
          data: {
            ...previous?.(url).data,
            audience: [],
            audienceTotal: 2,
            truncated: true,
          },
        }
      : previous?.(url)
  );
  mount("attention");
  expect(
    screen.queryByText(messages.AnalyticsOutcomes.emptyAttention)
  ).not.toBeInTheDocument();
  expect(
    screen.getByText(messages.AnalyticsOutcomes.workspace.audienceUnavailable)
  ).toBeInTheDocument();
});

it("clears a drilled segment after switching sources and returning", () => {
  mount("attention");
  fireEvent.click(screen.getByRole("button", { name: "View leads" }));
  fireEvent.change(screen.getByRole("combobox", { name: "Source" }), {
    target: { value: "source" },
  });
  fireEvent.change(screen.getByRole("combobox", { name: "Source" }), {
    target: { value: "" },
  });
  const last = mockSWR.mock.calls
    .filter(
      ([url]) => typeof url === "string" && url.includes("/chat-leakage?")
    )
    .at(-1)![0];
  expect(last).not.toContain("adIds=");
  expect(
    screen.queryByRole("button", { name: "Clear segment" })
  ).not.toBeInTheDocument();
});

it("keeps the selected source label while source discovery changes with the period", () => {
  mount();
  fireEvent.change(screen.getByRole("combobox", { name: "Source" }), {
    target: { value: "source" },
  });
  const previous = mockSWR.getMockImplementation();
  mockSWR.mockImplementation((url: string | null) =>
    url?.includes("/whatsapp?days=7")
      ? { ...previous?.(url), data: undefined, isLoading: true }
      : previous?.(url)
  );
  fireEvent.change(screen.getByRole("combobox", { name: "Period" }), {
    target: { value: "7" },
  });
  expect(screen.getByRole("combobox", { name: "Source" })).toHaveValue(
    "source"
  );
  expect(screen.getByRole("option", { name: "Store WhatsApp" })).toHaveValue(
    "source"
  );
  expect(
    mockSWR.mock.calls.some(
      ([url]) =>
        typeof url === "string" &&
        url.includes("acquisition?") &&
        url.includes("days=7") &&
        url.includes("sourceId=source")
    )
  ).toBe(true);
});
