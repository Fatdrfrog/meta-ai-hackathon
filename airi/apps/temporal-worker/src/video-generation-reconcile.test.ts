import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  VIDEO_GENERATION_RECONCILE_SCHEDULE_CATCHUP_WINDOW_MS,
  VIDEO_GENERATION_RECONCILE_SCHEDULE_ID,
  VIDEO_GENERATION_RECONCILE_SCHEDULE_INTERVAL_MS,
  VIDEO_GENERATION_RECONCILE_RUNNING_STALE_MS,
  VIDEO_GENERATION_RECONCILE_STALE_MS,
  VIDEO_GENERATION_RECONCILE_WORKFLOW,
} from "@icecore/temporal";

import {
  reconcileVideoGenerationOrchestration,
  type VideoGenerationReconcileDependencies,
} from "./activities/video-generation-reconcile.js";
import { buildVideoGenerationReconcileScheduleOptions } from "./video-generation-reconcile-schedule.js";

const candidate = {
  id: "asset-1",
  workspaceId: "workspace-1",
  providerSourceId: "source-1",
  attemptToken: "attempt-1",
  spec: {
    contractVersion: 1 as const,
    provider: "higgsfield" as const,
    mode: "image_to_video" as const,
    skill: "video" as const,
    userPrompt: "A clean product shot",
    modelId: "higgsfield-v1",
    seed: null,
    durationSeconds: 5,
    aspectRatio: null,
    resolution: "provider_default" as const,
    sourceAssetId: "source-asset-1",
    referenceAssetIds: [] as [],
  },
  prompt: {
    compilerId: "airi-video-director" as const,
    compilerVersion: 1 as const,
    normalizedUserPrompt: "A clean product shot",
    providerPrompt: "A clean product shot. Natural product motion.",
    providerPromptSha256: "a".repeat(64),
    warnings: [],
  },
};

function candidateDocument(
  value: typeof candidate = candidate,
  lifecycle: {
    status: "queued" | "in_progress";
    orchestrationState: "pending" | "unknown" | "started";
  } = { status: "queued", orchestrationState: "pending" },
): Record<string, unknown> {
  return {
    _id: value.id,
    workspaceId: value.workspaceId,
    status: lifecycle.status,
    providerSourceId: value.providerSourceId,
    generation: {
      spec: value.spec,
      prompt: value.prompt,
      submission: { attemptToken: value.attemptToken },
      orchestration: { state: lifecycle.orchestrationState },
    },
  };
}

test("replays pending NSFW sweeps before scanning orchestration candidates", async () => {
  const events: string[] = [];
  const now = new Date("2026-07-23T12:00:00.000Z");
  const dependencies = {
    now: () => now,
    async replayPendingNsfwVerdictSweeps(input: { now: Date; limit: number }) {
      events.push("replay");
      assert.deepEqual(input, { now, limit: 100 });
      return { scanned: 1, completed: 1, failed: 0 };
    },
    async loadCandidates() {
      events.push("load");
      return [];
    },
    queues: {
      mainTaskQueue: "airi-main",
      mediaTaskQueue: "airi-media",
    },
  } as unknown as VideoGenerationReconcileDependencies;

  const result = await reconcileVideoGenerationOrchestration(
    { contractVersion: 1 },
    dependencies,
  );

  assert.deepEqual(events, ["replay", "load"]);
  assert.equal(result.scanned, 0);
});

