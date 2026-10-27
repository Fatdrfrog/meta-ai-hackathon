import {
  hasStoredWhatsAppServiceMessage,
  resolveStoredWhatsAppServiceMessagePreview,
} from "@icecore/shared/lib/whatsapp/service-message-preview";
import type { StoredWhatsAppServiceMessagePreview } from "@icecore/shared/types/message-preview";
import { isNonEmptyString, readDate } from "@icecore/shared/lib/value-utils";

export const CONVERSATION_ENGAGEMENT_VERSION = 1;
export const ENGAGEMENT_MESSAGE_SELECT =
  "direction date text mediaType reactions whatsappFlowReply whatsappServiceMessage whatsappTemplate origin delivery";

export type ConversationEngagementMetrics = {
  version: number;
  computedAt: Date;
  messageCount: number;
  inboundCount: number;
  outboundCount: number;
  customerQuestionCount: number;
  firstMessageAt: Date | null;
  lastMessageAt: Date | null;
  activeDurationMinutes: number | null;
  hasTwoWayConversation: boolean;
  turnSwitchCount: number;
  customerRepliesAfterOutbound: number;
  firstCustomerReplyDelayMinutes: number | null;
  avgCustomerReplyDelayMinutes: number | null;
  inboundMediaCount: number;
  inboundVoiceCount: number;
  flowSubmitCount: number;
  reactionCount: number;
  templateOutboundCount: number;
  campaignReplyCount: number;
  deliveredCount: number;
  readCount: number;
  score: number;
  scoreParts: {
    depth: number;
    reciprocity: number;
    intent: number;
    richness: number;
    delivery: number;
  };
};

export type EngagementMessageInput = {
  direction?: string | null;
  date?: Date | string | null;
  text?: string | null;
  mediaType?: string | null;
  reactions?: unknown[] | null;
  whatsappFlowReply?: {
    flowName?: string | null;
    body?: string | null;
    responseJson?: string | null;
  } | null;
  whatsappServiceMessage?: StoredWhatsAppServiceMessagePreview | null;
  whatsappTemplate?: {
    name?: string | null;
  } | null;
  origin?: {
    kind?: string | null;
    campaignId?: string | null;
  } | null;
  delivery?: {
    status?: string | null;
    sentAt?: Date | string | null;
    deliveredAt?: Date | string | null;
    readAt?: Date | string | null;
    failedAt?: Date | string | null;
  } | null;
};

type NormalizedEngagementMessage = EngagementMessageInput & {
  direction: "inbound" | "outbound";
  date: Date;
};

function normalizeMessage(
  message: EngagementMessageInput
): NormalizedEngagementMessage | null {
  if (message.direction !== "inbound" && message.direction !== "outbound") {
    return null;
  }

  const date = readDate(message.date);
  if (!date) return null;

  const serviceMessageText = hasStoredWhatsAppServiceMessage(
    message.whatsappServiceMessage
  )
    ? resolveStoredWhatsAppServiceMessagePreview(
        message.whatsappServiceMessage
      ).textParts.join(" ")
    : "";

  return {
    ...message,
    text: serviceMessageText || message.text,
    direction: message.direction,
    date,
  };
}

function hasQuestion(text: string | null | undefined): boolean {
  return /[?؟？]/.test(text || "");
}

function hasMeaningfulFlowReply(message: EngagementMessageInput): boolean {
  const flowReply = message.whatsappFlowReply;
  if (!flowReply) return false;

  return (
    isNonEmptyString(flowReply.responseJson) ||
    isNonEmptyString(flowReply.body) ||
    isNonEmptyString(flowReply.flowName)
  );
}

function hasTemplateOutbound(message: EngagementMessageInput): boolean {
  return (
    !hasStoredWhatsAppServiceMessage(message.whatsappServiceMessage) &&
    isNonEmptyString(message.whatsappTemplate?.name)
  );
}

function isCampaignOutbound(message: EngagementMessageInput): boolean {
  return (
    message.origin?.kind === "campaign" ||
    message.origin?.kind === "bulk_analytics" ||
    isNonEmptyString(message.origin?.campaignId)
  );
}

function isInboundVoice(message: EngagementMessageInput): boolean {
  return message.mediaType === "audio" || message.mediaType === "voice";
}

function isDelivered(message: EngagementMessageInput): boolean {
  return (
    message.delivery?.status === "delivered" ||
    message.delivery?.status === "read" ||
    message.delivery?.status === "played" ||
    Boolean(message.delivery?.deliveredAt) ||
    Boolean(message.delivery?.readAt)
  );
}

function isRead(message: EngagementMessageInput): boolean {
  return (
    message.delivery?.status === "read" ||
    message.delivery?.status === "played" ||
    Boolean(message.delivery?.readAt)
  );
}

function clampScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

