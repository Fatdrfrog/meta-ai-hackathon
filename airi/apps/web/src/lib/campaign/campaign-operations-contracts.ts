import type { BulkCampaignDispatchLifecycleState } from "@icecore/temporal";

type BulkCampaignDispatchStatus = BulkCampaignDispatchLifecycleState;

const ACTIVE_BULK_CAMPAIGN_DISPATCH_STATUSES =
  new Set<BulkCampaignDispatchStatus>(["queued", "scheduled", "running"]);
const TERMINAL_BULK_CAMPAIGN_DISPATCH_STATUSES =
  new Set<BulkCampaignDispatchStatus>([
    "completed",
    "failed",
    "expired",
    "cancelled",
  ]);

export function isActiveBulkCampaignDispatchStatus(
  status: BulkCampaignDispatchStatus | null | undefined
) {
  return Boolean(status && ACTIVE_BULK_CAMPAIGN_DISPATCH_STATUSES.has(status));
}

export function isTerminalBulkCampaignDispatchStatus(
  status: BulkCampaignDispatchStatus | null | undefined
) {
  return Boolean(
    status && TERMINAL_BULK_CAMPAIGN_DISPATCH_STATUSES.has(status)
  );
}

export type CampaignOperationProviderCircuit = {
  state: "open" | "closed";
  provider: string | null;
  code: string | null;
  openedAt: string | null;
  failureCount: number;
  requiresAcknowledgement: boolean;
};

export type CampaignOperationStatusResponse = {
  campaignId: string;
  status: BulkCampaignDispatchLifecycleState;
  requestedAt: string | null;
  scheduledAt: string | null;
  dispatchExpiresAt: string | null;
  startedAt: string | null;
  progressAt: string | null;
  finishedAt: string | null;
  cancelledAt: string | null;
  expiredAt: string | null;
  totalRecipients: number;
  progress: {
    processed: number;
    accepted: number;
    attempted: number;
    notAttempted: number;
    successful: number;
    failed: number;
  };
  delivery: {
    pending: number;
    accepted: number;
    delivered: number;
    read: number;
    failed: number;
  };
  stopReason: string | null;
  providerCircuit: CampaignOperationProviderCircuit;
  retry: {
    ofCampaignId: string | null;
    kind: "failed_only" | "send_again" | null;
    failedRecipientCount: number;
    available: boolean;
  };
  canCancel: boolean;
  paused: boolean;
};

/**
 * `delivery` counts each message once, in its latest status, so a read message
 * is no longer "delivered". Screens label the counts as a funnel, where each
 * step includes the messages that moved past it.
 */
export function getCampaignDeliveryFunnel(
  delivery: CampaignOperationStatusResponse["delivery"]
) {
  const delivered = delivery.delivered + delivery.read;
  return {
    accepted: delivery.accepted + delivered,
    delivered,
    read: delivery.read,
  };
}

export type CampaignCancellationResponse = {
  campaignId: string;
  status: "cancelled";
  outcome: "cancelled" | "already_cancelled";
  temporalCancellation: "cancelled" | "already_closed";
};

export type CampaignPauseResponse = {
  campaignId: string;
  status: BulkCampaignDispatchLifecycleState;
  paused: boolean;
  outcome: "paused" | "resumed" | "already_paused" | "already_resumed";
};

export type CampaignFailedOnlyRetryResponse = {
  queued: true;
  /** Failed recipients left out because they were contacted too recently. */
  skippedRecentContact?: number;
  scheduled: boolean;
  total: number;
  campaignId: string;
  dispatchId: string;
  workflowId: string;
  status: BulkCampaignDispatchLifecycleState;
  requestedAt: string;
  dispatchExpiresAt: string;
  temporalDispatchStaging: "inline" | "gcs" | "existing";
  idempotentReplay: boolean;
  audience: {
    fingerprint: string;
    requestedTotal: number;
    queuedTotal: number;
    skippedOptIn: number;
    overlap?: {
      kind: "none" | "high" | "exact" | "unknown";
      intersectionCount: number;
      candidateCount: number;
      ratio: number;
    };
  };
  audienceConfirmation: {
    required: boolean;
    confirmed: boolean;
    fingerprint: string;
  };
  retry: {
    kind: "failed_only";
    ofCampaignId: string;
    providerCircuit:
      | {
          state: "open";
          provider: string;
          code: string;
          failureCount: number;
          acknowledged: true;
        }
      | {
          state: "closed";
          acknowledged: false;
        };
  };
};

export type CampaignRetryContactCooldownResponse = {
  code: "retry_contact_cooldown";
  error: string;
  cooldown: {
    blockedRecipientCount: number;
    eligibleRecipientCount: number;
    /** Local policy eligibility for the whole audience; provider recovery is separate. */
    nextEligibleAt: string | null;
  };
};

export type CampaignContactCooldownResponse = Omit<
  CampaignRetryContactCooldownResponse,
  "code"
> & {
  code: "campaign_contact_cooldown";
  /** Server time of the local contact check, independent of merged provider health. */
  evaluatedAt?: string;
  readiness: import("@icecore/scenario-contracts").BulkCampaignReadiness;
};