test("quarantines a durable ancestor verdict before reconciliation starts a workflow", async () => {
  const document = candidateDocument();
  (document.generation as Record<string, unknown>).safetyAncestors = [
    {
      assetId: "parent-asset-1",
      attemptToken: "parent-attempt-1",
    },
  ];
  let started = 0;
  const quarantined: Record<string, unknown>[] = [];
  const dependencies = {
    now: () => new Date("2026-07-23T12:00:00.000Z"),
    async loadCandidates() {
      return [document];
    },
    async findNsfwSafetyVerdict() {
      return {
        providerRequestId: "unsafe-parent-request",
        sourceAssetId: "parent-asset-1",
        sourceAttemptToken: "parent-attempt-1",
      };
    },
    async markNsfwFromVerdict(input: Record<string, unknown>) {
      quarantined.push(input);
      return true;
    },
    async startWorkflow() {
      started += 1;
      return { outcome: "started", status: "RUNNING" } as const;
    },
    async markStarted() {
      return true;
    },
    async markUnknown() {
      return true;
    },
    async markTerminalFailure() {
      return true;
    },
    queues: {
      mainTaskQueue: "airi-main",
      mediaTaskQueue: "airi-media",
    },
  } as unknown as VideoGenerationReconcileDependencies;

  const result = await reconcileVideoGenerationOrchestration(
    { contractVersion: 1 },
    dependencies,
  );

  assert.equal(started, 0);
  assert.equal(result.quarantined, 1);
  assert.equal(result.started, 0);
  assert.deepEqual(quarantined, [
    {
      assetId: "asset-1",
      workspaceId: "workspace-1",
      attemptToken: "attempt-1",
      providerRequestId: "unsafe-parent-request",
      now: new Date("2026-07-23T12:00:00.000Z"),
    },
  ]);
});

test("quarantines a malformed oldest row without starving a valid row", async () => {
  const now = new Date("2026-07-22T12:00:00.000Z");
  const malformed = candidateDocument();
  delete (malformed.generation as Record<string, unknown>).prompt;
  const valid = candidateDocument({ ...candidate, id: "asset-2" });
  const started: string[] = [];
  const terminalFailures: Record<string, unknown>[] = [];
  const dependencies = {
    now: () => now,
    async loadCandidates() {
      return [malformed, valid];
    },
    async startWorkflow(input: { workflowId: string }) {
      started.push(input.workflowId);
      return { outcome: "started", status: "RUNNING" } as const;
    },
    async markStarted() {
      return true;
    },
    async markUnknown() {
      assert.fail(
        "malformed rows are validation failures, not transport errors",
      );
    },
    async markTerminalFailure(input: Record<string, unknown>) {
      terminalFailures.push(input);
      return true;
    },
    queues: {
      mainTaskQueue: "airi-main",
      mediaTaskQueue: "airi-media",
    },
  } as unknown as VideoGenerationReconcileDependencies;

  const result = await reconcileVideoGenerationOrchestration(
    { contractVersion: 1 },
    dependencies,
  );

  assert.deepEqual(started, ["video-generation:asset-2"]);
  assert.deepEqual(terminalFailures, [
    {
      assetId: "asset-1",
      workspaceId: "workspace-1",
      attemptToken: "attempt-1",
      now,
      submissionState: "unknown",
      failure: {
        phase: "validation",
        code: "orchestration_record_invalid",
        providerCode: null,
        message: "Queued video generation has incomplete orchestration data",
        retryable: false,
        submissionUncertain: true,
        failedAt: now,
      },
    },
  ]);
  assert.deepEqual(result, {
    contractVersion: 1,
    scanned: 2,
    started: 1,
    alreadyStarted: 0,
    markedStarted: 1,
    unknown: 0,
    invalid: 1,
    unscoped: 0,
    quarantined: 1,
    closed: 0,
    closedFailed: 0,
    casMisses: 0,
  });
});

test("skips unscoped corruption without blocking a later tenant-scoped row", async () => {
  const unscoped = candidateDocument();
  delete unscoped.workspaceId;
  (
    (unscoped.generation as Record<string, unknown>).orchestration as Record<
      string,
      unknown
    >
  ).completionTarget = "malformed";
  const started: string[] = [];
  const dependencies = {
    now: () => new Date("2026-07-22T12:00:00.000Z"),
    async loadCandidates() {
      return [unscoped, candidateDocument({ ...candidate, id: "asset-2" })];
    },
    async startWorkflow(input: { workflowId: string }) {
      started.push(input.workflowId);
      return { outcome: "started", status: "RUNNING" } as const;
    },
    async markStarted() {
      return true;
    },
    async markUnknown() {
      assert.fail("valid workflow start must not be marked unknown");
    },
    async markTerminalFailure() {
      assert.fail("a row without workspace ownership cannot be safely mutated");
    },
    queues: {
      mainTaskQueue: "airi-main",
      mediaTaskQueue: "airi-media",
    },
  } as unknown as VideoGenerationReconcileDependencies;

  const result = await reconcileVideoGenerationOrchestration(
    { contractVersion: 1 },
    dependencies,
  );

  assert.deepEqual(started, ["video-generation:asset-2"]);
  assert.deepEqual(result, {
    contractVersion: 1,
    scanned: 2,
    started: 1,
    alreadyStarted: 0,
    markedStarted: 1,
    unknown: 0,
    invalid: 1,
    unscoped: 1,
    quarantined: 0,
    closed: 0,
    closedFailed: 0,
    casMisses: 0,
  });
});

