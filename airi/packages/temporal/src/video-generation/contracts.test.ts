import assert from "node:assert/strict";
import test from "node:test";
import * as videoGenerationContracts from "./contracts.js";
import {
  VIDEO_GENERATION_POLL_POLICIES,
  VIDEO_GENERATION_WORKFLOW,
  buildVideoGenerationWorkflowId,
  normalizeVideoGenerationCompletionTarget,
  selectVideoGenerationSettledStatus,
  selectVideoGenerationTerminalStatus,
  selectVideoGenerationWebhookTerminalStatus,
} from "./contracts.js";

test("normalizes only bounded exact video completion targets", () => {
  assert.deepEqual(
    normalizeVideoGenerationCompletionTarget({
      workflowId: "scenario-generation:workflow-1",
      signalName: "videoGenerationCompleted",
      correlationId: "execution-1",
    }),
    {
      workflowId: "scenario-generation:workflow-1",
      signalName: "videoGenerationCompleted",
      correlationId: "execution-1",
    },
  );
  assert.equal(normalizeVideoGenerationCompletionTarget(null), null);
  assert.throws(
    () =>
      normalizeVideoGenerationCompletionTarget({
        workflowId: " scenario-generation:workflow-1",
        signalName: "videoGenerationCompleted",
        correlationId: "execution-1",
      }),
    /workflowId/,
  );
  assert.throws(
    () =>
      normalizeVideoGenerationCompletionTarget({
        workflowId: "w".repeat(513),
        signalName: "videoGenerationCompleted",
        correlationId: "execution-1",
      }),
    /workflowId/,
  );
});

test("normalizes only the bounded allowlisted video completion result", () => {
  const normalizeVideoGenerationCompletionResult = (
    videoGenerationContracts as typeof videoGenerationContracts & {
      normalizeVideoGenerationCompletionResult?: (
        value: unknown,
      ) => Record<string, unknown>;
    }
  ).normalizeVideoGenerationCompletionResult;
  assert.equal(typeof normalizeVideoGenerationCompletionResult, "function");
  assert.deepEqual(
    normalizeVideoGenerationCompletionResult?.({
      contractVersion: 1,
      correlationId: "execution-1",
      assetId: "asset-1",
      attemptToken: "attempt-1",
      terminal: "complete",
      code: "generation_complete",
    }),
    {
      contractVersion: 1,
      correlationId: "execution-1",
      assetId: "asset-1",
      attemptToken: "attempt-1",
      terminal: "complete",
      code: "generation_complete",
    },
  );
  for (const terminal of ["complete", "failed", "unsafe", "timeout"] as const) {
    assert.equal(
      normalizeVideoGenerationCompletionResult?.({
        contractVersion: 1,
        correlationId: "execution-1",
        assetId: "asset-1",
        attemptToken: "attempt-1",
        terminal,
        code: terminal === "timeout" ? "provider_timeout" : "generation_failed",
      }).terminal,
      terminal,
    );
  }
});

