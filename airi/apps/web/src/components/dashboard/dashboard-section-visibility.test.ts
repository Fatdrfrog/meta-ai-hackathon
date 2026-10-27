import type {
  AdvertisementAnalytics,
  InternalLabelAnalytics,
} from "@/types/dashboard";
import {
  hasAdvertisementData,
  hasInternalLabelData,
} from "./dashboard-section-visibility";

const advertisement = (): AdvertisementAnalytics => ({
  totalConversations: 0,
  uniqueSources: 0,
  respondedConversations: 0,
  closedConversations: 0,
  responseRate: 0,
  closeRate: 0,
  topSources: [],
  bySourceType: [],
  dailyCounts: [],
});

const labels = (): InternalLabelAnalytics => ({
  taggedConversations: 0,
  unlabeledConversations: 0,
  uniqueLabels: 0,
  totalAssignments: 0,
  availableLabels: [],
  topLabels: [],
});

describe("dashboard section visibility", () => {
  it("keeps recorded sales and reporting failures visible without ad conversations", () => {
    expect(
      hasAdvertisementData({
        ...advertisement(),
        conversionAttributionError: "unavailable",
      })
    ).toBe(true);
    expect(
      hasAdvertisementData({
        ...advertisement(),
        conversionAttribution: {
          rows: [
            {
              adId: null,
              campaignId: null,
              campaignName: null,
              currency: "KZT",
              sales: 1,
              refunds: 0,
              grossRevenue: 50,
              refundedRevenue: 0,
              netRevenue: 50,
              payingCustomers: 0,
              paidConversations: 1,
            },
          ],
          recentDeliveries: [],
          truncated: false,
        },
      })
    ).toBe(true);
    expect(
      hasAdvertisementData({
        ...advertisement(),
        conversionAttribution: {
          rows: [],
          recentDeliveries: [],
          truncated: false,
        },
      })
    ).toBe(false);
  });
  it("keeps Meta provider errors visible without captured referrals", () => {
    expect(
      hasAdvertisementData({
        ...advertisement(),
        metaInsights: {
          dateStart: "2026-07-01",
          dateStop: "2026-07-31",
          resultActionType: "messages",
          resultLabel: "Messages",
          totalResults: 0,
          totalSpend: 0,
          costPerResult: null,
          sourceCount: 0,
          accountCount: 0,
          partial: false,
          error: "Provider error",
          fetchedAt: "2026-08-01T00:00:00.000Z",
          dailyCounts: [],
          topAds: [],
        },
      })
    ).toBe(true);
    expect(hasAdvertisementData(advertisement())).toBe(false);
  });

  it("shows internal labels only for tagged conversations", () => {
    expect(hasInternalLabelData(labels())).toBe(false);
    expect(hasInternalLabelData({ ...labels(), taggedConversations: 1 })).toBe(
      true
    );
  });
});
