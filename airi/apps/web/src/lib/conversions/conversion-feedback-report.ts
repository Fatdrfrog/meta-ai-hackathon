import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { MetaConversionDeliveryStatus } from "@icecore/shared/types/conversion-events";
import { isNonNegativeSafeInteger as isCount } from "@icecore/shared/lib/value-utils";

export type ConversionFeedbackReport = {
  recorded: number;
  eligible: number;
  statuses: Record<MetaConversionDeliveryStatus, number>;
  oldestPendingAt: string | null;
  reasons: Array<{
    status: MetaConversionDeliveryStatus;
    reason: string | null;
    count: number;
  }>;
  truncated: boolean;
};

const deliveryStatuses: MetaConversionDeliveryStatus[] = [
  "not_eligible",
  "pending",
  "queued",
  "sent",
  "rejected",
  "delivery_unknown",
];

export async function getConversionFeedbackReport(input: {
  supabase: SupabaseClient;
  workspaceId: string;
  start: string;
  end: string;
  sourceId?: string | null;
  timeZone?: string;
}): Promise<ConversionFeedbackReport> {
  const { data, error } = await input.supabase.rpc(
    "get_conversion_feedback_report",
    {
      p_workspace_id: input.workspaceId,
      p_start: input.start,
      p_end: input.end,
      p_source_id: input.sourceId || null,
      p_timezone: input.timeZone || "UTC",
    }
  );
  const statuses = data?.statuses;
  const validStatuses =
    statuses &&
    typeof statuses === "object" &&
    deliveryStatuses.every(status => isCount(statuses[status]));
  const validReasons =
    Array.isArray(data?.reasons) &&
    data.reasons.length <= 100 &&
    data.reasons.every((item: unknown) => {
      if (!item || typeof item !== "object") return false;
      const reason = item as Record<string, unknown>;
      return (
        deliveryStatuses.includes(
          reason.status as MetaConversionDeliveryStatus
        ) &&
        isCount(reason.count) &&
        (reason.reason === null ||
          (typeof reason.reason === "string" && reason.reason.length <= 500))
      );
    });
  if (
    error ||
    !data ||
    !isCount(data.recorded) ||
    !isCount(data.eligible) ||
    !validStatuses ||
    !validReasons ||
    deliveryStatuses.reduce((sum, status) => sum + statuses[status], 0) !==
      data.recorded ||
    data.eligible !== data.recorded - statuses.not_eligible ||
    typeof data.truncated !== "boolean" ||
    !(
      data.oldestPendingAt === null ||
      (typeof data.oldestPendingAt === "string" &&
        Number.isFinite(Date.parse(data.oldestPendingAt)))
    )
  ) {
    throw new Error("Failed to load conversion feedback");
  }
  return data as ConversionFeedbackReport;
}
