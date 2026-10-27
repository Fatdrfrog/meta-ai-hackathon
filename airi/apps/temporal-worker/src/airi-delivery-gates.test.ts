import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveGenerativeDeliveryClaimGuard,
  shouldBypassManualHandoffForAiriDelivery,
} from "@icecore/airi-runtime/delivery-gates";
import type {
  AiriConversationOutboundDeliveryRequest,
  AiriConversationPostDeliveryEffect,
} from "@icecore/temporal";

function deliveryRequest(
  context: Record<string, unknown>,
  manualHandoffPolicy?: "default" | "respect",
): AiriConversationOutboundDeliveryRequest {
  return {
    deliveryKey: "delivery-1",
    reservedMessageId: "reserved-1",
    context: {
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      newMessage: { _id: "message-1" },
      ...context,
    },
    ...(manualHandoffPolicy ? { manualHandoffPolicy } : {}),
  };
}

test("bypasses manual handoff for scenario-origin follow-up deliveries", () => {
  assert.equal(
    shouldBypassManualHandoffForAiriDelivery(
      deliveryRequest({
        scenarioOrigin: {
          scenarioId: "scenario-1",
          actionNodeId: "action-1",
        },
      }),
    ),
    true,
  );
});

test("bypasses manual handoff for post-action scenario timeout deliveries", () => {
  assert.equal(
    shouldBypassManualHandoffForAiriDelivery(
      deliveryRequest({
        newMessage: {
          _id: "scenario-timeout:post_action_no_reply_timeout:scenario-1:2026-05-19T10:00:00.000Z",
        },
      }),
    ),
    true,
  );
});

test("keeps manual handoff blocking ordinary AI deliveries", () => {
  assert.equal(
    shouldBypassManualHandoffForAiriDelivery(deliveryRequest({})),
    false,
  );
});

test("explicit respect policy keeps manual handoff blocking scenario deliveries", () => {
  assert.equal(
    shouldBypassManualHandoffForAiriDelivery(
      deliveryRequest(
        {
          scenarioOrigin: {
            scenarioId: "scenario-1",
            actionNodeId: "action-1",
          },
        },
        "respect",
      ),
    ),
    false,
  );
});

test("derives the exact generative delivery claim from the terminal effect", () => {
  const request = deliveryRequest({});
  request.context.conversationId = undefined;
  request.context.conversation = { _id: "conversation-1" };
  request.postDeliveryEffects = [
    {
      kind: "finalize_generative_ai_result",
      payload: {
        workspaceId: "workspace-1",
        conversationId: "conversation-1",
        executionId: "execution-1",
        scenarioId: "scenario-1",
        scenarioRevisionFingerprint: "revision-1",
        actionNodeId: "action-1",
        deliveryClaimToken: "claim-1",
        assetId: "asset-1",
        videoWorkflowId: "video-workflow-1",
        attemptToken: "attempt-1",
      },
    },
  ];

  assert.deepEqual(resolveGenerativeDeliveryClaimGuard(request), {
    classification: "required",
    claim: {
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      executionId: "execution-1",
      scenarioId: "scenario-1",
      scenarioRevisionFingerprint: "revision-1",
      actionNodeId: "action-1",
      deliveryClaimToken: "claim-1",
      deliveryKey: "delivery-1",
      reservedMessageId: "reserved-1",
      assetId: "asset-1",
      videoWorkflowId: "video-workflow-1",
      attemptToken: "attempt-1",
    },
  });

  request.context.conversation = { _id: "other-conversation" };
  assert.deepEqual(resolveGenerativeDeliveryClaimGuard(request), {
    classification: "invalid",
  });
});

test("rejects malformed or duplicate generative terminal effects", () => {
  const request = deliveryRequest({});
  const effect: AiriConversationPostDeliveryEffect = {
    kind: "finalize_generative_ai_result",
    payload: {
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      executionId: "execution-1",
      scenarioId: "scenario-1",
      scenarioRevisionFingerprint: "revision-1",
      actionNodeId: "action-1",
      deliveryClaimToken: "",
      assetId: null,
      videoWorkflowId: null,
      attemptToken: null,
    },
  };
  request.postDeliveryEffects = [effect];
  assert.deepEqual(resolveGenerativeDeliveryClaimGuard(request), {
    classification: "invalid",
  });

  request.postDeliveryEffects = [
    {
      ...effect,
      payload: { ...effect.payload, deliveryClaimToken: "claim-1" },
    },
    {
      ...effect,
      payload: { ...effect.payload, deliveryClaimToken: "claim-1" },
    },
  ];
  assert.deepEqual(resolveGenerativeDeliveryClaimGuard(request), {
    classification: "invalid",
  });

  const validEffect: AiriConversationPostDeliveryEffect = {
    ...effect,
    payload: { ...effect.payload, deliveryClaimToken: "claim-1" },
  };
  request.postDeliveryEffects = [
    validEffect,
    { kind: "clear_suppressed_state", conversationId: "conversation-1" },
  ];
  assert.deepEqual(resolveGenerativeDeliveryClaimGuard(request), {
    classification: "invalid",
  });

  request.postDeliveryEffects = [
    {
      ...validEffect,
      payload: { ...validEffect.payload, workspaceId: " workspace-1" },
    },
  ];
  assert.deepEqual(resolveGenerativeDeliveryClaimGuard(request), {
    classification: "invalid",
  });
});

test("does not gate ordinary deliveries", () => {
  assert.deepEqual(resolveGenerativeDeliveryClaimGuard(deliveryRequest({})), {
    classification: "not_applicable",
  });
});
