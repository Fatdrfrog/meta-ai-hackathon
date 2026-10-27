import connectDB from "@/lib/mongoose";
import { recordCustomerEvent } from "@/lib/customers/service";
import { Conversation } from "@/models/conversation";
import Customer, {
  ensureCustomerCrmIndexes,
  ensureCustomerOwnerIndexes,
} from "@/models/customer";
import CustomerEvent from "@/models/customer-event";
import { materializeCustomerStageEvent } from "@/lib/analytics/customer-stage-consumer";
import { CustomerStageWriteConflictError, customerStageQueryOptions, decodeCustomerStageEnvelope } from "@/lib/analytics/customer-stage-transition";
import { RequestListItem } from "@/models/request-list-item";
import { listWorkspaceMemberLabels } from "@/lib/supabase/company-users";
import type { SupabaseClient } from "@supabase/supabase-js";
import mongoose from "mongoose";
import { readNonEmptyString } from "@icecore/shared/lib/value-utils";
import { escapeRegExp } from "@/lib/regex-utils";
import {
  cardMatchesAttentionFilter,
  compareCrmAttentionCards,
  CRM_ATTENTION_SCAN_LIMIT,
  deriveCrmCardAttention,
  parseCrmAttentionFilter,
  type CrmAttentionFilter,
} from "./attention";
import {
  deriveCrmCardWarnings,
  deriveCrmFollowUp,
  extractCrmKeyMomentTypes,
} from "./follow-up";
import {
  CRM_UNASSIGNED_STAGE,
  CRM_UNASSIGNED_STAGE_KEY,
  getEffectivePipelineStages,
  normalizeCrmAttentionDays,
  normalizeStageForPersistence,
  replaceStageLabel,
  resolveCrmBoardStageKey,
  crmAssignedStageQueryValues,
  stageKeyToInternalLabel,
  validatePipelineStages,
  crmAttentionDaysToMs,
  type CrmPipelineStage,
  type CrmPipelineStageInput,
} from "./stages";
import { notifyCrmBoardChanged } from "./board-realtime";
import type {
  CrmBoardCard,
  CrmBoardResponse,
} from "./board-types";

export type { CrmBoardCard, CrmBoardResponse } from "./board-types";

type CrmPipelineStageRow = {
  id: string;
  stage_key: string;
  name: string;
  color: string | null;
  sort_order: number | null;
  is_active: boolean | null;
  ghosted_after_days?: number | null;
  stalled_after_days?: number | null;
};

type LeanCustomerCard = {
  _id: unknown;
  displayName?: string | null;
  status?: string | null;
  currentFunnelStage?: string | null;
  primaryConversationId?: unknown;
  ownerUserId?: string | null;
  lastInteractionAt?: Date | string | null;
  createdAt?: Date | string | null;
  profileSummary?: {
    channels?: string[];
    contactPoints?: {
      emails?: string[];
      phones?: string[];
      usernames?: string[];
    };
    conversationCount?: number;
    estimatedCustomerLtv?: number | null;
    lastSentiment?: string | null;
    churnRiskLevel?: string | null;
  } | null;
};

type CustomerStageActor = {
  type: "manager" | "system" | "ai" | "backfill";
  userId?: string | null;
  label?: string | null;
};

const CRM_BOARD_DEFAULT_STAGE_LIMIT = 10;

export class CrmStageConflictError extends Error {
  code = "CRM_STAGE_CONFLICT" as const;
  currentStageKey: string | null;

  constructor(currentStageKey: string | null) {
    super("Stage changed");
    this.currentStageKey = currentStageKey;
  }
}

export class CrmStageValidationError extends Error {
  code = "CRM_STAGE_VALIDATION" as const;
}

export class CrmOwnerValidationError extends Error {
  code = "CRM_OWNER_VALIDATION" as const;
}

function toIsoString(value: unknown): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function toStringId(value: unknown): string | null {
  if (!value) return null;
  if (value instanceof mongoose.Types.ObjectId) return value.toString();
  if (typeof value === "object" && value !== null && "_id" in value) {
    return toStringId((value as { _id?: unknown })._id);
  }
  const normalized = String(value).trim();
  return normalized || null;
}

