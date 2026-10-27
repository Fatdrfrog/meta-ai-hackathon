import { ensureCustomerForConversation } from "@/lib/customers/service";
import { awaitWithCancellation } from "@/lib/ai/cancellation";
import { Conversation } from "@/models/conversation";
import { Scenario } from "@/models/scenario";
import { normalizeConversationScenarioState } from "@icecore/airi-runtime/scenario-state";
import { getCurrentConversationClassification } from "@icecore/shared/lib/conversation-classification-freshness";
import type { PaymentSuggestion } from "@icecore/shared/types/payment-evidence";
import type {
  ConversionAttributionReport,
  ScenarioConversionReport,
} from "@icecore/shared/types/conversion-events";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  readStringArray,
  isNonNegativeSafeInteger,
} from "@icecore/shared/lib/value-utils";

export async function getConversionAttributionReport({
  supabase,
  workspaceId,
  start,
  end,
  sourceId,
  timeZone,
  signal,
}: {
  supabase: SupabaseClient;
  workspaceId: string;
  start: string;
  end: string;
  sourceId?: string | null;
  timeZone?: string;
  signal?: AbortSignal;
}): Promise<ConversionAttributionReport> {
  signal?.throwIfAborted();
  const query = supabase.rpc("get_conversion_attribution_report", {
    p_workspace_id: workspaceId,
    p_start: start,
    p_end: end,
    p_source_id: sourceId || null,
    ...(timeZone ? { p_timezone: timeZone } : {}),
  });
  const { data, error } = await awaitWithCancellation(
    signal ? query.abortSignal(signal) : query,
    signal
  );
  if (
    error ||
    !data ||
    !Array.isArray(data.rows) ||
    !Array.isArray(data.recentDeliveries) ||
    data.rows.length > 200 ||
    data.recentDeliveries.length > 20
  ) {
    throw new Error("Failed to load conversion attribution");
  }
  return data as ConversionAttributionReport;
}

export async function getScenarioConversionReport({
  supabase,
  workspaceId,
  scenarioId,
  start,
  end,
}: {
  supabase: SupabaseClient;
  workspaceId: string;
  scenarioId: string;
  start: string;
  end: string;
}): Promise<ScenarioConversionReport> {
  const { data, error } = await supabase.rpc("get_scenario_conversion_report", {
    p_workspace_id: workspaceId,
    p_scenario_id: scenarioId,
    p_start: start,
    p_end: end,
  });
  const isAmount = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value);
  if (
    error ||
    !data ||
    !data.totals ||
    !["sales", "bookings", "signups", "refunds"].every(key =>
      isNonNegativeSafeInteger(data.totals[key])
    ) ||
    !Array.isArray(data.currencies) ||
    data.currencies.length > 200 ||
    !data.currencies.every(
      (row: ScenarioConversionReport["currencies"][number]) =>
        row &&
        typeof row.currency === "string" &&
        (row.currency === "" || /^[A-Z]{3}$/.test(row.currency)) &&
        isNonNegativeSafeInteger(row.sales) &&
        isNonNegativeSafeInteger(row.refunds) &&
        isAmount(row.grossRevenue) &&
        isAmount(row.refundedRevenue) &&
        isAmount(row.netRevenue)
    ) ||
    typeof data.truncated !== "boolean"
  ) {
    throw new Error("Failed to load scenario conversion report");
  }
  return {
    scenarioId,
    period: { startDate: start, endDate: end },
    totals: data.totals,
    currencies: data.currencies,
    truncated: data.truncated,
  };
}

type FunnelSegmentKey =
  | "lead_generation"
  | "sales_qualified"
  | "onboarding"
  | "active"
  | "retention"
  | "churn_risk"
  | "other";

const SEGMENT_LABEL_PREFIX = "seg:";
const SEGMENT_LOCK_LABEL = "override:segment_locked";
const FUNNEL_SEGMENT_KEYS = new Set<FunnelSegmentKey>([
  "lead_generation",
  "sales_qualified",
  "onboarding",
  "active",
  "retention",
  "churn_risk",
  "other",
]);

function normalizeSegmentKey(value: unknown): FunnelSegmentKey | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return null;
  const withoutPrefix = trimmed.startsWith(SEGMENT_LABEL_PREFIX)
    ? trimmed.slice(SEGMENT_LABEL_PREFIX.length)
    : trimmed;
  if (!FUNNEL_SEGMENT_KEYS.has(withoutPrefix as FunnelSegmentKey)) return null;
  return withoutPrefix as FunnelSegmentKey;
}

function getSegmentFromLabels(labels: string[]): FunnelSegmentKey | null {
  for (const label of labels) {
    const normalized = normalizeSegmentKey(label);
    if (normalized) return normalized;
  }
  return null;
}

function hasSegmentLockLabel(labels: string[]): boolean {
  return labels.some(
    label => label.trim().toLowerCase() === SEGMENT_LOCK_LABEL
  );
}