function roundOne(value: number): number {
  return Math.round(value * 10) / 10;
}

function scoreEngagement(params: {
  messageCount: number;
  outboundCount: number;
  deliveredCount: number;
  readCount: number;
  hasTwoWayConversation: boolean;
  turnSwitchCount: number;
  customerRepliesAfterOutbound: number;
  customerQuestionCount: number;
  flowSubmitCount: number;
  campaignReplyCount: number;
  inboundMediaCount: number;
  inboundVoiceCount: number;
  reactionCount: number;
}): ConversationEngagementMetrics["scoreParts"] & { score: number } {
  const depth = clampScore((params.messageCount / 20) * 100);
  const reciprocity = clampScore(
    (params.hasTwoWayConversation ? 35 : 0) +
      Math.min(35, params.turnSwitchCount * 7) +
      Math.min(30, params.customerRepliesAfterOutbound * 10)
  );
  const intent = clampScore(
    Math.min(40, params.customerQuestionCount * 10) +
      Math.min(35, params.flowSubmitCount * 35) +
      Math.min(25, params.campaignReplyCount * 12)
  );
  const richness = clampScore(
    params.inboundMediaCount * 10 +
      params.inboundVoiceCount * 8 +
      params.reactionCount * 4
  );
  const delivery =
    params.outboundCount > 0
      ? clampScore(
          (params.deliveredCount / params.outboundCount) * 40 +
            (params.readCount / params.outboundCount) * 60
        )
      : 0;

  const hasDeliveryData = params.deliveredCount > 0 || params.readCount > 0;
  const score = hasDeliveryData
    ? depth * 0.2 +
      reciprocity * 0.35 +
      intent * 0.25 +
      richness * 0.1 +
      delivery * 0.1
    : depth * 0.22 + reciprocity * 0.38 + intent * 0.28 + richness * 0.12;

  return {
    depth: roundOne(depth),
    reciprocity: roundOne(reciprocity),
    intent: roundOne(intent),
    richness: roundOne(richness),
    delivery: roundOne(delivery),
    score: roundOne(clampScore(score)),
  };
}

export const ENGAGEMENT_COUNT_KEYS = [
  "messageCount",
  "inboundCount",
  "outboundCount",
  "customerQuestionCount",
  "inboundMediaCount",
  "inboundVoiceCount",
  "flowSubmitCount",
  "reactionCount",
  "templateOutboundCount",
  "deliveredCount",
  "readCount",
] as const;
export type EngagementCounts = Record<
  (typeof ENGAGEMENT_COUNT_KEYS)[number],
  number
>;
export type EngagementEdge = {
  turnSwitchCount: number;
  customerRepliesAfterOutbound: number;
  campaignReplyCount: number;
  replyDelayMilliseconds: number;
};
export type EngagementContribution = {
  version: 1;
  generation: string;
  conversationId: string | null;
  date: Date | null;
  direction: "inbound" | "outbound" | null;
  campaign: boolean;
  counts: EngagementCounts;
  edge: EngagementEdge;
};
export type EngagementAccumulator = {
  version: 1;
  phase: "ready";
  generation: string;
  counts: EngagementCounts;
  edge: EngagementEdge;
};

function emptyCounts(): EngagementCounts {
  return Object.fromEntries(
    ENGAGEMENT_COUNT_KEYS.map(key => [key, 0])
  ) as EngagementCounts;
}

export function buildEngagementEdge(
  previous: EngagementContribution | null,
  current: EngagementContribution | null
): EngagementEdge {
  const switched = Boolean(
    previous?.date && current?.date && previous.direction !== current.direction
  );
  const replied =
    switched &&
    previous?.direction === "outbound" &&
    current?.direction === "inbound";
  return {
    turnSwitchCount: switched ? 1 : 0,
    customerRepliesAfterOutbound: replied ? 1 : 0,
    campaignReplyCount: replied && previous?.campaign ? 1 : 0,
    // Integer milliseconds make average rounding independent of correction order.
    replyDelayMilliseconds: replied
      ? Math.max(0, current!.date!.getTime() - previous!.date!.getTime())
      : 0,
  };
}

export function buildEngagementContribution(
  input: EngagementMessageInput,
  generation: string,
  previous: EngagementContribution | null = null
): EngagementContribution {
  const message = normalizeMessage(input);
  const counts = emptyCounts();
  if (message) {
    counts.messageCount = 1;
    counts.reactionCount = Array.isArray(message.reactions)
      ? message.reactions.length
      : 0;
    if (message.direction === "inbound") {
      counts.inboundCount = 1;
      counts.customerQuestionCount = hasQuestion(message.text) ? 1 : 0;
      counts.inboundMediaCount = message.mediaType ? 1 : 0;
      counts.inboundVoiceCount = isInboundVoice(message) ? 1 : 0;
      counts.flowSubmitCount = hasMeaningfulFlowReply(message) ? 1 : 0;
    } else {
      counts.outboundCount = 1;
      counts.templateOutboundCount = hasTemplateOutbound(message) ? 1 : 0;
      counts.deliveredCount = isDelivered(message) ? 1 : 0;
      counts.readCount = isRead(message) ? 1 : 0;
    }
  }
  const contribution: EngagementContribution = {
    version: 1,
    generation,
    conversationId: null,
    date: message?.date ?? null,
    direction: message?.direction ?? null,
    campaign: message ? isCampaignOutbound(message) : false,
    counts,
    edge: buildEngagementEdge(null, null),
  };
  contribution.edge = buildEngagementEdge(previous, contribution);
  return contribution;
}

