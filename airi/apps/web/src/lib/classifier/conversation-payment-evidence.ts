import {
  MAX_PAYMENT_SUGGESTIONS,
  type PaymentSuggestion,
} from "@icecore/shared/types/payment-evidence";

export type ClassificationPaymentEvidence = {
  message_index: number;
  kind: PaymentSuggestion["kind"];
  amount: number | null;
  currency: string | null;
};

type EvidenceMessage = {
  _id?: unknown;
  direction?: string | null;
  author?: { isBot?: boolean | null } | null;
  text?: string | null;
  imageAnalysis?: string | null;
  audioAnalysis?: string | null;
  videoAnalysis?: string | null;
  date?: unknown;
};

// Admission only: the existing classifier decides whether this is a receipt,
// a completed-payment claim, an invoice, a question, or a failed payment.
const PAYMENT_LANGUAGE =
  /\b(?:paid|payment|receipt|transferred|transfer|cheque|invoice)\b|оплат|плат[её]ж|перев[её]л|перевод|квитанц|чек|төле|төлем|аудар|to[‘'’ʻ`]?lov|to[‘'’ʻ`]?lad|тўлов|тўлад|kvitans/iu;
export const PAYMENT_EVIDENCE_TEXT_LIMIT = 1_200;

export function getPaymentEvidenceCandidateIndices(
  messages: readonly EvidenceMessage[]
): number[] {
  return messages
    .flatMap((message, index) => {
      if (message.direction !== "inbound" || message.author?.isBot === true)
        return [];
      const content = [
        message.text,
        message.imageAnalysis,
        message.audioAnalysis,
        message.videoAnalysis,
      ]
        .filter((value): value is string => typeof value === "string")
        .map(value => value.slice(0, PAYMENT_EVIDENCE_TEXT_LIMIT))
        .join("\n");
      return PAYMENT_LANGUAGE.test(content) ? [index] : [];
    })
    .slice(-MAX_PAYMENT_SUGGESTIONS);
}

/** Optional evidence cannot cause a second expensive classification attempt. */
export function parseClassificationPaymentEvidence(
  value: unknown,
  presentedMessageCount: number
): ClassificationPaymentEvidence[] {
  if (!Array.isArray(value) || value.length > MAX_PAYMENT_SUGGESTIONS)
    return [];
  const seen = new Set<number>();
  return value.flatMap(candidate => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate))
      return [];
    const keys = Object.keys(candidate);
    if (
      keys.length !== 4 ||
      !["message_index", "kind", "amount", "currency"].every(key =>
        Object.hasOwn(candidate, key)
      )
    )
      return [];
    const { message_index, kind, amount, currency } = candidate;
    if (
      !Number.isSafeInteger(message_index) ||
      message_index < 0 ||
      message_index >= presentedMessageCount ||
      seen.has(message_index)
    )
      return [];
    if (kind !== "receipt" && kind !== "payment_claim") return [];
    if (
      amount !== null &&
      (typeof amount !== "number" ||
        !Number.isFinite(amount) ||
        amount <= 0 ||
        amount > Number.MAX_SAFE_INTEGER / 100)
    )
      return [];
    if (
      currency !== null &&
      (typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency))
    )
      return [];
    seen.add(message_index);
    return [{ message_index, kind, amount, currency }];
  });
}

export function mapClassificationPaymentSuggestions(
  evidence: readonly ClassificationPaymentEvidence[],
  presentedMessages: readonly EvidenceMessage[]
): PaymentSuggestion[] {
  const admitted = new Set(
    getPaymentEvidenceCandidateIndices(presentedMessages)
  );
  return evidence.slice(0, MAX_PAYMENT_SUGGESTIONS).flatMap(item => {
    if (!admitted.has(item.message_index)) return [];
    const message = presentedMessages[item.message_index];
    const messageId = message?._id == null ? "" : String(message._id);
    if (!/^[a-f\d]{24}$/i.test(messageId)) return [];
    const timestamp =
      message.date instanceof Date
        ? message.date
        : typeof message.date === "string"
          ? new Date(message.date)
          : null;
    if (!timestamp || !Number.isFinite(timestamp.getTime())) return [];
    return [
      {
        messageId,
        kind: item.kind,
        amount: item.amount,
        currency: item.currency,
        occurredAt: timestamp.toISOString(),
      },
    ];
  });
}