function mapStageRow(row: CrmPipelineStageRow): CrmPipelineStage {
  return {
    id: row.id,
    key: row.stage_key,
    name: row.name,
    color: row.color,
    sortOrder: row.sort_order ?? 0,
    isActive: row.is_active !== false,
    ghostedAfterDays: normalizeCrmAttentionDays(row.ghosted_after_days),
    stalledAfterDays: normalizeCrmAttentionDays(row.stalled_after_days),
  };
}

function mapCustomerCard(
  customer: LeanCustomerCard,
  ownerLabels: ReadonlyMap<string, string>,
  assignedStageKeys: ReadonlySet<string>
): CrmBoardCard {
  const profile = customer.profileSummary || {};
  const contactPoints = profile.contactPoints || {};
  const stageKey = resolveCrmBoardStageKey(
    customer.currentFunnelStage,
    assignedStageKeys
  );
  const ownerUserId = readNonEmptyString(customer.ownerUserId);

  return {
    id: String(customer._id),
    displayName: customer.displayName ?? null,
    status: customer.status || "active",
    stageKey,
    primaryConversationId: toStringId(customer.primaryConversationId),
    lastInteractionAt: toIsoString(customer.lastInteractionAt),
    createdAt: toIsoString(customer.createdAt),
    channels: Array.isArray(profile.channels) ? profile.channels : [],
    contactPoints: {
      emails: Array.isArray(contactPoints.emails) ? contactPoints.emails : [],
      phones: Array.isArray(contactPoints.phones) ? contactPoints.phones : [],
      usernames: Array.isArray(contactPoints.usernames)
        ? contactPoints.usernames
        : [],
    },
    conversationCount:
      typeof profile.conversationCount === "number"
        ? profile.conversationCount
        : 0,
    estimatedCustomerLtv:
      typeof profile.estimatedCustomerLtv === "number"
        ? profile.estimatedCustomerLtv
        : null,
    sentiment: profile.lastSentiment || null,
    churnRiskLevel: profile.churnRiskLevel || null,
    lastInboundAt: null,
    lastOutboundAt: null,
    slaDueAt: null,
    category: null,
    nextAction: null,
    attention: [],
    followUpKind: null,
    followUpDueAt: null,
    warnings: [],
    ownerUserId,
    ownerLabel: ownerUserId ? ownerLabels.get(ownerUserId) || null : null,
    lastInboundSnippet: null,
  };
}

type LeanRequestRow = {
  _id: unknown;
  lastInboundAt?: Date | string | null;
  slaDueAt?: Date | string | null;
  unreadGeneration?: unknown;
  category?: string | null;
  status?: string | null;
  recentMessages?: unknown;
  classification?: {
    action?: string | null;
    category?: string | null;
    priority?: string | null;
    key_moments?: unknown;
  } | null;
};

type LeanConversationRow = {
  _id: unknown;
  last_inbound_at?: Date | string | null;
  last_outbound_at?: Date | string | null;
  is_read_by_manager?: boolean | null;
  status?: string | null;
  airi_handoff_active?: boolean | null;
  classification?: {
    category?: string | null;
    action?: string | null;
    key_moments?: unknown;
  } | null;
};

function toDate(value: unknown): Date | null {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
}

function toObjectId(value: string): mongoose.Types.ObjectId | null {
  if (!mongoose.Types.ObjectId.isValid(value)) return null;
  return new mongoose.Types.ObjectId(value);
}

const CRM_INBOUND_SNIPPET_MAX = 140;

export function extractLastInboundSnippet(messages: unknown): string | null {
  if (!Array.isArray(messages)) return null;
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const row = message as { direction?: unknown; text?: unknown };
    if (String(row.direction || "").toLowerCase() !== "inbound") continue;
    const text = readNonEmptyString(row.text)?.replace(/\s+/g, " ") ?? null;
    if (!text) continue;
    if (text.length <= CRM_INBOUND_SNIPPET_MAX) return text;
    return `${text.slice(0, CRM_INBOUND_SNIPPET_MAX - 1)}…`;
  }
  return null;
}

