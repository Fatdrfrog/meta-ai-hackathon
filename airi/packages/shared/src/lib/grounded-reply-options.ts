import type { GroundedReplyOption } from "../types/message-preview";

export function buildGroundedReplyOptionCallbackKey(index: number): string {
  return `o${Math.max(0, Math.floor(index))}`;
}

export function appendGroundedReplyOptionsInlineText(params: {
  reply: string;
  options?: GroundedReplyOption[] | null;
}): string {
  const options = Array.isArray(params.options)
    ? params.options
        .map((option) => String(option?.label || "").trim())
        .filter(Boolean)
        .slice(0, 4)
    : [];
  if (options.length === 0) {
    return params.reply;
  }

  return [
    params.reply.trim(),
    options.map((option, index) => `${index + 1}. ${option}`).join("\n"),
  ]
    .filter(Boolean)
    .join("\n\n");
}
