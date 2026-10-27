import {
  sendWhatsappInteractiveList,
  sendWhatsappInteractiveReplyButtons,
  type WhatsAppRecipientTarget,
} from "@/lib/whatsapp";
import LlmEvaluationReviewItem from "@/models/llm-evaluation-review-item";
import Message from "@/models/message";
import { normalizeWhatsAppMessageId } from "@icecore/shared/lib/whatsapp/message-id";
import {
  buildWhatsAppLlmFeedbackPayload,
  WHATSAPP_LLM_FEEDBACK_REASON_ROWS,
  type ParsedWhatsAppLlmFeedbackPayload,
} from "./whatsapp-feedback-payload";

export {
  buildWhatsAppLlmFeedbackPayload,
  parseWhatsAppLlmFeedbackPayload,
  type LlmFeedbackReasonCode,
  type ParsedWhatsAppLlmFeedbackPayload,
} from "./whatsapp-feedback-payload";

export async function sendWhatsAppLlmHelpfulnessPrompt(params: {
  phoneNumberId: string;
  accessToken: string;
  recipient: WhatsAppRecipientTarget | string;
  sourceMessageId?: string | null;
}) {
  return sendWhatsappInteractiveReplyButtons(
    params.phoneNumberId,
    params.accessToken,
    params.recipient,
    "Was this answer helpful?",
    [
      {
        id: buildWhatsAppLlmFeedbackPayload({
          kind: "helpfulness",
          helpful: true,
          sourceMessageId: params.sourceMessageId,
        }),
        title: "👍 Helpful",
      },
      {
        id: buildWhatsAppLlmFeedbackPayload({
          kind: "helpfulness",
          helpful: false,
          sourceMessageId: params.sourceMessageId,
        }),
        title: "👎 Not helpful",
      },
    ]
  );
}

export async function sendWhatsAppLlmFeedbackReasonPrompt(params: {
  phoneNumberId: string;
  accessToken: string;
  recipient: WhatsAppRecipientTarget | string;
  sourceMessageId?: string | null;
}) {
  return sendWhatsappInteractiveList(
    params.phoneNumberId,
    params.accessToken,
    params.recipient,
    "What was wrong?",
    "Choose reason",
    WHATSAPP_LLM_FEEDBACK_REASON_ROWS.map(row => ({
      id: buildWhatsAppLlmFeedbackPayload({
        kind: "reason",
        reasonCode: row.id,
        sourceMessageId: params.sourceMessageId,
      }),
      title: row.title,
      description: row.description,
    }))
  );
}

function feedbackLabel(payload: ParsedWhatsAppLlmFeedbackPayload): string {
  if (payload.kind === "helpfulness") {
    return payload.helpful ? "Helpful" : "Not helpful";
  }

  return (
    WHATSAPP_LLM_FEEDBACK_REASON_ROWS.find(row => row.id === payload.reasonCode)
      ?.title || payload.reasonCode
  );
}

function issueTypeForFeedback(
  payload: ParsedWhatsAppLlmFeedbackPayload
):
  | "knowledge_gap"
  | "unsupported_answer"
  | "bad_retrieval"
  | "tone_policy_issue"
  | "other" {
  if (payload.kind === "helpfulness" && payload.helpful) return "other";
  if (payload.kind === "reason") {
    if (payload.reasonCode === "incorrect") return "unsupported_answer";
    if (payload.reasonCode === "did_not_answer") return "knowledge_gap";
    if (payload.reasonCode === "not_enough_detail") return "bad_retrieval";
    if (payload.reasonCode === "unsafe_or_inappropriate") {
      return "tone_policy_issue";
    }
  }
  return "other";
}

function severityForFeedback(
  payload: ParsedWhatsAppLlmFeedbackPayload
): "high" | "medium" | "info" {
  if (payload.kind === "helpfulness" && payload.helpful) return "info";
  if (
    payload.kind === "reason" &&
    payload.reasonCode === "unsafe_or_inappropriate"
  ) {
    return "high";
  }
  return "medium";
}

async function findFeedbackAnswerMessage(params: {
  workspaceId: string;
  conversationId: string;
  sourceMessageId?: string | null;
}) {
  const normalizedSourceMessageId = normalizeWhatsAppMessageId(
    params.sourceMessageId || ""
  );
  if (!normalizedSourceMessageId) return null;

  return Message.findOne({
    workspaceId: params.workspaceId,
    conversation: params.conversationId,
    channel: "whatsapp",
    direction: "outbound",
    $or: [
      { messageId: normalizedSourceMessageId },
      { messageId: params.sourceMessageId },
    ],
  })
    .select("_id messageId text date")
    .lean<{
      _id: unknown;
      messageId?: string | null;
      text?: string | null;
      date?: Date | string | null;
    } | null>();
}

async function findFeedbackInputMessage(params: {
  workspaceId: string;
  conversationId: string;
  beforeDate?: Date | string | null;
  excludeMessageId?: string | null;
}) {
  const dateFilter = params.beforeDate
    ? { date: { $lte: params.beforeDate } }
    : {};

  return Message.findOne({
    workspaceId: params.workspaceId,
    conversation: params.conversationId,
    channel: "whatsapp",
    direction: "inbound",
    ...(params.excludeMessageId
      ? { _id: { $ne: params.excludeMessageId } }
      : {}),
    ...dateFilter,
  })
    .sort({ date: -1 })
    .select("_id text date")
    .lean<{
      _id: unknown;
      text?: string | null;
      date?: Date | string | null;
    } | null>();
}

