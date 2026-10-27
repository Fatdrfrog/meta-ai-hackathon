import "server-only";
import { normalizeScenarioSharedLocationPoint } from "@icecore/scenario-contracts";
import type { ScenarioSharedLocationMessage } from "@icecore/airi-runtime/scenario-runtime-dependencies";
import { isMongoObjectIdString } from "@/lib/scenarios/task-utils";
import Message from "@/models/message";

/**
 * Meta stamps an inbound message in whole seconds, so an outbound sent in
 * the same second as a share can sort after it without answering it.
 */
const ANSWERED_AFTER_MS = 1_000;

type StoredSharedLocation = {
  _id?: unknown;
  date?: unknown;
  text?: unknown;
  whatsappLocation?: { latitude?: unknown; longitude?: unknown } | null;
  whatsappMeta?: { replyToWhatsAppMessageId?: unknown } | null;
};

/**
 * The newest inbound WhatsApp location shared from `since` to `until`,
 * skipping decided shares. Every saved message carries an all-null location
 * object, so only numeric coordinates count. A share any outbound message
 * already followed, such as a manager's reply, is not returned.
 */
export async function findLatestInboundSharedLocation(params: {
  workspaceId: string;
  conversationId: string;
  since: Date;
  until: Date;
  excludeMessageIds: string[];
}): Promise<ScenarioSharedLocationMessage | null> {
  const excludeMessageIds = params.excludeMessageIds.filter(
    isMongoObjectIdString
  );
  const share = await Message.findOne({
    workspaceId: params.workspaceId,
    conversation: params.conversationId,
    channel: "whatsapp",
    direction: "inbound",
    date: { $gte: params.since, $lte: params.until },
    ...(excludeMessageIds.length > 0
      ? { _id: { $nin: excludeMessageIds } }
      : {}),
    "whatsappLocation.latitude": { $type: "number" },
    "whatsappLocation.longitude": { $type: "number" },
  })
    .sort({ date: -1, _id: -1 })
    .select(
      "_id date text whatsappLocation.latitude whatsappLocation.longitude whatsappMeta.replyToWhatsAppMessageId"
    )
    .lean<StoredSharedLocation | null>();
  const point = normalizeScenarioSharedLocationPoint(share?.whatsappLocation);
  const date = share?.date instanceof Date ? share.date : null;
  if (!share || !point || !date || share._id == null) return null;

  const answered = await Message.exists({
    workspaceId: params.workspaceId,
    conversation: params.conversationId,
    direction: "outbound",
    date: {
      $gt: new Date(date.getTime() + ANSWERED_AFTER_MS),
      $lte: params.until,
    },
  });
  if (answered) return null;

  const replyTo = share.whatsappMeta?.replyToWhatsAppMessageId;
  return {
    messageId: String(share._id),
    date,
    ...point,
    hasReplyContext: typeof replyTo === "string" && replyTo.trim().length > 0,
    ...(typeof share.text === "string" && share.text.trim()
      ? { text: share.text.trim() }
      : {}),
  };
}
