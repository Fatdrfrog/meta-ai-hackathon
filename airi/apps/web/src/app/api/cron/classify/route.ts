import { getAppVersion } from "@/lib/app-version";
import {
  publishConversationClassificationWake,
  type ConversationClassificationWakeMarker,
  type ConversationClassificationWakeRequest,
} from "@/lib/classifier/classification-pubsub";
import {
  buildDueConversationAnalysisEffectsFilter,
  buildDueConversationClassificationsFilter,
  buildExpiredConversationAnalysisEffectsFilter,
  buildExpiredConversationClassificationsFilter,
  reconcileSupersededConversationAnalysisEffects,
  type ObservedDueEffectsIdentity,
} from "@/lib/classifier/conversation-classification-store";
import { verifyCronAuth } from "@/lib/cron-auth";
import { ensureIndexes } from "@/lib/mongo";
import {
  ANALYSIS_REVISION_DUE_EFFECTS_INDEX_NAME,
  ANALYSIS_REVISION_EXPIRED_EFFECTS_LEASE_INDEX_NAME,
  ConversationAnalysisRevision,
} from "@/models/conversation-analysis-revision";
import {
  CONVERSATION_CLASSIFICATION_EXPIRED_LEASE_INDEX_NAME,
  CONVERSATION_CLASSIFICATION_PENDING_INDEX_NAME,
  Conversation,
} from "@/models/conversation";
import {
  CONVERSATION_CLASSIFICATION_PROVENANCE_KINDS,
  CONVERSATION_CLASSIFICATION_FRESHNESS_SELECT,
  CONVERSATION_CLASSIFICATION_STATE_CONTRACT_VERSION,
  hasCurrentConversationClassification,
} from "@icecore/shared/lib/conversation-classification-freshness";
import { createLogger } from "@icecore/shared/lib/logger";
import { buildConversationClassificationWakeEventId } from "@icecore/temporal";
import { NextResponse } from "next/server";
import { isPlainRecord } from "@icecore/shared/lib/value-utils";

const cronClassifyLog = createLogger("cron-classify");

const RECONCILIATION_SCAN_LIMIT_PER_INDEX = 100;
const RECONCILIATION_MAX_PUBLISHES = 200;
const RECONCILIATION_PUBLISH_CONCURRENCY = 10;

// Leases are projected whole: a sub-path projection such as `lease.expiresAt`
// drops a stored `lease: null`, which the strict row validation rejects.
const CLASSIFICATION_SCAN_SELECT =
  "_id workspaceId classification_revision is_classified classification_meta.provenance_kind classification_meta.source_revision classification_meta.analysis_revision_id classification_state.contractVersion classification_state.status classification_state.requestedRevision classification_state.processingRevision classification_state.appliedRevision classification_state.generation classification_state.fence classification_state.requestedAt classification_state.nextAttemptAt classification_state.lease";
const EFFECTS_SCAN_SELECT =
  "_id conversationId sourceRevision completedAt effects.status effects.fence effects.nextAttemptAt effects.lease";
const EFFECTS_CURRENTNESS_SELECT = `${CONVERSATION_CLASSIFICATION_FRESHNESS_SELECT} _id classification_state.generation classification_state.requestedAt`;

const CLASSIFICATION_STATE_PROJECTED_FIELDS = [
  "contractVersion",
  "status",
  "requestedRevision",
  "processingRevision",
  "appliedRevision",
  "generation",
  "fence",
  "requestedAt",
  "nextAttemptAt",
  "lease",
] as const;
const CLASSIFICATION_LEASE_FIELDS = [
  "ownerToken",
  "claimedAt",
  "expiresAt",
] as const;

