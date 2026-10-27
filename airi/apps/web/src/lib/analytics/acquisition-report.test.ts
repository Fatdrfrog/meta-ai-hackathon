const mockPolicy = jest.fn();
const mockStageCoverage = jest.fn();
const mockEntryAggregate = jest.fn();
const mockPurchaseAggregate = jest.fn();
const mockFlowAggregate = jest.fn();
const mockCount = jest.fn();
const mockCheckpoints = jest.fn();
jest.mock("./analytics-policy", () => ({
  getAnalyticsPolicy: (...args: unknown[]) => mockPolicy(...args),
}));
jest.mock("./customer-stage-consumer", () => ({
  readCustomerStageCoverage: (...args: unknown[]) => mockStageCoverage(...args),
}));
jest.mock("@/models/message", () => ({
  __esModule: true,
  default: { collection: { name: "messages" } },
}));
jest.mock("@/models/customer-event", () => ({
  __esModule: true,
  default: { collection: { name: "customer_events" } },
}));
jest.mock("@/models/scenario-flow-event", () => ({
  ScenarioFlowEvent: {
    collection: { name: "scenario_flow_events" },
    aggregate: (...args: unknown[]) => mockFlowAggregate(...args),
  },
}));
jest.mock("@/models/analytics-acquisition", () => ({
  AnalyticsAcquisitionEntry: {
    collection: { name: "entries" },
    aggregate: (...args: unknown[]) => mockEntryAggregate(...args),
  },
  AnalyticsAcquisitionCheckpoint: {
    find: (...args: unknown[]) => mockCheckpoints(...args),
  },
  AnalyticsConversionFact: {
    collection: { name: "conversions" },
    countDocuments: (...args: unknown[]) => mockCount(...args),
  },
  AnalyticsCustomerPurchaseObservation: {
    aggregate: (...args: unknown[]) => mockPurchaseAggregate(...args),
  },
}));
import type { PipelineStage } from "mongoose";
import {
  ACQUISITION_STALE_AFTER_MS,
  getAcquisitionReport,
} from "./acquisition-report";

const now = new Date("2026-10-04T20:00:00Z");
const request = {
  workspaceId: "workspace",
  start: new Date("2026-09-01"),
  end: new Date("2026-10-01"),
  observationDays: 7 as const,
  now,
};
function aggregate(result: unknown) {
  return {
    allowDiskUse: jest.fn().mockReturnThis(),
    option: jest.fn().mockResolvedValue(result),
  };
}
function checkpoints(through: Date) {
  const rows = [
    ...["messages", "conversations", "conversions"].map(stream => ({
      stream,
      fence: 1,
      through,
    })),
    ...[
      "messages_reconciliation",
      "conversations_reconciliation",
      "conversions_reconciliation",
    ].map(stream => ({
      stream,
      fence: 1,
      through: null,
      reconcileThrough: through,
    })),
  ];
  mockCheckpoints.mockReturnValue({
    select: jest.fn().mockReturnThis(),
    setOptions: jest.fn().mockReturnThis(),
    lean: jest.fn().mockResolvedValue(rows),
  });
}
beforeEach(() => {
  jest.clearAllMocks();
  mockPolicy.mockResolvedValue({
    revision: 1,
    qualifiedStageKeys: ["qualified"],
  });
  mockStageCoverage.mockResolvedValue({ state: "streaming" });
  checkpoints(now);
  mockEntryAggregate.mockReturnValue(aggregate([]));
  mockPurchaseAggregate.mockReturnValue(aggregate([]));
  mockFlowAggregate.mockReturnValue(aggregate([]));
  mockCount.mockReturnValue({
    setOptions: jest.fn().mockReturnThis(),
    maxTimeMS: jest.fn().mockResolvedValue(0),
  });
});

describe("projection freshness", () => {
  it("stays ready while the collector is within its normal round", async () => {
    // A healthy collector returns to each workspace about every 48 minutes.
    checkpoints(new Date(now.getTime() - 48 * 60_000));
    const report = await getAcquisitionReport(request);
    expect(report.coverage).toMatchObject({
      status: "ready",
      projectedThrough: "2026-10-04T19:12:00.000Z",
    });
  });

  it("is ready at exactly the stale threshold and stale one millisecond later", async () => {
    checkpoints(new Date(now.getTime() - ACQUISITION_STALE_AFTER_MS));
    expect((await getAcquisitionReport(request)).coverage.status).toBe("ready");
    checkpoints(new Date(now.getTime() - ACQUISITION_STALE_AFTER_MS - 1));
    expect((await getAcquisitionReport(request)).coverage.status).toBe("stale");
  });
});

