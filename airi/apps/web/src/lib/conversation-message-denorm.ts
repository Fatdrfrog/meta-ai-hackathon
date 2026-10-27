import { readDate } from "@icecore/shared/lib/value-utils";

export type ConversationMessageDirection = "inbound" | "outbound";

type ConversationFirstResponseMessageLike = {
  conversation?: unknown;
  workspaceId?: unknown;
  direction?: string | null;
  date?: Date | string | null;
  author?: unknown;
  origin?: {
    kind?: string | null;
    sentByUserId?: string | null;
  } | null;
};

type ConversationFirstResponseManagerOptions = {
  authorIsHuman?: boolean;
  managerName?: string | null;
};

type ConversationFirstResponseManager = {
  managerId: string;
  authorId: string | null;
  managerName: string | null;
};

export type ConversationFirstResponseUpdate = {
  filter: Record<string, unknown>;
  update: Record<string, unknown>[];
};

const AUTOMATED_OUTBOUND_ORIGIN_KINDS = new Set([
  "airi",
  "scenario",
  "campaign",
  "bulk_analytics",
  "system",
]);

/** Campaign/scenario/Airi/system outbounds are not human manager replies. */
export function isAutomatedOutboundOriginKind(
  originKind: string | null | undefined
): boolean {
  const normalized =
    typeof originKind === "string" ? originKind.trim() : "";
  return Boolean(normalized && AUTOMATED_OUTBOUND_ORIGIN_KINDS.has(normalized));
}

export const toConversationMessageDate = readDate;

function normalizeNonEmptyString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (
    typeof value === "object" &&
    "_id" in value &&
    value._id !== null &&
    value._id !== undefined
  ) {
    return normalizeNonEmptyString(value._id);
  }

  const normalized = String(value).trim();
  if (!normalized || normalized === "[object Object]") return null;
  return normalized;
}

function normalizeManagerName(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized || null;
}

export function resolveConversationFirstResponseManager(
  message: ConversationFirstResponseMessageLike,
  options: ConversationFirstResponseManagerOptions = {}
): ConversationFirstResponseManager | null {
  if (message.direction !== "outbound") return null;

  const originKind = normalizeNonEmptyString(message.origin?.kind);
  if (isAutomatedOutboundOriginKind(originKind)) {
    return null;
  }

  const authorId = normalizeNonEmptyString(message.author);
  const originSentByUserId = normalizeNonEmptyString(
    message.origin?.sentByUserId
  );
  const managerId =
    originKind === "manager" || options.authorIsHuman
      ? originSentByUserId || authorId
      : null;

  if (!managerId || managerId === "0") return null;

  return {
    managerId,
    authorId,
    managerName: normalizeManagerName(options.managerName),
  };
}

export function buildConversationFirstResponseUpdate(
  message: ConversationFirstResponseMessageLike,
  options: ConversationFirstResponseManagerOptions = {}
): ConversationFirstResponseUpdate | null {
  const messageDate = toConversationMessageDate(message.date);
  const workspaceId = normalizeNonEmptyString(message.workspaceId);
  const manager = resolveConversationFirstResponseManager(message, options);

  if (!message.conversation || !workspaceId || !messageDate || !manager) {
    return null;
  }

  return {
    filter: {
      _id: message.conversation,
      workspaceId,
      first_response_at: null,
      first_inbound_at: { $type: "date", $lte: messageDate },
    },
    update: [
      {
        $set: {
          first_response_at: messageDate,
          first_response_seconds: {
            $divide: [{ $subtract: [messageDate, "$first_inbound_at"] }, 1000],
          },
          first_response_manager_id: manager.managerId,
          first_response_manager_name: manager.managerName,
        },
      },
    ],
  };
}

function newerConversationMessageDateExpression(
  field: string,
  value: Date
): Record<string, unknown> {
  return {
    $cond: [
      {
        $gt: [value, { $ifNull: [`$${field}`, new Date(0)] }],
      },
      value,
      `$${field}`,
    ],
  };
}

function olderConversationMessageDateExpression(
  field: string,
  value: Date
): Record<string, unknown> {
  return {
    $cond: [
      {
        $lt: [
          value,
          { $ifNull: [`$${field}`, new Date("9999-12-31T23:59:59.999Z")] },
        ],
      },
      value,
      `$${field}`,
    ],
  };
}

export function buildConversationMessageTimestampSet(
  messageDate: Date,
  direction?: ConversationMessageDirection | null
): Record<string, unknown> {
  const nextSet: Record<string, unknown> = {
    lastMessageAt: newerConversationMessageDateExpression(
      "lastMessageAt",
      messageDate
    ),
  };

  if (direction === "inbound") {
    nextSet.last_inbound_at = newerConversationMessageDateExpression(
      "last_inbound_at",
      messageDate
    );
    nextSet.first_inbound_at = olderConversationMessageDateExpression(
      "first_inbound_at",
      messageDate
    );
  } else if (direction === "outbound") {
    nextSet.last_outbound_at = newerConversationMessageDateExpression(
      "last_outbound_at",
      messageDate
    );
  }

  return nextSet;
}
