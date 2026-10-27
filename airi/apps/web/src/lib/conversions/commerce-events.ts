import { createHash } from "crypto";
import { z } from "zod";
import { recordCustomerConversionEvent } from "@/lib/customers/service";
import connectDB from "@/lib/mongoose";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { Conversation } from "@/models/conversation";
import type { CommerceEventInput } from "@icecore/shared/types/conversion-events";
import { buildConversionAttribution } from "./conversion-attribution";
import { prepareMetaConversionIntent } from "./meta-conversion-intent";
import { prepareConfirmedPaymentScenarioIntent } from "./confirmed-payment-scenario";

const commerceDate = z.string().datetime({ offset: true });

export class CommerceEventError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

export async function resolveOriginalCommerceSaleConversation({
  source,
  purchaseTransactionId,
  currency,
}: {
  source: { id: string; workspace_id: string; type: string };
  purchaseTransactionId: string;
  currency: string;
}): Promise<string | null> {
  const normalizedTransactionId = purchaseTransactionId.trim();
  const normalizedCurrency = currency.trim().toUpperCase();
  if (
    source.type !== "whatsapp" ||
    !source.id.trim() ||
    !source.workspace_id.trim() ||
    normalizedTransactionId.length < 1 ||
    normalizedTransactionId.length > 200 ||
    /[\u0000-\u001f]/.test(normalizedTransactionId) ||
    !/^[A-Z]{3}$/.test(normalizedCurrency)
  ) {
    throw new CommerceEventError("Invalid original purchase lookup", 400);
  }

  const { data, error } = await supabaseAdmin
    .from("conversions")
    .select("conversation_id")
    .eq("workspace_id", source.workspace_id)
    .eq("external_source_id", source.id)
    .eq("external_transaction_id", normalizedTransactionId)
    .eq("conversion_type", "sale")
    .eq("currency", normalizedCurrency)
    .maybeSingle();
  if (error) {
    throw new CommerceEventError("Failed to load original purchase", 500);
  }
  return typeof data?.conversation_id === "string" &&
    /^[a-f0-9]{24}$/i.test(data.conversation_id)
    ? data.conversation_id.toLowerCase()
    : null;
}

/** Normalize once before hashing, so formatting cannot change event identity. */
export function normalizeCommerceEvent(input: unknown): CommerceEventInput {
  const invalid = () => {
    throw new CommerceEventError("Invalid commerce event", 400);
  };
  if (!input || typeof input !== "object" || Array.isArray(input))
    return invalid();
  const data = input as Record<string, unknown>;
  const allowed = new Set([
    "eventId",
    "eventType",
    "transactionId",
    "purchaseTransactionId",
    "conversationId",
    "orderId",
    "value",
    "currency",
    "occurredAt",
  ]);
  if (Object.keys(data).some(key => !allowed.has(key))) return invalid();
  const identity = (value: unknown) =>
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.trim().length <= 200 &&
    !/[\u0000-\u001f]/.test(value)
      ? value.trim()
      : invalid();
  if (data.eventType !== "purchase" && data.eventType !== "refund")
    return invalid();
  if (
    typeof data.conversationId !== "string" ||
    !/^[a-f0-9]{24}$/i.test(data.conversationId)
  )
    return invalid();
  if (
    typeof data.value !== "number" ||
    !Number.isFinite(data.value) ||
    data.value <= 0 ||
    data.value > 99999999.99 ||
    Math.round(data.value * 100) / 100 !== data.value
  )
    return invalid();
  if (typeof data.currency !== "string" || !/^[a-z]{3}$/i.test(data.currency))
    return invalid();
  if (
    typeof data.occurredAt !== "string" ||
    !commerceDate.safeParse(data.occurredAt).success
  )
    return invalid();
  const date = new Date(data.occurredAt);
  if (!Number.isFinite(date.getTime()) || date.getTime() > Date.now())
    return invalid();
  if (data.eventType === "purchase" && data.purchaseTransactionId !== undefined)
    return invalid();
  return {
    eventId: identity(data.eventId),
    eventType: data.eventType,
    transactionId: identity(data.transactionId),
    ...(data.eventType === "refund"
      ? { purchaseTransactionId: identity(data.purchaseTransactionId) }
      : {}),
    conversationId: data.conversationId.toLowerCase(),
    ...(data.orderId !== undefined ? { orderId: identity(data.orderId) } : {}),
    value: data.value,
    currency: data.currency.toUpperCase(),
    occurredAt: date.toISOString(),
  };
}