function isUnreadGeneration(value: unknown): boolean {
  return value !== null && value !== undefined;
}

export async function loadStageEnteredAtByCustomer(
  workspaceId: string,
  customerIds: string[]
): Promise<Map<string, Date>> {
  const objectIds = customerIds
    .map(toObjectId)
    .filter((id): id is mongoose.Types.ObjectId => Boolean(id));
  if (objectIds.length === 0) return new Map();

  const rows = await CustomerEvent.aggregate<{
    _id: unknown;
    occurredAt?: Date;
  }>([
    {
      $match: {
        workspaceId,
        customerId: { $in: objectIds },
        // A first placement out of "no stage" is materialized as a
        // stage_snapshot; legacy snapshots without a stage event stay ignored.
        $or: [
          { type: "stage_changed" },
          { type: "stage_snapshot", "payload.stageEventId": { $exists: true } },
        ],
      },
    },
    { $sort: { occurredAt: -1 } },
    {
      $group: {
        _id: "$customerId",
        occurredAt: { $first: "$occurredAt" },
      },
    },
  ]);

  const map = new Map<string, Date>();
  for (const row of rows) {
    const id = toStringId(row._id);
    const occurredAt = toDate(row.occurredAt);
    if (id && occurredAt) map.set(id, occurredAt);
  }
  return map;
}

async function enrichCrmBoardCards(
  workspaceId: string,
  cards: CrmBoardCard[],
  stageWindows: ReadonlyMap<
    string,
    { ghostedAfterMs: number; stalledAfterMs: number }
  >
): Promise<CrmBoardCard[]> {
  const conversationIds = [
    ...new Set(
      cards
        .map(card => card.primaryConversationId)
        .filter((id): id is string => Boolean(id))
    ),
  ];
  const conversationObjectIds = conversationIds
    .map(toObjectId)
    .filter((id): id is mongoose.Types.ObjectId => Boolean(id));

  const [requestRows, conversationRows, stageEnteredAtByCustomer] =
    await Promise.all([
    conversationObjectIds.length > 0
      ? RequestListItem.find({
          _id: { $in: conversationObjectIds },
          workspaceId,
          $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
        })
          .select(
            "_id lastInboundAt slaDueAt unreadGeneration category status classification recentMessages"
          )
          .lean<LeanRequestRow[]>()
      : Promise.resolve([]),
    conversationObjectIds.length > 0
      ? Conversation.find({
          _id: { $in: conversationObjectIds },
          workspaceId,
        })
          .select(
            "_id last_inbound_at last_outbound_at is_read_by_manager status airi_handoff_active classification.category classification.action classification.key_moments"
          )
          .lean<LeanConversationRow[]>()
      : Promise.resolve([]),
    loadStageEnteredAtByCustomer(
      workspaceId,
      cards.map(card => card.id)
    ),
  ]);

  const requestsById = new Map(
    requestRows.map(row => [toStringId(row._id), row] as const)
  );
  const conversationsById = new Map(
    conversationRows.map(row => [toStringId(row._id), row] as const)
  );
  const now = new Date();

  return cards.map(card => {
    const request = card.primaryConversationId
      ? requestsById.get(card.primaryConversationId)
      : undefined;
    const conversation = card.primaryConversationId
      ? conversationsById.get(card.primaryConversationId)
      : undefined;
    const lastInboundAt =
      toDate(request?.lastInboundAt) || toDate(conversation?.last_inbound_at);
    const lastOutboundAt = toDate(conversation?.last_outbound_at);
    const slaDueAt = toDate(request?.slaDueAt);
    const category =
      readNonEmptyString(request?.category) ||
      readNonEmptyString(request?.classification?.category) ||
      readNonEmptyString(conversation?.classification?.category);
    const nextAction =
      readNonEmptyString(request?.classification?.action) ||
      readNonEmptyString(conversation?.classification?.action);
    const conversationStatus =
      readNonEmptyString(request?.status) ||
      readNonEmptyString(conversation?.status);
    const isUnread =
      isUnreadGeneration(request?.unreadGeneration) ||
      conversation?.is_read_by_manager === false;
    const enteredAt =
      stageEnteredAtByCustomer.get(card.id) || toDate(card.createdAt);
    const keyMomentTypes = extractCrmKeyMomentTypes(
      request?.classification?.key_moments ??
        conversation?.classification?.key_moments
    );
    const handoffActive = conversation?.airi_handoff_active === true;

    const windows = stageWindows.get(card.stageKey);
    const attention = deriveCrmCardAttention({
      stageKey: card.stageKey,
      now,
      lastInboundAt,
      lastOutboundAt,
      isUnread,
      conversationStatus,
      stageEnteredAt: enteredAt,
      ghostedAfterMs: windows?.ghostedAfterMs,
      stalledAfterMs: windows?.stalledAfterMs,
    });
    const followUp = deriveCrmFollowUp({
      attention,
      handoffActive,
      keyMomentTypes,
      slaDueAt,
      lastInboundAt,
    });

    return {
      ...card,
      lastInboundAt: toIsoString(lastInboundAt),
      lastOutboundAt: toIsoString(lastOutboundAt),
      slaDueAt: toIsoString(slaDueAt),
      category,
      nextAction,
      attention,
      followUpKind: followUp?.kind ?? null,
      followUpDueAt: toIsoString(followUp?.dueAt ?? null),
      warnings: deriveCrmCardWarnings(keyMomentTypes),
      lastInboundSnippet: extractLastInboundSnippet(request?.recentMessages),
    };
  });
}

