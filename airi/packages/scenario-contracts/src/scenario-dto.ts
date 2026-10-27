import type {
  ScenarioActionType,
  ScenarioBuilderSummary,
} from "./scenario-triggers";
import type { ScenarioMessageIngressEventKind } from "./scenario-message-events";

export type BulkFollowUpTemplateRoute = {
  /** Must match a label from workspace taxonomy (after classifier normalization). */
  taxonomyLabel: string;
  whatsappTemplateName: string;
  whatsappTemplateLanguage?: string;
  /** When set, this route applies only to sends from this campaign graph node id. */
  campaignNodeId?: string | null;
  /** Optional internal label filter (exact match in internal_labels array). */
  internalLabel?: string | null;
};

export type BulkFollowUpSettings = {
  /** Maps taxonomy buckets to templates for operators and future automation. */
  templateRoutes: BulkFollowUpTemplateRoute[];
};

export type ScenarioStatus = "draft" | "active";
export type ScenarioMode = "conversation" | "bulk_campaign";
export type ScenarioMatchingRole = "default" | "fallback";
export type ScenarioEntryPolicy = "repeatable" | "once_per_conversation";

export const DEFAULT_SCENARIO_MATCHING_ROLE: ScenarioMatchingRole = "default";
export const DEFAULT_SCENARIO_ENTRY_POLICY: ScenarioEntryPolicy =
  "once_per_conversation";
export const DEFAULT_SCENARIO_PRIORITY = 0;
export const MAX_SCENARIO_PRIORITY = 1000;
export const DEFAULT_SCENARIO_MODE: ScenarioMode = "conversation";
export const MAX_SCENARIO_NAME_LENGTH = 120;
export const MAX_SCENARIO_REPLY_IMAGES = 6;
export const MAX_SCENARIO_REPLY_LINKS = 8;

export const FUNNEL_SEGMENT_KEYS = [
  "lead_generation",
  "sales_qualified",
  "onboarding",
  "active",
  "retention",
  "churn_risk",
] as const;

export type FunnelSegmentKey = (typeof FUNNEL_SEGMENT_KEYS)[number];

export function isScenarioStatus(value: unknown): value is ScenarioStatus {
  return value === "draft" || value === "active";
}

export function normalizeScenarioStatus(value: unknown): ScenarioStatus {
  return value === "active" ? "active" : "draft";
}

export function isScenarioMode(value: unknown): value is ScenarioMode {
  return value === "conversation" || value === "bulk_campaign";
}

export function normalizeScenarioMode(value: unknown): ScenarioMode {
  return value === "bulk_campaign" ? "bulk_campaign" : "conversation";
}

export function normalizeScenarioTimezone(value: unknown): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) return "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: normalized }).format(
      new Date(0),
    );
    return normalized;
  } catch {
    return "UTC";
  }
}

export function normalizeScenarioPriority(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_SCENARIO_PRIORITY;
  }
  const normalized = Math.floor(value);
  if (normalized < 0) return DEFAULT_SCENARIO_PRIORITY;
  if (normalized > MAX_SCENARIO_PRIORITY) return MAX_SCENARIO_PRIORITY;
  return normalized;
}

export function normalizeScenarioLoopSetting(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    return normalized === "true" || normalized === "1";
  }
  if (typeof value === "number") {
    return value === 1;
  }
  return false;
}

export function isScenarioMatchingRole(
  value: unknown,
): value is ScenarioMatchingRole {
  return value === "default" || value === "fallback";
}

export function normalizeScenarioMatchingRole(
  value: unknown,
): ScenarioMatchingRole {
  return value === "fallback" ? "fallback" : "default";
}

export function isScenarioEntryPolicy(
  value: unknown,
): value is ScenarioEntryPolicy {
  return value === "repeatable" || value === "once_per_conversation";
}

export function normalizeScenarioEntryPolicy(
  value: unknown,
): ScenarioEntryPolicy {
  return isScenarioEntryPolicy(value) ? value : DEFAULT_SCENARIO_ENTRY_POLICY;
}

export type ScenarioViewport = {
  x: number;
  y: number;
  zoom: number;
};

export const DEFAULT_SCENARIO_VIEWPORT: ScenarioViewport = {
  x: 0,
  y: 0,
  zoom: 1,
};

export function isScenarioViewport(value: unknown): value is ScenarioViewport {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const viewport = value as Record<string, unknown>;
  return (
    typeof viewport.x === "number" &&
    Number.isFinite(viewport.x) &&
    typeof viewport.y === "number" &&
    Number.isFinite(viewport.y) &&
    typeof viewport.zoom === "number" &&
    Number.isFinite(viewport.zoom) &&
    viewport.zoom > 0
  );
}

