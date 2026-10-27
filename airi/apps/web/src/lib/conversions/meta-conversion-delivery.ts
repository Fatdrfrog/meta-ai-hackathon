import "server-only";

import { isRemovedWhatsAppSource } from "@/lib/integrations/source-status";
import {
  sendWhatsAppConversionEvent,
  validateMetaConversionSnapshot,
} from "@/lib/meta-ads/whatsapp-conversions-api";
import { fetchSourceWithCredentialsResult } from "@/lib/sources/utils";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { normalizeWhatsAppCredentials } from "@/lib/whatsapp/credentials";
import type {
  MetaConversionDeliveryStatus,
  MetaConversionSnapshot,
} from "@icecore/shared/types/conversion-events";
import { isOnboardingTestSource } from "@icecore/shared/types/sources";
import { readWhatsAppConversionsConfiguration } from "./source-config";

export type MetaConversionOutboxPayload = {
  workspaceId: string;
  conversionId: string;
};
type DeliveryResult = { status: MetaConversionDeliveryStatus };
type DeliveryRow = {
  id: string;
  workspace_id: string;
  meta_delivery_status: MetaConversionDeliveryStatus;
  meta_delivery_snapshot: MetaConversionSnapshot | null;
};

const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const DELIVERY_SELECT =
  "id,workspace_id,meta_delivery_status,meta_delivery_snapshot";

function validPayload(payload: MetaConversionOutboxPayload): boolean {
  return Boolean(
    payload && UUID.test(payload.workspaceId) && UUID.test(payload.conversionId)
  );
}

async function readDelivery(
  payload: MetaConversionOutboxPayload
): Promise<DeliveryRow | null> {
  const result = await supabaseAdmin
    .from("conversions")
    .select(DELIVERY_SELECT)
    .eq("workspace_id", payload.workspaceId)
    .eq("id", payload.conversionId)
    .maybeSingle();
  if (result.error) throw new Error("Meta conversion ledger lookup failed");
  return result.data as DeliveryRow | null;
}

async function suppressPending(
  payload: MetaConversionOutboxPayload,
  reason: string
): Promise<DeliveryResult> {
  const result = await supabaseAdmin
    .from("conversions")
    .update({
      meta_delivery_status: "not_eligible",
      meta_delivery_reason: reason,
    })
    .eq("workspace_id", payload.workspaceId)
    .eq("id", payload.conversionId)
    .in("meta_delivery_status", ["pending", "queued"])
    .select("id")
    .maybeSingle();
  if (result.error)
    throw new Error("Meta conversion eligibility update failed");
  if (result.data) return { status: "not_eligible" };
  return {
    status:
      (await readDelivery(payload))?.meta_delivery_status ?? "not_eligible",
  };
}

