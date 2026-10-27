import { CRM_ATTENTION_WINDOW_MS, type CrmAttentionKind } from "./attention";

export const CRM_FOLLOW_UP_KINDS = [
  "take_over",
  "review_quote",
  "reply",
  "follow_up",
] as const;

export type CrmFollowUpKind = (typeof CRM_FOLLOW_UP_KINDS)[number];

export type CrmCardWarning = "objection";

export type CrmFollowUp = {
  kind: CrmFollowUpKind;
  dueAt: Date | null;
};

export function extractCrmKeyMomentTypes(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const types: string[] = [];
  for (const moment of value) {
    if (!moment || typeof moment !== "object" || !("type" in moment)) continue;
    const type = (moment as { type?: unknown }).type;
    if (typeof type === "string" && type.trim()) {
      types.push(type.trim());
    }
  }
  return types;
}

function followUpDueAt(
  slaDueAt: Date | null,
  lastInboundAt: Date | null
): Date | null {
  if (slaDueAt) return slaDueAt;
  if (!lastInboundAt) return null;
  return new Date(lastInboundAt.getTime() + CRM_ATTENTION_WINDOW_MS);
}

export function deriveCrmFollowUp(input: {
  attention: readonly CrmAttentionKind[];
  handoffActive: boolean;
  keyMomentTypes: readonly string[];
  slaDueAt: Date | null;
  lastInboundAt: Date | null;
}): CrmFollowUp | null {
  const dueAt = followUpDueAt(input.slaDueAt, input.lastInboundAt);
  const hasPriceInquiry = input.keyMomentTypes.includes("price_inquiry");

  if (input.handoffActive && input.attention.includes("needs_reply")) {
    return { kind: "take_over", dueAt };
  }
  if (hasPriceInquiry) {
    return { kind: "review_quote", dueAt };
  }
  if (input.attention.includes("needs_reply")) {
    return { kind: "reply", dueAt };
  }
  if (input.attention.includes("ghosted")) {
    return { kind: "follow_up", dueAt };
  }
  return null;
}

export function deriveCrmCardWarnings(
  keyMomentTypes: readonly string[]
): CrmCardWarning[] {
  return keyMomentTypes.includes("objection") ? ["objection"] : [];
}
