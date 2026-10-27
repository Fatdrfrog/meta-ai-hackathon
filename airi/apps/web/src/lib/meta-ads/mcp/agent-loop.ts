import { withWorkspaceTextAiAction } from "@/lib/ai/workspace-ai-policy";
import "server-only";

import { createClient } from "@/lib/supabase/server";
import { randomUUID } from "node:crypto";
import {
  createMetaAdsMcpConversationId,
  isMetaAdsMcpConversationId,
} from "./conversation-id";
import {
  callMetaAdsMcpTool,
  closeMetaAdsMcpSession,
  createMetaAdsMcpSession,
  initializeMetaAdsMcpSession,
  listMetaAdsMcpTools,
} from "./client";
import { isMetaAdsMcpWriteTool } from "./tool-classifier";
import { resolveWorkspaceMetaAdsMcpAccessToken } from "./readiness-service";
export { resolveWorkspaceMetaAdsMcpAccessToken } from "./readiness-service";
import {
  getMetaAdsMcpAccountEligibility,
  getMetaAdsMcpAccountIds,
} from "./preconditions";
import { readMetaAdsMcpAccountAccess } from "./account-access";
import {
  loadMetaAdsMcpCreativeAssetReferences,
  materializeMetaAdsMcpMutationArguments,
} from "./creative-assets";
import {
  isMetaAdsMcpTransactionExpired,
  META_ADS_MCP_TRANSACTION_EXPIRED_ERROR,
} from "./confirmation-contract";
import {
  sha256CanonicalJson,
  verifyMetaAdsMcpTransaction,
} from "./confirmation-contract.server";
import { createMetaAdsMcpOperationEvent } from "./operation-event";
import { validateMetaAdsMcpToolArguments } from "./tool-argument-validation";
import { runNativeMetaAdsMcpTurn } from "./native-turn";
import {
  collectCreativeAssetIds,
  creativeDisclosureFacts,
  exactTargetStillMatches,
  operationErrorCode,
  type MetaAdsMcpPendingMutation,
  type MetaAdsMcpTurnParams,
  type MetaAdsMcpTurnResult,
} from "./turn-support";
export type {
  MetaAdsMcpGroundingContext,
  MetaAdsMcpPendingMutation,
  MetaAdsMcpTurnParams,
  MetaAdsMcpTurnResult,
} from "./turn-support";

export type MetaAdsMcpMutationExecutionResult =
  | {
      ok: true;
      outcome: "succeeded";
      dispatchStarted: true;
      result: unknown;
      effectiveArgumentsSha256?: string;
      materializedCreativeAssetIds: string[];
    }
  | {
      ok: false;
      outcome: "not_executed";
      dispatchStarted: false;
      error: string;
    }
  | {
      ok: false;
      outcome: "outcome_unknown";
      dispatchStarted: true;
      error: string;
      effectiveArgumentsSha256?: string;
      materializedCreativeAssetIds: string[];
    };