test("repairs a Mongo-created job whose route died before starting Temporal", async () => {
  const now = new Date("2026-07-22T12:00:00.000Z");
  const calls: Record<string, unknown>[] = [];
  const dependencies: VideoGenerationReconcileDependencies = {
    now: () => now,
    async loadCandidates(input) {
      assert.deepEqual(input, {
        query: {
          status: { $in: ["queued", "in_progress"] },
          workspaceId: { $type: "string", $ne: "", $regex: /\S/ },
          "generation.contractVersion": 1,
          $or: [
            {
              "generation.orchestration.state": {
                $in: ["pending", "unknown"],
              },
              updatedAt: {
                $lte: new Date(
                  now.getTime() - VIDEO_GENERATION_RECONCILE_STALE_MS,
                ),
              },
            },
            {
              "generation.orchestration.state": "started",
              updatedAt: {
                $lte: new Date(
                  now.getTime() - VIDEO_GENERATION_RECONCILE_RUNNING_STALE_MS,
                ),
              },
            },
          ],
        },
        projection: {
          _id: 1,
          workspaceId: 1,
          status: 1,
          providerSourceId: 1,
          "generation.spec": 1,
          "generation.prompt": 1,
          providerRequestId: 1,
          providerStatusUrl: 1,
          "generation.submission.attemptToken": 1,
          "generation.submission.state": 1,
          "generation.submission.providerRequestId": 1,
          "generation.orchestration.state": 1,
          "generation.orchestration.completionTarget": 1,
          "generation.safetyProviderRequestIds": 1,
          "generation.safetyAncestors": 1,
        },
        sort: { updatedAt: 1, _id: 1 },
        limit: 100,
      });
      return [candidateDocument()];
    },
    async startWorkflow(input) {
      calls.push(input);
      return { outcome: "started", status: "RUNNING" };
    },
    async markStarted(input) {
      calls.push({ markStarted: input });
      return true;
    },
    async touchStarted() {
      assert.fail("a pending repair must establish its first start");
    },
    async markUnknown() {
      assert.fail("successful starts must not be marked unknown");
    },
    async markTerminalFailure() {
      assert.fail("valid rows must not be quarantined");
    },
    queues: {
      mainTaskQueue: "airi-main",
      mediaTaskQueue: "airi-media",
    },
  };

  const result = await reconcileVideoGenerationOrchestration(
    { contractVersion: 1 },
    dependencies,
  );

  assert.deepEqual(result, {
    contractVersion: 1,
    scanned: 1,
    started: 1,
    alreadyStarted: 0,
    markedStarted: 1,
    unknown: 0,
    invalid: 0,
    unscoped: 0,
    quarantined: 0,
    closed: 0,
    closedFailed: 0,
    casMisses: 0,
  });
  assert.deepEqual(calls[0], {
    workflowId: "video-generation:asset-1",
    taskQueue: "airi-main",
    input: {
      contractVersion: 1,
      workspaceId: "workspace-1",
      assetId: "asset-1",
      attemptToken: "attempt-1",
      spec: candidate.spec,
      prompt: candidate.prompt,
      providerSourceId: "source-1",
      mediaTaskQueue: "airi-media",
    },
  });
});

