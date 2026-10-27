import type { CampaignOperationStatusResponse } from "@/lib/campaign/campaign-operations-contracts";

/** Recipients and provider attempts have deliberately separate denominators. */
export type BulkCampaignRecipientHealth = {
  planned: number;
  attempted: number;
  accepted: number;
  delivered: number;
  read: number;
  failed: number;
  awaitingReceipts: number;
  uncertain: number;
  untouched: number;
};
export type BulkCampaignAttemptHealth = {
  accepted: number;
  delivered: number;
  read: number;
  failed: number;
  awaitingReceipts: number;
  uncertain: number;
};
export type BulkCampaignHealthCoverage = {
  complete: boolean;
  reasons: string[];
  scannedRows: number;
  rowLimit: number;
  /** Earliest retained evidence observed; this is not a retention guarantee. */
  retainedSince: string | null;
};
export type BulkCampaignHealthError = {
  code: string | null;
  message: string | null;
  count: number;
};
export type BulkCampaignHealthResponse = {
  observedAt: string;
  family: {
    rootCampaignId: string;
    campaignIds: string[];
    campaigns: Array<{
      id: string;
      name: string;
      status: string | null;
      totalRecipients: number;
      operation: CampaignOperationStatusResponse | null;
    }>;
  };
  /** Exact metrics are unavailable when any identity or scan is incomplete. */
  recipients: { [K in keyof BulkCampaignRecipientHealth]: number | null };
  attempts: { [K in keyof BulkCampaignAttemptHealth]: number | null };
  observed: {
    /** Sampled states can overcount failed/awaiting/uncertain/untouched when
     * newer attempts are outside coverage; these are not lower bounds. */
    recipients: BulkCampaignRecipientHealth;
    attempts: BulkCampaignAttemptHealth;
  };
  errors: BulkCampaignHealthError[];
  coverage: BulkCampaignHealthCoverage;
};
export type BulkRecipientEvidenceAttempt = {
  campaignId: string | null;
  sourceId: string | null;
  messageId: string | null;
  attemptedAt: string | null;
  status: "untouched" | "uncertain" | "accepted" | "delivered" | "read" | "failed";
  deliveredAt: string | null;
  readAt: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  disputedIdentity: boolean;
};
export type BulkRecipientEvidenceResponse = {
  observedAt: string;
  latestOutcome: BulkRecipientEvidenceAttempt["status"] | null;
  attempts: BulkRecipientEvidenceAttempt[];
  evidence: {
    acceptedWithoutDeliveryProof: boolean;
    delivered: boolean;
    read: boolean;
    priorFailure: boolean;
    disputedIdentity: boolean;
  };
  coverage: BulkCampaignHealthCoverage;
};
