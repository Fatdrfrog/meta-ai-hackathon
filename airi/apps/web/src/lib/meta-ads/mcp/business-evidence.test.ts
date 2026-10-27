jest.mock("@/lib/conversions/conversion-attribution", () => ({
  getConversionAttributionReport: jest.fn(),
}));
jest.mock("@/lib/analytics/acquisition-report", () => ({
  getAcquisitionReport: jest.fn(),
}));
jest.mock("@/lib/meta-ads/meta-ads-insights", () => ({
  fetchMetaAdsDashboardInsights: jest.fn(),
}));

import { getConversionAttributionReport } from "@/lib/conversions/conversion-attribution";
import { getAcquisitionReport } from "@/lib/analytics/acquisition-report";
import { fetchMetaAdsDashboardInsights } from "@/lib/meta-ads/meta-ads-insights";
import {
  collectMetaAdsMcpBusinessEvidence,
  loadMetaAdsMcpBusinessEvidence,
  resolveMetaAdsMcpBusinessPeriod,
} from "./business-evidence";

const selectedAdAccount = {
  id: "act_123",
  currency: "USD",
  timezone_name: "UTC",
};
const now = new Date("2026-10-03T12:00:00.000Z");
const window = {
  start: "2026-09-01T00:00:00.000Z",
  end: "2026-10-01T00:00:00.000Z",
  asOf: now.toISOString(),
  observationDays: 7 as const,
};
const sales = {
  rows: [
    {
      adId: "111",
      campaignId: "campaign-1",
      campaignName: "Campaign",
      currency: "USD",
      sales: 3,
      refunds: 1,
      grossRevenue: 600,
      refundedRevenue: 100,
      netRevenue: 500,
      payingCustomers: 2,
      paidConversations: 2,
    },
  ],
  recentDeliveries: [],
  truncated: false,
};
function acquisition() {
  return {
    window,
    policy: { revision: 1, qualifiedStageKeys: ["qualified"] },
    coverage: {
      status: "ready",
      projectedThrough: now.toISOString(),
      conversionThrough: now.toISOString(),
      reconciliationThrough: now.toISOString(),
      identityMissing: 0,
      truncated: false,
      qualification: "recorded_events",
      qualificationHistory: {
        state: "streaming",
        history: "since_activation",
        firstObservedAt: "2026-08-01T00:00:00.000Z",
        historyGapAt: null,
        snapshotRecovery: "complete",
        snapshotScanned: 0,
        resumePersistedAt: now.toISOString(),
      },
    },
    cohorts: [
      {
        kind: "ad",
        sourceId: "whatsapp-source",
        adId: "111",
        entries: 10,
        engaged: 8,
        qualified: 5,
        qualifiedPaid: 2,
        booked: 1,
        paid: 2,
        pendingObservation: 0,
        currencies: [
          {
            currency: "USD",
            sales: 2,
            refunds: 0,
            grossRevenue: 400,
            refundedRevenue: 0,
            netRevenue: 400,
            unknownValues: 0,
          },
        ],
      },
    ],
    flows: [],
    retention: [],
    retentionMissingIdentity: 0,
  };
}
function advertising() {
  return {
    dateStart: "2026-09-01",
    dateStop: "2026-09-30",
    resultActionType: "onsite_conversion.messaging_conversation_started_7d",
    resultLabel: "Messaging conversations started",
    totalSpend: 100,
    totalResults: 20,
    costPerResult: 5,
    currency: "USD",
    accountId: "act_123",
    accountTimezone: "UTC",
    partial: false,
    error: null,
    fetchedAt: now.toISOString(),
    accounts: [{ accountId: "act_123", currency: "USD", timeZone: "UTC" }],
    reporting: { workspaceTimeZone: "UTC" },
    warnings: [],
    topAds: [
      {
        adId: "111",
        accountId: "act_123",
        currency: "USD",
        campaignId: "campaign-1",
        spend: 100,
        results: 20,
        destination: "whatsapp",
        destinationUpdatedAt: "2026-08-01T00:00:00.000Z",
      },
    ],
  };
}
const request = {
  supabase: {} as never,
  workspaceId: "workspace",
  sourceId: "meta-source",
  selectedAdAccount,
  userMessage: "@meta report sales from 2026-09-01 to 2026-09-30",
  now,
};

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(getConversionAttributionReport).mockResolvedValue(sales);
  jest.mocked(getAcquisitionReport).mockResolvedValue(acquisition() as never);
  jest
    .mocked(fetchMetaAdsDashboardInsights)
    .mockResolvedValue(advertising() as never);
});