test("reconstructs the exact private completion target during recovery", async () => {
  const document = candidateDocument();
  (
    (document.generation as Record<string, unknown>).orchestration as Record<
      string,
      unknown
    >
  ).completionTarget = {
    workflowId: "scenario-generation:workflow-1",
    signalName: "videoGenerationCompleted",
    correlationId: "execution-1",
  };
  const started: Record<string, unknown>[] = [];
  const dependencies = {
    now: () => new Date("2026-07-22T12:00:00.000Z"),
    async loadCandidates() {
      return [document];
    },
    async startWorkflow(input: Record<string, unknown>) {
      started.push(input);
      return { outcome: "started", status: "RUNNING" } as const;
    },
    async markStarted() {
      return true;
    },
    async markUnknown() {
      assert.fail("a valid target must not make workflow start ambiguous");
    },
    async markTerminalFailure() {
      assert.fail("a valid target must not be quarantined");
    },
    queues: {
      mainTaskQueue: "airi-main",
      mediaTaskQueue: "airi-media",
    },
  } as unknown as VideoGenerationReconcileDependencies;

  await reconcileVideoGenerationOrchestration(
    { contractVersion: 1 },
    dependencies,
  );

  assert.deepEqual(started, [
    {
      workflowId: "video-generation:asset-1",
      taskQueue: "airi-main",
      input: {
        contractVersion: 1,
        workspaceId: "workspace-1",
        assetId: "asset-1",
        attemptToken: "attempt-1",
        spec: candidate.spec,
        prompt: candidate.prompt,
        providerSourceId: "source-1",
        mediaTaskQueue: "airi-media",
        completionTarget: {
          workflowId: "scenario-generation:workflow-1",
          signalName: "videoGenerationCompleted",
          correlationId: "execution-1",
        },
      },
    },
  ]);
});

test("quarantines a malformed completion target without starving later recovery", async () => {
  const malformed = candidateDocument();
  (
    (malformed.generation as Record<string, unknown>).orchestration as Record<
      string,
      unknown
    >
  ).completionTarget = {
    workflowId: " scenario-generation:workflow-1",
    signalName: "videoGenerationCompleted",
    correlationId: "execution-1",
  };
  const valid = candidateDocument({ ...candidate, id: "asset-2" });
  const started: string[] = [];
  const quarantined: string[] = [];
  const dependencies = {
    now: () => new Date("2026-07-22T12:00:00.000Z"),
    async loadCandidates() {
      return [malformed, valid];
    },
    async startWorkflow(input: { workflowId: string }) {
      started.push(input.workflowId);
      return { outcome: "started", status: "RUNNING" } as const;
    },
    async markStarted() {
      return true;
    },
    async markUnknown() {
      assert.fail("validation failures must not become transport uncertainty");
    },
    async markTerminalFailure(input: { assetId: string }) {
      quarantined.push(input.assetId);
      return true;
    },
    queues: {
      mainTaskQueue: "airi-main",
      mediaTaskQueue: "airi-media",
    },
  } as unknown as VideoGenerationReconcileDependencies;

  const result = await reconcileVideoGenerationOrchestration(
    { contractVersion: 1 },
    dependencies,
  );

  assert.deepEqual(quarantined, ["asset-1"]);
  assert.deepEqual(started, ["video-generation:asset-2"]);
  assert.equal(result.invalid, 1);
  assert.equal(result.quarantined, 1);
  assert.equal(result.started, 1);
});

test("treats AlreadyStarted as success and leaves transport failures repairable", async () => {
  let calls = 0;
  const markedUnknown: string[] = [];
  const dependencies: VideoGenerationReconcileDependencies = {
    now: () => new Date("2026-07-22T12:00:00.000Z"),
    async loadCandidates() {
      return [
        candidateDocument(),
        candidateDocument({ ...candidate, id: "asset-2" }),
      ];
    },
    async startWorkflow() {
      calls += 1;
      if (calls === 1) return { outcome: "already_started", status: "RUNNING" };
      throw new Error("Temporal transport unavailable");
    },
    async markStarted() {
      return true;
    },
    async touchStarted() {
      assert.fail("pending candidates must not use the running touch path");
    },
    async markUnknown(input) {
      markedUnknown.push(input.assetId);
      return true;
    },
    async markTerminalFailure() {
      assert.fail("valid rows must not be quarantined");
    },
    queues: {
      mainTaskQueue: "airi-main",
      mediaTaskQueue: "airi-media",
    },
  };

  const result = await reconcileVideoGenerationOrchestration(
    { contractVersion: 1 },
    dependencies,
  );

  assert.deepEqual(result, {
    contractVersion: 1,
    scanned: 2,
    started: 0,
    alreadyStarted: 1,
    markedStarted: 1,
    unknown: 1,
    invalid: 0,
    unscoped: 0,
    quarantined: 0,
    closed: 0,
    closedFailed: 0,
    casMisses: 0,
  });
  assert.deepEqual(markedUnknown, ["asset-2"]);
});

