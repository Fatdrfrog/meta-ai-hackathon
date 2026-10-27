import {
  DEFAULT_CRM_PIPELINE_STAGES,
  crmAssignedStageQueryValues,
  normalizeCrmAttentionDays,
  normalizeCrmStageKey,
  replaceStageLabel,
  resolveCrmBoardStageKey,
  validatePipelineStages,
  getEffectivePipelineStages,
} from "./stages";

describe("CRM stage helpers", () => {
  it("normalizes display names into stable stage keys", () => {
    expect(normalizeCrmStageKey(" Qualified Lead ")).toBe("qualified_lead");
    expect(normalizeCrmStageKey("Proposal / Quote")).toBe("proposal_quote");
    expect(normalizeCrmStageKey("")).toBeNull();
  });

  it("keeps the default sales pipeline stable", () => {
    expect(DEFAULT_CRM_PIPELINE_STAGES.map(stage => stage.key)).toEqual([
      "new",
      "qualified",
      "proposal",
      "won",
      "lost",
    ]);
  });

  it("replaces only stage labels while preserving other labels", () => {
    expect(replaceStageLabel(["vip", "stage:new", "priority"], "won")).toEqual([
      "vip",
      "priority",
      "stage:won",
    ]);
  });

  it("clears stage labels without dropping non-stage labels", () => {
    expect(replaceStageLabel(["stage:qualified", "vip"], null)).toEqual([
      "vip",
    ]);
  });

  it("rejects duplicate stage keys", () => {
    expect(() =>
      validatePipelineStages([
        { key: "qualified", name: "Qualified" },
        { key: "Qualified", name: "Qualified duplicate" },
      ])
    ).toThrow("Duplicate pipeline stage");
  });

  it("does not restore default stages when persisted stages are archived", () => {
    expect(
      getEffectivePipelineStages([
        {
          id: "stage-old",
          key: "old",
          name: "Old",
          color: null,
          sortOrder: 0,
          isActive: false,
          ghostedAfterDays: 3,
          stalledAfterDays: 3,
        },
      ])
    ).toEqual([]);
  });

  it("clamps attention windows to 1-90 days and defaults missing values", () => {
    expect(normalizeCrmAttentionDays(undefined)).toBe(3);
    expect(normalizeCrmAttentionDays(0)).toBe(1);
    expect(normalizeCrmAttentionDays(120)).toBe(90);

    const [stage] = validatePipelineStages([
      { name: "Hot", ghostedAfterDays: 7, stalledAfterDays: 14 },
    ]);
    expect(stage.ghostedAfterDays).toBe(7);
    expect(stage.stalledAfterDays).toBe(14);
  });

  it("parks unknown funnel values on Unassigned and keeps pipeline keys", () => {
    const assigned = new Set(["new", "qualified", "proposal", "won", "lost"]);
    expect(resolveCrmBoardStageKey("qualified", assigned)).toBe("qualified");
    expect(resolveCrmBoardStageKey("stage:new", assigned)).toBe("new");
    expect(resolveCrmBoardStageKey("Sales", assigned)).toBe("unassigned");
    expect(
      resolveCrmBoardStageKey("Практикалық әрі тиімді баға", assigned)
    ).toBe("unassigned");
    expect(crmAssignedStageQueryValues(["qualified"])).toEqual(
      expect.arrayContaining([
        "qualified",
        "stage:qualified",
        "Qualified",
        "QUALIFIED",
        " qualified ",
      ])
    );
    expect(
      crmAssignedStageQueryValues(["qualified"]).every(
        value => resolveCrmBoardStageKey(value, assigned) === "qualified"
      )
    ).toBe(true);
  });
});
