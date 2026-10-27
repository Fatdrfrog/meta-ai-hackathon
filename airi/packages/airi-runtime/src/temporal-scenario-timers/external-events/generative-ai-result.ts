import type {
  GenerativeAIDeliveryAttachment,
  GenerativeAIDeliveryClaim,
  GenerativeAIExecution,
  GenerativeAIResultDeliveryKind,
} from "@icecore/scenario-contracts";
import type {
  AiriConversationExternalEventResult,
  AiriConversationOutboundDeliveryRequest,
  AiriConversationPostDeliveryEffect,
  AiriScenarioGenerativeAIResultEvent,
} from "@icecore/temporal";
import { AIRI_SCENARIO_GENERATIVE_AI_VIDEO_COMPLETION_SIGNAL } from "@icecore/temporal";
import { asNullableRecord } from "@icecore/shared/lib/value-utils";
import {
  WHATSAPP_OFFICIAL_MEDIA_MIME_TYPES,
  WHATSAPP_OFFICIAL_MEDIA_MAX_BYTES,
} from "@icecore/whatsapp/mediaTypes";

import { resolveGenerativeAICustomerCopy } from "../../generative-ai-auto-reply";
import {
  buildGenerativeAIResultDeliveryClaimToken,
  buildGenerativeAIResultDeliveryIdentity,
} from "../../scenario-generative-ai-identity";
import { canonicalGcsUri } from "../../media-api";

type GenerativeVideoAsset = {
  id: string;
  workspaceId: string;
  kind: "video" | "image";
  status: "queued" | "in_progress" | "complete" | "failed" | "nsfw";
  storageProvider: "gcs" | "supabase" | null;
  bucket: string | null;
  path: string | null;
  mimeType: string | null;
  fileName: string | null;
  fileSize: number | null;
  videoWorkflowId: string | null;
  attemptToken: string | null;
  completionTarget: {
    workflowId: string;
    signalName: string;
    correlationId: string;
  } | null;
};

type DeliveryClaimInput = {
  workspaceId: string;
  conversationId: string;
  executionId: string;
  scenarioId: string;
  scenarioRevisionFingerprint: string;
  actionNodeId: string;
  assetId: string | null;
  videoWorkflowId: string | null;
  attemptToken: string | null;
  deliveryClaim: GenerativeAIDeliveryClaim;
};

type GenerativeOwnerRecord =
  | { classification: "absent"; execution: null }
  | { classification: "malformed"; execution: null }
  | { classification: "present"; execution: GenerativeAIExecution };

type GenerativeOwnerReadInput = {
  workspaceId: string;
  conversationId: string;
  executionId: string;
};

type GenerativeInboundHydrationInput = {
  workspaceId: string;
  conversationId: string;
  messageId: string;
  channel: "whatsapp";
};

export type GenerativeAIResultHandlerDependencies = {
  readOwner: (
    input: GenerativeOwnerReadInput,
  ) => Promise<GenerativeOwnerRecord>;
  loadAsset: (input: {
    workspaceId: string;
    assetId: string;
  }) => Promise<GenerativeVideoAsset | null>;
  hydrateOriginalInbound: (
    input: GenerativeInboundHydrationInput,
  ) => Promise<Record<string, unknown>>;
  /**
   * The language a turn would answer this customer in, from the hydrated
   * inbound and its conversation. Without it, the stored preference.
   */
  resolveCustomerLanguage?: (
    body: Record<string, unknown>,
  ) => Promise<string | null>;
  captureOutbound: (input: {
    workspaceId: string;
    conversationId: string;
    messageId: string;
    context: Record<string, unknown>;
    deliveryIdentity: string;
    postDeliveryEffect: AiriConversationPostDeliveryEffect;
  }) => Promise<AiriConversationOutboundDeliveryRequest>;
  claimDelivery: (
    input: DeliveryClaimInput,
  ) => Promise<GenerativeAIExecution | null>;
  nowIso: () => string;
};

