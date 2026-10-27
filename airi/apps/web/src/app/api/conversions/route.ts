import {
  buildConversionAttribution,
  getMetadataString,
  getConversionAttributionReport,
  getScenarioConversionReport,
} from "@/lib/conversions/conversion-attribution";
import {
  prepareMetaConversionIntent,
  type MetaConversionIntent,
} from "@/lib/conversions/meta-conversion-intent";
import { prepareConfirmedPaymentScenarioIntent } from "@/lib/conversions/confirmed-payment-scenario";
import { recordCustomerConversionEvent } from "@/lib/customers/service";
import connectDB from "@/lib/mongoose";
import { createClient } from "@/lib/supabase/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { fetchSourceWithCredentialsResult } from "@/lib/sources/utils";
import { Conversation } from "@/models/conversation";
import Message from "@/models/message";
import {
  hasCurrentConversationClassification,
  CONVERSATION_CLASSIFICATION_FRESHNESS_SELECT,
} from "@icecore/shared/lib/conversation-classification-freshness";
import {
  MAX_PAYMENT_SUGGESTIONS,
  type PaymentSuggestion,
} from "@icecore/shared/types/payment-evidence";
import { NextResponse } from "next/server";
import { checkUserWorkspaceAccess } from "@/lib/supabase/queries";
import { requiredFieldResponse } from "@/lib/api/json-body";

interface ConversionRequest {
  conversationId: string;
  conversionType: "sale" | "signup" | "booking" | "retention" | "custom";
  conversionValue?: number;
  currency?: string;
  metadata?: Record<string, unknown>;
  paymentEvidenceMessageId?: string;
  transactionId?: string;
}

async function requiresTransactionId(conversation: {
  workspaceId: string;
  sourceId?: string | null;
  channel?: string;
}) {
  if (conversation.channel !== "whatsapp" || !conversation.sourceId)
    return false;
  const result = await fetchSourceWithCredentialsResult(
    conversation.sourceId,
    "whatsapp"
  );
  if (!result.ok) throw new Error("Failed to load sales connection");
  if (
    result.source &&
    result.source.workspace_id !== conversation.workspaceId
  ) {
    throw new Error("Invalid sales connection");
  }
  const credentials = result.source?.credentials as
    | Record<string, unknown>
    | undefined;
  return credentials?.sales_webhook_enabled === true;
}

type StoredConversion = {
  id: string;
  conversation_id?: string;
  conversion_type?: string;
  conversion_value?: number | null;
  currency?: string | null;
  metadata?: Record<string, unknown> | null;
  converted_at?: string | null;
  external_transaction_id?: string | null;
  external_source_id?: string | null;
};

function netConversionValue(conversion: {
  conversion_type: string;
  conversion_value?: number | null;
}) {
  return (
    (conversion.conversion_value || 0) *
    (conversion.conversion_type === "refund" ? -1 : 1)
  );
}

async function recordConversionCustomerHistory(params: {
  conversion: StoredConversion;
  conversationId: string;
  userId: string;
  conversionType: string;
  conversionValue?: number | null;
  currency?: string | null;
  metadata?: Record<string, unknown>;
}) {
  const { conversion } = params;
  const metadata = conversion.metadata || params.metadata || {};
  const paymentEvidence = metadata.paymentEvidence;
  const confirmedBy = getMetadataString(paymentEvidence, "confirmedByUserId");
  await recordCustomerConversionEvent({
    conversationId: params.conversationId,
    conversionId: conversion.id,
    conversionType: conversion.conversion_type || params.conversionType,
    conversionValue:
      conversion.conversion_value ?? params.conversionValue ?? null,
    currency: conversion.currency || params.currency,
    metadata,
    occurredAt: new Date(conversion.converted_at || new Date().toISOString()),
    actor: {
      type: "manager",
      userId: confirmedBy || params.userId,
      label: "manual_conversion",
    },
  }).catch(error => {
    console.error("Customer conversion event error:", error);
  });
}