test("rejects malformed or non-allowlisted video completion result data", () => {
  const normalizeVideoGenerationCompletionResult = (
    videoGenerationContracts as typeof videoGenerationContracts & {
      normalizeVideoGenerationCompletionResult?: (
        value: unknown,
      ) => Record<string, unknown>;
    }
  ).normalizeVideoGenerationCompletionResult;
  const isVideoGenerationCompletionCode = (
    videoGenerationContracts as typeof videoGenerationContracts & {
      isVideoGenerationCompletionCode?: (value: unknown) => boolean;
    }
  ).isVideoGenerationCompletionCode;
  assert.equal(typeof normalizeVideoGenerationCompletionResult, "function");
  assert.equal(typeof isVideoGenerationCompletionCode, "function");
  assert.equal(isVideoGenerationCompletionCode?.("provider_timeout"), true);
  assert.equal(isVideoGenerationCompletionCode?.("x".repeat(100)), true);
  assert.equal(isVideoGenerationCompletionCode?.("Provider Error"), false);
  assert.equal(isVideoGenerationCompletionCode?.("x".repeat(101)), false);
  const valid = {
    contractVersion: 1,
    correlationId: "execution-1",
    assetId: "asset-1",
    attemptToken: "attempt-1",
    terminal: "failed",
    code: "generation_failed",
  } as const;

  assert.throws(
    () =>
      normalizeVideoGenerationCompletionResult?.({
        ...valid,
        prompt: "must never enter workflow signaling",
      }),
    /fields/,
  );
  assert.throws(
    () =>
      normalizeVideoGenerationCompletionResult?.({
        ...valid,
        correlationId: "x".repeat(129),
      }),
    /correlationId/,
  );
  assert.throws(
    () =>
      normalizeVideoGenerationCompletionResult?.({
        ...valid,
        assetId: "x".repeat(129),
      }),
    /assetId/,
  );
  assert.throws(
    () =>
      normalizeVideoGenerationCompletionResult?.({
        ...valid,
        attemptToken: "x".repeat(129),
      }),
    /attemptToken/,
  );
  assert.throws(
    () =>
      normalizeVideoGenerationCompletionResult?.({
        ...valid,
        code: "Provider Error",
      }),
    /code/,
  );
  assert.throws(
    () =>
      normalizeVideoGenerationCompletionResult?.({
        ...valid,
        terminal: "cancelled",
      }),
    /terminal/,
  );
});

test("uses a new stable workflow identity", () => {
  assert.equal(VIDEO_GENERATION_WORKFLOW, "videoGenerationWorkflow");
  assert.equal(
    buildVideoGenerationWorkflowId({ assetId: "asset / 1" }),
    "video-generation:asset-1",
  );
});

test("bounds provider polling without keeping an activity occupied", () => {
  assert.deepEqual(VIDEO_GENERATION_POLL_POLICIES, {
    happyhorse: {
      intervalMs: 15_000,
      maxPolls: 100,
      deadlineMs: 25 * 60_000,
      continueAsNewEvery: null,
    },
    google: {
      intervalMs: 10_000,
      maxPolls: 180,
      deadlineMs: 30 * 60_000,
      continueAsNewEvery: null,
    },
    higgsfield: {
      intervalMs: 5 * 60_000,
      maxPolls: 288,
      deadlineMs: 24 * 60 * 60_000,
      continueAsNewEvery: 100,
    },
  });
});

test("selects the safest terminal result after a poll settles", () => {
  assert.equal(
    selectVideoGenerationTerminalStatus(["completed", "nsfw"]),
    "nsfw",
  );
  assert.equal(
    selectVideoGenerationTerminalStatus(["failed", "cancelled", "completed"]),
    "completed",
  );
  assert.equal(
    selectVideoGenerationSettledStatus({
      signalStatuses: [],
      pollResult: {
        status: "failed",
        terminal: true,
        providerStatus: "cancelled",
      },
    }),
    "cancelled",
  );
});

test("selects only exact durable webhook keys for the current provider request", () => {
  assert.equal(
    selectVideoGenerationWebhookTerminalStatus({
      providerRequestId: "request-1",
      webhookSignalKeys: [
        "request-10:nsfw",
        "request-1:completed:extra",
        "request-1:failed",
        "request-1:completed",
        "request-1:nsfw",
      ],
    }),
    "nsfw",
  );
  assert.equal(
    selectVideoGenerationWebhookTerminalStatus({
      providerRequestId: "request-1",
      webhookSignalKeys: [
        "request-1:failed",
        "request-1:cancelled",
        "request-1:completed",
      ],
    }),
    "completed",
  );
  assert.equal(
    selectVideoGenerationWebhookTerminalStatus({
      providerRequestId: "request-1",
      webhookSignalKeys: ["request-10:completed", "request-1:in_progress"],
    }),
    null,
  );
});
