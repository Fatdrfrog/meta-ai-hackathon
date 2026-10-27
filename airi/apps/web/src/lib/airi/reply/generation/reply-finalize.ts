import { normalizeReplyText } from "@/lib/airi/reply/generation/reply-text-sanitize";
import { stripDuplicateGreetingLead } from "@/lib/airi/reply/generation/strip-duplicate-greeting-lead";
import { MAX_REPLY_CHAR_LIMIT } from "@/lib/airi/shared/token-budget";

export function finalizeReplyText(
  raw: string,
  options?: { alreadyGreetedToday?: boolean }
): string {
  let reply = normalizeReplyText(
    String(raw || "").trim(),
    MAX_REPLY_CHAR_LIMIT
  );

  if (options?.alreadyGreetedToday) {
    reply = stripDuplicateGreetingLead(reply, true);
  }

  return reply;
}
