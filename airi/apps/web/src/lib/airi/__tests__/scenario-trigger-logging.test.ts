const mockTriggerLogInsertMany = jest.fn();
const mockDailyMetricBulkWrite = jest.fn();
const mockLoggerWarn = jest.fn();

jest.mock("@/models/scenario-trigger-log", () => ({
  ScenarioTriggerLog: {
    insertMany: (...args: unknown[]) => mockTriggerLogInsertMany(...args),
  },
}));

jest.mock("@/models/scenario-trigger-daily-metric", () => ({
  ScenarioTriggerDailyMetric: {
    bulkWrite: (...args: unknown[]) => mockDailyMetricBulkWrite(...args),
  },
}));

jest.mock("@/lib/airi/reply/runtime/reply-logging", () => ({
  airiOrchestrationLogger: {
    warn: (...args: unknown[]) => mockLoggerWarn(...args),
  },
}));

import { logScenarioTriggerEvaluations } from "@/lib/airi/scenario/scenario-trigger-logging";

function flushScheduledLogWrite() {
  return new Promise<void>(resolve => {
    setImmediate(resolve);
  });
}

async function flushScenarioTriggerLogBatch() {
  await flushScheduledLogWrite();
  await flushScheduledLogWrite();
}

describe("scenario trigger logging", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.SCENARIO_TRIGGER_LOG_SAMPLE_MATCHED;
    delete process.env.SCENARIO_TRIGGER_LOG_SAMPLE_UNMATCHED;
    mockTriggerLogInsertMany.mockResolvedValue(undefined);
    mockDailyMetricBulkWrite.mockResolvedValue(undefined);
  });

  afterEach(() => {
    delete process.env.SCENARIO_TRIGGER_LOG_SAMPLE_MATCHED;
    delete process.env.SCENARIO_TRIGGER_LOG_SAMPLE_UNMATCHED;
  });

  it("counts every evaluation when diagnostic sessions are sampled out", async () => {
    process.env.SCENARIO_TRIGGER_LOG_SAMPLE_MATCHED = "0";
    process.env.SCENARIO_TRIGGER_LOG_SAMPLE_UNMATCHED = "0";
    const evaluation = {
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      scenarioId: "scenario-1",
      scenarioName: "Welcome",
      evaluationId: "sampled-session",
      eventKind: "inbound_message" as const,
      evaluatedAt: new Date("2026-04-01T11:00:00.000Z"),
    };
    await logScenarioTriggerEvaluations([
      { ...evaluation, result: "trigger_mismatch", matched: false },
      { ...evaluation, result: "matched_but_shadowed", matched: false },
    ]);
    await logScenarioTriggerEvaluations([
      { ...evaluation, result: "winner", matched: true },
    ]);
    await flushScenarioTriggerLogBatch();

    expect(mockTriggerLogInsertMany).not.toHaveBeenCalled();
    expect(mockDailyMetricBulkWrite).toHaveBeenCalledWith(
      [expect.objectContaining({ updateOne: expect.objectContaining({
        update: expect.objectContaining({
          $inc: { totalCount: 3, matchedCount: 2, unmatchedCount: 1 },
        }),
      }) })],
      { ordered: false }
    );
  });

  it("keeps daily counts when inserting diagnostics fails", async () => {
    mockTriggerLogInsertMany.mockRejectedValueOnce(new Error("logs unavailable"));
    await logScenarioTriggerEvaluations([{
      workspaceId: "workspace-1", conversationId: "conversation-1",
      scenarioId: "scenario-1", scenarioName: "Welcome",
      evaluationId: "failed-diagnostics", eventKind: "inbound_message",
      result: "winner", matched: true,
      evaluatedAt: new Date("2026-04-01T11:00:00.000Z"),
    }]);
    await flushScenarioTriggerLogBatch();
    expect(mockDailyMetricBulkWrite).toHaveBeenCalledTimes(1);
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      "airi.orchestration.scenario_trigger_log",
      expect.objectContaining({ note: "persist_batch_failed" })
    );
  });

  it.each(["diagnostics", "daily metrics"] as const)(
    "coalesces new evaluations while the previous %s write is in flight",
    async slowWrite => {
      let release!: () => void;
      const pending = new Promise<void>(resolve => {
        release = resolve;
      });
      const target =
        slowWrite === "diagnostics"
          ? mockTriggerLogInsertMany
          : mockDailyMetricBulkWrite;
      target.mockReturnValueOnce(pending);
      const evaluation = {
        workspaceId: "workspace-1",
        conversationId: "conversation-1",
        scenarioId: "scenario-1",
        scenarioName: "Welcome",
        eventKind: "inbound_message" as const,
        result: "winner" as const,
        matched: true,
        evaluatedAt: new Date("2026-04-01T11:00:00.000Z"),
      };
      try {
        await logScenarioTriggerEvaluations([
          { ...evaluation, evaluationId: "first" },
        ]);
        await flushScenarioTriggerLogBatch();
        await logScenarioTriggerEvaluations([
          { ...evaluation, evaluationId: "second" },
        ]);
        await flushScenarioTriggerLogBatch();
        await logScenarioTriggerEvaluations([
          { ...evaluation, evaluationId: "third" },
        ]);
        await flushScenarioTriggerLogBatch();
        // Backpressure belongs to the logger, not the database driver.
        expect(mockTriggerLogInsertMany).toHaveBeenCalledTimes(1);
        expect(target).toHaveBeenCalledTimes(1);
      } finally {
        release();
        await flushScenarioTriggerLogBatch();
      }
      expect(
        mockTriggerLogInsertMany.mock.calls.map(([batch]) =>
          batch.map((entry: { evaluationId: string }) => entry.evaluationId)
        )
      ).toEqual([["first"], ["second", "third"]]);
      expect(
        mockDailyMetricBulkWrite.mock.calls.map(
          ([batch]) => batch[0].updateOne.update.$inc
        )
      ).toEqual([
        { totalCount: 1, matchedCount: 1, unmatchedCount: 0 },
        { totalCount: 2, matchedCount: 2, unmatchedCount: 0 },
      ]);
    }
  );

  it("flushes queued evaluations after an in-flight daily metric write fails", async () => {
    let reject!: (reason: Error) => void;
    mockDailyMetricBulkWrite.mockReturnValueOnce(
      new Promise<void>((_resolve, fail) => {
        reject = fail;
      })
    );
    const evaluation = {
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      scenarioId: "scenario-1",
      scenarioName: "Welcome",
      eventKind: "inbound_message" as const,
      result: "winner" as const,
      matched: true,
      evaluatedAt: new Date("2026-04-01T11:00:00.000Z"),
    };
    try {
      await logScenarioTriggerEvaluations([
        { ...evaluation, evaluationId: "first" },
      ]);
      await flushScenarioTriggerLogBatch();
      await logScenarioTriggerEvaluations([
        { ...evaluation, evaluationId: "queued" },
      ]);
      await flushScenarioTriggerLogBatch();
      expect(mockDailyMetricBulkWrite).toHaveBeenCalledTimes(1);
    } finally {
      reject(new Error("daily metrics unavailable"));
      await flushScenarioTriggerLogBatch();
    }
    expect(
      mockTriggerLogInsertMany.mock.calls.map(([batch]) =>
        batch.map((entry: { evaluationId: string }) => entry.evaluationId)
      )
    ).toEqual([["first"], ["queued"]]);
    expect(mockDailyMetricBulkWrite).toHaveBeenCalledTimes(2);
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      "airi.orchestration.scenario_trigger_log",
      expect.objectContaining({ note: "persist_daily_aggregates_failed" })
    );
  });

  it("derives the compatibility type for matched trigger-node metadata", async () => {
    await logScenarioTriggerEvaluations([
      {
        workspaceId: "workspace-1",
        conversationId: "conversation-1",
        scenarioId: "scenario-1",
        scenarioName: "Welcome",
        evaluationId: "evaluation-1",
        scenarioPriority: 10,
        candidateOrder: 2,
        matchingRole: "default",
        result: "matched_but_shadowed",
        winnerScenarioId: "scenario-0",
        shadowedByScenarioId: "scenario-0",
        shadowedByOrder: 1,
        eventKind: "inbound_message",
        matched: false,
        meta: { triggerNodeId: "trigger-1" },
        evaluatedAt: new Date("2026-04-01T10:00:00.000Z"),
      },
    ]);

    await flushScenarioTriggerLogBatch();

    expect(mockTriggerLogInsertMany).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          triggerType: "incoming_customer_message",
        }),
      ],
      { ordered: false }
    );
    expect(mockDailyMetricBulkWrite).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          updateOne: expect.objectContaining({
            filter: expect.objectContaining({
              triggerType: "incoming_customer_message",
            }),
            update: expect.objectContaining({
              $inc: {
                totalCount: 1,
                matchedCount: 1,
                unmatchedCount: 0,
              },
            }),
          }),
        }),
      ],
      { ordered: false }
    );
  });

  it("persists a null compatibility type when no trigger node matched", async () => {
    await logScenarioTriggerEvaluations([
      {
        workspaceId: "workspace-1",
        conversationId: "conversation-1",
        scenarioId: "scenario-1",
        scenarioName: "Welcome",
        evaluationId: "evaluation-2",
        scenarioPriority: 10,
        candidateOrder: 1,
        matchingRole: "default",
        result: "trigger_mismatch",
        eventKind: "inbound_message",
        matched: false,
        evaluatedAt: new Date("2026-04-01T11:00:00.000Z"),
      },
    ]);

    await flushScenarioTriggerLogBatch();

    expect(mockTriggerLogInsertMany).toHaveBeenCalledWith(
      [expect.objectContaining({ triggerType: null })],
      { ordered: false }
    );
    expect(mockDailyMetricBulkWrite).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          updateOne: expect.objectContaining({
            filter: expect.objectContaining({ triggerType: null }),
          }),
        }),
      ],
      { ordered: false }
    );
  });

  it("persists whatsapp_qr when QR anchor metadata is present", async () => {
    await logScenarioTriggerEvaluations([
      {
        workspaceId: "workspace-1",
        conversationId: "conversation-1",
        scenarioId: "scenario-1",
        scenarioName: "QR Door",
        evaluationId: "evaluation-3",
        scenarioPriority: 10,
        candidateOrder: 1,
        matchingRole: "default",
        result: "winner",
        eventKind: "inbound_message",
        matched: true,
        meta: {
          triggerNodeId: "qr-trigger",
          qrAnchored: true,
          entryPointType: "whatsapp_qr",
          qrIngress: { anchored: true },
        },
        evaluatedAt: new Date("2026-08-06T12:00:00.000Z"),
      },
    ]);

    await flushScenarioTriggerLogBatch();

    expect(mockTriggerLogInsertMany).toHaveBeenCalledWith(
      [expect.objectContaining({ triggerType: "whatsapp_qr" })],
      { ordered: false }
    );
  });
});
