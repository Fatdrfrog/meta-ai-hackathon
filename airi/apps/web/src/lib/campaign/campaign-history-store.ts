import { emitWorkspaceUsageDeltaBestEffort } from "@/lib/limits/company-usage-events";
import {
  COMPANY_BULK_CAMPAIGN_LIMIT_EXCEEDED_CODE,
  isCompanyBulkQuotaRefusal,
  isCompanySubscriptionType,
  type CompanySubscriptionType,
} from "@/lib/limits/company-limits";
import type { BulkCampaignDispatchExecutionSource } from "@icecore/scenario-contracts";
import { isMetaProviderRestrictionCode } from "@icecore/shared/lib/meta/message-failure-scope";
import {
  BULK_CAMPAIGN_DISPATCH_PAUSED_STOP_REASON,
  type BulkCampaignDispatchLifecycleState,
} from "@icecore/temporal";

export type { BulkCampaignDispatchExecutionSource };
export type CampaignExecutionSource = BulkCampaignDispatchExecutionSource;

export type CampaignStoreClient = {
  from: (table: string) => unknown;
  rpc?: (
    name: string,
    args: Record<string, unknown>
  ) => PromiseLike<{
    data?: unknown;
    error: SupabaseOptionalLinkageError | null;
  }>;
};

type SupabaseOptionalLinkageError = {
  code?: string | null;
  message?: string | null;
  details?: string | null;
  hint?: string | null;
};

type CampaignDispatchChannel = "whatsapp" | "telegram" | "email";
type ActiveCampaignDispatchStatus = Extract<
  BulkCampaignDispatchLifecycleState,
  "queued" | "scheduled" | "running"
>;
type FinalizableCampaignDispatchStatus = Extract<
  BulkCampaignDispatchLifecycleState,
  "completed" | "failed" | "expired"
>;
type CampaignDispatchRow = {
  id?: string | null;
  workspace_id?: string | null;
  channel?: string | null;
  name?: string | null;
  template_name?: string | null;
  template_language?: string | null;
  message_text?: string | null;
  workflow_id?: string | null;
  dispatch_status?: string | null;
  requested_at?: string | null;
  scheduled_at?: string | null;
  dispatch_expires_at?: string | null;
  started_at?: string | null;
  progress_at?: string | null;
  finished_at?: string | null;
  cancelled_at?: string | null;
  expired_at?: string | null;
  total_recipients?: number | null;
  bulk_quota_reserved_at?: string | null;
  processed_count?: number | null;
  accepted_count?: number | null;
  attempted_count?: number | null;
  not_attempted_count?: number | null;
  successful_sends?: number | null;
  failed_sends?: number | null;
  stop_reason?: string | null;
  provider_circuit_state?: string | null;
  provider_circuit_provider?: string | null;
  provider_circuit_code?: string | null;
  provider_circuit_opened_at?: string | null;
  provider_circuit_acknowledged_at?: string | null;
  provider_circuit_acknowledged_by?: string | null;
  retry_of_campaign_id?: string | null;
  retry_kind?: string | null;
};
type SafetyStoreResult<T> = {
  data?: T | null;
  error: SupabaseOptionalLinkageError | null;
};
type SafetyStoreQuery<T> = {
  eq: (column: string, value: string) => SafetyStoreQuery<T>;
  is: (column: string, value: null | boolean) => SafetyStoreQuery<T>;
  in: (column: string, values: string[]) => SafetyStoreQuery<T>;
  not: (column: string, operator: "is", value: null) => SafetyStoreQuery<T>;
  gt: (column: string, value: string) => SafetyStoreQuery<T>;
  lte: (column: string, value: string) => SafetyStoreQuery<T>;
  select: (columns: string) => SafetyStoreQuery<T>;
  maybeSingle: () => Promise<SafetyStoreResult<T>>;
  order: (
    column: string,
    options: { ascending: boolean }
  ) => Promise<SafetyStoreResult<T>>;
};
type SafetyStoreTable = {
  update: (
    payload: Record<string, unknown>
  ) => SafetyStoreQuery<CampaignDispatchRow>;
  select: <T>(columns: string) => SafetyStoreQuery<T>;
};
type FailedCampaignMessageRow = {
  campaign_id?: string | null;
  status?: string | null;
  channel?: string | null;
  recipient?: string | null;
  snapshot_ordinal?: number | null;
  dispatch_snapshot?: unknown;
  provider?: string | null;
  error_code?: string | number | null;
  failure_scope?: string | null;
  failure_reason?: string | null;
  error_message?: string | null;
};

const ACTIVE_CAMPAIGN_DISPATCH_STATUSES: ActiveCampaignDispatchStatus[] = [
  "queued",
  "scheduled",
  "running",
];
export const RETRYABLE_CAMPAIGN_MESSAGE_STATUSES = ["failed"] as const;
const CAMPAIGN_DISPATCH_STATUSES = new Set<BulkCampaignDispatchLifecycleState>([
  "queued",
  "scheduled",
  "running",
  "completed",
  "failed",
  "expired",
  "cancelled",
]);
const CAMPAIGN_DISPATCH_SELECT = [
  "id",
  "workspace_id",
  "workflow_id",
  "dispatch_status",
  "requested_at",
  "scheduled_at",
  "dispatch_expires_at",
  "started_at",
  "progress_at",
  "finished_at",
  "cancelled_at",
  "expired_at",
  "total_recipients",
  "processed_count",
  "accepted_count",
  "attempted_count",
  "not_attempted_count",
  "successful_sends",
  "failed_sends",
  "stop_reason",
  "provider_circuit_state",
  "provider_circuit_provider",
  "provider_circuit_code",
  "provider_circuit_opened_at",
  "retry_of_campaign_id",
  "retry_kind",
].join(",");

export type CampaignDispatchTransitionState = {
  campaignId: string;
  workflowId: string | null;
  status: BulkCampaignDispatchLifecycleState;
};
export type CampaignDispatchBeginResult =
  | (CampaignDispatchTransitionState & {
      outcome:
        | "started"
        | "already_started"
        | "workflow_mismatch"
        | "expired"
        | "cancelled"
        | "not_dispatchable";
    })
  | { outcome: "not_found"; status: null; workflowId: null };

export type CampaignDispatchPauseResult =
  | (CampaignDispatchTransitionState & {
      outcome: "paused" | "resumed" | "already_paused" | "already_resumed";
    })
  | (CampaignDispatchTransitionState & {
      outcome: "already_terminal" | "not_cancellable";
    })
  | { outcome: "not_found"; status: null; workflowId: null };

export type CampaignDispatchCancellationResult =
  | (CampaignDispatchTransitionState & {
      outcome:
        | "cancelled"
        | "already_cancelled"
        | "already_terminal"
        | "not_cancellable";
    })
  | { outcome: "not_found"; status: null; workflowId: null };
export type CampaignDispatchProgress = {
  processedCount: number;
  acceptedCount: number;
  failedCount: number;
  attemptedCount: number;
  notAttemptedCount: number;
};

