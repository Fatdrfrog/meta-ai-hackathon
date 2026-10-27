import {
  LANDING_CAMPAIGN_RECIPIENTS,
  LANDING_CAMPAIGN_SAMPLE,
  LANDING_REVENUE_SAMPLES,
  LANDING_CONVERSATION_SAMPLES,
  LANDING_META_ADS_SAMPLE,
  LANDING_AD_CONVERSATIONS,
  LANDING_CAMPAIGN_REPORT,
  LANDING_RESPONSE_SAMPLE,
  LANDING_MONTHLY_ATTRIBUTION,
} from "./landing-workflow-sample";
import {
  HERO_WORKFLOW_COLUMNS,
  HERO_WORKFLOWS,
} from "./hero-workflow-definitions";
import { createLandingNumberFormatters } from "./landing-number-formatters";

describe("Landing business examples", () => {
  it("keeps monthly attributed sales below store totals and reconciles net revenue with refunds", () => {
    expect(LANDING_MONTHLY_ATTRIBUTION.map(row => row.month)).toEqual([
      "jan",
      "feb",
      "mar",
      "apr",
      "may",
      "jun",
    ]);
    for (const row of LANDING_MONTHLY_ATTRIBUTION) {
      expect(row.sales).toBeLessThanOrEqual(row.conversations);
      expect(row.netRevenue + row.refundedRevenue).toBe(row.grossRevenue);
      expect(row.spend).toBeGreaterThan(0);
    }
    const june = LANDING_MONTHLY_ATTRIBUTION.at(-1)!;
    expect(june.spend).toBe(LANDING_META_ADS_SAMPLE.totalSpend);
    expect(june.conversations).toBe(LANDING_AD_CONVERSATIONS);
    expect(june.sales).toBeLessThan(LANDING_REVENUE_SAMPLES.month.sales);
    expect(june.grossRevenue).toBeLessThan(
      LANDING_REVENUE_SAMPLES.month.grossRevenue
    );
    expect(june.netRevenue).toBe(414000);
  });
  it.each(["kz"])(
    "keeps %s numeric separators and percent spacing stable across ICU versions",
    locale => {
      const format = createLandingNumberFormatters(locale);
      expect(format.integer(1240)).toBe("1\u00a0240");
      expect(format.signedPercent(33.3333, 1)).toBe("+33,3\u00a0%");
    }
  );
  it("reconciles the selected audience and mutually exclusive exclusions", () => {
    expect(LANDING_CAMPAIGN_RECIPIENTS).toBe(1240);
    expect(
      LANDING_CAMPAIGN_RECIPIENTS +
        LANDING_CAMPAIGN_SAMPLE.purchased +
        LANDING_CAMPAIGN_SAMPLE.unsubscribed
    ).toBe(LANDING_CAMPAIGN_SAMPLE.selected);
  });
  it.each(Object.entries(LANDING_REVENUE_SAMPLES))(
    "reconciles %s sales and refunds",
    (_period, sample) => {
      expect(sample.grossRevenue).toBeGreaterThan(sample.refundedRevenue);
      expect(sample.payingCustomers).toBeLessThanOrEqual(sample.sales);
      expect(sample.currency).toBe("KZT");
      expect(sample).not.toHaveProperty("previousNetRevenue");
    }
  );
  it.each(["month", "week"] as const)(
    "uses adjacent, equal-length %s conversation periods with nonnegative daily counts",
    period => {
      const { current, previous } = LANDING_CONVERSATION_SAMPLES[period];
      for (const points of [current, previous]) {
        expect(points).toHaveLength(period === "month" ? 30 : 7);
        for (const [index, point] of points.entries()) {
          expect(Number.isInteger(point.total)).toBe(true);
          expect(point.total).toBeGreaterThanOrEqual(0);
          if (index > 0)
            expect(
              Date.parse(point.date) - Date.parse(points[index - 1].date)
            ).toBe(86400000);
        }
      }
      expect(
        Date.parse(current[0].date) - Date.parse(previous.at(-1)!.date)
      ).toBe(86400000);
    }
  );
  it("keeps the shorter conversation sample consistent with the month", () => {
    const { month, week } = LANDING_CONVERSATION_SAMPLES;
    expect(week.current).toEqual(month.current.slice(-7));
    expect(week.previous).toEqual(month.current.slice(-14, -7));
  });
  it("reconciles Meta spend, messaging results and per-result costs without treating captured chats as the same count", () => {
    const ads = LANDING_META_ADS_SAMPLE;
    expect(ads.topAds.reduce((sum, ad) => sum + ad.spend, 0)).toBe(
      ads.totalSpend
    );
    expect(ads.topAds.reduce((sum, ad) => sum + ad.results, 0)).toBe(
      ads.totalResults
    );
    expect(ads.totalSpend / ads.totalResults).toBeCloseTo(ads.costPerResult);
    for (const ad of ads.topAds)
      expect(ad.spend / ad.results).toBeCloseTo(ad.costPerResult);
    expect(ads.currency).toBe("USD");
    expect(ads.currency).not.toBe(LANDING_REVENUE_SAMPLES.month.currency);
    expect(LANDING_AD_CONVERSATIONS).not.toBe(ads.totalResults);
  });
  it("uses the campaign audience for observed outcomes and reconciles estimated reply cost", () => {
    const campaign = LANDING_CAMPAIGN_REPORT;
    expect(campaign.totalAccepted).toBe(LANDING_CAMPAIGN_RECIPIENTS);
    expect(campaign.delivered).toBeLessThanOrEqual(campaign.totalAccepted);
    expect(campaign.read).toBeLessThanOrEqual(campaign.delivered);
    expect(campaign.replied).toBeLessThanOrEqual(campaign.totalAccepted);
    expect(campaign.estimatedCost / campaign.replied).toBeCloseTo(
      campaign.costPerReply
    );
    expect(LANDING_RESPONSE_SAMPLE.medianSeconds).toBeLessThanOrEqual(
      LANDING_RESPONSE_SAMPLE.p90Seconds
    );
  });
  it("puts revenue first in the right column while retaining quality in the explorer", () => {
    expect(HERO_WORKFLOW_COLUMNS[1][0].id).toBe("analytics");
    expect(HERO_WORKFLOW_COLUMNS.flat().map(item => item.id)).not.toContain(
      "meta"
    );
    expect(HERO_WORKFLOWS.some(item => item.id === "meta")).toBe(true);
    expect(new Set(HERO_WORKFLOWS.map(item => item.id)).size).toBe(9);
  });
});
