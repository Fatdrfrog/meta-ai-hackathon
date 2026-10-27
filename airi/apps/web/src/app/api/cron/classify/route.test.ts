import fs from "node:fs";
import path from "node:path";

const mockVerifyCronAuth = jest.fn();
const mockEnsureIndexes = jest.fn();
const mockConversationFind = jest.fn();
const mockAnalysisFind = jest.fn();
const mockBuildDueClassificationFilter = jest.fn();
const mockBuildExpiredClassificationFilter = jest.fn();
const mockBuildDueEffectsFilter = jest.fn();
const mockBuildExpiredEffectsFilter = jest.fn();
const mockReconcileStaleEffects = jest.fn();
const mockPublishWake = jest.fn();
const mockLoggerInfo = jest.fn();
const mockLegacyCapacity = jest.fn();
const mockLegacyBlock = jest.fn();
const mockLegacyClaim = jest.fn();
const mockLegacyExecute = jest.fn();

jest.mock("@/lib/cron-auth", () => ({
  verifyCronAuth: (...args: unknown[]) => mockVerifyCronAuth(...args),
}));
jest.mock("@/lib/mongo", () => ({
  ensureIndexes: (...args: unknown[]) => mockEnsureIndexes(...args),
}));
jest.mock("@/models/conversation", () => ({
  CONVERSATION_CLASSIFICATION_PENDING_INDEX_NAME:
    "conversations_classification_pending_due",
  CONVERSATION_CLASSIFICATION_EXPIRED_LEASE_INDEX_NAME:
    "conversations_classification_processing_lease_expired",
  Conversation: {
    find: (...args: unknown[]) => mockConversationFind(...args),
  },
}));
jest.mock("@/models/conversation-analysis-revision", () => ({
  ANALYSIS_REVISION_DUE_EFFECTS_INDEX_NAME:
    "conversation_analysis_revisions_effects_due",
  ANALYSIS_REVISION_EXPIRED_EFFECTS_LEASE_INDEX_NAME:
    "conversation_analysis_revisions_effects_processing_expired",
  ConversationAnalysisRevision: {
    find: (...args: unknown[]) => mockAnalysisFind(...args),
  },
}));
jest.mock("@/lib/classifier/conversation-classification-store", () => ({
  buildDueConversationClassificationsFilter: (...args: unknown[]) =>
    mockBuildDueClassificationFilter(...args),
  buildExpiredConversationClassificationsFilter: (...args: unknown[]) =>
    mockBuildExpiredClassificationFilter(...args),
  buildDueConversationAnalysisEffectsFilter: (...args: unknown[]) =>
    mockBuildDueEffectsFilter(...args),
  buildExpiredConversationAnalysisEffectsFilter: (...args: unknown[]) =>
    mockBuildExpiredEffectsFilter(...args),
  reconcileSupersededConversationAnalysisEffects: (...args: unknown[]) =>
    mockReconcileStaleEffects(...args),
  markConversationClassificationBlocked: (...args: unknown[]) =>
    mockLegacyBlock(...args),
  claimConversationClassification: (...args: unknown[]) =>
    mockLegacyClaim(...args),
}));
jest.mock("@/lib/classifier/conversation-classification-executor", () => ({
  executeConversationClassification: (...args: unknown[]) =>
    mockLegacyExecute(...args),
}));
jest.mock("@/lib/limits/company-limits", () => ({
  COMPANY_CLASSIFICATION_LIMIT_EXCEEDED_CODE:
    "company_classification_limit_exceeded",
  ensureCompanyClassificationCapacity: (...args: unknown[]) =>
    mockLegacyCapacity(...args),
}));
jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: { kind: "supabase-admin" },
}));
jest.mock("@/lib/classifier/classification-pubsub", () => ({
  publishConversationClassificationWake: (...args: unknown[]) =>
    mockPublishWake(...args),
}));
jest.mock("@/lib/app-version", () => ({
  getAppVersion: () => ({ version: "deploy-123", source: "test" }),
}));
jest.mock("@icecore/shared/lib/logger", () => ({
  createLogger: () => ({
    info: (...args: unknown[]) => mockLoggerInfo(...args),
  }),
}));

import { GET } from "./route";

const NOW = new Date("2026-08-10T06:00:00.000Z");
const ENABLE_ENV = "CONVERSATION_CLASSIFICATION_RECONCILIATION_ENABLED";
const ORIGINAL_ENABLE_ENV = process.env[ENABLE_ENV];

const CLASSIFICATION_SCAN_SELECT =
  "_id workspaceId classification_revision is_classified classification_meta.provenance_kind classification_meta.source_revision classification_meta.analysis_revision_id classification_state.contractVersion classification_state.status classification_state.requestedRevision classification_state.processingRevision classification_state.appliedRevision classification_state.generation classification_state.fence classification_state.requestedAt classification_state.nextAttemptAt classification_state.lease";
const EFFECTS_SCAN_SELECT =
  "_id conversationId sourceRevision completedAt effects.status effects.fence effects.nextAttemptAt effects.lease";
