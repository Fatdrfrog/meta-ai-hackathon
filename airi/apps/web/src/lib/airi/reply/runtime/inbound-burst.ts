import { isMeaningfulMessageText } from "@/lib/media/message-media-utils";
import Message from "@/models/message";
import { readDate } from "@icecore/shared/lib/value-utils";

export const INBOUND_BURST_WINDOW_MS = 5_000;
const INBOUND_BURST_RECENT_MESSAGE_LIMIT = 40;

type LeanBurstMessage = {
  _id: unknown;
  direction?: "inbound" | "outbound" | null;
  date?: Date | string | null;
  author?: unknown;
  text?: string | null;
};

type InboundBurstSkipReason =
  | "superseded_by_newer_inbound_burst"
  | "already_answered_by_prior_outbound";

export type InboundBurstResolution =
  | {
      shouldProcess: true;
      burstText: string;
      burstMessageIds: string[];
      latestBurstMessageId: string;
    }
  | {
      shouldProcess: false;
      reason: InboundBurstSkipReason;
      burstOwnerMessageId?: string;
      answeredByMessageId?: string;
    };

function compareMessagesChronologically(
  left: LeanBurstMessage,
  right: LeanBurstMessage
): number {
  const leftTime = readDate(left.date)?.getTime() ?? 0;
  const rightTime = readDate(right.date)?.getTime() ?? 0;

  if (leftTime !== rightTime) {
    return leftTime - rightTime;
  }

  return String(left._id || "").localeCompare(String(right._id || ""));
}

function readAuthorId(author: unknown): string {
  if (!author || typeof author !== "object") {
    return author == null ? "" : String(author);
  }

  if ("_id" in (author as Record<string, unknown>)) {
    const nestedId = (author as { _id?: unknown })._id;
    return nestedId == null ? "" : String(nestedId);
  }

  return "";
}

function isCustomerInboundMessage(message: LeanBurstMessage): boolean {
  if (message.direction !== "inbound") {
    return false;
  }

  return readAuthorId(message.author) !== "0";
}

function isOutboundMessage(message: LeanBurstMessage): boolean {
  return message.direction === "outbound";
}

function buildBurstText(messages: LeanBurstMessage[]): string {
  return messages
    .map(message =>
      typeof message.text === "string" ? message.text.trim() : ""
    )
    .filter(isMeaningfulMessageText)
    .join("\n")
    .trim();
}

export async function resolveInboundBurstOwnership(params: {
  conversationId: string;
  currentMessageId: string;
}): Promise<InboundBurstResolution> {
  const recentMessages = await Message.find({
    conversation: params.conversationId,
  })
    .sort({ date: -1, _id: -1 })
    .limit(INBOUND_BURST_RECENT_MESSAGE_LIMIT)
    .select("_id direction date author text")
    .lean<LeanBurstMessage[]>();

  if (!Array.isArray(recentMessages) || recentMessages.length === 0) {
    return {
      shouldProcess: true,
      burstText: "",
      burstMessageIds: [params.currentMessageId],
      latestBurstMessageId: params.currentMessageId,
    };
  }

  const chronologicalMessages = [...recentMessages].sort(
    compareMessagesChronologically
  );
  const currentIndex = chronologicalMessages.findIndex(
    message => String(message._id || "") === params.currentMessageId
  );

  if (currentIndex === -1) {
    return {
      shouldProcess: true,
      burstText: "",
      burstMessageIds: [params.currentMessageId],
      latestBurstMessageId: params.currentMessageId,
    };
  }

  for (
    let index = currentIndex + 1;
    index < chronologicalMessages.length;
    index += 1
  ) {
    const message = chronologicalMessages[index];
    if (isCustomerInboundMessage(message)) {
      return {
        shouldProcess: false,
        reason: "superseded_by_newer_inbound_burst",
        burstOwnerMessageId: String(message._id || ""),
      };
    }

    if (isOutboundMessage(message)) {
      return {
        shouldProcess: false,
        reason: "already_answered_by_prior_outbound",
        answeredByMessageId: String(message._id || ""),
      };
    }
  }

  const burstMessages: LeanBurstMessage[] = [
    chronologicalMessages[currentIndex],
  ];
  let pivotDate = readDate(chronologicalMessages[currentIndex]?.date);

  for (let index = currentIndex - 1; index >= 0; index -= 1) {
    const candidate = chronologicalMessages[index];
    if (isOutboundMessage(candidate)) {
      break;
    }

    if (!isCustomerInboundMessage(candidate)) {
      break;
    }

    const candidateDate = readDate(candidate.date);
    if (!candidateDate || !pivotDate) {
      break;
    }

    if (
      pivotDate.getTime() - candidateDate.getTime() >
      INBOUND_BURST_WINDOW_MS
    ) {
      break;
    }

    burstMessages.unshift(candidate);
    pivotDate = candidateDate;
  }

  return {
    shouldProcess: true,
    burstText: buildBurstText(burstMessages),
    burstMessageIds: burstMessages.map(message => String(message._id || "")),
    latestBurstMessageId: String(
      burstMessages[burstMessages.length - 1]?._id || params.currentMessageId
    ),
  };
}