export async function loadCrmPipelineStages(params: {
  supabase: SupabaseClient;
  workspaceId: string;
  activeOnly?: boolean;
}): Promise<CrmPipelineStage[]> {
  let query = params.supabase
    .from("crm_pipeline_stages")
    .select("id,stage_key,name,color,sort_order,is_active,ghosted_after_days,stalled_after_days")
    .eq("workspace_id", params.workspaceId)
    .order("sort_order", { ascending: true })
    .order("name", { ascending: true });

  if (params.activeOnly) {
    query = query.eq("is_active", true);
  }

  const { data, error } = await query;
  if (error) {
    const message = String(error.message || "").toLowerCase();
    if (message.includes("crm_pipeline_stages")) {
      return [];
    }
    throw error;
  }

  return ((data || []) as CrmPipelineStageRow[]).map(mapStageRow);
}

function buildCustomerFilter(params: {
  workspaceId: string;
  status?: string;
  search?: string;
  stageKey: string;
  ownerUserId?: string;
  assignedStageKeys: readonly string[];
}) {
  const filter: Record<string, unknown> = { workspaceId: params.workspaceId };

  if (params.status && params.status !== "all") {
    filter.status = params.status === "archived" ? "archived" : "active";
  }

  if (params.ownerUserId) {
    filter.ownerUserId = params.ownerUserId;
  }

  const assignedValues = crmAssignedStageQueryValues(params.assignedStageKeys);
  if (params.stageKey === CRM_UNASSIGNED_STAGE_KEY) {
    filter.currentFunnelStage = { $nin: assignedValues };
  } else {
    filter.currentFunnelStage = {
      $in: crmAssignedStageQueryValues([params.stageKey]),
    };
  }

  if (params.search) {
    const regex = new RegExp(escapeRegExp(params.search), "i");
    const searchFilter = [
      { displayName: { $regex: regex } },
      { "profileSummary.contactPoints.emails": { $regex: regex } },
      { "profileSummary.contactPoints.phones": { $regex: regex } },
      { "profileSummary.contactPoints.usernames": { $regex: regex } },
    ];
    if (filter.$or) {
      filter.$and = [{ $or: filter.$or }, { $or: searchFilter }];
      delete filter.$or;
    } else {
      filter.$or = searchFilter;
    }
  }

  return filter;
}

