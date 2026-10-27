import type { BulkCampaignDispatchItem } from "@icecore/temporal";
import {
  buildBulkCampaignDispatchLogicalRecipientKey,
  buildBulkCampaignDispatchWorkflowId,
} from "@icecore/temporal";

import { sanitizeBulkCampaignDispatchSnapshot } from "./bulk-campaign-admission";
import { createPreparedBulkCampaignContentHash } from "./bulk-campaign-content-hash";
import type { CampaignStoreClient } from "./campaign-history-store";

const DEFAULT_RECOVERY_PAGE_SIZE = 500;
const MAX_RECOVERY_PAGE_SIZE = 1000;
const CAMPAIGN_DISPATCH_STATUSES = new Set([
  "queued",
  "scheduled",
  "running",
  "completed",
  "failed",
  "expired",
  "cancelled",
] as const);

type AdmittedCampaignRecoveryChannel = "whatsapp" | "telegram" | "email";
type AdmittedCampaignRecoveryDispatchStatus =
  | "queued"
  | "scheduled"
  | "running"
  | "completed"
  | "failed"
  | "expired"
  | "cancelled";

type StoreError = { message?: string | null };
type StoreResult<T> = {
  data?: T | null;
  error?: StoreError | null;
};

type CampaignHistoryRecoveryRow = {
  id?: unknown;
  workspace_id?: unknown;
  scenario_id?: unknown;
  scenario_node_id?: unknown;
  execution_source?: unknown;
  sent_by?: unknown;
  channel?: unknown;
  dispatch_status?: unknown;
  workflow_id?: unknown;
  total_recipients?: unknown;
  requested_at?: unknown;
  scheduled_at?: unknown;
  dispatch_expires_at?: unknown;
  audience_count?: unknown;
  audience_fingerprint?: unknown;
  audience_hash_version?: unknown;
  audience_source_type?: unknown;
  audience_content_hash?: unknown;
};

type CampaignMessageRecoveryRow = {
  campaign_id?: unknown;
  scenario_id?: unknown;
  scenario_node_id?: unknown;
  execution_source?: unknown;
  channel?: unknown;
  snapshot_ordinal?: unknown;
  recipient_hash?: unknown;
  dispatch_snapshot?: unknown;
};

type HistoryRecoveryQuery = {
  eq: (column: string, value: string) => HistoryRecoveryQuery;
  maybeSingle: () => Promise<StoreResult<CampaignHistoryRecoveryRow>>;
};

type HistoryRecoveryTable = {
  select: (columns: string) => HistoryRecoveryQuery;
};

type MessageRecoveryQuery = {
  eq: (column: string, value: string) => MessageRecoveryQuery;
  gt: (column: string, value: number) => MessageRecoveryQuery;
  order: (
    column: string,
    options: { ascending: boolean }
  ) => MessageRecoveryQuery;
  limit: (count: number) => Promise<StoreResult<CampaignMessageRecoveryRow[]>>;
};

type MessageRecoveryTable = {
  select: (columns: string) => MessageRecoveryQuery;
};

type AdmittedCampaignLedgerRecoveryResult =
  | { status: "not_admitted" }
  | {
      status: "admitted";
      campaign: {
        campaignId: string;
        workspaceId: string;
        scenarioId: string | null;
        scenarioNodeId: string | null;
        executionSource: string | null;
        sentBy: string;
        channel: AdmittedCampaignRecoveryChannel;
        dispatchStatus: AdmittedCampaignRecoveryDispatchStatus;
        workflowId: string;
        totalRecipients: number;
        requestedAt: string;
        scheduledAt: string | null;
        dispatchExpiresAt: string;
        contentHash: string;
        audience: {
          count: number;
          fingerprint: string;
          hashVersion: string;
          sourceType: string;
        };
      };
      admittedItems: BulkCampaignDispatchItem[];
    };

export class AdmittedCampaignLedgerRecoveryAmbiguousError extends Error {
  readonly code = "admitted_campaign_ledger_recovery_ambiguous";

  constructor(message: string) {
    super(message);
    this.name = "AdmittedCampaignLedgerRecoveryAmbiguousError";
  }
}

function failAmbiguous(message: string): never {
  throw new AdmittedCampaignLedgerRecoveryAmbiguousError(message);
}

function requiredIdentifier(value: unknown, label: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) {
    failAmbiguous(`Admitted campaign recovery ${label} is invalid`);
  }
  return normalized;
}

function nullableIdentifier(value: unknown, label: string): string | null {
  if (value === null || value === undefined) return null;
  return requiredIdentifier(value, label);
}

