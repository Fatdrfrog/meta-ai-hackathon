import "server-only";

import {
  getCompiledScenarioGraph,
  type ScenarioGraphRecord,
} from "@icecore/airi-runtime/scenario-graph";
import {
  getPostActionConditionHandleId,
  hasBlockingScenarioRoutingDiagnostics,
  isPostActionConditionNodeData,
} from "@icecore/scenario-contracts";
import type { ConfirmedPaymentScenarioSnapshot } from "@icecore/shared/types/conversion-events";
import { z } from "zod";
import connectDB from "@/lib/mongoose";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { Scenario } from "@/models/scenario";

type ScenarioEffectStatus =
  | "not_applicable"
  | "pending"
  | "queued"
  | "processed"
  | "skipped"
  | "failed";
export type ConfirmedPaymentScenarioPayload = {
  workspaceId: string;
  conversionId: string;
};
type Intent = {
  scenario_effect_status: "pending" | "not_applicable";
  scenario_effect_snapshot: ConfirmedPaymentScenarioSnapshot | null;
  scenario_effect_reason: string | null;
};
type PendingConversation = {
  _id?: unknown;
  workspaceId?: unknown;
  sourceId?: unknown;
  channel?: unknown;
  airi_scenario_state?: {
    lockedScenarioId?: unknown;
    pendingConditionNodeId?: unknown;
    pendingSourceActionNodeId?: unknown;
    pendingStartedAt?: unknown;
    pendingScenarioUpdatedAt?: unknown;
    pendingLastOutboundMessageId?: unknown;
  } | null;
};
type DeliveryRow = {
  id: string;
  workspace_id: string;
  conversation_id: string;
  conversion_type: string;
  conversion_value: number | null;
  scenario_effect_status: ScenarioEffectStatus;
  scenario_effect_snapshot: unknown;
};
const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const OBJECT_ID = /^[a-f\d]{24}$/;
const isoDate = z.string().datetime({ offset: true });
const snapshotSchema = z.object({
  sourceId: z.string().regex(UUID),
  scenarioId: z.string().regex(OBJECT_ID),
  scenarioUpdatedAt: isoDate,
  pendingConditionNodeId: z.string().trim().min(1).max(500),
  pendingSourceActionNodeId: z.string().trim().min(1).max(500),
  pendingStartedAt: isoDate,
  pendingLastOutboundMessageId: z.string().regex(OBJECT_ID),
  occurredAt: isoDate,
});

export function parseConfirmedPaymentScenarioSnapshot(
  value: unknown
): ConfirmedPaymentScenarioSnapshot | null {
  const parsed = snapshotSchema.safeParse(value);
  if (
    !parsed.success ||
    Date.parse(parsed.data.occurredAt) <
      Date.parse(parsed.data.pendingStartedAt)
  )
    return null;
  return parsed.data;
}

function timestamp(value: unknown): string | null {
  if (value instanceof Date)
    return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  if (!isoDate.safeParse(value).success) return null;
  const parsed = new Date(value as string);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}
function notApplicable(reason: string): Intent {
  return {
    scenario_effect_status: "not_applicable",
    scenario_effect_snapshot: null,
    scenario_effect_reason: reason,
  };
}

