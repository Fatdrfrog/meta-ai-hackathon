import type { InstagramHumanAgentCapability } from "@/lib/instagram/human-agent";

export function isReplyComposerDisabled(params: {
  isConversationResolved: boolean;
  channel?: string;
  requiresWindowCheck: boolean;
  isWithinWindow?: boolean;
  humanAgent?: InstagramHumanAgentCapability | null;
  // The messaging account cannot send (for example an incomplete WhatsApp
  // phone registration), so every reply would fail at the provider.
  accountCannotSend?: boolean;
}): boolean {
  if (params.isConversationResolved) return true;
  if (params.accountCannotSend) return true;
  if (!params.requiresWindowCheck) return false;

  // Keep composer enabled until window is explicitly expired.
  if (params.isWithinWindow !== false) return false;

  // Instagram can continue with manual Human Agent replies when enabled.
  if (params.channel === "instagram" && params.humanAgent?.enabled) {
    return false;
  }

  return true;
}