function nullableTimestamp(value: unknown, label: string): string | null {
  if (value === null || value === undefined) return null;
  const normalized = requiredIdentifier(value, label);
  if (!Number.isFinite(new Date(normalized).getTime())) {
    failAmbiguous(`Admitted campaign recovery ${label} is invalid`);
  }
  return normalized;
}

function requiredTimestamp(value: unknown, label: string): string {
  const normalized = nullableTimestamp(value, label);
  if (!normalized) {
    failAmbiguous(`Admitted campaign recovery ${label} is invalid`);
  }
  return normalized;
}

function requiredSha256(value: unknown, label: string): string {
  const normalized = requiredIdentifier(value, label);
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    failAmbiguous(`Admitted campaign recovery ${label} is invalid`);
  }
  return normalized;
}

function positiveInteger(value: unknown, label: string): number {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized <= 0) {
    failAmbiguous(`Admitted campaign recovery ${label} is invalid`);
  }
  return normalized;
}

function nonNegativeInteger(value: unknown, label: string): number {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 0) {
    failAmbiguous(`Admitted campaign recovery ${label} is invalid`);
  }
  return normalized;
}

function normalizePageSize(value: number | undefined): number {
  const pageSize = value ?? DEFAULT_RECOVERY_PAGE_SIZE;
  if (
    !Number.isSafeInteger(pageSize) ||
    pageSize <= 0 ||
    pageSize > MAX_RECOVERY_PAGE_SIZE
  ) {
    failAmbiguous(
      `Admitted campaign recovery page size must be between 1 and ${MAX_RECOVERY_PAGE_SIZE}`
    );
  }
  return pageSize;
}

function storeErrorMessage(error: StoreError | null | undefined): string {
  return typeof error?.message === "string" && error.message.trim()
    ? error.message.trim()
    : "store read failed";
}

const CAMPAIGN_RECOVERY_SELECT = [
  "id",
  "workspace_id",
  "scenario_id",
  "scenario_node_id",
  "execution_source",
  "sent_by",
  "channel",
  "dispatch_status",
  "workflow_id",
  "total_recipients",
  "requested_at",
  "scheduled_at",
  "dispatch_expires_at",
  "audience_count",
  "audience_fingerprint",
  "audience_hash_version",
  "audience_source_type",
  "audience_content_hash",
].join(",");

const CAMPAIGN_MESSAGE_RECOVERY_SELECT = [
  "campaign_id",
  "scenario_id",
  "scenario_node_id",
  "execution_source",
  "channel",
  "snapshot_ordinal",
  "recipient_hash",
  "dispatch_snapshot",
].join(",");

async function readRecoveryHistory(params: {
  supabase: CampaignStoreClient;
  workspaceId: string;
  campaignId: string;
}): Promise<CampaignHistoryRecoveryRow | null> {
  const result = await (
    params.supabase.from("campaign_history") as HistoryRecoveryTable
  )
    .select(CAMPAIGN_RECOVERY_SELECT)
    .eq("id", params.campaignId)
    .eq("workspace_id", params.workspaceId)
    .maybeSingle();
  if (result.error) {
    failAmbiguous(
      `Admitted campaign recovery history read failed: ${storeErrorMessage(result.error)}`
    );
  }
  return result.data ?? null;
}

