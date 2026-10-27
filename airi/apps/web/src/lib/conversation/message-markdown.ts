/**
 * Normalize chat message text before `marked` lexing.
 * Escapes leading `N.` markers so invoice/account ids like
 * `140560. Name` stay literal instead of becoming ordered lists.
 */
export function normalizeMessageMarkdown(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/:\s+(?=\d+\.\s)/g, ":\n")
    .replace(/([.!?])\s+(?=(?:\d+\.\s+|[-*]\s+))/g, "$1\n")
    .replace(/:\s+(?=\[[^\]]+\]\((?:https?:\/\/|\/))/gi, ":\n")
    .trim()
    .replace(
      /(^|\n)(\d+)\.(?=\s|$)/g,
      (_match, prefix: string, digits: string) => `${prefix}${digits}\\.`
    );
}
