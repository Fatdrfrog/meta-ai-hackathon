import type mongoose from "mongoose";

import type { InteractionMetrics } from "@icecore/shared/types/models";
import { isAutomatedOutboundOriginKind } from "@/lib/conversation-message-denorm";

import {
  RECENT_MESSAGES_WITH_SUMMARY,
  RECENT_MESSAGES_WITHOUT_SUMMARY,
} from "@/lib/classifier/conversation-analysis-constants";
import { formatClassificationMessage } from "@/lib/classifier/conversation-analysis-context";
import { getPaymentEvidenceCandidateIndices } from "@/lib/classifier/conversation-payment-evidence";
import type { PopulatedMessage } from "@/types/models";

export function calculateInteractionMetrics(
  messages: PopulatedMessage[]
): InteractionMetrics {
  if (messages.length < 2) {
    return {
      talk_ratio: 0,
      agent_response_time_avg_sec: null,
      customer_question_count: 0,
    };
  }

  let agentMessages = 0;
  let customerMessages = 0;
  let customerQuestionCount = 0;
  const responseTimes: number[] = [];
  let waitingSince: number | null = null;

  for (let index = 0; index < messages.length; index += 1) {
    const current = messages[index];
    const isAgent = current.author?.isBot || current.direction === "outbound";
    if (isAgent) {
      agentMessages += 1;
      const isHuman = current.direction === "outbound" && !isAutomatedOutboundOriginKind(current.origin?.kind) && (current.origin?.kind === "manager" || current.author?.isBot === false);
      const replyAt = new Date(current.date).getTime();
      if (isHuman && waitingSince !== null && Number.isFinite(replyAt) && replyAt >= waitingSince) {
        responseTimes.push((replyAt - waitingSince) / 1000);
        waitingSince = null;
      }
      continue;
    }

    customerMessages += 1;
    if (current.text?.includes("?")) customerQuestionCount += 1;
    const inboundAt = new Date(current.date).getTime();
    if (waitingSince === null && Number.isFinite(inboundAt)) waitingSince = inboundAt;
  }

  const totalMessages = agentMessages + customerMessages;
  const talkRatio = totalMessages > 0 ? agentMessages / totalMessages : 0;
  const averageResponseSeconds =
    responseTimes.length > 0
      ? responseTimes.reduce((total, value) => total + value, 0) /
        responseTimes.length
      : null;
  return {
    talk_ratio: Number(talkRatio.toFixed(2)),
    agent_response_time_avg_sec: averageResponseSeconds === null ? null : Math.round(averageResponseSeconds),
    customer_question_count: customerQuestionCount,
  };
}

export function formatMessage(message: PopulatedMessage): string {
  return formatClassificationMessage(message);
}

function formatMessagesWithIndices(messages: PopulatedMessage[]): string {
  const paymentEvidenceIndices = new Set(
    getPaymentEvidenceCandidateIndices(messages)
  );
  return messages
    .map(
      (message, index) =>
        `Message ${index}: ${formatClassificationMessage(message, {
          preservePaymentEvidence: paymentEvidenceIndices.has(index),
        })}`
    )
    .join("\n");
}

export function prepareTextForAnalysis(
  messages: PopulatedMessage[],
  historySummary: string | undefined,
  newSummary: string | null
): { text: string; messagesOffset: number } {
  const summary = newSummary || historySummary;
  if (summary) {
    const recentMessages = messages.slice(-RECENT_MESSAGES_WITH_SUMMARY);
    return {
      text: `History Summary:\n${summary}\n\nRecent Messages (last ${recentMessages.length}):\n${formatMessagesWithIndices(recentMessages)}`,
      messagesOffset: Math.max(
        0,
        messages.length - RECENT_MESSAGES_WITH_SUMMARY
      ),
    };
  }

  if (messages.length > RECENT_MESSAGES_WITHOUT_SUMMARY) {
    const recentMessages = messages.slice(-RECENT_MESSAGES_WITHOUT_SUMMARY);
    const olderMessages = messages.slice(0, -RECENT_MESSAGES_WITHOUT_SUMMARY);
    const olderText = `[Earlier conversation - ${olderMessages.length} messages]\n${olderMessages
      .slice(0, 5)
      .map(formatMessage)
      .join("\n")}${olderMessages.length > 5 ? "\n..." : ""}\n\n[Recent conversation - last ${recentMessages.length} messages]\n`;
    return {
      text: olderText + formatMessagesWithIndices(recentMessages),
      messagesOffset: olderMessages.length,
    };
  }

  return { text: formatMessagesWithIndices(messages), messagesOffset: 0 };
}

export function mapKeyMoments(
  keyMoments: Array<{ type: string; message_index: number }>,
  messages: PopulatedMessage[],
  messagesOffset = 0
): Array<{ type: string; message_ref: mongoose.Schema.Types.ObjectId }> {
  if (!Array.isArray(keyMoments)) return [];
  return keyMoments.flatMap(moment => {
    const actualIndex = moment.message_index + messagesOffset;
    if (
      actualIndex < 0 ||
      actualIndex >= messages.length ||
      !messages[actualIndex]
    ) {
      return [];
    }
    return [
      {
        type: moment.type,
        message_ref: messages[actualIndex]
          ._id as mongoose.Schema.Types.ObjectId,
      },
    ];
  });
}
