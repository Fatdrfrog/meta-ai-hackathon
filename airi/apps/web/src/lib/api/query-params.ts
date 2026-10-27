export function parsePositiveInt(
  value: unknown,
  fallback: number,
  min: number,
  max: number
): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

/** First value of a Next.js page searchParam (`string | string[]`). */
export function firstSearchParam(
  value?: string | string[]
): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** The first value trimmed, or "" when the param is absent. */
export function trimmedSearchParam(value?: string | string[]): string {
  return firstSearchParam(value)?.trim() ?? "";
}

/** The trimmed body `workspaceId` when set, else the trimmed `workspaceId` query param. */
export function readBodyOrQueryWorkspaceId(
  request: Request,
  body?: Record<string, unknown>
) {
  const url = new URL(request.url);
  const fromQuery = url.searchParams.get("workspaceId")?.trim();
  const fromBody =
    typeof body?.workspaceId === "string" ? body.workspaceId.trim() : "";
  return fromBody || fromQuery;
}
