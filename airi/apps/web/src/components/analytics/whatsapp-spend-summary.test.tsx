/**
 * @jest-environment jsdom
 */

import type { WhatsAppSpendReport } from "@/lib/analytics/whatsapp-spend";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { SWRConfig } from "swr";
import {
  buildWhatsAppSpendUrl,
  WhatsAppSpendSummary,
} from "./whatsapp-spend-summary";

jest.mock("next-intl", () => ({
  useLocale: () => "en",
  useTranslations:
    () => (key: string, values?: Record<string, string | number>) =>
      values ? `${key} ${JSON.stringify(values)}` : key,
}));

function renderWithSWR(ui: ReactElement) {
  return render(
    <SWRConfig
      value={{
        provider: () => new Map(),
        dedupingInterval: 0,
        shouldRetryOnError: false,
      }}
    >
      {ui}
    </SWRConfig>
  );
}

function report(
  overrides: Partial<WhatsAppSpendReport> = {}
): WhatsAppSpendReport {
  return {
    window: {
      start: "2026-09-05T00:00:00.000Z",
      end: "2026-10-05T10:00:00.000Z",
    },
    generatedAt: "2026-10-05T10:00:01.000Z",
    state: "available",
    totals: [{ currency: "USD", spend: 20, accounts: 1 }],
    accounts: [
      {
        accountKey: "waba-1",
        sourceId: "s1",
        sourceName: "Main number",
        state: "reported",
        currency: "USD",
        spend: 20,
        volume: 400,
        fetchedAt: "2026-10-05T10:00:00.000Z",
      },
    ],
    accountsTruncated: false,
    ...overrides,
  };
}

function mockFetch(...responses: Array<{ ok: boolean; body?: unknown }>) {
  const fetchMock = jest.fn();
  for (const response of responses)
    fetchMock.mockResolvedValueOnce({
      ok: response.ok,
      json: async () => response.body,
    });
  global.fetch = fetchMock as typeof fetch;
  return fetchMock;
}

const usd = (value: number) =>
  new Intl.NumberFormat("en", { style: "currency", currency: "USD" }).format(
    value
  );

beforeEach(() => jest.clearAllMocks());

test("builds a member-scoped URL for a day count or an explicit report window", () => {
  const now = new Date("2026-10-05T10:00:00.000Z");
  expect(buildWhatsAppSpendUrl("w 1", { days: 30 })).toBe(
    "/api/workspaces/w%201/analytics/whatsapp-spend?days=30"
  );
  expect(
    buildWhatsAppSpendUrl(
      "w",
      { from: "2026-09-21T18:00:00.000Z", to: "2026-10-05T09:59:00.000Z" },
      now
    )
  ).toBe(
    "/api/workspaces/w/analytics/whatsapp-spend?from=2026-09-21&to=2026-10-05"
  );
});

test("sends only whole UTC dates the route accepts: the last 90 days, through today", () => {
  const now = new Date("2026-10-05T10:00:00.000Z");
  // A 180-day bulk analytics window, ending after its reply buffer.
  expect(
    buildWhatsAppSpendUrl(
      "w",
      { from: "2026-04-08T10:00:00.000Z", to: "2026-10-08T10:00:00.000Z" },
      now
    )
  ).toBe(
    "/api/workspaces/w/analytics/whatsapp-spend?from=2026-07-07&to=2026-10-05"
  );
  // Older than the 365-day lookback: nothing is requested.
  expect(
    buildWhatsAppSpendUrl(
      "w",
      { from: "2025-01-01T00:00:00.000Z", to: "2025-09-30T00:00:00.000Z" },
      now
    )
  ).toBeNull();
});

test("explains a report period older than the spend lookback without reading Meta", () => {
  const fetchMock = mockFetch();
  renderWithSWR(
    <WhatsAppSpendSummary
      workspaceId="w"
      period={{ from: "2020-01-01", to: "2020-02-01" }}
    />
  );
  expect(screen.getByRole("status").textContent).toBe("outOfRange");
  expect(fetchMock).not.toHaveBeenCalled();
});

test("shows a loading state while Meta is read", async () => {
  global.fetch = jest.fn(() => new Promise(() => undefined)) as typeof fetch;
  renderWithSWR(<WhatsAppSpendSummary workspaceId="w" period={{ days: 30 }} />);
  expect(await screen.findByText("loading")).toBeTruthy();
  expect(
    screen.getByRole("region", { name: "title" }).getAttribute("aria-busy")
  ).toBe("true");
});

