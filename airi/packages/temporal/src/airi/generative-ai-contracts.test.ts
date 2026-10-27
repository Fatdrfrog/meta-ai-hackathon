import assert from "node:assert/strict";
import test from "node:test";

import {
  AIRI_SCENARIO_GENERATIVE_AI_RESULT_PROCESSED_SIGNAL,
  AIRI_SCENARIO_GENERATIVE_AI_VIDEO_COMPLETION_SIGNAL,
  normalizeAiriScenarioGenerativeAIProcessedAck,
  normalizeAiriScenarioGenerativeAIResultEvent,
  normalizeAiriScenarioGenerativeAIWorkflowInput,
} from "./generative-ai-contracts.js";

const WORKFLOW_INPUT = {
  version: 1,
  kind: "start_generative_ai_scenario",
  workflowId: "scenario-generation:execution-1",
  workspaceId: "workspace-1",
  conversationId: "conversation-1",
  executionId: "execution-1",
  scenarioId: "scenario-1",
  scenarioRevisionFingerprint: "a".repeat(64),
  actionNodeId: "action-1",
} as const;

const RESULT_EVENT = {
  kind: "generative_ai_result",
  workspaceId: "workspace-1",
  conversationId: "conversation-1",
  messageId: "execution-1",
  executionId: "execution-1",
  scenarioWorkflowId: "scenario-generation:execution-1",
  videoWorkflowId: "video-generation:asset-1",
  assetId: "asset-1",
  terminal: {
    state: "complete",
    code: "generation_complete",
    attemptToken: "attempt-1",
  },
} as const;

test("normalizes the exact ID-only scenario generation workflow input", () => {
  assert.deepEqual(
    normalizeAiriScenarioGenerativeAIWorkflowInput(WORKFLOW_INPUT),
    WORKFLOW_INPUT,
  );
  assert.throws(
    () =>
      normalizeAiriScenarioGenerativeAIWorkflowInput({
        ...WORKFLOW_INPUT,
        prompt: "must stay out of workflow history",
      }),
    /fields/,
  );
  assert.throws(
    () =>
      normalizeAiriScenarioGenerativeAIWorkflowInput({
        ...WORKFLOW_INPUT,
        scenarioRevisionFingerprint: "revision-1",
      }),
    /scenarioRevisionFingerprint/,
  );
  assert.deepEqual(
    normalizeAiriScenarioGenerativeAIWorkflowInput({
      ...WORKFLOW_INPUT,
      reporting: {
        resultEvent: RESULT_EVENT,
        reportAttempt: 100,
      },
    }),
    {
      ...WORKFLOW_INPUT,
      reporting: {
        resultEvent: RESULT_EVENT,
        reportAttempt: 100,
      },
    },
  );
  assert.throws(
    () =>
      normalizeAiriScenarioGenerativeAIWorkflowInput({
        ...WORKFLOW_INPUT,
        reporting: {
          resultEvent: RESULT_EVENT,
          reportAttempt: -1,
        },
      }),
    /reportAttempt/,
  );
});

test("normalizes bounded result events without prompt or media data", () => {
  const event = RESULT_EVENT;

  assert.deepEqual(normalizeAiriScenarioGenerativeAIResultEvent(event), event);
  assert.deepEqual(
    normalizeAiriScenarioGenerativeAIResultEvent({
      ...event,
      videoWorkflowId: null,
      assetId: null,
      terminal: {
        state: "failed",
        code: "source_import_failed",
        attemptToken: null,
      },
    }),
    {
      ...event,
      videoWorkflowId: null,
      assetId: null,
      terminal: {
        state: "failed",
        code: "source_import_failed",
        attemptToken: null,
      },
    },
  );
  assert.throws(
    () =>
      normalizeAiriScenarioGenerativeAIResultEvent({
        ...event,
        messageId: "different-message",
      }),
    /messageId/,
  );
  assert.throws(
    () =>
      normalizeAiriScenarioGenerativeAIResultEvent({
        ...event,
        sourceUrl: "https://signed.example/video?token=secret",
      }),
    /fields/,
  );
  assert.throws(
    () =>
      normalizeAiriScenarioGenerativeAIResultEvent({
        ...event,
        videoWorkflowId: null,
      }),
    /identity/,
  );
  assert.throws(
    () =>
      normalizeAiriScenarioGenerativeAIResultEvent({
        ...event,
        videoWorkflowId: null,
        assetId: null,
        terminal: {
          state: "complete",
          code: "generation_complete",
          attemptToken: null,
        },
      }),
    /pre-asset/,
  );
  assert.throws(
    () =>
      normalizeAiriScenarioGenerativeAIResultEvent({
        ...event,
        videoWorkflowId: null,
        assetId: null,
        terminal: {
          state: "failed",
          code: "generation_start_failed",
          attemptToken: null,
        },
      }),
    /pre-asset/,
  );
});

test("normalizes only the exact processed acknowledgment", () => {
  assert.equal(
    AIRI_SCENARIO_GENERATIVE_AI_VIDEO_COMPLETION_SIGNAL,
    "airi.scenarioGenerativeAI.videoCompletion",
  );
  assert.equal(
    AIRI_SCENARIO_GENERATIVE_AI_RESULT_PROCESSED_SIGNAL,
    "generative_ai_result_processed",
  );
  assert.deepEqual(
    normalizeAiriScenarioGenerativeAIProcessedAck({
      contractVersion: 1,
      executionId: "execution-1",
    }),
    {
      contractVersion: 1,
      executionId: "execution-1",
    },
  );
  assert.throws(
    () =>
      normalizeAiriScenarioGenerativeAIProcessedAck({
        contractVersion: 1,
        executionId: "execution-1",
        handled: true,
      }),
    /fields/,
  );
});
