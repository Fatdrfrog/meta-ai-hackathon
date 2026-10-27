import { parseDate } from "../../internal/value-normalization";
import {
  normalizeMissingTextPhrases,
  normalizeMissingTextSearchText,
} from "@icecore/scenario-contracts";
import type { AiriScenarioTimerDependencies } from "../dependencies";

const MAX_TIMER_TEXT_SCAN_MESSAGES = 200;
type MessageDependencies = Pick<
  AiriScenarioTimerDependencies,
  "findLatestMessageAfter" | "findTextMessagesAfter"
>;

async function scanConversationMessagesAfter(
  params: {
    conversationId: string;
    after: Date;
    checkLatestMessageDate?: boolean;
    phrases?: unknown;
  },
  dependencies: MessageDependencies,
): Promise<{
  matchedTextPhrase: boolean;
  latestMessageDate: Date | null;
}> {
  const phrases = normalizeMissingTextPhrases(params.phrases)
    .map((phrase) => normalizeMissingTextSearchText(phrase))
    .filter(Boolean);

  const [latestMessage, textMessages] = await Promise.all([
    params.checkLatestMessageDate
      ? dependencies.findLatestMessageAfter({
          conversationId: params.conversationId,
          after: params.after,
        })
      : Promise.resolve(null),
    phrases.length > 0
      ? dependencies.findTextMessagesAfter({
          conversationId: params.conversationId,
          after: params.after,
          limit: MAX_TIMER_TEXT_SCAN_MESSAGES,
        })
      : Promise.resolve([]),
  ]);

  let matchedTextPhrase = false;
  for (const message of textMessages) {
    const haystack = normalizeMissingTextSearchText(message.text);
    if (!haystack) continue;
    if (phrases.some((phrase) => haystack.includes(phrase))) {
      matchedTextPhrase = true;
      break;
    }
  }

  return {
    matchedTextPhrase,
    latestMessageDate: parseDate(latestMessage?.date) || null,
  };
}

export async function scanPostActionTimerWindow(
  params: {
    conversationId: string;
    after: Date;
    phrases?: unknown;
  },
  dependencies: MessageDependencies,
): Promise<{
  matchedTextPhrase: boolean;
  latestMessageDate: Date | null;
}> {
  const scan = await scanConversationMessagesAfter(
    {
      ...params,
      checkLatestMessageDate: true,
    },
    dependencies,
  );

  return {
    matchedTextPhrase: scan.matchedTextPhrase,
    latestMessageDate: scan.latestMessageDate,
  };
}

export async function findLatestConversationMessageDateAfter(
  params: {
    conversationId: string;
    after: Date;
  },
  dependencies: MessageDependencies,
): Promise<Date | null> {
  const scan = await scanConversationMessagesAfter(
    {
      ...params,
      checkLatestMessageDate: true,
    },
    dependencies,
  );

  return scan.latestMessageDate;
}