/** SQL is the authoritative send fence, independent of Mongo lease recovery. */
export async function deliverMetaConversion(
  payload: MetaConversionOutboxPayload
): Promise<DeliveryResult> {
  if (!validPayload(payload)) return { status: "not_eligible" };
  const conversion = await readDelivery(payload);
  if (!conversion) return { status: "not_eligible" };
  if (
    conversion.meta_delivery_status !== "pending" &&
    conversion.meta_delivery_status !== "queued"
  ) {
    return { status: conversion.meta_delivery_status };
  }
  const snapshot = conversion.meta_delivery_snapshot;
  if (!snapshot || typeof snapshot !== "object")
    return suppressPending(payload, "missing_snapshot");
  const invalidReason = validateMetaConversionSnapshot(snapshot);
  if (invalidReason) return suppressPending(payload, invalidReason);

  const sourceResult = await fetchSourceWithCredentialsResult(
    snapshot.sourceId,
    "whatsapp"
  );
  if (!sourceResult.ok) throw new Error("Meta conversion source lookup failed");
  const source = sourceResult.source;
  if (
    !source ||
    source.id !== snapshot.sourceId ||
    source.workspace_id !== payload.workspaceId ||
    source.type !== "whatsapp" ||
    isRemovedWhatsAppSource(source) ||
    isOnboardingTestSource(source)
  ) {
    return suppressPending(payload, "whatsapp_source_unavailable");
  }
  const configuration = readWhatsAppConversionsConfiguration(
    source.credentials
  );
  const credentials = normalizeWhatsAppCredentials(source.credentials);
  if (!configuration?.enabled)
    return suppressPending(payload, "feedback_not_enabled");
  if (
    configuration.dataset_id !== snapshot.datasetId ||
    configuration.waba_id !== snapshot.wabaId ||
    credentials.wabaId !== snapshot.wabaId ||
    (configuration.test_event_code || undefined) !== snapshot.testEventCode
  ) {
    return suppressPending(payload, "delivery_destination_changed");
  }
  if (!credentials.accessToken)
    throw new Error("Meta conversion access token unavailable");

  // Meta does not deduplicate Business Messaging events. Once this transition
  // commits, a crash or uncertain response must never cause another automatic send.
  const claim = await supabaseAdmin
    .from("conversions")
    .update({
      meta_delivery_status: "delivery_unknown",
      meta_delivery_reason: "dispatch_started",
    })
    .eq("workspace_id", payload.workspaceId)
    .eq("id", payload.conversionId)
    .in("meta_delivery_status", ["pending", "queued"])
    .select("id")
    .maybeSingle();
  if (claim.error) throw new Error("Meta conversion dispatch claim failed");
  if (!claim.data)
    return {
      status:
        (await readDelivery(payload))?.meta_delivery_status ?? "not_eligible",
    };

  try {
    const outcome = await sendWhatsAppConversionEvent({
      snapshot,
      eventId: payload.conversionId,
      accessToken: credentials.accessToken,
    });
    const saved = await supabaseAdmin
      .from("conversions")
      .update({
        meta_delivery_status: outcome.status,
        meta_delivery_reason: outcome.status === "sent" ? null : outcome.code,
        ...(outcome.status === "sent"
          ? { meta_delivered_at: new Date().toISOString() }
          : {}),
      })
      .eq("workspace_id", payload.workspaceId)
      .eq("id", payload.conversionId)
      .eq("meta_delivery_status", "delivery_unknown")
      .select("id")
      .maybeSingle();
    if (saved.error || !saved.data) return { status: "delivery_unknown" };
    return { status: outcome.status };
  } catch {
    // Covers an ambiguous provider outcome and failed persistence after dispatch.
    // The already-committed ledger fence remains the recovery truth.
    return { status: "delivery_unknown" };
  }
}

/** Reconciles durable SQL intent into the existing outbox without a dual-write gap. */
export async function reconcilePendingMetaConversions(input: {
  enqueue: (payload: MetaConversionOutboxPayload) => Promise<unknown>;
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
    .eq("meta_delivery_status", "pending")
    .order("created_at", { ascending: true })
    .limit(limit);
  if (result.error)
    throw new Error("Meta conversion reconciliation lookup failed");
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
      .update({ meta_delivery_status: "queued" })
      .eq("workspace_id", payload.workspaceId)
      .eq("id", payload.conversionId)
      .eq("meta_delivery_status", "pending");
    if (updated.error)
      throw new Error("Meta conversion queued state update failed");
    queued += 1;
  }
  return queued;
}

/** Final pre-dispatch failures must be visible in the ledger, not stuck queued. */
export async function recordMetaConversionPreparationFailure(
  payload: MetaConversionOutboxPayload
): Promise<void> {
  if (!validPayload(payload)) return;
  const result = await supabaseAdmin
    .from("conversions")
    .update({
      meta_delivery_status: "rejected",
      meta_delivery_reason: "pre_dispatch_failure",
    })
    .eq("workspace_id", payload.workspaceId)
    .eq("id", payload.conversionId)
    .in("meta_delivery_status", ["pending", "queued"]);
  if (result.error)
    throw new Error("Meta conversion preparation failure update failed");
}
