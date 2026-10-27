import { isAutomatedOutboundOriginKind } from "@/lib/conversation-message-denorm";
import Message from "@/models/message";
import User from "@/models/user";

type PopulatedAuthor = {
  _id?: unknown;
  isBot?: boolean;
};

type LeanRecentOutboundMessage = {
  _id: unknown;
  author?: unknown;
  date?: Date | string | null;
  origin?: {
    kind?: string | null;
  } | null;
};

async function resolveAuthorIsBot(
  authorId: string,
  userBotCache: Map<string, boolean>
): Promise<boolean> {
  if (userBotCache.has(authorId)) {
    return Boolean(userBotCache.get(authorId));
  }

  const userDoc = await User.findById(authorId)
    .select("isBot")
    .lean<{ isBot?: boolean } | null>();
  const isBot = Boolean(userDoc?.isBot);
  userBotCache.set(authorId, isBot);
  return isBot;
}

export async function findRecentHumanOutboundAuthor(params: {
  conversationId: string;
  since: Date;
  until?: Date;
  limit?: number;
}): Promise<string | undefined> {
  const dateFilter: { $gte: Date; $lte?: Date } = {
    $gte: params.since,
  };
  if (params.until) {
    dateFilter.$lte = params.until;
  }

  const recentOutboundMessages = await Message.find({
    conversation: params.conversationId,
    direction: "outbound",
    date: dateFilter,
  })
    .select("_id author date origin.kind")
    .sort({ date: -1 })
    .limit(params.limit ?? 20)
    .populate({ path: "author", select: "_id isBot" })
    .lean<Array<LeanRecentOutboundMessage>>();

  if (
    !Array.isArray(recentOutboundMessages) ||
    recentOutboundMessages.length === 0
  ) {
    return undefined;
  }

  const userBotCache = new Map<string, boolean>();

  for (const message of recentOutboundMessages) {
    if (isAutomatedOutboundOriginKind(message.origin?.kind)) {
      continue;
    }

    const authorValue = message.author;
    if (authorValue === null || authorValue === undefined) {
      continue;
    }

    let authorId: string | undefined;
    let isBot: boolean | undefined;

    if (
      typeof authorValue === "object" &&
      authorValue !== null &&
      "_id" in (authorValue as Record<string, unknown>)
    ) {
      const authorObj = authorValue as PopulatedAuthor;
      if (authorObj._id !== null && authorObj._id !== undefined) {
        authorId = String(authorObj._id);
      }
      if (typeof authorObj.isBot === "boolean") {
        isBot = authorObj.isBot;
      }
    } else {
      authorId = String(authorValue);
    }

    if (!authorId || authorId === "0") {
      continue;
    }

    if (typeof isBot !== "boolean") {
      isBot = await resolveAuthorIsBot(authorId, userBotCache);
    }

    if (isBot) {
      continue;
    }

    return authorId;
  }

  return undefined;
}

export async function hasHumanOutboundSince(params: {
  conversationId: string;
  since: Date;
  until?: Date;
  limit?: number;
}): Promise<boolean> {
  const authorId = await findRecentHumanOutboundAuthor(params);
  return Boolean(authorId);
}
