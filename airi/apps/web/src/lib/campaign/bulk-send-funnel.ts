import { captureFunnelEvent } from "@/lib/funnel-analytics";

/** Filled by the bulk-send handler as it learns who is sending what. */
export type BulkSendAnalyticsContext = {
  userId?: string;
  workspaceId?: string;
  channel?: string;
  source?: "page" | "scenario";
  requestedRecipients?: number;
  scheduled?: boolean;
};

export type BulkSendFunnelOutcome =
  | {
      event: "campaign_queued";
      scheduled: boolean;
      accepted: number | null;
      requested: number | null;
      campaignId: string | null;
    }
  | { event: "campaign_send_blocked"; code: string; status: number };

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

/**
 * Reads the route's final response: the success body carries the legacy
 * aliases from serializeBulkCampaignCommandResult, refusals carry `code`.
 */
export function classifyBulkSendFunnelOutcome(
  status: number,
  body: unknown
): BulkSendFunnelOutcome | null {
  const record =
    body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
  const succeeded = status >= 200 && status < 300 && record.ok !== false;

  if (succeeded) {
    if (record.noOp === true) {
      return { event: "campaign_send_blocked", code: "no_op", status };
    }
    if (record.queued === true || record.success === true) {
      return {
        event: "campaign_queued",
        scheduled: record.scheduled === true,
        accepted: readNumber(record.successful),
        requested: readNumber(record.requestedTotal),
        campaignId: readString(record.campaignId),
      };
    }
    return null;
  }

  return {
    event: "campaign_send_blocked",
    code: readString(record.code) ?? `http_${status}`,
    status,
  };
}

export async function captureBulkSendFunnelOutcome(
  context: BulkSendAnalyticsContext,
  response: Response
): Promise<void> {
  // Refusals before workspace access was verified are not funnel steps.
  if (!context.userId || !context.workspaceId) return;
  const body: unknown = await response
    .clone()
    .json()
    .catch(() => null);
  const outcome = classifyBulkSendFunnelOutcome(response.status, body);
  if (!outcome) return;

  const shared = {
    channel: context.channel,
    source: context.source,
    requested_recipients: context.requestedRecipients,
  };
  if (outcome.event === "campaign_queued") {
    await captureFunnelEvent({
      event: "campaign_queued",
      userId: context.userId,
      workspaceId: context.workspaceId,
      properties: {
        ...shared,
        scheduled: outcome.scheduled || context.scheduled === true,
        accepted_recipients: outcome.accepted,
      },
      // Idempotent replays return the same campaign; count it once.
      ...(outcome.campaignId
        ? { insertId: `campaign_queued:${outcome.campaignId}` }
        : {}),
    });
    return;
  }

  await captureFunnelEvent({
    event: "campaign_send_blocked",
    userId: context.userId,
    workspaceId: context.workspaceId,
    properties: { ...shared, code: outcome.code, status: outcome.status },
  });
}