test("labels reported spend as approximate, account-level, with Meta's window", async () => {
  mockFetch({ ok: true, body: report() });
  renderWithSWR(<WhatsAppSpendSummary workspaceId="w" period={{ days: 30 }} />);
  expect(await screen.findByText(usd(20))).toBeTruthy();
  expect(screen.getByText('approximate {"currency":"USD"}')).toBeTruthy();
  expect(screen.getByText("scope")).toBeTruthy();
  expect(screen.getByText(/^window /).textContent).toContain("Sep 5, 2026");
  // One fully reported account needs no per-account list.
  expect(screen.queryByText("Main number")).toBeNull();
});

test("keeps currencies apart and lists every account with its state", async () => {
  mockFetch({
    ok: true,
    body: report({
      state: "partial",
      totals: [
        { currency: "KZT", spend: 5000, accounts: 1 },
        { currency: "USD", spend: 20, accounts: 1 },
      ],
      accounts: [
        ...report().accounts,
        {
          accountKey: "waba-2",
          sourceId: "s2",
          sourceName: "Almaty",
          state: "reported",
          currency: "KZT",
          spend: 5000,
          volume: 10,
          fetchedAt: null,
        },
        {
          accountKey: "waba-3",
          sourceId: "s3",
          sourceName: "Partner line",
          state: "cost_withheld",
          currency: "USD",
          spend: null,
          volume: 30,
          fetchedAt: null,
        },
      ],
      accountsTruncated: true,
    }),
  });
  renderWithSWR(<WhatsAppSpendSummary workspaceId="w" period={{ days: 7 }} />);
  expect(await screen.findByText("partial")).toBeTruthy();
  expect(screen.getAllByText(usd(20))).toHaveLength(2);
  expect(
    screen.getAllByText(
      // Testing Library collapses the formatter's non-breaking space.
      new Intl.NumberFormat("en", { style: "currency", currency: "KZT" })
        .format(5000)
        .replace(/\s/g, " ")
    )
  ).toHaveLength(2);
  expect(screen.getByText("accountState.cost_withheld")).toBeTruthy();
  expect(screen.getByText("truncated")).toBeTruthy();
});

test("asks to reconnect WhatsApp when Meta access expired", async () => {
  mockFetch({
    ok: true,
    body: report({
      state: "reconnect",
      totals: [],
      accounts: [
        {
          ...report().accounts[0],
          state: "reconnect",
          spend: null,
        },
      ],
    }),
  });
  renderWithSWR(<WhatsAppSpendSummary workspaceId="w" period={{ days: 30 }} />);
  expect(await screen.findByText("reconnect")).toBeTruthy();
  expect(
    screen.getByRole("link", { name: "reconnectAction" }).getAttribute("href")
  ).toBe("/panel/w/w/settings/integrations?type=whatsapp&reconnect=1");
  expect(screen.getByText("accountState.reconnect")).toBeTruthy();
});

test("says Meta reported no charges instead of showing zero", async () => {
  mockFetch({
    ok: true,
    body: report({
      totals: [],
      accounts: [
        { ...report().accounts[0], state: "no_activity", spend: null },
      ],
    }),
  });
  renderWithSWR(<WhatsAppSpendSummary workspaceId="w" period={{ days: 30 }} />);
  expect(await screen.findByText("noSpend")).toBeTruthy();
  expect(screen.queryByText(usd(0))).toBeNull();
});

test("offers connecting WhatsApp when the workspace has no WhatsApp source", async () => {
  mockFetch({
    ok: true,
    body: report({ state: "no_source", totals: [], accounts: [] }),
  });
  renderWithSWR(<WhatsAppSpendSummary workspaceId="w" period={{ days: 30 }} />);
  expect(await screen.findByText(/noSource/)).toBeTruthy();
  expect(
    screen.getByRole("link", { name: "connect" }).getAttribute("href")
  ).toBe("/panel/w/w/settings/integrations?type=whatsapp");
  expect(screen.queryByText(/^window /)).toBeNull();
});

test("retries after a failed or temporarily unavailable read", async () => {
  const fetchMock = mockFetch(
    { ok: false, body: { error: "WhatsApp spend unavailable" } },
    {
      ok: true,
      body: report({
        state: "unavailable",
        totals: [],
        accounts: [
          { ...report().accounts[0], state: "unavailable", spend: null },
        ],
      }),
    },
    { ok: true, body: report() }
  );
  renderWithSWR(<WhatsAppSpendSummary workspaceId="w" period={{ days: 30 }} />);
  expect(await screen.findByText("error")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "retry" }));
  expect(await screen.findByText("unavailable")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "retry" }));
  await waitFor(() => expect(screen.getByText(usd(20))).toBeTruthy());
  expect(fetchMock).toHaveBeenCalledTimes(3);
});

test("treats an unexpected payload as an error, not as zero spend", async () => {
  mockFetch({ ok: true, body: { campaigns: [] } });
  renderWithSWR(<WhatsAppSpendSummary workspaceId="w" period={{ days: 30 }} />);
  expect(await screen.findByText("error")).toBeTruthy();
});
