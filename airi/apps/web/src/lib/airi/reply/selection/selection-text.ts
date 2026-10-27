import { stripAiriPrefix } from "@/lib/airi/reply/thread/reply-text-utils";

export function trimSelectionLabelText(text: string): string {
  return stripAiriPrefix(text)
    .replace(/\s+/g, " ")
    .replace(/^[\u2014\u2013\-:\s]+/u, "")
    .replace(/[.?!,;:\s]+$/u, "")
    .trim();
}
