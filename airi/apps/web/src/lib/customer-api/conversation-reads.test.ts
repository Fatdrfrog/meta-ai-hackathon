import { buildCurrentConversationClassificationFilter } from "@icecore/shared/lib/conversation-classification-freshness";
import mongoose from "mongoose";
import {
  applyCustomerConversationVisibility,
  buildCustomerAnalyticsCategoryPipeline,
  resolveCustomerAnalyticsWindow,
} from "./conversation-reads";

describe("customer conversation read builders", () => {
  it("leaves the filter untouched when the plan shows every conversation", () => {
    const filter = { workspaceId: "w1" };
    expect(
      applyCustomerConversationVisibility(filter, {
        visibleConversationIds: null,
      })
    ).toBe(filter);
  });

  it("limits the filter to plan-visible ids without mutating it", () => {
    const filter = { workspaceId: "w1" };
    const id = "507f1f77bcf86cd799439011";
    expect(
      applyCustomerConversationVisibility(filter, {
        visibleConversationIds: [id],
      })
    ).toEqual({
      workspaceId: "w1",
      _id: { $in: [new mongoose.Types.ObjectId(id)] },
    });
    expect(filter).toEqual({ workspaceId: "w1" });
  });

  it("ends the analytics window at now and starts it `days` earlier", () => {
    const { start, end } = resolveCustomerAnalyticsWindow(
      7,
      new Date("2026-10-14T12:00:00.000Z")
    );
    expect(start.toISOString()).toBe("2026-10-07T12:00:00.000Z");
    expect(end.toISOString()).toBe("2026-10-14T12:00:00.000Z");
  });

  it("counts only current classifications, top 20 by default", () => {
    const pipeline = buildCustomerAnalyticsCategoryPipeline({
      workspaceId: "w1",
    });
    expect(pipeline[0]).toEqual({
      $match: {
        workspaceId: "w1",
        ...buildCurrentConversationClassificationFilter(),
      },
    });
    expect(pipeline).toContainEqual({ $limit: 20 });
    expect(
      buildCustomerAnalyticsCategoryPipeline({ workspaceId: "w1" }, 21)
    ).toContainEqual({ $limit: 21 });
  });
});