test("marks a typed duplicate started only when Temporal describes it as running", async () => {
  const markedStarted: string[] = [];
  const dependencies = {
    now: () => new Date("2026-07-22T12:00:00.000Z"),
    async loadCandidates() {
      return [candidateDocument()];
    },
    async startWorkflow() {
      return { outcome: "already_started", status: "RUNNING" } as const;
    },
    async markStarted(input: { assetId: string }) {
      markedStarted.push(input.assetId);
      return true;
    },
    async markUnknown() {
      assert.fail("a described running execution is not transport-unknown");
    },
    async markTerminalFailure() {
      assert.fail("a running execution must not be terminalized");
    },
    queues: {
      mainTaskQueue: "airi-main",
      mediaTaskQueue: "airi-media",
    },
  } as unknown as VideoGenerationReconcileDependencies;

  const result = await reconcileVideoGenerationOrchestration(
    { contractVersion: 1 },
    dependencies,
  );

  assert.deepEqual(markedStarted, ["asset-1"]);
  assert.deepEqual(result, {
    contractVersion: 1,
    scanned: 1,
    started: 0,
    alreadyStarted: 1,
    markedStarted: 1,
    unknown: 0,
    invalid: 0,
    unscoped: 0,
    quarantined: 0,
    closed: 0,
    closedFailed: 0,
    casMisses: 0,
  });
});

test("terminalizes a queued asset when its duplicate Temporal execution is closed", async () => {
  const now = new Date("2026-07-22T12:00:00.000Z");
  const terminalFailures: Record<string, unknown>[] = [];
  const dependencies = {
    now: () => now,
    async loadCandidates() {
      return [candidateDocument()];
    },
    async startWorkflow() {
      return { outcome: "already_started", status: "FAILED" } as const;
    },
    async markStarted() {
      assert.fail(
        "closed executions must never promote orchestration to started",
      );
    },
    async markUnknown() {
      assert.fail("a described closed execution is not transport-unknown");
    },
    async markTerminalFailure(input: Record<string, unknown>) {
      terminalFailures.push(input);
      return true;
    },
    queues: {
      mainTaskQueue: "airi-main",
      mediaTaskQueue: "airi-media",
    },
  } as unknown as VideoGenerationReconcileDependencies;

  const result = await reconcileVideoGenerationOrchestration(
    { contractVersion: 1 },
    dependencies,
  );

  assert.deepEqual(terminalFailures, [
    {
      assetId: "asset-1",
      workspaceId: "workspace-1",
      attemptToken: "attempt-1",
      now,
      submissionState: "unknown",
      failure: {
        phase: "submit",
        code: "orchestration_workflow_closed",
        providerCode: null,
        message:
          "Temporal video generation closed before the asset reached a terminal state",
        retryable: true,
        submissionUncertain: true,
        failedAt: now,
      },
    },
  ]);
  assert.deepEqual(result, {
    contractVersion: 1,
    scanned: 1,
    started: 0,
    alreadyStarted: 1,
    markedStarted: 0,
    unknown: 0,
    invalid: 0,
    unscoped: 0,
    quarantined: 0,
    closed: 1,
    closedFailed: 1,
    casMisses: 0,
  });
});

