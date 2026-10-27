import type { CompiledScenarioGraph } from "@icecore/airi-runtime/scenario-graph";
import {
  SCENARIO_TRIGGER_EVENT_KIND,
  type ScenarioRuntimeEventKind,
} from "@icecore/scenario-contracts";
import {
  isScenarioInteractiveReplyEventKind,
  parseWhatsAppBookCallPayload,
  parseWhatsAppSessionChoicePayload,
  parseWhatsAppTemplateButtonPayload,
} from "@icecore/scenario-contracts";
import type { MetaReferralFields } from "@/lib/scenarios/incoming-message-trigger-matcher";
import { normalizeOptionalNodeText } from "@/lib/scenarios/normalization";
import type { Channel, ConversationDocument } from "@/types/models";

export function resolveConversationMetaReferral(
  conversation: ConversationDocument
): Partial<MetaReferralFields> | null {
  const conversationWithReferral = conversation as ConversationDocument & {
    channel?: string | null;
    external_thread?: {
      provider?: string | null;
      referral?: {
        adId?: unknown;
        campaignId?: unknown;
        campaignName?: unknown;
        adSetId?: unknown;
        adSetName?: unknown;
        sourceUrl?: unknown;
        title?: unknown;
        body?: unknown;
        mediaUrl?: unknown;
        adAccountId?: unknown;
        campaignLabelStatus?: unknown;
        campaignLabels?: Array<{ id?: unknown; name?: unknown }> | null;
      } | null;
    } | null;
  };
  const provider = normalizeOptionalNodeText(
    conversationWithReferral.external_thread?.provider
  );
  const channel = normalizeOptionalNodeText(conversationWithReferral.channel);
  if (provider !== "instagram" && channel !== "instagram") return null;

  const referral = conversationWithReferral.external_thread?.referral;
  const sourceId = normalizeOptionalNodeText(referral?.adId);
  if (!sourceId) return null;

  const labelStatus = referral?.campaignLabelStatus;
  const campaignLabels = Array.isArray(referral?.campaignLabels)
    ? referral.campaignLabels.flatMap(label => {
        const id = normalizeOptionalNodeText(label?.id);
        if (!id) return [];
        return [
          {
            id,
            name: normalizeOptionalNodeText(label?.name) || id,
          },
        ];
      })
    : [];

  return {
    sourceId,
    sourceType: "ad",
    sourcePlatform: "instagram",
    campaignId: normalizeOptionalNodeText(referral?.campaignId),
    adSetId: normalizeOptionalNodeText(referral?.adSetId),
    sourceUrl: normalizeOptionalNodeText(referral?.sourceUrl),
    headline: normalizeOptionalNodeText(referral?.title),
    body: normalizeOptionalNodeText(referral?.body),
    mediaUrl: normalizeOptionalNodeText(referral?.mediaUrl),
    productCampaignName: normalizeOptionalNodeText(referral?.campaignName),
    adAccountId: normalizeOptionalNodeText(referral?.adAccountId),
    ...(campaignLabels.length > 0 ? { campaignLabels } : {}),
    ...(labelStatus === "present" ||
    labelStatus === "absent" ||
    labelStatus === "unavailable"
      ? { campaignLabelStatus: labelStatus }
      : {}),
  };
}

export function normalizeInteractiveTriggerPayloads(params: {
  quickReplyPayload?: string | null;
  whatsAppFlowResponseJson?: string | null;
}): {
  quickReplyPayload: string;
  whatsAppFlowResponseJson: string;
} {
  return {
    quickReplyPayload:
      typeof params.quickReplyPayload === "string"
        ? params.quickReplyPayload.trim()
        : "",
    whatsAppFlowResponseJson:
      typeof params.whatsAppFlowResponseJson === "string"
        ? params.whatsAppFlowResponseJson.trim()
        : "",
  };
}

/** A tap payload in our stb/wsc/wbc grammar: it names the step that sent it. */
function isScenarioWhatsAppReplyPayload(payload: string): boolean {
  return Boolean(
    parseWhatsAppTemplateButtonPayload(payload) ||
      parseWhatsAppSessionChoicePayload(payload) ||
      parseWhatsAppBookCallPayload(payload)
  );
}

