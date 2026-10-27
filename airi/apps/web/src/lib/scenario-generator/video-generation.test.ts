import { buildScenarioVideoGenerationPlans } from "./video-generation";

describe("buildScenarioVideoGenerationPlans", () => {
  it("generates at least three vertical video plans, repeating cohorts when needed", () => {
    const plans = buildScenarioVideoGenerationPlans({
      prompt: "Generate a VIP reactivation campaign",
      campaignName: "VIP Reactivation",
      cohorts: [
        { id: "vip", label: "VIP buyers", count: 5 },
        { id: "cold", label: "Cold leads", count: 7 },
      ],
    });

    expect(plans).toHaveLength(3);
    expect(plans.map(plan => plan.branchId)).toEqual(["vip", "cold", "vip"]);
    expect(plans[0].prompt).toContain("VIP buyers");
    expect(plans[0].prompt).toContain("9:16");
    expect(plans[0].prompt).toContain("TikTok-style");
  });

  it("caps generated plans at ten branches", () => {
    const plans = buildScenarioVideoGenerationPlans({
      prompt: "Launch a campaign",
      campaignName: "Launch",
      cohorts: Array.from({ length: 12 }, (_, index) => ({
        id: `branch-${index + 1}`,
        label: `Branch ${index + 1}`,
        count: 1,
      })),
    });

    expect(plans).toHaveLength(10);
    expect(plans.at(-1)?.branchId).toBe("branch-10");
  });
});
