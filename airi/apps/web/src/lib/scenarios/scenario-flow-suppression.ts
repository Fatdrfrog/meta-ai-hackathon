import connectDB from "@/lib/mongoose";
import { ScenarioFlowSuppression } from "@/models/scenario-flow-suppression";
import { readTrimmedString } from "@icecore/shared/lib/value-utils";

export const WHATSAPP_FLOW_INTEGRITY_BLOCK_CODE = 139000;

const DEFAULT_INTEGRITY_SUPPRESSION_TTL_DAYS = 7;

export type ActiveScenarioFlowSuppression = {
  workspaceId: string;
  flowId: string;
  reason: "meta_integrity_block";
  errorCode: number | null;
  errorMessage: string | null;
  suppressedAt: Date | null;
  expiresAt: Date | null;
};

function resolveIntegritySuppressionExpiresAt(now: Date): Date | null {
  const rawDays = String(
    process.env.WHATSAPP_FLOW_INTEGRITY_SUPPRESSION_TTL_DAYS || ""
  ).trim();
  if (rawDays === "0" || rawDays.toLowerCase() === "none") {
    return null;
  }

  const days = Number(rawDays) || DEFAULT_INTEGRITY_SUPPRESSION_TTL_DAYS;
  const safeDays = Number.isFinite(days) && days > 0 ? days : 1;
  return new Date(now.getTime() + safeDays * 24 * 60 * 60 * 1000);
}

export function getWhatsAppFlowErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isWhatsAppFlowIntegrityBlockError(error: unknown): boolean {
  const message = getWhatsAppFlowErrorMessage(error);
  return (
    /\b139000\b/.test(message) ||
    /meta integrity block/i.test(message) ||
    /blocked by integrity/i.test(message)
  );
}

export async function getActiveScenarioFlowSuppression(params: {
  workspaceId: string;
  flowId: string;
  now?: Date;
}): Promise<ActiveScenarioFlowSuppression | null> {
  const workspaceId = readTrimmedString(params.workspaceId);
  const flowId = readTrimmedString(params.flowId);
  if (!workspaceId || !flowId) return null;

  const now = params.now || new Date();
  await connectDB();

  const doc = (await ScenarioFlowSuppression.findOne({
    workspaceId,
    flowId,
    reason: "meta_integrity_block",
    resolvedAt: null,
    $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }],
  })
    .lean()
    .exec()) as {
    workspaceId: string;
    flowId: string;
    reason: "meta_integrity_block";
    errorCode?: number | null;
    errorMessage?: string | null;
    suppressedAt?: Date | null;
    expiresAt?: Date | null;
  } | null;

  if (!doc) return null;

  return {
    workspaceId: doc.workspaceId,
    flowId: doc.flowId,
    reason: doc.reason,
    errorCode: doc.errorCode ?? null,
    errorMessage: doc.errorMessage ?? null,
    suppressedAt: doc.suppressedAt ?? null,
    expiresAt: doc.expiresAt ?? null,
  };
}

export async function suppressScenarioFlowAfterIntegrityBlock(params: {
  workspaceId: string;
  flowId: string;
  sourceId?: string | null;
  conversationId?: string | null;
  scenarioId?: string | null;
  actionNodeId?: string | null;
  errorCode?: number | null;
  errorMessage?: string | null;
  now?: Date;
}): Promise<void> {
  const workspaceId = readTrimmedString(params.workspaceId);
  const flowId = readTrimmedString(params.flowId);
  if (!workspaceId || !flowId) return;

  const now = params.now || new Date();
  await connectDB();

  await ScenarioFlowSuppression.updateOne(
    {
      workspaceId,
      flowId,
      reason: "meta_integrity_block",
    },
    {
      $set: {
        sourceId: readTrimmedString(params.sourceId) || null,
        conversationId: readTrimmedString(params.conversationId) || null,
        scenarioId: readTrimmedString(params.scenarioId) || null,
        actionNodeId: readTrimmedString(params.actionNodeId) || null,
        errorCode: params.errorCode ?? WHATSAPP_FLOW_INTEGRITY_BLOCK_CODE,
        errorMessage: params.errorMessage || null,
        lastFailureAt: now,
        expiresAt: resolveIntegritySuppressionExpiresAt(now),
        resolvedAt: null,
      },
      $setOnInsert: {
        workspaceId,
        flowId,
        reason: "meta_integrity_block",
        suppressedAt: now,
      },
      $inc: { occurrenceCount: 1 },
    },
    { upsert: true }
  );
}
