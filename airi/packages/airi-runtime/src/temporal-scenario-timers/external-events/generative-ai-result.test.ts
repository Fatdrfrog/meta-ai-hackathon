import assert from "node:assert/strict";
import test from "node:test";

import type { AiriScenarioGenerativeAIResultEvent } from "@icecore/temporal";

import { shouldBypassManualHandoffForAiriDelivery } from "../../delivery-gates";
import {
  prepareGenerativeAIResultEvent,
  type GenerativeAIResultHandlerDependencies,
} from "./generative-ai-result";

const event: AiriScenarioGenerativeAIResultEvent = {
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
    code: "complete",
    attemptToken: "attempt-1",
  },
};

const generatingOwner = {
  version: 1 as const,
  configVersion: 1 as const,
  executionId: "execution-1",
  phase: "generating" as const,
  scenarioId: "scenario-1",
  scenarioRevisionFingerprint: "a".repeat(64),
  actionNodeId: "action-1",
  inputMessageId: "inbound-1",
  expectedInputKind: "text" as const,
  mode: "text_to_video" as const,
  composedPrompt: "private prompt",
  sourceMedia: null,
  successTransition: {
    nextActionNodeId: "success-1",
    completesScenario: false,
  },
  failureTransition: {
    nextActionNodeId: "failure-1",
    completesScenario: false,
  },
  scenarioWorkflowId: "scenario-generation:execution-1",
  videoWorkflowId: "video-generation:asset-1",
  acceptedAt: "2026-07-30T10:00:00.000Z",
  assetId: "asset-1",
};

const completeAsset = {
  id: "asset-1",
  workspaceId: "workspace-1",
  kind: "video" as const,
  status: "complete" as const,
  storageProvider: "gcs" as const,
  bucket: "creative-assets",
  path: "workspaces/workspace-1/creative-assets/video/asset-1/output.mp4",
  mimeType: "video/mp4",
  fileName: "output.mp4",
  fileSize: 8 * 1024 * 1024,
  videoWorkflowId: "video-generation:asset-1",
  attemptToken: "attempt-1",
  completionTarget: {
    workflowId: "scenario-generation:execution-1",
    signalName: "airi.scenarioGenerativeAI.videoCompletion",
    correlationId: "execution-1",
  },
};

function harness(
  overrides: Partial<GenerativeAIResultHandlerDependencies> = {},
) {
  const claims: Array<
    Parameters<GenerativeAIResultHandlerDependencies["claimDelivery"]>[0]
  > = [];
  const outboundContexts: Record<string, unknown>[] = [];
  const dependencies: GenerativeAIResultHandlerDependencies = {
    readOwner: async () => ({
      classification: "present",
      execution: generatingOwner,
    }),
    loadAsset: async () => completeAsset,
    hydrateOriginalInbound: async () => ({
      type: "whatsapp",
      workspaceId: "workspace-1",
      conversation: {
        _id: "conversation-1",
        airi_scenario_state: {
          lockedScenarioId: "scenario-1",
          lockedScenarioName: "Launch",
        },
      },
      newMessage: { _id: "inbound-1" },
      preferredLanguage: "en",
    }),
    captureOutbound: async ({
      context,
      deliveryIdentity,
      postDeliveryEffect,
    }) => {
      outboundContexts.push(context);
      const suffix = deliveryIdentity.endsWith(":video") ? "video" : "failure";
      return {
        deliveryKey: `delivery-${suffix}`,
        reservedMessageId: `reserved-${suffix}`,
        context,
        dispatchPolicy: "at_most_once",
        manualHandoffPolicy: "respect",
        postDeliveryEffects: [postDeliveryEffect],
      };
    },
    claimDelivery: async (input) => {
      claims.push(input);
      return {
        ...generatingOwner,
        phase: "delivering",
        deliveryClaim: input.deliveryClaim,
      };
    },
    nowIso: () => "2026-07-30T10:05:00.000Z",
    ...overrides,
  };
  return { dependencies, claims, outboundContexts };
}

