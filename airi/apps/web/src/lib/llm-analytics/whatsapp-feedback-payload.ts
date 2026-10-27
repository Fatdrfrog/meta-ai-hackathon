export const LLM_FEEDBACK_PAYLOAD_PREFIX = "llmfb";

export type LlmFeedbackReasonCode =
  | "incorrect"
  | "not_enough_detail"
  | "did_not_answer"
  | "unsafe_or_inappropriate"
  | "other";

export type ParsedWhatsAppLlmFeedbackPayload =
  | {
      kind: "helpfulness";
      helpful: boolean;
      sourceMessageId: string | null;
    }
  | {
      kind: "reason";
      reasonCode: LlmFeedbackReasonCode;
      sourceMessageId: string | null;
    };

export const WHATSAPP_LLM_FEEDBACK_REASON_ROWS: Array<{
  id: LlmFeedbackReasonCode;
  title: string;
  description: string;
}> = [
  {
    id: "incorrect",
    title: "Incorrect",
    description: "The answer was wrong.",
  },
  {
    id: "not_enough_detail",
    title: "Not enough detail",
    description: "The answer was too shallow.",
  },
  {
    id: "did_not_answer",
    title: "Didn't answer",
    description: "It missed the question.",
  },
  {
    id: "unsafe_or_inappropriate",
    title: "Unsafe",
    description: "Unsafe or inappropriate.",
  },
  {
    id: "other",
    title: "Other",
    description: "Something else was wrong.",
  },
];

function encodePayload(parts: string[]): string {
  return parts.map(part => encodeURIComponent(part)).join(":");
}

function decodePayloadPart(value: string | undefined): string {
  try {
    return decodeURIComponent(value || "").trim();
  } catch {
    return "";
  }
}

export function buildWhatsAppLlmFeedbackPayload(
  params:
    | {
        kind: "helpfulness";
        helpful: boolean;
        sourceMessageId?: string | null;
      }
    | {
        kind: "reason";
        reasonCode: LlmFeedbackReasonCode;
        sourceMessageId?: string | null;
      }
): string {
  if (params.kind === "helpfulness") {
    return encodePayload([
      LLM_FEEDBACK_PAYLOAD_PREFIX,
      "v1",
      "helpfulness",
      params.helpful ? "helpful" : "not_helpful",
      params.sourceMessageId || "",
    ]);
  }

  return encodePayload([
    LLM_FEEDBACK_PAYLOAD_PREFIX,
    "v1",
    "reason",
    params.reasonCode,
    params.sourceMessageId || "",
  ]);
}

export function parseWhatsAppLlmFeedbackPayload(
  payload: string | null | undefined
): ParsedWhatsAppLlmFeedbackPayload | null {
  const parts = String(payload || "").split(":");
  if (parts[0] !== LLM_FEEDBACK_PAYLOAD_PREFIX || parts[1] !== "v1") {
    return null;
  }

  const stage = decodePayloadPart(parts[2]);
  const value = decodePayloadPart(parts[3]);
  const sourceMessageId = decodePayloadPart(parts[4]) || null;

  if (stage === "helpfulness") {
    if (value === "helpful") {
      return { kind: "helpfulness", helpful: true, sourceMessageId };
    }
    if (value === "not_helpful") {
      return { kind: "helpfulness", helpful: false, sourceMessageId };
    }
  }

  if (
    stage === "reason" &&
    WHATSAPP_LLM_FEEDBACK_REASON_ROWS.some(row => row.id === value)
  ) {
    return {
      kind: "reason",
      reasonCode: value as LlmFeedbackReasonCode,
      sourceMessageId,
    };
  }

  return null;
}
