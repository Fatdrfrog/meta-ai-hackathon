const mockReadSpend = jest.fn();
const mockSourcesQuery = {
  select: jest.fn().mockReturnThis(),
  eq: jest.fn().mockReturnThis(),
  order: jest.fn().mockReturnThis(),
  limit: jest.fn(),
};
jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: { from: jest.fn(() => mockSourcesQuery) },
}));
jest.mock("@/lib/whatsapp/credentials", () => ({
  normalizeWhatsAppCredentials: (value: unknown) => value,
}));
jest.mock("./whatsapp-provider-analytics", () => ({
  readWhatsAppProviderSpend: (...args: unknown[]) => mockReadSpend(...args),
}));
import type { WhatsAppProviderSpendAccount } from "./whatsapp-analytics-contract";
import {
  classifyWhatsAppSpendAccount,
  queryWhatsAppSpend,
  resolveWhatsAppSpendWindow,
  summarizeWhatsAppSpend,
} from "./whatsapp-spend";

function account(
  overrides: Partial<WhatsAppProviderSpendAccount> = {}
): WhatsAppProviderSpendAccount {
  return {
    sourceId: "s1",
    sourceName: "Main",
    accountKey: "waba-1",
    scope: "waba",
    providerWindow: {
      start: "2026-09-05T00:00:00.000Z",
      end: "2026-10-05T10:00:00.000Z",
    },
    status: "available",
    pricingStatus: "available",
    currency: "USD",
    approximateSpend: 12.5,
    pricing: [
      {
        start: 1,
        end: 2,
        country: "KZ",
        category: "MARKETING_LITE",
        type: "REGULAR",
        tier: null,
        volume: 250,
        cost: 12.5,
        currency: "USD",
      },
    ],
    fetchedAt: "2026-10-05T10:00:00.000Z",
    ...overrides,
  };
}
const window = {
  start: new Date("2026-09-05T00:00:00Z"),
  end: new Date("2026-10-05T10:00:00Z"),
};

beforeEach(() => jest.clearAllMocks());

test.each([
  [account(), "reported"],
  [account({ approximateSpend: null, pricing: [] }), "no_activity"],
  [account({ approximateSpend: null }), "cost_withheld"],
  [
    account({
      status: "permission_required",
      pricingStatus: "permission_required",
    }),
    "reconnect",
  ],
  [account({ pricingStatus: "not_connected" }), "reconnect"],
  [account({ pricingStatus: "unsupported" }), "unsupported"],
  [account({ pricingStatus: "unavailable" }), "unavailable"],
])("classifies a provider answer (%#)", (input, expected) => {
  expect(classifyWhatsAppSpendAccount(input)).toBe(expected);
});

test("totals reported spend per currency and never sums currencies together", () => {
  const report = summarizeWhatsAppSpend({
    accounts: [
      account(),
      account({ accountKey: "waba-2", approximateSpend: 7.5 }),
      account({
        accountKey: "waba-3",
        currency: "KZT",
        approximateSpend: 5000,
      }),
    ],
    window,
    accountsTruncated: false,
    now: new Date("2026-10-05T10:00:01Z"),
  });
  expect(report.state).toBe("available");
  expect(report.totals).toEqual([
    { currency: "KZT", spend: 5000, accounts: 1 },
    { currency: "USD", spend: 20, accounts: 2 },
  ]);
  expect(report.window).toEqual({
    start: "2026-09-05T00:00:00.000Z",
    end: "2026-10-05T10:00:00.000Z",
  });
  expect(report.accounts[0]).toMatchObject({ volume: 250, spend: 12.5 });
});

test.each([
  [[], "no_source"],
  [[account(), account({ pricingStatus: "unavailable" })], "partial"],
  [
    [
      account({ pricingStatus: "permission_required" }),
      account({ pricingStatus: "unavailable" }),
    ],
    "reconnect",
  ],
  [[account({ pricingStatus: "unavailable" })], "unavailable"],
  [[account({ approximateSpend: null, pricing: [] })], "available"],
])("derives the overall state (%#)", (accounts, expected) => {
  const report = summarizeWhatsAppSpend({
    accounts,
    window,
    accountsTruncated: false,
  });
  expect(report.state).toBe(expected);
});