export async function executeConfirmedMetaAdsMcpMutation(params: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  workspaceId: string;
  mutation: MetaAdsMcpPendingMutation;
}): Promise<MetaAdsMcpMutationExecutionResult> {
  const transaction = params.mutation;
  const event = createMetaAdsMcpOperationEvent({
    operationId: randomUUID(),
    operation: "write",
    workspaceId: params.workspaceId,
    sourceId: transaction.target.sourceId,
    connectionId: transaction.target.connectionId,
    transactionDigest: transaction.transactionDigest,
  });
  event.add({
    mcpUserId: transaction.target.mcpUserId,
    adAccountId: transaction.target.adAccountId,
    businessId: transaction.target.businessId,
    toolName: transaction.tool.name,
    definitionSha256: transaction.tool.definitionSha256,
    catalogSha256: transaction.tool.catalogSha256,
    logicalArgumentsSha256: transaction.logicalArgumentsSha256,
    lifecycleStage: "verify_transaction",
    dispatched: false,
  });
  let session: ReturnType<typeof createMetaAdsMcpSession> | null = null;
  let dispatchStarted = false;
  let stage = "verify_transaction";
  let eventOutcome: "succeeded" | "not_executed" | "outcome_unknown" =
    "not_executed";
  let eventError: string | undefined;
  let effectiveArgumentsSha256: string | undefined;
  let materializedCreativeAssetIds: string[] = [];
  try {
    const verified = verifyMetaAdsMcpTransaction(transaction);
    if (!verified.ok) {
      eventError = verified.code.toLowerCase();
      return {
        ok: false,
        outcome: "not_executed",
        dispatchStarted: false,
        error: verified.message.slice(0, 400),
      };
    }
    if (isMetaAdsMcpTransactionExpired(transaction, Date.now())) {
      eventError = "transaction_expired";
      return {
        ok: false,
        outcome: "not_executed",
        dispatchStarted: false,
        error: META_ADS_MCP_TRANSACTION_EXPIRED_ERROR,
      };
    }
    if (!isMetaAdsMcpWriteTool(transaction.tool.name)) {
      eventError = "not_a_write_tool";
      return {
        ok: false,
        outcome: "not_executed",
        dispatchStarted: false,
        error: "Only classified Meta Ads write tools can be confirmed",
      };
    }
    stage = "resolve_source";
    const auth = await resolveWorkspaceMetaAdsMcpAccessToken({
      supabase: params.supabase,
      workspaceId: params.workspaceId,
      expectedSourceId: transaction.target.sourceId,
    });
    event.add({
      readiness: auth.readiness.state,
      missingScopes: auth.readiness.missingScopes,
    });
    if (
      !auth.accessToken ||
      !auth.readiness.canWrite ||
      !exactTargetStillMatches({ transaction, auth })
    ) {
      eventError = "source_or_readiness_drift";
      return {
        ok: false,
        outcome: "not_executed",
        dispatchStarted: false,
        error:
          "The Meta Ads connection, account, or readiness changed after review. Prepare a new action.",
      };
    }
    stage = "load_catalog";
    session = createMetaAdsMcpSession(auth.accessToken);
    await initializeMetaAdsMcpSession(session);
    const catalog = await listMetaAdsMcpTools(session, {
      cacheMode: "refresh",
    });
    event.add({
      protocolVersion: catalog.protocol.protocolVersion,
      serverName: catalog.protocol.serverName,
      serverVersion: catalog.protocol.serverVersion,
      toolCount: catalog.tools.length,
      catalogSha256: catalog.catalogSha256,
    });
    if (catalog.catalogSha256 !== transaction.tool.catalogSha256) {
      eventError = "catalog_digest_mismatch";
      return {
        ok: false,
        outcome: "not_executed",
        dispatchStarted: false,
        error:
          "The Meta Ads tool catalog changed after review. Prepare a new action.",
      };
    }
    const tool = catalog.tools.find(
      item => item.name === transaction.tool.name
    );
    if (!tool || tool.definitionSha256 !== transaction.tool.definitionSha256) {
      eventError = "tool_digest_mismatch";
      return {
        ok: false,
        outcome: "not_executed",
        dispatchStarted: false,
        error:
          "The reviewed Meta Ads tool contract changed. Prepare a new action.",
      };
    }
    stage = "validate_arguments";
    const ids = Array.from(
      collectCreativeAssetIds(transaction.logicalArguments)
    );
    const validation = ids.length
      ? { success: true as const }
      : validateMetaAdsMcpToolArguments({
          tool,
          arguments: transaction.logicalArguments,
        });
    if (!validation.success) {
      eventError = "argument_schema_mismatch";
      return {
        ok: false,
        outcome: "not_executed",
        dispatchStarted: false,
        error:
          `The reviewed arguments no longer match the current tool contract: ${validation.errors.slice(0, 3).join("; ")}`.slice(
            0,
            400
          ),
      };
    }
    stage = "materialize_assets";
    const references = ids.length
      ? await loadMetaAdsMcpCreativeAssetReferences({
          workspaceId: params.workspaceId,
          assetIds: ids,
        })
      : [];
    if (
      sha256CanonicalJson(creativeDisclosureFacts(references)) !==
      sha256CanonicalJson(
        creativeDisclosureFacts(transaction.disclosure.creativeAssets)
      )
    ) {
      eventError = "creative_asset_drift";
      return {
        ok: false,
        outcome: "not_executed",
        dispatchStarted: false,
        error:
          "A reviewed Creative Asset changed or is no longer available. Prepare a new action.",
      };
    }
    const materialized = await materializeMetaAdsMcpMutationArguments({
      workspaceId: params.workspaceId,
      arguments: transaction.logicalArguments,
    });
    effectiveArgumentsSha256 = materialized.effectiveArgumentsSha256;
    materializedCreativeAssetIds = materialized.materializedCreativeAssetIds;
    const expectedIds = references.map(reference => reference.id).sort();
    if (
      materializedCreativeAssetIds.length !== expectedIds.length ||
      materializedCreativeAssetIds.some(
        (id, index) => id !== expectedIds[index]
      )
    ) {
      eventError = "creative_materialization_mismatch";
      return {
        ok: false,
        outcome: "not_executed",
        dispatchStarted: false,
        error:
          "The reviewed Creative Asset references could not be materialized safely. Prepare a new action.",
      };
    }
    event.add({
      effectiveArgumentsSha256,
      creativeAssetCount: materializedCreativeAssetIds.length,
    });
    const effectiveValidation = validateMetaAdsMcpToolArguments({
      tool,
      arguments: materialized.effectiveArguments,
    });
    if (!effectiveValidation.success) {
      eventError = "materialized_argument_schema_mismatch";
      return {
        ok: false,
        outcome: "not_executed",
        dispatchStarted: false,
        error:
          `The resolved Creative Asset arguments do not match the current tool contract: ${effectiveValidation.errors.slice(0, 3).join("; ")}`.slice(
            0,
            400
          ),
      };
    }
    stage = "verify_account_availability";
    const accountAccess = await readMetaAdsMcpAccountAccess({
      session,
      catalog,
      clientConversationId: isMetaAdsMcpConversationId(
        transaction.logicalArguments.client_conversation_id
      )
        ? transaction.logicalArguments.client_conversation_id
        : createMetaAdsMcpConversationId(),
    });
    if (!accountAccess.complete) {
      eventError = "account_inventory_incomplete";
      return {
        ok: false,
        outcome: "not_executed",
        dispatchStarted: false,
        error:
          "Meta could not verify account availability. Retry verification before confirming a new action.",
      };
    }
    const scopedAccountIds = getMetaAdsMcpAccountIds(
      transaction.logicalArguments
    );
    const accountEligibility = getMetaAdsMcpAccountEligibility({
      inventory: accountAccess.inventory,
      accountIds: scopedAccountIds
        ? [transaction.target.adAccountId, ...scopedAccountIds]
        : [],
    });
    if (accountEligibility.kind === "blocked") {
      eventError = accountEligibility.code;
      return {
        ok: false,
        outcome: "not_executed",
        dispatchStarted: false,
        error: accountEligibility.message,
      };
    }
    stage = "ready_to_dispatch";
    const finalAuth = await resolveWorkspaceMetaAdsMcpAccessToken({
      supabase: params.supabase,
      workspaceId: params.workspaceId,
      expectedSourceId: transaction.target.sourceId,
      refresh: "never",
    });
    if (
      !finalAuth.accessToken ||
      finalAuth.accessToken !== auth.accessToken ||
      !exactTargetStillMatches({ transaction, auth: finalAuth })
    ) {
      eventError = "source_changed_before_dispatch";
      return {
        ok: false,
        outcome: "not_executed",
        dispatchStarted: false,
        error:
          "The Meta Ads connection changed during preparation. Review a new action.",
      };
    }
    const result = await callMetaAdsMcpTool({
      session,
      tool,
      arguments: materialized.effectiveArguments,
      sideEffect: "write",
      onDispatch: () => {
        dispatchStarted = true;
        stage = "dispatched";
        event.add({ lifecycleStage: stage, dispatched: true });
      },
    });
    eventOutcome = "succeeded";
    stage = "succeeded";
    return {
      ok: true,
      outcome: "succeeded",
      dispatchStarted: true,
      result,
      effectiveArgumentsSha256,
      materializedCreativeAssetIds,
    };
  } catch (error) {
    eventError = operationErrorCode(error);
    if (dispatchStarted) {
      eventOutcome = "outcome_unknown";
      stage = "outcome_unknown";
      return {
        ok: false,
        outcome: "outcome_unknown",
        dispatchStarted: true,
        error:
          "The Meta Ads write was sent, but Airi could not verify its outcome. Review Meta Ads Manager before taking another action.",
        effectiveArgumentsSha256,
        materializedCreativeAssetIds,
      };
    }
    stage = "not_executed";
    return {
      ok: false,
      outcome: "not_executed",
      dispatchStarted: false,
      error:
        error instanceof Error
          ? error.message.slice(0, 400)
          : "The Meta Ads write could not be verified before dispatch",
    };
  } finally {
    try {
      if (session) await closeMetaAdsMcpSession(session);
    } finally {
      event.add({
        lifecycleStage: stage,
        dispatched: dispatchStarted,
        effectiveArgumentsSha256,
        creativeAssetCount: materializedCreativeAssetIds.length,
      });
      event.finish(eventOutcome, eventError);
    }
  }
}

export async function runMetaAdsMcpTurn(
  params: MetaAdsMcpTurnParams
): Promise<MetaAdsMcpTurnResult> {
  return withWorkspaceTextAiAction(
    {
      workspaceId: params.workspaceId,
      actionId: `meta-ads-turn:${randomUUID()}`,
    },
    () => runNativeMetaAdsMcpTurn(params)
  );
}