function resolveSegmentFromConversation(params: {
  internalLabels: string[];
  classificationCategory?: unknown;
  scenarioSegmentKey?: unknown;
}): FunnelSegmentKey {
  const internalSegment = getSegmentFromLabels(params.internalLabels);
  const taxonomySegment = normalizeSegmentKey(params.classificationCategory);
  const scenarioSegment = normalizeSegmentKey(params.scenarioSegmentKey);

  if (hasSegmentLockLabel(params.internalLabels) && internalSegment) {
    return internalSegment;
  }
  if (internalSegment) return internalSegment;
  if (taxonomySegment) return taxonomySegment;
  if (scenarioSegment) return scenarioSegment;
  return "other";
}

function getFunnelStageFromLabels(labels: string[]): string | null {
  const stageLabel = labels.find(label => label.startsWith("stage:"));
  if (!stageLabel) return null;
  const stage = stageLabel.slice(6).trim();
  return stage || null;
}

export function getMetadataString(
  metadata: unknown,
  key: string
): string | null {
  if (!metadata || typeof metadata !== "object") return null;
  const raw = (metadata as Record<string, unknown>)[key];
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed || null;
}

const COMPLETED_SCENARIO_ATTRIBUTION_WINDOW_MS = 24 * 60 * 60 * 1000;