export type CampaignDispatchPublicStatus = {
  campaignId: string;
  workspaceId: string;
  workflowId: string | null;
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
  providerCircuit: {
    state: "open" | "closed";
    provider: string | null;
    code: string | null;
    openedAt: string | null;
    failureCount: number;
  };
  retry: {
    ofCampaignId: string | null;
    kind: "failed_only" | "send_again" | null;
  };
  retryableFailedRecipientCount: number;
};
export type CampaignFailedSnapshotForRetry = {
  campaignId: string;
  channel: CampaignDispatchChannel;
  recipient: string;
  snapshotOrdinal: number;
  dispatchSnapshot: Record<string, unknown>;
  providerFailure: {
    provider: string | null;
    code: string | number | null;
    scope: string | null;
    message: string | null;
  };
};
export type CampaignRetryPreparation = {
  source: {
    campaignId: string;
    workspaceId: string;
    channel: CampaignDispatchChannel;
    name: string;
    templateName: string | null;
    templateLanguage: string | null;
    messageText: string | null;
    totalRecipients: number;
    status: BulkCampaignDispatchLifecycleState;
    providerCircuit: {
      state: "open" | "closed";
      provider: string | null;
      code: string | null;
      openedAt: string | null;
    };
  };
  failedSnapshots: CampaignFailedSnapshotForRetry[];
  ancestorProviderCircuit?: Extract<
    CampaignDispatchAggregate["providerCircuit"],
    { state: "open" }
  >;
};
export type CampaignDispatchAggregate = {
  delivery: CampaignDispatchPublicStatus["delivery"];
  retryableFailedRecipientCount: number;
  topFailure: {
    reason: string;
    errorCode: number | null;
    count: number;
  } | null;
  providerCircuit:
    | {
        state: "open";
        provider: string;
        code: string;
        failureCount: number;
      }
    | { state: "closed" };
};
export type CampaignDispatchPreStartFailureReason =
  | "payload_staging_unavailable"
  | "payload_staging_failed"
  | "workflow_start_failed"
  | "dispatch_expired_before_start";

const OPTIONAL_LINKAGE_COLUMNS = [
  "scenario_id",
  "scenario_node_id",
  "execution_source",
] as const;

export function isMissingOptionalCampaignLinkageColumnError(
  error: SupabaseOptionalLinkageError | null | undefined
): boolean {
  if (!error) {
    return false;
  }

  const text = [error.message, error.details, error.hint]
    .filter(Boolean)
    .join(" ");
  const mentionsOptionalColumn = OPTIONAL_LINKAGE_COLUMNS.some(column =>
    text.toLowerCase().includes(column)
  );

  if (!mentionsOptionalColumn) {
    return false;
  }

  return (
    error.code === "PGRST204" ||
    /column .* does not exist/i.test(text) ||
    /unknown column/i.test(text) ||
    /schema cache/i.test(text)
  );
}

export async function findCampaignHistoryRunReservation(params: {
  supabase: CampaignStoreClient;
  workspaceId: string;
  scenarioId: string;
  scenarioNodeId: string;
  executionSource: CampaignExecutionSource;
  executionRunKey: string;
  legacyScheduledForRange?: { start: string; end: string };
}): Promise<{
  campaignId: string;
  channel: CampaignDispatchChannel;
  stopReason: string | null;
  bulkQuotaReservedAt: string | null;
  executionRunKey?: string;
} | null> {
  const context = "findCampaignHistoryRunReservation";
  const scoped = (params.supabase.from("campaign_history") as SafetyStoreTable)
    .select<CampaignDispatchRow>(
      "id, channel, stop_reason, bulk_quota_reserved_at" +
        (params.legacyScheduledForRange ? ", execution_run_key" : "")
    )
    .eq("workspace_id", params.workspaceId)
    .eq("scenario_id", params.scenarioId)
    .eq("scenario_node_id", params.scenarioNodeId)
    .eq("execution_source", params.executionSource);
  type LegacyReservationQuery = {
    gte: (column: string, value: string) => LegacyReservationQuery;
    lt: (column: string, value: string) => LegacyReservationQuery;
    order: (
      column: string,
      options: { ascending: boolean }
    ) => LegacyReservationQuery;
    limit: (count: number) => LegacyReservationQuery;
    maybeSingle: () => Promise<
      SafetyStoreResult<CampaignDispatchRow & { execution_run_key?: string }>
    >;
  };
  const result = params.legacyScheduledForRange
    ? await (scoped as unknown as LegacyReservationQuery)
        .gte(
          "execution_run_key",
          `scheduled:${params.legacyScheduledForRange.start}`
        )
        .lt(
          "execution_run_key",
          `scheduled:${params.legacyScheduledForRange.end}`
        )
        .order("execution_run_key", { ascending: true })
        .limit(1)
        .maybeSingle()
    : await scoped
        .eq("execution_run_key", params.executionRunKey)
        .maybeSingle();

  if (result.error) {
    throw new Error(
      `[${context}] ${result.error.message || "campaign history lookup failed"}`
    );
  }
  const campaignId =
    typeof result.data?.id === "string" ? result.data.id.trim() : "";
  if (!campaignId) return null;
  const channel = result.data?.channel;
  if (channel !== "whatsapp" && channel !== "telegram" && channel !== "email") {
    throw new Error(`[${context}] invalid campaign channel`);
  }
  const stopReason =
    typeof result.data?.stop_reason === "string"
      ? result.data.stop_reason.trim() || null
      : null;
  const bulkQuotaReservedAt =
    typeof result.data?.bulk_quota_reserved_at === "string"
      ? result.data.bulk_quota_reserved_at.trim() || null
      : null;
  const reservation = { campaignId, channel, stopReason, bulkQuotaReservedAt } as const;
  if (!params.legacyScheduledForRange) return reservation;
  const executionRunKey =
    "execution_run_key" in (result.data || {})
      ? String(
          (result.data as { execution_run_key?: unknown }).execution_run_key ||
            ""
        ).trim()
      : "";
  if (
    executionRunKey < `scheduled:${params.legacyScheduledForRange.start}` ||
    executionRunKey >= `scheduled:${params.legacyScheduledForRange.end}`
  )
    throw new Error(`[${context}] invalid legacy birthday reservation key`);
  return { ...reservation, executionRunKey };
}

export async function createCampaignHistoryRecord(params: {
  supabase: CampaignStoreClient;
  workspaceId: string;
  name: string;
  channel: "whatsapp" | "telegram" | "email";
  templateName?: string | null;
  templateLanguage?: string | null;
  messageText?: string | null;
  totalRecipients: number;
  companyBulkCampaignLimit: number | null;
  companySubscriptionType: CompanySubscriptionType;
  sentBy?: string | null;
  scenarioId: string;
  scenarioNodeId: string;
  executionSource: CampaignExecutionSource;
  executionRunKey: string;
}): Promise<
  | {
      status: "ready";
      campaignId: string;
      created: boolean;
    }
  | {
      status: "blocked";
      code: typeof COMPANY_BULK_CAMPAIGN_LIMIT_EXCEEDED_CODE;
      companyBulkCampaignLimit: number;
      companyBulkCampaignCount: number;
    }
  | {
      status: "skipped";
      code: "empty_audience";
      campaignId: string;
    }
  | {
      status: "conflict";
      code: "company_plan_changed";
      expectedSubscriptionType: CompanySubscriptionType;
      currentSubscriptionType: CompanySubscriptionType;
    }
  | {
      status: "failed";
      errorMessage: string;
    }
