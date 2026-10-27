import mongoose from "mongoose";
import type { ConversationClassificationEffectInputs } from "@/models/conversation-analysis-revision";
import { buildClassificationInputPendingTransitionPipeline } from "./classification-contract";
import {
  CONVERSATION_ANALYSIS_EFFECT_STEPS,
  CONVERSATION_CLASSIFICATION_MEDIA_RECHECK_MS,
  authorizeConversationAnalysisEffectStep,
  buildConversationClassificationClaimFilter,
  buildConversationClassificationClaimPipeline,
  buildConversationClassificationLeaseFilter,
  buildDueConversationClassificationsFilter,
  buildExpiredConversationClassificationsFilter,
  buildStaleConversationClassificationLeaseFilter,
  claimConversationAnalysisEffects,
  commitConversationClassificationReady,
  ConversationClassificationCasError,
  deferClaimedConversationClassification,
  getConversationAnalysisEffectsRetryAt,
  getConversationClassificationFailureDecision,
  markConversationClassificationEnqueued,
  markConversationClassificationBlocked,
  readConversationClassificationWakeState,
  reconcileSupersededConversationAnalysisEffects,
  recoverExpiredSupersededConversationClassificationLease,
  renewConversationAnalysisEffectsLease,
} from "./conversation-classification-store";

type EffectsRow = {
  _id: string;
  conversationId: mongoose.Types.ObjectId;
  workspaceId: string;
  sourceRevision: number;
  completedAt: Date;
  outcome: "ready" | "review_required";
  projection: Record<string, unknown> | null;
  effectInputs: ConversationClassificationEffectInputs | null;
  effects: {
    status:
      | "pending"
      | "processing"
      | "completed"
      | "failed"
      | "superseded"
      | "not_applicable";
    attemptCount: number;
    fence: number;
    nextAttemptAt: Date | null;
    completedAt: Date | null;
    lease: {
      ownerToken: string;
      claimedAt: Date;
      expiresAt: Date;
    } | null;
    checklist: Record<
      (typeof CONVERSATION_ANALYSIS_EFFECT_STEPS)[number],
      Date | null
    >;
  };
};

function queryResult<T>(value: T) {
  return {
    lean: jest.fn(() => ({ exec: jest.fn(async () => value) })),
  };
}

function sessionQueryResult<T>(value: T) {
  return {
    session: jest.fn(() => queryResult(value)),
  };
}

function primaryQueryResult<T>(value: T) {
  const exec = jest.fn(async () => value);
  const lean = jest.fn(() => ({ exec }));
  const read = jest.fn(() => ({ lean }));
  return { query: { read }, read, lean, exec };
}