function isExactVideoIdentity(params: {
  event: AiriScenarioGenerativeAIResultEvent;
  owner: GenerativeAIExecution;
  asset: GenerativeVideoAsset;
}): boolean {
  const { event, owner, asset } = params;
  return (
    event.assetId !== null &&
    event.videoWorkflowId !== null &&
    event.terminal.attemptToken !== null &&
    owner.assetId === event.assetId &&
    owner.videoWorkflowId === event.videoWorkflowId &&
    asset.id === event.assetId &&
    asset.workspaceId === event.workspaceId &&
    asset.kind === (owner.mode === "text_to_image" ? "image" : "video") &&
    asset.videoWorkflowId === event.videoWorkflowId &&
    asset.attemptToken === event.terminal.attemptToken &&
    asset.completionTarget?.workflowId === event.scenarioWorkflowId &&
    asset.completionTarget.signalName ===
      AIRI_SCENARIO_GENERATIVE_AI_VIDEO_COMPLETION_SIGNAL &&
    asset.completionTarget.correlationId === event.executionId
  );
}

function buildWhatsAppSafeCompleteVideo(
  asset: GenerativeVideoAsset,
): GenerativeAIDeliveryAttachment | null {
  const isSafe =
    asset.status === "complete" &&
    asset.storageProvider === "gcs" &&
    Boolean(asset.bucket && asset.path && asset.fileName) &&
    Boolean(
      asset.mimeType &&
        WHATSAPP_OFFICIAL_MEDIA_MIME_TYPES[asset.kind].includes(asset.mimeType),
    ) &&
    typeof asset.fileSize === "number" &&
    Number.isSafeInteger(asset.fileSize) &&
    asset.fileSize > 0 &&
    asset.fileSize <= WHATSAPP_OFFICIAL_MEDIA_MAX_BYTES[asset.kind];
  if (
    !isSafe ||
    !asset.bucket ||
    !asset.path ||
    !asset.mimeType ||
    !asset.fileName ||
    !asset.fileSize
  ) {
    return null;
  }
  return {
    url: canonicalGcsUri(asset.bucket, asset.path),
    mediaType: asset.kind,
    mimeType: asset.mimeType,
    fileName: asset.fileName,
    fileSize: asset.fileSize,
    bucket: asset.bucket,
    path: asset.path,
  };
}

function readLanguage(body: Record<string, unknown>): string {
  return String(
    body.preferredLanguage ||
      body.targetLanguage ||
      asNullableRecord(body.conversation)?.preferred_language ||
      "en",
  );
}

function buildPostDeliveryEffect(params: {
  event: AiriScenarioGenerativeAIResultEvent;
  owner: GenerativeAIExecution;
  deliveryClaimToken: string;
}): Extract<
  AiriConversationPostDeliveryEffect,
  { kind: "finalize_generative_ai_result" }
> {
  return {
    kind: "finalize_generative_ai_result",
    payload: {
      workspaceId: params.event.workspaceId,
      conversationId: params.event.conversationId,
      executionId: params.event.executionId,
      scenarioId: params.owner.scenarioId,
      scenarioRevisionFingerprint: params.owner.scenarioRevisionFingerprint,
      actionNodeId: params.owner.actionNodeId,
      deliveryClaimToken: params.deliveryClaimToken,
      assetId: params.event.assetId,
      videoWorkflowId: params.event.videoWorkflowId,
      attemptToken: params.event.terminal.attemptToken,
    },
  };
}