> {
  const templateLanguage =
    typeof params.templateLanguage === "string" &&
    params.templateLanguage.trim()
      ? params.templateLanguage.trim()
      : "en";
  const deliveryLedgerStartedAt = new Date().toISOString();
  const executionRunKey = params.executionRunKey.trim();
  let campaignId: string | null = null;
  let errorMessage: string | null = null;
  let created = false;

  if (
    params.companyBulkCampaignLimit !== null &&
    (!Number.isSafeInteger(params.companyBulkCampaignLimit) ||
      params.companyBulkCampaignLimit < 0)
  ) {
    return {
      status: "failed",
      errorMessage:
        "Company bulk campaign limit must be a non-negative integer or null",
    };
  }
  if (!isCompanySubscriptionType(params.companySubscriptionType)) {
    return {
      status: "failed",
      errorMessage: "Company subscription type is invalid",
    };
  }

  if (
    !executionRunKey ||
    !params.scenarioId.trim() ||
    !params.scenarioNodeId.trim()
  ) {
    errorMessage =
      "Scenario ID, node ID, and execution run key are required for a run reservation";
  } else if (!params.supabase.rpc) {
    errorMessage =
      "[reserve_scenario_campaign_history] required campaign lifecycle RPC is unavailable";
  } else {
    const result = await params.supabase.rpc(
      "reserve_scenario_campaign_history",
      {
        p_workspace_id: params.workspaceId,
        p_name: params.name,
        p_channel: params.channel,
        p_template_name: params.templateName || null,
        p_template_language: templateLanguage,
        p_message_text: params.messageText || null,
        p_total_recipients: params.totalRecipients,
        p_sent_by: params.sentBy || null,
        p_scenario_id: params.scenarioId,
        p_scenario_node_id: params.scenarioNodeId,
        p_execution_source: params.executionSource,
        p_execution_run_key: executionRunKey,
        p_company_bulk_campaign_limit: params.companyBulkCampaignLimit,
        p_expected_subscription_type: params.companySubscriptionType,
        p_delivery_ledger_started_at: deliveryLedgerStartedAt,
        p_cost_ledger_started_at:
          params.channel === "whatsapp" ? deliveryLedgerStartedAt : null,
      }
    );
    errorMessage = result.error?.message || null;
    if (!errorMessage) {
      const row =
        result.data &&
        typeof result.data === "object" &&
        !Array.isArray(result.data)
          ? (result.data as Record<string, unknown>)
          : null;
      if (row?.status === "conflict" && row.code === "company_plan_changed") {
        const expectedSubscriptionType = row.expected_subscription_type;
        const currentSubscriptionType = row.current_subscription_type;
        if (
          !isCompanySubscriptionType(expectedSubscriptionType) ||
          !isCompanySubscriptionType(currentSubscriptionType) ||
          expectedSubscriptionType !== params.companySubscriptionType
        ) {
          return {
            status: "failed",
            errorMessage:
              "[reserve_scenario_campaign_history] malformed company plan conflict",
          };
        }
        return {
          status: "conflict",
          code: "company_plan_changed",
          expectedSubscriptionType,
          currentSubscriptionType,
        };
      }
      if (row?.status === "skipped" && row.code === "empty_audience") {
        const skippedCampaignId =
          typeof row.campaign_id === "string"
            ? row.campaign_id.trim() || null
            : null;
        if (!skippedCampaignId || row.created !== false) {
          return {
            status: "failed",
            errorMessage:
              "[reserve_scenario_campaign_history] malformed empty-audience replay",
          };
        }
        return {
          status: "skipped",
          code: "empty_audience",
          campaignId: skippedCampaignId,
        };
      }
      if (
        row?.status === "blocked" &&
        row.code === COMPANY_BULK_CAMPAIGN_LIMIT_EXCEEDED_CODE
      ) {
        const companyBulkCampaignLimit = row.company_bulk_campaign_limit;
        const companyBulkCampaignCount = row.company_bulk_campaign_count;
        if (
          params.companyBulkCampaignLimit === null ||
          !Number.isSafeInteger(companyBulkCampaignLimit) ||
          Number(companyBulkCampaignLimit) !==
            params.companyBulkCampaignLimit ||
          !isCompanyBulkQuotaRefusal(row)
        ) {
          return {
            status: "failed",
            errorMessage:
              "[reserve_scenario_campaign_history] malformed company quota decision",
          };
        }
        return {
          status: "blocked",
          code: COMPANY_BULK_CAMPAIGN_LIMIT_EXCEEDED_CODE,
          companyBulkCampaignLimit: Number(companyBulkCampaignLimit),
          companyBulkCampaignCount: Number(companyBulkCampaignCount),
        };
      }
      campaignId =
        typeof row?.campaign_id === "string"
          ? row.campaign_id.trim() || null
          : null;
      created = row?.created === true;
      if (!campaignId || typeof row?.created !== "boolean") {
        campaignId = null;
        created = false;
        errorMessage =
          "[reserve_scenario_campaign_history] malformed RPC result";
      }
    }
  }

  if (errorMessage || !campaignId) {
    return {
      status: "failed",
      errorMessage:
        errorMessage || "Campaign history reservation did not return an ID",
    };
  }

  if (created && params.totalRecipients > 0) {
    emitCampaignHistoryCreatedUsageBestEffort({
      workspaceId: params.workspaceId,
      campaignId,
      channel: params.channel,
      executionSource: params.executionSource,
      logContext: "createCampaignHistoryRecord",
    });
  }

  return {
    status: "ready",
    campaignId,
    created,
  };
}

export function emitCampaignHistoryCreatedUsageBestEffort(params: {
  workspaceId: string;
  campaignId: string;
  channel: CampaignDispatchChannel;
  executionSource?: CampaignExecutionSource | null;
  logContext?: string;
}): void {
  emitWorkspaceUsageDeltaBestEffort(
    {
      workspaceId: params.workspaceId,
      metric: "bulk_campaign_count",
      delta: 1,
      objectId: params.campaignId,
      source: "campaign_history",
      metadata: {
        sourceType: params.channel,
        executionSource: params.executionSource || null,
      },
    },
    { logContext: params.logContext || "campaignHistoryCreated" }
  );
}