export async function upsertWhatsAppLlmFeedbackReviewItem(params: {
  workspaceId: string;
  conversationId?: string | null;
  customerMessageId?: string | null;
  payload: ParsedWhatsAppLlmFeedbackPayload;
}) {
  const conversationId = String(params.conversationId || "").trim();
  if (!params.workspaceId || !conversationId) {
    return { item: null, inserted: false };
  }

  const answerMessage = await findFeedbackAnswerMessage({
    workspaceId: params.workspaceId,
    conversationId,
    sourceMessageId: params.payload.sourceMessageId,
  });
  const inputMessage = await findFeedbackInputMessage({
    workspaceId: params.workspaceId,
    conversationId,
    beforeDate: answerMessage?.date || null,
    excludeMessageId: params.customerMessageId,
  });
  const label = feedbackLabel(params.payload);
  const isPositive =
    params.payload.kind === "helpfulness" && params.payload.helpful;
  const dedupeKey = [
    "whatsapp-llm-feedback",
    params.workspaceId,
    conversationId,
    params.customerMessageId || "unknown-click",
    params.payload.kind,
    params.payload.sourceMessageId || "unknown-answer",
    params.payload.kind === "reason" ? params.payload.reasonCode : label,
  ].join(":");

  const result = await LlmEvaluationReviewItem.findOneAndUpdate(
    { workspaceId: params.workspaceId, dedupeKey },
    {
      $setOnInsert: {
        workspaceId: params.workspaceId,
        dedupeKey,
        conversationId,
        messageId:
          (typeof answerMessage?.messageId === "string"
            ? answerMessage.messageId
            : null) ||
          params.payload.sourceMessageId ||
          null,
        status: "open",
        source: "customer_feedback",
        issueType: issueTypeForFeedback(params.payload),
        severity: severityForFeedback(params.payload),
        title: isPositive
          ? "WhatsApp customer marked Airi answer helpful"
          : `WhatsApp customer feedback: ${label}`,
        summary: isPositive
          ? "Customer tapped Helpful. Review as a possible positive golden example."
          : `Customer tapped ${label}. Review the answer with conversation context before deciding whether it becomes a golden failure/regression case.`,
        inputExcerpt: inputMessage?.text || null,
        outputExcerpt: answerMessage?.text || null,
        reasoningExcerpt: null,
        suggestedFix: {
          type: isPositive ? "no_change" : "prompt_rubric_change",
          title: isPositive
            ? "Consider adding as a success example"
            : "Judge the failure mode and expected behavior",
          description:
            "Human reviewer should score relevance, trustworthiness, conciseness, completeness, safety, and write an explanation before deciding the dataset action.",
        },
      },
    },
    {
      includeResultMetadata: true,
      lean: true,
      new: true,
      runValidators: true,
      upsert: true,
    }
  );
  return {
    item: result?.value ?? null,
    inserted: result?.lastErrorObject?.updatedExisting !== true,
  };
}

export async function upsertWhatsAppLlmAnswerReviewItem(params: {
  workspaceId: string;
  conversationId?: string | null;
  sourceMessageId?: string | null;
  outputText?: string | null;
}) {
  const conversationId = String(params.conversationId || "").trim();
  const sourceMessageId = String(params.sourceMessageId || "").trim();
  if (!params.workspaceId || !conversationId || !sourceMessageId) {
    return { item: null, inserted: false };
  }

  const answerMessage = await findFeedbackAnswerMessage({
    workspaceId: params.workspaceId,
    conversationId,
    sourceMessageId,
  });
  const inputMessage = await findFeedbackInputMessage({
    workspaceId: params.workspaceId,
    conversationId,
    beforeDate: answerMessage?.date || null,
  });
  const dedupeKey = [
    "whatsapp-llm-answer-review",
    params.workspaceId,
    conversationId,
    sourceMessageId,
  ].join(":");

  const result = await LlmEvaluationReviewItem.findOneAndUpdate(
    { workspaceId: params.workspaceId, dedupeKey },
    {
      $setOnInsert: {
        workspaceId: params.workspaceId,
        dedupeKey,
        conversationId,
        messageId:
          (typeof answerMessage?.messageId === "string"
            ? answerMessage.messageId
            : null) || sourceMessageId,
        status: "open",
        source: "human_review",
        issueType: "other",
        severity: "info",
        title: "Airi answer awaiting human evaluation",
        summary:
          "Review this WhatsApp Airi answer and score relevance, trustworthiness, conciseness, completeness, and safety before deciding whether it belongs in the golden dataset.",
        inputExcerpt: inputMessage?.text || null,
        outputExcerpt: answerMessage?.text || params.outputText || null,
        reasoningExcerpt: null,
        suggestedFix: {
          type: "no_change",
          title: "Judge answer quality and dataset action",
          description:
            "Use this item for human evaluation even when the customer has not clicked a feedback button.",
        },
      },
    },
    {
      includeResultMetadata: true,
      lean: true,
      new: true,
      runValidators: true,
      upsert: true,
    }
  );
  return {
    item: result?.value ?? null,
    inserted: result?.lastErrorObject?.updatedExisting === false,
  };
}