function normalizeLimit(value: unknown, fallback: number): number {
  const parsed =
    typeof value === "number" ? value : Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, 100);
}

function sumCardLtv(cards: CrmBoardCard[]): number | null {
  let sum = 0;
  let hasValue = false;
  for (const card of cards) {
    if (typeof card.estimatedCustomerLtv === "number") {
      sum += card.estimatedCustomerLtv;
      hasValue = true;
    }
  }
  return hasValue ? sum : null;
}

async function sumStageLtv(
  filter: Record<string, unknown>
): Promise<number | null> {
  const [row] = await Customer.aggregate<{ sum: number; count: number }>([
    { $match: filter },
    {
      $group: {
        _id: null,
        sum: {
          $sum: { $ifNull: ["$profileSummary.estimatedCustomerLtv", 0] },
        },
        count: {
          $sum: {
            $cond: [
              {
                $in: [
                  { $type: "$profileSummary.estimatedCustomerLtv" },
                  ["int", "long", "double", "decimal"],
                ],
              },
              1,
              0,
            ],
          },
        },
      },
    },
  ]);
  if (!row || row.count <= 0) return null;
  return row.sum;
}

export function resolveCrmOwnerFilter(
  value: string | null | undefined,
  viewerUserId: string
): string | undefined {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) return undefined;
  if (trimmed === "me") return viewerUserId;
  return trimmed;
}

async function loadOwnerLabels(
  supabase: SupabaseClient,
  workspaceId: string
): Promise<Map<string, string>> {
  try {
    const members = await listWorkspaceMemberLabels(supabase, workspaceId);
    return new Map(members.map(member => [member.userId, member.label]));
  } catch {
    return new Map();
  }
}

