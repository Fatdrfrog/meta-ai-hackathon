const mockConnectDB = jest.fn();
const mockFindScenario = jest.fn();
const mockFindSchedule = jest.fn();
const mockFindSchedules = jest.fn();
const mockPersistSchedule = jest.fn();
const mockDescribeSchedule = jest.fn();
const mockUpdateSchedule = jest.fn();
const mockDeleteSchedule = jest.fn();
const mockLoggerInfo = jest.fn();

jest.mock("@/lib/mongoose", () => ({
  __esModule: true,
  default: () => mockConnectDB(),
}));
jest.mock("@/models/scenario", () => ({
  Scenario: { findOne: (...args: unknown[]) => mockFindScenario(...args) },
}));
jest.mock("@/models/campaign-node-schedule", () => ({
  __esModule: true,
  default: {
    findOne: (...args: unknown[]) => mockFindSchedule(...args),
    find: (...args: unknown[]) => mockFindSchedules(...args),
    findOneAndUpdate: (...args: unknown[]) => mockPersistSchedule(...args),
  },
}));
jest.mock("@/lib/temporal/client", () => ({
  isTemporalConfigured: () => true,
  getTemporalWebClientConfig: () => ({ taskQueue: "campaign-test-queue" }),
}));
jest.mock("@/lib/temporal/campaign-node-run-client", () => ({
  getTemporalScheduleClient: () => ({
    getHandle: () => ({
      describe: () => mockDescribeSchedule(),
      update: (...args: unknown[]) => mockUpdateSchedule(...args),
      delete: () => mockDeleteSchedule(),
    }),
  }),
}));
jest.mock("@icecore/airi-runtime/logging", () => ({
  airiWorkerLogger: {
    info: (...args: unknown[]) => mockLoggerInfo(...args),
    warn: jest.fn(),
  },
}));

import { campaignScheduleReconcileActivity } from "../../../../temporal-worker/src/activities/campaign-schedule-reconcile";
import { CAMPAIGN_SCHEDULE_RECONCILE_WORKFLOW_CONTRACT_VERSION } from "@icecore/temporal";
import { Types } from "mongoose";

describe("campaign schedule reconciliation activity with the production schedule owner", () => {
  const input = {
    contractVersion: CAMPAIGN_SCHEDULE_RECONCILE_WORKFLOW_CONTRACT_VERSION,
    workspaceId: "workspace-1",
    scenarioId: "000000000000000000000101",
  };
  const scenario = {
    _id: input.scenarioId,
    workspaceId: input.workspaceId,
    mode: "bulk_campaign",
    status: "active",
    timezone: "UTC",
    nodes: [
      {
        id: "scheduled",
        data: {
          channel: "whatsapp",
          scheduleConfig: {
            version: 2,
            mode: "recurring",
            timezone: "UTC",
            recurrence: { kind: "daily", time: "09:30" },
          },
        },
      },
    ],
  };

  beforeEach(() => {
    jest.resetAllMocks();
    mockConnectDB.mockResolvedValue(undefined);
    mockFindScenario.mockReturnValue({ lean: async () => scenario });
    mockFindSchedule.mockReturnValue({
      lean: async () => ({ nodeId: "scheduled", status: "active" }),
    });
    mockFindSchedules.mockReturnValue({
      lean: async () => [{ nodeId: "scheduled", status: "active" }],
    });
    mockPersistSchedule.mockReturnValue({
      lean: async () => ({ nodeId: "scheduled" }),
    });
    mockDescribeSchedule.mockResolvedValue({ state: { paused: false } });
    mockUpdateSchedule.mockResolvedValue(undefined);
    mockDeleteSchedule.mockResolvedValue(undefined);
  });

  it("rejects a provider failure so Temporal can retry and succeeds on a later attempt", async () => {
    mockUpdateSchedule.mockRejectedValueOnce(
      new Error("Temporal schedule service unavailable")
    );

    await expect(
      campaignScheduleReconcileActivity(input)
    ).rejects.toMatchObject({ name: "AggregateError" });
    expect(mockLoggerInfo).not.toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ note: "complete" })
    );
    await expect(
      campaignScheduleReconcileActivity(input)
    ).resolves.toMatchObject({
      reconciled: [
        {
          ok: true,
          scheduleId: `campaign-node:${input.workspaceId}:${input.scenarioId}:scheduled`,
        },
      ],
      orphanedDeletes: [],
    });
    expect(mockUpdateSchedule).toHaveBeenCalledTimes(2);
    expect(mockFindScenario).toHaveBeenCalledWith({
      _id: expect.objectContaining({ toHexString: expect.any(Function) }),
      workspaceId: input.workspaceId,
    });
  });

  it("reconciles a scenario whose _id Mongo returns as an ObjectId", async () => {
    mockFindScenario.mockReturnValue({
      lean: async () => ({
        ...scenario,
        _id: new Types.ObjectId(input.scenarioId),
      }),
    });

    await expect(
      campaignScheduleReconcileActivity(input)
    ).resolves.toMatchObject({
      reconciled: [
        {
          ok: true,
          scheduleId: `campaign-node:${input.workspaceId}:${input.scenarioId}:scheduled`,
        },
      ],
      orphanedDeletes: [],
    });
    expect(mockPersistSchedule).toHaveBeenCalledWith(
      {
        workspaceId: input.workspaceId,
        scenarioId: input.scenarioId,
        nodeId: "scheduled",
      },
      expect.objectContaining({
        $set: expect.objectContaining({ status: "active" }),
      }),
      expect.any(Object)
    );
  });

  it("retires a soft-deleted scenario instead of recreating paused schedules from a delayed save", async () => {
    mockFindScenario.mockReturnValue({
      lean: async () => ({
        ...scenario,
        status: "draft",
        deletedAt: new Date("2026-09-08T00:00:00Z"),
      }),
    });

    await expect(
      campaignScheduleReconcileActivity(input)
    ).resolves.toMatchObject({
      reconciled: [],
      orphanedDeletes: [{ ok: true, action: "deleted" }],
    });
    expect(mockDeleteSchedule).toHaveBeenCalledTimes(1);
    expect(mockUpdateSchedule).not.toHaveBeenCalled();
  });

  it("propagates retirement failure for a soft-deleted scenario", async () => {
    mockFindScenario.mockReturnValue({
      lean: async () => ({
        ...scenario,
        status: "draft",
        deletedAt: new Date("2026-09-08T00:00:00Z"),
      }),
    });
    mockDeleteSchedule.mockRejectedValue(
      new Error("Schedule deletion unavailable")
    );

    await expect(
      campaignScheduleReconcileActivity(input)
    ).rejects.toMatchObject({ name: "AggregateError" });
    expect(mockUpdateSchedule).not.toHaveBeenCalled();
  });

  it("preserves the empty result for a missing scenario", async () => {
    mockFindScenario.mockReturnValue({ lean: async () => null });
    await expect(campaignScheduleReconcileActivity(input)).resolves.toEqual({
      reconciled: [],
      orphanedDeletes: [],
    });
    expect(mockFindSchedules).not.toHaveBeenCalled();
    expect(mockUpdateSchedule).not.toHaveBeenCalled();
  });
});
