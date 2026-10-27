export const CRM_BOARD_REALTIME_DEBOUNCE_MS = 300;

export const CRM_BOARD_REALTIME_EVENT_NAMES = [
  "conversation.row.changed",
  "crm.board.changed",
] as const;

export function isCrmRealtimeCacheKey(
  key: unknown,
  workspaceId: string
): boolean {
  if (typeof key !== "string" || !workspaceId) return false;

  if (
    key.includes(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/crm/board`
    )
  ) {
    return true;
  }

  if (!key.startsWith("/api/customers?")) return false;
  return (
    new URL(key, "https://airi.local").searchParams.get("workspaceId") ===
    workspaceId
  );
}