const CLASSIFICATION_DUE_SORT = {
  "classification_state.status": 1,
  "classification_state.nextAttemptAt": 1,
  "classification_state.requestedAt": 1,
  _id: 1,
} as const;
const CLASSIFICATION_EXPIRED_SORT = {
  "classification_state.status": 1,
  "classification_state.lease.expiresAt": 1,
  _id: 1,
} as const;
const EFFECTS_DUE_SORT = {
  "effects.status": 1,
  "effects.nextAttemptAt": 1,
  completedAt: 1,
  _id: 1,
} as const;
const EFFECTS_EXPIRED_SORT = {
  "effects.status": 1,
  "effects.lease.expiresAt": 1,
  completedAt: 1,
  _id: 1,
} as const;

type ReconciliationCandidateSource =
  | "classification_due"
  | "classification_lease_expired"
  | "effects_due"
  | "effects_lease_expired";

type ReconciliationWakeCandidate = {
  source: ReconciliationCandidateSource;
  dueAt: Date;
  request: ConversationClassificationWakeRequest;
  marker: ConversationClassificationWakeMarker;
};

type ScannedEffect = {
  source: Extract<
    ReconciliationCandidateSource,
    "effects_due" | "effects_lease_expired"
  >;
  analysisRevisionId: string;
  conversationId: string;
  sourceRevision: number;
  dueAt: Date;
  observed: ObservedDueEffectsIdentity;
};

type ReconciliationMetrics = {
  classification_due_found: number;
  classification_due_oldest_age_ms: number | null;
  classification_lease_expired_found: number;
  classification_lease_expired_oldest_age_ms: number | null;
  effects_due_found: number;
  effects_due_oldest_age_ms: number | null;
  effects_lease_expired_found: number;
  effects_lease_expired_oldest_age_ms: number | null;
  unique_candidates: number;
  attempted: number;
  transport_published: number;
  cas_marked: number;
  published_stale: number;
  publish_failed: number;
  published_marker_failed: number;
  stale_effects_superseded: number;
  stale_effects_current: number;
  stale_effects_changed: number;
  stale_effects_missing: number;
  unattempted: number;
};

function emptyMetrics(): ReconciliationMetrics {
  return {
    classification_due_found: 0,
    classification_due_oldest_age_ms: null,
    classification_lease_expired_found: 0,
    classification_lease_expired_oldest_age_ms: null,
    effects_due_found: 0,
    effects_due_oldest_age_ms: null,
    effects_lease_expired_found: 0,
    effects_lease_expired_oldest_age_ms: null,
    unique_candidates: 0,
    attempted: 0,
    transport_published: 0,
    cas_marked: 0,
    published_stale: 0,
    publish_failed: 0,
    published_marker_failed: 0,
    stale_effects_superseded: 0,
    stale_effects_current: 0,
    stale_effects_changed: 0,
    stale_effects_missing: 0,
    unattempted: 0,
  };
}

function requiredRecord(
  value: unknown,
  label: string
): Record<string, unknown> {
  if (!isPlainRecord(value)) throw new Error(`${label} is invalid`);
  return value;
}

function hasOwnFields(
  value: Record<string, unknown>,
  fields: readonly string[]
): boolean {
  return fields.every(field => Object.hasOwn(value, field));
}

function hasExactFields(
  value: Record<string, unknown>,
  fields: readonly string[]
): boolean {
  const keys = Object.keys(value);
  return keys.length === fields.length && hasOwnFields(value, fields);
}

function requiredIdentifier(value: unknown, label: string): string {
  let identifier: string;
  if (typeof value === "string") {
    identifier = value;
  } else if (value !== null && typeof value === "object") {
    const objectIdLike = value as { toHexString?: unknown };
    if (typeof objectIdLike.toHexString !== "function") {
      throw new Error(`${label} is invalid`);
    }
    try {
      identifier = objectIdLike.toHexString.call(value);
    } catch {
      throw new Error(`${label} is invalid`);
    }
  } else {
    throw new Error(`${label} is invalid`);
  }
  if (
    typeof identifier !== "string" ||
    identifier.length === 0 ||
    identifier !== identifier.trim() ||
    (typeof value !== "string" && !/^[a-f\d]{24}$/i.test(identifier))
  ) {
    throw new Error(`${label} is invalid`);
  }
  return identifier;
}