export function createEngagementAccumulator(
  generation: string
): EngagementAccumulator {
  return {
    version: 1,
    phase: "ready",
    generation,
    counts: emptyCounts(),
    edge: buildEngagementEdge(null, null),
  };
}

export function applyEngagementEdge(
  accumulator: EngagementAccumulator,
  edge: EngagementEdge,
  sign = 1
): void {
  for (const key of Object.keys(edge) as Array<keyof EngagementEdge>)
    accumulator.edge[key] += edge[key] * sign;
}

export function applyEngagementContribution(
  accumulator: EngagementAccumulator,
  contribution: EngagementContribution,
  sign = 1
): void {
  for (const key of ENGAGEMENT_COUNT_KEYS)
    accumulator.counts[key] += contribution.counts[key] * sign;
  applyEngagementEdge(accumulator, contribution.edge, sign);
}

export function computeEngagementMetricsFromAccumulator(
  accumulator: EngagementAccumulator,
  bounds: {
    firstMessageAt: Date | null;
    lastMessageAt: Date | null;
    firstReplyDelayMilliseconds: number | null;
  },
  now = new Date()
): ConversationEngagementMetrics {
  const { counts, edge } = accumulator;
  const hasTwoWayConversation =
    counts.inboundCount > 0 && counts.outboundCount > 0;
  const scoreParts = scoreEngagement({
    ...counts,
    ...edge,
    hasTwoWayConversation,
  });
  return {
    version: CONVERSATION_ENGAGEMENT_VERSION,
    computedAt: now,
    ...counts,
    firstMessageAt: bounds.firstMessageAt,
    lastMessageAt: bounds.lastMessageAt,
    activeDurationMinutes:
      bounds.firstMessageAt && bounds.lastMessageAt
        ? roundOne(
            Math.max(
              0,
              (bounds.lastMessageAt.getTime() -
                bounds.firstMessageAt.getTime()) /
                60000
            )
          )
        : null,
    hasTwoWayConversation,
    turnSwitchCount: edge.turnSwitchCount,
    customerRepliesAfterOutbound: edge.customerRepliesAfterOutbound,
    campaignReplyCount: edge.campaignReplyCount,
    firstCustomerReplyDelayMinutes:
      bounds.firstReplyDelayMilliseconds === null
        ? null
        : roundOne(bounds.firstReplyDelayMilliseconds / 60000),
    avgCustomerReplyDelayMinutes:
      edge.customerRepliesAfterOutbound > 0
        ? roundOne(
            edge.replyDelayMilliseconds /
              (60000 * edge.customerRepliesAfterOutbound)
          )
        : null,
    score: scoreParts.score,
    scoreParts: {
      depth: scoreParts.depth,
      reciprocity: scoreParts.reciprocity,
      intent: scoreParts.intent,
      richness: scoreParts.richness,
      delivery: scoreParts.delivery,
    },
  };
}

export function computeConversationEngagementMetrics(
  messages: EngagementMessageInput[],
  now = new Date()
): ConversationEngagementMetrics {
  const ordered = messages
    .map(normalizeMessage)
    .filter((message): message is NormalizedEngagementMessage =>
      Boolean(message)
    )
    .sort((left, right) => left.date.getTime() - right.date.getTime());
  const accumulator = createEngagementAccumulator("compute");
  let previous: EngagementContribution | null = null;
  let firstReplyDelayMilliseconds: number | null = null;
  for (const message of ordered) {
    const contribution = buildEngagementContribution(
      message,
      accumulator.generation,
      previous
    );
    applyEngagementContribution(accumulator, contribution);
    if (
      firstReplyDelayMilliseconds === null &&
      contribution.edge.customerRepliesAfterOutbound
    )
      firstReplyDelayMilliseconds = contribution.edge.replyDelayMilliseconds;
    previous = contribution;
  }
  return computeEngagementMetricsFromAccumulator(
    accumulator,
    {
      firstMessageAt: ordered[0]?.date ?? null,
      lastMessageAt: ordered.at(-1)?.date ?? null,
      firstReplyDelayMilliseconds,
    },
    now
  );
}