test("exact completed asset prepares one strict canonical video delivery", async () => {
  const { dependencies, claims, outboundContexts } = harness();

  const result = await prepareGenerativeAIResultEvent(event, dependencies);

  assert.equal(result.handled, true);
  assert.equal(result.generativeResultDisposition, "pending_delivery");
  assert.equal(result.pendingDelivery?.dispatchPolicy, "at_most_once");
  // The scenario's other messages go out during a manual handoff, so its
  // paid result does too, even if the capture carried a stricter policy.
  assert.equal(result.pendingDelivery?.manualHandoffPolicy, "default");
  assert.equal(
    shouldBypassManualHandoffForAiriDelivery(result.pendingDelivery!),
    true,
  );
  assert.deepEqual(result.pendingDelivery?.postDeliveryEffects, [
    {
      kind: "finalize_generative_ai_result",
      payload: {
        workspaceId: "workspace-1",
        conversationId: "conversation-1",
        executionId: "execution-1",
        scenarioId: "scenario-1",
        scenarioRevisionFingerprint: "a".repeat(64),
        actionNodeId: "action-1",
        deliveryClaimToken: "generative-result-claim:execution-1:success_video",
        assetId: "asset-1",
        videoWorkflowId: "video-generation:asset-1",
        attemptToken: "attempt-1",
      },
    },
  ]);
  assert.deepEqual(outboundContexts[0].scenarioAttachments, [
    {
      url: "gcs://creative-assets/workspaces/workspace-1/creative-assets/video/asset-1/output.mp4",
      mediaType: "video",
      mimeType: "video/mp4",
      fileName: "output.mp4",
      fileSize: 8 * 1024 * 1024,
      bucket: "creative-assets",
      path: "workspaces/workspace-1/creative-assets/video/asset-1/output.mp4",
    },
  ]);
  assert.equal(outboundContexts[0].content, "");
  assert.equal(claims.length, 1);
  const claim = claims[0];
  assert.ok(claim);
  assert.equal("expectedPhases" in claim, false);
  assert.equal(claim.assetId, "asset-1");
  assert.equal(claim.videoWorkflowId, "video-generation:asset-1");
  assert.equal(claim.attemptToken, "attempt-1");
  assert.equal(claim.deliveryClaim.kind, "success_video");
  assert.equal(claim.deliveryClaim.deliveryKey, "delivery-video");
  assert.equal(claim.deliveryClaim.reservedMessageId, "reserved-video");
});

test("completed image uses canonical image delivery and preserves its success claim", async () => {
  const imageOwner = {
    ...generatingOwner,
    mode: "text_to_image" as const,
    videoWorkflowId: "creative-image-generation:asset-1",
  };
  const imageAsset = {
    ...completeAsset,
    kind: "image" as const,
    videoWorkflowId: imageOwner.videoWorkflowId,
    mimeType: "image/png",
    fileSize: 1024,
    fileName: "medal.png",
    path: "workspaces/workspace-1/creative-assets/image/asset-1/medal.png",
  };
  const { dependencies, claims, outboundContexts } = harness({
    readOwner: async () => ({
      classification: "present",
      execution: imageOwner,
    }),
    loadAsset: async () => imageAsset,
  });
  const result = await prepareGenerativeAIResultEvent(
    { ...event, videoWorkflowId: imageOwner.videoWorkflowId },
    dependencies,
  );
  assert.equal(result.generativeResultDisposition, "pending_delivery");
  assert.equal(claims[0]?.deliveryClaim.kind, "success_image");
  assert.equal(claims[0]?.deliveryClaim.attachment?.mediaType, "image");
  assert.equal(outboundContexts[0]?.content, "");
  assert.equal(
    outboundContexts[0]?.temporalDispatchIdentity,
    "generative-result:execution-1:image",
  );
});

test("oversized image follows failure without sending an invalid WhatsApp attachment", async () => {
  const { dependencies, claims, outboundContexts } = harness({
    readOwner: async () => ({
      classification: "present",
      execution: { ...generatingOwner, mode: "text_to_image" as const },
    }),
    loadAsset: async () => ({
      ...completeAsset,
      kind: "image" as const,
      mimeType: "image/png",
      fileSize: 5 * 1024 * 1024 + 1,
    }),
  });
  await prepareGenerativeAIResultEvent(event, dependencies);
  assert.equal(claims[0]?.deliveryClaim.kind, "failure_feedback");
  assert.equal(outboundContexts[0]?.scenarioAttachments, undefined);
});

test("image failure copy is written in the language a turn would answer in", async () => {
  const oversizedImage = {
    readOwner: async () => ({
      classification: "present" as const,
      execution: { ...generatingOwner, mode: "text_to_image" as const },
    }),
    loadAsset: async () => ({
      ...completeAsset,
      kind: "image" as const,
      mimeType: "image/png",
      fileSize: 5 * 1024 * 1024 + 1,
    }),
  };
  const resolvedFrom: unknown[] = [];
  const kazakh = harness({
    ...oversizedImage,
    resolveCustomerLanguage: async (body) => {
      resolvedFrom.push(body.newMessage);
      return "kz";
    },
  });
  await prepareGenerativeAIResultEvent(event, kazakh.dependencies);
  assert.equal(
    kazakh.outboundContexts[0]?.content,
    "Суретті жасау мүмкін болмады. Қайтадан көріңіз.",
  );
  assert.deepEqual(resolvedFrom, [{ _id: "inbound-1" }]);

  // An unavailable resolver keeps the stored preference.
  const unavailable = harness({
    ...oversizedImage,
    resolveCustomerLanguage: async () => {
      throw new Error("language unavailable");
    },
  });
  await prepareGenerativeAIResultEvent(event, unavailable.dependencies);
  assert.equal(
    unavailable.outboundContexts[0]?.content,
    "We couldn't create an image this time. Please try again.",
  );
});

