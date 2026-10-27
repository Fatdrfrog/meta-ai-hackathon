import { normalizeWhatsAppMessageId } from "@icecore/shared/lib/whatsapp/message-id";
import { readDefaultExport } from "@icecore/airi-runtime/module-interop";

import * as MessageModule from "@/models/message";

type MessageModelLike = {
  findOne: (query: Record<string, unknown>) => {
    select: (fields: string) => {
      lean: () => Promise<unknown>;
    };
  };
};

function isMessageModelLike(value: unknown): value is MessageModelLike {
  return Boolean(
    value && typeof (value as MessageModelLike).findOne === "function",
  );
}

export function resolveWhatsAppDedupeMessageModel(
  moduleRecord: unknown = MessageModule,
): MessageModelLike {
  const model = readDefaultExport<unknown>(moduleRecord);
  if (isMessageModelLike(model)) return model;

  throw new Error("Message model export not found for WhatsApp dedupe");
}

const Message = resolveWhatsAppDedupeMessageModel();

export async function findExistingWhatsAppMessageByExternalId(
  messageId: string,
) {
  const normalizedMessageId = normalizeWhatsAppMessageId(messageId);
  const existing = (await Message.findOne({
    channel: "whatsapp",
    $or: [{ messageId: normalizedMessageId }, { messageId }],
  })
    .select("_id conversation messageId")
    .lean()) as {
    _id: unknown;
    conversation?: unknown;
    messageId?: string | null;
  } | null;

  return existing;
}
