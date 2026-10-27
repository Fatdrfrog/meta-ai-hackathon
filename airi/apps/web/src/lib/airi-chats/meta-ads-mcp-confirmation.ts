import "server-only";

import { randomUUID } from "node:crypto";
import { parseAiriCreativeAssetUri } from "@/lib/airi-chats/creative-asset-refs";
import {
  executeConfirmedMetaAdsMcpMutation,
  resolveWorkspaceMetaAdsMcpAccessToken,
  type MetaAdsMcpMutationExecutionResult,
  type MetaAdsMcpPendingMutation,
} from "@/lib/meta-ads/mcp/agent-loop";
import { loadMetaAdsMcpCreativeAssetReferences } from "@/lib/meta-ads/mcp/creative-assets";
import {
  isMetaAdsMcpTransactionExpired,
  META_ADS_MCP_TRANSACTION_EXPIRED_ERROR,
  META_ADS_MCP_TRANSACTION_TTL_MS,
  type MetaAdsMcpTransactionV2,
} from "@/lib/meta-ads/mcp/confirmation-contract";
import { verifyMetaAdsMcpTransaction } from "@/lib/meta-ads/mcp/confirmation-contract.server";
import { createMetaAdsMcpOperationEvent } from "@/lib/meta-ads/mcp/operation-event";
import type { createClient } from "@/lib/supabase/server";
import { Types } from "mongoose";
import {
  airiMetaAdsMcpConfirmationStore,
  type AiriMetaAdsMcpConfirmationExecution,
  type AiriMetaAdsMcpConfirmationStatusV2,
  type AiriMetaAdsMcpConfirmationResultMessage,
  type AiriMetaAdsMcpConfirmationStore,
} from "./meta-ads-mcp-confirmation-store";

export type {
  AiriMetaAdsMcpConfirmationExecution,
  AiriMetaAdsMcpConfirmationStore,
} from "./meta-ads-mcp-confirmation-store";

type SupabaseClient = Awaited<ReturnType<typeof createClient>>;
const META_ADS_RECONCILIATION_DELAY_MS = 5 * 60 * 1_000;
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;

export type AiriMetaAdsMcpConfirmationErrorCode =
  | "CONFIRMATION_INVALID_REQUEST"
  | "CONFIRMATION_NOT_FOUND"
  | "CONFIRMATION_IN_PROGRESS"
  | "CONFIRMATION_STATE_CONFLICT";

export class AiriMetaAdsMcpConfirmationError extends Error {
  readonly code: AiriMetaAdsMcpConfirmationErrorCode;

  constructor(code: AiriMetaAdsMcpConfirmationErrorCode, message: string) {
    super(message);
    this.name = "AiriMetaAdsMcpConfirmationError";
    this.code = code;
  }
}

export type ConfirmAiriMetaAdsMcpMutationInput = {
  supabase: SupabaseClient;
  workspaceId: string;
  userId: string;
  threadId: string;
  messageId: string;
  mutationId: string;
  transactionDigest: string;
};

export type ConfirmAiriMetaAdsMcpMutationResult = {
  assistantMessage: AiriMetaAdsMcpConfirmationResultMessage;
  confirmedMutationId: string;
  executionStatus: Exclude<AiriMetaAdsMcpConfirmationStatusV2, "executing">;
  replayed: boolean;
};

export type ReconcileAiriMetaAdsMcpMutationInput = Omit<
  ConfirmAiriMetaAdsMcpMutationInput,
  "transactionDigest"
> & {
  transactionDigest?: string;
  resolution: "succeeded" | "not_executed";
  note: string;
  providerIdentifiers?: Array<{ kind: string; id: string }>;
};

export type AiriMetaAdsMcpConfirmationServiceDependencies = {
  store: AiriMetaAdsMcpConfirmationStore;
  executeMutation(input: {
    supabase: SupabaseClient;
    workspaceId: string;
    mutation: MetaAdsMcpPendingMutation;
  }): Promise<MetaAdsMcpMutationExecutionResult>;
  now(): Date;
  createClaimToken(): string;
  createResultMessageId(): string;
};

export type AiriMetaAdsMcpConfirmationService = {
  confirm(
    input: ConfirmAiriMetaAdsMcpMutationInput
  ): Promise<ConfirmAiriMetaAdsMcpMutationResult>;
  reconcile(
    input: ReconcileAiriMetaAdsMcpMutationInput
  ): Promise<ConfirmAiriMetaAdsMcpMutationResult>;
};