const EFFECTS_CURRENTNESS_SELECT =
  "is_classified classification_revision classification_state.contractVersion classification_state.status classification_state.requestedRevision classification_state.appliedRevision classification_meta.source_revision classification_meta.provenance_kind classification_meta.analysis_revision_id _id classification_state.generation classification_state.requestedAt";

type QueryDouble = ReturnType<typeof queryDouble>;

function queryDouble(rows: unknown[], failure?: Error) {
  const query = {
    select: jest.fn(),
    sort: jest.fn(),
    hint: jest.fn(),
    limit: jest.fn(),
    lean: jest.fn(),
  };
  query.select.mockReturnValue(query);
  query.sort.mockReturnValue(query);
  query.hint.mockReturnValue(query);
  query.limit.mockReturnValue(query);
  if (failure) query.lean.mockRejectedValue(failure);
  else query.lean.mockResolvedValue(rows);
  return query;
}

function arrangeScans(
  input: {
    classificationDue?: unknown[];
    classificationExpired?: unknown[];
    effectsDue?: unknown[];
    effectsExpired?: unknown[];
    effectConversations?: unknown[];
    dueFailure?: Error;
    currentnessFailure?: Error;
  } = {}
): {
  classificationDue: QueryDouble;
  classificationDueBlocked: QueryDouble;
  classificationExpired: QueryDouble;
  effectsDue: QueryDouble;
  effectsExpired: QueryDouble;
  effectConversations: QueryDouble | null;
} {
  // The route scans pending and blocked due rows separately; route each row by status.
  const isBlocked = (row: unknown) =>
    (row as { classification_state?: { status?: unknown } } | null)
      ?.classification_state?.status === "blocked";
  const due = input.classificationDue ?? [];
  const classificationDue = queryDouble(
    due.filter(row => !isBlocked(row)),
    input.dueFailure
  );
  const classificationDueBlocked = queryDouble(due.filter(isBlocked));
  const classificationExpired = queryDouble(input.classificationExpired ?? []);
  const effectsDue = queryDouble(input.effectsDue ?? []);
  const effectsExpired = queryDouble(input.effectsExpired ?? []);
  const hasEffects =
    (input.effectsDue?.length ?? 0) + (input.effectsExpired?.length ?? 0) > 0;
  const effectConversations = hasEffects
    ? queryDouble(input.effectConversations ?? [], input.currentnessFailure)
    : null;

  mockConversationFind.mockReset();
  mockConversationFind
    .mockReturnValueOnce(classificationDue)
    .mockReturnValueOnce(classificationDueBlocked)
    .mockReturnValueOnce(classificationExpired);
  if (effectConversations) {
    mockConversationFind.mockReturnValueOnce(effectConversations);
  }
  mockAnalysisFind.mockReset();
  mockAnalysisFind
    .mockReturnValueOnce(effectsDue)
    .mockReturnValueOnce(effectsExpired);

  return {
    classificationDue,
    classificationDueBlocked,
    classificationExpired,
    effectsDue,
    effectsExpired,
    effectConversations,
  };
}

function request() {
  return new Request("https://airi.chat/api/cron/classify", {
    headers: { authorization: "Bearer cron" },
  });
}

function classificationRow(input: {
  id: string;
  status?: "pending" | "blocked" | "processing";
  revision?: number;
  generation?: number;
  requestedAt?: Date;
  dueAt?: Date;
}) {
  const status = input.status ?? "pending";
  const revision = input.revision ?? 7;
  const requestedAt = input.requestedAt ?? new Date("2026-08-10T05:50:00.000Z");
  const dueAt = input.dueAt ?? new Date("2026-08-10T05:59:00.000Z");
  return {
    _id: input.id,
    workspaceId: `workspace-${input.id}`,
    classification_revision: revision,
    is_classified: false,
    classification_meta: null,
    classification_state: {
      contractVersion: 2,
      status,
      requestedRevision: revision,
      processingRevision: status === "processing" ? revision : null,
      appliedRevision: null,
      generation: input.generation ?? 3,
      fence: status === "processing" ? 4 : 0,
      requestedAt,
      nextAttemptAt: status === "processing" ? null : dueAt,
      lease:
        status === "processing"
          ? {
              ownerToken: `owner-${input.id}`,
              claimedAt: new Date("2026-08-10T05:40:00.000Z"),
              expiresAt: dueAt,
            }
          : null,
    },
  };
}

function malformedClassificationLifecycleRows(): Array<
  [string, "classificationDue" | "classificationExpired", unknown]