export async function getCrmBoard(params: {
  supabase: SupabaseClient;
  workspaceId: string;
  status?: string;
  search?: string;
  limitPerStage?: number;
  stageLimits?: Record<string, number>;
  attention?: string | null;
  salesOnly?: boolean;
  hideSupportSpam?: boolean;
  ownerUserId?: string;
}): Promise<CrmBoardResponse> {
  await connectDB();
  await Promise.all([
    ensureCustomerCrmIndexes(),
    ensureCustomerOwnerIndexes(),
  ]);

  const persistedStages = await loadCrmPipelineStages({
    supabase: params.supabase,
    workspaceId: params.workspaceId,
  });
  const activeStages = getEffectivePipelineStages(persistedStages);
  const archivedStages = persistedStages
    .filter(
      stage =>
        stage.isActive === false && stage.key !== CRM_UNASSIGNED_STAGE_KEY
    )
    .sort(
      (left, right) =>
        left.sortOrder - right.sortOrder || left.name.localeCompare(right.name)
    );
  const stages = [CRM_UNASSIGNED_STAGE, ...activeStages];
  const stageWindows = new Map(
    stages.map(stage => [
      stage.key,
      {
        ghostedAfterMs: crmAttentionDaysToMs(stage.ghostedAfterDays),
        stalledAfterMs: crmAttentionDaysToMs(stage.stalledAfterDays),
      },
    ] as const)
  );
  const defaultLimit = normalizeLimit(
    params.limitPerStage,
    CRM_BOARD_DEFAULT_STAGE_LIMIT
  );
  const attentionFilter: CrmAttentionFilter = parseCrmAttentionFilter(
    params.attention
  );
  const salesOnly = params.salesOnly === true;
  const hideSupportSpam = params.hideSupportSpam !== false;
  const ownerUserId = readNonEmptyString(params.ownerUserId) ?? undefined;
  const scanUnfiltered =
    attentionFilter === "all" && !salesOnly && !hideSupportSpam;
  const ownerLabels = await loadOwnerLabels(
    params.supabase,
    params.workspaceId
  );
  const assignedStageKeys = activeStages.map(stage => stage.key);
  const assignedStageKeySet = new Set(assignedStageKeys);

  const columns = await Promise.all(
    stages.map(async stage => {
      const stageLimit = normalizeLimit(
        params.stageLimits?.[stage.key],
        defaultLimit
      );
      const queryLimit = scanUnfiltered
        ? stageLimit
        : Math.min(
            CRM_ATTENTION_SCAN_LIMIT,
            Math.max(stageLimit, CRM_ATTENTION_SCAN_LIMIT)
          );
      const filter = buildCustomerFilter({
        workspaceId: params.workspaceId,
        status: params.status || "active",
        search: params.search?.trim() || "",
        stageKey: stage.key,
        ownerUserId,
        assignedStageKeys,
      });

      const [customers, unfilteredCount] = await Promise.all([
        Customer.find(filter)
          .select(
            "_id displayName status currentFunnelStage primaryConversationId ownerUserId lastInteractionAt createdAt profileSummary"
          )
          .sort({ lastInteractionAt: -1, createdAt: -1 })
          .limit(queryLimit)
          .lean<LeanCustomerCard[]>(),
        Customer.countDocuments(filter),
      ]);

      const enriched = await enrichCrmBoardCards(
        params.workspaceId,
        customers.map(customer =>
          mapCustomerCard(customer, ownerLabels, assignedStageKeySet)
        ),
        stageWindows
      );
      const matching = scanUnfiltered
        ? enriched
        : [...enriched]
            .filter(card =>
              cardMatchesAttentionFilter(
                card.attention,
                card.category,
                attentionFilter,
                salesOnly,
                hideSupportSpam,
                card.followUpKind
              )
            )
            .sort((left, right) =>
              compareCrmAttentionCards(
                {
                  attention: left.attention,
                  slaDueAt: toDate(left.slaDueAt),
                  lastInboundAt: toDate(left.lastInboundAt),
                },
                {
                  attention: right.attention,
                  slaDueAt: toDate(right.slaDueAt),
                  lastInboundAt: toDate(right.lastInboundAt),
                }
              )
            );
      const cards = matching.slice(0, stageLimit);
      const totalCount = scanUnfiltered ? unfilteredCount : matching.length;
      const ltvSum =
        scanUnfiltered && unfilteredCount > customers.length
          ? await sumStageLtv(filter)
          : sumCardLtv(matching);

      return {
        stageKey: stage.key,
        totalCount,
        ltvSum,
        nextCursor:
          totalCount > cards.length ? String(cards.length) : null,
        cards,
      };
    })
  );

  return { stages, columns, archivedStages };
}

async function upsertInternalStageLabels(params: {
  supabase: SupabaseClient;
  workspaceId: string;
  stages: ReturnType<typeof validatePipelineStages>;
}) {
  for (const stage of params.stages) {
    const name = stageKeyToInternalLabel(stage.key);
    const { data: existing, error: selectError } = await params.supabase
      .from("internal_labels")
      .select("id")
      .eq("workspace_id", params.workspaceId)
      .eq("name", name)
      .maybeSingle();

    if (selectError) throw selectError;

    if ((existing as { id?: string } | null)?.id) {
      const { error } = await params.supabase
        .from("internal_labels")
        .update({
          color: stage.color,
          is_active: stage.isActive,
          updated_at: new Date().toISOString(),
        })
        .eq("id", (existing as { id: string }).id)
        .eq("workspace_id", params.workspaceId);
      if (error) throw error;
      continue;
    }

    const { error } = await params.supabase.from("internal_labels").insert({
      workspace_id: params.workspaceId,
      name,
      color: stage.color,
      description: `CRM pipeline stage: ${stage.name}`,
      is_active: stage.isActive,
      updated_at: new Date().toISOString(),
    });
    if (error) throw error;
  }
}

