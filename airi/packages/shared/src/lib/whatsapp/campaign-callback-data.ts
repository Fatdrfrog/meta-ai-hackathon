export type CampaignCallbackData = {
  kind: "campaign";
  campaignId: string;
  workspaceId: string;
  taskId?: string;
};

export type BuildCampaignCallbackDataInput = {
  campaignId: string;
  workspaceId: string;
  taskId?: string | null;
};

const MAX_CALLBACK_BYTES = 512;

/**
 * Opaque payload echoed by Meta on status webhooks (`biz_opaque_callback_data`).
 * Keep ≤512 bytes per Cloud API limit.
 */
export function buildCampaignCallbackData(
  input: BuildCampaignCallbackDataInput,
): string | null {
  const campaignId = String(input.campaignId || "").trim();
  const workspaceId = String(input.workspaceId || "").trim();
  if (!campaignId || !workspaceId) {
    return null;
  }

  const taskId =
    typeof input.taskId === "string" && input.taskId.trim()
      ? input.taskId.trim()
      : null;

  const payload: { k: "cmp"; c: string; w: string; t?: string } = {
    k: "cmp",
    c: campaignId,
    w: workspaceId,
    ...(taskId ? { t: taskId } : {}),
  };

  const encoded = JSON.stringify(payload);
  if (Buffer.byteLength(encoded, "utf8") > MAX_CALLBACK_BYTES) {
    return null;
  }

  return encoded;
}

export function parseCampaignCallbackData(
  raw: string | null | undefined,
): CampaignCallbackData | null {
  if (!raw || typeof raw !== "string") {
    return null;
  }
  const trimmed = raw.trim();
  if (!trimmed || trimmed[0] !== "{") {
    return null;
  }
  if (Buffer.byteLength(trimmed, "utf8") > MAX_CALLBACK_BYTES) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") {
    return null;
  }

  const obj = parsed as Record<string, unknown>;
  if (obj.k !== "cmp") {
    return null;
  }
  const campaignId = typeof obj.c === "string" ? obj.c.trim() : "";
  const workspaceId = typeof obj.w === "string" ? obj.w.trim() : "";
  if (!campaignId || !workspaceId) {
    return null;
  }
  const taskId =
    typeof obj.t === "string" && obj.t.trim() ? obj.t.trim() : undefined;

  return {
    kind: "campaign",
    campaignId,
    workspaceId,
    ...(taskId ? { taskId } : {}),
  };
}