function confirmationError(
  code: AiriMetaAdsMcpConfirmationErrorCode,
  message: string
): never {
  throw new AiriMetaAdsMcpConfirmationError(code, message);
}

function validateDigest(value: string): void {
  if (!SHA256_HEX_PATTERN.test(value)) {
    confirmationError(
      "CONFIRMATION_INVALID_REQUEST",
      "Invalid Meta Ads confirmation request"
    );
  }
}

function publicTerminalStatus(
  execution: AiriMetaAdsMcpConfirmationExecution
): Exclude<AiriMetaAdsMcpConfirmationStatusV2, "executing"> {
  if (execution.status === "executing") {
    confirmationError(
      "CONFIRMATION_IN_PROGRESS",
      "This Meta Ads change is already being confirmed. Review Meta before retrying if it does not finish."
    );
  }
  return execution.status === "rejected" ? "not_executed" : execution.status;
}

function collectCreativeAssetIds(
  value: unknown,
  output = new Set<string>()
): Set<string> {
  if (typeof value === "string") {
    const id = parseAiriCreativeAssetUri(value);
    if (id) output.add(id);
    return output;
  }
  if (Array.isArray(value)) {
    value.forEach(item => collectCreativeAssetIds(item, output));
    return output;
  }
  if (!value || typeof value !== "object") return output;
  Object.values(value as Record<string, unknown>).forEach(item =>
    collectCreativeAssetIds(item, output)
  );
  return output;
}

