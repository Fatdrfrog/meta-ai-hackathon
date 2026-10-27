import { createHash } from "node:crypto";
import { isMongoDuplicateKeyError } from "@/lib/mongo-errors";
import ApiMessageSendOperation, {
  type ApiMessageSendOperationRecord,
  type ApiMessageSendResponse,
} from "@/models/api-message-send-operation";

export type MessageSendIdentity = {
  operationId: string;
  workspaceId: string;
  payloadDigest: string;
};

export type MessageSendReplay =
  | { state: "completed"; response: ApiMessageSendResponse }
  | { state: "conflict" | "pending" | "unknown" };

export function buildMessageSendIdentity(
  workspaceId: string,
  idempotencyKey: string,
  payload: { conversationId: string; text: string }
): MessageSendIdentity {
  return {
    workspaceId,
    operationId: createHash("sha256")
      .update(JSON.stringify([workspaceId, "messages.send", idempotencyKey]))
      .digest("hex"),
    payloadDigest: createHash("sha256")
      .update(JSON.stringify([payload.conversationId, payload.text]))
      .digest("hex"),
  };
}

function readReplay(
  identity: MessageSendIdentity,
  record: ApiMessageSendOperationRecord
): MessageSendReplay {
  if (
    record.workspaceId !== identity.workspaceId ||
    record.payloadDigest !== identity.payloadDigest
  ) {
    return { state: "conflict" };
  }
  if (record.state === "completed" && record.response) {
    return { state: "completed", response: record.response };
  }
  if (
    record.state === "pending" &&
    record.createdAt instanceof Date &&
    Date.now() - record.createdAt.getTime() < 2 * 60_000
  ) {
    return { state: "pending" };
  }
  // A lost worker/HTTP response is not proof the provider did not send.
  return { state: "unknown" };
}

export async function getMessageSendReplay(
  identity: MessageSendIdentity
): Promise<MessageSendReplay | null> {
  const record = await ApiMessageSendOperation.findById(
    identity.operationId
  ).lean();
  return record ? readReplay(identity, record) : null;
}

export async function reserveMessageSend(
  identity: MessageSendIdentity,
  details: {
    apiKeyId: string;
    conversationId: string;
    sourceId: string;
    messageId: string;
  }
): Promise<
  { acquired: true } | { acquired: false; replay: MessageSendReplay }
> {
  try {
    await ApiMessageSendOperation.create(
      [
        {
          _id: identity.operationId,
          workspaceId: identity.workspaceId,
          payloadDigest: identity.payloadDigest,
          ...details,
          state: "pending",
        },
      ],
      { writeConcern: { w: "majority", wtimeout: 5_000 } }
    );
    return { acquired: true };
  } catch (error) {
    if (!isMongoDuplicateKeyError(error)) throw error;
    const replay = await getMessageSendReplay(identity);
    if (!replay) throw error;
    return { acquired: false, replay };
  }
}

function pendingOperationFilter(identity: MessageSendIdentity) {
  return {
    _id: identity.operationId,
    workspaceId: identity.workspaceId,
    payloadDigest: identity.payloadDigest,
    state: "pending",
  };
}

export async function completeMessageSend(
  identity: MessageSendIdentity,
  response: ApiMessageSendResponse,
  providerMessageId: string
): Promise<void> {
  const result = await ApiMessageSendOperation.updateOne(
    pendingOperationFilter(identity),
    {
      $set: {
        state: "completed",
        response,
        providerMessageId,
        sentAt: new Date(response.sentAt),
      },
    },
    { runValidators: true, writeConcern: { w: "majority", wtimeout: 5_000 } }
  );
  if (result.matchedCount !== 1) {
    throw new Error("API message send reservation could not be completed");
  }
}

export async function recordUnknownMessageSend(
  identity: MessageSendIdentity,
  accepted?: { providerMessageId: string; sentAt: Date }
): Promise<void> {
  await ApiMessageSendOperation.updateOne(
    pendingOperationFilter(identity),
    { $set: { state: "unknown", ...accepted } },
    { runValidators: true, writeConcern: { w: "majority", wtimeout: 5_000 } }
  );
}