/** Capture the wait when the sale is recorded, never when the outbox eventually runs. */
export async function prepareConfirmedPaymentScenarioIntent(input: {
  conversation: PendingConversation;
  conversionType: string;
  value: number | null;
  occurredAt: string;
  paymentEvidenceOccurredAt?: string;
}): Promise<Intent> {
  if (
    input.conversionType !== "sale" ||
    typeof input.value !== "number" ||
    !Number.isFinite(input.value) ||
    input.value <= 0
  )
    return notApplicable("not_positive_sale");
  const conversation = input.conversation;
  if (
    conversation.channel !== "whatsapp" ||
    typeof conversation.workspaceId !== "string" ||
    !UUID.test(conversation.workspaceId) ||
    !OBJECT_ID.test(String(conversation._id))
  )
    return notApplicable("conversation_not_eligible");
  const pending = conversation.airi_scenario_state;
  const occurredAt = timestamp(input.occurredAt);
  const pendingStartedAt = timestamp(pending?.pendingStartedAt);
  const partial = parseConfirmedPaymentScenarioSnapshot({
    sourceId: conversation.sourceId,
    scenarioId: pending?.lockedScenarioId,
    scenarioUpdatedAt: timestamp(pending?.pendingScenarioUpdatedAt),
    pendingConditionNodeId: pending?.pendingConditionNodeId,
    pendingSourceActionNodeId: pending?.pendingSourceActionNodeId,
    pendingStartedAt,
    pendingLastOutboundMessageId: pending?.pendingLastOutboundMessageId,
    occurredAt,
  });
  if (!partial) return notApplicable("no_matching_payment_wait");
  if (input.paymentEvidenceOccurredAt !== undefined) {
    const evidenceAt = timestamp(input.paymentEvidenceOccurredAt);
    if (
      !evidenceAt ||
      Date.parse(evidenceAt) < Date.parse(partial.pendingStartedAt)
    )
      return notApplicable("evidence_predates_wait");
  }
  await connectDB();
  const scenario = await Scenario.findOne({
    _id: partial.scenarioId,
    workspaceId: conversation.workspaceId,
    status: "active",
    deletedAt: null,
  })
    .select("nodes edges updatedAt")
    .lean<ScenarioGraphRecord>();
  if (!scenario) return notApplicable("scenario_unavailable");
  const scenarioUpdatedAt = timestamp(scenario.updatedAt);
  if (!scenarioUpdatedAt) return notApplicable("scenario_revision_unavailable");
  if (scenarioUpdatedAt !== partial.scenarioUpdatedAt)
    return notApplicable("scenario_revision_changed");
  const graph = getCompiledScenarioGraph(scenario);
  const condition = graph.nodesById.get(partial.pendingConditionNodeId);
  if (
    hasBlockingScenarioRoutingDiagnostics(graph.diagnostics) ||
    !condition ||
    condition.data.kind !== "logic" ||
    !isPostActionConditionNodeData(condition.data)
  )
    return notApplicable("payment_outcome_unavailable");
  const sourceAction = graph.nodesById.get(partial.pendingSourceActionNodeId);
  const connectsWait = graph.edges.some(
    edge =>
      edge.source === partial.pendingSourceActionNodeId &&
      edge.target === partial.pendingConditionNodeId
  );
  const paymentHandle = getPostActionConditionHandleId("payment_detected");
  const connectsPayment = graph.edges.some(
    edge =>
      edge.source === partial.pendingConditionNodeId &&
      edge.sourceHandle === paymentHandle &&
      Boolean(edge.target && graph.nodesById.has(edge.target))
  );
  if (sourceAction?.data.kind !== "action" || !connectsWait || !connectsPayment)
    return notApplicable("payment_outcome_unavailable");
  return {
    scenario_effect_status: "pending",
    scenario_effect_snapshot: partial,
    scenario_effect_reason: null,
  };
}

function validPayload(payload: ConfirmedPaymentScenarioPayload): boolean {
  return Boolean(
    payload && UUID.test(payload.workspaceId) && UUID.test(payload.conversionId)
  );
}
async function readDelivery(
  payload: ConfirmedPaymentScenarioPayload
): Promise<DeliveryRow | null> {
  const result = await supabaseAdmin
    .from("conversions")
    .select(
      "id,workspace_id,conversation_id,conversion_type,conversion_value,scenario_effect_status,scenario_effect_snapshot"
    )
    .eq("workspace_id", payload.workspaceId)
    .eq("id", payload.conversionId)
    .maybeSingle();
  if (result.error) throw new Error("Confirmed payment ledger lookup failed");
  return result.data as DeliveryRow | null;
}