function parseHistory(params: {
  row: CampaignHistoryRecoveryRow;
  workspaceId: string;
  campaignId: string;
  expectedChannel?: AdmittedCampaignRecoveryChannel;
  expectedScenarioId?: string | null;
  expectedScenarioNodeId?: string | null;
  expectedExecutionSource?: string | null;
  expectedAudienceSourceType?: string;
  expectedRecipientCount: number;
  expectedContentHash?: string;
  maxRecipients: number;
}) {
  const channel = requiredIdentifier(
    params.row.channel,
    "history channel"
  ) as AdmittedCampaignRecoveryChannel;
  const dispatchStatus = requiredIdentifier(
    params.row.dispatch_status,
    "history dispatch status"
  );
  const scenarioId = nullableIdentifier(
    params.row.scenario_id,
    "history scenario ID"
  );
  const scenarioNodeId = nullableIdentifier(
    params.row.scenario_node_id,
    "history scenario node ID"
  );
  const executionSource = nullableIdentifier(
    params.row.execution_source,
    "history execution source"
  );
  const audienceSourceType = requiredIdentifier(
    params.row.audience_source_type,
    "history audience source"
  );
  const totalRecipients = positiveInteger(
    params.row.total_recipients,
    "history total recipients"
  );
  const audienceCount = positiveInteger(
    params.row.audience_count,
    "history audience count"
  );
  if (
    requiredIdentifier(params.row.id, "history campaign ID") !==
      params.campaignId ||
    requiredIdentifier(params.row.workspace_id, "history workspace ID") !==
      params.workspaceId ||
    (params.expectedChannel !== undefined &&
      channel !== params.expectedChannel) ||
    (params.expectedScenarioId !== undefined &&
      scenarioId !== params.expectedScenarioId) ||
    (params.expectedScenarioNodeId !== undefined &&
      scenarioNodeId !== params.expectedScenarioNodeId) ||
    (params.expectedExecutionSource !== undefined &&
      executionSource !== params.expectedExecutionSource) ||
    (params.expectedAudienceSourceType !== undefined &&
      audienceSourceType !== params.expectedAudienceSourceType) ||
    (channel !== "whatsapp" && channel !== "telegram" && channel !== "email") ||
    !CAMPAIGN_DISPATCH_STATUSES.has(
      dispatchStatus as AdmittedCampaignRecoveryDispatchStatus
    ) ||
    audienceCount > totalRecipients ||
    totalRecipients > params.maxRecipients
  ) {
    failAmbiguous("Admitted campaign recovery history identity is foreign");
  }
  if (totalRecipients !== params.expectedRecipientCount) {
    failAmbiguous(
      "Admitted campaign recovery history audience does not match assignment"
    );
  }
  const workflowId = requiredIdentifier(
    params.row.workflow_id,
    "history workflow ID"
  );
  if (
    workflowId !==
    buildBulkCampaignDispatchWorkflowId({
      workspaceId: params.workspaceId,
      executionId: params.campaignId,
    })
  ) {
    failAmbiguous("Admitted campaign recovery workflow identity is foreign");
  }
  const contentHash = requiredSha256(
    params.row.audience_content_hash,
    "history content hash"
  );
  if (
    params.expectedContentHash !== undefined &&
    contentHash !== params.expectedContentHash
  ) {
    failAmbiguous(
      "Admitted campaign recovery history content does not match preparation"
    );
  }
  const requestedAt = requiredTimestamp(
    params.row.requested_at,
    "history requested time"
  );
  const scheduledAt = nullableTimestamp(
    params.row.scheduled_at,
    "history scheduled time"
  );
  const dispatchExpiresAt = requiredTimestamp(
    params.row.dispatch_expires_at,
    "history dispatch expiry"
  );
  if (
    new Date(dispatchExpiresAt).getTime() <= new Date(requestedAt).getTime()
  ) {
    failAmbiguous("Admitted campaign recovery history timing is invalid");
  }
  return {
    campaignId: params.campaignId,
    workspaceId: params.workspaceId,
    scenarioId,
    scenarioNodeId,
    executionSource,
    sentBy: requiredIdentifier(params.row.sent_by, "history sender ID"),
    channel,
    dispatchStatus: dispatchStatus as AdmittedCampaignRecoveryDispatchStatus,
    workflowId,
    totalRecipients,
    requestedAt,
    scheduledAt,
    dispatchExpiresAt,
    contentHash,
    audience: {
      count: audienceCount,
      fingerprint: requiredIdentifier(
        params.row.audience_fingerprint,
        "history audience fingerprint"
      ),
      hashVersion: requiredIdentifier(
        params.row.audience_hash_version,
        "history audience hash version"
      ),
      sourceType: audienceSourceType,
    },
  };
}