export async function saveCrmPipeline(params: {
  supabase: SupabaseClient;
  workspaceId: string;
  stages: CrmPipelineStageInput[];
}): Promise<{ stages: CrmPipelineStage[] }> {
  const stages = validatePipelineStages(params.stages);
  const rows = stages.map(stage => ({
    workspace_id: params.workspaceId,
    stage_key: stage.key,
    name: stage.name,
    color: stage.color,
    sort_order: stage.sortOrder,
    is_active: stage.isActive,
    ghosted_after_days: stage.ghostedAfterDays,
    stalled_after_days: stage.stalledAfterDays,
    updated_at: new Date().toISOString(),
  }));

  const { data, error } = await params.supabase
    .from("crm_pipeline_stages")
    .upsert(rows, { onConflict: "workspace_id,stage_key" })
    .select("id,stage_key,name,color,sort_order,is_active,ghosted_after_days,stalled_after_days")
    .order("sort_order", { ascending: true })
    .order("name", { ascending: true });

  if (error) throw error;

  await upsertInternalStageLabels({
    supabase: params.supabase,
    workspaceId: params.workspaceId,
    stages,
  });

  await notifyCrmBoardChanged({
    workspaceId: params.workspaceId,
    reason: "pipeline_saved",
  });

  return { stages: ((data || []) as CrmPipelineStageRow[]).map(mapStageRow) };
}

async function getValidStageKeys(params: {
  supabase: SupabaseClient;
  workspaceId: string;
}) {
  const persistedStages = await loadCrmPipelineStages({
    supabase: params.supabase,
    workspaceId: params.workspaceId,
  });
  return new Set(
    getEffectivePipelineStages(persistedStages).map(stage => stage.key)
  );
}