function scenarioAttributionTime(value: unknown): number | null {
  if (!(value instanceof Date) && typeof value !== "string") return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

/** Reuse persisted runtime receipts; never infer a scenario from message text. */
function resolveScenarioAttributionTouch(state: unknown, anchor: string) {
  const scenarioState = normalizeConversationScenarioState(state);
  const anchorTime = scenarioAttributionTime(anchor);
  const now = Date.now();
  if (!scenarioState || anchorTime === null || anchorTime > now) return null;
  const isScenarioId = (id: string | null | undefined): id is string =>
    typeof id === "string" && /^[a-f0-9]{24}$/.test(id);
  const starts = (scenarioState.startedScenarios || [])
    .flatMap(entry => {
      const time = scenarioAttributionTime(entry.startedAt);
      return isScenarioId(entry.scenarioId) &&
        time !== null &&
        time <= anchorTime
        ? [{ ...entry, time }]
        : [];
    })
    .sort((left, right) => right.time - left.time);
  const latestStart = starts[0];
  // Same-time receipts for different scenarios cannot establish an ordering.
  if (
    latestStart &&
    starts.some(
      entry =>
        entry.time === latestStart.time &&
        entry.scenarioId !== latestStart.scenarioId
    )
  )
    return null;

  const activeId = scenarioState.lockedScenarioId;
  if (isScenarioId(activeId)) {
    const matchingStart = starts.find(entry => entry.scenarioId === activeId);
    const activeTouches = [
      matchingStart?.time,
      scenarioAttributionTime(scenarioState.lastMatchedAt),
      scenarioAttributionTime(scenarioState.pendingStartedAt),
    ].filter(
      (time): time is number => typeof time === "number" && time <= anchorTime
    );
    const activeTime = activeTouches.length ? Math.max(...activeTouches) : null;
    if (
      activeTime !== null &&
      (!latestStart ||
        latestStart.scenarioId === activeId ||
        latestStart.time < activeTime)
    ) {
      return {
        scenarioId: activeId,
        scenarioName:
          scenarioState.lockedScenarioName ||
          matchingStart?.scenarioName ||
          null,
        actionNodeId: scenarioState.currentActionNodeId || null,
        branchNodeIds: scenarioState.currentBranchNodeIds || [],
        attribution: {
          method: "active" as const,
          anchorAt: new Date(anchorTime).toISOString(),
          startedAt: new Date(matchingStart?.time ?? activeTime).toISOString(),
        },
      };
    }
  }
  if (!latestStart) return null;
  const completed = (scenarioState.completedScenarios || [])
    .flatMap(entry => {
      const time = scenarioAttributionTime(entry.completedAt);
      return entry.scenarioId === latestStart.scenarioId && time !== null
        ? [{ ...entry, time }]
        : [];
    })
    .sort((left, right) => right.time - left.time)[0];
  if (
    !completed ||
    completed.time > now ||
    completed.time < latestStart.time ||
    Math.abs(anchorTime - completed.time) >
      COMPLETED_SCENARIO_ATTRIBUTION_WINDOW_MS
  )
    return null;
  return {
    scenarioId: completed.scenarioId,
    scenarioName: completed.scenarioName || latestStart.scenarioName || null,
    actionNodeId: completed.lastActionNodeId || null,
    branchNodeIds: [],
    attribution: {
      method: "completed_touch" as const,
      anchorAt: new Date(anchorTime).toISOString(),
      startedAt: new Date(latestStart.time).toISOString(),
      completedAt: new Date(completed.time).toISOString(),
      windowHours: 24,
    },
  };
}

export async function buildConversionAttribution({
  conversation,
  conversationId,
  convertedAt,
  metadata = {},
  paymentSuggestion,
  confirmedByUserId,
}: {
  conversation: InstanceType<typeof Conversation>;
  conversationId: string;
  convertedAt: string;
  metadata?: Record<string, unknown>;
  paymentSuggestion?: PaymentSuggestion;
  confirmedByUserId?: string;
}): Promise<Record<string, unknown>> {
  const conversationAny = conversation as typeof conversation & {
    internal_labels?: string[];
    classification?: { category?: string };
    customerId?: unknown;
    airi_scenario_state?: {
      lockedScenarioId?: string | null;
      lockedScenarioName?: string | null;
      currentActionNodeId?: string | null;
      currentBranchNodeIds?: string[];
    } | null;
  };
  const scenarioState = conversationAny.airi_scenario_state;
  const internalLabels = readStringArray(conversationAny.internal_labels);
  const currentClassification = getCurrentConversationClassification<{
    category?: unknown;
  }>(conversationAny);
  const ensuredCustomer = await ensureCustomerForConversation({
    conversationId,
    linkMethod: "system",
  }).catch(() => null);
  const customerId =
    ensuredCustomer &&
    typeof ensuredCustomer === "object" &&
    "_id" in ensuredCustomer
      ? String((ensuredCustomer as { _id?: unknown })._id || "")
      : conversationAny.customerId != null
        ? String(conversationAny.customerId)
        : "";
  let scenarioTouch = resolveScenarioAttributionTouch(
    scenarioState,
    paymentSuggestion?.occurredAt || convertedAt
  );
  const funnelStage = getFunnelStageFromLabels(internalLabels);

  let presetId: string | null = null;
  let scenarioSegmentKey: string | null = null;
  if (scenarioTouch && conversation.workspaceId) {
    const scenarioDoc = await Scenario.findOne({
      _id: scenarioTouch.scenarioId,
      workspaceId: conversation.workspaceId,
    })
      .select("workspaceId presetId segmentKey")
      .lean<{
        workspaceId?: string;
        presetId?: string | null;
        segmentKey?: string | null;
      } | null>();
    if (!scenarioDoc || scenarioDoc.workspaceId !== conversation.workspaceId) {
      scenarioTouch = null;
    }
    presetId =
      scenarioTouch &&
      typeof scenarioDoc?.presetId === "string" &&
      scenarioDoc.presetId.trim()
        ? scenarioDoc.presetId.trim()
        : null;
    scenarioSegmentKey =
      scenarioTouch &&
      typeof scenarioDoc?.segmentKey === "string" &&
      scenarioDoc.segmentKey.trim()
        ? scenarioDoc.segmentKey.trim()
        : null;
  } else {
    scenarioTouch = null;
  }

  const referral = conversation.whatsappReferral;
  const referralCapturedAt = referral?.capturedAt
    ? new Date(referral.capturedAt).getTime()
    : NaN;
  const whatsappReferralStatus = !referral
    ? "unavailable"
    : !Number.isFinite(referralCapturedAt)
      ? "unverified"
      : referralCapturedAt > new Date(convertedAt).getTime()
        ? "after_conversion"
        : "attributed";
  return {
    ...metadata,
    commerceEvent: null,
    sourceId: conversation.sourceId || null,
    whatsappReferralStatus,
    whatsappReferral:
      whatsappReferralStatus === "attributed" && referral
        ? {
            sourceType: referral.sourceType || null,
            sourceId: referral.sourceId || null,
            sourceUrl: referral.sourceUrl || null,
            campaignId: referral.campaignId || null,
            campaignName: referral.campaignName || null,
            adSetId: referral.adSetId || null,
            adSetName: referral.adSetName || null,
            ctwaClid: referral.ctwaClid || null,
            ref: referral.ref || null,
            capturedAt: referral.capturedAt || null,
          }
        : null,
    paymentEvidence: paymentSuggestion
      ? {
          ...paymentSuggestion,
          classificationRevision: conversation.classification_revision,
          confirmedByUserId: confirmedByUserId || null,
          confirmedAt: new Date().toISOString(),
        }
      : null,
    scenarioId: scenarioTouch?.scenarioId || null,
    scenarioName: scenarioTouch?.scenarioName || null,
    actionNodeId: scenarioTouch?.actionNodeId || null,
    branchNodeIds: scenarioTouch?.branchNodeIds || [],
    scenarioAttribution: scenarioTouch?.attribution || null,
    segment: resolveSegmentFromConversation({
      internalLabels,
      classificationCategory: currentClassification?.category,
      scenarioSegmentKey,
    }),
    customerId: customerId || null,
    presetId,
    funnelStage,
  } satisfies Record<string, unknown>;
}