function parseMessagePage(params: {
  rows: CampaignMessageRecoveryRow[];
  campaign: {
    campaignId: string;
    workspaceId: string;
    scenarioId: string | null;
    scenarioNodeId: string | null;
    executionSource: string | null;
    sentBy: string;
    channel: AdmittedCampaignRecoveryChannel;
  };
  expectedFirstOrdinal: number;
  seenLegacyRecipientHashes: Set<string>;
}): {
  snapshots: Array<{
    recipientHash: string;
    snapshotOrdinal?: number;
    dispatchSnapshot: Record<string, unknown>;
  }>;
  items: BulkCampaignDispatchItem[];
  lastOrdinal: number;
} {
  const snapshots: Array<{
    recipientHash: string;
    snapshotOrdinal?: number;
    dispatchSnapshot: Record<string, unknown>;
  }> = [];
  const items: BulkCampaignDispatchItem[] = [];
  let expectedOrdinal = params.expectedFirstOrdinal;
  for (const row of params.rows) {
    const snapshot = row.dispatch_snapshot;
    const ordinal = nonNegativeInteger(
      row.snapshot_ordinal,
      "message snapshot ordinal"
    );
    if (
      requiredIdentifier(row.campaign_id, "message campaign ID") !==
        params.campaign.campaignId ||
      nullableIdentifier(row.scenario_id, "message scenario ID") !==
        params.campaign.scenarioId ||
      nullableIdentifier(row.scenario_node_id, "message scenario node ID") !==
        params.campaign.scenarioNodeId ||
      nullableIdentifier(row.execution_source, "message execution source") !==
        params.campaign.executionSource ||
      requiredIdentifier(row.channel, "message channel") !==
        params.campaign.channel ||
      ordinal !== expectedOrdinal ||
      typeof snapshot !== "object" ||
      snapshot === null ||
      Array.isArray(snapshot)
    ) {
      failAmbiguous("Admitted campaign recovery message linkage is malformed");
    }
    const recipientHash = requiredSha256(
      row.recipient_hash,
      "message recipient hash"
    );
    let sanitizedSnapshot: Record<string, unknown>;
    try {
      sanitizedSnapshot = sanitizeBulkCampaignDispatchSnapshot(
        snapshot as Record<string, unknown>
      );
    } catch {
      failAmbiguous(
        "Admitted campaign recovery immutable dispatch snapshot is malformed"
      );
    }
    const ledgerAudienceUpload = sanitizedSnapshot._audience_upload;
    if (
      ledgerAudienceUpload !== undefined &&
      (typeof ledgerAudienceUpload !== "object" ||
        ledgerAudienceUpload === null ||
        Array.isArray(ledgerAudienceUpload))
    ) {
      failAmbiguous(
        "Admitted campaign recovery immutable ledger metadata is malformed"
      );
    }
    const immutableDispatchSnapshot = { ...sanitizedSnapshot };
    delete immutableDispatchSnapshot._audience_upload;
    const embeddedOrdinal = immutableDispatchSnapshot.snapshotOrdinal;
    // Presence is the migration-transition content-hash discriminator. A
    // truly absent ordinal keeps the caller's legacy recipient-bound hash;
    // present values use the ordinal-bound item hash and must match SQL.
    const usesOrdinalBoundContentHash = embeddedOrdinal !== undefined;
    if (
      usesOrdinalBoundContentHash &&
      (!Number.isInteger(embeddedOrdinal) ||
        Number(embeddedOrdinal) !== ordinal)
    ) {
      failAmbiguous(
        "Admitted campaign recovery embedded snapshot ordinal is malformed"
      );
    }
    if (
      !usesOrdinalBoundContentHash &&
      params.seenLegacyRecipientHashes.has(recipientHash)
    ) {
      failAmbiguous(
        "Admitted campaign recovery legacy recipient identity is ambiguous"
      );
    }
    const item =
      immutableDispatchSnapshot as unknown as BulkCampaignDispatchItem;
    let logicalRecipientKey: string | null = null;
    try {
      logicalRecipientKey = buildBulkCampaignDispatchLogicalRecipientKey(item);
    } catch {
      // Shape validation below reports one fail-closed recovery error.
    }
    if (
      requiredIdentifier(
        immutableDispatchSnapshot.workspaceId,
        "snapshot workspace ID"
      ) !== params.campaign.workspaceId ||
      requiredIdentifier(
        immutableDispatchSnapshot.campaignId,
        "snapshot campaign ID"
      ) !== params.campaign.campaignId ||
      nullableIdentifier(
        immutableDispatchSnapshot.executionSource,
        "snapshot execution source"
      ) !== params.campaign.executionSource ||
      requiredIdentifier(
        immutableDispatchSnapshot.channel,
        "snapshot channel"
      ) !== params.campaign.channel ||
      requiredIdentifier(
        immutableDispatchSnapshot.sentByUserId,
        "snapshot sender ID"
      ) !== params.campaign.sentBy ||
      !logicalRecipientKey
    ) {
      failAmbiguous(
        "Admitted campaign recovery immutable dispatch snapshot is foreign"
      );
    }
    if (!usesOrdinalBoundContentHash) {
      params.seenLegacyRecipientHashes.add(recipientHash);
    }
    snapshots.push({
      recipientHash,
      ...(usesOrdinalBoundContentHash ? { snapshotOrdinal: ordinal } : {}),
      dispatchSnapshot: immutableDispatchSnapshot,
    });
    items.push(item);
    expectedOrdinal += 1;
  }
  return {
    snapshots,
    items,
    lastOrdinal: expectedOrdinal - 1,
  };
}