test("image execution cannot consume a completed video asset", async () => {
  const { dependencies, claims } = harness({
    readOwner: async () => ({
      classification: "present",
      execution: { ...generatingOwner, mode: "text_to_image" as const },
    }),
  });
  const result = await prepareGenerativeAIResultEvent(event, dependencies);
  assert.equal(result.generativeResultDisposition, "suppressed_stale");
  assert.equal(claims.length, 0);
});

test("invalid completed media prepares localized best-effort failure feedback", async () => {
  const { dependencies, claims, outboundContexts } = harness({
    loadAsset: async () => ({
      ...completeAsset,
      mimeType: "video/quicktime",
      fileSize: 17 * 1024 * 1024,
    }),
  });

  const result = await prepareGenerativeAIResultEvent(event, dependencies);

  assert.equal(result.generativeResultDisposition, "pending_delivery");
  assert.equal(result.pendingDelivery?.dispatchPolicy, "at_most_once");
  assert.equal(
    outboundContexts[0].content,
    "We couldn't create a video this time. Please try again.",
  );
  assert.equal(outboundContexts[0].scenarioAttachments, undefined);
  const claim = claims[0];
  assert.ok(claim);
  assert.equal(claim.deliveryClaim.kind, "failure_feedback");
});

test("missing output filename cannot claim Success while preparing failure text", async () => {
  const { dependencies, claims, outboundContexts } = harness({
    loadAsset: async () => ({
      ...completeAsset,
      fileName: null,
    }),
  });

  await prepareGenerativeAIResultEvent(event, dependencies);

  assert.equal(outboundContexts[0].scenarioAttachments, undefined);
  const claim = claims[0];
  assert.ok(claim);
  assert.equal(claim.deliveryClaim.kind, "failure_feedback");
});

test("pre-asset failure claims its exact early phase and prepares failure feedback", async () => {
  const preAssetEvent: AiriScenarioGenerativeAIResultEvent = {
    ...event,
    videoWorkflowId: null,
    assetId: null,
    terminal: {
      state: "failed",
      code: "source_import_failed",
      attemptToken: null,
    },
  };
  const { dependencies, claims } = harness({
    readOwner: async () => ({
      classification: "present",
      execution: {
        ...generatingOwner,
        phase: "importing_source",
        videoWorkflowId: undefined,
        assetId: undefined,
      },
    }),
    loadAsset: async () => null,
  });

  const result = await prepareGenerativeAIResultEvent(
    preAssetEvent,
    dependencies,
  );

  assert.equal(result.generativeResultDisposition, "pending_delivery");
  const claim = claims[0];
  assert.ok(claim);
  assert.equal("expectedPhases" in claim, false);
  assert.equal(claim.assetId, null);
  assert.equal(claim.videoWorkflowId, null);
  assert.equal(claim.attemptToken, null);
  assert.equal(claim.deliveryClaim.kind, "failure_feedback");
  assert.deepEqual(result.pendingDelivery?.postDeliveryEffects?.[0], {
    kind: "finalize_generative_ai_result",
    payload: {
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      executionId: "execution-1",
      scenarioId: "scenario-1",
      scenarioRevisionFingerprint: "a".repeat(64),
      actionNodeId: "action-1",
      deliveryClaimToken:
        "generative-result-claim:execution-1:failure_feedback",
      assetId: null,
      videoWorkflowId: null,
      attemptToken: null,
    },
  });
});

test("stale or identity-conflicting result is suppressed without claim or delivery", async () => {
  for (const overrides of [
    {
      readOwner: async () => ({
        classification: "absent" as const,
        execution: null,
      }),
    },
    {
      loadAsset: async () => ({
        ...completeAsset,
        completionTarget: {
          ...completeAsset.completionTarget,
          correlationId: "different-execution",
        },
      }),
    },
  ] satisfies Array<Partial<GenerativeAIResultHandlerDependencies>>) {
    const { dependencies, claims, outboundContexts } = harness(overrides);
    const result = await prepareGenerativeAIResultEvent(event, dependencies);

    assert.equal(result.generativeResultDisposition, "suppressed_stale");
    assert.equal(result.pendingDelivery, null);
    assert.deepEqual(claims, []);
    assert.deepEqual(outboundContexts, []);
  }
});

