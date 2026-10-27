import { createHash } from "node:crypto";
import type { ServiceLifecycleCoverage } from "./service-lifecycle-consumer";

export type AcquisitionEntryInput = {
  workspaceId: string;
  conversationId: string;
  sourceId: string | null;
  channel: string;
  capturedAt: Date;
  messageId?: string;
  referral?: {
    sourceType?: string | null;
    sourceId?: string | null;
    ctwaClid?: string | null;
  } | null;
};

/** First creation and later ad-entry episodes intentionally have distinct identities. */
export function acquisitionEntry(input: AcquisitionEntryInput) {
  const isAd = input.referral?.sourceType === "ad";
  const click = input.referral?.ctwaClid?.trim();
  const identity = isAd
    ? [
        "ad",
        input.workspaceId,
        input.conversationId,
        click || input.messageId || input.conversationId,
      ]
    : ["organic", input.workspaceId, input.conversationId];
  return {
    entryKey: createHash("sha256")
      .update(JSON.stringify(identity))
      .digest("hex"),
    workspaceId: input.workspaceId,
    conversationId: input.conversationId,
    sourceId: input.sourceId,
    channel: input.channel,
    capturedAt: input.capturedAt,
    entryOrder: input.messageId || input.conversationId,
    sourceMessageId: isAd ? input.messageId || null : null,
    kind: isAd ? ("ad" as const) : ("organic" as const),
    adId: isAd ? input.referral?.sourceId?.trim() || null : null,
    identityCoverage: isAd
      ? click
        ? ("click" as const)
        : ("message" as const)
      : ("conversation" as const),
  };
}

export { comparableEfficiency } from "./acquisition-efficiency";

export type AcquisitionCohortRow = {
  kind: "ad" | "organic";
  sourceId: string | null;
  adId: string | null;
  entries: number;
  engaged: number;
  qualified: number;
  qualifiedPaid: number;
  booked: number;
  paid: number;
  pendingObservation: number;
  currencies: Array<{
    currency: string;
    sales: number;
    refunds: number;
    grossRevenue: number | null;
    refundedRevenue: number | null;
    netRevenue: number | null;
    unknownValues: number;
  }>;
};
export type AcquisitionReport = {
  window: { start: string; end: string; observationDays: 7 | 30; asOf: string };
  policy: { qualifiedStageKeys: string[]; revision: number };
  coverage: {
    status: "ready" | "backfilling" | "stale" | "unavailable";
    projectedThrough: string | null;
    conversionThrough: string | null;
    reconciliationThrough: string | null;
    identityMissing: number;
    truncated: boolean;
    qualification: "recorded_events";
    qualificationHistory: ServiceLifecycleCoverage;
  };
  cohorts: AcquisitionCohortRow[];
  flows: Array<{
    flowId: string | null;
    sent: number;
    delivered: number;
    read: number;
    submitted: number;
    qualified: number;
    paid: number;
  }>;
  retention: Array<{
    cohortMonth: string;
    currency: string;
    customers: number;
    repeatCustomers: number;
    sales: number;
    grossRevenue: number | null;
    refundedRevenue: number | null;
    netRevenue: number | null;
    unknownValues: number;
    pendingCustomers: number;
  }>;
  retentionMissingIdentity: number;
};
