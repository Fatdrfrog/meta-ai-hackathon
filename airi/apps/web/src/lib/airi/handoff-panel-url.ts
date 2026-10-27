/**
 * Deep link to panel inbox for a conversation (requests master-detail).
 */
export function buildHandoffPanelUrl(
  workspaceId: string,
  conversationId: string
): string {
  const base = (
    process.env.NEXT_PUBLIC_APP_URL || "https://www.airi.chat"
  ).replace(/\/$/, "");
  const q = new URLSearchParams({ conversation: conversationId });
  return `${base}/panel/w/${encodeURIComponent(workspaceId)}/requests?${q}`;
}