// Write the board move's history row now so stage age does not wait for the
// worker collector; it replays the same event id idempotently.
async function materializeCommittedStageEvent(
  workspaceId: string,
  customerId: string
) {
  try {
    const committed = await Customer.findById(customerId)
      .select("crm_stage_event")
      .lean<{ crm_stage_event?: unknown } | null>();
    const event = decodeCustomerStageEnvelope(committed?.crm_stage_event);
    if (
      !event ||
      event.workspaceId !== workspaceId ||
      event.customerId !== customerId
    )
      return;
    await materializeCustomerStageEvent(event, "source_write");
  } catch (error) {
    console.warn("[CRM board] Stage history write deferred to the collector", {
      workspaceId,
      customerId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function moveCustomerToCrmStage(params: {
  supabase: SupabaseClient;
  workspaceId: string;
  customerId: string;
  stageKey: string | null;
  expectedStageKey?: string | null;
  actor: CustomerStageActor;
}) {
  await connectDB();

  const nextStageKey = normalizeStageForPersistence(params.stageKey);
  if (nextStageKey) {
    const validStageKeys = await getValidStageKeys({
      supabase: params.supabase,
      workspaceId: params.workspaceId,
    });
    if (!validStageKeys.has(nextStageKey)) {
      throw new CrmStageValidationError("Invalid CRM pipeline stage");
    }
  }

  const customer = await Customer.findById(params.customerId)
    .select(
      "_id workspaceId currentFunnelStage primaryConversationId conversationIds"
    )
    .lean<{
      _id: unknown;
      workspaceId?: string;
      currentFunnelStage?: string | null;
      primaryConversationId?: unknown;
      conversationIds?: unknown[];
    } | null>();

  if (!customer || customer.workspaceId !== params.workspaceId) {
    throw new CrmStageValidationError("Customer not found");
  }

  const currentStageKey = normalizeStageForPersistence(
    customer.currentFunnelStage
  );
  const expectedStageKey =
    params.expectedStageKey === undefined
      ? undefined
      : normalizeStageForPersistence(params.expectedStageKey);
  if (
    expectedStageKey !== undefined &&
    (currentStageKey || null) !== (expectedStageKey || null)
  ) {
    throw new CrmStageConflictError(currentStageKey);
  }

  if ((currentStageKey || null) === (nextStageKey || null)) {
    return {
      customer: {
        id: String(customer._id),
        stageKey: nextStageKey,
      },
    };
  }

  const primaryConversationId =
    toStringId(customer.primaryConversationId) ||
    (Array.isArray(customer.conversationIds)
      ? customer.conversationIds.map(toStringId).find(Boolean) || null
      : null);
  let eventConversationId: string | null = null;

  // Commit stage and its durable transition before updating the conversation label mirror.
  try {
    const updated = await Customer.updateOne(
      { _id: params.customerId, workspaceId: params.workspaceId, currentFunnelStage: customer.currentFunnelStage ?? null },
      { $set: { currentFunnelStage: nextStageKey } },
      customerStageQueryOptions({ actor: params.actor, source: "crm_board" })
    );
    if (updated.matchedCount !== 1) throw new CustomerStageWriteConflictError();
  } catch (error) {
    if (!(error instanceof CustomerStageWriteConflictError)) throw error;
    const latest = await Customer.findById(params.customerId).select("currentFunnelStage").lean<{ currentFunnelStage?: string | null } | null>();
    throw new CrmStageConflictError(normalizeStageForPersistence(latest?.currentFunnelStage));
  }
  await materializeCommittedStageEvent(params.workspaceId, String(customer._id));

  if (primaryConversationId) {
    const conversation = await Conversation.findOne({
      _id: primaryConversationId,
      workspaceId: params.workspaceId,
    })
      .select("_id internal_labels")
      .lean<{ _id: unknown; internal_labels?: string[] | null } | null>();

    if (conversation) {
      eventConversationId = String(conversation._id);
      await Conversation.updateOne(
        { _id: conversation._id, workspaceId: params.workspaceId },
        {
          $set: {
            internal_labels: replaceStageLabel(
              conversation.internal_labels,
              nextStageKey
            ),
          },
        }
      );
    }
  }

  await notifyCrmBoardChanged({
    workspaceId: params.workspaceId,
    reason: "stage_moved",
    customerId: params.customerId,
    conversationId: eventConversationId,
    stageKey: nextStageKey,
  });

  return {
    customer: {
      id: String(customer._id),
      stageKey: nextStageKey,
    },
  };
}

export async function assignCustomerOwner(params: {
  workspaceId: string;
  customerId: string;
  ownerUserId: string | null;
  actor: CustomerStageActor;
}) {
  await connectDB();

  const nextOwnerUserId = readNonEmptyString(params.ownerUserId);
  const customer = await Customer.findById(params.customerId)
    .select("_id workspaceId ownerUserId")
    .lean<{
      _id: unknown;
      workspaceId?: string;
      ownerUserId?: string | null;
    } | null>();

  if (!customer || customer.workspaceId !== params.workspaceId) {
    throw new CrmOwnerValidationError("Customer not found");
  }

  const previousOwnerUserId = readNonEmptyString(customer.ownerUserId);
  if (previousOwnerUserId === nextOwnerUserId) {
    return {
      customer: {
        id: String(customer._id),
        ownerUserId: nextOwnerUserId,
      },
    };
  }

  const assignedAt = nextOwnerUserId ? new Date() : null;
  await Customer.updateOne(
    { _id: params.customerId, workspaceId: params.workspaceId },
    {
      $set: {
        ownerUserId: nextOwnerUserId,
        ownerAssignedAt: assignedAt,
      },
    }
  );

  await recordCustomerEvent({
    workspaceId: params.workspaceId,
    customerId: params.customerId,
    type: "owner_changed",
    occurredAt: assignedAt ?? new Date(),
    payload: {
      ownerUserId: nextOwnerUserId,
      previousOwnerUserId,
      source: "crm_board",
    },
    actor: params.actor,
    idempotencyKey: [
      "crm-owner",
      params.customerId,
      previousOwnerUserId || "none",
      nextOwnerUserId || "none",
      Date.now(),
    ].join(":"),
  });

  await notifyCrmBoardChanged({
    workspaceId: params.workspaceId,
    reason: "owner_changed",
    customerId: params.customerId,
    ownerUserId: nextOwnerUserId,
  });

  return {
    customer: {
      id: String(customer._id),
      ownerUserId: nextOwnerUserId,
    },
  };
}