describe("Meta business period", () => {
  it("uses account calendar days across DST without inventing UTC dates", () => {
    expect(
      resolveMetaAdsMcpBusinessPeriod({
        userMessage: "sales 2026-03-07 to 2026-03-09",
        timeZone: "America/New_York",
        now,
      })
    ).toMatchObject({
      from: "2026-03-07",
      to: "2026-03-09",
      start: "2026-03-07T05:00:00.000Z",
      end: "2026-03-10T04:00:00.000Z",
      resolution: "explicit",
    });
  });
  it.each([
    ["last 7 days", "2026-09-26", "2026-10-02"],
    ["за последние 30 дней", "2026-09-03", "2026-10-02"],
    ["соңғы 7 күн", "2026-09-26", "2026-10-02"],
  ])("resolves a completed relative period: %s", (userMessage, from, to) => {
    expect(
      resolveMetaAdsMcpBusinessPeriod({ userMessage, timeZone: "UTC", now })
    ).toMatchObject({ from, to, resolution: "explicit" });
  });
  it("inherits an explicit period for a follow-up and labels an absent period", () => {
    expect(
      resolveMetaAdsMcpBusinessPeriod({
        userMessage: "what about sales?",
        previousUserMessages: ["report 2026-09-01 to 2026-09-30"],
        timeZone: "UTC",
        now,
      })
    ).toMatchObject({ from: "2026-09-01", resolution: "history" });
    expect(
      resolveMetaAdsMcpBusinessPeriod({
        userMessage: "sales performance",
        timeZone: "UTC",
        now,
      })
    ).toMatchObject({
      from: "2026-09-03",
      to: "2026-10-02",
      resolution: "default",
    });
  });
  it.each([
    "2026-02-30 to 2026-03-01",
    "2026-01-01 to 2026-09-30",
    "last 90 days",
    "2026-09-01",
    "all time",
    "за всё время",
    "sales in September",
  ])("leaves an unsupported/ambiguous period unavailable: %s", userMessage => {
    expect(
      resolveMetaAdsMcpBusinessPeriod({ userMessage, timeZone: "UTC", now })
    ).toBeNull();
  });
});

