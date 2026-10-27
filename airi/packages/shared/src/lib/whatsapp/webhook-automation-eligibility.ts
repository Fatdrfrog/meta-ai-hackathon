import { asWhatsAppRecord, compactWhatsAppString } from "./value-utils";

type WhatsAppWebhookDirection = "inbound" | "outbound" | string | undefined;

type WhatsAppAutomationMessageType = string | undefined;

/** Actual standalone customer content, never a placeholder or a message mutation. */
export function isWhatsAppRecoverableMessageContent(message: unknown): boolean {
  const record = asWhatsAppRecord(message);
  const type = compactWhatsAppString(record.type);
  const content = asWhatsAppRecord(type ? record[type] : null);
  switch (type) {
    case "text":
      return Boolean(compactWhatsAppString(content.body));
    case "image":
    case "video":
    case "audio":
    case "voice":
    case "document":
    case "sticker":
      return Boolean(compactWhatsAppString(content.id));
    case "button":
      return Boolean(
        compactWhatsAppString(content.payload) || compactWhatsAppString(content.text),
      );
    case "interactive": {
      const reply = asWhatsAppRecord(content[String(content.type)]);
      return Boolean(
        compactWhatsAppString(reply.id) ||
          compactWhatsAppString(reply.response_json) ||
          compactWhatsAppString(reply.body),
      );
    }
    case "location":
      return Number.isFinite(content.latitude) && Number.isFinite(content.longitude);
    case "contacts":
      return Array.isArray(record.contacts) && record.contacts.some((contact) => {
        const item = asWhatsAppRecord(contact);
        return Boolean(
          compactWhatsAppString(asWhatsAppRecord(item.name).formatted_name) ||
            (Array.isArray(item.phones) && item.phones.length > 0),
        );
      });
    case "order":
      return Array.isArray(content.product_items) && content.product_items.length > 0;
    default:
      return false;
  }
}

export function isWhatsAppUnavailableMessage(message: {
  type?: string;
  errors?: ReadonlyArray<{ code: number }>;
  unsupported?: { type?: string };
}): boolean {
  const unsupportedType = message.unsupported?.type?.trim().toLowerCase();
  return (
    message.type === "unsupported" &&
    (!unsupportedType || unsupportedType === "unknown") &&
    Boolean(message.errors?.some((error) => error.code === 131060))
  );
}

export function shouldQueueWhatsAppAiriIngress(params: {
  direction: WhatsAppWebhookDirection;
  hasChat: boolean;
  hasConversation: boolean;
  messageType: WhatsAppAutomationMessageType;
  messageWasNew: boolean;
  messageErrors?: ReadonlyArray<{ code: number }>;
  unsupportedType?: string;
}): boolean {
  if (params.direction !== "inbound") return false;
  if (!params.messageWasNew) return false;
  // Coexistence can report a real first contact without its message content.
  // Let the runtime evaluate a safe welcome scenario; general AI stays suppressed.
  if (
    params.messageType === "unsupported" &&
    !isWhatsAppUnavailableMessage({
      type: params.messageType,
      errors: params.messageErrors,
      unsupported: { type: params.unsupportedType },
    })
  )
    return false;
  return params.hasConversation && params.hasChat;
}

export function shouldSuppressGeneralWhatsAppAiriReply(params: {
  messageType: WhatsAppAutomationMessageType;
}): boolean {
  return params.messageType === "unsupported";
}
