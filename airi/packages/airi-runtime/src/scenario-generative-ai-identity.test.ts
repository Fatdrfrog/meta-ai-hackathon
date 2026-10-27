import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  GENERATIVE_AI_EXECUTION_NAMESPACE_UUID,
  buildGenerativeAIResultDeliveryIdentity,
  buildGenerativeAIResultDeliveryClaimToken,
  buildGenerativeAIExecutionId,
  buildGenerativeAIScenarioWorkflowId,
  buildScenarioRevisionFingerprint,
  type CanonicalScenarioGraph,
} from "./scenario-generative-ai-identity.js";

describe("scenario-generative-ai identity", () => {
  it("keeps image identities stable and distinct from video and failure", () => {
    const input = {
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      scenarioId: "scenario-1",
      actionNodeId: "action-1",
      inputMessageId: "message-1",
      mode: "text_to_image" as const,
    };
    assert.equal(
      buildGenerativeAIExecutionId(input),
      buildGenerativeAIExecutionId(input),
    );
    assert.notEqual(
      buildGenerativeAIExecutionId(input),
      buildGenerativeAIExecutionId({ ...input, mode: "text_to_video" }),
    );
    assert.equal(
      buildGenerativeAIResultDeliveryIdentity("execution-1", "success_image"),
      "generative-result:execution-1:image",
    );
  });
  it("builds a stable UUIDv5 from length-prefixed UTF-8 identity fields", () => {
    assert.equal(
      GENERATIVE_AI_EXECUTION_NAMESPACE_UUID,
      "516efdaa-b5c2-5f26-9d4d-0f7a5be5a7a6",
    );
    assert.equal(
      buildGenerativeAIExecutionId({
        workspaceId: "workspace-\u03b1",
        conversationId: "conversation-42",
        scenarioId: "scenario-7",
        actionNodeId: "node-9",
        inputMessageId: "message-11",
        mode: "image_to_video",
      }),
      "c3c49514-3e36-5acc-8b7c-de5ce10c92e4",
    );
  });

  it("derives deterministic result delivery and claim identities", () => {
    assert.equal(
      buildGenerativeAIResultDeliveryIdentity("execution-1", "success_video"),
      "generative-result:execution-1:video",
    );
    assert.equal(
      buildGenerativeAIResultDeliveryClaimToken(
        "execution-1",
        "failure_feedback",
      ),
      "generative-result-claim:execution-1:failure_feedback",
    );
  });

  it("derives a stable workflow identity from one execution", () => {
    assert.equal(
      buildGenerativeAIScenarioWorkflowId("execution-1"),
      "scenario-generation:execution-1",
    );
  });

  it("rejects invalid durable execution IDs", () => {
    for (const executionId of ["", " ", " execution-1", "execution-1 "]) {
      assert.throws(
        () => buildGenerativeAIScenarioWorkflowId(executionId),
        /non-empty, trimmed string/,
      );
    }
  });

  it("keeps a scenario revision fingerprint stable across object-key order", () => {
    const first = buildScenarioRevisionFingerprint({
      version: 1,
      nodes: [{ id: "trigger", data: { label: "Start", enabled: true } }],
      edges: [{ source: "trigger", target: "action", data: { order: 0 } }],
    });
    const reordered = buildScenarioRevisionFingerprint({
      edges: [{ data: { order: 0 }, target: "action", source: "trigger" }],
      nodes: [{ data: { enabled: true, label: "Start" }, id: "trigger" }],
      version: 1,
    });

    assert.equal(first, reordered);
  });

  it("changes a scenario revision fingerprint when graph semantics change", () => {
    const baseline = buildScenarioRevisionFingerprint({
      version: 1,
      nodes: [{ id: "trigger", data: { label: "Start" } }],
      edges: [{ source: "trigger", target: "action" }],
    });
    const changed = buildScenarioRevisionFingerprint({
      version: 1,
      nodes: [{ id: "trigger", data: { label: "Changed" } }],
      edges: [{ source: "trigger", target: "action" }],
    });

    assert.notEqual(baseline, changed);
  });

  it("rejects sparse graph arrays instead of fingerprinting missing values", () => {
    assert.throws(
      () =>
        buildScenarioRevisionFingerprint({
          version: 1,
          nodes: new Array(1),
          edges: [],
        }),
      /cannot contain sparse arrays/,
    );
  });

  it("rejects non-finite and unsupported graph values", () => {
    assert.throws(
      () =>
        buildScenarioRevisionFingerprint({
          version: 1,
          nodes: [Number.NaN],
          edges: [],
        }),
      /cannot contain non-finite numbers/,
    );
    assert.throws(
      () =>
        buildScenarioRevisionFingerprint({
          version: 1,
          nodes: [new Date()],
          edges: [],
        } as unknown as CanonicalScenarioGraph),
      /must contain plain JSON objects/,
    );
  });
});
