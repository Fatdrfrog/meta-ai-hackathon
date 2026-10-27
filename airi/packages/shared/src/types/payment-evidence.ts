/** Evidence from a conversation is a suggestion, never proof of settlement. */
export type PaymentSuggestion = {
  messageId: string;
  kind: "receipt" | "payment_claim";
  amount: number | null;
  currency: string | null;
  occurredAt: string;
};

export const MAX_PAYMENT_SUGGESTIONS = 3;
