import { hasStoredWhatsAppServiceMessage } from "./service-message-preview";

export type WhatsAppMessageMutationKind = "edit" | "revoke";

export type WhatsAppMessageEventLike = {
  type?: string | null;
  unsupported?: { type?: string | null } | null;
};

export type StoredWhatsAppTextEditMetadata = {
  whatsappFlow?: unknown;
  whatsappServiceMessage?: unknown;
  whatsappTemplate?: unknown;
};

export function isStoredWhatsAppTextMessageEditable(
  message: StoredWhatsAppTextEditMetadata,
): boolean {
  if (hasStoredWhatsAppServiceMessage(message.whatsappServiceMessage)) {
    return false;
  }

  if (
    message.whatsappTemplate !== null &&
    message.whatsappTemplate !== undefined
  ) {
    return false;
  }

  const flow = message.whatsappFlow;
  if (!flow || typeof flow !== "object" || Array.isArray(flow)) {
    return true;
  }

  return !Boolean((flow as { flowId?: unknown }).flowId);
}

export function getWhatsAppMessageMutationKind(
  message: WhatsAppMessageEventLike,
): WhatsAppMessageMutationKind | null {
  if (message.type === "edit" || message.type === "revoke") {
    return message.type;
  }

  if (message.type !== "unsupported") return null;

  const unsupportedType = message.unsupported?.type?.trim().toLowerCase();
  return unsupportedType === "edit" || unsupportedType === "revoke"
    ? unsupportedType
    : null;
}

export function isWhatsAppStandaloneMessageEvent(
  message: WhatsAppMessageEventLike,
): boolean {
  return (
    message.type !== "reaction" &&
    getWhatsAppMessageMutationKind(message) === null
  );
}