function creativeFacts(
  references: Array<{ id: string; kind: string; name: string }>
): Array<{ id: string; kind: string; name: string }> {
  return references
    .map(reference => ({
      id: reference.id,
      kind: reference.kind,
      name: reference.name,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function factsMatch(
  left: Array<{ id: string; kind: string; name: string }>,
  right: Array<{ id: string; kind: string; name: string }>
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (fact, index) =>
        fact.id === right[index]?.id &&
        fact.kind === right[index]?.kind &&
        fact.name === right[index]?.name
    )
  );
}

async function verifyCheapConfirmationFacts(input: {
  supabase: SupabaseClient;
  workspaceId: string;
  transaction: MetaAdsMcpTransactionV2;
}): Promise<void> {
  const verified = verifyMetaAdsMcpTransaction(input.transaction);
  if (!verified.ok) {
    confirmationError(
      "CONFIRMATION_STATE_CONFLICT",
      "The reviewed Meta Ads transaction changed. Prepare a new action."
    );
  }

  let current: Awaited<
    ReturnType<typeof resolveWorkspaceMetaAdsMcpAccessToken>
  >;
  try {
    current = await resolveWorkspaceMetaAdsMcpAccessToken({
      supabase: input.supabase,
      workspaceId: input.workspaceId,
      expectedSourceId: input.transaction.target.sourceId,
    });
  } catch {
    confirmationError(
      "CONFIRMATION_STATE_CONFLICT",
      "The Meta Ads connection could not be verified. Prepare a new action."
    );
  }
  const connectionId =
    typeof current.credentials?.mcp_connection_id === "string"
      ? current.credentials.mcp_connection_id
      : null;
  if (
    current.sourceId !== input.transaction.target.sourceId ||
    connectionId !== input.transaction.target.connectionId ||
    current.readiness.selectedAsset?.adAccountId !==
      input.transaction.target.adAccountId ||
    current.selectedAdAccount?.id !== input.transaction.target.adAccountId ||
    !current.readiness.canWrite
  ) {
    confirmationError(
      "CONFIRMATION_STATE_CONFLICT",
      "The Meta Ads connection or selected account changed. Prepare a new action."
    );
  }

  const referencedAssetIds = Array.from(
    collectCreativeAssetIds(input.transaction.logicalArguments)
  ).sort();
  const disclosedFacts = creativeFacts(
    input.transaction.disclosure.creativeAssets
  );
  if (
    referencedAssetIds.length !== disclosedFacts.length ||
    referencedAssetIds.some((id, index) => id !== disclosedFacts[index]?.id)
  ) {
    confirmationError(
      "CONFIRMATION_STATE_CONFLICT",
      "The reviewed Creative Asset references changed. Prepare a new action."
    );
  }
  try {
    const currentReferences = referencedAssetIds.length
      ? await loadMetaAdsMcpCreativeAssetReferences({
          workspaceId: input.workspaceId,
          assetIds: referencedAssetIds,
        })
      : [];
    if (!factsMatch(creativeFacts(currentReferences), disclosedFacts)) {
      confirmationError(
        "CONFIRMATION_STATE_CONFLICT",
        "A reviewed Creative Asset changed. Prepare a new action."
      );
    }
  } catch (error) {
    if (error instanceof AiriMetaAdsMcpConfirmationError) throw error;
    confirmationError(
      "CONFIRMATION_STATE_CONFLICT",
      "A reviewed Creative Asset is no longer available. Prepare a new action."
    );
  }
}

function requireV2ExecutionTransaction(
  execution: AiriMetaAdsMcpConfirmationExecution,
  transactionDigest: string
): MetaAdsMcpTransactionV2 {
  if (
    execution.version !== 2 ||
    execution.transaction.transactionDigest !== transactionDigest
  ) {
    confirmationError(
      "CONFIRMATION_STATE_CONFLICT",
      "This Meta Ads confirmation is expired or no longer matches the reviewed action."
    );
  }
  const verified = verifyMetaAdsMcpTransaction(execution.transaction);
  if (!verified.ok) {
    confirmationError(
      "CONFIRMATION_STATE_CONFLICT",
      "The reviewed Meta Ads transaction changed. Prepare a new action."
    );
  }
  return execution.transaction;
}

function requestedStatusSummary(transaction: MetaAdsMcpTransactionV2): string {
  const requestedStatuses = Array.from(
    new Set(
      transaction.disclosure.entities.flatMap(entity =>
        entity.requestedStatus ? [entity.requestedStatus] : []
      )
    )
  );
  return requestedStatuses.length > 0
    ? requestedStatuses.join(", ")
    : "No explicit entity status requested";
}

function buildTerminalOutcome(
  transaction: MetaAdsMcpTransactionV2,
  result: MetaAdsMcpMutationExecutionResult
): {
  status: Exclude<AiriMetaAdsMcpConfirmationStatusV2, "executing">;
  responseContent: string;
  error: string | null;
  effectiveArgumentsSha256?: string;
  materializedCreativeAssetIds?: string[];
} {
  const requestedStatus = requestedStatusSummary(transaction);
  if (result.ok) {
    return {
      status: "succeeded",
      responseContent: `Requested status: **${requestedStatus}**\n\nProvider outcome: **Completed**\n\nMeta Ads completed **${transaction.tool.name}**.`,
      error: null,
      effectiveArgumentsSha256: result.effectiveArgumentsSha256,
      materializedCreativeAssetIds: result.materializedCreativeAssetIds,
    };
  }
  if (
    result.outcome === "not_executed" &&
    result.error === META_ADS_MCP_TRANSACTION_EXPIRED_ERROR
  ) {
    return {
      status: "not_executed",
      responseContent: `Requested status: **${requestedStatus}**\n\nProvider outcome: **Not executed (expired)**\n\nThis prepared change expired ${META_ADS_MCP_TRANSACTION_TTL_MS / 60_000} minutes after Airi prepared it, so nothing was sent to Meta. Ask Airi to prepare it again with current data.`,
      error: result.error,
    };
  }
  if (result.outcome === "not_executed") {
    return {
      status: "not_executed",
      responseContent: `Requested status: **${requestedStatus}**\n\nProvider outcome: **Not executed**\n\nNo Meta Ads change was sent. Prepare a new action after resolving the connection or review conflict.`,
      error: result.error,
    };
  }
  return {
    status: "outcome_unknown",
    responseContent: `Requested status: **${requestedStatus}**\n\nProvider outcome: **Unknown**\n\nThe Meta Ads write was sent, but Airi could not verify the outcome. Review Meta Ads Manager before taking another action.`,
    error: result.error,
    effectiveArgumentsSha256: result.effectiveArgumentsSha256,
    materializedCreativeAssetIds: result.materializedCreativeAssetIds,
  };
}

function normalizeReconciliationInput(
  input: ReconcileAiriMetaAdsMcpMutationInput
): {
  note: string;
  providerIdentifiers?: Array<{ kind: string; id: string }>;
} {
  const note = input.note.trim();
  if (!note || note.length > 500) {
    confirmationError(
      "CONFIRMATION_INVALID_REQUEST",
      "Invalid Meta Ads reconciliation request"
    );
  }
  const identifiers = input.providerIdentifiers?.map(identifier => ({
    kind: identifier.kind.trim(),
    id: identifier.id.trim(),
  }));
  if (
    identifiers &&
    (identifiers.length > 20 ||
      identifiers.some(
        identifier =>
          !identifier.kind ||
          identifier.kind.length > 100 ||
          !identifier.id ||
          identifier.id.length > 200
      ))
  ) {
    confirmationError(
      "CONFIRMATION_INVALID_REQUEST",
      "Invalid Meta Ads reconciliation request"
    );
  }
  if (input.resolution === "not_executed" && identifiers?.length) {
    confirmationError(
      "CONFIRMATION_INVALID_REQUEST",
      "Provider identifiers are only accepted for a completed provider outcome"
    );
  }
  return {
    note,
    ...(identifiers?.length ? { providerIdentifiers: identifiers } : {}),
  };
}

function buildReconciledOutcome(params: {
  execution: AiriMetaAdsMcpConfirmationExecution;
  resolution: "succeeded" | "not_executed";
}): { responseContent: string; error: string | null } {
  const requestedStatus =
    params.execution.version === 2
      ? requestedStatusSummary(params.execution.transaction)
      : "Unavailable for this legacy confirmation";
  const toolName =
    params.execution.version === 2
      ? params.execution.transaction.tool.name
      : params.execution.toolName;
  if (params.resolution === "succeeded") {
    return {
      responseContent: `Requested status: **${requestedStatus}**\n\nProvider outcome: **Completed (manually reviewed)**\n\nThis records your review of **${toolName}** and did not run the Meta action again.`,
      error: null,
    };
  }
  return {
    responseContent: `Requested status: **${requestedStatus}**\n\nProvider outcome: **Not completed (manually reviewed)**\n\nThis records your review of **${toolName}** and did not run the Meta action again.`,
    error: "Recorded as not completed after manual review",
  };
}

export function createAiriMetaAdsMcpConfirmationService(
  dependencies: AiriMetaAdsMcpConfirmationServiceDependencies
): AiriMetaAdsMcpConfirmationService {
  async function resolveExistingExecution(input: {
    request: Pick<
      ConfirmAiriMetaAdsMcpMutationInput,
      "workspaceId" | "threadId" | "messageId"
    >;
    execution: AiriMetaAdsMcpConfirmationExecution;
  }): Promise<ConfirmAiriMetaAdsMcpMutationResult> {
    const executionStatus = publicTerminalStatus(input.execution);
    const assistantMessage = await dependencies.store.ensureResultMessage({
      workspaceId: input.request.workspaceId,
      threadId: input.request.threadId,
      sourceMessageId: input.request.messageId,
      execution: input.execution,
    });
    return {
      assistantMessage,
      confirmedMutationId: input.execution.id,
      executionStatus,
      replayed: true,
    };
  }

  async function confirm(
    input: ConfirmAiriMetaAdsMcpMutationInput
  ): Promise<ConfirmAiriMetaAdsMcpMutationResult> {
    validateDigest(input.transactionDigest);
    const stateInput = {
      workspaceId: input.workspaceId,
      threadId: input.threadId,
      messageId: input.messageId,
      mutationId: input.mutationId,
    };
    const initial = await dependencies.store.loadState(stateInput);
    if (!initial) {
      confirmationError("CONFIRMATION_NOT_FOUND", "Message not found");
    }
    if (initial.execution) {
      requireV2ExecutionTransaction(initial.execution, input.transactionDigest);
      return resolveExistingExecution({
        request: input,
        execution: initial.execution,
      });
    }
    if (!initial.pendingMutation) {
      confirmationError(
        "CONFIRMATION_NOT_FOUND",
        "Pending Meta Ads MCP mutation not found"
      );
    }
    if (
      !("version" in initial.pendingMutation) ||
      initial.pendingMutation.version !== 2
    ) {
      confirmationError(
        "CONFIRMATION_STATE_CONFLICT",
        "This legacy Meta Ads confirmation has expired. Prepare a new action."
      );
    }
    if (initial.pendingMutation.transactionDigest !== input.transactionDigest) {
      confirmationError(
        "CONFIRMATION_STATE_CONFLICT",
        "The Meta Ads confirmation digest no longer matches the reviewed action."
      );
    }
    // An expired card is claimed and recorded as not executed, so the stored
    // message shows the expiry and the card cannot be confirmed again.
    const expired = isMetaAdsMcpTransactionExpired(
      initial.pendingMutation,
      dependencies.now().getTime()
    );
    if (!expired)
      await verifyCheapConfirmationFacts({
        supabase: input.supabase,
        workspaceId: input.workspaceId,
        transaction: initial.pendingMutation,
      });

    const claimed = await dependencies.store.claim({
      ...stateInput,
      transactionDigest: input.transactionDigest,
      claimToken: dependencies.createClaimToken(),
      resultMessageId: dependencies.createResultMessageId(),
      confirmedByUserId: input.userId,
      claimedAt: dependencies.now().toISOString(),
    });
    if (!claimed) {
      const current = await dependencies.store.loadState(stateInput);
      if (current?.execution) {
        requireV2ExecutionTransaction(
          current.execution,
          input.transactionDigest
        );
        return resolveExistingExecution({
          request: input,
          execution: current.execution,
        });
      }
      confirmationError(
        "CONFIRMATION_STATE_CONFLICT",
        "Meta Ads confirmation state changed before it could be claimed"
      );
    }
    if (claimed.version !== 2) {
      confirmationError(
        "CONFIRMATION_STATE_CONFLICT",
        "Meta Ads confirmation could not be safely claimed"
      );
    }

    let executionResult: MetaAdsMcpMutationExecutionResult;
    try {
      executionResult = expired
        ? {
            ok: false,
            outcome: "not_executed",
            dispatchStarted: false,
            error: META_ADS_MCP_TRANSACTION_EXPIRED_ERROR,
          }
        : await dependencies.executeMutation({
            supabase: input.supabase,
            workspaceId: input.workspaceId,
            mutation: claimed.transaction,
          });
    } catch {
      executionResult = {
        ok: false,
        outcome: "outcome_unknown",
        dispatchStarted: true,
        error: "Meta Ads execution failed unexpectedly after confirmation",
        materializedCreativeAssetIds: [],
      };
    }
    const terminal = buildTerminalOutcome(claimed.transaction, executionResult);
    const completed = await dependencies.store.complete({
      ...stateInput,
      claimToken: claimed.claimToken,
      ...terminal,
      completedAt: dependencies.now().toISOString(),
    });
    if (!completed) {
      confirmationError(
        "CONFIRMATION_STATE_CONFLICT",
        "Meta Ads confirmation result could not be persisted; review Meta before retrying"
      );
    }
    const assistantMessage = await dependencies.store.ensureResultMessage({
      workspaceId: input.workspaceId,
      threadId: input.threadId,
      sourceMessageId: input.messageId,
      execution: completed,
    });
    return {
      assistantMessage,
      confirmedMutationId: completed.id,
      executionStatus: publicTerminalStatus(completed),
      replayed: false,
    };
  }

  async function reconcile(
    input: ReconcileAiriMetaAdsMcpMutationInput
  ): Promise<ConfirmAiriMetaAdsMcpMutationResult> {
    if (input.transactionDigest !== undefined) {
      validateDigest(input.transactionDigest);
    }
    const normalized = normalizeReconciliationInput(input);
    const stateInput = {
      workspaceId: input.workspaceId,
      threadId: input.threadId,
      messageId: input.messageId,
      mutationId: input.mutationId,
    };
    const current = await dependencies.store.loadState(stateInput);
    if (!current?.execution) {
      confirmationError(
        "CONFIRMATION_NOT_FOUND",
        "Meta Ads confirmation execution not found"
      );
    }
    const transaction =
      current.execution.version === 2
        ? requireV2ExecutionTransaction(
            current.execution,
            input.transactionDigest ??
              confirmationError(
                "CONFIRMATION_INVALID_REQUEST",
                "A transaction digest is required for this Meta Ads reconciliation"
              )
          )
        : null;
    if (
      current.execution.status === "succeeded" ||
      current.execution.status === "not_executed" ||
      current.execution.status === "rejected" ||
      current.execution.reconciliation !== undefined
    ) {
      return resolveExistingExecution({
        request: input,
        execution: current.execution,
      });
    }

    const priorStatus = current.execution.status;
    if (priorStatus === "executing") {
      const claimedAt = Date.parse(current.execution.claimedAt);
      const ageMs = dependencies.now().getTime() - claimedAt;
      if (!Number.isFinite(ageMs) || ageMs < META_ADS_RECONCILIATION_DELAY_MS) {
        confirmationError(
          "CONFIRMATION_IN_PROGRESS",
          "This Meta Ads action may still be running. Reconciliation becomes available five minutes after confirmation starts."
        );
      }
    }

    const reconciledAt = dependencies.now().toISOString();
    const event = createMetaAdsMcpOperationEvent({
      operationId: randomUUID(),
      operation: "reconciliation",
      workspaceId: input.workspaceId,
      ...(transaction
        ? {
            sourceId: transaction.target.sourceId,
            connectionId: transaction.target.connectionId,
            transactionDigest: transaction.transactionDigest,
          }
        : {}),
    });
    event.add({
      ...(transaction ? { adAccountId: transaction.target.adAccountId } : {}),
      reconciliationActorId: input.userId,
      reconciledAt,
      resultCount: normalized.providerIdentifiers?.length ?? 0,
      lifecycleStage: `${priorStatus}_to_${input.resolution}`,
      dispatched: false,
    });
    let eventOutcome: "succeeded" | "not_executed" | "failed" = "failed";
    try {
      const terminal = buildReconciledOutcome({
        execution: current.execution,
        resolution: input.resolution,
      });
      const completed = await dependencies.store.reconcile({
        ...stateInput,
        claimToken: current.execution.claimToken,
        expectedStatus: priorStatus,
        resolution: input.resolution,
        ...terminal,
        completedAt: reconciledAt,
        reconciliation: {
          actorUserId: input.userId,
          resolution: input.resolution,
          note: normalized.note,
          ...(normalized.providerIdentifiers
            ? { providerIdentifiers: normalized.providerIdentifiers }
            : {}),
          reconciledAt,
        },
      });
      if (!completed) {
        const refreshed = await dependencies.store.loadState(stateInput);
        if (
          refreshed?.execution &&
          refreshed.execution.status !== "executing" &&
          (refreshed.execution.status !== "outcome_unknown" ||
            refreshed.execution.reconciliation !== undefined)
        ) {
          if (refreshed.execution.version === 2) {
            requireV2ExecutionTransaction(
              refreshed.execution,
              input.transactionDigest ??
                confirmationError(
                  "CONFIRMATION_INVALID_REQUEST",
                  "A transaction digest is required for this Meta Ads reconciliation"
                )
            );
          }
          eventOutcome =
            publicTerminalStatus(refreshed.execution) === "succeeded"
              ? "succeeded"
              : "not_executed";
          return resolveExistingExecution({
            request: input,
            execution: refreshed.execution,
          });
        }
        confirmationError(
          "CONFIRMATION_STATE_CONFLICT",
          "Meta Ads reconciliation state changed before it could be saved"
        );
      }
      eventOutcome = input.resolution;
      const assistantMessage = await dependencies.store.ensureResultMessage({
        workspaceId: input.workspaceId,
        threadId: input.threadId,
        sourceMessageId: input.messageId,
        execution: completed,
      });
      return {
        assistantMessage,
        confirmedMutationId: completed.id,
        executionStatus: publicTerminalStatus(completed),
        replayed: false,
      };
    } finally {
      event.finish(
        eventOutcome,
        eventOutcome === "failed" ? "reconciliation_failed" : undefined
      );
    }
  }

  return { confirm, reconcile };
}

const defaultAiriMetaAdsMcpConfirmationService =
  createAiriMetaAdsMcpConfirmationService({
    store: airiMetaAdsMcpConfirmationStore,
    executeMutation: executeConfirmedMetaAdsMcpMutation,
    now: () => new Date(),
    createClaimToken: randomUUID,
    createResultMessageId: () => new Types.ObjectId().toString(),
  });

export async function confirmAiriMetaAdsMcpMutationExecution(
  input: ConfirmAiriMetaAdsMcpMutationInput
): Promise<ConfirmAiriMetaAdsMcpMutationResult> {
  return defaultAiriMetaAdsMcpConfirmationService.confirm(input);
}

export async function reconcileAiriMetaAdsMcpMutationExecution(
  input: ReconcileAiriMetaAdsMcpMutationInput
): Promise<ConfirmAiriMetaAdsMcpMutationResult> {
  return defaultAiriMetaAdsMcpConfirmationService.reconcile(input);
}

export function isAiriMetaAdsMcpConfirmationError(
  error: unknown
): error is AiriMetaAdsMcpConfirmationError {
  return error instanceof AiriMetaAdsMcpConfirmationError;
}