describe("conversation classification state store contract", () => {
  const now = new Date("2026-08-10T06:00:00.000Z");
  const expiresAt = new Date("2026-08-10T06:10:00.000Z");
  const conversationId = new mongoose.Types.ObjectId();

  const effectInputs = {
    companyId: "company-1",
    source: { id: "source-1", type: "whatsapp" },
    predictedCategoryConfidence: 0.9,
    processingTimeMs: 1_250,
    provider: "vertex",
    model: "gemini-2.5-flash",
    ragSummary: null,
  };

  const completedChecklist = Object.fromEntries(
    CONVERSATION_ANALYSIS_EFFECT_STEPS.map(step => [step, now])
  ) as EffectsRow["effects"]["checklist"];
  const emptyChecklist = Object.fromEntries(
    CONVERSATION_ANALYSIS_EFFECT_STEPS.map(step => [step, null])
  ) as EffectsRow["effects"]["checklist"];

  function effectsRow(
    overrides: Omit<Partial<EffectsRow>, "effects"> & {
      effects?: Partial<EffectsRow["effects"]>;
    } = {}
  ): EffectsRow {
    return {
      _id: `${conversationId}:7`,
      conversationId,
      workspaceId: "workspace-1",
      sourceRevision: 7,
      completedAt: new Date("2026-08-10T05:59:00.000Z"),
      outcome: "ready",
      projection: {
        classification: {
          category: "Support",
          priority: "medium",
          sentiment: "neutral",
          summary: "Customer needs help.",
          confidence: { category: 0.8 },
        },
      },
      effectInputs,
      ...overrides,
      effects: {
        status: "pending",
        attemptCount: 0,
        fence: 0,
        nextAttemptAt: now,
        completedAt: null,
        lease: null,
        checklist: { ...emptyChecklist },
        ...overrides.effects,
      },
    };
  }

  function claimDependencies(input: {
    observed: Array<EffectsRow | null>;
    claimed?: Array<EffectsRow | null>;
    barrierMatches?: number[];
  }) {
    const sessions = input.observed.map(() => ({
      withTransaction: jest.fn(async (operation: () => Promise<void>) => {
        await operation();
      }),
      endSession: jest.fn(async () => undefined),
    }));
    const findById = jest.fn();
    for (const row of input.observed) {
      findById.mockReturnValueOnce(sessionQueryResult(row));
    }
    const findOneAndUpdate = jest.fn();
    for (const row of input.claimed ?? []) {
      findOneAndUpdate.mockReturnValueOnce(queryResult(row));
    }
    const analysisRevisionModel = {
      findById,
      findOneAndUpdate,
      updateOne: jest.fn().mockResolvedValue({ matchedCount: 1 }),
    };
    const conversationModel = {
      startSession: jest.fn().mockImplementation(async () => sessions.shift()),
      updateOne: jest.fn().mockImplementation(async () => ({
        matchedCount: input.barrierMatches?.shift() ?? 1,
      })),
    };
    return {
      deps: {
        now: () => now,
        createOwnerToken: () => "new-effects-owner",
        conversationModel: conversationModel as never,
        analysisRevisionModel: analysisRevisionModel as never,
      },
      analysisRevisionModel,
      conversationModel,
    };
  }

  function reconciliationDependencies(input: {
    row: EffectsRow | null;
    barrierMatches?: number;
    updateMatches?: number;
  }) {
    const session = {
      withTransaction: jest.fn(async (operation: () => Promise<void>) => {
        await operation();
      }),
      endSession: jest.fn(async () => undefined),
    };
    const analysisUpdateOne = jest
      .fn()
      .mockResolvedValue({ matchedCount: input.updateMatches ?? 1 });
    const analysisRevisionModel = {
      findById: jest.fn(() => sessionQueryResult(input.row)),
      updateOne: analysisUpdateOne,
    };
    const conversationUpdateOne = jest
      .fn()
      .mockResolvedValue({ matchedCount: input.barrierMatches ?? 0 });
    const conversationModel = {
      startSession: jest.fn(async () => session),
      updateOne: conversationUpdateOne,
    };
    return {
      deps: {
        now: () => now,
        conversationModel: conversationModel as never,
        analysisRevisionModel: analysisRevisionModel as never,
      },
      analysisUpdateOne,
      conversationUpdateOne,
    };
  }

  it("exports exactly the five ordered completion effect steps", () => {
    expect(CONVERSATION_ANALYSIS_EFFECT_STEPS).toEqual([
      "summary",
      "analytics",
      "realtime",
      "usage",
      "webhook",
    ]);
  });

  it.each(["activeLearning", "customerStage"])(
    "rejects removed runtime effect step %s before model I/O",
    async step => {
      const startSession = jest.fn();
      await expect(
        authorizeConversationAnalysisEffectStep(
          {
            lease: {
              analysisRevisionId: `${conversationId}:7`,
              conversationId,
              sourceRevision: 7,
              ownerToken: "effects-owner",
              fence: 1,
              expiresAt,
              attemptCount: 1,
            },
            step: step as never,
          },
          {
            conversationModel: { startSession } as never,
          }
        )
      ).rejects.toThrow(`Unknown analysis effect step ${step}`);
      expect(startSession).not.toHaveBeenCalled();
    }
  );

  it.each([
    [
      "classifier-owned internal labels",
      {
        projection: {
          classification: { category: "Support" },
          internal_labels: ["inferred"],
        },
        effectInputs,
      },
      /internal_labels/,
    ],
    [
      "invalid effect inputs",
      {
        projection: { classification: { category: "Support" } },
        effectInputs: {
          ...effectInputs,
          predictedCategoryConfidence: "0.9",
        },
      },
      /effect input/i,
    ],
  ])(
    "rejects %s before opening a transaction",
    async (_name, proposal, error) => {
      const startSession = jest.fn();
      await expect(
        commitConversationClassificationReady(
          {
            lease: {
              conversationId,
              revision: 7,
              ownerToken: "owner-7",
              fence: 11,
              expiresAt,
            },
            workspaceId: "workspace-1",
            provenance: {
              taxonomyId: "taxonomy-1",
              taxonomyDigest: "digest-1",
              classifierVersion: "classifier-1",
              classifierContractRevision: 2,
            },
            ...proposal,
          } as never,
          {
            conversationModel: { startSession } as never,
          }
        )
      ).rejects.toThrow(error);
      expect(startSession).not.toHaveBeenCalled();
    }
  );

  it("builds one complete semantic-input transition owned by contract v2", () => {
    const pipeline = buildClassificationInputPendingTransitionPipeline({
      now,
      hasInboundInput: true,
    });

    expect(pipeline).toHaveLength(3);
    expect(pipeline[1]).toMatchObject({
      $set: {
        classification_revision: "$__classification_next_revision",
        is_classified: false,
        is_qa_analyzed: false,
        classification_error: null,
        classification_state: {
          contractVersion: 2,
          requestedRevision: "$__classification_next_revision",
          attemptRevision: "$__classification_next_revision",
          attemptCount: 0,
          requestedAt: now,
          lastEnqueuedAt: null,
          completedAt: null,
          error: null,
          review: null,
          blocked: null,
        },
      },
    });
    expect(pipeline[2]).toEqual({
      $unset: [
        "__classification_next_revision",
        "__classification_has_inbound",
        "__classification_live_processing",
      ],
    });
  });

  it("accepts only safe integer revisions, BSON inbound dates, and valid live leases", () => {
    const pipeline = buildClassificationInputPendingTransitionPipeline({ now });
    const firstSet = (pipeline[0] as { $set: Record<string, unknown> }).$set;
    const serialized = JSON.stringify(firstSet);

    expect(serialized).toContain("$trunc");
    expect(serialized).toContain(String(Number.MAX_SAFE_INTEGER));
    expect(serialized).toContain('"$type":"$last_inbound_at"');
    expect(serialized).toContain(
      '"$isNumber":"$classification_state.processingRevision"'
    );
    expect(serialized).toContain('"__classification_has_inbound"');
  });

  it("uses the complete live lease identity for ordinary worker mutations", () => {
    expect(
      buildConversationClassificationLeaseFilter({
        conversationId,
        revision: 7,
        ownerToken: "owner-7",
        fence: 11,
        expiresAt,
        now,
      })
    ).toEqual({
      _id: conversationId,
      classification_revision: 7,
      "classification_state.contractVersion": 2,
      "classification_state.requestedRevision": 7,
      "classification_state.processingRevision": 7,
      "classification_state.status": "processing",
      "classification_state.lease.ownerToken": "owner-7",
      "classification_state.fence": 11,
      "classification_state.lease.expiresAt": {
        $eq: expiresAt,
        $gt: now,
      },
    });
  });

  it("lets stale release target only its processing lease after a newer request", () => {
    const filter = buildStaleConversationClassificationLeaseFilter({
      conversationId,
      revision: 7,
      ownerToken: "owner-7",
      fence: 11,
      expiresAt,
      now,
    });

    expect(filter).toEqual({
      _id: conversationId,
      "classification_state.contractVersion": 2,
      "classification_state.processingRevision": 7,
      "classification_state.status": "processing",
      "classification_state.lease.ownerToken": "owner-7",
      "classification_state.fence": 11,
      "classification_state.lease.expiresAt": {
        $eq: expiresAt,
        $gt: now,
      },
    });
    expect(filter).not.toHaveProperty("classification_revision");
    expect(filter).not.toHaveProperty("classification_state.requestedRevision");
  });

  it.each([
    [1, "pending", "2026-08-10T06:01:00.000Z"],
    [2, "pending", "2026-08-10T06:05:00.000Z"],
    [3, "pending", "2026-08-10T06:20:00.000Z"],
    [4, "failed", null],
  ] as const)(
    "uses the bounded classification retry decision for attempt %s",
    (attemptCount, status, expectedAt) => {
      const decision = getConversationClassificationFailureDecision({
        attemptCount,
        retryable: true,
        now,
      });

      expect(decision.status).toBe(status);
      expect(decision.nextAttemptAt?.toISOString() ?? null).toBe(expectedAt);
    }
  );

  it("makes a non-retryable classification error terminal immediately", () => {
    expect(
      getConversationClassificationFailureDecision({
        attemptCount: 1,
        retryable: false,
        now,
      })
    ).toEqual({ status: "failed", nextAttemptAt: null });
  });

  it("builds separate indexable due-pending and expired-processing selectors", () => {
    expect(buildDueConversationClassificationsFilter(now)).toEqual({
      "classification_state.contractVersion": 2,
      "classification_state.status": { $in: ["pending", "blocked"] },
      "classification_state.nextAttemptAt": { $lte: now },
      $expr: {
        $eq: [
          "$classification_state.requestedRevision",
          "$classification_revision",
        ],
      },
    });
    expect(buildExpiredConversationClassificationsFilter(now)).toEqual({
      "classification_state.contractVersion": 2,
      "classification_state.status": "processing",
      "classification_state.lease.expiresAt": { $lte: now },
      $expr: {
        $eq: [
          "$classification_state.requestedRevision",
          "$classification_revision",
        ],
      },
    });
  });

  it("reads an exact pending wake state from the primary without manufacturing a fence", async () => {
    const requestedAt = new Date("2026-08-10T05:59:00.000Z");
    const dueAt = new Date("2026-08-10T06:05:00.000Z");
    const result = primaryQueryResult({
      _id: conversationId,
      workspaceId: "workspace-1",
      classification_revision: 7,
      is_classified: false,
      classification_state: {
        contractVersion: 2,
        status: "pending",
        requestedRevision: 7,
        processingRevision: null,
        appliedRevision: null,
        generation: 3,
        fence: 0,
        requestedAt,
        nextAttemptAt: dueAt,
        lease: null,
      },
    });
    const findById = jest.fn(() => result.query);

    await expect(
      readConversationClassificationWakeState(conversationId, {
        conversationModel: { findById } as never,
      })
    ).resolves.toEqual({
      conversationId: String(conversationId),
      workspaceId: "workspace-1",
      classificationRevision: 7,
      isClassified: false,
      classificationMeta: null,
      state: {
        contractVersion: 2,
        status: "pending",
        requestedRevision: 7,
        processingRevision: null,
        appliedRevision: null,
        generation: 3,
        fence: 0,
        requestedAt,
        nextAttemptAt: dueAt,
        lease: null,
      },
    });
    expect(result.read).toHaveBeenCalledWith("primary");
    expect(findById).toHaveBeenCalledWith(
      conversationId,
      expect.objectContaining({
        _id: 1,
        workspaceId: 1,
        classification_revision: 1,
        is_classified: 1,
        "classification_state.fence": 1,
        "classification_state.lease": 1,
      })
    );
  });

  it("preserves the complete expired superseded processing identity in a strict wake read", async () => {
    const requestedAt = new Date("2026-08-10T05:59:00.000Z");
    const claimedAt = new Date("2026-08-10T05:40:00.000Z");
    const leaseExpiresAt = new Date("2026-08-10T05:50:00.000Z");
    const result = primaryQueryResult({
      _id: conversationId,
      workspaceId: "workspace-1",
      classification_revision: 7,
      is_classified: false,
      classification_meta: {
        source_revision: 6,
        analysis_revision_id: `${conversationId}:6`,
      },
      classification_state: {
        contractVersion: 2,
        status: "processing",
        requestedRevision: 7,
        processingRevision: 6,
        appliedRevision: 6,
        generation: 3,
        fence: 4,
        requestedAt,
        nextAttemptAt: requestedAt,
        lease: {
          ownerToken: "old-owner",
          claimedAt,
          expiresAt: leaseExpiresAt,
        },
      },
    });

    await expect(
      readConversationClassificationWakeState(conversationId, {
        conversationModel: {
          findById: jest.fn(() => result.query),
        } as never,
      })
    ).resolves.toEqual(
      expect.objectContaining({
        classificationMeta: {
          sourceRevision: 6,
          analysisRevisionId: `${conversationId}:6`,
        },
        state: expect.objectContaining({
          processingRevision: 6,
          fence: 4,
          lease: {
            ownerToken: "old-owner",
            claimedAt,
            expiresAt: leaseExpiresAt,
          },
        }),
      })
    );
  });

  it("accepts the due next-attempt timestamp left by a live superseded processing mutation", async () => {
    const requestedAt = new Date("2026-08-10T06:00:00.000Z");
    const claimedAt = new Date("2026-08-10T05:50:00.000Z");
    const leaseExpiresAt = new Date("2026-08-10T06:10:00.000Z");
    const result = primaryQueryResult({
      _id: conversationId,
      workspaceId: "workspace-1",
      classification_revision: 8,
      is_classified: false,
      classification_state: {
        contractVersion: 2,
        status: "processing",
        requestedRevision: 8,
        processingRevision: 7,
        appliedRevision: 7,
        generation: 4,
        fence: 5,
        requestedAt,
        nextAttemptAt: requestedAt,
        lease: {
          ownerToken: "superseded-owner",
          claimedAt,
          expiresAt: leaseExpiresAt,
        },
      },
    });

    await expect(
      readConversationClassificationWakeState(conversationId, {
        conversationModel: {
          findById: jest.fn(() => result.query),
        } as never,
      })
    ).resolves.toMatchObject({
      classificationRevision: 8,
      isClassified: false,
      state: {
        status: "processing",
        requestedRevision: 8,
        processingRevision: 7,
        nextAttemptAt: requestedAt,
        fence: 5,
        lease: {
          ownerToken: "superseded-owner",
          claimedAt,
          expiresAt: leaseExpiresAt,
        },
      },
    });
  });

  it.each(["legacy_unknown", null] as const)(
    "preserves a paired historical analysis identity on a non-ready %s-provenance row",
    async provenanceKind => {
      const result = primaryQueryResult({
        _id: conversationId,
        workspaceId: "workspace-1",
        classification_revision: 7,
        is_classified: false,
        classification_meta: {
          provenance_kind: provenanceKind,
          source_revision: 6,
          analysis_revision_id: `${conversationId}:6`,
        },
        classification_state: {
          contractVersion: 2,
          status: "review_required",
          requestedRevision: 7,
          processingRevision: null,
          appliedRevision: 6,
          generation: 3,
          fence: 4,
          requestedAt: now,
          nextAttemptAt: null,
          lease: null,
        },
      });

      await expect(
        readConversationClassificationWakeState(conversationId, {
          conversationModel: {
            findById: jest.fn(() => result.query),
          } as never,
        })
      ).resolves.toMatchObject({
        isClassified: false,
        classificationMeta: {
          sourceRevision: 6,
          analysisRevisionId: `${conversationId}:6`,
        },
        state: {
          status: "review_required",
          appliedRevision: 6,
          processingRevision: null,
          nextAttemptAt: null,
          lease: null,
        },
      });
    }
  );

  it("rejects native-v2 provenance without its paired historical identity on a non-ready row", async () => {
    const result = primaryQueryResult({
      _id: conversationId,
      workspaceId: "workspace-1",
      classification_revision: 7,
      is_classified: false,
      classification_meta: {
        provenance_kind: "v2",
        source_revision: null,
        analysis_revision_id: null,
      },
      classification_state: {
        contractVersion: 2,
        status: "pending",
        requestedRevision: 7,
        processingRevision: null,
        appliedRevision: null,
        generation: 3,
        fence: 0,
        requestedAt: now,
        nextAttemptAt: now,
        lease: null,
      },
    });

    await expect(
      readConversationClassificationWakeState(conversationId, {
        conversationModel: {
          findById: jest.fn(() => result.query),
        } as never,
      })
    ).rejects.toThrow(/classification wake state invariant/i);
  });

  it.each([
    ["ready without the classified flag", { is_classified: false }],
    [
      "ready without native-v2 provenance",
      { "classification_meta.provenance_kind": "legacy_unknown" },
    ],
    [
      "ready with a stale analysis source revision",
      { "classification_meta.source_revision": 6 },
    ],
    [
      "ready with a blank analysis revision ID",
      { "classification_meta.analysis_revision_id": " " },
    ],
  ])("rejects malformed current-ready wake state: %s", async (_name, override) => {
    const row: Record<string, unknown> = {
      _id: conversationId,
      workspaceId: "workspace-1",
      classification_revision: 7,
      is_classified: true,
      classification_meta: {
        provenance_kind: "v2",
        source_revision: 7,
        analysis_revision_id: `${conversationId}:7`,
      },
      classification_state: {
        contractVersion: 2,
        status: "ready",
        requestedRevision: 7,
        processingRevision: null,
        appliedRevision: 7,
        generation: 3,
        fence: 4,
        requestedAt: now,
        nextAttemptAt: null,
        lease: null,
      },
    };
    for (const [path, value] of Object.entries(override)) {
      const [owner, key] = path.split(".");
      if (key) {
        (row[owner] as Record<string, unknown>)[key] = value;
      } else {
        row[path] = value;
      }
    }
    const result = primaryQueryResult(row);

    await expect(
      readConversationClassificationWakeState(conversationId, {
        conversationModel: {
          findById: jest.fn(() => result.query),
        } as never,
      })
    ).rejects.toThrow(/classification wake state invariant/i);
  });

  it("returns null only for a cleanly missing conversation", async () => {
    const result = primaryQueryResult(null);
    await expect(
      readConversationClassificationWakeState(conversationId, {
        conversationModel: {
          findById: jest.fn(() => result.query),
        } as never,
      })
    ).resolves.toBeNull();
  });

  it.each([
    ["blank workspace", { workspaceId: " " }],
    ["mismatched requested revision", { requestedRevision: 8 }],
    ["inverted processing revision", { processingRevision: 8 }],
    ["zero processing fence", { fence: 0 }],
    [
      "inverted processing lease dates",
      {
        lease: {
          ownerToken: "owner-7",
          claimedAt: new Date("2026-08-10T06:10:01.000Z"),
          expiresAt: new Date("2026-08-10T06:10:00.000Z"),
        },
      },
    ],
  ])("rejects malformed wake state: %s", async (_name, override) => {
    const { workspaceId: workspaceOverride, ...stateOverride } = override as {
      workspaceId?: unknown;
    } & Record<string, unknown>;
    const result = primaryQueryResult({
      _id: conversationId,
      workspaceId: "workspace-1",
      classification_revision: 7,
      is_classified: false,
      classification_state: {
        contractVersion: 2,
        status: "processing",
        requestedRevision: 7,
        processingRevision: 6,
        appliedRevision: null,
        generation: 3,
        fence: 4,
        requestedAt: now,
        nextAttemptAt: now,
        lease: {
          ownerToken: "owner-7",
          claimedAt: new Date("2026-08-10T05:50:00.000Z"),
          expiresAt: new Date("2026-08-10T06:00:00.000Z"),
        },
        ...stateOverride,
      },
      ...(workspaceOverride !== undefined
        ? { workspaceId: workspaceOverride }
        : {}),
    });

    await expect(
      readConversationClassificationWakeState(conversationId, {
        conversationModel: {
          findById: jest.fn(() => result.query),
        } as never,
      })
    ).rejects.toThrow(/classification wake state invariant/i);
  });

  it("recovers only the exact expired superseded classification owner", async () => {
    const expiredAt = new Date("2026-08-10T05:59:00.000Z");
    const updateOne = jest.fn().mockResolvedValue({ matchedCount: 1 });

    await expect(
      recoverExpiredSupersededConversationClassificationLease(
        {
          observed: {
            conversationId,
            requestedRevision: 7,
            generation: 3,
            processingRevision: 6,
            ownerToken: "expired-owner",
            fence: 4,
            expiresAt: expiredAt,
          },
          recoveredAt: now,
        },
        { conversationModel: { updateOne } as never }
      )
    ).resolves.toBe("recovered");

    expect(updateOne).toHaveBeenCalledWith(
      {
        _id: conversationId,
        classification_revision: 7,
        "classification_state.contractVersion": 2,
        "classification_state.status": "processing",
        "classification_state.requestedRevision": 7,
        "classification_state.processingRevision": 6,
        "classification_state.generation": 3,
        "classification_state.fence": 4,
        "classification_state.lease.ownerToken": "expired-owner",
        "classification_state.lease.expiresAt": {
          $eq: expiredAt,
          $lte: now,
        },
      },
      {
        $set: {
          "classification_state.status": "pending",
          "classification_state.processingRevision": null,
          "classification_state.nextAttemptAt": now,
          "classification_state.lease": null,
          is_classified: false,
          is_qa_analyzed: false,
        },
      },
      { timestamps: false }
    );
    const serialized = JSON.stringify(updateOne.mock.calls[0]?.[1]);
    for (const preserved of [
      "requestedRevision",
      "generation",
      "attemptRevision",
      "attemptCount",
      "appliedRevision",
      "classification_meta",
      '"classification":',
      '"fence"',
    ]) {
      expect(serialized).not.toContain(preserved);
    }
  });

  it.each([
    [
      "current owner",
      { processingRevision: 7 },
      new Date("2026-08-10T05:59:00.000Z"),
      "not_superseded",
    ],
    ["live old owner", {}, expiresAt, "not_expired"],
  ] as const)(
    "classifies an exact %s without model I/O",
    async (_name, override, observedExpiry, expected) => {
      const updateOne = jest.fn();
      await expect(
        recoverExpiredSupersededConversationClassificationLease(
          {
            observed: {
              conversationId,
              requestedRevision: 7,
              generation: 3,
              processingRevision: 6,
              ownerToken: "owner-7",
              fence: 4,
              expiresAt: observedExpiry,
              ...override,
            },
            recoveredAt: now,
          },
          { conversationModel: { updateOne } as never }
        )
      ).resolves.toBe(expected);
      expect(updateOne).not.toHaveBeenCalled();
    }
  );

  it("returns changed when the exact expired recovery CAS loses", async () => {
    const updateOne = jest.fn().mockResolvedValue({ matchedCount: 0 });
    await expect(
      recoverExpiredSupersededConversationClassificationLease(
        {
          observed: {
            conversationId,
            requestedRevision: 7,
            generation: 3,
            processingRevision: 6,
            ownerToken: "owner-7",
            fence: 4,
            expiresAt: new Date("2026-08-10T05:59:00.000Z"),
          },
          recoveredAt: now,
        },
        { conversationModel: { updateOne } as never }
      )
    ).resolves.toBe("changed");
  });

  it.each([
    ["inverted revisions", { processingRevision: 8 }],
    ["zero processing revision", { processingRevision: 0 }],
    ["blank owner", { ownerToken: " " }],
    ["zero fence", { fence: 0 }],
    ["invalid expiry", { expiresAt: new Date("invalid") }],
  ])("rejects malformed recovery identity: %s", async (_name, override) => {
    const updateOne = jest.fn();
    await expect(
      recoverExpiredSupersededConversationClassificationLease(
        {
          observed: {
            conversationId,
            requestedRevision: 7,
            generation: 3,
            processingRevision: 6,
            ownerToken: "owner-7",
            fence: 4,
            expiresAt: new Date("2026-08-10T05:59:00.000Z"),
            ...override,
          },
          recoveredAt: now,
        },
        { conversationModel: { updateOne } as never }
      )
    ).rejects.toThrow(/superseded classification lease observation/i);
    expect(updateOne).not.toHaveBeenCalled();
  });

  it.each([
    [
      "classification",
      { kind: "classification" } as const,
      expect.objectContaining({
        "classification_state.status": {
          $in: ["pending", "blocked", "processing"],
        },
      }),
    ],
    [
      "effects",
      { kind: "effects", analysisRevisionId: `${conversationId}:7` } as const,
      expect.objectContaining({
        is_classified: true,
        "classification_state.status": "ready",
        "classification_state.appliedRevision": 7,
        "classification_meta.source_revision": 7,
        "classification_meta.provenance_kind": "v2",
        "classification_meta.analysis_revision_id": `${conversationId}:7`,
        $expr: expect.objectContaining({ $and: expect.any(Array) }),
      }),
    ],
  ])("marks only an exact current %s wake", async (_name, marker, filter) => {
    const enqueuedAt = new Date("2026-08-10T06:00:01.000Z");
    const updateOne = jest.fn().mockResolvedValue({ matchedCount: 1 });
    await expect(
      markConversationClassificationEnqueued(
        {
          conversationId,
          revision: 7,
          generation: 3,
          marker,
          enqueuedAt,
        },
        { conversationModel: { updateOne } as never }
      )
    ).resolves.toBe(true);
    expect(updateOne).toHaveBeenCalledWith(
      filter,
      { $set: { "classification_state.lastEnqueuedAt": enqueuedAt } },
      { timestamps: false }
    );
  });

  it("rejects a malformed effects marker before model I/O", async () => {
    const updateOne = jest.fn();
    await expect(
      markConversationClassificationEnqueued(
        {
          conversationId,
          revision: 7,
          generation: 3,
          marker: { kind: "effects", analysisRevisionId: " " },
        },
        { conversationModel: { updateOne } as never }
      )
    ).rejects.toThrow(/analysis revision/i);
    expect(updateOne).not.toHaveBeenCalled();
  });

  it("rejects malformed contract-v2 state instead of repairing it during claim", () => {
    const filter = buildConversationClassificationClaimFilter({
      conversationId,
      now,
    });

    expect(filter).toMatchObject({
      _id: conversationId,
      "classification_state.contractVersion": 2,
      $or: [
        {
          "classification_state.status": { $in: ["pending", "blocked"] },
          "classification_state.processingRevision": { $type: "null" },
          "classification_state.nextAttemptAt": {
            $type: "date",
            $lte: now,
          },
          "classification_state.lease": { $type: "null" },
        },
        {
          "classification_state.status": "processing",
          "classification_state.lease.ownerToken": {
            $type: "string",
            $ne: "",
          },
          "classification_state.lease.claimedAt": { $type: "date" },
          "classification_state.lease.expiresAt": {
            $type: "date",
            $lte: now,
          },
        },
      ],
    });

    const serialized = JSON.stringify(filter);
    for (const path of [
      "$classification_revision",
      "$classification_state.requestedRevision",
      "$classification_state.attemptRevision",
      "$classification_state.attemptCount",
      "$classification_state.generation",
      "$classification_state.fence",
      "$classification_state.processingRevision",
    ]) {
      expect(serialized).toContain(path);
    }
    expect(serialized).toContain("$trunc");
    expect(serialized).toContain(String(Number.MAX_SAFE_INTEGER));
  });

  it("increments only already-valid claim counters and never normalizes them", () => {
    const pipeline = buildConversationClassificationClaimPipeline({
      now,
      ownerToken: "claim-owner",
      expiresAt,
    });
    const set = (pipeline[0] as { $set: Record<string, unknown> }).$set;

    expect(set["classification_state.fence"]).toEqual({
      $add: ["$classification_state.fence", 1],
    });
    expect(set["classification_state.attemptCount"]).toEqual({
      $cond: [
        {
          $eq: [
            "$classification_state.attemptRevision",
            "$classification_revision",
          ],
        },
        { $add: ["$classification_state.attemptCount", 1] },
        1,
      ],
    });
    expect(JSON.stringify(pipeline)).not.toContain("$ifNull");
  });

  it("atomically defers only the exact live media claim and refunds one attempt", async () => {
    const updateOne = jest.fn().mockResolvedValue({ matchedCount: 1 });
    const recheckAt = new Date("2026-08-10T06:20:00.000Z");

    await expect(
      deferClaimedConversationClassification(
        {
          lease: {
            conversationId,
            revision: 7,
            ownerToken: "owner-7",
            fence: 11,
            expiresAt,
          },
          recheckAt,
        },
        {
          now: () => now,
          conversationModel: { updateOne } as never,
        }
      )
    ).resolves.toBe(true);

    expect(updateOne).toHaveBeenCalledWith(
      buildConversationClassificationLeaseFilter({
        conversationId,
        revision: 7,
        ownerToken: "owner-7",
        fence: 11,
        expiresAt,
        now,
      }),
      [
        {
          $set: {
            "classification_state.status": "blocked",
            "classification_state.processingRevision": null,
            "classification_state.nextAttemptAt": recheckAt,
            "classification_state.lease": null,
            "classification_state.error": null,
            "classification_state.review": null,
            "classification_state.blocked": {
              code: "media_pending",
              reason: "Inbound media analysis is still pending",
              recheckAt,
            },
            "classification_state.attemptCount": {
              $max: [
                0,
                { $subtract: ["$classification_state.attemptCount", 1] },
              ],
            },
            is_classified: false,
            is_qa_analyzed: false,
          },
        },
      ],
      { timestamps: false }
    );
    const serializedUpdate = JSON.stringify(updateOne.mock.calls[0]?.[1]);
    for (const preservedPath of [
      '"classification_revision"',
      '"classification_state.requestedRevision"',
      '"classification_state.attemptRevision"',
      '"classification_state.generation"',
      '"classification_state.fence"',
      '"classification_meta"',
      '"classification":',
    ]) {
      expect(serializedUpdate).not.toContain(preservedPath);
    }
    expect(CONVERSATION_CLASSIFICATION_MEDIA_RECHECK_MS).toBe(20 * 60 * 1000);
  });

  it("returns stale when the exact media claim no longer matches", async () => {
    const updateOne = jest.fn().mockResolvedValue({ matchedCount: 0 });

    await expect(
      deferClaimedConversationClassification(
        {
          lease: {
            conversationId,
            revision: 7,
            ownerToken: "prior-owner",
            fence: 10,
            expiresAt,
          },
          recheckAt: new Date("2026-08-10T06:20:00.000Z"),
        },
        {
          now: () => now,
          conversationModel: { updateOne } as never,
        }
      )
    ).resolves.toBe(false);
  });

  it.each([
    "not-a-date" as unknown as Date,
    new Date("invalid"),
    new Date("2026-08-10T05:59:59.999Z"),
    new Date("2026-08-10T06:20:00.001Z"),
  ])(
    "rejects an invalid or unbounded media recheck before model I/O",
    async recheckAt => {
      const updateOne = jest.fn();

      await expect(
        deferClaimedConversationClassification(
          {
            lease: {
              conversationId,
              revision: 7,
              ownerToken: "owner-7",
              fence: 11,
              expiresAt,
            },
            recheckAt,
          },
          {
            now: () => now,
            conversationModel: { updateOne } as never,
          }
        )
      ).rejects.toThrow("media recheckAt");
      expect(updateOne).not.toHaveBeenCalled();
    }
  );

  it("blocks an exact expired processing observation without consuming its attempt", async () => {
    const updateOne = jest.fn().mockResolvedValue({ matchedCount: 1 });
    const expiredAt = new Date("2026-08-10T05:59:59.000Z");
    const recheckAt = new Date("2026-08-10T06:05:00.000Z");

    await expect(
      markConversationClassificationBlocked(
        {
          observation: {
            kind: "expired_processing",
            lease: {
              conversationId,
              revision: 7,
              ownerToken: "expired-owner",
              fence: 11,
              expiresAt: expiredAt,
            },
          },
          code: "company_capacity",
          reason: "Company processing capacity is exhausted",
          recheckAt,
        },
        {
          now: () => now,
          conversationModel: { updateOne } as never,
        }
      )
    ).resolves.toBe(true);

    expect(updateOne).toHaveBeenCalledWith(
      {
        _id: conversationId,
        classification_revision: 7,
        "classification_state.contractVersion": 2,
        "classification_state.requestedRevision": 7,
        "classification_state.processingRevision": 7,
        "classification_state.status": "processing",
        "classification_state.lease.ownerToken": "expired-owner",
        "classification_state.fence": 11,
        "classification_state.lease.expiresAt": {
          $eq: expiredAt,
          $lte: now,
        },
      },
      {
        $set: {
          "classification_state.status": "blocked",
          "classification_state.processingRevision": null,
          "classification_state.nextAttemptAt": recheckAt,
          "classification_state.lease": null,
          "classification_state.error": null,
          "classification_state.review": null,
          "classification_state.blocked": {
            code: "company_capacity",
            reason: "Company processing capacity is exhausted",
            recheckAt,
          },
          is_classified: false,
          is_qa_analyzed: false,
        },
      },
      { timestamps: false }
    );
    const serializedUpdate = JSON.stringify(updateOne.mock.calls[0]?.[1]);
    for (const preservedPath of [
      '"classification_revision"',
      '"classification_state.requestedRevision"',
      '"classification_state.attemptRevision"',
      '"classification_state.attemptCount"',
      '"classification_state.generation"',
      '"classification_state.fence"',
      '"classification_meta"',
      '"classification":',
    ]) {
      expect(serializedUpdate).not.toContain(preservedPath);
    }
  });

  it("blocks only an exact due observation without overwriting a scan race", async () => {
    const updateOne = jest.fn().mockResolvedValue({ matchedCount: 1 });
    const recheckAt = new Date("2026-08-10T06:05:00.000Z");

    await expect(
      markConversationClassificationBlocked(
        {
          observation: {
            kind: "due",
            conversationId,
            revision: 7,
          },
          code: "company_capacity",
          reason: "Company processing capacity is exhausted",
          recheckAt,
        },
        {
          now: () => now,
          conversationModel: { updateOne } as never,
        }
      )
    ).resolves.toBe(true);

    expect(updateOne).toHaveBeenCalledWith(
      {
        _id: conversationId,
        classification_revision: 7,
        "classification_state.contractVersion": 2,
        "classification_state.requestedRevision": 7,
        "classification_state.status": { $in: ["pending", "blocked"] },
        "classification_state.processingRevision": null,
        "classification_state.nextAttemptAt": { $type: "date", $lte: now },
        "classification_state.lease": null,
      },
      {
        $set: {
          "classification_state.status": "blocked",
          "classification_state.processingRevision": null,
          "classification_state.nextAttemptAt": recheckAt,
          "classification_state.lease": null,
          "classification_state.error": null,
          "classification_state.review": null,
          "classification_state.blocked": {
            code: "company_capacity",
            reason: "Company processing capacity is exhausted",
            recheckAt,
          },
          is_classified: false,
          is_qa_analyzed: false,
        },
      },
      { timestamps: false }
    );
  });

  it("returns false without model I/O for an observed lease that is still live", async () => {
    const updateOne = jest.fn();

    await expect(
      markConversationClassificationBlocked(
        {
          observation: {
            kind: "expired_processing",
            lease: {
              conversationId,
              revision: 7,
              ownerToken: "live-owner",
              fence: 11,
              expiresAt,
            },
          },
          code: "company_capacity",
          reason: "Company processing capacity is exhausted",
          recheckAt: new Date("2026-08-10T06:05:00.000Z"),
        },
        {
          now: () => now,
          conversationModel: { updateOne } as never,
        }
      )
    ).resolves.toBe(false);
    expect(updateOne).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "invalid expiry",
      expiresAt: new Date("invalid"),
      recheckAt: new Date("2026-08-10T06:05:00.000Z"),
      expected: /expiresAt/,
    },
    {
      name: "invalid recheck",
      expiresAt: new Date("2026-08-10T05:59:59.000Z"),
      recheckAt: new Date("invalid"),
      expected: /recheckAt/,
    },
    {
      name: "past recheck",
      expiresAt: new Date("2026-08-10T05:59:59.000Z"),
      recheckAt: now,
      expected: /recheckAt/,
    },
    {
      name: "malformed owner",
      expiresAt: new Date("2026-08-10T05:59:59.000Z"),
      recheckAt: new Date("2026-08-10T06:05:00.000Z"),
      ownerToken: 42,
      expected: /observation/,
    },
  ])("rejects $name before expired-observation model I/O", async input => {
    const updateOne = jest.fn();
    await expect(
      markConversationClassificationBlocked(
        {
          observation: {
            kind: "expired_processing",
            lease: {
              conversationId,
              revision: 7,
              ownerToken: (input.ownerToken ?? "expired-owner") as string,
              fence: 11,
              expiresAt: input.expiresAt,
            },
          },
          code: "company_capacity",
          reason: "Company processing capacity is exhausted",
          recheckAt: input.recheckAt,
        },
        {
          now: () => now,
          conversationModel: { updateOne } as never,
        }
      )
    ).rejects.toThrow(input.expected);
    expect(updateOne).not.toHaveBeenCalled();
  });

  it.each([
    [
      "completed",
      effectsRow({
        effects: {
          status: "completed",
          attemptCount: 1,
          fence: 1,
          nextAttemptAt: null,
          completedAt: now,
          checklist: { ...completedChecklist },
        },
      }),
      { status: "completed" },
    ],
    [
      "review not applicable",
      effectsRow({
        outcome: "review_required",
        projection: null,
        effectInputs: null,
        effects: {
          status: "not_applicable",
          nextAttemptAt: null,
          completedAt: new Date("2026-08-10T05:59:00.000Z"),
        },
      }),
      { status: "completed" },
    ],
    [
      "superseded",
      effectsRow({
        effects: {
          status: "superseded",
          nextAttemptAt: null,
          completedAt: now,
        },
      }),
      { status: "superseded" },
    ],
    [
      "expired-processing reconciliation terminal",
      effectsRow({
        effects: {
          status: "superseded",
          attemptCount: 2,
          fence: 3,
          nextAttemptAt: null,
          completedAt: now,
        },
      }),
      { status: "superseded" },
    ],
    [
      "future pending",
      effectsRow({
        effects: {
          status: "pending",
          nextAttemptAt: new Date("2026-08-10T06:01:00.000Z"),
        },
      }),
      {
        status: "retry_scheduled",
        nextAttemptAt: new Date("2026-08-10T06:01:00.000Z"),
      },
    ],
    [
      "future failed",
      effectsRow({
        effects: {
          status: "failed",
          attemptCount: 1,
          fence: 1,
          nextAttemptAt: new Date("2026-08-10T06:05:00.000Z"),
        },
      }),
      {
        status: "retry_scheduled",
        nextAttemptAt: new Date("2026-08-10T06:05:00.000Z"),
      },
    ],
    [
      "live processing",
      effectsRow({
        effects: {
          status: "processing",
          nextAttemptAt: null,
          attemptCount: 2,
          fence: 2,
          lease: {
            ownerToken: "live-owner",
            claimedAt: new Date("2026-08-10T05:59:00.000Z"),
            expiresAt,
          },
        },
      }),
      { status: "lease_lost" },
    ],
  ] as const)(
    "maps an observed %s effects row exhaustively",
    async (_name, row, expected) => {
      const { deps, analysisRevisionModel } = claimDependencies({
        observed: [row as EffectsRow],
      });

      await expect(
        claimConversationAnalysisEffects({ analysisRevisionId: row._id }, deps)
      ).resolves.toEqual(expected);
      expect(analysisRevisionModel.findOneAndUpdate).not.toHaveBeenCalled();
    }
  );

  it.each([
    ["missing row", null],
    ["unknown status", effectsRow({ effects: { status: "unknown" as never } })],
    [
      "completed with an incomplete checklist",
      effectsRow({
        effects: {
          status: "completed",
          attemptCount: 1,
          fence: 1,
          nextAttemptAt: null,
          completedAt: now,
        },
      }),
    ],
    [
      "review revision with pending effects",
      effectsRow({
        outcome: "review_required",
        projection: null,
        effectInputs: null,
      }),
    ],
    [
      "processing with a partial lease",
      effectsRow({
        effects: {
          status: "processing",
          nextAttemptAt: null,
          lease: { ownerToken: "owner" } as never,
        },
      }),
    ],
    [
      "checklist with an unknown key",
      effectsRow({
        effects: {
          checklist: { ...emptyChecklist, sixth: null } as never,
        },
      }),
    ],
    [
      "review revision with claim counters",
      effectsRow({
        outcome: "review_required",
        projection: null,
        effectInputs: null,
        effects: {
          status: "not_applicable",
          attemptCount: 1,
          fence: 1,
          nextAttemptAt: null,
          completedAt: new Date("2026-08-10T05:59:00.000Z"),
        },
      }),
    ],
    [
      "pending revision with a completed step",
      effectsRow({
        effects: {
          checklist: { ...emptyChecklist, summary: now },
        },
      }),
    ],
    [
      "failed revision without a claim",
      effectsRow({ effects: { status: "failed" } }),
    ],
    [
      "processing revision without a claim",
      effectsRow({
        effects: {
          status: "processing",
          nextAttemptAt: null,
          lease: {
            ownerToken: "owner",
            claimedAt: new Date("2026-08-10T05:59:00.000Z"),
            expiresAt,
          },
        },
      }),
    ],
    [
      "completed revision without a claim",
      effectsRow({
        effects: {
          status: "completed",
          nextAttemptAt: null,
          completedAt: now,
          checklist: { ...completedChecklist },
        },
      }),
    ],
    [
      "divergent attempt and fence",
      effectsRow({
        effects: {
          status: "failed",
          attemptCount: 2,
          fence: 1,
        },
      }),
    ],
    [
      "superseded fence more than one ahead of attempts",
      effectsRow({
        effects: {
          status: "superseded",
          attemptCount: 2,
          fence: 4,
          nextAttemptAt: null,
          completedAt: now,
        },
      }),
    ],
    [
      "superseded reconciliation fence without a prior attempt",
      effectsRow({
        effects: {
          status: "superseded",
          attemptCount: 0,
          fence: 1,
          nextAttemptAt: null,
          completedAt: now,
        },
      }),
    ],
    [
      "inverted processing lease",
      effectsRow({
        effects: {
          status: "processing",
          attemptCount: 1,
          fence: 1,
          nextAttemptAt: null,
          lease: {
            ownerToken: "owner",
            claimedAt: expiresAt,
            expiresAt: new Date("2026-08-10T06:09:59.999Z"),
          },
        },
      }),
    ],
    ["blank analysis identity", effectsRow({ _id: " " })],
    [
      "unsafe source revision",
      effectsRow({ sourceRevision: Number.MAX_SAFE_INTEGER + 1 }),
    ],
    [
      "invalid completion date",
      effectsRow({ completedAt: new Date("invalid") }),
    ],
  ])("throws for invariant effects state: %s", async (_name, row) => {
    const { deps } = claimDependencies({
      observed: [row as EffectsRow | null],
    });

    await expect(
      claimConversationAnalysisEffects(
        { analysisRevisionId: `${conversationId}:7` },
        deps
      )
    ).rejects.toThrow(/analysis effects invariant/i);
  });

  it("claims with the exact observed state and returns only the post-update lease and snapshot", async () => {
    const pre = effectsRow({
      workspaceId: "pre-workspace",
      projection: { classification: { category: "Pre" } },
    });
    const claimedAt = now;
    const postExpiresAt = new Date("2026-08-10T06:10:00.000Z");
    const post = effectsRow({
      workspaceId: "post-workspace",
      projection: {
        classification: {
          category: "Post",
          priority: "medium",
          sentiment: "neutral",
          summary: "Post-update snapshot",
          confidence: { category: 0.7 },
        },
      },
      effects: {
        status: "processing",
        attemptCount: 1,
        fence: 1,
        nextAttemptAt: null,
        lease: {
          ownerToken: "new-effects-owner",
          claimedAt,
          expiresAt: postExpiresAt,
        },
      },
    });
    const { deps, analysisRevisionModel } = claimDependencies({
      observed: [pre],
      claimed: [post],
    });

    await expect(
      claimConversationAnalysisEffects({ analysisRevisionId: pre._id }, deps)
    ).resolves.toEqual({
      status: "claimed",
      lease: {
        analysisRevisionId: post._id,
        conversationId: post.conversationId,
        sourceRevision: post.sourceRevision,
        ownerToken: "new-effects-owner",
        fence: 1,
        expiresAt: postExpiresAt,
        attemptCount: 1,
      },
      analysis: {
        analysisRevisionId: post._id,
        conversationId: String(post.conversationId),
        workspaceId: "post-workspace",
        sourceRevision: 7,
        completedAt: post.completedAt,
        outcome: "ready",
        projection: post.projection,
        effectInputs: post.effectInputs,
        checklist: post.effects.checklist,
      },
    });

    expect(analysisRevisionModel.findOneAndUpdate).toHaveBeenCalledWith(
      {
        _id: pre._id,
        "effects.status": "pending",
        "effects.attemptCount": 0,
        "effects.fence": 0,
        "effects.nextAttemptAt": { $eq: now, $lte: now },
        "effects.completedAt": null,
        "effects.lease": null,
      },
      {
        $set: {
          "effects.status": "processing",
          "effects.nextAttemptAt": null,
          "effects.lease": {
            ownerToken: "new-effects-owner",
            claimedAt: now,
            expiresAt: postExpiresAt,
          },
        },
        $inc: { "effects.attemptCount": 1, "effects.fence": 1 },
      },
      expect.objectContaining({
        new: true,
        timestamps: false,
        projection: {
          _id: 1,
          conversationId: 1,
          workspaceId: 1,
          sourceRevision: 1,
          completedAt: 1,
          outcome: 1,
          projection: 1,
          effectInputs: 1,
          effects: 1,
        },
      })
    );
    expect(analysisRevisionModel.findById).toHaveBeenCalledWith(pre._id, {
      _id: 1,
      conversationId: 1,
      sourceRevision: 1,
      completedAt: 1,
      outcome: 1,
      effects: 1,
    });
  });

  it("claims an expired owner only through its exact observed lease identity", async () => {
    const observedExpiry = new Date("2026-08-10T05:59:59.000Z");
    const observedClaimedAt = new Date("2026-08-10T05:50:00.000Z");
    const expired = effectsRow({
      effects: {
        status: "processing",
        attemptCount: 2,
        fence: 2,
        nextAttemptAt: null,
        lease: {
          ownerToken: "expired-owner",
          claimedAt: observedClaimedAt,
          expiresAt: observedExpiry,
        },
      },
    });
    const post = effectsRow({
      effects: {
        status: "processing",
        attemptCount: 3,
        fence: 3,
        nextAttemptAt: null,
        lease: {
          ownerToken: "new-effects-owner",
          claimedAt: now,
          expiresAt,
        },
      },
    });
    const { deps, analysisRevisionModel } = claimDependencies({
      observed: [expired],
      claimed: [post],
    });

    await expect(
      claimConversationAnalysisEffects(
        { analysisRevisionId: expired._id },
        deps
      )
    ).resolves.toMatchObject({ status: "claimed" });
    expect(analysisRevisionModel.findOneAndUpdate.mock.calls[0]?.[0]).toEqual({
      _id: expired._id,
      "effects.status": "processing",
      "effects.attemptCount": 2,
      "effects.fence": 2,
      "effects.nextAttemptAt": null,
      "effects.completedAt": null,
      "effects.lease.ownerToken": "expired-owner",
      "effects.lease.claimedAt": { $eq: observedClaimedAt },
      "effects.lease.expiresAt": { $eq: observedExpiry, $lte: now },
    });
  });

  it("rejects a post-update claim whose installed claimedAt is not authoritative now", async () => {
    const pre = effectsRow();
    const post = effectsRow({
      effects: {
        status: "processing",
        attemptCount: 1,
        fence: 1,
        nextAttemptAt: null,
        lease: {
          ownerToken: "new-effects-owner",
          claimedAt: new Date("2026-08-10T05:59:59.999Z"),
          expiresAt,
        },
      },
    });
    const { deps, conversationModel } = claimDependencies({
      observed: [pre],
      claimed: [post],
    });

    await expect(
      claimConversationAnalysisEffects({ analysisRevisionId: pre._id }, deps)
    ).rejects.toThrow(/post-update claim identity/i);
    expect(conversationModel.updateOne).not.toHaveBeenCalled();
  });

  it.each([
    [
      "completed",
      effectsRow({
        effects: {
          status: "completed",
          attemptCount: 1,
          fence: 1,
          nextAttemptAt: null,
          completedAt: now,
          checklist: { ...completedChecklist },
        },
      }),
      { status: "completed" },
    ],
    [
      "future",
      effectsRow({
        effects: {
          status: "failed",
          attemptCount: 1,
          fence: 1,
          nextAttemptAt: new Date("2026-08-10T06:05:00.000Z"),
        },
      }),
      {
        status: "retry_scheduled",
        nextAttemptAt: new Date("2026-08-10T06:05:00.000Z"),
      },
    ],
    [
      "live owned",
      effectsRow({
        effects: {
          status: "processing",
          attemptCount: 1,
          fence: 1,
          nextAttemptAt: null,
          lease: {
            ownerToken: "other-owner",
            claimedAt: new Date("2026-08-10T05:59:00.000Z"),
            expiresAt,
          },
        },
      }),
      { status: "lease_lost" },
    ],
    [
      "superseded",
      effectsRow({
        effects: {
          status: "superseded",
          nextAttemptAt: null,
          completedAt: now,
        },
      }),
      { status: "superseded" },
    ],
  ] as const)(
    "rereads and maps %s after an observed-state claim CAS loses",
    async (_name, second, expected) => {
      const due = effectsRow();
      const { deps } = claimDependencies({
        observed: [due, second as EffectsRow],
        claimed: [null],
      });

      await expect(
        claimConversationAnalysisEffects({ analysisRevisionId: due._id }, deps)
      ).resolves.toEqual(expected);
    }
  );

  it("throws after eight observed-state claim CAS losses", async () => {
    const due = effectsRow();
    const { deps, analysisRevisionModel } = claimDependencies({
      observed: Array.from({ length: 8 }, () => due),
      claimed: Array.from({ length: 8 }, () => null),
    });

    await expect(
      claimConversationAnalysisEffects({ analysisRevisionId: due._id }, deps)
    ).rejects.toBeInstanceOf(ConversationClassificationCasError);
    expect(analysisRevisionModel.findOneAndUpdate).toHaveBeenCalledTimes(8);
  });

  it("supersedes an owned effects lease when its ready revision is no longer current", async () => {
    const analysisRevisionId = `${conversationId}:7`;
    const effectsExpiresAt = new Date("2026-08-10T06:10:00.000Z");
    const lease = {
      analysisRevisionId,
      conversationId,
      sourceRevision: 7,
      ownerToken: "effects-owner",
      fence: 3,
      expiresAt: effectsExpiresAt,
      attemptCount: 3,
    };
    const session = {
      withTransaction: jest.fn(async (operation: () => Promise<void>) => {
        await operation();
      }),
      endSession: jest.fn(async () => undefined),
    };
    const row = {
      _id: analysisRevisionId,
      conversationId,
      sourceRevision: 7,
      completedAt: new Date("2026-08-10T05:59:00.000Z"),
      effects: {
        status: "processing",
        attemptCount: 3,
        fence: 3,
        lease: {
          ownerToken: "effects-owner",
          claimedAt: new Date("2026-08-10T05:58:00.000Z"),
          expiresAt: effectsExpiresAt,
        },
      },
    };
    const analysisUpdateOne = jest.fn().mockResolvedValue({ matchedCount: 1 });
    const conversationUpdateOne = jest
      .fn()
      .mockResolvedValue({ matchedCount: 0 });
    const analysisRevisionModel = {
      findById: jest.fn(() => ({
        session: jest.fn(() => ({
          lean: jest.fn(() => ({
            exec: jest.fn(async () => row),
          })),
        })),
      })),
      updateOne: analysisUpdateOne,
    };
    const conversationModel = {
      startSession: jest.fn(async () => session),
      updateOne: conversationUpdateOne,
    };

    await expect(
      renewConversationAnalysisEffectsLease(lease, {
        now: () => now,
        conversationModel: conversationModel as never,
        analysisRevisionModel: analysisRevisionModel as never,
      })
    ).resolves.toEqual({ status: "superseded" });
    expect(conversationUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: conversationId,
        classification_revision: 7,
        "classification_state.status": "ready",
        "classification_meta.provenance_kind": "v2",
        "classification_meta.analysis_revision_id": analysisRevisionId,
        $expr: expect.objectContaining({ $and: expect.any(Array) }),
      }),
      expect.any(Object),
      expect.objectContaining({ session, timestamps: false })
    );
    const barrierFilter = conversationUpdateOne.mock.calls[0]?.[0];
    expect(JSON.stringify(barrierFilter)).toContain(
      '"$isNumber":"$classification_revision"'
    );
    expect(JSON.stringify(barrierFilter)).toContain(
      '"$classification_meta.source_revision"'
    );
    expect(JSON.stringify(barrierFilter)).toContain(
      '"$classification_state.requestedRevision"'
    );
    expect(JSON.stringify(barrierFilter)).toContain(
      '"$classification_state.appliedRevision"'
    );
    expect(analysisUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: analysisRevisionId,
        "effects.status": "processing",
        "effects.lease.ownerToken": "effects-owner",
        "effects.fence": 3,
      }),
      {
        $set: {
          "effects.status": "superseded",
          "effects.completedAt": now,
          "effects.nextAttemptAt": null,
          "effects.lease": null,
        },
      },
      expect.objectContaining({ session, timestamps: false })
    );
  });

  it.each(["pending", "failed"] as const)(
    "supersedes an exact observed stale %s effects row without claiming it",
    async status => {
      const nextAttemptAt = new Date("2026-08-10T05:59:00.000Z");
      const row = effectsRow({
        effects: {
          status,
          attemptCount: status === "pending" ? 0 : 2,
          fence: status === "pending" ? 0 : 2,
          nextAttemptAt,
        },
      });
      const { deps, analysisUpdateOne } = reconciliationDependencies({ row });

      await expect(
        reconcileSupersededConversationAnalysisEffects(
          {
            analysisRevisionId: row._id,
            observed: { status, nextAttemptAt, fence: row.effects.fence },
          },
          deps
        )
      ).resolves.toBe("superseded");
      expect(analysisUpdateOne).toHaveBeenCalledWith(
        {
          _id: row._id,
          "effects.status": status,
          "effects.fence": row.effects.fence,
          "effects.nextAttemptAt": { $eq: nextAttemptAt, $lte: now },
          "effects.completedAt": null,
          "effects.lease": null,
        },
        {
          $set: {
            "effects.status": "superseded",
            "effects.completedAt": now,
            "effects.nextAttemptAt": null,
            "effects.lease": null,
          },
        },
        expect.objectContaining({ timestamps: false })
      );
    }
  );

  it("fence-increments an exact observed stale expired processing effects row", async () => {
    const claimedAt = new Date("2026-08-10T05:45:00.000Z");
    const effectsExpiresAt = new Date("2026-08-10T05:55:00.000Z");
    const row = effectsRow({
      effects: {
        status: "processing",
        attemptCount: 3,
        fence: 3,
        nextAttemptAt: null,
        lease: {
          ownerToken: "expired-effects-owner",
          claimedAt,
          expiresAt: effectsExpiresAt,
        },
      },
    });
    const { deps, analysisUpdateOne } = reconciliationDependencies({ row });

    await expect(
      reconcileSupersededConversationAnalysisEffects(
        {
          analysisRevisionId: row._id,
          observed: {
            status: "processing",
            expiresAt: effectsExpiresAt,
            fence: 3,
          },
        },
        deps
      )
    ).resolves.toBe("superseded");
    expect(analysisUpdateOne).toHaveBeenCalledWith(
      {
        _id: row._id,
        "effects.status": "processing",
        "effects.fence": 3,
        "effects.nextAttemptAt": null,
        "effects.completedAt": null,
        "effects.lease.expiresAt": { $eq: effectsExpiresAt, $lte: now },
      },
      {
        $set: {
          "effects.status": "superseded",
          "effects.completedAt": now,
          "effects.nextAttemptAt": null,
          "effects.lease": null,
        },
        $inc: { "effects.fence": 1 },
      },
      expect.objectContaining({ timestamps: false })
    );
  });

  it.each([
    ["current", effectsRow(), 1, 1, "current"],
    ["missing", null, 0, 1, "missing"],
    ["changed", effectsRow(), 0, 0, "changed"],
  ] as const)(
    "returns %s without overwriting a changed effects observation",
    async (_name, row, barrierMatches, updateMatches, expected) => {
      const nextAttemptAt = now;
      const { deps, analysisUpdateOne } = reconciliationDependencies({
        row: row as EffectsRow | null,
        barrierMatches,
        updateMatches,
      });
      await expect(
        reconcileSupersededConversationAnalysisEffects(
          {
            analysisRevisionId: `${conversationId}:7`,
            observed: { status: "pending", nextAttemptAt, fence: 0 },
          },
          deps
        )
      ).resolves.toBe(expected);
      if (expected === "current" || expected === "missing") {
        expect(analysisUpdateOne).not.toHaveBeenCalled();
      }
    }
  );

  it("rejects a not-yet-expired processing effects observation before a transaction", async () => {
    const startSession = jest.fn();
    await expect(
      reconcileSupersededConversationAnalysisEffects(
        {
          analysisRevisionId: `${conversationId}:7`,
          observed: { status: "processing", expiresAt, fence: 3 },
        },
        {
          now: () => now,
          conversationModel: { startSession } as never,
        }
      )
    ).rejects.toThrow(/due effects observation/i);
    expect(startSession).not.toHaveBeenCalled();
  });

  it("caps durable effects retries at twenty-four hours", () => {
    const expected = [
      "2026-08-10T06:01:00.000Z",
      "2026-08-10T06:05:00.000Z",
      "2026-08-10T06:20:00.000Z",
      "2026-08-10T07:00:00.000Z",
      "2026-08-10T12:00:00.000Z",
      "2026-08-11T06:00:00.000Z",
      "2026-08-11T06:00:00.000Z",
    ];

    expect(
      expected.map((_, index) =>
        getConversationAnalysisEffectsRetryAt({
          attemptCount: index + 1,
          now,
        }).toISOString()
      )
    ).toEqual(expected);
  });
});
