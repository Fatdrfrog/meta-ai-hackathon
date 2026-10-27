import { isIntegrationReactionStubMessage } from "@/lib/airi/reply/thread/reply-text-utils";

const ACKNOWLEDGMENT_PATTERN = /^(?:ok|thanks|thank you|got it|i see)$/i;

function isAcknowledgment(msg: string): boolean {
  return ACKNOWLEDGMENT_PATTERN.test(msg);
}

export type ConversationQueryMode = "adaptive" | "last_message_only";

type BuildConversationQueryOptions = {
  mode?: ConversationQueryMode;
  includeHistoryInContext?: boolean;
};

/**
 * Builds a structured RAG query from a text window + last customer message (coach UI).
 * Prefers the latest substantive message when the last line is noise (ack / reaction stub).
 */
export function buildQueryFromConversation(
  window: string,
  lastMsg: string,
  options: BuildConversationQueryOptions = {}
): {
  query: string;
  context: string;
  lastMessageQuery: string;
  mode: ConversationQueryMode;
} {
  const mode = options.mode ?? "adaptive";
  const includeHistoryInContext = options.includeHistoryInContext ?? true;
  const normalizedLastMessage = (lastMsg || "").trim();

  if (!window.trim()) {
    return {
      query: normalizedLastMessage,
      context: "",
      lastMessageQuery: normalizedLastMessage,
      mode,
    };
  }

  const lines = window.split("\n").filter(l => l.trim());
  const recent = lines.slice(-10);

  const customerThreads = recent
    .map(line => line.match(/\[CUSTOMER\]\s*(.+)$/)?.[1]?.trim())
    .filter(
      (msg): msg is string =>
        !!msg &&
        msg.length > 5 &&
        !isAcknowledgment(msg) &&
        !isIntegrationReactionStubMessage(msg)
    );

  const lastMessageQuery = normalizedLastMessage;
  let query = normalizedLastMessage;
  if (
    mode === "adaptive" &&
    (isIntegrationReactionStubMessage(normalizedLastMessage) ||
      isAcknowledgment(normalizedLastMessage))
  ) {
    const latestSubstantive = customerThreads[customerThreads.length - 1];
    if (latestSubstantive) {
      query = latestSubstantive;
    }
  }

  if (mode === "adaptive" && customerThreads.length > 1) {
    const top3 = customerThreads.slice(-3);
    const lastIsSubstantive = normalizedLastMessage.length >= 30;
    const isStandaloneQuestion =
      normalizedLastMessage.endsWith("?") ||
      /^(what|how|why|where|when|who|which)\s+(is|are|does|do|can)\s+/i.test(
        normalizedLastMessage
      );
    if (
      lastIsSubstantive ||
      (isStandaloneQuestion && normalizedLastMessage.length >= 8)
    ) {
      query = normalizedLastMessage;
    } else if (normalizedLastMessage.length < 25) {
      query = `${top3[top3.length - 2] || ""}. ${normalizedLastMessage}`.trim();
    } else {
      query = top3.join(". ").trim();
    }
  }

  const context = includeHistoryInContext
    ? recent
        .map(line => line.replace(/^\d{4}-\d{2}-\d{2}T[\d:.-]+Z\s*/, ""))
        .join("\n")
    : "";

  const resolvedQuery = query || lastMessageQuery;
  return {
    query: resolvedQuery.slice(0, 400),
    context,
    lastMessageQuery: lastMessageQuery.slice(0, 400),
    mode,
  };
}