describe("canonical Meta business evidence", () => {
  it("joins exact verified ads and keeps financial period and cohort populations separate", async () => {
    const result = await collectMetaAdsMcpBusinessEvidence(request);
    expect(result).toMatchObject({
      status: "available",
      scope: { adAccountId: "act_123", timeZone: "UTC", currency: "USD" },
      ads: [
        {
          adId: "111",
          accountMembership: "verified",
          advertising: { spend: 100, providerResults: 20 },
          recordedSales: [{ currency: "USD", sales: 3, netRevenue: 500 }],
          acquisition: [
            {
              sourceId: "whatsapp-source",
              entries: 10,
              qualified: 5,
              paid: 2,
              qualifiedToPaidRate: 0.4,
              currencies: [{ currency: "USD", netRevenue: 400, netRoas: 4 }],
              costPerQualified: 20,
              costPerPaid: 50,
            },
          ],
        },
      ],
    });
    expect(fetchMetaAdsDashboardInsights).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace",
        sourceId: "meta-source",
        adAccountId: "act_123",
        signal: expect.any(AbortSignal),
        deadlineAt: expect.any(Number),
      })
    );
    expect(getAcquisitionReport).toHaveBeenCalledWith(
      expect.objectContaining({
        queryMaxTimeMS: 4000,
        signal: expect.any(AbortSignal),
      })
    );
    expect(getConversionAttributionReport).toHaveBeenCalledWith(
      expect.objectContaining({
        signal: expect.any(AbortSignal),
      })
    );
  });
  it("does not attribute foreign/local unmatched ads to the selected account", async () => {
    const report = advertising();
    report.topAds[0].accountId = "act_999";
    jest
      .mocked(fetchMetaAdsDashboardInsights)
      .mockResolvedValue(report as never);
    const result = await collectMetaAdsMcpBusinessEvidence(request);
    expect(result.ads).toEqual([]);
    expect(result.unmatched).toMatchObject({
      salesGroups: 1,
      acquisitionGroups: 1,
    });
    expect(result.status).toBe("partial");
  });
  it.each([
    "currency",
    "period",
    "timezone",
    "partial",
    "destination",
    "pending",
    "duplicate_cohort",
  ])(
    "withholds efficiency when evidence is not comparable: %s",
    async reason => {
      const provider = advertising();
      const cohort = acquisition();
      if (reason === "currency")
        cohort.cohorts[0].currencies[0].currency = "KZT";
      if (reason === "period") provider.dateStop = "2026-09-29";
      if (reason === "timezone") provider.accounts[0].timeZone = "Asia/Almaty";
      if (reason === "partial") provider.partial = true;
      if (reason === "destination") provider.topAds[0].destination = "other";
      if (reason === "pending") cohort.cohorts[0].pendingObservation = 1;
      if (reason === "duplicate_cohort")
        cohort.cohorts.push({
          ...cohort.cohorts[0],
          sourceId: "second-source",
        });
      jest.mocked(getAcquisitionReport).mockResolvedValue(cohort as never);
      jest
        .mocked(fetchMetaAdsDashboardInsights)
        .mockResolvedValue(provider as never);
      const result = await collectMetaAdsMcpBusinessEvidence(request);
      for (const row of result.ads.flatMap(ad => ad.acquisition)) {
        expect(row.currencies[0].netRoas).toBeNull();
        if (reason !== "currency") expect(row.costPerPaid).toBeNull();
      }
    }
  );
  it("does not turn incomplete missing observations into zero or sum distinct customers", async () => {
    const cohort = acquisition();
    cohort.coverage.status = "backfilling";
    cohort.cohorts[0].qualified = 0;
    cohort.cohorts[0].paid = 0;
    jest.mocked(getAcquisitionReport).mockResolvedValue(cohort as never);
    const result = await collectMetaAdsMcpBusinessEvidence(request);
    expect(result.ads[0].acquisition[0]).toMatchObject({
      qualified: null,
      paid: null,
      costPerPaid: null,
    });
    expect(result.ads[0].recordedSales?.[0]).toMatchObject({
      payingCustomers: 2,
    });
    expect(result.status).toBe("partial");
  });
  it("keeps failed financial reads unavailable and other evidence useful", async () => {
    jest
      .mocked(getConversionAttributionReport)
      .mockRejectedValue(new Error("private database details"));
    const result = await collectMetaAdsMcpBusinessEvidence(request);
    expect(result.coverage.sales).toBe("unavailable");
    expect(result.ads[0].recordedSales).toBeNull();
    expect(JSON.stringify(result)).not.toContain("private database details");
  });

  it("labels positive qualification observations partial when history starts inside the period", async () => {
    const cohort = acquisition();
    cohort.coverage.qualificationHistory.firstObservedAt =
      "2026-09-15T00:00:00.000Z";
    jest.mocked(getAcquisitionReport).mockResolvedValue(cohort as never);
    const result = await collectMetaAdsMcpBusinessEvidence(request);
    expect(result.ads[0].acquisition[0]).toMatchObject({
      qualified: 5,
      qualifiedToPaidRate: null,
      costPerQualified: null,
    });
    expect(result.status).toBe("partial");
    expect(result.coverage.acquisition).toBe("partial");
    expect(result.reasons).toContain("qualification_history_partial");
  });
  it("withholds historical unknown-currency money and missing groups in a truncated sales report", async () => {
    jest.mocked(getConversionAttributionReport).mockResolvedValue({
      ...sales,
      rows: [{ ...sales.rows[0], currency: "" }],
    });
    const unknownCurrency = await collectMetaAdsMcpBusinessEvidence(request);
    expect(unknownCurrency.ads[0].recordedSales?.[0]).toMatchObject({
      currency: "",
      netRevenue: null,
    });
    expect(unknownCurrency.coverage.sales).toBe("partial");
    jest
      .mocked(getConversionAttributionReport)
      .mockResolvedValue({ ...sales, rows: [], truncated: true });
    const truncated = await collectMetaAdsMcpBusinessEvidence(request);
    expect(truncated.ads[0].recordedSales).toBeNull();
  });
  it("retains the actual provider period when requested and provider scope differ", async () => {
    const provider = advertising();
    provider.dateStop = "2026-09-29";
    jest
      .mocked(fetchMetaAdsDashboardInsights)
      .mockResolvedValue(provider as never);
    const evidence = await collectMetaAdsMcpBusinessEvidence(request);
    expect(evidence.ads[0].advertising).toMatchObject({
      period: { from: "2026-09-01", to: "2026-09-29" },
      accountId: "act_123",
    });
    expect(evidence.coverage.advertising).toBe("partial");
  });
  it("does not join acquisition observations from a different window", async () => {
    const cohort = acquisition();
    cohort.window = { ...window, start: "2026-09-02T00:00:00.000Z" };
    jest.mocked(getAcquisitionReport).mockResolvedValue(cohort as never);
    const evidence = await collectMetaAdsMcpBusinessEvidence(request);
    expect(evidence.ads[0].acquisition).toEqual([]);
    expect(evidence.coverage.acquisition).toBe("partial");
    expect(evidence.reasons).toContain("acquisition_scope_mismatch");
  });
  it("does not verify account membership from an internally mismatched provider report", async () => {
    const provider = advertising();
    provider.accountId = "act_999";
    jest
      .mocked(fetchMetaAdsDashboardInsights)
      .mockResolvedValue(provider as never);
    const evidence = await collectMetaAdsMcpBusinessEvidence(request);
    expect(evidence.ads).toEqual([]);
    expect(evidence.unmatched.salesGroups).toBe(1);
    expect(evidence.reasons).toContain("provider_scope_mismatch");
  });
  it("does not turn a backfilling cohort's zero revenue into a measured zero", async () => {
    const cohort = acquisition();
    cohort.coverage.status = "backfilling";
    cohort.cohorts[0].currencies[0].netRevenue = 0;
    jest.mocked(getAcquisitionReport).mockResolvedValue(cohort as never);
    const evidence = await collectMetaAdsMcpBusinessEvidence(request);
    expect(evidence.ads[0].acquisition[0].currencies[0].netRevenue).toBeNull();
  });
  it("bounds serialized evidence by dropping complete groups and reports the omission", async () => {
    const provider = advertising();
    provider.topAds = Array.from({ length: 20 }, (_, index) => ({
      ...provider.topAds[0],
      adId: String(111 + index),
    }));
    const cohort = acquisition();
    cohort.cohorts = provider.topAds.map(ad => ({
      ...cohort.cohorts[0],
      adId: ad.adId,
    }));
    jest
      .mocked(fetchMetaAdsDashboardInsights)
      .mockResolvedValue(provider as never);
    jest.mocked(getAcquisitionReport).mockResolvedValue(cohort as never);
    const prompt = await loadMetaAdsMcpBusinessEvidence(request);
    expect(prompt.length).toBeLessThanOrEqual(6000);
    const evidence = JSON.parse(prompt.slice(prompt.indexOf("\n") + 1));
    expect(evidence.omittedAdGroups).toBeGreaterThan(0);
    expect(evidence.status).toBe("partial");
    expect(
      evidence.ads.every((ad: { adId: string }) => /^\d+$/.test(ad.adId))
    ).toBe(true);
  });
  it("does no local business reads for mutation-only requests or a different requested account", async () => {
    expect(
      await collectMetaAdsMcpBusinessEvidence({
        ...request,
        userMessage: "@meta pause campaign 123",
      })
    ).toMatchObject({ status: "not_requested" });
    expect(
      await collectMetaAdsMcpBusinessEvidence({
        ...request,
        userMessage: "@meta sales for act_999",
      })
    ).toMatchObject({ status: "unavailable" });
    expect(getConversionAttributionReport).not.toHaveBeenCalled();
  });
  it("does not collect sales merely because a mutation names a Sales campaign", async () => {
    const evidence = await collectMetaAdsMcpBusinessEvidence({
      ...request,
      userMessage: "@meta pause Sales campaign 123",
    });
    expect(evidence.status).toBe("not_requested");
    expect(getConversionAttributionReport).not.toHaveBeenCalled();
  });
  it("recognizes a comparison follow-up and leaves its unsupported dates explicit", async () => {
    const evidence = await collectMetaAdsMcpBusinessEvidence({
      ...request,
      userMessage: "@meta compare with last month",
      previousUserMessages: [request.userMessage],
    });
    expect(evidence.status).toBe("unavailable");
    expect(evidence.reasons).toContain("period_unavailable");
    expect(getConversionAttributionReport).not.toHaveBeenCalled();
  });
  it("inherits reporting intent for a referential follow-up without applying it to management", async () => {
    const followUp = await collectMetaAdsMcpBusinessEvidence({
      ...request,
      userMessage: "@meta what about that?",
      previousUserMessages: [request.userMessage],
    });
    expect(followUp.status).toBe("available");
    expect(followUp.period?.resolution).toBe("history");
    jest.clearAllMocks();
    const mutation = await collectMetaAdsMcpBusinessEvidence({
      ...request,
      userMessage: "@meta pause that campaign",
      previousUserMessages: [request.userMessage],
    });
    expect(mutation.status).toBe("not_requested");
    expect(getConversionAttributionReport).not.toHaveBeenCalled();
  });
  it("propagates user cancellation rather than describing an unavailable source", async () => {
    const controller = new AbortController();
    controller.abort(new DOMException("Stopped", "AbortError"));
    await expect(
      collectMetaAdsMcpBusinessEvidence({
        ...request,
        signal: controller.signal,
      })
    ).rejects.toThrow("Stopped");
    expect(getConversionAttributionReport).not.toHaveBeenCalled();
  });
  it("bounds stalled business readers and marks a total outage unavailable", async () => {
    const timeout = new AbortController();
    const timeoutSignal = jest
      .spyOn(AbortSignal, "timeout")
      .mockReturnValue(timeout.signal);
    jest.mocked(getAcquisitionReport).mockReturnValue(new Promise(() => {}));
    jest
      .mocked(getConversionAttributionReport)
      .mockReturnValue(new Promise(() => {}));
    jest
      .mocked(fetchMetaAdsDashboardInsights)
      .mockReturnValue(new Promise(() => {}));
    try {
      const work = collectMetaAdsMcpBusinessEvidence(request);
      expect(timeoutSignal).toHaveBeenCalledWith(12000);
      timeout.abort(new DOMException("Deadline", "TimeoutError"));
      const evidence = await work;
      expect(evidence.status).toBe("unavailable");
      expect(evidence.coverage).toEqual({
        advertising: "unavailable",
        sales: "unavailable",
        acquisition: "unavailable",
      });
      expect(evidence.reasons).toContain("collection_timeout");
    } finally {
      timeoutSignal.mockRestore();
    }
  });
  it("propagates an in-flight caller abort while readers are pending", async () => {
    const controller = new AbortController();
    jest.mocked(getAcquisitionReport).mockReturnValue(new Promise(() => {}));
    jest
      .mocked(getConversionAttributionReport)
      .mockReturnValue(new Promise(() => {}));
    jest
      .mocked(fetchMetaAdsDashboardInsights)
      .mockReturnValue(new Promise(() => {}));
    const work = collectMetaAdsMcpBusinessEvidence({
      ...request,
      signal: controller.signal,
    });
    controller.abort(new DOMException("Stopped", "AbortError"));
    await expect(work).rejects.toThrow("Stopped");
  });
});