> {
  const pending = classificationRow({ id: "conversation-pending" });
  const blocked = classificationRow({
    id: "conversation-blocked",
    status: "blocked",
  });
  const processing = classificationRow({
    id: "conversation-processing",
    status: "processing",
  });
  const supersededProcessing = {
    ...processing,
    classification_state: {
      ...processing.classification_state,
      processingRevision: 6,
      nextAttemptAt: processing.classification_state.requestedAt,
    },
  };
  const inheritedState = Object.create(pending.classification_state);
  const inheritedLease = Object.create(processing.classification_state.lease);
  const incompleteState = { ...pending.classification_state } as Record<
    string,
    unknown
  >;
  delete incompleteState.appliedRevision;
  const incompleteLease = {
    ...processing.classification_state.lease,
  } as Record<string, unknown>;
  delete incompleteLease.claimedAt;

  return [
    [
      "classified pending row",
      "classificationDue",
      { ...pending, is_classified: true },
    ],
    [
      "classified blocked row",
      "classificationDue",
      { ...blocked, is_classified: true },
    ],
    [
      "classified processing row",
      "classificationExpired",
      { ...processing, is_classified: true },
    ],
    [
      "current processing retry date",
      "classificationExpired",
      {
        ...processing,
        classification_state: {
          ...processing.classification_state,
          nextAttemptAt: processing.classification_state.requestedAt,
        },
      },
    ],
    [
      "superseded processing wrong retry date",
      "classificationExpired",
      {
        ...supersededProcessing,
        classification_state: {
          ...supersededProcessing.classification_state,
          nextAttemptAt: new Date("2026-08-10T05:49:00.000Z"),
        },
      },
    ],
    [
      "inverted applied revision",
      "classificationDue",
      {
        ...pending,
        classification_state: {
          ...pending.classification_state,
          appliedRevision: 8,
        },
      },
    ],
    [
      "partial historical metadata",
      "classificationDue",
      {
        ...pending,
        classification_meta: {
          provenance_kind: "legacy_unknown",
          source_revision: 6,
          analysis_revision_id: null,
        },
      },
    ],
    [
      "inverted historical metadata",
      "classificationDue",
      {
        ...pending,
        classification_meta: {
          provenance_kind: "legacy_unknown",
          source_revision: 8,
          analysis_revision_id: "analysis-8",
        },
      },
    ],
    [
      "native provenance without identity",
      "classificationDue",
      {
        ...pending,
        classification_meta: {
          provenance_kind: "v2",
          source_revision: null,
          analysis_revision_id: null,
        },
      },
    ],
    [
      "unknown provenance",
      "classificationDue",
      {
        ...pending,
        classification_meta: {
          provenance_kind: "future",
          source_revision: 6,
          analysis_revision_id: "analysis-6",
        },
      },
    ],
    [
      "inherited state fields",
      "classificationDue",
      { ...pending, classification_state: inheritedState },
    ],
    [
      "incomplete state own fields",
      "classificationDue",
      { ...pending, classification_state: incompleteState },
    ],
    [
      "inherited lease fields",
      "classificationExpired",
      {
        ...processing,
        classification_state: {
          ...processing.classification_state,
          lease: inheritedLease,
        },
      },
    ],
    [
      "incomplete lease own fields",
      "classificationExpired",
      {
        ...processing,
        classification_state: {
          ...processing.classification_state,
          lease: incompleteLease,
        },
      },
    ],
    [
      "lease with extra fields",
      "classificationExpired",
      {
        ...processing,
        classification_state: {
          ...processing.classification_state,
          lease: {
            ...processing.classification_state.lease,
            extra: true,
          },
        },
      },
    ],
  ];
}

function currentConversation(input: {
  id: string;
  analysisRevisionId: string;
  revision?: number;
  generation?: number;
  requestedAt?: Date;
}) {
  const revision = input.revision ?? 7;
  return {
    _id: input.id,
    is_classified: true,
    classification_revision: revision,
    classification_meta: {
      provenance_kind: "v2",
      source_revision: revision,
      analysis_revision_id: input.analysisRevisionId,
    },
    classification_state: {
      contractVersion: 2,
      status: "ready",
      requestedRevision: revision,
      appliedRevision: revision,
      generation: input.generation ?? 3,
      requestedAt: input.requestedAt ?? new Date("2026-08-10T05:50:00.000Z"),
    },
  };
}

function dueEffect(input: {
  id: string;
  conversationId: string;
  status?: "pending" | "failed";
  sourceRevision?: number;
  dueAt?: Date;
  fence?: number;
}) {
  const status = input.status ?? "pending";
  return {
    _id: input.id,
    conversationId: input.conversationId,
    sourceRevision: input.sourceRevision ?? 7,
    completedAt: new Date("2026-08-10T05:45:00.000Z"),
    effects: {
      status,
      fence: input.fence ?? (status === "failed" ? 1 : 0),
      nextAttemptAt: input.dueAt ?? new Date("2026-08-10T05:58:00.000Z"),
      lease: null,
    },
  };
}

function expiredEffect(input: {
  id: string;
  conversationId: string;
  sourceRevision?: number;
  dueAt?: Date;
  fence?: number;
}) {
  const dueAt = input.dueAt ?? new Date("2026-08-10T05:57:00.000Z");
  return {
    _id: input.id,
    conversationId: input.conversationId,
    sourceRevision: input.sourceRevision ?? 7,
    completedAt: new Date("2026-08-10T05:45:00.000Z"),
    effects: {
      status: "processing",
      fence: input.fence ?? 2,
      nextAttemptAt: null,
      lease: {
        ownerToken: `effects-owner-${input.id}`,
        claimedAt: new Date("2026-08-10T05:40:00.000Z"),
        expiresAt: dueAt,
      },
    },
  };
}