test("withheld cost or failures contribute nothing to totals", () => {
  const report = summarizeWhatsAppSpend({
    accounts: [
      account({ approximateSpend: null }),
      account({ pricingStatus: "unavailable", approximateSpend: 99 }),
    ],
    window,
    accountsTruncated: false,
  });
  expect(report.totals).toEqual([]);
  expect(report.accounts.map(row => row.spend)).toEqual([null, null]);
});

test("keeps the provider window to whole UTC days within 90 days and never in the future", () => {
  const now = new Date("2026-10-05T10:00:00Z");
  expect(
    resolveWhatsAppSpendWindow(
      new Date("2026-09-05T10:00:00Z"),
      new Date("2026-10-05T10:00:00Z"),
      now
    )
  ).toEqual({
    start: new Date("2026-09-05T00:00:00Z"),
    end: new Date("2026-10-05T10:00:00Z"),
  });
  const long = resolveWhatsAppSpendWindow(
    new Date("2026-01-01T00:00:00Z"),
    new Date("2026-12-31T00:00:00Z"),
    now
  );
  expect(long.end).toEqual(now);
  expect(long.end.getTime() - long.start.getTime()).toBeLessThanOrEqual(
    90 * 86400000
  );
  expect(long.start.getUTCHours()).toBe(0);
});

test("reads each WhatsApp Business Account once and keeps unreadable ones visible", async () => {
  mockSourcesQuery.limit.mockResolvedValue({
    data: [
      {
        id: "s1",
        name: "Main",
        workspace_id: "w",
        credentials: { wabaId: "waba-1" },
      },
      {
        id: "s2",
        name: "Second number",
        workspace_id: "w",
        credentials: { wabaId: "waba-1" },
      },
      {
        id: "s3",
        name: "Other",
        workspace_id: "w",
        credentials: { wabaId: "waba-2" },
      },
    ],
    error: null,
  });
  mockReadSpend
    .mockResolvedValueOnce(account())
    .mockRejectedValueOnce(new Error("cache down"));
  const report = await queryWhatsAppSpend({
    workspaceId: "w",
    start: new Date(Date.now() - 30 * 86400000),
    end: new Date(),
  });
  expect(mockSourcesQuery.eq).toHaveBeenCalledWith("workspace_id", "w");
  expect(mockSourcesQuery.eq).toHaveBeenCalledWith("type", "whatsapp");
  expect(mockReadSpend).toHaveBeenCalledTimes(2);
  expect(mockReadSpend.mock.calls.map(([call]) => call.source.id)).toEqual([
    "s1",
    "s3",
  ]);
  expect(report.state).toBe("partial");
  expect(report.accounts[1]).toMatchObject({
    accountKey: "waba-2",
    state: "unavailable",
  });
  expect(report.accountsTruncated).toBe(false);
});

test("a workspace without WhatsApp has no source", async () => {
  mockSourcesQuery.limit.mockResolvedValue({ data: [], error: null });
  const report = await queryWhatsAppSpend({
    workspaceId: "w",
    start: new Date(Date.now() - 86400000),
    end: new Date(),
  });
  expect(report.state).toBe("no_source");
  expect(mockReadSpend).not.toHaveBeenCalled();
});

test("a source lookup failure is an error, not an empty report", async () => {
  mockSourcesQuery.limit.mockResolvedValue({
    data: null,
    error: { message: "boom" },
  });
  await expect(
    queryWhatsAppSpend({
      workspaceId: "w",
      start: new Date(Date.now() - 86400000),
      end: new Date(),
    })
  ).rejects.toThrow("WhatsApp sources unavailable");
});
