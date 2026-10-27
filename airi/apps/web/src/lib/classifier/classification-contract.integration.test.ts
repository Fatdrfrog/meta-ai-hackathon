jest.mock(
  "@/lib/airi/rag/conversation-summary/conversation-summary-storage",
  () => ({ persistConversationSummaryRevision: jest.fn() })
);
jest.mock("@/lib/analytics", () => ({
  trackConversationClassificationCompleted: jest.fn(),
}));
jest.mock("@/lib/realtime/server", () => ({
  enqueueConversationClassificationReadyRealtimeEvent: jest.fn(),
}));
jest.mock("@/lib/limits/company-usage-events", () => ({
  emitWorkspaceUsageDelta: jest.fn(),
}));
jest.mock("@/lib/webhook-events", () => ({
  triggerClassificationCompletedStrict: jest.fn(),
}));

import mongoose from "mongoose";

import {
  buildCurrentConversationClassificationFilter,
  hasCurrentConversationClassification,
} from "@icecore/shared/lib/conversation-classification-freshness";
import {
  ConversationAnalysisRevision,
  buildConversationAnalysisRevisionId,
} from "@/models/conversation-analysis-revision";
import { Conversation } from "@/models/conversation";
import Message from "@/models/message";
import { buildClassificationInputPendingTransitionPipeline } from "./classification-contract";
import { updateClassificationInputMessageAndInvalidate } from "./classification-input-mutation";
import {
  dispatchConversationClassificationEffects,
  type ConversationClassificationEffectsDependencies,
} from "./conversation-classification-effects";
import {
  CONVERSATION_ANALYSIS_EFFECT_STEPS,
  authorizeConversationAnalysisEffectStep,
  claimConversationAnalysisEffects,
  claimConversationClassification,
  commitConversationClassificationReady,
  commitConversationClassificationReviewRequired,
  completeConversationAnalysisEffectStep,
  completeConversationAnalysisEffects,
  deferClaimedConversationClassification,
  markConversationClassificationEnqueued,
  markConversationClassificationBlocked,
  readConversationClassificationWakeState,
  reconcileSupersededConversationAnalysisEffects,
  recordConversationAnalysisEffectsFailure,
  recordConversationClassificationFailure,
  recoverExpiredSupersededConversationClassificationLease,
  releaseStaleConversationClassificationLease,
  renewConversationAnalysisEffectsLease,
  renewConversationClassificationLease,
} from "./conversation-classification-store";

const mongoUri = process.env.CLASSIFICATION_CONTRACT_TEST_MONGODB_URI;
const describeMongo = mongoUri ? describe : describe.skip;

const T0 = new Date("2026-08-10T06:00:00.000Z");

type StoredConversation = {
  classification_revision?: number;
  classification_state?: {
    status?: string;
    requestedRevision?: number;
    appliedRevision?: number | null;
  };
  classification?: Record<string, unknown>;
  classification_meta?: {
    provenance_kind?: string | null;
    source_revision?: number | null;
    analysis_revision_id?: string | null;
  };
  internal_labels?: string[];
  is_classified?: boolean;
  is_qa_analyzed?: boolean;
};

async function readConversation(
  _id: mongoose.Types.ObjectId
): Promise<StoredConversation | null> {
  return (await Conversation.collection.findOne({
    _id,
  })) as StoredConversation | null;
}

async function readMessage(
  _id: mongoose.Types.ObjectId
): Promise<{ text?: string } | null> {
  return (await Message.collection.findOne({ _id })) as {
    text?: string;
  } | null;
}

function state(input?: {
  revision?: number;
  appliedRevision?: number | null;
  generation?: number;
}) {
  const revision = input?.revision ?? 1;
  return {
    contractVersion: 2,
    status: "pending",
    requestedRevision: revision,
    processingRevision: null,
    appliedRevision: input?.appliedRevision ?? null,
    generation: input?.generation ?? 1,
    attemptRevision: revision,
    attemptCount: 0,
    fence: 0,
    requestedAt: T0,
    nextAttemptAt: T0,
    lastEnqueuedAt: null,
    completedAt: null,
    lease: null,
    error: null,
    review: null,
    blocked: null,
  };
}

async function createPendingConversation(input?: {
  classification?: Record<string, unknown>;
  appliedRevision?: number | null;
}) {
  const _id = new mongoose.Types.ObjectId();
  await Conversation.collection.insertOne({
    _id,
    workspaceId: "workspace-integration",
    channel: "whatsapp",
    messages: [],
    last_inbound_at: new Date("2026-08-10T05:59:00.000Z"),
    classification_revision: 1,
    classification_state: state({ appliedRevision: input?.appliedRevision }),
    classification: input?.classification,
    is_classified: false,
    is_qa_analyzed: false,
    createdAt: T0,
    updatedAt: T0,
  });
  return { _id };
}

const provenance = {
  taxonomyId: "taxonomy-1",
  taxonomyDigest: "digest-1",
  classifierVersion: "classifier-1",
  classifierContractRevision: 2,
};

const effectInputs = {
  companyId: "company-integration",
  source: { id: "source-integration", type: "whatsapp" },
  predictedCategoryConfidence: 0.9,
  processingTimeMs: 1_250,
  provider: "vertex",
  model: "gemini-2.5-flash",
  ragSummary: {
    mode: "replace" as const,
    language: "en" as const,
    summary: "Customer needs help.",
    chunks: ["Customer needs help."],
    metadata: {
      wordCount: 3,
      messageCount: 2,
      chunkCount: 1,
      generationTimeMs: 250,
    },
  },
};

const projection = {
  classification: {
    category: "Support",
    priority: "medium",
    sentiment: "neutral",
    summary: "Customer needs help.",
    action: "Reply with troubleshooting steps.",
    tags: ["support"],
    confidence: { category: 0.9, priority: 0.8, sentiment: 0.8 },
  },
  agent_performance_scorecard: {
    empathy_score: 8,
    clarity_score: 8,
    script_adherence_score: 7,
    resolution_efficiency_score: 8,
    overall_comment: "Clear response.",
  },
};

function realMongoEffectsDependencies(input: {
  now: { current: Date };
  ownerToken: string;
  summary?: ConversationClassificationEffectsDependencies["persistConversationSummaryRevision"];
  analytics?: ConversationClassificationEffectsDependencies["trackConversationClassificationCompleted"];
}) {
  const summary =
    input.summary ?? jest.fn(async () => ({ status: "completed" as const }));
  const analytics =
    input.analytics ?? jest.fn(async () => ({ status: "accepted" as const }));
  const realtime = jest.fn(async () => undefined);
  const usage = jest.fn(async () => ({ ok: true as const }));
  const webhook = jest.fn(async () => undefined);
  const dependencies: ConversationClassificationEffectsDependencies = {
    claimConversationAnalysisEffects: request =>
      claimConversationAnalysisEffects(request, {
        now: () => new Date(input.now.current),
        createOwnerToken: () => input.ownerToken,
      }),
    renewConversationAnalysisEffectsLease: ownedLease =>
      renewConversationAnalysisEffectsLease(ownedLease, {
        now: () => new Date(input.now.current),
      }),
    authorizeConversationAnalysisEffectStep: request =>
      authorizeConversationAnalysisEffectStep(request, {
        now: () => new Date(input.now.current),
      }),
    completeConversationAnalysisEffectStep: request =>
      completeConversationAnalysisEffectStep(request, {
        now: () => new Date(input.now.current),
      }),
    completeConversationAnalysisEffects: request =>
      completeConversationAnalysisEffects(request, {
        now: () => new Date(input.now.current),
      }),
    recordConversationAnalysisEffectsFailure: request =>
      recordConversationAnalysisEffectsFailure(request, {
        now: () => new Date(input.now.current),
      }),
    persistConversationSummaryRevision: summary,
    trackConversationClassificationCompleted: analytics,
    enqueueConversationClassificationReadyRealtimeEvent: realtime,
    emitWorkspaceUsageDelta: usage,
    triggerClassificationCompletedStrict: webhook,
    now: () => new Date(input.now.current),
    setTimer: () =>
      ({ integrationTimer: true }) as unknown as ReturnType<typeof setTimeout>,
    clearTimer: jest.fn(),
    writeWideEvent: jest.fn(),
  };
  return { dependencies, summary, analytics, realtime, usage, webhook };
}

async function createReadyAnalysis(
  completedAt: Date = new Date("2026-08-10T06:01:00.000Z")
) {
  const conversation = await createPendingConversation();
  const classificationLease = await claimConversationClassification(
    { conversationId: conversation._id },
    { now: () => T0, createOwnerToken: () => "classifier-owner" }
  );
  if (!classificationLease) throw new Error("classification not claimed");
  const ready = await commitConversationClassificationReady(
    {
      lease: classificationLease,
      workspaceId: "workspace-integration",
      projection,
      provenance,
      effectInputs,
    },
    { now: () => completedAt }
  );
  return { conversation, ready };
}