test("preserves known submitted identity and classifies a closed workflow for safe provider-result recovery", async () => {
  const now = new Date("2026-07-22T12:00:00.000Z");
  const terminalFailures: Record<string, unknown>[] = [];
  const document = candidateDocument(candidate, {
    status: "in_progress",
    orchestrationState: "started",
  });
  document.providerRequestId = "hf-request-1";
  document.providerStatusUrl = "hf-request-1";
  (
    (document.generation as Record<string, unknown>).submission as Record<
      string,
      unknown
    >
  ).state = "submitted";
  (
    (document.generation as Record<string, unknown>).submission as Record<
      string,
      unknown
    >
  ).providerRequestId = "hf-request-1";

  const dependencies = {
    now: () => now,
    async loadCandidates() {
      return [document];
    },
    async startWorkflow() {
      return { outcome: "already_started", status: "FAILED" } as const;
    },
    async markStarted() {
      assert.fail("closed executions must not be marked started");
    },
    async touchStarted() {
      assert.fail("closed executions must not be touched as running");
    },
    async markUnknown() {
      assert.fail("a described closed execution is not transport-unknown");
    },
    async markTerminalFailure(input: Record<string, unknown>) {
      terminalFailures.push(input);
      return true;
    },
    queues: {
      mainTaskQueue: "airi-main",
      mediaTaskQueue: "airi-media",
    },
  } as unknown as VideoGenerationReconcileDependencies;

  const result = await reconcileVideoGenerationOrchestration(
    { contractVersion: 1 },
    dependencies,
  );

  assert.deepEqual(terminalFailures, [
    {
      assetId: "asset-1",
      workspaceId: "workspace-1",
      attemptToken: "attempt-1",
      now,
      submissionState: "submitted",
      providerRequestId: "hf-request-1",
      providerRequestLocator: "hf-request-1",
      failure: {
        phase: "poll",
        code: "orchestration_workflow_closed_provider_result",
        providerCode: null,
        message:
          "Temporal video generation closed after provider submission; the provider result can be recovered",
        retryable: true,
        submissionUncertain: false,
        failedAt: now,
      },
    },
  ]);
  assert.equal(result.closed, 1);
  assert.equal(result.closedFailed, 1);
});

test("terminalizes a stale started asset when terminal persistence exhausted before workflow close", async () => {
  const now = new Date("2026-07-22T12:00:00.000Z");
  const terminalFailures: Record<string, unknown>[] = [];
  const dependencies = {
    now: () => now,
    async loadCandidates() {
      return [
        candidateDocument(candidate, {
          status: "in_progress",
          orchestrationState: "started",
        }),
      ];
    },
    async startWorkflow() {
      return { outcome: "already_started", status: "FAILED" } as const;
    },
    async markStarted() {
      assert.fail("closed executions must not be marked started");
    },
    async touchStarted() {
      assert.fail("closed executions must not be touched as running");
    },
    async markUnknown() {
      assert.fail("a described closed execution is not transport-unknown");
    },
    async markTerminalFailure(input: Record<string, unknown>) {
      terminalFailures.push(input);
      return true;
    },
    queues: {
      mainTaskQueue: "airi-main",
      mediaTaskQueue: "airi-media",
    },
  } as unknown as VideoGenerationReconcileDependencies;

  const result = await reconcileVideoGenerationOrchestration(
    { contractVersion: 1 },
    dependencies,
  );

  assert.equal(terminalFailures.length, 1);
  assert.equal(result.closed, 1);
  assert.equal(result.closedFailed, 1);
});

test("touches a stale started asset after confirming its workflow is still running", async () => {
  const touched: string[] = [];
  const dependencies = {
    now: () => new Date("2026-07-22T12:00:00.000Z"),
    async loadCandidates() {
      return [
        candidateDocument(candidate, {
          status: "in_progress",
          orchestrationState: "started",
        }),
      ];
    },
    async startWorkflow() {
      return { outcome: "already_started", status: "RUNNING" } as const;
    },
    async markStarted() {
      assert.fail("an existing start timestamp must not be overwritten");
    },
    async touchStarted(input: { assetId: string }) {
      touched.push(input.assetId);
      return true;
    },
    async markUnknown() {
      assert.fail("a running execution is not transport-unknown");
    },
    async markTerminalFailure() {
      assert.fail("a running execution must not be terminalized");
    },
    queues: {
      mainTaskQueue: "airi-main",
      mediaTaskQueue: "airi-media",
    },
  } as unknown as VideoGenerationReconcileDependencies;

  const result = await reconcileVideoGenerationOrchestration(
    { contractVersion: 1 },
    dependencies,
  );

  assert.deepEqual(touched, ["asset-1"]);
  assert.equal(result.markedStarted, 1);
  assert.equal(result.casMisses, 0);
});