function requiredText(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim()
  ) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function positiveSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`${label} is invalid`);
  }
  return value as number;
}

function nonnegativeSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${label} is invalid`);
  }
  return value as number;
}

function requiredDate(value: unknown, label: string): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function requireDue(date: Date, now: Date, label: string): Date {
  if (date.getTime() > now.getTime()) throw new Error(`${label} is not due`);
  return date;
}

function validateLease(
  value: unknown,
  now: Date,
  label: string
): { expiresAt: Date } {
  const lease = requiredRecord(value, label);
  if (!hasExactFields(lease, CLASSIFICATION_LEASE_FIELDS)) {
    throw new Error(`${label} fields are invalid`);
  }
  requiredText(lease.ownerToken, `${label} owner`);
  const claimedAt = requiredDate(lease.claimedAt, `${label} claimedAt`);
  const expiresAt = requireDue(
    requiredDate(lease.expiresAt, `${label} expiresAt`),
    now,
    `${label} expiresAt`
  );
  if (claimedAt.getTime() > expiresAt.getTime()) {
    throw new Error(`${label} ordering is invalid`);
  }
  return { expiresAt };
}

function validateClassificationMetadata(
  value: unknown,
  classificationRevision: number
): void {
  if (value === null || value === undefined) return;
  const meta = requiredRecord(value, "Classification metadata");
  const sourceRevision = meta.source_revision ?? null;
  const analysisRevisionId = meta.analysis_revision_id ?? null;
  const provenanceKind = meta.provenance_kind ?? null;
  if (
    (sourceRevision !== null &&
      (!Number.isSafeInteger(sourceRevision) ||
        (sourceRevision as number) < 1 ||
        (sourceRevision as number) > classificationRevision)) ||
    (analysisRevisionId !== null &&
      (typeof analysisRevisionId !== "string" ||
        analysisRevisionId.length === 0 ||
        analysisRevisionId !== analysisRevisionId.trim())) ||
    (provenanceKind !== null &&
      !(
        CONVERSATION_CLASSIFICATION_PROVENANCE_KINDS as readonly unknown[]
      ).includes(provenanceKind)) ||
    (sourceRevision === null) !== (analysisRevisionId === null) ||
    (provenanceKind === "v2" && sourceRevision === null)
  ) {
    throw new Error("Classification metadata is invalid");
  }
}

function classificationCandidate(
  value: unknown,
  source: Extract<
    ReconciliationCandidateSource,
    "classification_due" | "classification_lease_expired"
  >,
  now: Date
): ReconciliationWakeCandidate {
  const row = requiredRecord(value, "Classification scan row");
  const state = requiredRecord(
    row.classification_state,
    "Classification scan state"
  );
  if (!hasOwnFields(state, CLASSIFICATION_STATE_PROJECTED_FIELDS)) {
    throw new Error("Classification scan state is incomplete");
  }
  const conversationId = requiredIdentifier(row._id, "Conversation id");
  requiredText(row.workspaceId, "Classification workspace id");
  const revision = positiveSafeInteger(
    row.classification_revision,
    "Classification revision"
  );
  if (
    state.contractVersion !==
      CONVERSATION_CLASSIFICATION_STATE_CONTRACT_VERSION ||
    state.requestedRevision !== revision ||
    row.is_classified !== false
  ) {
    throw new Error("Classification scan identity is invalid");
  }
  const generation = positiveSafeInteger(
    state.generation,
    "Classification generation"
  );
  const requestedAt = requiredDate(
    state.requestedAt,
    "Classification requestedAt"
  );
  const appliedRevision = state.appliedRevision;
  if (
    appliedRevision !== null &&
    (!Number.isSafeInteger(appliedRevision) ||
      (appliedRevision as number) < 1 ||
      (appliedRevision as number) > revision)
  ) {
    throw new Error("Classification applied revision is invalid");
  }
  validateClassificationMetadata(row.classification_meta, revision);
  const fence = nonnegativeSafeInteger(state.fence, "Classification fence");
  let dueAt: Date;

  if (source === "classification_due") {
    if (
      (state.status !== "pending" && state.status !== "blocked") ||
      state.processingRevision !== null ||
      state.lease !== null
    ) {
      throw new Error("Due classification scan state is invalid");
    }
    dueAt = requireDue(
      requiredDate(state.nextAttemptAt, "Classification nextAttemptAt"),
      now,
      "Classification nextAttemptAt"
    );
  } else {
    if (state.status !== "processing" || fence < 1) {
      throw new Error("Expired classification scan state is invalid");
    }
    const processingRevision = positiveSafeInteger(
      state.processingRevision,
      "Classification processing revision"
    );
    if (processingRevision > revision) {
      throw new Error("Classification processing revision is inverted");
    }
    if (processingRevision === revision) {
      if (state.nextAttemptAt !== null) {
        throw new Error("Current classification retry time is invalid");
      }
    } else {
      const nextAttemptAt = requiredDate(
        state.nextAttemptAt,
        "Superseded classification nextAttemptAt"
      );
      if (nextAttemptAt.getTime() !== requestedAt.getTime()) {
        throw new Error("Superseded classification retry time is invalid");
      }
    }
    dueAt = validateLease(state.lease, now, "Classification lease").expiresAt;
  }

  return {
    source,
    dueAt,
    request: {
      conversationId,
      requestedRevision: revision,
      generation,
      requestedAt,
    },
    marker: { kind: "classification" },
  };
}

function scannedEffect(
  value: unknown,
  source: Extract<
    ReconciliationCandidateSource,
    "effects_due" | "effects_lease_expired"
  >,
  now: Date
): ScannedEffect {
  const row = requiredRecord(value, "Effects scan row");
  const effects = requiredRecord(row.effects, "Effects scan state");
  const analysisRevisionId = requiredIdentifier(
    row._id,
    "Analysis revision id"
  );
  const conversationId = requiredIdentifier(
    row.conversationId,
    "Effects conversation id"
  );
  const sourceRevision = positiveSafeInteger(
    row.sourceRevision,
    "Effects source revision"
  );
  requiredDate(row.completedAt, "Analysis completedAt");
  const fence = nonnegativeSafeInteger(effects.fence, "Effects fence");

  let dueAt: Date;
  let observed: ObservedDueEffectsIdentity;
  if (source === "effects_due") {
    if (
      (effects.status !== "pending" && effects.status !== "failed") ||
      effects.lease !== null ||
      (effects.status === "failed" && fence < 1)
    ) {
      throw new Error("Due effects scan state is invalid");
    }
    dueAt = requireDue(
      requiredDate(effects.nextAttemptAt, "Effects nextAttemptAt"),
      now,
      "Effects nextAttemptAt"
    );
    observed = { status: effects.status, nextAttemptAt: dueAt, fence };
  } else {
    if (
      effects.status !== "processing" ||
      effects.nextAttemptAt !== null ||
      fence < 1
    ) {
      throw new Error("Expired effects scan state is invalid");
    }
    dueAt = validateLease(effects.lease, now, "Effects lease").expiresAt;
    observed = { status: "processing", expiresAt: dueAt, fence };
  }

  return {
    source,
    analysisRevisionId,
    conversationId,
    sourceRevision,
    dueAt,
    observed,
  };
}

function oldestAge(now: Date, dueDates: Date[]): number | null {
  if (dueDates.length === 0) return null;
  const oldest = Math.min(...dueDates.map(date => date.getTime()));
  return Math.max(0, now.getTime() - oldest);
}

async function scanReconciliationRows(now: Date) {
  const dueFilter = buildDueConversationClassificationsFilter(now);
  // Blocked rows recheck every few minutes and sort before pending ones, so one
  // shared limit let them crowd the pending backlog out of every run.
  const dueClassificationScan = (status: "pending" | "blocked") =>
    Conversation.find({ ...dueFilter, "classification_state.status": status })
      .select(CLASSIFICATION_SCAN_SELECT)
      .sort(CLASSIFICATION_DUE_SORT)
      .hint(CONVERSATION_CLASSIFICATION_PENDING_INDEX_NAME)
      .limit(RECONCILIATION_SCAN_LIMIT_PER_INDEX)
      .lean();
  const [
    pendingDueRows,
    blockedDueRows,
    classificationExpiredRows,
    effectsDueRows,
    effectsExpiredRows,
  ] = await Promise.all([
    dueClassificationScan("pending"),
    dueClassificationScan("blocked"),
    Conversation.find(buildExpiredConversationClassificationsFilter(now))
      .select(CLASSIFICATION_SCAN_SELECT)
      .sort(CLASSIFICATION_EXPIRED_SORT)
      .hint(CONVERSATION_CLASSIFICATION_EXPIRED_LEASE_INDEX_NAME)
      .limit(RECONCILIATION_SCAN_LIMIT_PER_INDEX)
      .lean(),
    ConversationAnalysisRevision.find(
      buildDueConversationAnalysisEffectsFilter(now)
    )
      .select(EFFECTS_SCAN_SELECT)
      .sort(EFFECTS_DUE_SORT)
      .hint(ANALYSIS_REVISION_DUE_EFFECTS_INDEX_NAME)
      .limit(RECONCILIATION_SCAN_LIMIT_PER_INDEX)
      .lean(),
    ConversationAnalysisRevision.find(
      buildExpiredConversationAnalysisEffectsFilter(now)
    )
      .select(EFFECTS_SCAN_SELECT)
      .sort(EFFECTS_EXPIRED_SORT)
      .hint(ANALYSIS_REVISION_EXPIRED_EFFECTS_LEASE_INDEX_NAME)
      .limit(RECONCILIATION_SCAN_LIMIT_PER_INDEX)
      .lean(),
  ]);

  return {
    classificationDueRows: [...pendingDueRows, ...blockedDueRows] as unknown[],
    classificationExpiredRows: classificationExpiredRows as unknown[],
    effectsDueRows: effectsDueRows as unknown[],
    effectsExpiredRows: effectsExpiredRows as unknown[],
  };
}

function currentEffectsCandidate(
  effect: ScannedEffect,
  conversation: unknown
): ReconciliationWakeCandidate | null {
  if (!hasCurrentConversationClassification(conversation)) return null;
  const row = requiredRecord(conversation, "Effects currentness row");
  const revision = positiveSafeInteger(
    row.classification_revision,
    "Effects current revision"
  );
  const meta = requiredRecord(
    row.classification_meta,
    "Effects current metadata"
  );
  if (
    revision !== effect.sourceRevision ||
    meta.analysis_revision_id !== effect.analysisRevisionId
  ) {
    return null;
  }
  const state = requiredRecord(
    row.classification_state,
    "Effects current classification state"
  );
  return {
    source: effect.source,
    dueAt: effect.dueAt,
    request: {
      conversationId: effect.conversationId,
      requestedRevision: revision,
      generation: positiveSafeInteger(
        state.generation,
        "Effects current generation"
      ),
      requestedAt: requiredDate(
        state.requestedAt,
        "Effects current requestedAt"
      ),
    },
    marker: {
      kind: "effects",
      analysisRevisionId: effect.analysisRevisionId,
    },
  };
}

async function buildEffectsCandidates(input: {
  effects: ScannedEffect[];
  now: Date;
  metrics: ReconciliationMetrics;
}): Promise<ReconciliationWakeCandidate[]> {
  if (input.effects.length === 0) return [];
  const conversationIds = [
    ...new Set(input.effects.map(effect => effect.conversationId)),
  ];
  const conversations = (await Conversation.find({
    _id: { $in: conversationIds },
  })
    .select(EFFECTS_CURRENTNESS_SELECT)
    .lean()) as unknown[];
  const byId = new Map<string, unknown>();
  for (const conversation of conversations) {
    const row = requiredRecord(conversation, "Effects currentness row");
    const id = requiredIdentifier(row._id, "Effects currentness id");
    if (byId.has(id)) throw new Error("Effects currentness id is duplicated");
    byId.set(id, conversation);
  }

  const candidates: ReconciliationWakeCandidate[] = [];
  for (const effect of input.effects) {
    const current = currentEffectsCandidate(
      effect,
      byId.get(effect.conversationId)
    );
    if (current) {
      candidates.push(current);
      continue;
    }
    const outcome = await reconcileSupersededConversationAnalysisEffects({
      analysisRevisionId: effect.analysisRevisionId,
      observed: effect.observed,
      now: input.now,
    });
    switch (outcome) {
      case "superseded":
        input.metrics.stale_effects_superseded += 1;
        break;
      case "current":
        input.metrics.stale_effects_current += 1;
        break;
      case "changed":
        input.metrics.stale_effects_changed += 1;
        break;
      case "missing":
        input.metrics.stale_effects_missing += 1;
        break;
      default: {
        const exhaustive: never = outcome;
        throw new Error(`Unknown stale effects outcome: ${String(exhaustive)}`);
      }
    }
  }
  return candidates;
}

function deduplicateCandidates(
  candidates: ReconciliationWakeCandidate[]
): ReconciliationWakeCandidate[] {
  const ordered = candidates
    .map(candidate => ({
      ...candidate,
      eventId: buildConversationClassificationWakeEventId(candidate.request),
    }))
    .sort((left, right) => {
      const dueDifference = left.dueAt.getTime() - right.dueAt.getTime();
      if (dueDifference) return dueDifference;
      const eventDifference = left.eventId.localeCompare(right.eventId);
      if (eventDifference) return eventDifference;
      return left.source.localeCompare(right.source);
    });
  const byEventId = new Map<
    string,
    ReconciliationWakeCandidate & { eventId: string }
  >();
  for (const candidate of ordered) {
    const existing = byEventId.get(candidate.eventId);
    if (!existing) {
      byEventId.set(candidate.eventId, candidate);
    } else if (
      existing.marker.kind === "classification" &&
      candidate.marker.kind === "effects"
    ) {
      existing.marker = candidate.marker;
    }
  }
  return [...byEventId.values()].map(
    ({ eventId: _eventId, ...candidate }) => candidate
  );
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>
): Promise<R[]> {
  if (values.length === 0) return [];
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (true) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= values.length) return;
        results[index] = await mapper(values[index]);
      }
    }
  );
  await Promise.all(workers);
  return results;
}

type PublishResult =
  | "published_marked"
  | "published_stale"
  | "publish_failed"
  | "published_marker_failed";

async function publishCandidate(
  candidate: ReconciliationWakeCandidate
): Promise<PublishResult> {
  try {
    const outcome = await publishConversationClassificationWake({
      ...candidate.request,
      marker: candidate.marker,
    });
    switch (outcome.status) {
      case "published_marked":
      case "published_stale":
      case "publish_failed":
      case "published_marker_failed":
        return outcome.status;
      default:
        return "publish_failed";
    }
  } catch {
    return "publish_failed";
  }
}

function responseBody(
  status: "ok" | "partial",
  metrics: ReconciliationMetrics
) {
  return {
    status,
    uniqueCandidates: metrics.unique_candidates,
    attempted: metrics.attempted,
    transportPublished: metrics.transport_published,
    casMarked: metrics.cas_marked,
    publishedStale: metrics.published_stale,
    publishFailed: metrics.publish_failed,
    publishedMarkerFailed: metrics.published_marker_failed,
    staleEffects: {
      superseded: metrics.stale_effects_superseded,
      current: metrics.stale_effects_current,
      changed: metrics.stale_effects_changed,
      missing: metrics.stale_effects_missing,
    },
    unattempted: metrics.unattempted,
  };
}

export async function GET(request: Request) {
  const denied = verifyCronAuth(request);
  if (denied) return denied;

  const startedAt = Date.now();
  const now = new Date(startedAt);
  const appVersion = getAppVersion();
  const metrics = emptyMetrics();
  const wide: Record<string, unknown> = {
    kind: "wide_event",
    request: "cron.classify.reconciliation",
    started_at: now.toISOString(),
    deployment_version: appVersion.version,
    deployment_version_source: appVersion.source,
    reconciliation_enabled: false,
    scan_limit_per_index: RECONCILIATION_SCAN_LIMIT_PER_INDEX,
    max_publishes: RECONCILIATION_MAX_PUBLISHES,
    publish_concurrency: RECONCILIATION_PUBLISH_CONCURRENCY,
    status: "disabled",
    outcome: "success",
    ...metrics,
  };

  try {
    if (
      process.env.CONVERSATION_CLASSIFICATION_RECONCILIATION_ENABLED !== "true"
    ) {
      return NextResponse.json({ status: "disabled" });
    }
    wide.reconciliation_enabled = true;

    await ensureIndexes();
    const rows = await scanReconciliationRows(now);
    const classificationDue = rows.classificationDueRows.map(row =>
      classificationCandidate(row, "classification_due", now)
    );
    const classificationExpired = rows.classificationExpiredRows.map(row =>
      classificationCandidate(row, "classification_lease_expired", now)
    );
    const effectsDue = rows.effectsDueRows.map(row =>
      scannedEffect(row, "effects_due", now)
    );
    const effectsExpired = rows.effectsExpiredRows.map(row =>
      scannedEffect(row, "effects_lease_expired", now)
    );

    metrics.classification_due_found = classificationDue.length;
    metrics.classification_due_oldest_age_ms = oldestAge(
      now,
      classificationDue.map(candidate => candidate.dueAt)
    );
    metrics.classification_lease_expired_found = classificationExpired.length;
    metrics.classification_lease_expired_oldest_age_ms = oldestAge(
      now,
      classificationExpired.map(candidate => candidate.dueAt)
    );
    metrics.effects_due_found = effectsDue.length;
    metrics.effects_due_oldest_age_ms = oldestAge(
      now,
      effectsDue.map(effect => effect.dueAt)
    );
    metrics.effects_lease_expired_found = effectsExpired.length;
    metrics.effects_lease_expired_oldest_age_ms = oldestAge(
      now,
      effectsExpired.map(effect => effect.dueAt)
    );

    const effectsCandidates = await buildEffectsCandidates({
      effects: [...effectsDue, ...effectsExpired],
      now,
      metrics,
    });
    const candidates = deduplicateCandidates([
      ...classificationDue,
      ...classificationExpired,
      ...effectsCandidates,
    ]);
    metrics.unique_candidates = candidates.length;
    const selected = candidates.slice(0, RECONCILIATION_MAX_PUBLISHES);
    metrics.attempted = selected.length;
    metrics.unattempted = candidates.length - selected.length;

    const publishResults = await mapWithConcurrency(
      selected,
      RECONCILIATION_PUBLISH_CONCURRENCY,
      publishCandidate
    );
    for (const result of publishResults) {
      switch (result) {
        case "published_marked":
          metrics.transport_published += 1;
          metrics.cas_marked += 1;
          break;
        case "published_stale":
          metrics.transport_published += 1;
          metrics.published_stale += 1;
          break;
        case "published_marker_failed":
          metrics.transport_published += 1;
          metrics.published_marker_failed += 1;
          break;
        case "publish_failed":
          metrics.publish_failed += 1;
          break;
      }
    }

    const status =
      metrics.publish_failed > 0 || metrics.published_marker_failed > 0
        ? "partial"
        : "ok";
    wide.status = status;
    wide.outcome = status === "partial" ? "partial" : "success";
    return NextResponse.json(responseBody(status, metrics));
  } catch {
    wide.status = "error";
    wide.outcome = "error";
    wide.error = { category: "reconciliation_failed" };
    return NextResponse.json(
      { status: "error", message: "Classification reconciliation failed" },
      { status: 500 }
    );
  } finally {
    Object.assign(wide, metrics);
    wide.duration_ms = Date.now() - startedAt;
    cronClassifyLog.info("cron.classify.reconciliation", wide);
  }
}