export async function updateCampaignHistoryRecipientCount(params: {
  supabase: CampaignStoreClient;
  workspaceId: string;
  campaignId: string;
  channel: CampaignDispatchChannel;
  totalRecipients: number;
  scenarioId: string;
  scenarioNodeId: string;
  executionSource: CampaignExecutionSource;
  executionRunKey: string;
}) {
  const context = "reconcile_scenario_campaign_recipient_total";
  const result = await executeRequiredCampaignRpc(params.supabase, context, {
    p_workspace_id: params.workspaceId,
    p_campaign_id: params.campaignId,
    p_total_recipients: params.totalRecipients,
    p_scenario_id: params.scenarioId,
    p_scenario_node_id: params.scenarioNodeId,
    p_execution_source: params.executionSource,
    p_execution_run_key: params.executionRunKey,
  });
  const campaignId =
    typeof result.campaign_id === "string" ? result.campaign_id : null;
  const totalRecipients = Number(result.total_recipients);
  const becameCounted = result.became_counted;
  if (
    campaignId !== params.campaignId ||
    !Number.isSafeInteger(totalRecipients) ||
    totalRecipients < params.totalRecipients ||
    typeof becameCounted !== "boolean"
  ) {
    throw new Error(`[${context}] malformed RPC result`);
  }
  if (becameCounted) {
    emitCampaignHistoryCreatedUsageBestEffort({
      workspaceId: params.workspaceId,
      campaignId: params.campaignId,
      channel: params.channel,
      executionSource: params.executionSource,
      logContext: "reconcileScenarioCampaignRecipientTotal",
    });
  }
  return totalRecipients;
}

function throwOnCampaignStoreError(
  context: string,
  error: SupabaseOptionalLinkageError | null | undefined
): void {
  if (!error) {
    return;
  }

  const details = [error.code, error.message, error.details, error.hint]
    .filter(Boolean)
    .join(": ");
  throw new Error(`[${context}] ${details || "campaign store query failed"}`);
}

function parseCampaignDispatchStatus(
  value: unknown,
  context: string
): BulkCampaignDispatchLifecycleState {
  if (
    typeof value !== "string" ||
    !CAMPAIGN_DISPATCH_STATUSES.has(value as BulkCampaignDispatchLifecycleState)
  ) {
    throw new Error(`[${context}] invalid dispatch_status`);
  }
  return value as BulkCampaignDispatchLifecycleState;
}

function transitionStateFromRow(
  row: CampaignDispatchRow,
  context: string
): CampaignDispatchTransitionState {
  if (typeof row.id !== "string" || !row.id) {
    throw new Error(`[${context}] campaign id is missing`);
  }
  return {
    campaignId: row.id,
    workflowId: typeof row.workflow_id === "string" ? row.workflow_id : null,
    status: parseCampaignDispatchStatus(row.dispatch_status, context),
  };
}

function asCampaignRpcRecord(value: unknown, context: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`[${context}] malformed RPC result`);
  }
  return value as Record<string, unknown>;
}

async function executeRequiredCampaignRpc(
  supabase: CampaignStoreClient,
  name: string,
  args: Record<string, unknown>
) {
  if (!supabase.rpc) {
    throw new Error(`[${name}] required campaign lifecycle RPC is unavailable`);
  }
  const result = await supabase.rpc(name, args);
  throwOnCampaignStoreError(name, result.error);
  return asCampaignRpcRecord(result.data, name);
}

function parseCampaignRpcTransition(
  value: Record<string, unknown>,
  context: string
): CampaignDispatchTransitionState {
  return transitionStateFromRow(
    {
      id: typeof value.campaign_id === "string" ? value.campaign_id : null,
      workflow_id:
        typeof value.workflow_id === "string" ? value.workflow_id : null,
      dispatch_status:
        typeof value.dispatch_status === "string"
          ? value.dispatch_status
          : null,
    },
    context
  );
}

export async function beginCampaignDispatch(params: {
  supabase: CampaignStoreClient;
  campaignId: string;
  expectedWorkflowId: string;
  now?: Date;
}): Promise<CampaignDispatchBeginResult> {
  const context = "begin_bulk_campaign_dispatch";
  const result = await executeRequiredCampaignRpc(params.supabase, context, {
    p_campaign_id: params.campaignId,
    p_workflow_id: params.expectedWorkflowId,
    p_now: (params.now ?? new Date()).toISOString(),
  });
  const outcome = result.outcome;
  if (outcome === "not_found") {
    return { outcome: "not_found", status: null, workflowId: null };
  }
  if (
    outcome !== "started" &&
    outcome !== "already_started" &&
    outcome !== "workflow_mismatch" &&
    outcome !== "expired" &&
    outcome !== "cancelled" &&
    outcome !== "not_dispatchable"
  ) {
    throw new Error(`[${context}] invalid outcome`);
  }
  return {
    outcome,
    ...parseCampaignRpcTransition(result, context),
  };
}

export async function updateCampaignDispatchProgress(
  params: {
    supabase: CampaignStoreClient;
    campaignId: string;
    now?: Date;
  } & CampaignDispatchProgress
): Promise<boolean> {
  const result = await executeRequiredCampaignRpc(
    params.supabase,
    "update_bulk_campaign_progress",
    {
      p_campaign_id: params.campaignId,
      p_processed_count: params.processedCount,
      p_accepted_count: params.acceptedCount,
      p_failed_count: params.failedCount,
      p_attempted_count: params.attemptedCount,
      p_not_attempted_count: params.notAttemptedCount,
      p_now: (params.now ?? new Date()).toISOString(),
    }
  );
  if (typeof result.applied !== "boolean") {
    throw new Error("[update_bulk_campaign_progress] malformed applied result");
  }
  return result.applied;
}

export async function reconcileCampaignDispatchCancellation(
  params: {
    supabase: CampaignStoreClient;
    workspaceId: string;
    campaignId: string;
    stopReason?: string | null;
    providerCircuit?: {
      state: "open" | "closed";
      provider?: string | null;
      code?: string | number | null;
    };
    now?: Date;
  } & CampaignDispatchProgress
): Promise<CampaignDispatchCancellationResult> {
  const result = await executeRequiredCampaignRpc(
    params.supabase,
    "reconcile_bulk_campaign_cancellation",
    {
      p_campaign_id: params.campaignId,
      p_workspace_id: params.workspaceId,
      p_processed_count: params.processedCount,
      p_accepted_count: params.acceptedCount,
      p_failed_count: params.failedCount,
      p_attempted_count: params.attemptedCount,
      p_not_attempted_count: params.notAttemptedCount,
      p_stop_reason: params.stopReason ?? "workflow_cancelled",
      p_provider_circuit_state: params.providerCircuit?.state ?? "closed",
      p_provider_circuit_provider: params.providerCircuit?.provider ?? null,
      p_provider_circuit_code:
        params.providerCircuit?.code === undefined ||
        params.providerCircuit?.code === null
          ? null
          : String(params.providerCircuit.code),
      p_now: (params.now ?? new Date()).toISOString(),
    }
  );
  const outcome = String(result.outcome || "");
  if (outcome === "not_found") {
    return { outcome: "not_found", status: null, workflowId: null };
  }
  if (
    outcome !== "cancelled" &&
    outcome !== "already_cancelled" &&
    outcome !== "terminal_conflict"
  ) {
    throw new Error("[reconcile_bulk_campaign_cancellation] invalid outcome");
  }
  return {
    outcome: outcome === "terminal_conflict" ? "already_terminal" : outcome,
    ...parseCampaignRpcTransition(
      result,
      "reconcile_bulk_campaign_cancellation"
    ),
  };
}