function buildOutboundContext(params: {
  body: Record<string, unknown>;
  owner: GenerativeAIExecution;
  kind: GenerativeAIResultDeliveryKind;
  attachment: GenerativeAIDeliveryAttachment | null;
  language: string;
}): Record<string, unknown> {
  const scenarioName = String(
    asNullableRecord(
      asNullableRecord(params.body.conversation)?.airi_scenario_state,
    )?.lockedScenarioName || "Scenario",
  );
  const base = {
    ...params.body,
    scenarioOrigin: {
      scenarioId: params.owner.scenarioId,
      scenarioName,
      actionNodeId: params.owner.actionNodeId,
    },
    temporalDispatchPolicy: "at_most_once",
  };
  if (
    (params.kind === "success_video" || params.kind === "success_image") &&
    params.attachment
  ) {
    return {
      ...base,
      content: "",
      scenarioAttachments: [
        {
          ...params.attachment,
        },
      ],
    };
  }
  return {
    ...base,
    content: resolveGenerativeAICustomerCopy(
      params.language,
      "failure",
      params.owner.mode,
    ),
    scenarioAttachments: undefined,
  };
}

function suppressedStaleResult(): AiriConversationExternalEventResult {
  return {
    handled: true,
    clearTimer: false,
    pendingDelivery: null,
    generativeResultDisposition: "suppressed_stale",
  };
}