export async function recordCommerceEvent({
  source,
  input,
}: {
  source: { id: string; workspace_id: string; type: string };
  input: unknown;
}) {
  const event = normalizeCommerceEvent(input);
  await connectDB();
  const conversation = await Conversation.findById(event.conversationId);
  if (
    !conversation ||
    source.type !== "whatsapp" ||
    conversation.channel !== "whatsapp" ||
    conversation.workspaceId !== source.workspace_id ||
    conversation.sourceId !== source.id
  ) {
    throw new CommerceEventError("Conversation not found for this source", 404);
  }
  event.conversationId = String(conversation._id);
  const conversionType = event.eventType === "purchase" ? "sale" : "refund";
  let metadata: Record<string, unknown>;
  let originalSnapshot: Record<string, unknown> | null = null;
  if (event.eventType === "refund") {
    const { data: original, error } = await supabaseAdmin
      .from("conversions")
      .select("id,conversation_id,currency,metadata,meta_delivery_snapshot")
      .eq("external_source_id", source.id)
      .eq("external_transaction_id", event.purchaseTransactionId!)
      .eq("conversion_type", "sale")
      .maybeSingle();
    if (error)
      throw new CommerceEventError("Failed to load original purchase", 500);
    if (
      !original ||
      original.conversation_id !== event.conversationId ||
      original.currency !== event.currency
    )
      throw new CommerceEventError(
        "Original purchase does not match this refund",
        409
      );
    metadata = { ...(original.metadata || {}) };
    originalSnapshot = original.meta_delivery_snapshot;
  } else {
    metadata = await buildConversionAttribution({
      conversation,
      conversationId: event.conversationId,
      convertedAt: event.occurredAt,
    });
  }
  metadata = {
    ...metadata,
    commerceEvent: {
      eventId: event.eventId,
      transactionId: event.transactionId,
      orderId: event.orderId || null,
      purchaseTransactionId: event.purchaseTransactionId || null,
    },
  };
  let intent = await prepareMetaConversionIntent({
    workspaceId: source.workspace_id,
    sourceId: source.id,
    conversionType,
    value: event.value,
    currency: event.currency,
    occurredAt: event.occurredAt,
    metadata,
  });
  if (
    event.eventType === "refund" &&
    !originalSnapshot &&
    intent.meta_delivery_status === "pending"
  ) {
    intent = {
      meta_delivery_status: "not_eligible",
      meta_delivery_snapshot: null,
      meta_delivery_reason: "purchase_not_eligible",
    };
  } else if (
    originalSnapshot &&
    intent.meta_delivery_snapshot &&
    ["datasetId", "wabaId", "ctwaClid", "testEventCode"].some(
      key =>
        originalSnapshot![key] !==
        (intent.meta_delivery_snapshot as unknown as Record<string, unknown>)[
          key
        ]
    )
  ) {
    intent = {
      meta_delivery_status: "not_eligible",
      meta_delivery_snapshot: null,
      meta_delivery_reason: "purchase_destination_changed",
    };
  }
  const scenarioIntent = await prepareConfirmedPaymentScenarioIntent({
    conversation,
    conversionType,
    value: event.value,
    occurredAt: event.occurredAt,
  });
  const { data, error } = await supabaseAdmin.rpc(
    "record_commerce_conversion",
    {
      p_conversion: {
        workspace_id: source.workspace_id,
        conversation_id: event.conversationId,
        conversion_type: conversionType,
        conversion_value: event.value,
        currency: event.currency,
        attributed_to_channel: conversation.channel,
        source: "integration",
        metadata,
        converted_at: event.occurredAt,
        external_source_id: source.id,
        external_event_id: event.eventId,
        external_transaction_id: event.transactionId,
        event_payload_hash: createHash("sha256")
          .update(JSON.stringify(event))
          .digest("hex"),
        ...intent,
        ...scenarioIntent,
      },
      p_purchase_transaction_id: event.purchaseTransactionId || null,
    }
  );
  if (error) {
    const conflict = [
      "commerce_event_conflict",
      "refund_original_not_found",
      "refund_purchase_mismatch",
      "refund_exceeds_purchase",
    ].find(reason => error.message?.includes(reason));
    throw new CommerceEventError(
      conflict || "Failed to record commerce event",
      conflict ? 409 : 500
    );
  }
  if (!data?.conversion?.id)
    throw new CommerceEventError("Invalid conversion persistence result", 500);
  const conversion = data.conversion;
  await recordCustomerConversionEvent({
    conversationId: event.conversationId,
    conversionId: conversion.id,
    conversionType: conversion.conversion_type,
    conversionValue: conversion.conversion_value,
    currency: conversion.currency,
    metadata: conversion.metadata,
    occurredAt: new Date(conversion.converted_at),
    actor: { type: "system", label: "commerce_event" },
  });
  return {
    success: true,
    conversion,
    deduplicated: data.deduplicated === true,
  };
}