export async function finalizeCampaignDispatch(
  params: {
    supabase: CampaignStoreClient;
    campaignId: string;
    status: FinalizableCampaignDispatchStatus;
    stopReason?: string | null;
    providerCircuit?: {
      state: "open" | "closed";
      provider?: string | null;
      code?: string | number | null;
    };
    now?: Date;
  } & CampaignDispatchProgress
): Promise<boolean> {
  const circuitState = params.providerCircuit?.state ?? "closed";
  const result = await executeRequiredCampaignRpc(
    params.supabase,
    "finalize_bulk_campaign_dispatch",
    {
      p_campaign_id: params.campaignId,
      p_dispatch_status: params.status,
      p_processed_count: params.processedCount,
      p_accepted_count: params.acceptedCount,
      p_failed_count: params.failedCount,
      p_attempted_count: params.attemptedCount,
      p_not_attempted_count: params.notAttemptedCount,
      p_stop_reason: params.stopReason ?? null,
      p_provider_circuit_state: circuitState,
      p_provider_circuit_provider: params.providerCircuit?.provider ?? null,
      p_provider_circuit_code:
        params.providerCircuit?.code === undefined ||
        params.providerCircuit?.code === null
          ? null
          : String(params.providerCircuit.code),
      p_now: (params.now ?? new Date()).toISOString(),
    }
  );
  if (typeof result.applied !== "boolean") {
    throw new Error(
      "[finalize_bulk_campaign_dispatch] malformed applied result"
    );
  }
  return result.applied;
}

export async function failCampaignDispatchBeforeStart(params: {
  supabase: CampaignStoreClient;
  campaignId: string;
  stopReason: CampaignDispatchPreStartFailureReason;
  now?: Date;
}): Promise<boolean> {
  const result = await executeRequiredCampaignRpc(
    params.supabase,
    "fail_bulk_campaign_before_start",
    {
      p_campaign_id: params.campaignId,
      p_stop_reason: params.stopReason,
      p_now: (params.now ?? new Date()).toISOString(),
    }
  );
  if (typeof result.applied !== "boolean") {
    throw new Error(
      "[fail_bulk_campaign_before_start] malformed applied result"
    );
  }
  return result.applied;
}

export async function cancelCampaignDispatch(params: {
  supabase: CampaignStoreClient;
  workspaceId: string;
  campaignId: string;
  now?: Date;
}): Promise<CampaignDispatchCancellationResult> {
  const nowIso = (params.now ?? new Date()).toISOString();
  const table = params.supabase.from("campaign_history") as SafetyStoreTable;
  const cancelResult = await table
    .update({
      dispatch_status: "cancelled",
      cancelled_at: nowIso,
      finished_at: nowIso,
      stop_reason: "cancelled_by_operator",
    })
    .eq("id", params.campaignId)
    .eq("workspace_id", params.workspaceId)
    .in("dispatch_status", ACTIVE_CAMPAIGN_DISPATCH_STATUSES)
    .select(CAMPAIGN_DISPATCH_SELECT)
    .maybeSingle();

  throwOnCampaignStoreError("cancelCampaignDispatch", cancelResult.error);
  if (cancelResult.data) {
    return {
      outcome: "cancelled",
      ...transitionStateFromRow(cancelResult.data, "cancelCampaignDispatch"),
    };
  }

  const currentResult = await table
    .select(CAMPAIGN_DISPATCH_SELECT)
    .eq("id", params.campaignId)
    .eq("workspace_id", params.workspaceId)
    .maybeSingle();
  throwOnCampaignStoreError("cancelCampaignDispatch", currentResult.error);
  if (!currentResult.data) {
    return { outcome: "not_found", status: null, workflowId: null };
  }

  const state = transitionStateFromRow(
    currentResult.data,
    "cancelCampaignDispatch"
  );
  return {
    outcome:
      state.status === "cancelled"
        ? "already_cancelled"
        : ACTIVE_CAMPAIGN_DISPATCH_STATUSES.includes(
              state.status as ActiveCampaignDispatchStatus
            )
          ? "not_cancellable"
          : "already_terminal",
    ...state,
  };
}

export async function setCampaignDispatchPaused(params: {
  supabase: CampaignStoreClient;
  workspaceId: string;
  campaignId: string;
  paused: boolean;
}): Promise<CampaignDispatchPauseResult> {
  const table = params.supabase.from("campaign_history") as SafetyStoreTable;
  const mutation = params.paused
    ? table.update({
        stop_reason: BULK_CAMPAIGN_DISPATCH_PAUSED_STOP_REASON,
      })
    : table.update({ stop_reason: null });
  const pauseResult = params.paused
    ? await mutation
        .eq("id", params.campaignId)
        .eq("workspace_id", params.workspaceId)
        .is("stop_reason", null)
        .in("dispatch_status", ACTIVE_CAMPAIGN_DISPATCH_STATUSES)
        .select(CAMPAIGN_DISPATCH_SELECT)
        .maybeSingle()
    : await mutation
        .eq("id", params.campaignId)
        .eq("workspace_id", params.workspaceId)
        .eq("stop_reason", BULK_CAMPAIGN_DISPATCH_PAUSED_STOP_REASON)
        .in("dispatch_status", ACTIVE_CAMPAIGN_DISPATCH_STATUSES)
        .select(CAMPAIGN_DISPATCH_SELECT)
        .maybeSingle();

  throwOnCampaignStoreError("setCampaignDispatchPaused", pauseResult.error);
  if (pauseResult.data) {
    return {
      outcome: params.paused ? "paused" : "resumed",
      ...transitionStateFromRow(pauseResult.data, "setCampaignDispatchPaused"),
    };
  }

  const currentResult = await table
    .select<CampaignDispatchRow>(CAMPAIGN_DISPATCH_SELECT)
    .eq("id", params.campaignId)
    .eq("workspace_id", params.workspaceId)
    .maybeSingle();
  throwOnCampaignStoreError("setCampaignDispatchPaused", currentResult.error);
  if (!currentResult.data) {
    return { outcome: "not_found", status: null, workflowId: null };
  }

  const state = transitionStateFromRow(
    currentResult.data,
    "setCampaignDispatchPaused"
  );
  const isActive = ACTIVE_CAMPAIGN_DISPATCH_STATUSES.includes(
    state.status as ActiveCampaignDispatchStatus
  );
  if (!isActive) {
    return {
      outcome: "already_terminal",
      ...state,
    };
  }
  const alreadyPaused =
    currentResult.data.stop_reason ===
    BULK_CAMPAIGN_DISPATCH_PAUSED_STOP_REASON;
  if (params.paused) {
    return alreadyPaused
      ? { outcome: "already_paused", ...state }
      : { outcome: "not_cancellable", ...state };
  }
  return alreadyPaused
    ? { outcome: "not_cancellable", ...state }
    : { outcome: "already_resumed", ...state };
}