test("malformed persisted owner fails for retry instead of acknowledging stale", async () => {
  const { dependencies, claims, outboundContexts } = harness({
    readOwner: async () => ({
      classification: "malformed",
      execution: null,
    }),
  });

  await assert.rejects(
    prepareGenerativeAIResultEvent(event, dependencies),
    /Generative execution owner is malformed/,
  );
  assert.deepEqual(claims, []);
  assert.deepEqual(outboundContexts, []);
});

test("delivering retry rebuilds claimed success from its immutable attachment", async () => {
  const firstAttempt = harness();
  await prepareGenerativeAIResultEvent(event, firstAttempt.dependencies);
  const storedClaim = firstAttempt.claims[0]?.deliveryClaim;
  assert.ok(storedClaim);
  assert.deepEqual(Object.keys(storedClaim), [
    "token",
    "kind",
    "deliveryKey",
    "reservedMessageId",
    "claimedAt",
    "attemptToken",
    "attachment",
  ]);
  assert.ok(storedClaim.attachment);
  assert.deepEqual(Object.keys(storedClaim.attachment), [
    "url",
    "mediaType",
    "mimeType",
    "fileName",
    "fileSize",
    "bucket",
    "path",
  ]);
  let retryAssetReads = 0;
  const retry = harness({
    readOwner: async () => ({
      classification: "present",
      execution: {
        ...generatingOwner,
        phase: "delivering",
        deliveryClaim: storedClaim,
      },
    }),
    loadAsset: async () => {
      retryAssetReads += 1;
      return null;
    },
  });

  const result = await prepareGenerativeAIResultEvent(
    event,
    retry.dependencies,
  );

  assert.equal(result.generativeResultDisposition, "pending_delivery");
  assert.deepEqual(
    {
      deliveryKey: result.pendingDelivery?.deliveryKey,
      reservedMessageId: result.pendingDelivery?.reservedMessageId,
      dispatchPolicy: result.pendingDelivery?.dispatchPolicy,
      manualHandoffPolicy: result.pendingDelivery?.manualHandoffPolicy,
      context: result.pendingDelivery?.context,
    },
    {
      deliveryKey: "delivery-video",
      reservedMessageId: "reserved-video",
      dispatchPolicy: "at_most_once",
      manualHandoffPolicy: "default",
      context: {
        type: "whatsapp",
        workspaceId: "workspace-1",
        conversation: {
          _id: "conversation-1",
          airi_scenario_state: {
            lockedScenarioId: "scenario-1",
            lockedScenarioName: "Launch",
          },
        },
        newMessage: { _id: "inbound-1" },
        preferredLanguage: "en",
        scenarioOrigin: {
          scenarioId: "scenario-1",
          scenarioName: "Launch",
          actionNodeId: "action-1",
        },
        temporalDispatchPolicy: "at_most_once",
        content: "",
        scenarioAttachments: [
          {
            url: "gcs://creative-assets/workspaces/workspace-1/creative-assets/video/asset-1/output.mp4",
            mediaType: "video",
            mimeType: "video/mp4",
            fileName: "output.mp4",
            fileSize: 8 * 1024 * 1024,
            bucket: "creative-assets",
            path: "workspaces/workspace-1/creative-assets/video/asset-1/output.mp4",
          },
        ],
        temporalDispatchIdentity: "generative-result:execution-1:video",
      },
    },
  );
  assert.equal(retryAssetReads, 0);
  const retryClaim = retry.claims[0];
  assert.ok(retryClaim);
  assert.deepEqual(retryClaim.deliveryClaim, {
    token: "generative-result-claim:execution-1:success_video",
    kind: "success_video",
    deliveryKey: "delivery-video",
    reservedMessageId: "reserved-video",
    claimedAt: "2026-07-30T10:05:00.000Z",
    attemptToken: "attempt-1",
    attachment: {
      url: "gcs://creative-assets/workspaces/workspace-1/creative-assets/video/asset-1/output.mp4",
      mediaType: "video",
      mimeType: "video/mp4",
      fileName: "output.mp4",
      fileSize: 8 * 1024 * 1024,
      bucket: "creative-assets",
      path: "workspaces/workspace-1/creative-assets/video/asset-1/output.mp4",
    },
  });
});