test("deletes late NSFW GCS media with bounded tenant-scoped version checks", async () => {
  const now = new Date("2026-07-22T12:00:00.000Z");
  const deleted: Record<string, unknown>[] = [];
  const cleared: Record<string, unknown>[] = [];
  const deferred: Record<string, unknown>[] = [];
  const nsfwDocument = (assetId: string) => ({
    _id: assetId,
    workspaceId: "workspace-1",
    bucket: "creative-assets",
    path: `workspaces/workspace-1/creative-assets/video/${assetId}/generated-video.mp4`,
    generation: { submission: { attemptToken: `attempt-${assetId}` } },
  });
  const dependencies: VideoGenerationReconcileDependencies = {
    now: () => now,
    async loadCandidates() {
      return [];
    },
    async loadNsfwCleanupCandidates(input) {
      assert.deepEqual(input, {
        query: {
          kind: "video",
          status: "nsfw",
          storageProvider: "gcs",
          workspaceId: { $type: "string", $ne: "", $regex: /\S/ },
          bucket: { $type: "string", $ne: "", $regex: /\S/ },
          path: { $type: "string", $ne: "", $regex: /\S/ },
          "generation.contractVersion": 1,
          "generation.submission.attemptToken": {
            $type: "string",
            $ne: "",
            $regex: /\S/,
          },
        },
        projection: {
          _id: 1,
          workspaceId: 1,
          bucket: 1,
          path: 1,
          "generation.submission.attemptToken": 1,
        },
        sort: { updatedAt: 1, _id: 1 },
        limit: 100,
      });
      return [
        nsfwDocument("asset-existing"),
        nsfwDocument("asset-missing"),
        nsfwDocument("asset-conflict"),
        nsfwDocument("asset-transient"),
        { _id: "asset-unscoped", bucket: "creative-assets", path: "unsafe" },
      ];
    },
    async statNsfwObject(input) {
      if (input.assetId === "asset-transient") {
        throw new Error("GCS temporarily unavailable");
      }
      if (input.assetId === "asset-missing") {
        return {
          exists: false,
          customMetadata: {},
          generation: null,
          metageneration: null,
        };
      }
      const customMetadata: Record<string, string> = {
        workspaceId: input.workspaceId,
        assetId:
          input.assetId === "asset-conflict" ? "another-asset" : input.assetId,
        attemptTokenHash: createHash("sha256")
          .update(input.attemptToken)
          .digest("hex"),
      };
      return {
        exists: true,
        customMetadata,
        generation: "7",
        metageneration: "3",
      };
    },
    async deleteNsfwObject(input) {
      deleted.push(input);
    },
    async clearNsfwStorage(input) {
      cleared.push(input);
      return ["asset-existing", "asset-conflict"].includes(input.assetId);
    },
    async deferNsfwCleanup(input) {
      deferred.push(input);
      return true;
    },
    async startWorkflow() {
      assert.fail("there are no orchestration candidates");
    },
    async markStarted() {
      assert.fail("there are no orchestration candidates");
    },
    async touchStarted() {
      assert.fail("there are no orchestration candidates");
    },
    async markUnknown() {
      assert.fail("there are no orchestration candidates");
    },
    async markTerminalFailure() {
      assert.fail("there are no orchestration candidates");
    },
    queues: {
      mainTaskQueue: "airi-main",
      mediaTaskQueue: "airi-media",
    },
  };

  const result = await reconcileVideoGenerationOrchestration(
    { contractVersion: 1 },
    dependencies,
  );

  assert.equal(result.scanned, 0);
  assert.deepEqual(deleted, [
    {
      assetId: "asset-existing",
      workspaceId: "workspace-1",
      attemptToken: "attempt-asset-existing",
      bucket: "creative-assets",
      path: "workspaces/workspace-1/creative-assets/video/asset-existing/generated-video.mp4",
      ifGenerationMatch: "7",
      ifMetagenerationMatch: "3",
    },
  ]);
  assert.deepEqual(
    cleared.sort((left, right) =>
      String(left.assetId).localeCompare(String(right.assetId)),
    ),
    [
      {
        assetId: "asset-conflict",
        workspaceId: "workspace-1",
        attemptToken: "attempt-asset-conflict",
        bucket: "creative-assets",
        path: "workspaces/workspace-1/creative-assets/video/asset-conflict/generated-video.mp4",
        now,
      },
      {
        assetId: "asset-existing",
        workspaceId: "workspace-1",
        attemptToken: "attempt-asset-existing",
        bucket: "creative-assets",
        path: "workspaces/workspace-1/creative-assets/video/asset-existing/generated-video.mp4",
        now,
      },
      {
        assetId: "asset-missing",
        workspaceId: "workspace-1",
        attemptToken: "attempt-asset-missing",
        bucket: "creative-assets",
        path: "workspaces/workspace-1/creative-assets/video/asset-missing/generated-video.mp4",
        now,
      },
    ],
  );
  assert.deepEqual(deferred, [
    {
      assetId: "asset-transient",
      workspaceId: "workspace-1",
      attemptToken: "attempt-asset-transient",
      bucket: "creative-assets",
      path: "workspaces/workspace-1/creative-assets/video/asset-transient/generated-video.mp4",
      now,
    },
  ]);
});