/** Internal control events are safe to retry under the stable conversion identity. */
export async function dispatchConfirmedPaymentScenario(
  payload: ConfirmedPaymentScenarioPayload
): Promise<{ status: ScenarioEffectStatus }> {
  if (!validPayload(payload)) return { status: "not_applicable" };
  const conversion = await readDelivery(payload);
  if (!conversion) return { status: "not_applicable" };
  if (
    conversion.scenario_effect_status !== "pending" &&
    conversion.scenario_effect_status !== "queued"
  )
    return { status: conversion.scenario_effect_status };
  const snapshot = parseConfirmedPaymentScenarioSnapshot(
    conversion.scenario_effect_snapshot
  );
  const eligible =
    conversion.conversion_type === "sale" &&
    Number.isFinite(conversion.conversion_value) &&
    Number(conversion.conversion_value) > 0 &&
    OBJECT_ID.test(conversion.conversation_id);
  if (!snapshot || !eligible) {
    const skipped = await supabaseAdmin
      .from("conversions")
      .update({
        scenario_effect_status: "skipped",
        scenario_effect_reason: snapshot
          ? "not_positive_sale"
          : "invalid_snapshot",
      })
      .eq("workspace_id", payload.workspaceId)
      .eq("id", payload.conversionId)
      .in("scenario_effect_status", ["pending", "queued"]);
    if (skipped.error)
      throw new Error("Confirmed payment skipped state update failed");
    return {
      status:
        (await readDelivery(payload))?.scenario_effect_status ??
        "not_applicable",
    };
  }
  const { signalWithStartAiriConversationExternalEvent } = await import(
    "@/lib/temporal/client"
  );
  await signalWithStartAiriConversationExternalEvent({
    kind: "payment_confirmed",
    conversionId: payload.conversionId,
    messageId: `confirmed-payment:${payload.conversionId}`,
    workspaceId: payload.workspaceId,
    conversationId: conversion.conversation_id,
    sourceId: snapshot.sourceId,
    channel: "whatsapp",
    messageDate: snapshot.occurredAt,
  });
  // Acceptance is already durable in Temporal. A bookkeeping outage after this
  // point must not turn the accepted signal into a terminal dispatch failure.
  return { status: "queued" };
}

/** The SQL pending intent closes the Mongo enqueue / SQL insert dual-write gap. */
export async function reconcilePendingConfirmedPayments(input: {
  enqueue: (payload: ConfirmedPaymentScenarioPayload) => Promise<unknown>;
  limit?: number;
  deadlineAtMs?: number;
}): Promise<number> {
  if (input.deadlineAtMs && Date.now() >= input.deadlineAtMs) return 0;
  const limit =
    Number.isSafeInteger(input.limit) && Number(input.limit) > 0
      ? Math.min(50, Number(input.limit))
      : 50;
  const result = await supabaseAdmin
    .from("conversions")
    .select("id,workspace_id")
    .eq("scenario_effect_status", "pending")
    .order("created_at", { ascending: true })
    .limit(limit);
  if (result.error)
    throw new Error("Confirmed payment reconciliation lookup failed");
  let queued = 0;
  for (const row of result.data ?? []) {
    if (input.deadlineAtMs && Date.now() >= input.deadlineAtMs) break;
    const payload = {
      workspaceId: String(row.workspace_id),
      conversionId: String(row.id),
    };
    if (!validPayload(payload)) continue;
    await input.enqueue(payload);
    const updated = await supabaseAdmin
      .from("conversions")
      .update({ scenario_effect_status: "queued" })
      .eq("workspace_id", payload.workspaceId)
      .eq("id", payload.conversionId)
      .eq("scenario_effect_status", "pending");
    if (updated.error)
      throw new Error("Confirmed payment queued state update failed");
    queued++;
  }
  return queued;
}

export async function recordConfirmedPaymentScenarioFailure(
  payload: ConfirmedPaymentScenarioPayload & { reason?: string }
): Promise<void> {
  if (!validPayload(payload)) return;
  const result = await supabaseAdmin
    .from("conversions")
    .update({
      scenario_effect_status: "failed",
      scenario_effect_reason: payload.reason || "dispatch_failed",
    })
    .eq("workspace_id", payload.workspaceId)
    .eq("id", payload.conversionId)
    .in("scenario_effect_status", ["pending", "queued"]);
  if (result.error)
    throw new Error("Confirmed payment failure state update failed");
}
