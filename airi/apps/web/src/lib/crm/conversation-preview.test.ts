import {
  formatKeyMomentLabel,
  isUsefulLeadChurn,
  isUsefulLeadPriority,
  isUsefulLeadSentiment,
  isVisibleCrmFunnelStage,
  pickKeyMomentTypes,
  pickProductEntities,
  primaryLeadContactPoint,
  resolveNamedCrmStageKey,
} from "./conversation-preview";

describe("conversation-preview", () => {
  it("picks one contact line for a lead: email, then phone, then username", () => {
    expect(
      primaryLeadContactPoint({
        emails: ["buyer@example.com"],
        phones: ["+77011234567"],
      })
    ).toBe("buyer@example.com");
    expect(
      primaryLeadContactPoint({ emails: [], phones: ["+77011234567"] })
    ).toBe("+77011234567");
    expect(primaryLeadContactPoint({ usernames: ["acme"] })).toBe("acme");
    expect(primaryLeadContactPoint({})).toBeNull();
    expect(primaryLeadContactPoint(null)).toBeNull();
  });

  it("keeps only pos/neg sentiment and high/medium churn", () => {
    expect(isUsefulLeadSentiment("positive")).toBe(true);
    expect(isUsefulLeadSentiment("neutral")).toBe(false);
    expect(isUsefulLeadChurn("high")).toBe(true);
    expect(isUsefulLeadChurn("none")).toBe(false);
    expect(isUsefulLeadPriority("medium")).toBe(true);
    expect(isUsefulLeadPriority("low")).toBe(false);
  });

  it("hides taxonomy values from the funnel badge", () => {
    expect(isVisibleCrmFunnelStage("qualified")).toBe(true);
    expect(isVisibleCrmFunnelStage("registered_business")).toBe(true);
    expect(isVisibleCrmFunnelStage("Sales")).toBe(false);
    expect(isVisibleCrmFunnelStage("Практикалық әрі тиімді баға")).toBe(false);
  });

  it("resolves i18n keys for named pipeline stages", () => {
    expect(resolveNamedCrmStageKey("qualified")).toBe("qualified");
    expect(resolveNamedCrmStageKey("stage:new")).toBe("new");
    expect(resolveNamedCrmStageKey("unassigned")).toBe("unassigned");
    expect(resolveNamedCrmStageKey("Sales")).toBeNull();
    expect(resolveNamedCrmStageKey("warm_leads")).toBeNull();
  });

  it("picks unique product and price entities", () => {
    expect(
      pickProductEntities([
        { type: "product", value: "медаль ілгіш" },
        { type: "product", value: "медаль ілгіш" },
        { type: "feature_request", value: "полка" },
        { type: "price", value: "15000" },
      ])
    ).toEqual([
      { type: "product", value: "медаль ілгіш" },
      { type: "price", value: "15000" },
    ]);
  });

  it("dedupes key moment types", () => {
    expect(
      pickKeyMomentTypes([
        { type: "price_inquiry" },
        { type: "price_inquiry" },
        { type: "objection" },
      ])
    ).toEqual(["price_inquiry", "objection"]);
    expect(formatKeyMomentLabel("price_inquiry")).toBe("price inquiry");
  });
});
