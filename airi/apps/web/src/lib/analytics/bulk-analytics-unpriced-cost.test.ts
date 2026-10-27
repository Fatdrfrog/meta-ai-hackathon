jest.mock("@/lib/mongoose", () => ({ __esModule: true, default: jest.fn() }));
jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: { from: jest.fn() },
}));
jest.mock("@/models/message", () => ({
  __esModule: true,
  default: { aggregate: jest.fn() },
}));

import {
  buildBulkSendSummaryFacetStages,
  normalizeBulkSendSummary,
} from "./bulk-analytics-audience";

describe("bulk send summary cost coverage", () => {
  it("projects how many delivered messages have no verified price", () => {
    const [group, project] =
      buildBulkSendSummaryFacetStages() as unknown as Array<
        Record<string, Record<string, unknown>>
      >;
    expect(group.$group.unknownCostCount).toBeDefined();
    expect(project.$project.unknownCostCount).toBe(1);
  });

  it("returns the unpriced count next to the hidden total", () => {
    const summary = normalizeBulkSendSummary({
      totalAccepted: 239,
      replied: 12,
      delivered: 239,
      estimatedCost: null,
      unknownCostCount: 239,
    });
    expect(summary).toMatchObject({
      estimatedCost: null,
      costPerReply: null,
      unknownCostCount: 239,
    });
  });

  it("reports zero unpriced messages for a fully priced window", () => {
    expect(
      normalizeBulkSendSummary({ totalAccepted: 2, estimatedCost: 0 })
        .unknownCostCount
    ).toBe(0);
  });

  it("carries no cost coverage outside campaign sends", () => {
    expect(
      normalizeBulkSendSummary(
        { totalAccepted: 2, unknownCostCount: 2 },
        { includeDeliveryEconomics: false }
      ).unknownCostCount
    ).toBeNull();
  });
});