test("preserves a concurrent winner when closed-execution terminalization loses its CAS", async () => {
  const dependencies = {
    now: () => new Date("2026-07-22T12:00:00.000Z"),
    async loadCandidates() {
      return [candidateDocument()];
    },
    async startWorkflow() {
      return { outcome: "already_started", status: "TIMED_OUT" } as const;
    },
    async markStarted() {
      assert.fail("closed executions must never be marked started");
    },
    async markUnknown() {
      assert.fail("a CAS miss means another Mongo state won, not uncertainty");
    },
    async markTerminalFailure() {
      return false;
    },
    queues: {
      mainTaskQueue: "airi-main",
      mediaTaskQueue: "airi-media",
    },
  } as unknown as VideoGenerationReconcileDependencies;

  const result = await reconcileVideoGenerationOrchestration(
    { contractVersion: 1 },
    dependencies,
  );

  assert.deepEqual(result, {
    contractVersion: 1,
    scanned: 1,
    started: 0,
    alreadyStarted: 1,
    markedStarted: 0,
    unknown: 0,
    invalid: 0,
    unscoped: 0,
    quarantined: 0,
    closed: 1,
    closedFailed: 0,
    casMisses: 1,
  });
});

test("schedules one bounded reconciliation run per minute on the main queue", () => {
  const options = buildVideoGenerationReconcileScheduleOptions({
    taskQueue: "airi-main",
  });

  assert.equal(options.scheduleId, VIDEO_GENERATION_RECONCILE_SCHEDULE_ID);
  assert.deepEqual(options.spec, {
    intervals: [{ every: VIDEO_GENERATION_RECONCILE_SCHEDULE_INTERVAL_MS }],
  });
  assert.equal(options.action.type, "startWorkflow");
  if (options.action.type !== "startWorkflow") return;
  assert.equal(
    options.action.workflowType,
    VIDEO_GENERATION_RECONCILE_WORKFLOW,
  );
  assert.equal(options.action.taskQueue, "airi-main");
  assert.deepEqual(options.action.args, [{ contractVersion: 1 }]);
  assert.equal(options.policies?.overlap, "SKIP");
  assert.equal(
    options.policies?.catchupWindow,
    VIDEO_GENERATION_RECONCILE_SCHEDULE_CATCHUP_WINDOW_MS,
  );
});

test("registers reconciliation without displacing generation or retained workflows", () => {
  const root = dirname(fileURLToPath(import.meta.url));
  const index = readFileSync(join(root, "workflows", "index.ts"), "utf8");
  const worker = readFileSync(join(root, "worker.ts"), "utf8");
  const replay = readFileSync(join(root, "export-replay-histories.ts"), "utf8");

  assert.match(index, /videoGenerationReconcileWorkflow/);
  assert.match(index, /videoGenerationWorkflow/);
  assert.match(worker, /VIDEO_GENERATION_RECONCILE_ACTIVITY/);
  assert.match(worker, /ensureVideoGenerationReconcileSchedule/);
  assert.match(replay, /VIDEO_GENERATION_RECONCILE_WORKFLOW/);
  assert.match(replay, /VIDEO_GENERATION_WORKFLOW/);
  assert.match(replay, /HAPPYHORSE_VIDEO_WORKFLOW/);
  assert.match(replay, /HIGGSFIELD_ASSET_GENERATION_WORKFLOW/);
});