function emptyWideCounts() {
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

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers().setSystemTime(NOW);
  delete process.env[ENABLE_ENV];
  mockVerifyCronAuth.mockReturnValue(null);
  mockEnsureIndexes.mockResolvedValue(undefined);
  mockBuildDueClassificationFilter.mockReturnValue({ dueClassification: true });
  mockBuildExpiredClassificationFilter.mockReturnValue({
    expiredClassification: true,
  });
  mockBuildDueEffectsFilter.mockReturnValue({ dueEffects: true });
  mockBuildExpiredEffectsFilter.mockReturnValue({ expiredEffects: true });
  mockReconcileStaleEffects.mockResolvedValue("superseded");
  mockLegacyCapacity.mockResolvedValue({ allowed: true });
  mockLegacyBlock.mockResolvedValue(true);
  mockLegacyClaim.mockResolvedValue(null);
  mockLegacyExecute.mockResolvedValue({ status: "stale" });
  mockPublishWake.mockImplementation(async input => ({
    status: "published_marked",
    eventId: `event:${input.conversationId}`,
    messageId: "message-1",
  }));
  arrangeScans();
});

afterEach(() => {
  jest.useRealTimers();
});

afterAll(() => {
  if (ORIGINAL_ENABLE_ENV === undefined) delete process.env[ENABLE_ENV];
  else process.env[ENABLE_ENV] = ORIGINAL_ENABLE_ENV;
});