export async function prepareGenerativeAIResultEvent(
  event: AiriScenarioGenerativeAIResultEvent,
  dependencies: GenerativeAIResultHandlerDependencies,
): Promise<AiriConversationExternalEventResult> {
  const ownerRecord = await dependencies.readOwner({
    workspaceId: event.workspaceId,
    conversationId: event.conversationId,
    executionId: event.executionId,
  });
  if (ownerRecord.classification === "malformed") {
    throw new Error("Generative execution owner is malformed");
  }
  const owner =
    ownerRecord.classification === "present" ? ownerRecord.execution : null;
  if (!owner || owner.executionId !== event.executionId) {
    return suppressedStaleResult();
  }
  const recoveringDelivery = owner.phase === "delivering";
  if (owner.scenarioWorkflowId !== event.scenarioWorkflowId) {
    if (recoveringDelivery) {
      throw new Error(
        "Delivering generative owner conflicts with its result workflow",
      );
    }
    return suppressedStaleResult();
  }
  const hasVideoIdentity =
    event.assetId !== null &&
    event.videoWorkflowId !== null &&
    event.terminal.attemptToken !== null;
  const hasNoVideoIdentity =
    event.assetId === null &&
    event.videoWorkflowId === null &&
    event.terminal.attemptToken === null;
  if (!hasVideoIdentity && !hasNoVideoIdentity) {
    if (recoveringDelivery) {
      throw new Error(
        "Delivering generative result has partial video identity",
      );
    }
    return suppressedStaleResult();
  }
  let freshAttachment: GenerativeAIDeliveryAttachment | null = null;
  if (hasVideoIdentity) {
    if (
      owner.assetId !== event.assetId ||
      owner.videoWorkflowId !== event.videoWorkflowId
    ) {
      if (recoveringDelivery) {
        throw new Error(
          "Delivering generative owner conflicts with its result asset",
        );
      }
      return suppressedStaleResult();
    }
    if (!recoveringDelivery) {
      const asset = await dependencies.loadAsset({
        workspaceId: event.workspaceId,
        assetId: event.assetId!,
      });
      if (!asset || !isExactVideoIdentity({ event, owner, asset })) {
        return suppressedStaleResult();
      }
      freshAttachment =
        event.terminal.state === "complete"
          ? buildWhatsAppSafeCompleteVideo(asset)
          : null;
    }
  } else if (owner.assetId || owner.videoWorkflowId) {
    if (recoveringDelivery) {
      throw new Error(
        "Delivering generative owner is missing its result video identity",
      );
    }
    return suppressedStaleResult();
  }

  const attachment =
    recoveringDelivery && owner.deliveryClaim
      ? owner.deliveryClaim.attachment
      : freshAttachment;
  const kind: GenerativeAIResultDeliveryKind =
    recoveringDelivery && owner.deliveryClaim
      ? owner.deliveryClaim.kind
      : attachment !== null
        ? attachment.mediaType === "image"
          ? "success_image"
          : "success_video"
        : "failure_feedback";

  const body = await dependencies.hydrateOriginalInbound({
    workspaceId: event.workspaceId,
    conversationId: event.conversationId,
    messageId: owner.inputMessageId,
    channel: "whatsapp",
  });
  const deliveryIdentity = buildGenerativeAIResultDeliveryIdentity(
    event.executionId,
    kind,
  );
  const deliveryClaimToken = buildGenerativeAIResultDeliveryClaimToken(
    event.executionId,
    kind,
  );
  if (
    recoveringDelivery &&
    (!owner.deliveryClaim ||
      owner.deliveryClaim.token !== deliveryClaimToken ||
      owner.deliveryClaim.attemptToken !== event.terminal.attemptToken ||
      ((owner.deliveryClaim.kind === "success_video" ||
        owner.deliveryClaim.kind === "success_image") &&
        (!attachment ||
          attachment.mediaType !==
            (owner.deliveryClaim.kind === "success_image"
              ? "image"
              : "video"))) ||
      (owner.deliveryClaim.kind === "failure_feedback" && attachment !== null))
  ) {
    throw new Error("Delivering generative owner has an invalid result claim");
  }
  const postDeliveryEffect = buildPostDeliveryEffect({
    event,
    owner,
    deliveryClaimToken,
  });
  // Only the failure copy is text; a missing resolver or one that fails
  // falls back to the stored preference.
  const language =
    (kind === "failure_feedback"
      ? await dependencies.resolveCustomerLanguage?.(body).catch(() => null)
      : null) || readLanguage(body);
  const captured = await dependencies.captureOutbound({
    workspaceId: event.workspaceId,
    conversationId: event.conversationId,
    messageId: owner.inputMessageId,
    context: {
      ...buildOutboundContext({ body, owner, kind, attachment, language }),
      temporalDispatchIdentity: deliveryIdentity,
    },
    deliveryIdentity,
    postDeliveryEffect,
  });
  // Like the scenario's other messages, the result reaches the customer during
  // a manual handoff: the scenario kept running and the generation was paid.
  // A handoff that starts after this capture still stops it at the sender.
  const pendingDelivery: AiriConversationOutboundDeliveryRequest = {
    ...captured,
    dispatchPolicy: "at_most_once",
    manualHandoffPolicy: "default",
    postDeliveryEffects: [postDeliveryEffect],
  };
  const claimed = await dependencies.claimDelivery({
    workspaceId: event.workspaceId,
    conversationId: event.conversationId,
    executionId: event.executionId,
    scenarioId: owner.scenarioId,
    scenarioRevisionFingerprint: owner.scenarioRevisionFingerprint,
    actionNodeId: owner.actionNodeId,
    assetId: event.assetId,
    videoWorkflowId: event.videoWorkflowId,
    attemptToken: event.terminal.attemptToken,
    deliveryClaim: {
      token: deliveryClaimToken,
      kind,
      deliveryKey: pendingDelivery.deliveryKey,
      reservedMessageId: pendingDelivery.reservedMessageId,
      claimedAt:
        recoveringDelivery && owner.deliveryClaim
          ? owner.deliveryClaim.claimedAt
          : dependencies.nowIso(),
      attemptToken: event.terminal.attemptToken,
      attachment,
    },
  });
  if (!claimed) {
    if (recoveringDelivery) {
      throw new Error("Generative result delivery claim recovery failed");
    }
    return suppressedStaleResult();
  }

  return {
    handled: true,
    clearTimer: false,
    pendingDelivery,
    generativeResultDisposition: "pending_delivery",
  };
}

export function handleGenerativeAIResultEvent(
  event: AiriScenarioGenerativeAIResultEvent,
  dependencies: GenerativeAIResultHandlerDependencies,
): Promise<AiriConversationExternalEventResult> {
  return prepareGenerativeAIResultEvent(event, dependencies);
}