export function resolveDefaultTriggerEventKind(params: {
  channel: Channel;
  triggerEventKind?: ScenarioRuntimeEventKind;
  quickReplyPayload: string;
  whatsAppFlowResponseJson: string;
}): ScenarioRuntimeEventKind {
  if (params.triggerEventKind) {
    return params.triggerEventKind;
  }

  // A WhatsApp button sent without our payload (Campaigns, inbox) returns its
  // label, which names no step: it reads as a typed reply.
  if (
    params.quickReplyPayload &&
    (params.channel !== "whatsapp" ||
      isScenarioWhatsAppReplyPayload(params.quickReplyPayload))
  ) {
    return resolveQuickReplyEventKindForChannel(params.channel);
  }

  if (params.whatsAppFlowResponseJson) {
    return SCENARIO_TRIGGER_EVENT_KIND.whatsAppFlowReply;
  }

  return SCENARIO_TRIGGER_EVENT_KIND.inboundMessage;
}

export function resolveQuickReplyEventKindForChannel(
  channel: Channel
): ScenarioRuntimeEventKind {
  if (channel === "whatsapp") {
    return SCENARIO_TRIGGER_EVENT_KIND.whatsAppButtonReply;
  }
  if (channel === "instagram") {
    return SCENARIO_TRIGGER_EVENT_KIND.instagramQuickReply;
  }
  return SCENARIO_TRIGGER_EVENT_KIND.telegramQuickReply;
}

export function shouldRouteBulkInteractiveReply(params: {
  graph: CompiledScenarioGraph;
  triggerEventKind?: ScenarioRuntimeEventKind | null;
}): boolean {
  return (
    params.graph.triggerNodeIds.length === 0 &&
    isScenarioInteractiveReplyEventKind(params.triggerEventKind) &&
    params.graph.nodes.some(node => node.data.kind === "bulk")
  );
}

export function isLockedBranchReplyEvent(params: {
  lockedByConversationState: boolean;
  preferredActionNodeId?: string;
  triggerEventKind?: ScenarioRuntimeEventKind | null;
}): boolean {
  return (
    params.lockedByConversationState &&
    Boolean(params.preferredActionNodeId) &&
    isScenarioInteractiveReplyEventKind(params.triggerEventKind)
  );
}

export function isLockedStructuredReplyEvent(params: {
  ignoreLockedScenario?: boolean;
  lockedScenarioId: string | null;
  triggerEventKind: ScenarioRuntimeEventKind;
}): boolean {
  return (
    !params.ignoreLockedScenario &&
    Boolean(params.lockedScenarioId) &&
    isScenarioInteractiveReplyEventKind(params.triggerEventKind)
  );
}

export function shouldSkipTriggerMatchDuringRuntimeBuild(params: {
  skipTriggerMatch?: boolean;
  triggerEventKind?: ScenarioRuntimeEventKind | null;
  lockedByConversationState: boolean;
  preferredActionNodeId?: string;
  graph: CompiledScenarioGraph;
}): boolean {
  if (params.skipTriggerMatch) {
    return true;
  }

  // The caller has already resolved an action that accepts this event. This
  // includes a text answer continuing to unsent service buttons, not only taps.
  // Entry criteria must not redirect an admitted action to another root.
  if (params.lockedByConversationState && params.preferredActionNodeId) {
    return true;
  }

  return shouldRouteBulkInteractiveReply({
    graph: params.graph,
    triggerEventKind: params.triggerEventKind,
  });
}

export function isActionReplyChannelMismatch(params: {
  actionReplyChannel?: string;
  channel: Channel;
}): boolean {
  return Boolean(
    params.actionReplyChannel && params.actionReplyChannel !== params.channel
  );
}

export function mapForcedBuildToSessionLogResult(
  mismatchReason: string | null | undefined
): "winner" | "no_action" | "trigger_mismatch" {
  if (mismatchReason === "flow_no_matching_action") {
    return "no_action";
  }
  return "trigger_mismatch";
}

export function mapRuntimeBuildToSessionLogResult(
  mismatchReason: string | null | undefined
): "no_action" | "trigger_mismatch" {
  return mismatchReason === "flow_no_matching_action"
    ? "no_action"
    : "trigger_mismatch";
}