describe("classification reconciliation cron", () => {
  it("authenticates before the enable gate, logging, Mongo, or publishing", async () => {
    process.env[ENABLE_ENV] = "true";
    const denied = new Response("denied", { status: 401 });
    mockVerifyCronAuth.mockReturnValue(denied);
    const incoming = request();

    const response = await GET(incoming);

    expect(response).toBe(denied);
    expect(mockVerifyCronAuth).toHaveBeenCalledWith(incoming);
    expect(mockEnsureIndexes).not.toHaveBeenCalled();
    expect(mockConversationFind).not.toHaveBeenCalled();
    expect(mockAnalysisFind).not.toHaveBeenCalled();
    expect(mockReconcileStaleEffects).not.toHaveBeenCalled();
    expect(mockPublishWake).not.toHaveBeenCalled();
    expect(mockLoggerInfo).not.toHaveBeenCalled();
  });

  it.each([undefined, "TRUE", " true ", "1"])(
    "fails closed when the exact reconciliation enable value is %p",
    async value => {
      if (value === undefined) delete process.env[ENABLE_ENV];
      else process.env[ENABLE_ENV] = value;

      const response = await GET(request());

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ status: "disabled" });
      expect(mockEnsureIndexes).not.toHaveBeenCalled();
      expect(mockConversationFind).not.toHaveBeenCalled();
      expect(mockAnalysisFind).not.toHaveBeenCalled();
      expect(mockReconcileStaleEffects).not.toHaveBeenCalled();
      expect(mockPublishWake).not.toHaveBeenCalled();
      expect(mockLoggerInfo).toHaveBeenCalledTimes(1);
      expect(mockLoggerInfo).toHaveBeenCalledWith(
        "cron.classify.reconciliation",
        expect.objectContaining({
          kind: "wide_event",
          request: "cron.classify.reconciliation",
          status: "disabled",
          outcome: "success",
          reconciliation_enabled: false,
          deployment_version: "deploy-123",
          deployment_version_source: "test",
          ...emptyWideCounts(),
        })
      );
    }
  );

  it("runs exactly five bounded, projected, hinted, sorted lean scans with one logical now", async () => {
    process.env[ENABLE_ENV] = "true";
    const queries = arrangeScans();

    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(mockEnsureIndexes).toHaveBeenCalledTimes(1);
    for (const filter of [
      mockBuildDueClassificationFilter,
      mockBuildExpiredClassificationFilter,
      mockBuildDueEffectsFilter,
      mockBuildExpiredEffectsFilter,
    ]) {
      expect(filter).toHaveBeenCalledTimes(1);
      expect(filter).toHaveBeenCalledWith(NOW);
    }
    expect(mockConversationFind).toHaveBeenNthCalledWith(1, {
      dueClassification: true,
      "classification_state.status": "pending",
    });
    expect(mockConversationFind).toHaveBeenNthCalledWith(2, {
      dueClassification: true,
      "classification_state.status": "blocked",
    });
    expect(mockConversationFind).toHaveBeenNthCalledWith(3, {
      expiredClassification: true,
    });
    expect(mockAnalysisFind).toHaveBeenNthCalledWith(1, { dueEffects: true });
    expect(mockAnalysisFind).toHaveBeenNthCalledWith(2, {
      expiredEffects: true,
    });

    for (const dueQuery of [
      queries.classificationDue,
      queries.classificationDueBlocked,
    ]) {
      expect(dueQuery.select).toHaveBeenCalledWith(CLASSIFICATION_SCAN_SELECT);
      expect(dueQuery.sort).toHaveBeenCalledWith({
        "classification_state.status": 1,
        "classification_state.nextAttemptAt": 1,
        "classification_state.requestedAt": 1,
        _id: 1,
      });
      expect(dueQuery.hint).toHaveBeenCalledWith(
        "conversations_classification_pending_due"
      );
    }
    expect(queries.classificationExpired.select).toHaveBeenCalledWith(
      CLASSIFICATION_SCAN_SELECT
    );
    expect(queries.classificationExpired.sort).toHaveBeenCalledWith({
      "classification_state.status": 1,
      "classification_state.lease.expiresAt": 1,
      _id: 1,
    });
    expect(queries.classificationExpired.hint).toHaveBeenCalledWith(
      "conversations_classification_processing_lease_expired"
    );
    expect(queries.effectsDue.select).toHaveBeenCalledWith(EFFECTS_SCAN_SELECT);
    expect(queries.effectsDue.sort).toHaveBeenCalledWith({
      "effects.status": 1,
      "effects.nextAttemptAt": 1,
      completedAt: 1,
      _id: 1,
    });
    expect(queries.effectsDue.hint).toHaveBeenCalledWith(
      "conversation_analysis_revisions_effects_due"
    );
    expect(queries.effectsExpired.select).toHaveBeenCalledWith(
      EFFECTS_SCAN_SELECT
    );
    expect(queries.effectsExpired.sort).toHaveBeenCalledWith({
      "effects.status": 1,
      "effects.lease.expiresAt": 1,
      completedAt: 1,
      _id: 1,
    });
    expect(queries.effectsExpired.hint).toHaveBeenCalledWith(
      "conversation_analysis_revisions_effects_processing_expired"
    );
    for (const query of [
      queries.classificationDue,
      queries.classificationDueBlocked,
      queries.classificationExpired,
      queries.effectsDue,
      queries.effectsExpired,
    ]) {
      expect(query.limit).toHaveBeenCalledWith(100);
      expect(query.lean).toHaveBeenCalledTimes(1);
    }
    expect(mockConversationFind).toHaveBeenCalledTimes(3);
    expect(mockPublishWake).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      status: "ok",
      uniqueCandidates: 0,
      attempted: 0,
      unattempted: 0,
    });
    expect(mockLoggerInfo).toHaveBeenCalledTimes(1);
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      "cron.classify.reconciliation",
      expect.objectContaining({
        outcome: "success",
        status: "ok",
        reconciliation_enabled: true,
        ...emptyWideCounts(),
      })
    );
  });

  it("batch-checks effects currentness and reconciles stale immutable analysis identities", async () => {
    process.env[ENABLE_ENV] = "true";
    const current = dueEffect({
      id: "analysis-current",
      conversationId: "conversation-current",
    });
    const staleSuperseded = dueEffect({
      id: "analysis-stale-superseded",
      conversationId: "conversation-stale",
      status: "failed",
      fence: 3,
    });
    const staleCurrent = dueEffect({
      id: "analysis-raced-current",
      conversationId: "conversation-raced-current",
    });
    const staleIdMismatch = dueEffect({
      id: "analysis-id-mismatch",
      conversationId: "conversation-id-mismatch",
    });
    const staleChanged = expiredEffect({
      id: "analysis-stale-changed",
      conversationId: "conversation-changed",
      fence: 4,
    });
    const staleMissing = expiredEffect({
      id: "analysis-stale-missing",
      conversationId: "conversation-missing",
      fence: 5,
    });
    const currentConversationRow = currentConversation({
      id: "conversation-current",
      analysisRevisionId: current._id,
    });
    const newerConversationRow = currentConversation({
      id: "conversation-stale",
      analysisRevisionId: staleSuperseded._id,
      revision: 8,
    });
    const idMismatchConversationRow = currentConversation({
      id: "conversation-id-mismatch",
      analysisRevisionId: "analysis-other",
      revision: 7,
    });
    const queries = arrangeScans({
      effectsDue: [current, staleSuperseded, staleIdMismatch, staleCurrent],
      effectsExpired: [staleChanged, staleMissing],
      effectConversations: [
        currentConversationRow,
        newerConversationRow,
        idMismatchConversationRow,
      ],
    });
    mockReconcileStaleEffects
      .mockResolvedValueOnce("superseded")
      .mockResolvedValueOnce("current")
      .mockResolvedValueOnce("changed")
      .mockResolvedValueOnce("missing")
      .mockResolvedValueOnce("superseded");

    const response = await GET(request());

    expect(mockConversationFind).toHaveBeenNthCalledWith(4, {
      _id: {
        $in: [
          "conversation-current",
          "conversation-stale",
          "conversation-id-mismatch",
          "conversation-raced-current",
          "conversation-changed",
          "conversation-missing",
        ],
      },
    });
    expect(queries.effectConversations?.select).toHaveBeenCalledWith(
      EFFECTS_CURRENTNESS_SELECT
    );
    expect(queries.effectConversations?.lean).toHaveBeenCalledTimes(1);
    expect(mockReconcileStaleEffects).toHaveBeenNthCalledWith(1, {
      analysisRevisionId: "analysis-stale-superseded",
      observed: {
        status: "failed",
        nextAttemptAt: new Date("2026-08-10T05:58:00.000Z"),
        fence: 3,
      },
      now: NOW,
    });
    expect(mockReconcileStaleEffects).toHaveBeenNthCalledWith(2, {
      analysisRevisionId: "analysis-id-mismatch",
      observed: {
        status: "pending",
        nextAttemptAt: new Date("2026-08-10T05:58:00.000Z"),
        fence: 0,
      },
      now: NOW,
    });
    expect(mockReconcileStaleEffects).toHaveBeenNthCalledWith(3, {
      analysisRevisionId: "analysis-raced-current",
      observed: {
        status: "pending",
        nextAttemptAt: new Date("2026-08-10T05:58:00.000Z"),
        fence: 0,
      },
      now: NOW,
    });
    expect(mockReconcileStaleEffects).toHaveBeenNthCalledWith(4, {
      analysisRevisionId: "analysis-stale-changed",
      observed: {
        status: "processing",
        expiresAt: new Date("2026-08-10T05:57:00.000Z"),
        fence: 4,
      },
      now: NOW,
    });
    expect(mockReconcileStaleEffects).toHaveBeenNthCalledWith(5, {
      analysisRevisionId: "analysis-stale-missing",
      observed: {
        status: "processing",
        expiresAt: new Date("2026-08-10T05:57:00.000Z"),
        fence: 5,
      },
      now: NOW,
    });
    expect(mockPublishWake).toHaveBeenCalledTimes(1);
    expect(mockPublishWake).toHaveBeenCalledWith({
      conversationId: "conversation-current",
      requestedRevision: 7,
      generation: 3,
      requestedAt: new Date("2026-08-10T05:50:00.000Z"),
      marker: {
        kind: "effects",
        analysisRevisionId: "analysis-current",
      },
    });
    await expect(response.json()).resolves.toMatchObject({
      status: "ok",
      staleEffects: {
        superseded: 2,
        current: 1,
        changed: 1,
        missing: 1,
      },
    });
    expect(mockLoggerInfo).toHaveBeenCalledTimes(1);
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      "cron.classify.reconciliation",
      expect.objectContaining({
        classification_due_found: 0,
        classification_due_oldest_age_ms: null,
        classification_lease_expired_found: 0,
        classification_lease_expired_oldest_age_ms: null,
        effects_due_found: 4,
        effects_due_oldest_age_ms: 120_000,
        effects_lease_expired_found: 2,
        effects_lease_expired_oldest_age_ms: 180_000,
        unique_candidates: 1,
        attempted: 1,
        transport_published: 1,
        cas_marked: 1,
        published_stale: 0,
        publish_failed: 0,
        published_marker_failed: 0,
        stale_effects_superseded: 2,
        stale_effects_current: 1,
        stale_effects_changed: 1,
        stale_effects_missing: 1,
        unattempted: 0,
      })
    );
  });

  it("orders globally, deduplicates event identities, and keeps the stronger effects marker", async () => {
    process.env[ENABLE_ENV] = "true";
    const conversationA = classificationRow({
      id: "conversation-a",
      dueAt: new Date("2026-08-10T05:59:00.000Z"),
    });
    const duplicateA = classificationRow({
      id: "conversation-a",
      status: "processing",
      dueAt: new Date("2026-08-10T05:55:00.000Z"),
    });
    const conversationB = classificationRow({
      id: "conversation-b",
      dueAt: new Date("2026-08-10T05:56:00.000Z"),
    });
    const conversationC = classificationRow({
      id: "conversation-c",
      dueAt: new Date("2026-08-10T05:56:00.000Z"),
    });
    const effectA = dueEffect({
      id: "analysis-a",
      conversationId: "conversation-a",
      dueAt: new Date("2026-08-10T05:57:00.000Z"),
    });
    const readyA = currentConversation({
      id: "conversation-a",
      analysisRevisionId: "analysis-a",
    });
    arrangeScans({
      classificationDue: [conversationC, conversationA, conversationB],
      classificationExpired: [duplicateA],
      effectsDue: [effectA],
      effectConversations: [readyA],
    });

    const response = await GET(request());

    expect(mockPublishWake).toHaveBeenCalledTimes(3);
    expect(
      mockPublishWake.mock.calls.map(([input]) => input.conversationId)
    ).toEqual(["conversation-a", "conversation-b", "conversation-c"]);
    expect(mockPublishWake).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        conversationId: "conversation-a",
        marker: { kind: "effects", analysisRevisionId: "analysis-a" },
      })
    );
    await expect(response.json()).resolves.toMatchObject({
      uniqueCandidates: 3,
      attempted: 3,
      unattempted: 0,
    });
    expect(mockLoggerInfo).toHaveBeenCalledTimes(1);
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      "cron.classify.reconciliation",
      expect.objectContaining({
        classification_due_found: 3,
        classification_due_oldest_age_ms: 240_000,
        classification_lease_expired_found: 1,
        classification_lease_expired_oldest_age_ms: 300_000,
        effects_due_found: 1,
        effects_due_oldest_age_ms: 180_000,
        effects_lease_expired_found: 0,
        effects_lease_expired_oldest_age_ms: null,
        unique_candidates: 3,
        attempted: 3,
        transport_published: 3,
        cas_marked: 3,
        unattempted: 0,
      })
    );
  });

  it("applies one global 200-publish bound after merging all scans", async () => {
    process.env[ENABLE_ENV] = "true";
    const due = Array.from({ length: 100 }, (_, index) =>
      classificationRow({
        id: `due-${String(index).padStart(3, "0")}`,
        dueAt: new Date(NOW.getTime() - 400_000 + index),
      })
    );
    const expired = Array.from({ length: 100 }, (_, index) =>
      classificationRow({
        id: `expired-${String(index).padStart(3, "0")}`,
        status: "processing",
        dueAt: new Date(NOW.getTime() - 200_000 + index),
      })
    );
    const effect = dueEffect({
      id: "analysis-over-bound",
      conversationId: "conversation-over-bound",
      dueAt: new Date(NOW.getTime() - 100_000),
    });
    arrangeScans({
      classificationDue: due,
      classificationExpired: expired,
      effectsDue: [effect],
      effectConversations: [
        currentConversation({
          id: "conversation-over-bound",
          analysisRevisionId: "analysis-over-bound",
        }),
      ],
    });

    const response = await GET(request());

    expect(mockPublishWake).toHaveBeenCalledTimes(200);
    await expect(response.json()).resolves.toMatchObject({
      uniqueCandidates: 201,
      attempted: 200,
      unattempted: 1,
    });
    expect(mockLoggerInfo).toHaveBeenCalledTimes(1);
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      "cron.classify.reconciliation",
      expect.objectContaining({
        unique_candidates: 201,
        attempted: 200,
        transport_published: 200,
        cas_marked: 200,
        unattempted: 1,
      })
    );
  });

  it("treats published-stale as a successful transport no-op", async () => {
    process.env[ENABLE_ENV] = "true";
    arrangeScans({
      classificationDue: [classificationRow({ id: "conversation-stale" })],
    });
    mockPublishWake.mockResolvedValue({
      status: "published_stale",
      eventId: "event-stale",
      messageId: "message-stale",
    });

    const response = await GET(request());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: "ok",
      attempted: 1,
      transportPublished: 1,
      casMarked: 0,
      publishedStale: 1,
      publishFailed: 0,
      publishedMarkerFailed: 0,
    });
  });

  it("limits publishing to ten concurrent calls and isolates every outcome", async () => {
    process.env[ENABLE_ENV] = "true";
    const candidates = Array.from({ length: 12 }, (_, index) =>
      classificationRow({
        id: `conversation-${String(index).padStart(2, "0")}`,
      })
    );
    arrangeScans({ classificationDue: candidates });
    let active = 0;
    let maximumActive = 0;
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    mockPublishWake.mockImplementation(async input => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await gate;
      active -= 1;
      if (input.conversationId === "conversation-00") {
        return {
          status: "publish_failed",
          eventId: "event-00",
          error: "TOP-SECRET transport",
        };
      }
      if (input.conversationId === "conversation-01") {
        return {
          status: "published_marker_failed",
          eventId: "event-01",
          messageId: "message-01",
          error: "TOP-SECRET marker",
        };
      }
      if (input.conversationId === "conversation-02") {
        return {
          status: "published_stale",
          eventId: "event-02",
          messageId: "message-02",
        };
      }
      if (input.conversationId === "conversation-03") {
        throw new Error("TOP-SECRET unexpected publisher throw");
      }
      return {
        status: "published_marked",
        eventId: `event-${input.conversationId}`,
        messageId: `message-${input.conversationId}`,
      };
    });

    const execution = GET(request());
    for (
      let flush = 0;
      flush < 20 && mockPublishWake.mock.calls.length < 10;
      flush += 1
    ) {
      await Promise.resolve();
    }
    expect(mockPublishWake).toHaveBeenCalledTimes(10);
    expect(maximumActive).toBe(10);
    release();
    const response = await execution;

    expect(mockPublishWake).toHaveBeenCalledTimes(12);
    expect(maximumActive).toBe(10);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: "partial",
      attempted: 12,
      transportPublished: 10,
      casMarked: 8,
      publishedStale: 1,
      publishFailed: 2,
      publishedMarkerFailed: 1,
    });
    expect(mockLoggerInfo).toHaveBeenCalledTimes(1);
    const serializedLog = JSON.stringify(mockLoggerInfo.mock.calls[0]);
    expect(serializedLog).not.toContain("TOP-SECRET");
  });

  it("accepts canonical historical scheduled and superseded-processing identities", async () => {
    process.env[ENABLE_ENV] = "true";
    const historical = classificationRow({ id: "conversation-historical" });
    const superseded = classificationRow({
      id: "conversation-superseded",
      status: "processing",
    });
    arrangeScans({
      classificationDue: [
        {
          ...historical,
          classification_meta: {
            provenance_kind: "legacy_unknown",
            source_revision: 6,
            analysis_revision_id: "analysis-historical",
          },
          classification_state: {
            ...historical.classification_state,
            appliedRevision: 6,
          },
        },
      ],
      classificationExpired: [
        {
          ...superseded,
          classification_state: {
            ...superseded.classification_state,
            processingRevision: 6,
            nextAttemptAt: superseded.classification_state.requestedAt,
          },
        },
      ],
    });

    const response = await GET(request());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: "ok",
      attempted: 2,
    });
    expect(mockPublishWake).toHaveBeenCalledTimes(2);
    expect(mockPublishWake.mock.calls.map(([input]) => input)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          conversationId: "conversation-historical",
          marker: { kind: "classification" },
        }),
        expect.objectContaining({
          conversationId: "conversation-superseded",
          marker: { kind: "classification" },
        }),
      ])
    );
  });

  it.each(malformedClassificationLifecycleRows())(
    "fails closed on a %s",
    async (_name, scan, row) => {
      process.env[ENABLE_ENV] = "true";
      arrangeScans({ [scan]: [row] });

      const response = await GET(request());

      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({
        status: "error",
        message: "Classification reconciliation failed",
      });
      expect(mockPublishWake).not.toHaveBeenCalled();
      expect(mockLoggerInfo).toHaveBeenCalledTimes(1);
      expect(mockLoggerInfo).toHaveBeenCalledWith(
        "cron.classify.reconciliation",
        expect.objectContaining({
          status: "error",
          outcome: "error",
          error: { category: "reconciliation_failed" },
        })
      );
    }
  );

  it.each([
    "index initialization",
    "scan",
    "effects currentness batch",
    "stale effects cleanup",
    "malformed scanned state",
    "primitive scan identity",
  ])("returns one sanitized 500 wide event for a %s failure", async failure => {
    process.env[ENABLE_ENV] = "true";
    const secret = new Error(`TOP-SECRET ${failure}`);
    if (failure === "index initialization") {
      mockEnsureIndexes.mockRejectedValue(secret);
    } else if (failure === "scan") {
      arrangeScans({ dueFailure: secret });
    } else if (failure === "effects currentness batch") {
      arrangeScans({
        effectsDue: [
          dueEffect({ id: "analysis-1", conversationId: "conversation-1" }),
        ],
        currentnessFailure: secret,
      });
    } else if (failure === "stale effects cleanup") {
      arrangeScans({
        effectsDue: [
          dueEffect({ id: "analysis-1", conversationId: "conversation-1" }),
        ],
      });
      mockReconcileStaleEffects.mockRejectedValue(secret);
    } else if (failure === "malformed scanned state") {
      arrangeScans({
        classificationDue: [
          {
            ...classificationRow({ id: "conversation-malformed" }),
            classification_state: {
              ...classificationRow({ id: "conversation-malformed" })
                .classification_state,
              requestedAt: null,
            },
          },
        ],
      });
    } else {
      arrangeScans({
        classificationDue: [
          {
            ...classificationRow({ id: "conversation-primitive-id" }),
            _id: 42,
          },
        ],
      });
    }

    const response = await GET(request());

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      status: "error",
      message: "Classification reconciliation failed",
    });
    expect(mockPublishWake).not.toHaveBeenCalled();
    expect(mockLoggerInfo).toHaveBeenCalledTimes(1);
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      "cron.classify.reconciliation",
      expect.objectContaining({
        status: "error",
        outcome: "error",
        error: { category: "reconciliation_failed" },
      })
    );
    expect(JSON.stringify(mockLoggerInfo.mock.calls[0])).not.toContain(
      "TOP-SECRET"
    );
  });

  it("retains only the reconciliation route surface and removes forbidden inline owners", () => {
    const routeDirectory = path.join(
      process.cwd(),
      "src/app/api/cron/classify"
    );
    expect(fs.readdirSync(routeDirectory).sort()).toEqual([
      "route.test.ts",
      "route.ts",
    ]);
    expect(
      fs.existsSync(
        path.join(
          process.cwd(),
          "scripts/reclassify-workspace-conversations.ts"
        )
      )
    ).toBe(false);

    const routeSource = fs.readFileSync(
      path.join(routeDirectory, "route.ts"),
      "utf8"
    );
    for (const forbidden of [
      "conversation-classification-executor",
      "conversation-classification-effects",
      "claimConversationClassification",
      "markConversationClassificationBlocked",
      "ensureCompanyClassificationCapacity",
      "company-limits",
      "supabase",
      "conversation-classification-media",
      'from "@/lib/ai"',
      "VertexAI",
      "OpenAI",
      'from "p-limit"',
      "CLASSIFIABLE_CONVERSATION_FILTER",
      "CONVERSATION_CLASSIFICATION_QUEUE_LEGACY_INDEX_NAME",
      "is_classification_queued",
      "setTimeout",
      'from "./consts"',
    ]) {
      expect(routeSource).not.toContain(forbidden);
    }

    const importedRetiredCronOwners: string[] = [];
    const visit = (directory: string) => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory()) visit(entryPath);
        else if (
          /\.[cm]?[jt]sx?$/u.test(entry.name) &&
          entryPath !== __filename
        ) {
          const source = fs.readFileSync(entryPath, "utf8");
          if (
            /(?:from\s*|import\s*\()["'][^"']*(?:cron\/classify\/(?:consts|active-learning)|\.\/(?:consts|active-learning))["']/u.test(
              source
            )
          ) {
            importedRetiredCronOwners.push(entryPath);
          }
        }
      }
    };
    for (const root of ["src", "scripts"]) {
      visit(path.join(process.cwd(), root));
    }
    expect(importedRetiredCronOwners).toEqual([]);
  });
});
