import {
  activationCohortKey,
  assembleActivationWorkspaceFacts,
  buildActivationFunnelReport,
  formatActivationFunnelMarkdown,
} from "./activation-funnel-report";

const day = (iso: string) => new Date(`${iso}T12:00:00.000Z`);

describe("activation funnel report", () => {
  it("keys cohorts by ISO week (Monday) or month", () => {
    expect(activationCohortKey(day("2026-10-18"), "week")).toBe("2026-10-12");
    expect(activationCohortKey(day("2026-10-12"), "week")).toBe("2026-10-12");
    expect(activationCohortKey(day("2026-10-18"), "month")).toBe("2026-10");
  });

  it("merges every workspace of a company and keeps the first time per step", () => {
    const facts = assembleActivationWorkspaceFacts(
      [
        {
          companyId: "company-1",
          createdAt: day("2026-10-01"),
          workspaceIds: ["ws-1", "ws-2"],
          internal: false,
        },
        {
          companyId: "company-empty",
          createdAt: day("2026-10-01"),
          workspaceIds: [],
          internal: false,
        },
      ],
      [
        { workspaceId: "ws-2", step: "whatsapp", at: day("2026-10-05") },
        { workspaceId: "ws-1", step: "whatsapp", at: day("2026-10-03") },
        { workspaceId: "unknown", step: "whatsapp", at: day("2026-10-02") },
      ]
    );

    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({
      workspaceId: "ws-1",
      companyId: "company-1",
      steps: { whatsapp: day("2026-10-03") },
    });
  });

  it("counts each step with its share and median days, excluding internal companies", () => {
    const report = buildActivationFunnelReport(
      [
        {
          workspaceId: "ws-1",
          companyId: "c-1",
          createdAt: day("2026-10-01"),
          internal: false,
          steps: {
            whatsapp: day("2026-10-02"),
            campaign_accepted: day("2026-10-11"),
          },
        },
        {
          workspaceId: "ws-2",
          companyId: "c-2",
          createdAt: day("2026-10-02"),
          internal: false,
          steps: { whatsapp: day("2026-10-01") },
        },
        {
          workspaceId: "ws-3",
          companyId: "c-3",
          createdAt: day("2026-10-02"),
          internal: true,
          steps: { whatsapp: day("2026-10-02") },
        },
      ],
      { granularity: "month" }
    );

    expect(report.excludedInternal).toBe(1);
    expect(report.cohorts.map(row => row.cohort)).toEqual(["2026-10"]);
    expect(report.total.workspaces).toBe(2);
    expect(report.total.steps.whatsapp).toEqual({
      count: 2,
      share: 1,
      // 1 day and a step before creation clamped to 0 days.
      medianDays: 0.5,
    });
    expect(report.total.steps.campaign_accepted).toEqual({
      count: 1,
      share: 0.5,
      medianDays: 10,
    });
    expect(report.total.steps.scenario_active).toEqual({
      count: 0,
      share: 0,
      medianDays: null,
    });
  });

  it("formats a Markdown table with a total row", () => {
    const report = buildActivationFunnelReport(
      [
        {
          workspaceId: "ws-1",
          companyId: "c-1",
          createdAt: day("2026-10-13"),
          internal: false,
          steps: { any_channel: day("2026-10-14") },
        },
      ],
      { granularity: "week" }
    );
    const markdown = formatActivationFunnelMarkdown(report);

    expect(markdown).toContain(
      "| Week of | Workspaces | Any channel connected |"
    );
    expect(markdown).toContain("| 2026-10-12 | 1 | 1 (100%, 1 d) |");
    expect(markdown).toContain("| **Total** | 1 | 1 (100%, 1 d) |");
    expect(markdown).toContain("Internal workspaces excluded: 0.");
  });
});
