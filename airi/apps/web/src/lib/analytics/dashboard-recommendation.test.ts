import {
  parseDashboardRecommendation,
  recommendDashboardTemplate,
  type DashboardRecommendationSignals,
} from "./dashboard-recommendation";

const established: DashboardRecommendationSignals = {
  workspaceAgeDays: 120,
  recentConversations: 30,
  metaAdsConnected: false,
  recentWhatsAppCampaigns: false,
  members: 1,
};

describe("recommendDashboardTemplate", () => {
  it.each([
    [{ workspaceAgeDays: 3 }, "starter", "new_workspace"],
    [{ workspaceAgeDays: 13.9 }, "starter", "new_workspace"],
    [{ recentConversations: 29 }, "starter", "low_volume"],
    [{ metaAdsConnected: true }, "sales", "ads_connected"],
    [{ recentWhatsAppCampaigns: true }, "sales", "recent_campaigns"],
    [{ members: 3 }, "operations", "team_size"],
    [{ members: 2 }, "support", "support_default"],
    [{}, "support", "support_default"],
  ] as const)("recommends for %j", (patch, templateId, reason) => {
    expect(recommendDashboardTemplate({ ...established, ...patch })).toEqual({
      templateId,
      reason,
    });
  });

  it("applies the rules in stage, growth, team, support order", () => {
    const everything = {
      workspaceAgeDays: 2,
      recentConversations: 0,
      metaAdsConnected: true,
      recentWhatsAppCampaigns: true,
      members: 8,
    };
    expect(recommendDashboardTemplate(everything)?.reason).toBe(
      "new_workspace"
    );
    expect(
      recommendDashboardTemplate({ ...everything, workspaceAgeDays: 40 })
        ?.reason
    ).toBe("low_volume");
    expect(
      recommendDashboardTemplate({
        ...everything,
        workspaceAgeDays: 40,
        recentConversations: 30,
      })?.reason
    ).toBe("ads_connected");
    expect(
      recommendDashboardTemplate({
        ...everything,
        workspaceAgeDays: 40,
        recentConversations: 30,
        metaAdsConnected: false,
        recentWhatsAppCampaigns: false,
      })?.reason
    ).toBe("team_size");
  });

  it("skips signals that could not be read instead of treating them as zero", () => {
    expect(
      recommendDashboardTemplate({
        ...established,
        workspaceAgeDays: null,
        recentConversations: null,
      })
    ).toEqual({ templateId: "support", reason: "support_default" });
    expect(
      recommendDashboardTemplate({
        workspaceAgeDays: null,
        recentConversations: null,
        metaAdsConnected: null,
        recentWhatsAppCampaigns: null,
        members: null,
      })
    ).toBeNull();
  });
});

describe("parseDashboardRecommendation", () => {
  it("accepts only known templates and reasons", () => {
    expect(
      parseDashboardRecommendation({
        templateId: "sales",
        reason: "ads_connected",
        extra: true,
      })
    ).toEqual({ templateId: "sales", reason: "ads_connected" });
    for (const value of [
      null,
      "sales",
      { templateId: "ecommerce", reason: "ads_connected" },
      { templateId: "sales", reason: "guess" },
    ])
      expect(parseDashboardRecommendation(value)).toBeNull();
  });
});