function nonNegativeInteger(
  value: unknown,
  field: string,
  context: string
): number {
  if (!Number.isInteger(value) || Number(value) < 0) {
    throw new Error(`[${context}] ${field} must be a non-negative integer`);
  }
  return Number(value);
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function nullableInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value)) {
    return value;
  }
  if (typeof value === "string" && /^-?\d+$/.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

function parseCampaignDispatchAggregate(
  value: unknown,
  context: string
): CampaignDispatchAggregate {
  const row = asCampaignRpcRecord(value, context);
  const delivery = Object.fromEntries(
    ["pending", "accepted", "delivered", "read", "failed"].map(field => [
      field,
      nonNegativeInteger(row[field], `${field} count`, context),
    ])
  ) as CampaignDispatchAggregate["delivery"];
  const topFailureReason = nullableString(row.top_failure_reason);
  const topFailureErrorCode = nullableInteger(row.top_failure_error_code);
  const topFailureCount = topFailureReason
    ? nonNegativeInteger(row.top_failure_count, "top failure count", context)
    : null;
  const commonProvider = nullableString(row.common_provider_failure_provider);
  const commonCode = nullableString(row.common_provider_failure_code);
  const commonCount = nonNegativeInteger(
    row.common_provider_failure_count ?? 0,
    "common provider failure count",
    context
  );
  const retryableFailedRecipientCount = nonNegativeInteger(
    row.retryable_failed_recipient_count,
    "retryable failed recipient count",
    context
  );
  return {
    delivery,
    retryableFailedRecipientCount,
    topFailure: topFailureReason
      ? {
          reason: topFailureReason,
          errorCode: topFailureErrorCode,
          count: topFailureCount!,
        }
      : null,
    providerCircuit:
      commonProvider &&
      commonCode &&
      (commonProvider.trim().toLowerCase() === "meta"
        ? commonCount >= 1 && isMetaProviderRestrictionCode(commonCode)
        : commonCount >= 2)
        ? {
            state: "open",
            provider: commonProvider,
            code: commonCode,
            failureCount: commonCount,
          }
        : { state: "closed" },
  };
}

export async function getCampaignDispatchBatchAggregates(params: {
  supabase: CampaignStoreClient;
  workspaceId: string;
  campaignIds: string[];
}): Promise<Map<string, CampaignDispatchAggregate>> {
  if (params.campaignIds.length === 0) {
    return new Map();
  }
  if (!params.supabase.rpc) {
    throw new Error(
      "[get_bulk_campaign_delivery_counts_batch] required campaign lifecycle RPC is unavailable"
    );
  }
  const result = await params.supabase.rpc(
    "get_bulk_campaign_delivery_counts_batch",
    {
      p_workspace_id: params.workspaceId,
      p_campaign_ids: params.campaignIds,
    }
  );
  throwOnCampaignStoreError(
    "get_bulk_campaign_delivery_counts_batch",
    result.error
  );
  if (!Array.isArray(result.data)) {
    throw new Error(
      "[get_bulk_campaign_delivery_counts_batch] malformed RPC result"
    );
  }

  const requestedIds = new Set(params.campaignIds);
  const aggregates = new Map<string, CampaignDispatchAggregate>();
  for (const value of result.data) {
    const row = asCampaignRpcRecord(
      value,
      "get_bulk_campaign_delivery_counts_batch"
    );
    const campaignId = nullableString(row.campaign_id);
    if (
      !campaignId ||
      !requestedIds.has(campaignId) ||
      aggregates.has(campaignId)
    ) {
      throw new Error(
        "[get_bulk_campaign_delivery_counts_batch] invalid campaign aggregate"
      );
    }
    aggregates.set(
      campaignId,
      parseCampaignDispatchAggregate(
        row,
        "get_bulk_campaign_delivery_counts_batch"
      )
    );
  }
  return aggregates;
}

function providerFailureFromRow(row: FailedCampaignMessageRow) {
  let code =
    typeof row.error_code === "string" ||
    (typeof row.error_code === "number" && Number.isFinite(row.error_code))
      ? row.error_code
      : null;
  let scope = nullableString(row.failure_scope);
  const legacyFailureReason = nullableString(row.failure_reason);
  if (legacyFailureReason?.startsWith("{")) {
    try {
      const structured = JSON.parse(legacyFailureReason) as Record<
        string,
        unknown
      >;
      if (code === null && typeof structured.providerCode === "string") {
        const legacyCode = structured.providerCode.trim();
        // Match SQL: a persisted provider code wins over older serialized data.
        // Meta codes are numeric; local policy reasons must remain local.
        code =
          nullableString(row.provider)?.trim().toLowerCase() === "meta"
            ? /^\d+$/.test(legacyCode)
              ? legacyCode
              : null
            : structured.providerCode;
      }
      scope = scope || nullableString(structured.providerScope);
    } catch {
      // Legacy free-text failure reasons are handled below.
    }
  }
  scope = scope || legacyFailureReason;
  return {
    provider: nullableString(row.provider),
    code,
    scope,
    message: nullableString(row.error_message),
  };
}

async function loadRetryableCampaignSnapshots(params: {
  supabase: CampaignStoreClient;
  workspaceId: string;
  campaignId: string;
}): Promise<CampaignFailedSnapshotForRetry[]> {
  if (!params.supabase.rpc) {
    throw new Error(
      "[get_bulk_campaign_retryable_snapshots] required campaign lifecycle RPC is unavailable"
    );
  }
  const result = await params.supabase.rpc(
    "get_bulk_campaign_retryable_snapshots",
    {
      p_workspace_id: params.workspaceId,
      p_campaign_id: params.campaignId,
    }
  );
  throwOnCampaignStoreError(
    "get_bulk_campaign_retryable_snapshots",
    result.error
  );
  if (!Array.isArray(result.data)) {
    throw new Error(
      "[get_bulk_campaign_retryable_snapshots] malformed RPC result"
    );
  }
  return result.data.map(value =>
    parseFailedSnapshotRow(
      asCampaignRpcRecord(value, "get_bulk_campaign_retryable_snapshots"),
      params.campaignId
    )
  );
}

/** The dispatch gate needs the indexed campaign row, not a recipient-ledger scan. */
export async function getCampaignDispatchProviderCircuit(params: {
  supabase: CampaignStoreClient;
  workspaceId: string;
  campaignId: string;
}): Promise<
  { state: "closed" } | { state: "open"; provider: string; code: string }
> {
  const context = "getCampaignDispatchProviderCircuit";
  const result = await (
    params.supabase.from("campaign_history") as SafetyStoreTable
  )
    .select<CampaignDispatchRow>(
      "id,workspace_id,provider_circuit_state,provider_circuit_provider,provider_circuit_code"
    )
    .eq("id", params.campaignId)
    .eq("workspace_id", params.workspaceId)
    .maybeSingle();
  throwOnCampaignStoreError(context, result.error);
  const row = result.data;
  if (
    !row ||
    row.id !== params.campaignId ||
    row.workspace_id !== params.workspaceId
  ) {
    throw new Error(
      `[${context}] workspace-scoped campaign is missing or malformed`
    );
  }
  if (row.provider_circuit_state === "closed") return { state: "closed" };
  const provider = nullableString(row.provider_circuit_provider)?.trim();
  const code = nullableString(row.provider_circuit_code)?.trim();
  if (row.provider_circuit_state !== "open" || !provider || !code) {
    throw new Error(`[${context}] provider circuit metadata is malformed`);
  }
  return { state: "open", provider, code };
}

export async function getCampaignDispatchStatus(params: {
  supabase: CampaignStoreClient;
  workspaceId: string;
  campaignId: string;
}): Promise<CampaignDispatchPublicStatus | null> {
  const historyResult = await (
    params.supabase.from("campaign_history") as SafetyStoreTable
  )
    .select<CampaignDispatchRow>(CAMPAIGN_DISPATCH_SELECT)
    .eq("id", params.campaignId)
    .eq("workspace_id", params.workspaceId)
    .maybeSingle();
  throwOnCampaignStoreError("getCampaignDispatchStatus", historyResult.error);
  if (!historyResult.data) {
    return null;
  }

  const row = historyResult.data;
  if (
    typeof row.id !== "string" ||
    typeof row.workspace_id !== "string" ||
    row.id !== params.campaignId ||
    row.workspace_id !== params.workspaceId
  ) {
    throw new Error(
      "[getCampaignDispatchStatus] workspace-scoped campaign result is malformed"
    );
  }

  const deliveryCounts = await executeRequiredCampaignRpc(
    params.supabase,
    "get_bulk_campaign_delivery_counts",
    { p_campaign_id: params.campaignId }
  );
  const aggregate = parseCampaignDispatchAggregate(
    deliveryCounts,
    "getCampaignDispatchStatus"
  );
  const delivery = aggregate.delivery;

  const circuitState =
    row.provider_circuit_state === "open"
      ? "open"
      : row.provider_circuit_state === "closed"
        ? "closed"
        : null;
  if (!circuitState) {
    throw new Error(
      "[getCampaignDispatchStatus] invalid provider_circuit_state"
    );
  }
  const retryKind =
    row.retry_kind === "failed_only" || row.retry_kind === "send_again"
      ? row.retry_kind
      : null;

  return {
    campaignId: row.id,
    workspaceId: row.workspace_id,
    workflowId: nullableString(row.workflow_id),
    status: parseCampaignDispatchStatus(
      row.dispatch_status,
      "getCampaignDispatchStatus"
    ),
    requestedAt: nullableString(row.requested_at),
    scheduledAt: nullableString(row.scheduled_at),
    dispatchExpiresAt: nullableString(row.dispatch_expires_at),
    startedAt: nullableString(row.started_at),
    progressAt: nullableString(row.progress_at),
    finishedAt: nullableString(row.finished_at),
    cancelledAt: nullableString(row.cancelled_at),
    expiredAt: nullableString(row.expired_at),
    totalRecipients: nonNegativeInteger(
      row.total_recipients ?? 0,
      "total_recipients",
      "getCampaignDispatchStatus"
    ),
    progress: {
      processed: nonNegativeInteger(
        row.processed_count ?? 0,
        "processed_count",
        "getCampaignDispatchStatus"
      ),
      accepted: nonNegativeInteger(
        row.accepted_count ?? 0,
        "accepted_count",
        "getCampaignDispatchStatus"
      ),
      attempted: nonNegativeInteger(
        row.attempted_count ?? 0,
        "attempted_count",
        "getCampaignDispatchStatus"
      ),
      notAttempted: nonNegativeInteger(
        row.not_attempted_count ?? 0,
        "not_attempted_count",
        "getCampaignDispatchStatus"
      ),
      successful: nonNegativeInteger(
        row.successful_sends ?? 0,
        "successful_sends",
        "getCampaignDispatchStatus"
      ),
      failed: nonNegativeInteger(
        row.failed_sends ?? 0,
        "failed_sends",
        "getCampaignDispatchStatus"
      ),
    },
    delivery,
    stopReason: nullableString(row.stop_reason),
    providerCircuit: {
      state:
        circuitState === "open" || aggregate.providerCircuit.state === "open"
          ? "open"
          : "closed",
      provider:
        circuitState === "open"
          ? nullableString(row.provider_circuit_provider)
          : aggregate.providerCircuit.state === "open"
            ? aggregate.providerCircuit.provider
            : null,
      code:
        circuitState === "open"
          ? nullableString(row.provider_circuit_code)
          : aggregate.providerCircuit.state === "open"
            ? aggregate.providerCircuit.code
            : null,
      openedAt: nullableString(row.provider_circuit_opened_at),
      failureCount:
        aggregate.providerCircuit.state === "open"
          ? aggregate.providerCircuit.failureCount
          : circuitState === "open"
            ? Math.max(
                delivery.failed,
                nonNegativeInteger(
                  row.failed_sends ?? 0,
                  "failed_sends",
                  "getCampaignDispatchStatus"
                )
              )
            : 0,
    },
    retry: {
      ofCampaignId: nullableString(row.retry_of_campaign_id),
      kind: retryKind,
    },
    retryableFailedRecipientCount: aggregate.retryableFailedRecipientCount,
  };
}

function parseFailedSnapshotRow(
  row: FailedCampaignMessageRow,
  campaignId: string
): CampaignFailedSnapshotForRetry {
  const channel = row.channel;
  const snapshot = row.dispatch_snapshot;
  if (
    row.campaign_id !== campaignId ||
    !RETRYABLE_CAMPAIGN_MESSAGE_STATUSES.includes(
      row.status as (typeof RETRYABLE_CAMPAIGN_MESSAGE_STATUSES)[number]
    ) ||
    (channel !== "whatsapp" && channel !== "telegram" && channel !== "email") ||
    typeof row.recipient !== "string" ||
    !row.recipient ||
    !Number.isInteger(row.snapshot_ordinal) ||
    Number(row.snapshot_ordinal) < 0 ||
    !snapshot ||
    typeof snapshot !== "object" ||
    Array.isArray(snapshot)
  ) {
    throw new Error(
      "[selectFailedCampaignSnapshotsForRetry] malformed immutable snapshot"
    );
  }

  return {
    campaignId,
    channel,
    recipient: row.recipient,
    snapshotOrdinal: Number(row.snapshot_ordinal),
    dispatchSnapshot: snapshot as Record<string, unknown>,
    providerFailure: providerFailureFromRow(row),
  };
}

export async function selectFailedCampaignSnapshotsForRetry(params: {
  supabase: CampaignStoreClient;
  workspaceId: string;
  campaignId: string;
}): Promise<CampaignFailedSnapshotForRetry[]> {
  const campaignResult = await (
    params.supabase.from("campaign_history") as SafetyStoreTable
  )
    .select<CampaignDispatchRow>("id")
    .eq("id", params.campaignId)
    .eq("workspace_id", params.workspaceId)
    .maybeSingle();
  throwOnCampaignStoreError(
    "selectFailedCampaignSnapshotsForRetry",
    campaignResult.error
  );
  if (!campaignResult.data) {
    return [];
  }

  return loadRetryableCampaignSnapshots(params);
}

const CAMPAIGN_RETRY_PREPARATION_SELECT = [
  "id",
  "workspace_id",
  "channel",
  "name",
  "template_name",
  "template_language",
  "message_text",
  "total_recipients",
  "dispatch_status",
  "provider_circuit_state",
  "provider_circuit_provider",
  "provider_circuit_code",
  "provider_circuit_opened_at",
  "provider_circuit_acknowledged_at",
  "provider_circuit_acknowledged_by",
  "retry_of_campaign_id",
].join(",");

/** Resolve retry audit ancestry only on an explicit retry, never per history row. */
async function resolveCampaignRetryAncestorCircuit(params: {
  supabase: CampaignStoreClient;
  workspaceId: string;
  source: CampaignDispatchRow;
}): Promise<CampaignRetryPreparation["ancestorProviderCircuit"]> {
  const visited = new Set([params.source.id]);
  const ancestors: CampaignDispatchRow[] = [];
  let current = params.source;
  while (true) {
    const acknowledgedAt = nullableString(
      current.provider_circuit_acknowledged_at
    );
    const acknowledgedBy = nullableString(
      current.provider_circuit_acknowledged_by
    )?.trim();
    if (acknowledgedAt || acknowledgedBy) {
      if (
        !acknowledgedAt ||
        !acknowledgedBy ||
        !Number.isFinite(Date.parse(acknowledgedAt))
      ) {
        throw new Error(
          "[prepareFailedCampaignRetry] retry ancestry acknowledgment is malformed"
        );
      }
      // This acknowledgment settles older audit warnings. The current run's own
      // failures and live provider health are evaluated independently.
      break;
    }
    const parentId = nullableString(current.retry_of_campaign_id)?.trim();
    if (!parentId) break;
    if (visited.has(parentId) || ancestors.length >= 20) {
      throw new Error(
        "[prepareFailedCampaignRetry] retry ancestry is cyclic or exceeds twenty ancestors"
      );
    }
    visited.add(parentId);
    const result = await (
      params.supabase.from("campaign_history") as SafetyStoreTable
    )
      .select<CampaignDispatchRow>(CAMPAIGN_RETRY_PREPARATION_SELECT)
      .eq("id", parentId)
      .eq("workspace_id", params.workspaceId)
      .maybeSingle();
    throwOnCampaignStoreError(
      "prepareFailedCampaignRetry retry ancestry",
      result.error
    );
    const ancestor = result.data;
    if (
      !ancestor ||
      ancestor.id !== parentId ||
      ancestor.workspace_id !== params.workspaceId ||
      ancestor.channel !== params.source.channel
    ) {
      throw new Error(
        "[prepareFailedCampaignRetry] retry ancestry is missing or outside the campaign workspace/channel"
      );
    }
    if (
      ancestor.provider_circuit_state !== "closed" &&
      ancestor.provider_circuit_state !== "open"
    ) {
      throw new Error(
        "[prepareFailedCampaignRetry] retry ancestry circuit is malformed"
      );
    }
    ancestors.push(ancestor);
    current = ancestor;
  }
  if (!ancestors.length) return undefined;
  // Reuse the canonical historical Meta classifier in one workspace-scoped
  // aggregate RPC, without loading each ancestor's immutable recipient snapshots.
  const aggregates = await getCampaignDispatchBatchAggregates({
    supabase: params.supabase,
    workspaceId: params.workspaceId,
    campaignIds: ancestors.map(ancestor => ancestor.id!),
  });
  for (const ancestor of ancestors) {
    const aggregate = aggregates.get(ancestor.id!);
    if (!aggregate)
      throw new Error(
        "[prepareFailedCampaignRetry] retry ancestry aggregate is missing"
      );
    if (ancestor.provider_circuit_state === "open") {
      const provider = nullableString(ancestor.provider_circuit_provider)
        ?.trim()
        .toLowerCase();
      const code = nullableString(ancestor.provider_circuit_code)?.trim();
      if (!provider || !code)
        throw new Error(
          "[prepareFailedCampaignRetry] retry ancestry circuit metadata is malformed"
        );
      return {
        state: "open",
        provider,
        code,
        failureCount: Math.max(
          aggregate.delivery.failed,
          aggregate.providerCircuit.state === "open"
            ? aggregate.providerCircuit.failureCount
            : 0
        ),
      };
    }
    if (aggregate.providerCircuit.state === "open")
      return aggregate.providerCircuit;
  }
  return undefined;
}

export async function prepareFailedCampaignRetry(params: {
  supabase: CampaignStoreClient;
  workspaceId: string;
  campaignId: string;
}): Promise<CampaignRetryPreparation | null> {
  const campaignResult = await (
    params.supabase.from("campaign_history") as SafetyStoreTable
  )
    .select<CampaignDispatchRow>(CAMPAIGN_RETRY_PREPARATION_SELECT)
    .eq("id", params.campaignId)
    .eq("workspace_id", params.workspaceId)
    .maybeSingle();
  throwOnCampaignStoreError("prepareFailedCampaignRetry", campaignResult.error);
  if (!campaignResult.data) {
    return null;
  }

  const row = campaignResult.data;
  const channel = row.channel;
  if (
    row.id !== params.campaignId ||
    row.workspace_id !== params.workspaceId ||
    (channel !== "whatsapp" && channel !== "telegram" && channel !== "email") ||
    typeof row.name !== "string" ||
    !row.name.trim()
  ) {
    throw new Error("[prepareFailedCampaignRetry] malformed source campaign");
  }
  const providerCircuitState =
    row.provider_circuit_state === "open"
      ? "open"
      : row.provider_circuit_state === "closed"
        ? "closed"
        : null;
  if (!providerCircuitState) {
    throw new Error(
      "[prepareFailedCampaignRetry] invalid provider circuit state"
    );
  }

  const [failedSnapshots, ancestorProviderCircuit] = await Promise.all([
    loadRetryableCampaignSnapshots(params),
    resolveCampaignRetryAncestorCircuit({
      supabase: params.supabase,
      workspaceId: params.workspaceId,
      source: row,
    }),
  ]);

  return {
    source: {
      campaignId: row.id,
      workspaceId: row.workspace_id,
      channel,
      name: row.name.trim(),
      templateName: nullableString(row.template_name),
      templateLanguage: nullableString(row.template_language),
      messageText: nullableString(row.message_text),
      totalRecipients: nonNegativeInteger(
        row.total_recipients ?? 0,
        "total_recipients",
        "prepareFailedCampaignRetry"
      ),
      status: parseCampaignDispatchStatus(
        row.dispatch_status,
        "prepareFailedCampaignRetry"
      ),
      providerCircuit: {
        state: providerCircuitState,
        provider: nullableString(row.provider_circuit_provider),
        code: nullableString(row.provider_circuit_code),
        openedAt: nullableString(row.provider_circuit_opened_at),
      },
    },
    failedSnapshots,
    ...(ancestorProviderCircuit ? { ancestorProviderCircuit } : {}),
  };
}