/** Shared list/detail fields for scenario API DTOs (summary vs full document). */
export type ScenarioDocumentListMetadata = {
  _id: string;
  name: string;
  description: string;
  status: ScenarioStatus;
  mode?: ScenarioMode;
  timezone?: string | null;
  priority?: number;
  presetId?: string | null;
  presetVersion?: string | null;
  segmentKey?: string | null;
  matchingRole?: ScenarioMatchingRole;
  entryPolicy: ScenarioEntryPolicy;
  linkedParentScenarioIds?: string[];
  builderSummary?: ScenarioBuilderSummary | null;
  createdAt: string | null;
  updatedAt: string | null;
};

export type ScenarioSummaryDTO = ScenarioDocumentListMetadata & {
  nodeCount: number;
  edgeCount: number;
};

export type ScenarioDocumentDTO<
  TNode = unknown,
  TEdge = unknown,
> = ScenarioDocumentListMetadata & {
  graphSchemaVersion: number;
  nodes: TNode[];
  edges: TEdge[];
  viewport: ScenarioViewport;
  bulkFollowUpSettings?: BulkFollowUpSettings | null;
};

export type ScenarioApiPersistBody<TNode = unknown, TEdge = unknown> = {
  workspaceId: string;
  name: string;
  description: string;
  status: ScenarioStatus;
  mode?: ScenarioMode;
  timezone?: string | null;
  priority: number;
  presetId?: string | null;
  presetVersion?: string | null;
  segmentKey?: string | null;
  matchingRole?: ScenarioMatchingRole;
  entryPolicy?: ScenarioEntryPolicy;
  graphSchemaVersion?: number;
  nodes: TNode[];
  edges: TEdge[];
  viewport: ScenarioViewport;
};

export type ScenarioApiFullUpdateBody<
  TNode = unknown,
  TEdge = unknown,
> = ScenarioApiPersistBody<TNode, TEdge> & {
  expectedUpdatedAt?: string | null;
};

export type ScenarioListApiResponse = {
  items: ScenarioSummaryDTO[];
  nextCursor: string | null;
  hasMore: boolean;
};

export type ScenarioDetailResponseMetadata = {
  linkedConditionParentCountByNodeId: Record<string, number>;
  warnings?: ScenarioDetailResponseWarning[];
  /**
   * Only on reads that asked for `?mediaSigning=deferred`: true when some
   * node media was not signed in time and still holds its durable `gcs://`
   * reference (omitted otherwise). Signing continues on the server, so asking
   * for the detail again shortly returns signed HTTPS URLs.
   */
  mediaDisplayUrlsPending?: boolean;
};

export type ScenarioDetailResponseWarning =
  | {
      code:
        | "legacy_action_routing_timer_replan_failed"
        | "legacy_action_routing_session_cleanup_failed";
      message: string;
      affectedConversationIds: string[];
      recoveryStatus?: "pending" | "failed";
      retryable?: boolean;
    }
  | {
      code: "scenario_detail_enrichment_failed";
      message: string;
    }
  | {
      code: "linked_condition_reconciliation_pending";
      message: string;
      affectedScenarioIds: string[];
    }
  | {
      code: "whatsapp_qr_entry_point_detach_pending";
      message: string;
      affectedNodeIds: string[];
    };

export type ScenarioDetailApiResponse<TNode = unknown, TEdge = unknown> = {
  scenario: ScenarioDocumentDTO<TNode, TEdge>;
  metadata: ScenarioDetailResponseMetadata;
};

export type ScenarioApiErrorPayload = {
  error?: string;
  code?: string;
  codes?: string[];
  nodeIds?: string[];
  currentUpdatedAt?: string;
};

export type ScenarioListCursor = {
  updatedAt: string;
  id: string;
};

export type TriggerLogCursor = {
  evaluatedAt: string;
  id: string;
};

export type ScenarioPreviewEvaluation = {
  scenarioId: string;
  scenarioName: string;
  matchingRole: ScenarioMatchingRole;
  triggerNodeId?: string | null;
  scenarioPriority: number;
  order: number;
  result: "winner" | "matched_but_shadowed" | "skipped";
  reason?: string | null;
  selectedActionNodeId?: string | null;
  selectedActionType?: ScenarioActionType | null;
  pathNodeIds?: string[];
  branchNodeIds?: string[];
};

export type ScenarioPreviewResult = {
  eventKind: ScenarioMessageIngressEventKind;
  evaluations: ScenarioPreviewEvaluation[];
  winner: ScenarioPreviewEvaluation | null;
};
