import {
  appendBulkAnalyticsAudienceFiltersToSearchParams,
  type BulkAnalyticsAudienceFilters,
} from "@/lib/analytics/bulk-analytics-contract";

describe("bulk analytics audience contract", () => {
  it("does not serialize removed global search and run threshold filters", () => {
    const params = new URLSearchParams();

    appendBulkAnalyticsAudienceFiltersToSearchParams(params, {
      q: "pricing",
      minRunSize: "50",
      messageContains: "discount",
      messageContainsMode: "contains",
    } as BulkAnalyticsAudienceFilters & {
      q: string;
      minRunSize: string;
    });

    expect(params.has("q")).toBe(false);
    expect(params.has("minRunSize")).toBe(false);
    expect(params.get("messageContains")).toBe("discount");
  });

  it("serializes saved filter fields for bulk analytics recipient sources", () => {
    const params = new URLSearchParams();

    appendBulkAnalyticsAudienceFiltersToSearchParams(params, {
      days: "30",
      timezone: "Asia/Qyzylorda",
      templates: ["promo_a", "promo_b"],
      campaignIds: ["campaign-1"],
      status: "not_replied",
      engagement: "low",
      conversationScope: "campaign_or_fresh",
      messageContains: "  discount  ",
      messageContainsMode: "not_contains",
      replyWindowHours: 168,
      excludeRecentClientMessageWithin24h: true,
      excludeTemplates: true,
    });

    expect(params.get("days")).toBe("30");
    expect(params.get("timezone")).toBe("Asia/Qyzylorda");
    expect(params.getAll("template")).toEqual(["promo_a", "promo_b"]);
    expect(params.getAll("campaignId")).toEqual(["campaign-1"]);
    expect(params.get("status")).toBe("not_replied");
    expect(params.get("engagement")).toBe("low");
    expect(params.get("conversationScope")).toBe("campaign_or_fresh");
    expect(params.get("messageContains")).toBe("discount");
    expect(params.get("messageContainsMode")).toBe("not_contains");
    expect(params.get("replyWindowHours")).toBe("168");
    expect(params.get("excludeRecentClientMessageWithin24h")).toBe("1");
    expect(params.get("excludeTemplates")).toBe("1");
  });

  it("preserves explicit all scope now that campaign sends is the default", () => {
    const allParams = new URLSearchParams();
    appendBulkAnalyticsAudienceFiltersToSearchParams(allParams, {
      conversationScope: "all",
    });

    expect(allParams.get("conversationScope")).toBe("all");

    const defaultParams = new URLSearchParams();
    appendBulkAnalyticsAudienceFiltersToSearchParams(defaultParams, {
      conversationScope: "campaign_sends",
    });

    expect(defaultParams.has("conversationScope")).toBe(false);
  });
});