function getPaymentSuggestions(conversation: unknown): PaymentSuggestion[] {
  if (!hasCurrentConversationClassification(conversation)) return [];
  const suggestions = (
    conversation as { payment_suggestions?: PaymentSuggestion[] }
  ).payment_suggestions;
  if (!Array.isArray(suggestions)) return [];
  // POST reads a hydrated document while GET reads lean data. Copy only domain
  // fields so Mongoose subdocument internals never enter conversion metadata.
  return suggestions.slice(0, MAX_PAYMENT_SUGGESTIONS).map(suggestion => ({
    messageId: suggestion.messageId,
    kind: suggestion.kind,
    amount: suggestion.amount,
    currency: suggestion.currency,
    occurredAt: suggestion.occurredAt,
  }));
}

/**
 * POST - Report a conversion
 */
export async function POST(request: Request) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = (await request.json()) as ConversionRequest;
    const {
      conversationId: requestedConversationId,
      conversionType,
      conversionValue,
      currency = "USD",
      metadata = {},
      paymentEvidenceMessageId,
      transactionId: requestedTransactionId,
    } = body;

    if (
      !requestedConversationId ||
      !["sale", "signup", "booking", "retention", "custom"].includes(
        conversionType
      )
    ) {
      return NextResponse.json(
        { error: "conversationId and conversionType are required" },
        { status: 400 }
      );
    }

    if (
      typeof requestedConversationId !== "string" ||
      !/^[a-f0-9]{24}$/i.test(requestedConversationId)
    ) {
      return NextResponse.json(
        { error: "Conversation not found" },
        { status: 404 }
      );
    }
    if (
      conversionType === "sale" &&
      (typeof conversionValue !== "number" ||
        !Number.isFinite(conversionValue) ||
        conversionValue <= 0 ||
        conversionValue > 99999999.99 ||
        Math.round(conversionValue * 100) / 100 !== conversionValue ||
        typeof currency !== "string" ||
        !/^[A-Z]{3}$/.test(currency))
    ) {
      return NextResponse.json(
        { error: "Sale requires a positive value and valid currency" },
        { status: 400 }
      );
    }
    if (
      requestedTransactionId !== undefined &&
      (typeof requestedTransactionId !== "string" ||
        !requestedTransactionId.trim() ||
        requestedTransactionId.trim().length > 200 ||
        /[\u0000-\u001f]/.test(requestedTransactionId) ||
        conversionType !== "sale")
    ) {
      return NextResponse.json(
        { error: "Invalid payment transaction reference" },
        { status: 400 }
      );
    }
    const transactionId = requestedTransactionId?.trim();

    if (
      paymentEvidenceMessageId !== undefined &&
      (typeof paymentEvidenceMessageId !== "string" ||
        !/^[a-f0-9]{24}$/i.test(paymentEvidenceMessageId) ||
        conversionType !== "sale" ||
        typeof conversionValue !== "number" ||
        !Number.isFinite(conversionValue) ||
        conversionValue <= 0 ||
        conversionValue > 99999999.99 ||
        Math.round(conversionValue * 100) / 100 !== conversionValue ||
        typeof currency !== "string" ||
        !/^[A-Z]{3}$/.test(currency))
    ) {
      return NextResponse.json(
        {
          error:
            "Payment confirmation requires valid evidence, sale value, and currency",
        },
        { status: 400 }
      );
    }

    await connectDB();

    // Get conversation to verify access and get metadata
    const conversation = await Conversation.findById(requestedConversationId);

    if (!conversation) {
      return NextResponse.json(
        { error: "Conversation not found" },
        { status: 404 }
      );
    }

    const conversationId = String(conversation._id);
    const workspaceId = conversation.workspaceId;

    // Verify workspace access
    if (!(await checkUserWorkspaceAccess(supabase, user.id, workspaceId))) {
      return NextResponse.json(
        { error: "Access denied to this conversation" },
        { status: 403 }
      );
    }

    const findConfirmedPayment = () =>
      supabase
        .from("conversions")
        .select("*")
        .eq("workspace_id", workspaceId)
        .eq("conversation_id", conversationId)
        .eq("payment_evidence_message_id", paymentEvidenceMessageId!)
        .maybeSingle();

    const confirmedPaymentResponse = async (conversion: StoredConversion) => {
      if (
        transactionId &&
        (conversion.external_transaction_id !== transactionId ||
          conversion.external_source_id !== conversation.sourceId ||
          conversion.conversion_value !== conversionValue ||
          conversion.currency !== currency)
      ) {
        return NextResponse.json(
          {
            error:
              "Payment transaction reference already records different sale details",
            code: "commerce_event_conflict",
          },
          { status: 409 }
        );
      }
      await recordConversionCustomerHistory({
        conversion,
        conversationId,
        userId: user.id,
        conversionType,
      });
      return NextResponse.json({
        success: true,
        conversion,
        deduplicated: true,
      });
    };

    let paymentSuggestion: PaymentSuggestion | undefined;
    if (paymentEvidenceMessageId) {
      // A retry must retain the original sale even if classification changed.
      const { data: existing, error: lookupError } =
        await findConfirmedPayment();
      if (lookupError) {
        return NextResponse.json(
          { error: "Failed to check payment confirmation" },
          { status: 500 }
        );
      }
      if (existing) return confirmedPaymentResponse(existing);

      paymentSuggestion = getPaymentSuggestions(conversation).find(
        suggestion => suggestion.messageId === paymentEvidenceMessageId
      );
      if (!paymentSuggestion) {
        return NextResponse.json(
          {
            error:
              "Payment suggestion is no longer current. Refresh the conversation.",
          },
          { status: 409 }
        );
      }
      const evidence = await Message.findOne({
        _id: paymentEvidenceMessageId,
        conversation: conversationId,
        workspaceId,
        direction: "inbound",
      })
        .select("_id date")
        .lean<{ _id: unknown; date?: Date | string } | null>();
      if (!evidence) {
        return NextResponse.json(
          { error: "Payment evidence is unavailable" },
          { status: 409 }
        );
      }
    }

    if (conversionType === "sale") {
      if (
        transactionId &&
        (conversation.channel !== "whatsapp" || !conversation.sourceId)
      ) {
        return NextResponse.json(
          { error: "Payment transaction reference requires a WhatsApp source" },
          { status: 400 }
        );
      }
      if (!transactionId && (await requiresTransactionId(conversation))) {
        return NextResponse.json(
          {
            error:
              "A payment transaction reference is required while the sales webhook is enabled",
            code: "transaction_id_required",
          },
          { status: 400 }
        );
      }
    }

    const convertedAt =
      paymentSuggestion?.occurredAt || new Date().toISOString();
    const enrichedMetadata = await buildConversionAttribution({
      conversation,
      conversationId,
      convertedAt,
      metadata,
      paymentSuggestion,
      confirmedByUserId: user.id,
    });
    const metaIntent: MetaConversionIntent =
      conversionType === "sale" && !transactionId
        ? {
            meta_delivery_status: "not_eligible",
            meta_delivery_snapshot: null,
            meta_delivery_reason: "transaction_id_missing",
          }
        : await prepareMetaConversionIntent({
            workspaceId,
            sourceId: conversation.sourceId || null,
            conversionType,
            value: conversionValue ?? null,
            currency,
            occurredAt: convertedAt,
            metadata: enrichedMetadata,
          });
    const scenarioIntent = await prepareConfirmedPaymentScenarioIntent({
      conversation,
      conversionType,
      value: conversionValue ?? null,
      occurredAt: convertedAt,
      paymentEvidenceOccurredAt: paymentSuggestion?.occurredAt,
    });

    // Insert conversion
    const row = {
      ...metaIntent,
      ...scenarioIntent,
      workspace_id: workspaceId,
      conversation_id: conversationId,
      conversion_type: conversionType,
      conversion_value: conversionValue,
      currency,
      attributed_to_agent: conversation.handled_by_agent_id || null,
      attributed_to_channel: conversation.channel,
      metadata: enrichedMetadata,
      source: "manual",
      ...(paymentEvidenceMessageId
        ? { payment_evidence_message_id: paymentEvidenceMessageId }
        : {}),
      converted_at: convertedAt,
    };
    const result = transactionId
      ? await supabaseAdmin.rpc("record_commerce_conversion", {
          p_conversion: {
            ...row,
            external_source_id: conversation.sourceId,
            external_transaction_id: transactionId,
          },
          p_purchase_transaction_id: null,
        })
      : await supabaseAdmin.from("conversions").insert(row).select().single();
    const insertError = result.error;
    const conversion = transactionId ? result.data?.conversion : result.data;
    const deduplicated = transactionId && result.data?.deduplicated === true;

    if (insertError) {
      if (insertError.message?.includes("commerce_event_conflict")) {
        return NextResponse.json(
          {
            error:
              "Payment transaction reference already records different sale details",
            code: "commerce_event_conflict",
          },
          { status: 409 }
        );
      }
      if (paymentEvidenceMessageId && insertError.code === "23505") {
        const { data: existing, error: lookupError } =
          await findConfirmedPayment();
        if (!lookupError && existing) return confirmedPaymentResponse(existing);
      }
      console.error("Insert conversion error:", insertError);
      return NextResponse.json(
        { error: "Failed to save conversion" },
        { status: 500 }
      );
    }

    if (!conversion?.id) {
      return NextResponse.json(
        { error: "Failed to save conversion" },
        { status: 500 }
      );
    }
    await recordConversionCustomerHistory({
      conversion,
      conversationId,
      userId: user.id,
      conversionType,
      conversionValue: conversionValue ?? null,
      currency,
      metadata: enrichedMetadata,
    });

    return NextResponse.json({
      success: true,
      conversion,
      message: "Conversion tracked successfully",
      ...(deduplicated ? { deduplicated: true } : {}),
    });
  } catch (error) {
    console.error("Report conversion error:", error);
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
}