async function readRecoveryPayload(params: {
  supabase: CampaignStoreClient;
  campaign: Extract<
    AdmittedCampaignLedgerRecoveryResult,
    { status: "admitted" }
  >["campaign"];
  pageSize: number;
}): Promise<BulkCampaignDispatchItem[]> {
  const admittedItems: BulkCampaignDispatchItem[] = [];
  const contentSnapshots: Array<{
    recipientHash: string;
    snapshotOrdinal?: number;
    dispatchSnapshot: Record<string, unknown>;
  }> = [];
  const seenLegacyRecipientHashes = new Set<string>();
  let lastOrdinal = -1;
  for (;;) {
    const result = await (
      params.supabase.from("campaign_messages") as MessageRecoveryTable
    )
      .select(CAMPAIGN_MESSAGE_RECOVERY_SELECT)
      .eq("campaign_id", params.campaign.campaignId)
      .gt("snapshot_ordinal", lastOrdinal)
      .order("snapshot_ordinal", { ascending: true })
      .limit(params.pageSize);
    if (result.error) {
      failAmbiguous(
        `Admitted campaign recovery message read failed: ${storeErrorMessage(result.error)}`
      );
    }
    if (!Array.isArray(result.data)) {
      failAmbiguous("Admitted campaign recovery message page is malformed");
    }
    if (result.data.length === 0) break;
    const page = parseMessagePage({
      rows: result.data,
      campaign: params.campaign,
      expectedFirstOrdinal: admittedItems.length,
      seenLegacyRecipientHashes,
    });
    contentSnapshots.push(...page.snapshots);
    admittedItems.push(...page.items);
    lastOrdinal = page.lastOrdinal;
    if (admittedItems.length > params.campaign.totalRecipients) {
      failAmbiguous("Admitted campaign recovery has excess message snapshots");
    }
    if (result.data.length < params.pageSize) break;
  }
  if (admittedItems.length !== params.campaign.totalRecipients) {
    failAmbiguous(
      "Admitted campaign recovery message audience is incomplete or foreign"
    );
  }
  if (
    createPreparedBulkCampaignContentHash(contentSnapshots) !==
    params.campaign.contentHash
  ) {
    failAmbiguous(
      "Admitted campaign recovery immutable content does not match admission"
    );
  }
  return admittedItems;
}

/**
 * Reads the exact immutable SQL admission payload. Callers must supply an
 * already-bounded expected count so recovery cannot turn into an unbounded
 * history scan.
 */
export async function recoverAdmittedCampaignDispatch(params: {
  supabase: CampaignStoreClient;
  workspaceId: string;
  campaignId: string;
  expectedRecipientCount: number;
  maxRecipients: number;
  expectedChannel?: AdmittedCampaignRecoveryChannel;
  expectedScenarioId?: string | null;
  expectedScenarioNodeId?: string | null;
  expectedExecutionSource?: string | null;
  expectedAudienceSourceType?: string;
  expectedContentHash?: string;
  pageSize?: number;
}): Promise<AdmittedCampaignLedgerRecoveryResult> {
  const workspaceId = requiredIdentifier(params.workspaceId, "workspace ID");
  const campaignId = requiredIdentifier(params.campaignId, "campaign ID");
  const expectedRecipientCount = positiveInteger(
    params.expectedRecipientCount,
    "expected recipient count"
  );
  const maxRecipients = positiveInteger(
    params.maxRecipients,
    "recipient bound"
  );
  if (expectedRecipientCount > maxRecipients) {
    failAmbiguous("Admitted campaign recovery recipient bound is exceeded");
  }
  const expectedContentHash =
    params.expectedContentHash === undefined
      ? undefined
      : requiredSha256(params.expectedContentHash, "expected content hash");
  const pageSize = normalizePageSize(params.pageSize);
  const historyRow = await readRecoveryHistory({
    supabase: params.supabase,
    workspaceId,
    campaignId,
  });
  if (!historyRow) return { status: "not_admitted" };

  const campaign = parseHistory({
    row: historyRow,
    workspaceId,
    campaignId,
    expectedChannel: params.expectedChannel,
    expectedScenarioId: params.expectedScenarioId,
    expectedScenarioNodeId: params.expectedScenarioNodeId,
    expectedExecutionSource: params.expectedExecutionSource,
    expectedAudienceSourceType: params.expectedAudienceSourceType,
    expectedRecipientCount,
    expectedContentHash,
    maxRecipients,
  });
  const admittedItems = await readRecoveryPayload({
    supabase: params.supabase,
    campaign,
    pageSize,
  });
  return {
    status: "admitted",
    campaign,
    admittedItems,
  };
}