describeMongo("classification contract v2 real Mongo gates", () => {
  beforeAll(async () => {
    await mongoose.connect(mongoUri as string, {
      serverSelectionTimeoutMS: 5000,
    });
  });

  afterEach(async () => {
    await mongoose.connection.db?.dropDatabase();
  });

  afterAll(async () => {
    await mongoose.disconnect();
  });

  it("normalizes invalid legacy revisions and requires a BSON inbound date", async () => {
    const conversationId = new mongoose.Types.ObjectId();
    await Conversation.collection.insertOne({
      _id: conversationId,
      workspaceId: "workspace-integration",
      messages: [],
      classification_revision: "3",
      last_inbound_at: "2026-08-10T05:59:00.000Z",
    });

    await Conversation.updateOne(
      { _id: conversationId },
      buildClassificationInputPendingTransitionPipeline({ now: T0 }),
      { timestamps: false }
    );
    const stored = await readConversation(conversationId);
    expect(stored?.classification_revision).toBe(1);
    expect(stored?.classification_state?.status).toBe("not_applicable");
  });

  it("does not preserve a processing lease for an inbound-less conversation", async () => {
    const conversationId = new mongoose.Types.ObjectId();
    await Conversation.collection.insertOne({
      _id: conversationId,
      workspaceId: "workspace-integration",
      messages: [],
      classification_revision: 1,
      classification_state: {
        ...state(),
        status: "processing",
        processingRevision: 1,
        fence: 2,
        lease: {
          ownerToken: "old-owner",
          claimedAt: T0,
          expiresAt: new Date("2026-08-10T06:10:00.000Z"),
        },
      },
    });
    await Conversation.updateOne(
      { _id: conversationId },
      buildClassificationInputPendingTransitionPipeline({ now: T0 }),
      { timestamps: false }
    );
    const stored = (await Conversation.collection.findOne({
      _id: conversationId,
    })) as {
      classification_state?: {
        status?: string;
        processingRevision?: number | null;
        lease?: unknown;
      };
    } | null;
    expect(stored?.classification_state).toMatchObject({
      status: "not_applicable",
      processingRevision: null,
      lease: null,
    });
  });

  it("permits one concurrent claim and fences an expired owner", async () => {
    const conversation = await createPendingConversation();
    const [first, second] = await Promise.all([
      claimConversationClassification(
        { conversationId: conversation._id },
        { now: () => T0, createOwnerToken: () => "owner-a" }
      ),
      claimConversationClassification(
        { conversationId: conversation._id },
        { now: () => T0, createOwnerToken: () => "owner-b" }
      ),
    ]);
    const original = first ?? second;
    expect([first, second].filter(Boolean)).toHaveLength(1);
    expect(original).not.toBeNull();

    const activeDuplicate = await claimConversationClassification(
      { conversationId: conversation._id },
      {
        now: () => new Date("2026-08-10T06:09:59.000Z"),
        createOwnerToken: () => "owner-active",
      }
    );
    expect(activeDuplicate).toBeNull();

    const reclaimed = await claimConversationClassification(
      { conversationId: conversation._id },
      {
        now: () => new Date("2026-08-10T06:10:00.000Z"),
        createOwnerToken: () => "owner-reclaimed",
      }
    );
    expect(reclaimed?.fence).toBe((original?.fence ?? 0) + 1);
    expect(reclaimed?.ownerToken).toBe("owner-reclaimed");
    expect(
      await renewConversationClassificationLease(original!, {
        now: () => new Date("2026-08-10T06:10:01.000Z"),
      })
    ).toBeNull();
    expect(
      await recordConversationClassificationFailure(
        {
          lease: original!,
          code: "late",
          message: "late owner",
          retryable: true,
        },
        { now: () => new Date("2026-08-10T06:10:01.000Z") }
      )
    ).toBeNull();
    expect(
      await releaseStaleConversationClassificationLease(
        { lease: original! },
        { now: () => new Date("2026-08-10T06:10:01.000Z") }
      )
    ).toBe(false);
    expect(
      await deferClaimedConversationClassification(
        {
          lease: original!,
          recheckAt: new Date("2026-08-10T06:30:01.000Z"),
        },
        { now: () => new Date("2026-08-10T06:10:01.000Z") }
      )
    ).toBe(false);

    const beforeStaleCommits = await Conversation.collection.findOne({
      _id: conversation._id,
    });
    await expect(
      commitConversationClassificationReady(
        {
          lease: original!,
          workspaceId: "workspace-integration",
          projection,
          provenance,
          effectInputs,
        },
        { now: () => new Date("2026-08-10T06:10:01.000Z") }
      )
    ).rejects.toThrow("Ready classification lease is stale");
    await expect(
      commitConversationClassificationReviewRequired(
        {
          lease: original!,
          workspaceId: "workspace-integration",
          review: { code: "late_review", reason: "Late owner review" },
          provenance,
        },
        { now: () => new Date("2026-08-10T06:10:01.000Z") }
      )
    ).rejects.toThrow("Review classification lease is stale");
    expect(
      await Conversation.collection.findOne({ _id: conversation._id })
    ).toEqual(beforeStaleCommits);
    expect(
      await ConversationAnalysisRevision.countDocuments({
        conversationId: conversation._id,
      })
    ).toBe(0);

    const expiredConversation = await createPendingConversation();
    const expiredLease = await claimConversationClassification(
      { conversationId: expiredConversation._id },
      { now: () => T0, createOwnerToken: () => "expired-owner" }
    );
    expect(
      await releaseStaleConversationClassificationLease(
        { lease: expiredLease! },
        { now: () => new Date("2026-08-10T06:10:00.000Z") }
      )
    ).toBe(false);
  });

  it("strictly reads and recovers an expired superseded classification owner before claiming the newest revision", async () => {
    const conversation = await createPendingConversation();
    const oldOwner = await claimConversationClassification(
      { conversationId: conversation._id },
      { now: () => T0, createOwnerToken: () => "crashed-old-owner" }
    );
    if (!oldOwner) throw new Error("classification not claimed");
    const mutationAt = new Date("2026-08-10T06:00:01.000Z");
    await Conversation.updateOne(
      { _id: conversation._id },
      buildClassificationInputPendingTransitionPipeline({
        now: mutationAt,
        hasInboundInput: true,
      }),
      { timestamps: false }
    );

    const observed = await readConversationClassificationWakeState(
      conversation._id
    );
    expect(observed).toMatchObject({
      conversationId: String(conversation._id),
      workspaceId: "workspace-integration",
      classificationRevision: 2,
      isClassified: false,
      classificationMeta: null,
      state: {
        contractVersion: 2,
        status: "processing",
        requestedRevision: 2,
        processingRevision: 1,
        appliedRevision: null,
        generation: 2,
        fence: oldOwner.fence,
        requestedAt: mutationAt,
        nextAttemptAt: mutationAt,
        lease: {
          ownerToken: oldOwner.ownerToken,
          claimedAt: T0,
          expiresAt: oldOwner.expiresAt,
        },
      },
    });
    await expect(
      recoverExpiredSupersededConversationClassificationLease(
        {
          observed: {
            conversationId: conversation._id,
            requestedRevision: 2,
            generation: 2,
            processingRevision: 1,
            ownerToken: oldOwner.ownerToken,
            fence: oldOwner.fence,
            expiresAt: oldOwner.expiresAt,
          },
          recoveredAt: new Date(oldOwner.expiresAt.getTime() - 1),
        }
      )
    ).resolves.toBe("not_expired");
    await expect(
      recoverExpiredSupersededConversationClassificationLease(
        {
          observed: {
            conversationId: conversation._id,
            requestedRevision: 2,
            generation: 2,
            processingRevision: 1,
            ownerToken: oldOwner.ownerToken,
            fence: oldOwner.fence,
            expiresAt: oldOwner.expiresAt,
          },
          recoveredAt: oldOwner.expiresAt,
        }
      )
    ).resolves.toBe("recovered");

    const recovered = await readConversationClassificationWakeState(
      conversation._id
    );
    expect(recovered?.state).toMatchObject({
      status: "pending",
      requestedRevision: 2,
      processingRevision: null,
      generation: 2,
      fence: oldOwner.fence,
      nextAttemptAt: oldOwner.expiresAt,
      lease: null,
    });
    const newOwner = await claimConversationClassification(
      { conversationId: conversation._id },
      {
        now: () => oldOwner.expiresAt,
        createOwnerToken: () => "new-current-owner",
      }
    );
    expect(newOwner).toMatchObject({
      revision: 2,
      generation: 2,
      ownerToken: "new-current-owner",
      fence: oldOwner.fence + 1,
    });
    await expect(
      renewConversationClassificationLease(oldOwner, {
        now: () => new Date(oldOwner.expiresAt.getTime() + 1),
      })
    ).resolves.toBeNull();
  });

  it("returns null only for deletion and rejects corrupt current-ready provenance on strict wake reads", async () => {
    const deleted = await createPendingConversation();
    await Conversation.collection.deleteOne({ _id: deleted._id });
    await expect(
      readConversationClassificationWakeState(deleted._id)
    ).resolves.toBeNull();

    const corrupt = await createPendingConversation();
    await Conversation.collection.updateOne(
      { _id: corrupt._id },
      {
        $set: {
          is_classified: true,
          "classification_state.status": "ready",
          "classification_state.appliedRevision": 1,
          "classification_state.nextAttemptAt": null,
          "classification_meta.provenance_kind": "legacy_unknown",
          "classification_meta.source_revision": 1,
          "classification_meta.analysis_revision_id": `${corrupt._id}:1`,
        },
      }
    );
    await expect(
      readConversationClassificationWakeState(corrupt._id)
    ).rejects.toThrow(/classification wake state invariant/i);
  });

  it("refunds an exact media deferral once and rejects the prior owner after reclaim", async () => {
    const conversation = await createPendingConversation({
      classification: { category: "Last good" },
      appliedRevision: 1,
    });
    const original = await claimConversationClassification(
      { conversationId: conversation._id },
      { now: () => T0, createOwnerToken: () => "media-owner-old" }
    );
    expect(original?.attemptCount).toBe(1);
    const recheckAt = new Date("2026-08-10T06:20:00.000Z");

    await expect(
      deferClaimedConversationClassification(
        { lease: original!, recheckAt },
        { now: () => T0 }
      )
    ).resolves.toBe(true);
    const deferred = (await Conversation.collection.findOne({
      _id: conversation._id,
    })) as unknown as {
      classification_revision: number;
      classification?: Record<string, unknown>;
      classification_state: {
        status: string;
        requestedRevision: number;
        processingRevision: number | null;
        attemptRevision: number;
        attemptCount: number;
        generation: number;
        fence: number;
        lease: unknown;
        nextAttemptAt: Date;
        blocked: { code: string; reason: string; recheckAt: Date };
      };
    };
    expect(deferred).toMatchObject({
      classification_revision: 1,
      classification: { category: "Last good" },
      classification_state: {
        status: "blocked",
        requestedRevision: 1,
        processingRevision: null,
        attemptRevision: 1,
        attemptCount: 0,
        generation: 1,
        fence: 1,
        lease: null,
        nextAttemptAt: recheckAt,
        blocked: {
          code: "media_pending",
          reason: "Inbound media analysis is still pending",
          recheckAt,
        },
      },
    });
    await expect(
      deferClaimedConversationClassification(
        { lease: original!, recheckAt },
        { now: () => T0 }
      )
    ).resolves.toBe(false);
    expect(
      (
        (await Conversation.collection.findOne({
          _id: conversation._id,
        })) as unknown as {
          classification_state: { attemptCount: number };
        }
      ).classification_state.attemptCount
    ).toBe(0);

    const reclaimed = await claimConversationClassification(
      { conversationId: conversation._id },
      {
        now: () => recheckAt,
        createOwnerToken: () => "media-owner-new",
      }
    );
    expect(reclaimed).toMatchObject({
      ownerToken: "media-owner-new",
      fence: 2,
      attemptCount: 1,
    });
    await expect(
      deferClaimedConversationClassification(
        {
          lease: original!,
          recheckAt: new Date("2026-08-10T06:40:01.000Z"),
        },
        { now: () => new Date("2026-08-10T06:20:01.000Z") }
      )
    ).resolves.toBe(false);
    expect(
      (
        (await Conversation.collection.findOne({
          _id: conversation._id,
        })) as unknown as {
          classification_state: {
            lease: { ownerToken: string };
            attemptCount: number;
          };
        }
      ).classification_state
    ).toMatchObject({
      lease: { ownerToken: "media-owner-new" },
      attemptCount: 1,
    });
  });

  it("capacity-blocks exact expired processing observations without mutating attempts", async () => {
    const conversation = await createPendingConversation({
      classification: { category: "Last good" },
      appliedRevision: 1,
    });
    const observed = await claimConversationClassification(
      { conversationId: conversation._id },
      { now: () => T0, createOwnerToken: () => "capacity-owner-old" }
    );
    const recheckAt = new Date("2026-08-10T06:15:00.000Z");

    await expect(
      markConversationClassificationBlocked(
        {
          observation: { kind: "expired_processing", lease: observed! },
          code: "company_capacity",
          reason: "Company processing capacity is exhausted",
          recheckAt,
        },
        { now: () => new Date("2026-08-10T06:09:59.000Z") }
      )
    ).resolves.toBe(false);
    await expect(
      markConversationClassificationBlocked(
        {
          observation: { kind: "expired_processing", lease: observed! },
          code: "company_capacity",
          reason: "Company processing capacity is exhausted",
          recheckAt,
        },
        { now: () => new Date("2026-08-10T06:10:00.000Z") }
      )
    ).resolves.toBe(true);

    const blocked = (await Conversation.collection.findOne({
      _id: conversation._id,
    })) as unknown as {
      classification_revision: number;
      classification?: Record<string, unknown>;
      classification_state: {
        status: string;
        requestedRevision: number;
        processingRevision: number | null;
        attemptRevision: number;
        attemptCount: number;
        generation: number;
        fence: number;
        lease: unknown;
      };
    };
    expect(blocked).toMatchObject({
      classification_revision: 1,
      classification: { category: "Last good" },
      classification_state: {
        status: "blocked",
        requestedRevision: 1,
        processingRevision: null,
        attemptRevision: 1,
        attemptCount: 1,
        generation: 1,
        fence: 1,
        lease: null,
      },
    });

    const reclaimed = await claimConversationClassification(
      { conversationId: conversation._id },
      {
        now: () => recheckAt,
        createOwnerToken: () => "capacity-owner-new",
      }
    );
    expect(reclaimed).toMatchObject({
      ownerToken: "capacity-owner-new",
      fence: 2,
      attemptCount: 2,
    });
    await expect(
      markConversationClassificationBlocked(
        {
          observation: { kind: "expired_processing", lease: observed! },
          code: "company_capacity",
          reason: "Company processing capacity is exhausted",
          recheckAt: new Date("2026-08-10T06:25:00.000Z"),
        },
        { now: () => new Date("2026-08-10T06:20:00.000Z") }
      )
    ).resolves.toBe(false);

    const dueRace = await createPendingConversation();
    const dueClaim = await claimConversationClassification(
      { conversationId: dueRace._id },
      { now: () => T0, createOwnerToken: () => "due-race-owner" }
    );
    await expect(
      markConversationClassificationBlocked(
        {
          observation: {
            kind: "due",
            conversationId: dueRace._id,
            revision: 1,
          },
          code: "company_capacity",
          reason: "Company processing capacity is exhausted",
          recheckAt: new Date("2026-08-10T06:05:00.000Z"),
        },
        { now: () => T0 }
      )
    ).resolves.toBe(false);
    expect(
      (
        (await Conversation.collection.findOne({
          _id: dueRace._id,
        })) as unknown as {
          classification_state: {
            status: string;
            lease: { ownerToken: string };
          };
        }
      ).classification_state
    ).toMatchObject({
      status: "processing",
      lease: { ownerToken: dueClaim?.ownerToken },
    });

    const semanticRace = await createPendingConversation();
    const semanticMessageId = new mongoose.Types.ObjectId();
    await Message.collection.insertOne({
      _id: semanticMessageId,
      conversation: semanticRace._id,
      workspaceId: "workspace-integration",
      channel: "whatsapp",
      direction: "inbound",
      date: T0,
      text: "before",
    });
    await Conversation.collection.updateOne(
      { _id: semanticRace._id },
      { $set: { messages: [semanticMessageId] } }
    );
    const semanticObserved = await claimConversationClassification(
      { conversationId: semanticRace._id },
      { now: () => T0, createOwnerToken: () => "semantic-race-old" }
    );
    const scheduleWake = jest.fn().mockResolvedValue(undefined);
    await updateClassificationInputMessageAndInvalidate(
      {
        messageId: semanticMessageId,
        conversationId: semanticRace._id,
        set: { text: "after" },
        semanticPaths: ["text"],
      },
      {
        now: () => new Date("2026-08-10T06:10:00.000Z"),
        scheduleWake,
      }
    );
    await expect(
      markConversationClassificationBlocked(
        {
          observation: {
            kind: "expired_processing",
            lease: semanticObserved!,
          },
          code: "company_capacity",
          reason: "Company processing capacity is exhausted",
          recheckAt: new Date("2026-08-10T06:15:00.000Z"),
        },
        { now: () => new Date("2026-08-10T06:10:01.000Z") }
      )
    ).resolves.toBe(false);
    expect(scheduleWake).toHaveBeenCalledTimes(1);
    expect(
      (await Conversation.collection.findOne({
        _id: semanticRace._id,
      })) as unknown as {
        classification_revision: number;
        classification_state: {
          status: string;
          requestedRevision: number;
          processingRevision: number | null;
          lease: unknown;
        };
      }
    ).toMatchObject({
      classification_revision: 2,
      classification_state: {
        status: "pending",
        requestedRevision: 2,
        processingRevision: null,
        lease: null,
      },
    });
  });

  it("rejects malformed contract-v2 rows instead of repairing them during claim", async () => {
    const expiredAt = new Date("2026-08-10T05:59:00.000Z");
    const validExpiredProcessingState = {
      ...state(),
      status: "processing",
      processingRevision: 1,
      fence: 1,
      nextAttemptAt: null,
      lease: {
        ownerToken: "expired-owner",
        claimedAt: new Date("2026-08-10T05:49:00.000Z"),
        expiresAt: expiredAt,
      },
    };
    const malformedRows: Array<{
      name: string;
      classificationRevision?: number;
      classificationState: Record<string, unknown>;
    }> = [
      {
        name: "unsafe current and requested revision",
        classificationRevision: Number.MAX_SAFE_INTEGER + 1,
        classificationState: {
          ...state(),
          requestedRevision: Number.MAX_SAFE_INTEGER + 1,
          attemptRevision: Number.MAX_SAFE_INTEGER + 1,
        },
      },
      {
        name: "fractional pending fence",
        classificationState: { ...state(), fence: 0.5 },
      },
      {
        name: "non-numeric pending generation",
        classificationState: { ...state(), generation: "1" },
      },
      {
        name: "non-numeric pending attempt revision",
        classificationState: { ...state(), attemptRevision: "1" },
      },
      {
        name: "mismatched expired processing revision",
        classificationState: {
          ...validExpiredProcessingState,
          processingRevision: 2,
        },
      },
      {
        name: "empty expired owner",
        classificationState: {
          ...validExpiredProcessingState,
          lease: {
            ...validExpiredProcessingState.lease,
            ownerToken: "",
          },
        },
      },
      {
        name: "non-positive expired fence",
        classificationState: {
          ...validExpiredProcessingState,
          fence: 0,
        },
      },
      {
        name: "non-date expired lease",
        classificationState: {
          ...validExpiredProcessingState,
          lease: {
            ...validExpiredProcessingState.lease,
            expiresAt: expiredAt.toISOString(),
          },
        },
      },
    ];

    for (const malformed of malformedRows) {
      const conversationId = new mongoose.Types.ObjectId();
      await Conversation.collection.insertOne({
        _id: conversationId,
        workspaceId: "workspace-integration",
        channel: "whatsapp",
        messages: [],
        last_inbound_at: new Date("2026-08-10T05:58:00.000Z"),
        classification_revision: malformed.classificationRevision ?? 1,
        classification_state: malformed.classificationState,
        is_classified: false,
        is_qa_analyzed: false,
        createdAt: T0,
        updatedAt: T0,
      });
      const before = await Conversation.collection.findOne({
        _id: conversationId,
      });

      await expect(
        claimConversationClassification(
          { conversationId },
          {
            now: () => T0,
            createOwnerToken: () => `owner-${malformed.name}`,
          }
        )
      ).resolves.toBeNull();
      expect(
        await Conversation.collection.findOne({ _id: conversationId })
      ).toEqual(before);
    }
  });

  it("commits ready projection and immutable revision atomically", async () => {
    const conversation = await createPendingConversation();
    const lease = await claimConversationClassification(
      { conversationId: conversation._id },
      { now: () => T0, createOwnerToken: () => "ready-owner" }
    );
    const committedAt = new Date("2026-08-10T06:05:00.000Z");
    const committed = await commitConversationClassificationReady(
      {
        lease: lease!,
        workspaceId: "workspace-integration",
        projection,
        provenance,
        effectInputs,
      },
      { now: () => committedAt }
    );

    const stored = await readConversation(conversation._id);
    const revision = await ConversationAnalysisRevision.findById(
      committed.analysisRevisionId
    ).lean();
    expect(stored?.classification_state?.status).toBe("ready");
    expect(stored?.classification_state?.appliedRevision).toBe(1);
    expect(stored?.is_classified).toBe(true);
    expect(stored?.is_qa_analyzed).toBe(true);
    expect(stored?.classification_meta?.analysis_revision_id).toBe(
      committed.analysisRevisionId
    );
    expect(stored?.classification_meta?.provenance_kind).toBe("v2");
    expect(stored?.classification_meta?.source_revision).toBe(1);
    expect(hasCurrentConversationClassification(stored)).toBe(true);
    expect(
      await Conversation.collection.findOne({
        _id: conversation._id,
        ...buildCurrentConversationClassificationFilter(),
      })
    ).not.toBeNull();
    expect(revision).toMatchObject({
      sourceRevision: 1,
      outcome: "ready",
      effectInputs,
      effects: { status: "pending", attemptCount: 0, fence: 0 },
    });
    expect(Object.keys(revision?.effects.checklist ?? {})).toEqual([
      "summary",
      "analytics",
      "realtime",
      "usage",
      "webhook",
    ]);
  });

  it("rejects a ready commit under a workspace different from the Conversation", async () => {
    const conversation = await createPendingConversation();
    const lease = await claimConversationClassification(
      { conversationId: conversation._id },
      { now: () => T0, createOwnerToken: () => "wrong-workspace-owner" }
    );

    await expect(
      commitConversationClassificationReady(
        {
          lease: lease!,
          workspaceId: "workspace-other",
          projection,
          provenance,
          effectInputs,
        },
        { now: () => new Date("2026-08-10T06:01:00.000Z") }
      )
    ).rejects.toThrow("stale");
    expect(await ConversationAnalysisRevision.countDocuments()).toBe(0);
    expect(
      (await readConversation(conversation._id))?.classification_state?.status
    ).toBe("processing");
  });

  it.each([
    [
      "missing analysis id",
      { $unset: { "classification_meta.analysis_revision_id": "" } },
    ],
    [
      "blank analysis id",
      { $set: { "classification_meta.analysis_revision_id": " \t " } },
    ],
    [
      "legacy provenance",
      { $set: { "classification_meta.provenance_kind": "legacy_unknown" } },
    ],
    [
      "requested revision mismatch",
      { $set: { "classification_state.requestedRevision": 2 } },
    ],
    [
      "applied revision mismatch",
      { $set: { "classification_state.appliedRevision": 2 } },
    ],
    [
      "source revision mismatch",
      { $set: { "classification_meta.source_revision": 2 } },
    ],
  ] as const)(
    "rejects current-ready rows with %s",
    async (_name, corruption) => {
      const conversation = await createPendingConversation();
      const lease = await claimConversationClassification(
        { conversationId: conversation._id },
        { now: () => T0, createOwnerToken: () => `freshness-${_name}` }
      );
      await commitConversationClassificationReady(
        {
          lease: lease!,
          workspaceId: "workspace-integration",
          projection,
          provenance,
          effectInputs,
        },
        { now: () => new Date("2026-08-10T06:01:00.000Z") }
      );
      await Conversation.collection.updateOne(
        { _id: conversation._id },
        corruption
      );

      const stored = await readConversation(conversation._id);
      expect(hasCurrentConversationClassification(stored)).toBe(false);
      expect(
        await Conversation.collection.findOne({
          _id: conversation._id,
          ...buildCurrentConversationClassificationFilter(),
        })
      ).toBeNull();
    }
  );

  it("rolls back the ready projection when only immutable effect inputs conflict", async () => {
    const conversation = await createPendingConversation();
    const lease = await claimConversationClassification(
      { conversationId: conversation._id },
      { now: () => T0, createOwnerToken: () => "conflict-owner" }
    );
    const id = buildConversationAnalysisRevisionId({
      conversationId: String(conversation._id),
      sourceRevision: 1,
    });
    const completedAt = new Date("2026-08-10T06:05:00.000Z");
    await ConversationAnalysisRevision.create({
      _id: id,
      conversationId: conversation._id,
      workspaceId: "workspace-integration",
      sourceRevision: 1,
      completedAt,
      outcome: "ready",
      projection,
      review: null,
      effectInputs: { ...effectInputs, processingTimeMs: 1_251 },
      provenance,
      effects: {
        status: "pending",
        attemptCount: 0,
        fence: 0,
        nextAttemptAt: completedAt,
        completedAt: null,
        lease: null,
        checklist: {
          summary: null,
          analytics: null,
          realtime: null,
          usage: null,
          webhook: null,
        },
      },
    });

    await expect(
      commitConversationClassificationReady(
        {
          lease: lease!,
          workspaceId: "workspace-integration",
          projection,
          provenance,
          effectInputs,
        },
        { now: () => completedAt }
      )
    ).rejects.toThrow("conflicts with immutable data");
    const stored = await readConversation(conversation._id);
    expect(stored?.classification_state?.status).toBe("processing");
    expect(stored?.classification?.category).toBeUndefined();
  });

  it("makes an old ready CAS stale after a newer semantic request", async () => {
    const conversation = await createPendingConversation();
    const lease = await claimConversationClassification(
      { conversationId: conversation._id },
      { now: () => T0, createOwnerToken: () => "stale-owner" }
    );
    const requestedAt = new Date("2026-08-10T06:01:00.000Z");
    await Conversation.updateOne(
      { _id: conversation._id },
      buildClassificationInputPendingTransitionPipeline({
        now: requestedAt,
        hasInboundInput: true,
      }),
      { timestamps: false }
    );

    await expect(
      commitConversationClassificationReady(
        {
          lease: lease!,
          workspaceId: "workspace-integration",
          projection,
          provenance,
          effectInputs,
        },
        { now: () => new Date("2026-08-10T06:02:00.000Z") }
      )
    ).rejects.toThrow("stale");
    expect(await ConversationAnalysisRevision.countDocuments()).toBe(0);
    const stored = await readConversation(conversation._id);
    expect(stored?.classification_revision).toBe(2);
    expect(stored?.classification_state?.requestedRevision).toBe(2);
    expect(stored?.classification_state?.status).toBe("processing");
  });

  it("records review-required without replacing the last good output or pending effects", async () => {
    const lastGood = {
      category: "Sales",
      priority: "low",
      sentiment: "positive",
      summary: "Earlier accepted result.",
      action: "Keep helping.",
      tags: [],
      confidence: { category: 0.8, priority: 0.8, sentiment: 0.8 },
    };
    const conversation = await createPendingConversation({
      classification: lastGood,
      appliedRevision: 1,
    });
    const lastGoodMeta = {
      provenance_kind: "legacy_unknown",
      taxonomy_id: "taxonomy-legacy",
      taxonomy_digest: "digest-legacy",
      classifier_version: "classifier-legacy",
      classifier_contract_revision: 1,
      source_revision: 1,
      analysis_revision_id: "legacy-analysis-1",
      completed_at: new Date("2026-08-09T06:00:00.000Z"),
    };
    await Conversation.collection.updateOne(
      { _id: conversation._id },
      {
        $set: {
          classification_meta: lastGoodMeta,
          internal_labels: ["manual:vip"],
        },
      }
    );
    const lease = await claimConversationClassification(
      { conversationId: conversation._id },
      { now: () => T0, createOwnerToken: () => "review-owner" }
    );
    const result = await commitConversationClassificationReviewRequired(
      {
        lease: lease!,
        workspaceId: "workspace-integration",
        review: { code: "provider_safety", reason: "Human review required" },
        provenance,
      },
      { now: () => new Date("2026-08-10T06:03:00.000Z") }
    );

    const stored = await readConversation(conversation._id);
    const revision = await ConversationAnalysisRevision.findById(
      result.analysisRevisionId
    ).lean();
    expect(stored?.classification).toMatchObject(lastGood);
    expect(stored?.classification_meta).toMatchObject(lastGoodMeta);
    expect(stored?.internal_labels).toEqual(["manual:vip"]);
    expect(stored?.classification_state?.appliedRevision).toBe(1);
    expect(stored?.classification_state?.status).toBe("review_required");
    expect(stored?.is_classified).toBe(false);
    expect(revision?.outcome).toBe("review_required");
    expect(revision?.effectInputs).toBeNull();
    expect(revision?.effects.status).toBe("not_applicable");
    expect(revision?.effects.nextAttemptAt).toBeNull();
    expect(Object.keys(revision?.effects.checklist ?? {})).toEqual([
      "summary",
      "analytics",
      "realtime",
      "usage",
      "webhook",
    ]);
    expect(Object.values(revision?.effects.checklist ?? {})).toEqual([
      null,
      null,
      null,
      null,
      null,
    ]);
    expect(hasCurrentConversationClassification(stored)).toBe(false);
  });

  it("commits Message semantic input and Conversation revision together", async () => {
    const conversation = await createPendingConversation();
    const messageId = new mongoose.Types.ObjectId();
    const requestedAt = new Date("2026-08-10T06:01:00.000Z");
    const scheduleWake = jest.fn().mockResolvedValue(undefined);
    await Message.collection.insertOne({
      _id: messageId,
      conversation: conversation._id,
      workspaceId: "workspace-integration",
      channel: "whatsapp",
      direction: "inbound",
      date: T0,
      text: "before",
    });
    await Conversation.collection.updateOne(
      { _id: conversation._id },
      { $set: { messages: [messageId] } }
    );

    const changed = await updateClassificationInputMessageAndInvalidate(
      {
        messageId,
        conversationId: conversation._id,
        set: { text: "after" },
        semanticPaths: ["text"],
      },
      { now: () => requestedAt, scheduleWake }
    );
    expect(changed).toMatchObject({
      semanticChanged: true,
      requestedRevision: 2,
    });
    expect((await readMessage(messageId))?.text).toBe("after");
    expect(
      (await readConversation(conversation._id))?.classification_revision
    ).toBe(2);

    const unchanged = await updateClassificationInputMessageAndInvalidate(
      {
        messageId,
        conversationId: conversation._id,
        set: { text: "after", "mediaAnalysis.status": "completed" },
        semanticPaths: ["text"],
      },
      {
        now: () => new Date("2026-08-10T06:02:00.000Z"),
        scheduleWake,
      }
    );
    expect(unchanged).toEqual({ semanticChanged: false });
    expect(
      (await readConversation(conversation._id))?.classification_revision
    ).toBe(2);
    expect(scheduleWake).toHaveBeenCalledTimes(1);
    expect(scheduleWake).toHaveBeenCalledWith({
      conversationId: String(conversation._id),
      requestedRevision: 2,
      generation: 2,
      requestedAt,
    });
  });

  it("lets image semantic completion invalidate an old ready CAS without partial projection", async () => {
    const conversation = await createPendingConversation();
    const messageId = new mongoose.Types.ObjectId();
    await Message.collection.insertOne({
      _id: messageId,
      conversation: conversation._id,
      workspaceId: "workspace-integration",
      channel: "whatsapp",
      direction: "inbound",
      date: T0,
      text: "See the attached product",
      imageUrl: "https://cdn.example.com/product.jpg",
      imageAnalysis: null,
    });
    await Conversation.collection.updateOne(
      { _id: conversation._id },
      { $set: { messages: [messageId] } }
    );
    const lease = await claimConversationClassification(
      { conversationId: conversation._id },
      { now: () => T0, createOwnerToken: () => "image-old-owner" }
    );
    const scheduleWake = jest.fn().mockResolvedValue(undefined);

    await expect(
      updateClassificationInputMessageAndInvalidate(
        {
          messageId,
          conversationId: conversation._id,
          set: { imageAnalysis: "A blue product package." },
          semanticPaths: ["imageAnalysis"],
        },
        {
          now: () => new Date("2026-08-10T06:00:30.000Z"),
          scheduleWake,
        }
      )
    ).resolves.toMatchObject({ semanticChanged: true, requestedRevision: 2 });
    await expect(
      commitConversationClassificationReady(
        {
          lease: lease!,
          workspaceId: "workspace-integration",
          projection,
          provenance,
          effectInputs,
        },
        { now: () => new Date("2026-08-10T06:00:31.000Z") }
      )
    ).rejects.toThrow("Ready classification lease is stale");

    expect(scheduleWake).toHaveBeenCalledTimes(1);
    expect(
      (await Message.collection.findOne({ _id: messageId }))?.imageAnalysis
    ).toBe("A blue product package.");
    const stored = await readConversation(conversation._id);
    expect(stored).toMatchObject({
      classification_revision: 2,
      classification_state: {
        status: "processing",
        requestedRevision: 2,
      },
      is_classified: false,
      is_qa_analyzed: false,
    });
    expect(stored?.classification).toBeNull();
    expect(
      await ConversationAnalysisRevision.countDocuments({
        conversationId: conversation._id,
      })
    ).toBe(0);
  });

  it("rolls back Message semantic data when Conversation invalidation misses", async () => {
    const missingConversationId = new mongoose.Types.ObjectId();
    const messageId = new mongoose.Types.ObjectId();
    await Message.collection.insertOne({
      _id: messageId,
      conversation: missingConversationId,
      workspaceId: "workspace-integration",
      channel: "whatsapp",
      direction: "inbound",
      date: T0,
      text: "before",
    });

    const scheduleWake = jest.fn().mockResolvedValue(undefined);
    await expect(
      updateClassificationInputMessageAndInvalidate(
        {
          messageId,
          conversationId: missingConversationId,
          set: { text: "after" },
          semanticPaths: ["text"],
        },
        { scheduleWake }
      )
    ).rejects.toThrow("Conversation input invalidation did not match");
    expect((await readMessage(messageId))?.text).toBe("before");
    expect(scheduleWake).not.toHaveBeenCalled();
  });

  it("increments one revision for concurrent identical semantic patches", async () => {
    const conversation = await createPendingConversation();
    const messageId = new mongoose.Types.ObjectId();
    const requestedAt = new Date("2026-08-10T06:01:00.000Z");
    const scheduleWake = jest.fn().mockResolvedValue(undefined);
    await Message.collection.insertOne({
      _id: messageId,
      conversation: conversation._id,
      workspaceId: "workspace-integration",
      channel: "whatsapp",
      direction: "inbound",
      date: T0,
      text: "before",
    });
    await Conversation.collection.updateOne(
      { _id: conversation._id },
      { $set: { messages: [messageId] } }
    );
    const results = await Promise.all([
      updateClassificationInputMessageAndInvalidate(
        {
          messageId,
          conversationId: conversation._id,
          set: { text: "after" },
          semanticPaths: ["text"],
        },
        { now: () => requestedAt, scheduleWake }
      ),
      updateClassificationInputMessageAndInvalidate(
        {
          messageId,
          conversationId: conversation._id,
          set: { text: "after" },
          semanticPaths: ["text"],
        },
        { now: () => requestedAt, scheduleWake }
      ),
    ]);

    expect(results.filter(result => result.semanticChanged)).toHaveLength(1);
    expect(
      (await readConversation(conversation._id))?.classification_revision
    ).toBe(2);
    expect(scheduleWake).toHaveBeenCalledTimes(1);
    expect(scheduleWake).toHaveBeenCalledWith({
      conversationId: String(conversation._id),
      requestedRevision: 2,
      generation: 2,
      requestedAt,
    });
  });

  it("requeues once for concurrent identical media semantic completion", async () => {
    const conversation = await createPendingConversation();
    const messageId = new mongoose.Types.ObjectId();
    await Message.collection.insertOne({
      _id: messageId,
      conversation: conversation._id,
      workspaceId: "workspace-integration",
      channel: "whatsapp",
      direction: "inbound",
      date: T0,
      text: "",
      mediaType: "voice",
      audioAnalysis: null,
      mediaAnalysis: { status: "submitted", providerRequestId: "request-1" },
    });
    await Conversation.collection.updateOne(
      { _id: conversation._id },
      { $set: { messages: [messageId] } }
    );
    const scheduleWake = jest.fn().mockResolvedValue(undefined);
    const mutation = () =>
      updateClassificationInputMessageAndInvalidate(
        {
          messageId,
          conversationId: conversation._id,
          set: {
            text: "Where is my order?",
            audioAnalysis: "Customer asks for order status.",
            "mediaAnalysis.status": "completed",
            "mediaAnalysis.completedAt": new Date("2026-08-10T06:02:00.000Z"),
          },
          semanticPaths: ["audioAnalysis", "text"],
        },
        { scheduleWake }
      );

    const results = await Promise.all([mutation(), mutation()]);

    expect(results.filter(result => result.semanticChanged)).toHaveLength(1);
    expect(scheduleWake).toHaveBeenCalledTimes(1);
    expect(
      (await Conversation.collection.findOne({ _id: conversation._id }))
        ?.classification_revision
    ).toBe(2);
    expect(await Message.collection.findOne({ _id: messageId })).toMatchObject({
      text: "Where is my order?",
      audioAnalysis: "Customer asks for order status.",
      mediaAnalysis: {
        status: "completed",
        completedAt: new Date("2026-08-10T06:02:00.000Z"),
      },
    });
  });

  it("resumes incomplete effects and supersedes them after newer input", async () => {
    const conversation = await createPendingConversation();
    const classificationLease = await claimConversationClassification(
      { conversationId: conversation._id },
      { now: () => T0, createOwnerToken: () => "classifier-owner" }
    );
    const ready = await commitConversationClassificationReady(
      {
        lease: classificationLease!,
        workspaceId: "workspace-integration",
        projection,
        provenance,
        effectInputs,
      },
      { now: () => new Date("2026-08-10T06:01:00.000Z") }
    );
    const first = await claimConversationAnalysisEffects(
      { analysisRevisionId: ready.analysisRevisionId },
      {
        now: () => new Date("2026-08-10T06:01:00.000Z"),
        createOwnerToken: () => "effects-owner-1",
      }
    );
    expect(first?.status).toBe("claimed");
    if (!first || first.status !== "claimed")
      throw new Error("effects not claimed");
    expect(
      await completeConversationAnalysisEffectStep(
        { lease: first.lease, step: "summary" },
        { now: () => new Date("2026-08-10T06:01:10.000Z") }
      )
    ).toBe("completed");
    expect(
      await recordConversationAnalysisEffectsFailure(
        { lease: first.lease },
        { now: () => new Date("2026-08-10T06:01:20.000Z") }
      )
    ).toMatchObject({ status: "retry_scheduled" });

    const second = await claimConversationAnalysisEffects(
      { analysisRevisionId: ready.analysisRevisionId },
      {
        now: () => new Date("2026-08-10T06:02:20.000Z"),
        createOwnerToken: () => "effects-owner-2",
      }
    );
    if (!second || second.status !== "claimed")
      throw new Error("retry not claimed");
    expect(
      await authorizeConversationAnalysisEffectStep(
        { lease: second.lease, step: "summary" },
        { now: () => new Date("2026-08-10T06:02:21.000Z") }
      )
    ).toBe("already_completed");

    await Conversation.updateOne(
      { _id: conversation._id },
      buildClassificationInputPendingTransitionPipeline({
        now: new Date("2026-08-10T06:02:22.000Z"),
        hasInboundInput: true,
      }),
      { timestamps: false }
    );
    expect(
      await authorizeConversationAnalysisEffectStep(
        { lease: second.lease, step: "analytics" },
        { now: () => new Date("2026-08-10T06:02:23.000Z") }
      )
    ).toBe("superseded");
    const revision = await ConversationAnalysisRevision.findById(
      ready.analysisRevisionId
    ).lean();
    expect(revision?.effects.status).toBe("superseded");
    expect(revision?.effects.checklist.summary).toBeInstanceOf(Date);
    expect(revision?.effects.checklist.analytics).toBeNull();
  });

  it("does not renew an effects lease after its ready revision becomes stale", async () => {
    const conversation = await createPendingConversation();
    const classificationLease = await claimConversationClassification(
      { conversationId: conversation._id },
      { now: () => T0, createOwnerToken: () => "classifier-owner" }
    );
    const ready = await commitConversationClassificationReady(
      {
        lease: classificationLease!,
        workspaceId: "workspace-integration",
        projection,
        provenance,
        effectInputs,
      },
      { now: () => new Date("2026-08-10T06:01:00.000Z") }
    );
    const effects = await claimConversationAnalysisEffects(
      { analysisRevisionId: ready.analysisRevisionId },
      {
        now: () => new Date("2026-08-10T06:01:00.000Z"),
        createOwnerToken: () => "effects-owner",
      }
    );
    if (!effects || effects.status !== "claimed") {
      throw new Error("effects not claimed");
    }
    const originalExpiry = effects.lease.expiresAt;

    await Conversation.updateOne(
      { _id: conversation._id },
      buildClassificationInputPendingTransitionPipeline({
        now: new Date("2026-08-10T06:02:00.000Z"),
        hasInboundInput: true,
      }),
      { timestamps: false }
    );

    await expect(
      renewConversationAnalysisEffectsLease(effects.lease, {
        now: () => new Date("2026-08-10T06:03:00.000Z"),
      })
    ).resolves.toEqual({ status: "superseded" });
    const revision = await ConversationAnalysisRevision.findById(
      ready.analysisRevisionId
    ).lean();
    expect(revision?.effects).toMatchObject({
      status: "superseded",
      completedAt: new Date("2026-08-10T06:03:00.000Z"),
      nextAttemptAt: null,
      lease: null,
    });
    expect(originalExpiry).toEqual(new Date("2026-08-10T06:11:00.000Z"));
  });

  it("supersedes an owned effects lease after current provenance is corrupted", async () => {
    const conversation = await createPendingConversation();
    const classificationLease = await claimConversationClassification(
      { conversationId: conversation._id },
      { now: () => T0, createOwnerToken: () => "classifier-owner" }
    );
    const ready = await commitConversationClassificationReady(
      {
        lease: classificationLease!,
        workspaceId: "workspace-integration",
        projection,
        provenance,
        effectInputs,
      },
      { now: () => new Date("2026-08-10T06:01:00.000Z") }
    );
    const effects = await claimConversationAnalysisEffects(
      { analysisRevisionId: ready.analysisRevisionId },
      {
        now: () => new Date("2026-08-10T06:01:00.000Z"),
        createOwnerToken: () => "effects-owner",
      }
    );
    if (!effects || effects.status !== "claimed") {
      throw new Error("effects not claimed");
    }
    await Conversation.collection.updateOne(
      { _id: conversation._id },
      { $set: { "classification_meta.provenance_kind": "legacy_unknown" } }
    );

    await expect(
      renewConversationAnalysisEffectsLease(effects.lease, {
        now: () => new Date("2026-08-10T06:02:00.000Z"),
      })
    ).resolves.toEqual({ status: "superseded" });
  });

  it("reclaims expired effects with a larger fence and rejects the prior owner", async () => {
    const conversation = await createPendingConversation();
    const classificationLease = await claimConversationClassification(
      { conversationId: conversation._id },
      { now: () => T0, createOwnerToken: () => "classifier-owner" }
    );
    const ready = await commitConversationClassificationReady(
      {
        lease: classificationLease!,
        workspaceId: "workspace-integration",
        projection,
        provenance,
        effectInputs,
      },
      { now: () => T0 }
    );
    const first = await claimConversationAnalysisEffects(
      { analysisRevisionId: ready.analysisRevisionId },
      { now: () => T0, createOwnerToken: () => "effects-old" }
    );
    if (!first || first.status !== "claimed")
      throw new Error("effects not claimed");
    const second = await claimConversationAnalysisEffects(
      { analysisRevisionId: ready.analysisRevisionId },
      {
        now: () => new Date("2026-08-10T06:10:00.000Z"),
        createOwnerToken: () => "effects-new",
      }
    );
    if (!second || second.status !== "claimed")
      throw new Error("effects not reclaimed");
    expect(second.lease.fence).toBe(first.lease.fence + 1);
    expect(
      await renewConversationAnalysisEffectsLease(first.lease, {
        now: () => new Date("2026-08-10T06:10:01.000Z"),
      })
    ).toEqual({ status: "lease_lost" });
    expect(
      await completeConversationAnalysisEffectStep(
        { lease: first.lease, step: "summary" },
        { now: () => new Date("2026-08-10T06:10:01.000Z") }
      )
    ).toBe("lease_lost");
  });

  it("uses authoritative time rather than a caller completion timestamp for effect fencing", async () => {
    const conversation = await createPendingConversation();
    const classificationLease = await claimConversationClassification(
      { conversationId: conversation._id },
      { now: () => T0, createOwnerToken: () => "classifier-owner" }
    );
    const ready = await commitConversationClassificationReady(
      {
        lease: classificationLease!,
        workspaceId: "workspace-integration",
        projection,
        provenance,
        effectInputs,
      },
      { now: () => T0 }
    );
    const effects = await claimConversationAnalysisEffects(
      { analysisRevisionId: ready.analysisRevisionId },
      { now: () => T0, createOwnerToken: () => "effects-owner" }
    );
    if (!effects || effects.status !== "claimed")
      throw new Error("effects not claimed");

    expect(
      await completeConversationAnalysisEffectStep(
        {
          lease: effects.lease,
          step: "summary",
          completedAt: new Date("2026-08-10T06:00:01.000Z"),
        },
        { now: () => new Date("2026-08-10T06:10:01.000Z") }
      )
    ).toBe("lease_lost");
  });

  it("marks stale owned effects superseded when failure or terminal completion arrives", async () => {
    for (const operation of ["failure", "completion"] as const) {
      const conversation = await createPendingConversation();
      const classificationLease = await claimConversationClassification(
        { conversationId: conversation._id },
        {
          now: () => T0,
          createOwnerToken: () => `classifier-${operation}`,
        }
      );
      const ready = await commitConversationClassificationReady(
        {
          lease: classificationLease!,
          workspaceId: "workspace-integration",
          projection,
          provenance,
          effectInputs,
        },
        { now: () => T0 }
      );
      const effects = await claimConversationAnalysisEffects(
        { analysisRevisionId: ready.analysisRevisionId },
        {
          now: () => T0,
          createOwnerToken: () => `effects-${operation}`,
        }
      );
      if (!effects || effects.status !== "claimed") {
        throw new Error("effects not claimed");
      }
      await Conversation.updateOne(
        { _id: conversation._id },
        buildClassificationInputPendingTransitionPipeline({
          now: new Date("2026-08-10T06:00:01.000Z"),
          hasInboundInput: true,
        }),
        { timestamps: false }
      );

      const outcome =
        operation === "failure"
          ? await recordConversationAnalysisEffectsFailure(
              { lease: effects.lease },
              { now: () => new Date("2026-08-10T06:00:02.000Z") }
            )
          : await completeConversationAnalysisEffects(
              { lease: effects.lease },
              { now: () => new Date("2026-08-10T06:00:02.000Z") }
            );
      expect(typeof outcome === "string" ? outcome : outcome.status).toBe(
        "superseded"
      );
      expect(
        (
          await ConversationAnalysisRevision.findById(
            ready.analysisRevisionId
          ).lean()
        )?.effects.status
      ).toBe("superseded");
    }
  });

  it("allows only one dispatcher to own a live effects row", async () => {
    const { ready } = await createReadyAnalysis();
    const clock = { current: new Date("2026-08-10T06:01:01.000Z") };
    let releaseSummary!: () => void;
    const summaryGate = new Promise<void>(resolve => {
      releaseSummary = resolve;
    });
    let summaryStarted!: () => void;
    const summaryStartedPromise = new Promise<void>(resolve => {
      summaryStarted = resolve;
    });
    const first = realMongoEffectsDependencies({
      now: clock,
      ownerToken: "dispatcher-owner-1",
      summary: jest.fn(async () => {
        summaryStarted();
        await summaryGate;
        return { status: "completed" as const };
      }),
    });
    const second = realMongoEffectsDependencies({
      now: clock,
      ownerToken: "dispatcher-owner-2",
    });

    const firstDispatch = dispatchConversationClassificationEffects(
      { analysisRevisionId: ready.analysisRevisionId },
      first.dependencies
    );
    await summaryStartedPromise;
    await expect(
      dispatchConversationClassificationEffects(
        { analysisRevisionId: ready.analysisRevisionId },
        second.dependencies
      )
    ).resolves.toEqual({ status: "lease_lost" });
    expect(second.summary).not.toHaveBeenCalled();
    releaseSummary();
    await expect(firstDispatch).resolves.toEqual({ status: "completed" });
  });

  it("supersedes a dispatcher when the Conversation revision changes during a long sink", async () => {
    const { conversation, ready } = await createReadyAnalysis();
    const clock = { current: new Date("2026-08-10T06:01:01.000Z") };
    let releaseSummary!: () => void;
    const summaryGate = new Promise<void>(resolve => {
      releaseSummary = resolve;
    });
    let summaryStarted!: () => void;
    const summaryStartedPromise = new Promise<void>(resolve => {
      summaryStarted = resolve;
    });
    const runtime = realMongoEffectsDependencies({
      now: clock,
      ownerToken: "long-sink-owner",
      summary: jest.fn(async () => {
        summaryStarted();
        await summaryGate;
        return { status: "completed" as const };
      }),
    });

    const dispatch = dispatchConversationClassificationEffects(
      { analysisRevisionId: ready.analysisRevisionId },
      runtime.dependencies
    );
    await summaryStartedPromise;
    await Conversation.updateOne(
      { _id: conversation._id },
      buildClassificationInputPendingTransitionPipeline({
        now: new Date("2026-08-10T06:01:02.000Z"),
        hasInboundInput: true,
      }),
      { timestamps: false }
    );
    releaseSummary();

    await expect(dispatch).resolves.toEqual({ status: "superseded" });
    expect(runtime.analytics).not.toHaveBeenCalled();
    const revision = await ConversationAnalysisRevision.findById(
      ready.analysisRevisionId
    ).lean();
    expect(revision?.effects.status).toBe("superseded");
    expect(revision?.effects.checklist.summary).toBeNull();
  });

  it("reclaims an expired dispatcher while preserving completed checklist commits through global failure", async () => {
    const { ready } = await createReadyAnalysis(T0);
    const prior = await claimConversationAnalysisEffects(
      { analysisRevisionId: ready.analysisRevisionId },
      { now: () => T0, createOwnerToken: () => "expired-effects-owner" }
    );
    if (prior.status !== "claimed") throw new Error("effects not claimed");
    await expect(
      completeConversationAnalysisEffectStep(
        { lease: prior.lease, step: "summary" },
        { now: () => new Date("2026-08-10T06:00:01.000Z") }
      )
    ).resolves.toBe("completed");

    const clock = { current: new Date("2026-08-10T06:10:00.000Z") };
    const runtime = realMongoEffectsDependencies({
      now: clock,
      ownerToken: "reclaimed-effects-owner",
      analytics: jest.fn(async () => {
        throw new Error("analytics unavailable");
      }),
    });
    await expect(
      dispatchConversationClassificationEffects(
        { analysisRevisionId: ready.analysisRevisionId },
        runtime.dependencies
      )
    ).resolves.toEqual({
      status: "retry_scheduled",
      nextAttemptAt: new Date("2026-08-10T06:15:00.000Z"),
    });
    expect(runtime.summary).not.toHaveBeenCalled();
    const revision = await ConversationAnalysisRevision.findById(
      ready.analysisRevisionId
    ).lean();
    expect(revision?.effects).toMatchObject({
      status: "failed",
      attemptCount: 2,
      fence: 2,
      nextAttemptAt: new Date("2026-08-10T06:15:00.000Z"),
      lease: null,
    });
    expect(revision?.effects.checklist.summary).toBeInstanceOf(Date);
    expect(revision?.effects.checklist.analytics).toBeNull();
    expect(revision?.effects.checklist.realtime).toBeInstanceOf(Date);
    expect(revision?.effects.checklist.usage).toBeInstanceOf(Date);
    expect(revision?.effects.checklist.webhook).toBeInstanceOf(Date);
    await expect(
      renewConversationAnalysisEffectsLease(prior.lease, {
        now: () => new Date("2026-08-10T06:10:01.000Z"),
      })
    ).resolves.toEqual({ status: "lease_lost" });
  });

  it("requires all five checklist dates before terminal completion", async () => {
    const { ready } = await createReadyAnalysis(T0);
    const claimed = await claimConversationAnalysisEffects(
      { analysisRevisionId: ready.analysisRevisionId },
      { now: () => T0, createOwnerToken: () => "terminal-owner" }
    );
    if (claimed.status !== "claimed") throw new Error("effects not claimed");

    await expect(
      completeConversationAnalysisEffects(
        { lease: claimed.lease },
        { now: () => new Date("2026-08-10T06:00:01.000Z") }
      )
    ).resolves.toBe("incomplete");
    for (const step of CONVERSATION_ANALYSIS_EFFECT_STEPS) {
      await expect(
        completeConversationAnalysisEffectStep(
          { lease: claimed.lease, step },
          { now: () => new Date("2026-08-10T06:00:02.000Z") }
        )
      ).resolves.toBe("completed");
    }
    await expect(
      completeConversationAnalysisEffects(
        { lease: claimed.lease },
        { now: () => new Date("2026-08-10T06:00:03.000Z") }
      )
    ).resolves.toBe("completed");
  });

  it("marks only exact classification and current-ready effects wake identities", async () => {
    const pending = await createPendingConversation();
    const classificationEnqueuedAt = new Date("2026-08-10T06:00:01.000Z");
    await expect(
      markConversationClassificationEnqueued({
        conversationId: pending._id,
        revision: 1,
        generation: 1,
        marker: { kind: "classification" },
        enqueuedAt: classificationEnqueuedAt,
      })
    ).resolves.toBe(true);
    await expect(
      markConversationClassificationEnqueued({
        conversationId: pending._id,
        revision: 1,
        generation: 1,
        marker: { kind: "effects", analysisRevisionId: `${pending._id}:1` },
      })
    ).resolves.toBe(false);

    const { conversation, ready } = await createReadyAnalysis(T0);
    await expect(
      markConversationClassificationEnqueued({
        conversationId: conversation._id,
        revision: 1,
        generation: 1,
        marker: { kind: "classification" },
      })
    ).resolves.toBe(false);
    await expect(
      markConversationClassificationEnqueued({
        conversationId: conversation._id,
        revision: 1,
        generation: 1,
        marker: {
          kind: "effects",
          analysisRevisionId: `${conversation._id}:999`,
        },
      })
    ).resolves.toBe(false);
    await expect(
      markConversationClassificationEnqueued({
        conversationId: conversation._id,
        revision: 1,
        generation: 1,
        marker: {
          kind: "effects",
          analysisRevisionId: ready.analysisRevisionId,
        },
      })
    ).resolves.toBe(true);
  });

  it("reconciles the scanned immutable stale effects identity behind a newer ready revision", async () => {
    const old = await createReadyAnalysis(T0);
    await Conversation.updateOne(
      { _id: old.conversation._id },
      buildClassificationInputPendingTransitionPipeline({
        now: new Date("2026-08-10T06:00:01.000Z"),
        hasInboundInput: true,
      }),
      { timestamps: false }
    );
    const newerLease = await claimConversationClassification(
      { conversationId: old.conversation._id },
      {
        now: () => new Date("2026-08-10T06:00:01.000Z"),
        createOwnerToken: () => "newer-classifier",
      }
    );
    if (!newerLease) throw new Error("newer classification not claimed");
    const newer = await commitConversationClassificationReady(
      {
        lease: newerLease,
        workspaceId: "workspace-integration",
        projection,
        provenance,
        effectInputs,
      },
      { now: () => new Date("2026-08-10T06:00:02.000Z") }
    );
    expect(
      (
        (await Conversation.collection.findOne({
          _id: old.conversation._id,
        })) as StoredConversation
      ).classification_meta?.analysis_revision_id
    ).toBe(newer.analysisRevisionId);

    await expect(
      reconcileSupersededConversationAnalysisEffects(
        {
          analysisRevisionId: old.ready.analysisRevisionId,
          observed: { status: "pending", nextAttemptAt: T0, fence: 0 },
        },
        { now: () => new Date("2026-08-10T06:00:03.000Z") }
      )
    ).resolves.toBe("superseded");
    expect(
      (
        await ConversationAnalysisRevision.findById(
          old.ready.analysisRevisionId
        ).lean()
      )?.effects
    ).toMatchObject({
      status: "superseded",
      attemptCount: 0,
      fence: 0,
      nextAttemptAt: null,
      lease: null,
    });
    expect(
      (
        await ConversationAnalysisRevision.findById(
          newer.analysisRevisionId
        ).lean()
      )?.effects.status
    ).toBe("pending");
  });

  it("fence-terminalizes only the exact expired stale processing effects observation", async () => {
    const old = await createReadyAnalysis(T0);
    const claimed = await claimConversationAnalysisEffects(
      { analysisRevisionId: old.ready.analysisRevisionId },
      { now: () => T0, createOwnerToken: () => "expired-stale-effects" }
    );
    if (claimed.status !== "claimed") throw new Error("effects not claimed");
    await Conversation.updateOne(
      { _id: old.conversation._id },
      buildClassificationInputPendingTransitionPipeline({
        now: new Date("2026-08-10T06:00:01.000Z"),
        hasInboundInput: true,
      }),
      { timestamps: false }
    );

    await expect(
      reconcileSupersededConversationAnalysisEffects(
        {
          analysisRevisionId: old.ready.analysisRevisionId,
          observed: {
            status: "processing",
            expiresAt: new Date(claimed.lease.expiresAt.getTime() - 1),
            fence: claimed.lease.fence,
          },
        },
        { now: () => claimed.lease.expiresAt }
      )
    ).resolves.toBe("changed");
    await expect(
      reconcileSupersededConversationAnalysisEffects(
        {
          analysisRevisionId: old.ready.analysisRevisionId,
          observed: {
            status: "processing",
            expiresAt: claimed.lease.expiresAt,
            fence: claimed.lease.fence,
          },
        },
        { now: () => claimed.lease.expiresAt }
      )
    ).resolves.toBe("superseded");
    expect(
      (
        await ConversationAnalysisRevision.findById(
          old.ready.analysisRevisionId
        ).lean()
      )?.effects
    ).toMatchObject({
      status: "superseded",
      attemptCount: claimed.lease.attemptCount,
      fence: claimed.lease.fence + 1,
      nextAttemptAt: null,
      lease: null,
    });
    await expect(
      claimConversationAnalysisEffects({
        analysisRevisionId: old.ready.analysisRevisionId,
      })
    ).resolves.toEqual({ status: "superseded" });
    await expect(
      renewConversationAnalysisEffectsLease(claimed.lease, {
        now: () => new Date(claimed.lease.expiresAt.getTime() + 1),
      })
    ).resolves.toEqual({ status: "lease_lost" });
  });

  it("maps future, completed, live-owned, not-applicable, and superseded claims without ambiguity", async () => {
    const future = await createReadyAnalysis(T0);
    const futureLease = await claimConversationAnalysisEffects(
      { analysisRevisionId: future.ready.analysisRevisionId },
      { now: () => T0, createOwnerToken: () => "future-owner" }
    );
    if (futureLease.status !== "claimed")
      throw new Error("effects not claimed");
    await recordConversationAnalysisEffectsFailure(
      { lease: futureLease.lease },
      { now: () => new Date("2026-08-10T06:00:01.000Z") }
    );
    await expect(
      claimConversationAnalysisEffects(
        { analysisRevisionId: future.ready.analysisRevisionId },
        { now: () => new Date("2026-08-10T06:00:30.000Z") }
      )
    ).resolves.toEqual({
      status: "retry_scheduled",
      nextAttemptAt: new Date("2026-08-10T06:01:01.000Z"),
    });

    const completed = await createReadyAnalysis(T0);
    const completedLease = await claimConversationAnalysisEffects(
      { analysisRevisionId: completed.ready.analysisRevisionId },
      { now: () => T0, createOwnerToken: () => "completed-owner" }
    );
    if (completedLease.status !== "claimed")
      throw new Error("effects not claimed");
    for (const step of CONVERSATION_ANALYSIS_EFFECT_STEPS) {
      await completeConversationAnalysisEffectStep(
        { lease: completedLease.lease, step },
        { now: () => new Date("2026-08-10T06:00:01.000Z") }
      );
    }
    await completeConversationAnalysisEffects(
      { lease: completedLease.lease },
      { now: () => new Date("2026-08-10T06:00:02.000Z") }
    );
    await expect(
      claimConversationAnalysisEffects({
        analysisRevisionId: completed.ready.analysisRevisionId,
      })
    ).resolves.toEqual({ status: "completed" });

    const live = await createReadyAnalysis(T0);
    await claimConversationAnalysisEffects(
      { analysisRevisionId: live.ready.analysisRevisionId },
      { now: () => T0, createOwnerToken: () => "live-owner" }
    );
    await expect(
      claimConversationAnalysisEffects(
        { analysisRevisionId: live.ready.analysisRevisionId },
        { now: () => new Date("2026-08-10T06:00:01.000Z") }
      )
    ).resolves.toEqual({ status: "lease_lost" });

    const reviewConversation = await createPendingConversation();
    const reviewLease = await claimConversationClassification(
      { conversationId: reviewConversation._id },
      { now: () => T0, createOwnerToken: () => "review-classifier" }
    );
    if (!reviewLease) throw new Error("classification not claimed");
    const review = await commitConversationClassificationReviewRequired(
      {
        lease: reviewLease,
        workspaceId: "workspace-integration",
        review: { code: "provider_safety", reason: "Review required" },
        provenance,
      },
      { now: () => new Date("2026-08-10T06:01:00.000Z") }
    );
    await expect(
      claimConversationAnalysisEffects({
        analysisRevisionId: review.analysisRevisionId,
      })
    ).resolves.toEqual({ status: "completed" });

    const stale = await createReadyAnalysis(T0);
    await Conversation.updateOne(
      { _id: stale.conversation._id },
      buildClassificationInputPendingTransitionPipeline({
        now: new Date("2026-08-10T06:00:01.000Z"),
        hasInboundInput: true,
      }),
      { timestamps: false }
    );
    await expect(
      claimConversationAnalysisEffects({
        analysisRevisionId: stale.ready.analysisRevisionId,
      })
    ).resolves.toEqual({ status: "superseded" });
  });
});