describe("flow outcome joins", () => {
  const lookups = () =>
    (mockFlowAggregate.mock.calls[0][0] as PipelineStage[]).flatMap(stage =>
      "$lookup" in stage ? [stage.$lookup] : []
    );

  it("joins delivery by provider id on the indexed WhatsApp outbound messages", async () => {
    await getAcquisitionReport(request);
    const delivery = lookups().find(lookup => lookup.from === "messages");
    expect(delivery).toMatchObject({
      localField: "_id.message",
      foreignField: "messageId",
      as: "delivery",
    });
    expect(delivery).not.toHaveProperty("let");
    expect(delivery?.pipeline?.[0]).toEqual({
      $match: {
        workspaceId: "workspace",
        channel: "whatsapp",
        direction: "outbound",
        messageId: { $type: "string" },
      },
    });
  });

  it("joins qualification by conversation on the indexed stage events", async () => {
    await getAcquisitionReport(request);
    const qualification = lookups().find(
      lookup => lookup.from === "customer_events"
    );
    expect(qualification).toMatchObject({
      localField: "conversationObjectId",
      foreignField: "conversationId",
      as: "qualification",
    });
    expect(qualification?.pipeline?.[0]).toMatchObject({
      $match: {
        workspaceId: "workspace",
        conversationId: { $type: "objectId" },
        type: { $in: ["stage_changed", "stage_snapshot"] },
        "payload.stage": { $in: ["qualified"] },
      },
    });
  });
});

describe("caller cancellation", () => {
  const cancellableRequest = { ...request, now: new Date("2026-10-03") };

  beforeEach(() => {
    mockStageCoverage.mockResolvedValue({ state: "not_started" });
    mockCheckpoints.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      setOptions: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue([]),
    });
  });

  it("does not start an acquisition query after caller cancellation", async () => {
    const controller = new AbortController();
    controller.abort(new DOMException("Stopped", "AbortError"));
    await expect(
      getAcquisitionReport({ ...cancellableRequest, signal: controller.signal })
    ).rejects.toThrow("Stopped");
    expect(mockPolicy).not.toHaveBeenCalled();
    expect(mockEntryAggregate).not.toHaveBeenCalled();
  });

  it("stops between readers when cancellation occurs during policy retrieval", async () => {
    const controller = new AbortController();
    mockPolicy.mockReturnValue(new Promise(() => {}));
    const result = getAcquisitionReport({
      ...cancellableRequest,
      signal: controller.signal,
    });
    controller.abort(new DOMException("Stopped", "AbortError"));
    await expect(result).rejects.toThrow("Stopped");
    expect(mockStageCoverage).not.toHaveBeenCalled();
    expect(mockEntryAggregate).not.toHaveBeenCalled();
  });

  it("passes the bounded query budget and caller signal to all financial/cohort aggregates", async () => {
    const controller = new AbortController();
    await getAcquisitionReport({
      ...cancellableRequest,
      signal: controller.signal,
      queryMaxTimeMS: 4000,
    });
    for (const query of [
      mockEntryAggregate,
      mockPurchaseAggregate,
      mockFlowAggregate,
    ]) {
      expect(query.mock.results[0].value.option).toHaveBeenCalledWith({
        maxTimeMS: 4000,
        signal: controller.signal,
      });
    }
    expect(mockCount.mock.results[0].value.maxTimeMS).toHaveBeenCalledWith(
      4000
    );
  });
});

describe("retention calendar", () => {
  const cohortMonth = () =>
    JSON.stringify(mockPurchaseAggregate.mock.calls[0][0]).match(
      /"cohortMonth":\{"\$dateToString":\{[^}]*"timezone":"([^"]+)"/
    )?.[1];

  it("groups first purchases by month in the viewer's time zone", async () => {
    await getAcquisitionReport({ ...request, timeZone: "Asia/Almaty" });
    expect(cohortMonth()).toBe("Asia/Almaty");
  });

  it("keeps UTC months for callers without a time zone", async () => {
    await getAcquisitionReport(request);
    expect(cohortMonth()).toBe("UTC");
  });
});
