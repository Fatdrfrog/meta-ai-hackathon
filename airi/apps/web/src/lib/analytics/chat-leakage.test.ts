jest.mock("@/lib/mongoose", () => ({ __esModule: true, default: jest.fn() }));
jest.mock("@/lib/crm/board", () => ({
  loadCrmPipelineStages: jest.fn(),
  loadStageEnteredAtByCustomer: jest.fn(),
}));
import { buildChatLeakageReport } from "./chat-leakage";
import { DEFAULT_CRM_PIPELINE_STAGES } from "@/lib/crm/stages";

const now = new Date("2026-10-02T12:00:00Z");
const base = {
  customerId: "customer-1",
  conversationId: "conversation-1",
  stageKey: "qualified",
  ownerId: "owner-1",
  sourceId: "source-1",
  adId: "ad-1",
  channel: "whatsapp",
  status: "open",
  lastInboundAt: "2026-09-28T12:00:00Z",
  lastOutboundAt: null,
  stageEnteredAt: "2026-09-27T12:00:00Z",
  handoffActive: true,
  category: "Sales",
  isUnread: true,
};
function report(rows = [base], filters = {}) {
  return buildChatLeakageReport({
    now,
    rows,
    stages: DEFAULT_CRM_PIPELINE_STAGES,
    qualifiedStageKeys: ["qualified"],
    policyRevision: 2,
    scannedCustomers: rows.length,
    truncated: false,
    filters,
  });
}

describe("actionable chat leakage", () => {
  it("uses CRM attention and returns the same audience that supplies its counts", () => {
    const result = report();
    expect(result.counts).toEqual({
      needsReply: 1,
      agedUnanswered: 1,
      stalled: 1,
      handoff: 1,
      ghosted: 0,
      qualifiedUnanswered: 1,
    });
    expect(result.audience[0]).toMatchObject({
      conversationId: "conversation-1",
      qualified: true,
      waitSeconds: 345600,
      attention: ["needs_reply", "stalled"],
      followUp: { kind: "take_over" },
    });
    expect(result.audienceTotal).toBe(result.counts.needsReply);
    expect(result.qualification).toEqual({
      stageKeys: ["qualified"],
      policyRevision: 2,
    });
  });
  it("excludes closed, terminal and noise conversations without relabeling won as paid", () => {
    const rows = [
      base,
      { ...base, customerId: "2", status: "closed" },
      { ...base, customerId: "3", stageKey: "won" },
      { ...base, customerId: "4", category: "Spam" },
    ];
    expect(report(rows).eligibleCustomers).toBe(1);
  });
  it("applies source, ad and owner filters before both grouping and drilldown", () => {
    const result = report([base, { ...base, customerId: "2", adId: "ad-2" }], {
      adIds: ["ad-2"],
      ownerIds: ["owner-1"],
    });
    expect(result.eligibleCustomers).toBe(1);
    expect(result.groups).toHaveLength(1);
    expect(result.audience).toHaveLength(1);
    expect(result.audience[0].adId).toBe("ad-2");
  });
  it("uses workspace stage deadlines and marks capped source coverage partial", () => {
    const result = buildChatLeakageReport({
      now,
      rows: [base],
      stages: DEFAULT_CRM_PIPELINE_STAGES.map(stage => ({
        ...stage,
        stalledAfterDays: 10,
      })),
      qualifiedStageKeys: ["proposal"],
      policyRevision: 3,
      scannedCustomers: 1000,
      truncated: true,
      filters: { kind: "stalled" },
    });
    expect(result.status).toBe("partial");
    expect(result.counts.stalled).toBe(0);
    expect(result.audience).toHaveLength(0);
    expect(result.counts.qualifiedUnanswered).toBe(0);
  });
  it("keeps organic and unassigned group drilldowns in the exact null population", () => {
    const result = report(
      [
        {
          ...base,
          customerId: "null",
          ownerId: null,
          sourceId: null,
          adId: null,
        } as unknown as typeof base,
        base,
      ],
      { ownerIds: ["__none__"], sourceIds: ["__none__"], adIds: ["__none__"] }
    );
    expect(result.eligibleCustomers).toBe(1);
    expect(result.counts.needsReply).toBe(1);
    expect(result.audience.map(row => row.customerId)).toEqual(["null"]);
  });
});
