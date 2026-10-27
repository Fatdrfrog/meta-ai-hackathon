import { buildWhatsAppSessionChoicePayload } from "@icecore/scenario-contracts";

export function createServiceMessageEntityId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

export function createServiceMessageOptionId(actionNodeId: string): string {
  return buildWhatsAppSessionChoicePayload({
    actionNodeId,
    choiceId: createServiceMessageEntityId(),
  });
}
