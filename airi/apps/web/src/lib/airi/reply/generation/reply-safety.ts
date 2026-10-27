import { stripAiriPrefix } from "@/lib/airi/reply/thread/reply-text-utils";

type FinalizeAssistantReplyParams = {
  reply: string;
};

export type FinalizeAssistantReplyResult = {
  reply: string;
  wasTrimmed: boolean;
};

export function finalizeAssistantReplyForDelivery(
  params: FinalizeAssistantReplyParams
): FinalizeAssistantReplyResult {
  const rawReply = String(params.reply || "");
  const reply = stripAiriPrefix(rawReply.trim());

  return {
    reply,
    wasTrimmed: reply !== rawReply,
  };
}

export function formatFinalizedAssistantReplyForOutbound(params: {
  reply: string;
  includeAssistantPrefix: boolean;
}): string {
  if (!params.reply) return "";
  return params.includeAssistantPrefix ? `Airi: ${params.reply}` : params.reply;
}
