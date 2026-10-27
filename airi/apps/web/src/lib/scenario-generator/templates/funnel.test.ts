import {
  buildCustomerFunnelTemplates,
  findStaticFunnelTemplate,
  FUNNEL_TEMPLATE_VERSION,
} from "./funnel";

const t = (key: string) => key;

describe("funnel templates", () => {
  it("builds stable workflow template seeds for Airi Create", () => {
    const templates = buildCustomerFunnelTemplates(t);

    expect(FUNNEL_TEMPLATE_VERSION).toBe("2.0.0");
    expect(templates).toHaveLength(8);
    expect(templates.map(template => template.segmentKey)).toEqual([
      "human_escalation",
      "lead_generation",
      "sales_qualified",
      "onboarding",
      "active",
      "retention",
      "churn_risk",
      "other",
    ]);
    expect(new Set(templates.map(template => template.id)).size).toBe(
      templates.length
    );
    expect(
      templates.every(
        template =>
          template.title &&
          template.description &&
          template.segmentLabel &&
          template.mainScenarioName &&
          template.recoveryScenarioName
      )
    ).toBe(true);
  });

  it("keeps human escalation as a handoff template, not a CRM segment", () => {
    const templates = buildCustomerFunnelTemplates(t);
    const humanEscalation = templates.find(
      template => template.segmentKey === "human_escalation"
    );
    const leadGeneration = templates.find(
      template => template.segmentKey === "lead_generation"
    );

    expect(humanEscalation).toMatchObject({
      kind: "handoff",
      id: "segment_human_escalation_pack",
    });
    expect(leadGeneration).toMatchObject({
      kind: "lifecycle_segment",
      id: "segment_lead_generation_funnel",
    });
  });

  it("resolves static templates by persisted id or segment key", () => {
    expect(
      findStaticFunnelTemplate({
        id: "segment_retention_funnel",
        segmentKey: null,
      })
    ).toMatchObject({
      segmentKey: "retention",
      kind: "lifecycle_segment",
    });
    expect(
      findStaticFunnelTemplate({ id: null, segmentKey: "human_escalation" })
    ).toMatchObject({
      id: "segment_human_escalation_pack",
      kind: "handoff",
    });
  });
});