/**
 * GET - Get conversions for workspace
 */
export async function GET(request: Request) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const workspaceId = searchParams.get("workspaceId");
    let conversationId = searchParams.get("conversationId");
    const conversionType = searchParams.get("type");
    const paymentSuggestionsOnly =
      searchParams.get("paymentSuggestionsOnly") === "true";
    const days = parseInt(searchParams.get("days") || "30", 10);

    if (!workspaceId) return requiredFieldResponse("workspaceId");

    if (paymentSuggestionsOnly && !conversationId) {
      return NextResponse.json(
        { error: "conversationId is required for payment suggestions" },
        { status: 400 }
      );
    }

    // Verify workspace access
    if (!(await checkUserWorkspaceAccess(supabase, user.id, workspaceId))) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    if (searchParams.get("report") === "attribution") {
      const end = new Date(searchParams.get("end") || Date.now());
      const start = new Date(
        searchParams.get("start") || end.getTime() - 30 * 86400000
      );
      const sourceId = searchParams.get("sourceId");
      if (
        !Number.isFinite(start.getTime()) ||
        !Number.isFinite(end.getTime()) ||
        start >= end ||
        end.getTime() - start.getTime() > 366 * 86400000 ||
        (sourceId &&
          !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(sourceId))
      ) {
        return NextResponse.json(
          { error: "Invalid attribution report interval or source" },
          { status: 400 }
        );
      }
      return NextResponse.json(
        await getConversionAttributionReport({
          supabase,
          workspaceId,
          start: start.toISOString(),
          end: end.toISOString(),
          sourceId,
        })
      );
    }

    if (searchParams.get("report") === "scenario") {
      const scenarioId = (searchParams.get("scenarioId") || "")
        .trim()
        .toLowerCase();
      const rawDays = searchParams.get("days") ?? "30";
      const reportDays = Number(rawDays);
      const end = new Date(searchParams.get("end") || Date.now());
      const start = new Date(
        searchParams.get("start") || end.getTime() - reportDays * 86400000
      );
      if (
        !/^[a-f0-9]{24}$/.test(scenarioId) ||
        !/^\d+$/.test(rawDays) ||
        !Number.isInteger(reportDays) ||
        reportDays < 1 ||
        reportDays > 90 ||
        !Number.isFinite(start.getTime()) ||
        !Number.isFinite(end.getTime()) ||
        start >= end ||
        end.getTime() - start.getTime() > 90 * 86400000
      ) {
        return NextResponse.json(
          { error: "Invalid scenario report interval or scenario" },
          { status: 400 }
        );
      }
      return NextResponse.json(
        await getScenarioConversionReport({
          supabase,
          workspaceId,
          scenarioId,
          start: start.toISOString(),
          end: end.toISOString(),
        })
      );
    }

    let paymentSuggestions: Array<
      PaymentSuggestion & { conversionId: string | null }
    > = [];
    let defaultCurrency = "USD";
    let transactionIdRequired = false;
    let transactionIdSupported = false;
    if (conversationId) {
      if (!/^[a-f0-9]{24}$/i.test(conversationId)) {
        return NextResponse.json(
          { error: "Conversation not found" },
          { status: 404 }
        );
      }
      await connectDB();
      const conversation = await Conversation.findById(conversationId)
        .select(
          `workspaceId sourceId channel payment_suggestions ${CONVERSATION_CLASSIFICATION_FRESHNESS_SELECT}`
        )
        .lean<{
          _id: unknown;
          workspaceId: string;
          sourceId?: string;
          channel?: string;
          payment_suggestions?: PaymentSuggestion[];
        } | null>();
      if (!conversation || conversation.workspaceId !== workspaceId) {
        return NextResponse.json(
          { error: "Conversation not found" },
          { status: 404 }
        );
      }
      conversationId = String(conversation._id);
      transactionIdRequired = await requiresTransactionId(conversation);
      transactionIdSupported =
        conversation.channel === "whatsapp" && Boolean(conversation.sourceId);
      const { data: workspace, error: workspaceError } = await supabase
        .from("workspaces")
        .select("ltv_currency")
        .eq("id", workspaceId)
        .maybeSingle();
      if (workspaceError) {
        return NextResponse.json(
          { error: "Failed to load workspace currency" },
          { status: 500 }
        );
      }
      defaultCurrency = workspace?.ltv_currency || "USD";
      const suggestions = getPaymentSuggestions(conversation);
      if (suggestions.length) {
        // Evidence identity is independent of the date window used for reports.
        const { data: confirmed, error: confirmedError } = await supabase
          .from("conversions")
          .select("id,payment_evidence_message_id,conversion_value,currency")
          .eq("workspace_id", workspaceId)
          .eq("conversation_id", conversationId)
          .in(
            "payment_evidence_message_id",
            suggestions.map(suggestion => suggestion.messageId)
          );
        if (confirmedError) {
          return NextResponse.json(
            { error: "Failed to load payment confirmations" },
            { status: 500 }
          );
        }
        const confirmedByMessage = new Map<
          string,
          {
            id: string;
            conversion_value: number | null;
            currency: string | null;
          }
        >(
          (confirmed || []).map(conversion => [
            conversion.payment_evidence_message_id,
            conversion,
          ])
        );
        paymentSuggestions = suggestions.map(suggestion => {
          const conversion = confirmedByMessage.get(suggestion.messageId);
          return {
            ...suggestion,
            ...(conversion
              ? {
                  amount: conversion.conversion_value,
                  currency: conversion.currency,
                }
              : {}),
            conversionId: conversion?.id || null,
          };
        });
      }
    }

    if (paymentSuggestionsOnly) {
      return NextResponse.json({
        paymentSuggestions,
        defaultCurrency,
        transactionIdRequired,
        transactionIdSupported,
      });
    }

    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    let query = supabase
      .from("conversions")
      .select("*")
      .eq("workspace_id", workspaceId)
      .gte("converted_at", startDate.toISOString())
      .order("converted_at", { ascending: false });

    if (conversationId) {
      query = query.eq("conversation_id", conversationId);
    }

    if (conversionType) {
      query = query.eq("conversion_type", conversionType);
    }

    const { data: conversions, error } = await query;

    if (error) {
      return NextResponse.json(
        { error: "Failed to fetch conversions" },
        { status: 500 }
      );
    }

    // Calculate aggregated metrics
    const conversionsData = conversions || [];
    const totalValue = conversionsData.reduce(
      (sum, c) => sum + netConversionValue(c),
      0
    );

    const byType = conversionsData.reduce(
      (acc, c) => {
        const type = c.conversion_type;
        if (!acc[type]) {
          acc[type] = { count: 0, total_value: 0 };
        }
        acc[type].count++;
        acc[type].total_value += c.conversion_value || 0;
        return acc;
      },
      {} as Record<string, { count: number; total_value: number }>
    );

    const byChannel = conversionsData.reduce(
      (acc, c) => {
        const channel = c.attributed_to_channel || "unknown";
        if (!acc[channel]) {
          acc[channel] = { count: 0, total_value: 0 };
        }
        acc[channel].count++;
        acc[channel].total_value += netConversionValue(c);
        return acc;
      },
      {} as Record<string, { count: number; total_value: number }>
    );

    const byScenario = conversionsData.reduce(
      (acc, c) => {
        const scenarioKey =
          getMetadataString(c.metadata, "scenarioName") ||
          getMetadataString(c.metadata, "scenarioId") ||
          "unknown";
        if (!acc[scenarioKey]) {
          acc[scenarioKey] = { count: 0, total_value: 0 };
        }
        acc[scenarioKey].count += 1;
        acc[scenarioKey].total_value += netConversionValue(c);
        return acc;
      },
      {} as Record<string, { count: number; total_value: number }>
    );

    const byPreset = conversionsData.reduce(
      (acc, c) => {
        const presetKey =
          getMetadataString(c.metadata, "presetId") || "unknown";
        if (!acc[presetKey]) {
          acc[presetKey] = { count: 0, total_value: 0 };
        }
        acc[presetKey].count += 1;
        acc[presetKey].total_value += netConversionValue(c);
        return acc;
      },
      {} as Record<string, { count: number; total_value: number }>
    );

    const bySegment = conversionsData.reduce(
      (acc, c) => {
        const segmentKey =
          getMetadataString(c.metadata, "segment") || "unknown";
        if (!acc[segmentKey]) {
          acc[segmentKey] = { count: 0, total_value: 0 };
        }
        acc[segmentKey].count += 1;
        acc[segmentKey].total_value += netConversionValue(c);
        return acc;
      },
      {} as Record<string, { count: number; total_value: number }>
    );

    const byFunnelStage = conversionsData.reduce(
      (acc, c) => {
        const stageKey =
          getMetadataString(c.metadata, "funnelStage") || "unknown";
        if (!acc[stageKey]) {
          acc[stageKey] = { count: 0, total_value: 0 };
        }
        acc[stageKey].count += 1;
        acc[stageKey].total_value += netConversionValue(c);
        return acc;
      },
      {} as Record<string, { count: number; total_value: number }>
    );

    return NextResponse.json({
      conversions: conversionsData,
      paymentSuggestions,
      defaultCurrency,
      aggregates: {
        total_conversions: conversionsData.length,
        total_value: parseFloat(totalValue.toFixed(2)),
        by_type: byType,
        by_channel: byChannel,
        by_scenario: byScenario,
        by_preset: byPreset,
        by_segment: bySegment,
        by_funnel_stage: byFunnelStage,
        currency: conversionsData[0]?.currency || "USD",
      },
    });
  } catch (error) {
    console.error("Get conversions error:", error);
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
}
