const mockChatCompletion = jest.fn();
const mockGetDocumentEmbeddingResult = jest.fn();
const mockBuildEmbeddingMetadata = jest.fn();
const mockConversationFindOne = jest.fn();
const mockResolveBusinessContext = jest.fn();
const mockProcessImageAnalysis = jest.fn();
const mockResolveSummaryProposal = jest.fn();
const mockGetWorkspaceTaxonomyStrict = jest.fn();
const mockRenewLease = jest.fn();
const mockReleaseStaleLease = jest.fn();
const mockDeferClaim = jest.fn();
const mockCommitReady = jest.fn();
const mockCommitReview = jest.fn();
const mockRecordFailure = jest.fn();
const mockLoggerWarn = jest.fn();
import {
  hasWorkspaceTextAiAction,
  reserveWorkspaceTextAiSpend,
} from "@/lib/ai/workspace-ai-policy";

jest.mock("@/lib/ai", () => {
  class AIChatProviderAggregateError extends Error {
    readonly providerErrors: ReadonlyArray<Record<string, unknown>>;

    constructor(providerErrors: Array<Record<string, unknown>>) {
      super("AI chat provider attempts failed");
      this.name = "AIChatProviderAggregateError";
      this.providerErrors = providerErrors;
    }
  }
  return {
    AIChatProviderAggregateError,
    chatCompletionWithFallback: (...args: unknown[]) =>
      mockChatCompletion(...args),
    getDocumentEmbeddingResult: (...args: unknown[]) =>
      mockGetDocumentEmbeddingResult(...args),
    buildEmbeddingMetadata: (...args: unknown[]) =>
      mockBuildEmbeddingMetadata(...args),
    // Tier getters: light first, heavy for the repair attempt.
    getHeavyTextModel: () => "gemini-heavy",
    getLightTextModel: () => "gemini-light",
  };
});

jest.mock("@/models/conversation", () => ({
  Conversation: {
    findOne: (...args: unknown[]) => mockConversationFindOne(...args),
  },
}));
jest.mock("@/models/chat", () => ({}));
jest.mock("@/models/user", () => ({}));
jest.mock("@icecore/shared/lib/logger", () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: (...args: unknown[]) => mockLoggerWarn(...args),
  }),
}));
jest.mock("@/lib/app-version", () => ({
  getAppVersion: () => ({ version: "deploy-123", source: "test" }),
}));
jest.mock("./conversation-analysis-context", () => ({
  CLASSIFICATION_MESSAGE_SELECT: "classification message fields",
  buildConversationMetadataContext: () => "Channel: whatsapp",
  formatClassificationMessage: (message: { text?: string | null }) =>
    message.text || "",
  resolveConversationClassificationBusinessContextStrict: (
    ...args: unknown[]
  ) => mockResolveBusinessContext(...args),
}));
jest.mock("./conversation-media-analysis", () => ({
  processConversationImageAnalysis: (...args: unknown[]) =>
    mockProcessImageAnalysis(...args),
}));
jest.mock("./conversation-classification-summary-proposal", () => ({
  resolveConversationClassificationSummaryProposal: (...args: unknown[]) =>
    mockResolveSummaryProposal(...args),
}));
jest.mock("./taxonomy-server", () => ({
  getWorkspaceTaxonomyStrict: (...args: unknown[]) =>
    mockGetWorkspaceTaxonomyStrict(...args),
}));
jest.mock("./conversation-classification-store", () => {
  class ConversationClassificationCasError extends Error {}
  class ConversationAnalysisRevisionConflictError extends Error {}
  return {
    ConversationClassificationCasError,
    ConversationAnalysisRevisionConflictError,
    CONVERSATION_CLASSIFICATION_MEDIA_RECHECK_MS: 20 * 60 * 1_000,
    buildConversationClassificationLeaseFilter: (input: unknown) => ({
      exactLease: input,
    }),
    renewConversationClassificationLease: (...args: unknown[]) =>
      mockRenewLease(...args),
    releaseStaleConversationClassificationLease: (...args: unknown[]) =>
      mockReleaseStaleLease(...args),
    deferClaimedConversationClassification: (...args: unknown[]) =>
      mockDeferClaim(...args),
    commitConversationClassificationReady: (...args: unknown[]) =>
      mockCommitReady(...args),
    commitConversationClassificationReviewRequired: (...args: unknown[]) =>
      mockCommitReview(...args),
    recordConversationClassificationFailure: (...args: unknown[]) =>
      mockRecordFailure(...args),
  };
});

import { AIChatProviderAggregateError } from "@/lib/ai";
import { createConversationClassificationError } from "./conversation-classification-errors";
import type { ClaimedConversationClassification } from "./conversation-classification-store";
import {
  executeConversationClassification,
  type ExecuteConversationClassificationResult,
} from "./conversation-classification-executor";

const now = new Date("2026-08-10T06:00:00.000Z");
const conversationId = "68a000000000000000000001";

const claim: ClaimedConversationClassification = {
  conversationId,
  workspaceId: "workspace-1",
  revision: 7,
  generation: 3,
  attemptCount: 1,
  requestedAt: new Date("2026-08-10T05:59:00.000Z"),
  ownerToken: "owner-7",
  fence: 11,
  expiresAt: new Date("2026-08-10T06:10:00.000Z"),
};

const taxonomy = {
  id: "taxonomy-1",
  workspaceId: "workspace-1",
  labels: ["Support", "Sales"],
  guidelines: "Use Support for delivery and service requests.",
  fewShots: [],
  confidenceThreshold: 0.7,
  version: "taxonomy-v4",
};

const result = {
  category: "Support",
  priority: "high",
  sentiment: "negative",
  summary: "Customer asks where the delayed delivery is.",
  action: "Confirm the latest delivery status with the customer.",
  tags: ["delivery"],
  confidence: { category: 0.94, priority: 0.85, sentiment: 0.9 },
  extracted_entities: [{ type: "order_number", value: "ORD-7" }],
  key_moments: [{ type: "negative_feedback", message_index: 0 }],
  agent_performance_scorecard: {
    empathy_score: 8,
    clarity_score: 9,
    script_adherence_score: 7,
    resolution_efficiency_score: 8,
    overall_comment: "The agent responded clearly and empathetically.",
  },
  is_best_practice: true,
};

function jsonResult(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({ ...result, ...overrides });
}

function rootConversation(overrides: Record<string, unknown> = {}) {
  return {
    _id: conversationId,
    workspaceId: "workspace-1",
    sourceId: "source-1",
    chat: null,
    ...overrides,
  };
}

function loadedConversation(overrides: Record<string, unknown> = {}) {
  return {
    ...rootConversation(),
    channel: "whatsapp",
    history_summary: null,
    classification: { category: "Sales" },
    internal_labels: ["manual-vip"],
    messages: [
      {
        _id: "68a000000000000000000002",
        author: { firstName: "Customer", isBot: false },
        text: "My delivery is late. Where is ORD-7?",
        date: new Date("2026-08-10T05:58:00.000Z"),
        direction: "inbound",
        channel: "whatsapp",
        mediaType: null,
        mediaAnalysis: null,
      },
      {
        _id: "68a000000000000000000003",
        author: { firstName: "Agent", isBot: false },
        text: "I will check that now.",
        date: new Date("2026-08-10T05:58:30.000Z"),
        direction: "outbound",
        channel: "whatsapp",
        mediaType: null,
        mediaAnalysis: null,
      },
    ],
    ...overrides,
  };
}

function resolvedQuery(value: unknown) {
  const query = {
    select: jest.fn(),
    populate: jest.fn(),
    lean: jest.fn(),
    exec: jest.fn().mockResolvedValue(value),
  };
  query.select.mockReturnValue(query);
  query.populate.mockReturnValue(query);
  query.lean.mockReturnValue(query);
  return query;
}

function queueConversationReads(...values: unknown[]) {
  const queue = [...values];
  mockConversationFindOne.mockImplementation(() =>
    resolvedQuery(queue.shift() ?? null)
  );
}

function renewedLease(lease: ClaimedConversationClassification) {
  return {
    ...lease,
    expiresAt: new Date(lease.expiresAt.getTime() + 60_000),
  };
}

function safetyError() {
  return new AIChatProviderAggregateError([
    {
      provider: "vertex",
      model: "gemini-heavy",
      message: "AI provider attempt failed",
      name: "VertexGeminiEmptyContentError",
      code: "vertex_gemini_empty_content",
      finishReason: "SAFETY",
      promptBlockReason: null,
    },
  ] as never);
}

async function flushPromises() {
  for (let index = 0; index < 100; index += 1) {
    await Promise.resolve();
  }
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers().setSystemTime(now);
  queueConversationReads(rootConversation(), loadedConversation());
  mockResolveBusinessContext.mockResolvedValue({
    workspaceId: "workspace-1",
    companyId: "company-1",
    businessContext: "Parcel delivery support",
    airiLanguage: "en",
    source: { id: "source-1", type: "whatsapp" },
  });
  mockProcessImageAnalysis.mockResolvedValue({ semanticChanged: false });
  mockResolveSummaryProposal.mockResolvedValue({
    mode: "replace",
    language: "en",
    summary: "Canonical conversation summary",
    chunks: ["Canonical chunk"],
    metadata: {
      wordCount: 14,
      messageCount: 2,
      chunkCount: 1,
      generationTimeMs: 18,
    },
  });
  mockGetWorkspaceTaxonomyStrict.mockResolvedValue({
    taxonomy,
    digest: "digest-1",
  });
  mockRenewLease.mockImplementation(async lease => renewedLease(lease));
  mockReleaseStaleLease.mockResolvedValue(true);
  mockDeferClaim.mockResolvedValue(true);
  mockCommitReady.mockResolvedValue({
    analysisRevisionId: `${conversationId}:7`,
    completedAt: now,
  });
  mockCommitReview.mockResolvedValue({
    analysisRevisionId: `${conversationId}:7`,
    completedAt: now,
  });
  mockRecordFailure.mockResolvedValue({
    status: "pending",
    nextAttemptAt: new Date("2026-08-10T06:01:00.000Z"),
  });
  mockChatCompletion.mockResolvedValue({
    content: jsonResult(),
    provider: "vertex",
    model: "gemini-heavy",
    latencyMs: 25,
  });
  mockGetDocumentEmbeddingResult.mockResolvedValue({
    embedding: [0.1, 0.2],
    provider: "vertex",
    model: "text-embedding-005",
    taskType: "RETRIEVAL_DOCUMENT",
    dimensions: 2,
  });
  mockBuildEmbeddingMetadata.mockReturnValue({
    embeddingProvider: "vertex",
    embeddingModel: "text-embedding-005",
    embeddingTaskType: "RETRIEVAL_DOCUMENT",
    embeddingDimensions: 2,
  });
});

afterEach(() => {
  jest.useRealTimers();
});

describe("conversation classification executor", () => {
  it("classifies as a platform-sponsored action that reserves no company spend", async () => {
    queueConversationReads(rootConversation(), loadedConversation());
    let reservation: unknown = "not called";
    mockChatCompletion.mockImplementation(async () => {
      // An allowance-billed action would call the admission RPC and fail closed here.
      reservation = await reserveWorkspaceTextAiSpend({
        provider: "anthropic",
        model: "claude-haiku-4-5",
        request: "classify",
        maxOutputTokens: 100,
      });
      return {
        content: jsonResult(),
        provider: "anthropic",
        model: "claude-haiku-4-5",
        latencyMs: 25,
      };
    });
    await expect(
      executeConversationClassification(claim)
    ).resolves.toMatchObject({ status: "ready" });
    expect(reservation).toBeNull();
  });

  it("extracts a payment suggestion with the single existing classification call", async () => {
    mockProcessImageAnalysis.mockImplementationOnce(async () => {
      expect(hasWorkspaceTextAiAction()).toBe(true);
    });
    const conversation = loadedConversation();
    conversation.messages[0].text = "Оплатила 45 000 тенге";
    queueConversationReads(rootConversation(), conversation);
    mockChatCompletion.mockResolvedValue({
      content: jsonResult({
        payment_evidence: [
          {
            message_index: 0,
            kind: "payment_claim",
            amount: 45000,
            currency: "KZT",
          },
        ],
      }),
      provider: "vertex",
      model: "gemini-heavy",
      latencyMs: 25,
    });
    await expect(
      executeConversationClassification(claim)
    ).resolves.toMatchObject({ status: "ready" });
    expect(mockChatCompletion).toHaveBeenCalledTimes(1);
    expect(mockChatCompletion.mock.calls[0][0].messages[1].content).toContain(
      "payment_evidence"
    );
    expect(
      mockCommitReady.mock.calls[0][0].projection.payment_suggestions
    ).toEqual([
      {
        messageId: "68a000000000000000000002",
        kind: "payment_claim",
        amount: 45000,
        currency: "KZT",
        occurredAt: "2026-08-10T05:58:00.000Z",
      },
    ]);
  });

  it("does not add payment instructions to ordinary classifications or retry malformed optional evidence", async () => {
    mockChatCompletion.mockResolvedValue({
      content: jsonResult({ payment_evidence: "invalid" }),
      provider: "vertex",
      model: "gemini-heavy",
      latencyMs: 25,
    });
    await expect(
      executeConversationClassification(claim)
    ).resolves.toMatchObject({ status: "ready" });
    expect(mockChatCompletion).toHaveBeenCalledTimes(1);
    expect(
      mockChatCompletion.mock.calls[0][0].messages[1].content
    ).not.toContain("payment_evidence");
    expect(
      mockCommitReady.mock.calls[0][0].projection.payment_suggestions
    ).toEqual([]);
  });

  it("repairs once, commits immutable current inputs, and returns only the persisted ready identity", async () => {
    mockChatCompletion
      .mockResolvedValueOnce({
        content: JSON.stringify({ category: "Support" }),
        provider: "vertex",
        model: "gemini-light",
        latencyMs: 20,
      })
      .mockResolvedValueOnce({
        content: jsonResult(),
        provider: "vertex",
        model: "gemini-heavy",
        latencyMs: 25,
      });

    await expect(executeConversationClassification(claim)).resolves.toEqual({
      status: "ready",
      analysisRevisionId: `${conversationId}:7`,
    } satisfies ExecuteConversationClassificationResult);

    expect(mockChatCompletion).toHaveBeenCalledTimes(2);
    expect(mockChatCompletion.mock.calls[0][0]).toMatchObject({
      model: "gemini-light",
      trace: false,
      responseFormat: { type: "json_object" },
      temperature: 0,
      resilience: {
        maxRetries: 0,
        disableInternalFallbacks: true,
        timeoutMs: 30_000,
      },
    });
    expect(mockChatCompletion.mock.calls[1][0]).toMatchObject({
      model: "gemini-heavy",
      resilience: {
        maxRetries: 0,
        disableInternalFallbacks: true,
        timeoutMs: 30_000,
      },
    });
    expect(mockChatCompletion.mock.calls[1][0].messages[1].content).toContain(
      "Repair reason:"
    );
    expect(mockCommitReady).toHaveBeenCalledTimes(1);
    const committed = mockCommitReady.mock.calls[0][0];
    expect(committed).toMatchObject({
      workspaceId: "workspace-1",
      provenance: {
        taxonomyId: "taxonomy-1",
        taxonomyDigest: "digest-1",
        classifierVersion: "deploy-123",
        classifierContractRevision: 2,
      },
      projection: {
        classification: {
          category: "Support",
          priority: "high",
          sentiment: "negative",
          summary: result.summary,
          action: result.action,
          tags: ["delivery"],
          confidence: result.confidence,
        },
        shadow_classification: {
          category: "Support",
          priority: "high",
          sentiment: "negative",
          summary: result.summary,
          action: result.action,
          tags: ["delivery"],
          confidence: result.confidence,
        },
        history_summary: "Canonical conversation summary",
        embedding: [0.1, 0.2],
        embeddingProvider: "vertex",
        embeddingModel: "text-embedding-005",
        embeddingTaskType: "RETRIEVAL_DOCUMENT",
        embeddingDimensions: 2,
      },
      effectInputs: {
        companyId: "company-1",
        source: { id: "source-1", type: "whatsapp" },
        predictedCategoryConfidence: 0.94,
        processingTimeMs: 0,
        provider: "vertex",
        model: "gemini-heavy",
        ragSummary: {
          mode: "replace",
          language: "en",
          summary: "Canonical conversation summary",
          chunks: ["Canonical chunk"],
          metadata: {
            wordCount: 14,
            messageCount: 2,
            chunkCount: 1,
            generationTimeMs: 18,
          },
        },
      },
    });
    expect(committed.projection).not.toHaveProperty("internal_labels");
    expect(mockGetWorkspaceTaxonomyStrict).toHaveBeenCalledTimes(2);
    expect(mockCommitReview).not.toHaveBeenCalled();
    expect(mockRecordFailure).not.toHaveBeenCalled();
  });

  it("serializes timer and mandatory renewals and does not reschedule before renewal settles", async () => {
    let resolveImage!: (value: { semanticChanged: boolean }) => void;
    mockProcessImageAnalysis.mockReturnValue(
      new Promise(resolve => {
        resolveImage = resolve;
      })
    );
    let resolveHeartbeat!: (value: ClaimedConversationClassification) => void;
    mockRenewLease.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          resolveHeartbeat = resolve;
        })
    );

    const execution = executeConversationClassification(claim);
    await flushPromises();
    await jest.advanceTimersByTimeAsync(200_000);
    expect(mockRenewLease).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(600_000);
    expect(mockRenewLease).toHaveBeenCalledTimes(1);

    resolveImage({ semanticChanged: false });
    await flushPromises();
    expect(mockRenewLease).toHaveBeenCalledTimes(1);
    resolveHeartbeat({
      ...renewedLease(claim),
      expiresAt: new Date(Date.now() + 600_000),
    });
    await flushPromises();
    expect(mockRenewLease.mock.calls.length).toBeGreaterThanOrEqual(2);

    await expect(execution).resolves.toMatchObject({ status: "ready" });
  });

  it("caps each call at thirty seconds and gives repair only the remaining total deadline", async () => {
    mockChatCompletion
      .mockImplementationOnce(async () => {
        jest.setSystemTime(new Date(now.getTime() + 40_000));
        return {
          content: JSON.stringify({ category: "Support" }),
          provider: "vertex",
          model: "gemini-light",
          latencyMs: 40_000,
        };
      })
      .mockResolvedValueOnce({
        content: jsonResult(),
        provider: "vertex",
        model: "gemini-heavy",
        latencyMs: 25,
      });

    await expect(
      executeConversationClassification(claim)
    ).resolves.toMatchObject({
      status: "ready",
    });
    expect(mockChatCompletion.mock.calls[0][0].resilience.timeoutMs).toBe(
      30_000
    );
    expect(mockChatCompletion.mock.calls[1][0]).toMatchObject({
      model: "gemini-heavy",
      resilience: { timeoutMs: 20_000 },
    });
  });

  it("catches a rejected timer renewal, stops compute, and manually renews once to persist failure", async () => {
    let resolveImage!: (value: { semanticChanged: boolean }) => void;
    mockProcessImageAnalysis.mockReturnValue(
      new Promise(resolve => {
        resolveImage = resolve;
      })
    );
    const renewalError = new Error("heartbeat storage unavailable");
    mockRenewLease.mockRejectedValueOnce(renewalError);

    const execution = executeConversationClassification(claim);
    await flushPromises();
    await jest.advanceTimersByTimeAsync(200_000);
    await flushPromises();
    expect(mockRenewLease).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(600_000);
    expect(mockRenewLease).toHaveBeenCalledTimes(1);

    resolveImage({ semanticChanged: false });
    await expect(execution).resolves.toEqual({
      status: "retry_scheduled",
      nextAttemptAt: new Date("2026-08-10T06:01:00.000Z"),
    });
    expect(mockRenewLease).toHaveBeenCalledTimes(2);
    expect(mockResolveSummaryProposal).not.toHaveBeenCalled();
    expect(mockChatCompletion).not.toHaveBeenCalled();
    expect(mockCommitReady).not.toHaveBeenCalled();
    expect(mockCommitReview).not.toHaveBeenCalled();
    expect(mockRecordFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "classification_execution_failed",
        retryable: true,
      })
    );
  });

  it("halts after attempt one when an asynchronous heartbeat returns lease loss", async () => {
    let resolveImage!: (value: { semanticChanged: boolean }) => void;
    mockProcessImageAnalysis.mockReturnValue(
      new Promise(resolve => {
        resolveImage = resolve;
      })
    );
    let resolveFirstAttempt!: (value: Record<string, unknown>) => void;
    mockChatCompletion.mockReturnValueOnce(
      new Promise(resolve => {
        resolveFirstAttempt = resolve;
      })
    );
    mockRenewLease
      .mockImplementationOnce(async lease => renewedLease(lease))
      .mockResolvedValueOnce(null);

    const execution = executeConversationClassification(claim);
    await flushPromises();
    await jest.advanceTimersByTimeAsync(190_000);
    resolveImage({ semanticChanged: false });
    await flushPromises();
    expect(mockChatCompletion).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(10_000);
    await flushPromises();
    expect(mockRenewLease).toHaveBeenCalledTimes(2);
    resolveFirstAttempt({
      content: JSON.stringify({ category: "Support" }),
      provider: "vertex",
      model: "gemini-heavy",
      latencyMs: 10_000,
    });

    await expect(execution).resolves.toEqual({ status: "stale" });
    expect(mockChatCompletion).toHaveBeenCalledTimes(1);
    expect(mockGetDocumentEmbeddingResult).not.toHaveBeenCalled();
    expect(mockCommitReady).not.toHaveBeenCalled();
    expect(mockCommitReview).not.toHaveBeenCalled();
  });

  it("does not start more billable work after the latest exact lease objectively expires", async () => {
    mockRenewLease.mockResolvedValueOnce({
      ...claim,
      expiresAt: new Date(now.getTime() + 1_000),
    });
    mockChatCompletion.mockImplementationOnce(async () => {
      jest.setSystemTime(new Date(now.getTime() + 1_001));
      return {
        content: JSON.stringify({ category: "Support" }),
        provider: "vertex",
        model: "gemini-heavy",
        latencyMs: 1_001,
      };
    });

    await expect(executeConversationClassification(claim)).resolves.toEqual({
      status: "stale",
    });
    expect(mockChatCompletion).toHaveBeenCalledTimes(1);
    expect(mockGetDocumentEmbeddingResult).not.toHaveBeenCalled();
    expect(mockCommitReady).not.toHaveBeenCalled();
    expect(mockCommitReview).not.toHaveBeenCalled();
  });

  it("releases only the observed lease and returns stale when the first exact load misses", async () => {
    queueConversationReads(null);

    await expect(executeConversationClassification(claim)).resolves.toEqual({
      status: "stale",
    });
    expect(mockReleaseStaleLease).toHaveBeenCalledWith({
      lease: {
        conversationId,
        revision: 7,
        ownerToken: "owner-7",
        fence: 11,
        expiresAt: claim.expiresAt,
      },
    });
    expect(mockResolveBusinessContext).not.toHaveBeenCalled();
    expect(mockChatCompletion).not.toHaveBeenCalled();
  });

  it("returns stale before the LLM when semantic image preprocessing invalidates the claim", async () => {
    mockProcessImageAnalysis.mockResolvedValue({ semanticChanged: true });
    mockRenewLease.mockResolvedValueOnce(null);

    await expect(executeConversationClassification(claim)).resolves.toEqual({
      status: "stale",
    });
    expect(mockReleaseStaleLease).toHaveBeenCalledTimes(1);
    expect(mockConversationFindOne).toHaveBeenCalledTimes(1);
    expect(mockChatCompletion).not.toHaveBeenCalled();
  });

  it("defers content-bearing inbound media that has no terminal semantic analysis", async () => {
    const pending = loadedConversation({
      messages: [
        {
          _id: "68a000000000000000000004",
          author: null,
          text: "",
          date: new Date("2026-08-10T05:59:00.000Z"),
          direction: "inbound",
          channel: "whatsapp",
          mediaType: "voice",
          imageUrl: "https://cdn.example.com/voice.ogg",
          attachments: [],
          audioAnalysis: null,
          mediaAnalysis: { status: "submitted", kind: "voice" },
        },
      ],
    });
    queueConversationReads(rootConversation(), pending);

    await expect(executeConversationClassification(claim)).resolves.toEqual({
      status: "media_deferred",
      recheckAt: new Date("2026-08-10T06:20:00.000Z"),
    });
    expect(mockDeferClaim).toHaveBeenCalledWith({
      lease: expect.objectContaining({ ownerToken: "owner-7", fence: 11 }),
      recheckAt: new Date("2026-08-10T06:20:00.000Z"),
    });
    expect(mockChatCompletion).not.toHaveBeenCalled();
  });

  it("commits review only when both canonical attempts are explicitly safety blocked", async () => {
    mockChatCompletion
      .mockRejectedValueOnce(safetyError())
      .mockRejectedValueOnce(safetyError());

    await expect(executeConversationClassification(claim)).resolves.toEqual({
      status: "review_required",
    });
    expect(mockCommitReview).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-1",
        review: {
          code: "provider_safety_blocked",
          reason: "Every classification provider attempt was safety blocked",
        },
      })
    );
    expect(mockCommitReady).not.toHaveBeenCalled();
    expect(mockRecordFailure).not.toHaveBeenCalled();
  });

  it("commits review when Claude refuses and the Gemini fallback is safety blocked", async () => {
    const refusedThenBlocked = () =>
      new AIChatProviderAggregateError([
        {
          provider: "anthropic",
          model: "claude-sonnet-5-5",
          finishReason: "refusal",
          promptBlockReason: null,
        },
        {
          provider: "vertex",
          model: "gemini-heavy",
          finishReason: "SAFETY",
          promptBlockReason: null,
        },
      ] as never);
    mockChatCompletion
      .mockRejectedValueOnce(refusedThenBlocked())
      .mockRejectedValueOnce(refusedThenBlocked());

    await expect(executeConversationClassification(claim)).resolves.toEqual({
      status: "review_required",
    });
    expect(mockCommitReview).toHaveBeenCalledWith(
      expect.objectContaining({
        review: {
          code: "provider_safety_blocked",
          reason: "Every classification provider attempt was safety blocked",
        },
      })
    );
    expect(mockRecordFailure).not.toHaveBeenCalled();
  });

  it("persists the provider and model that served the classification", async () => {
    mockChatCompletion.mockResolvedValue({
      content: jsonResult(),
      provider: "anthropic",
      model: "claude-haiku-4-5",
      latencyMs: 25,
    });

    await expect(
      executeConversationClassification(claim)
    ).resolves.toMatchObject({ status: "ready" });
    expect(mockChatCompletion).toHaveBeenCalledTimes(1);
    expect(mockChatCompletion.mock.calls[0][0].model).toBe("gemini-light");
    expect(mockCommitReady.mock.calls[0][0].effectInputs).toMatchObject({
      provider: "anthropic",
      model: "claude-haiku-4-5",
    });
  });

  it("treats an unexecuted second attempt after a safety result as operational retry", async () => {
    mockChatCompletion.mockImplementationOnce(async () => {
      jest.setSystemTime(new Date(now.getTime() + 60_001));
      throw safetyError();
    });

    await expect(executeConversationClassification(claim)).resolves.toEqual({
      status: "retry_scheduled",
      nextAttemptAt: new Date("2026-08-10T06:01:00.000Z"),
    });
    expect(mockChatCompletion).toHaveBeenCalledTimes(1);
    expect(mockCommitReview).not.toHaveBeenCalled();
    expect(mockRecordFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "classification_provider_failed",
        retryable: true,
      })
    );
  });

  it("treats mixed safety and operational provider evidence as an ordinary retry", async () => {
    mockChatCompletion
      .mockRejectedValueOnce(safetyError())
      .mockRejectedValueOnce(new Error("provider unavailable"));

    await expect(executeConversationClassification(claim)).resolves.toEqual({
      status: "retry_scheduled",
      nextAttemptAt: new Date("2026-08-10T06:01:00.000Z"),
    });
    expect(mockCommitReview).not.toHaveBeenCalled();
    expect(mockRecordFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "classification_provider_failed",
        retryable: true,
      })
    );
  });

  it("logs the conversation and the wrapped cause of a media preprocessing failure", async () => {
    mockProcessImageAnalysis.mockRejectedValueOnce(
      Object.assign(
        new Error(
          "fetch failed for https://storage.example/object/sign/chat/a.jpg?token=signed-secret"
        ),
        { name: "StorageError", code: "ETIMEDOUT" }
      )
    );

    await expect(
      executeConversationClassification(claim)
    ).resolves.toMatchObject({ status: "retry_scheduled" });

    expect(mockRecordFailure).toHaveBeenCalledWith(
      expect.objectContaining({ code: "media_preprocessing_failed" })
    );
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      "classification.execution_failed",
      {
        conversation_id: conversationId,
        revision: 7,
        error: {
          message: "Classification media preprocessing failed",
          name: "ConversationClassificationError",
          code: "media_preprocessing_failed",
          cause: {
            message:
              "fetch failed for https://storage.example/object/sign/chat/a.jpg?[redacted]",
            name: "StorageError",
            code: "ETIMEDOUT",
          },
        },
      }
    );
  });

  it("maps the fourth ordinary failure to the persisted terminal failed outcome", async () => {
    mockResolveBusinessContext.mockRejectedValue(
      Object.assign(new Error("workspace read failed"), {
        code: "business_context_read_failed",
        retryable: true,
      })
    );
    mockRecordFailure.mockResolvedValue({
      status: "failed",
      nextAttemptAt: null,
    });

    await expect(
      executeConversationClassification({ ...claim, attemptCount: 4 })
    ).resolves.toEqual({ status: "failed" });
    expect(mockRecordFailure).toHaveBeenCalledTimes(1);
  });

  it("stops provider attempts and records a non-retryable connection requirement at the allowance limit", async () => {
    mockChatCompletion.mockRejectedValueOnce(
      Object.assign(new Error("Connect Google AI"), {
        code: "own_ai_source_required",
      })
    );
    mockRecordFailure.mockResolvedValue({
      status: "failed",
      nextAttemptAt: null,
    });
    await expect(executeConversationClassification(claim)).resolves.toEqual({
      status: "failed",
    });
    expect(mockChatCompletion).toHaveBeenCalledTimes(1);
    expect(mockRecordFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "own_ai_source_required",
        retryable: false,
      })
    );
  });

  it("records a taxonomy digest race instead of certifying the obsolete result", async () => {
    mockGetWorkspaceTaxonomyStrict
      .mockResolvedValueOnce({ taxonomy, digest: "digest-before" })
      .mockResolvedValueOnce({ taxonomy, digest: "digest-after" });

    await expect(executeConversationClassification(claim)).resolves.toEqual({
      status: "retry_scheduled",
      nextAttemptAt: new Date("2026-08-10T06:01:00.000Z"),
    });
    expect(mockCommitReady).not.toHaveBeenCalled();
    expect(mockRecordFailure).toHaveBeenCalledWith(
      expect.objectContaining({ code: "taxonomy_changed", retryable: true })
    );
  });

  it("clears every embedding field when generation returns no current vector", async () => {
    mockResolveSummaryProposal.mockResolvedValue(null);
    mockGetDocumentEmbeddingResult.mockResolvedValue(null);

    await expect(
      executeConversationClassification(claim)
    ).resolves.toMatchObject({
      status: "ready",
    });
    expect(mockCommitReady.mock.calls[0][0].projection).toMatchObject({
      embedding: null,
      embeddingProvider: null,
      embeddingModel: null,
      embeddingTaskType: null,
      embeddingDimensions: null,
    });
    expect(mockCommitReady.mock.calls[0][0].effectInputs.ragSummary).toBeNull();
  });

  it("explicitly clears a prior QA scorecard when the accepted result omits one", async () => {
    const { agent_performance_scorecard: scorecard, ...withoutScorecard } =
      result;
    expect(scorecard).toBeDefined();
    mockChatCompletion.mockResolvedValueOnce({
      content: JSON.stringify(withoutScorecard),
      provider: "vertex",
      model: "gemini-heavy",
      latencyMs: 25,
    });

    await expect(
      executeConversationClassification(claim)
    ).resolves.toMatchObject({
      status: "ready",
    });
    expect(mockCommitReady.mock.calls[0][0].projection).toMatchObject({
      agent_performance_scorecard: null,
    });
  });

  it.each([
    [
      "empty vector",
      {
        embedding: [],
        provider: "vertex",
        model: "text-embedding-005",
        taskType: "RETRIEVAL_DOCUMENT",
        dimensions: 0,
      },
    ],
    [
      "non-finite vector",
      {
        embedding: [0.1, Number.NaN],
        provider: "vertex",
        model: "text-embedding-005",
        taskType: "RETRIEVAL_DOCUMENT",
        dimensions: 2,
      },
    ],
    [
      "dimension mismatch",
      {
        embedding: [0.1, 0.2],
        provider: "vertex",
        model: "text-embedding-005",
        taskType: "RETRIEVAL_DOCUMENT",
        dimensions: 3,
      },
    ],
    [
      "blank identity",
      {
        embedding: [0.1],
        provider: " ",
        model: "text-embedding-005",
        taskType: "RETRIEVAL_DOCUMENT",
        dimensions: 1,
      },
    ],
  ])(
    "nulls all embedding fields for an incoherent %s",
    async (_name, generated) => {
      mockGetDocumentEmbeddingResult.mockResolvedValue(generated);

      await expect(
        executeConversationClassification(claim)
      ).resolves.toMatchObject({
        status: "ready",
      });
      expect(mockCommitReady.mock.calls[0][0].projection).toMatchObject({
        embedding: null,
        embeddingProvider: null,
        embeddingModel: null,
        embeddingTaskType: null,
        embeddingDimensions: null,
      });
    }
  );

  it("nulls all embedding fields when metadata construction fails", async () => {
    mockBuildEmbeddingMetadata.mockImplementationOnce(() => {
      throw new Error("metadata mismatch");
    });

    await expect(
      executeConversationClassification(claim)
    ).resolves.toMatchObject({
      status: "ready",
    });
    expect(mockCommitReady.mock.calls[0][0].projection).toMatchObject({
      embedding: null,
      embeddingProvider: null,
      embeddingModel: null,
      embeddingTaskType: null,
      embeddingDimensions: null,
    });
  });

  it("fails durably instead of clamping processing time outside the immutable input contract", async () => {
    mockRenewLease.mockImplementation(async lease => ({
      ...renewedLease(lease),
      expiresAt: new Date(now.getTime() + 48 * 60 * 60 * 1_000),
    }));
    mockChatCompletion.mockImplementationOnce(async () => {
      jest.setSystemTime(new Date(now.getTime() + 24 * 60 * 60 * 1_000 + 1));
      return {
        content: jsonResult(),
        provider: "vertex",
        model: "gemini-heavy",
        latencyMs: 25,
      };
    });

    await expect(executeConversationClassification(claim)).resolves.toEqual({
      status: "retry_scheduled",
      nextAttemptAt: new Date("2026-08-10T06:01:00.000Z"),
    });
    expect(mockCommitReady).not.toHaveBeenCalled();
    expect(mockRecordFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "classification_execution_failed",
        retryable: true,
      })
    );
  });

  it("uses the canonical JSON extractor before strict authorization", async () => {
    mockChatCompletion.mockResolvedValueOnce({
      content: `\`\`\`json\n${jsonResult()}\n\`\`\``,
      provider: "vertex",
      model: "gemini-heavy",
      latencyMs: 25,
    });

    await expect(
      executeConversationClassification(claim)
    ).resolves.toMatchObject({
      status: "ready",
    });
    expect(mockChatCompletion).toHaveBeenCalledTimes(1);
  });

  it("returns stale when the final manual renewal loses the lease", async () => {
    mockRenewLease
      .mockImplementationOnce(async lease => renewedLease(lease))
      .mockResolvedValueOnce(null);

    await expect(executeConversationClassification(claim)).resolves.toEqual({
      status: "stale",
    });
    expect(mockCommitReady).not.toHaveBeenCalled();
    expect(mockRecordFailure).not.toHaveBeenCalled();
  });

  it("returns stale when a ready CAS misses after the final renewal", async () => {
    const store = jest.requireMock("./conversation-classification-store") as {
      ConversationClassificationCasError: new (message: string) => Error;
    };
    mockCommitReady.mockRejectedValue(
      new store.ConversationClassificationCasError("stale")
    );

    await expect(executeConversationClassification(claim)).resolves.toEqual({
      status: "stale",
    });
    expect(mockRecordFailure).not.toHaveBeenCalled();
  });

  it("treats a missing root source as source-less and ignores a populated chat source", async () => {
    const sourceLessRoot = rootConversation({
      chat: { sourceId: "chat-source-must-not-be-used" },
    });
    delete (sourceLessRoot as { sourceId?: unknown }).sourceId;
    queueConversationReads(sourceLessRoot, loadedConversation());
    mockResolveBusinessContext.mockResolvedValueOnce({
      workspaceId: "workspace-1",
      companyId: "company-1",
      businessContext: "Parcel delivery support",
      airiLanguage: "en",
      source: null,
    });

    await expect(
      executeConversationClassification(claim)
    ).resolves.toMatchObject({
      status: "ready",
    });
    expect(mockResolveBusinessContext).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      sourceId: null,
    });
    expect(mockCommitReady.mock.calls[0][0].effectInputs.source).toEqual({
      id: null,
      type: null,
    });
  });

  it("preserves an explicit null root source as source-less", async () => {
    queueConversationReads(
      rootConversation({
        sourceId: null,
        chat: { sourceId: "chat-source-must-not-be-used" },
      }),
      loadedConversation()
    );
    mockResolveBusinessContext.mockResolvedValueOnce({
      workspaceId: "workspace-1",
      companyId: "company-1",
      businessContext: "Parcel delivery support",
      airiLanguage: "en",
      source: null,
    });

    await expect(
      executeConversationClassification(claim)
    ).resolves.toMatchObject({
      status: "ready",
    });
    expect(mockResolveBusinessContext).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      sourceId: null,
    });
  });

  it("passes a present blank root source to strict validation and fails before provider or CAS", async () => {
    queueConversationReads(
      rootConversation({
        sourceId: "   ",
        chat: { sourceId: "chat-source-must-not-be-used" },
      })
    );
    mockResolveBusinessContext.mockRejectedValueOnce(
      createConversationClassificationError("source_read_failed")
    );

    await expect(executeConversationClassification(claim)).resolves.toEqual({
      status: "retry_scheduled",
      nextAttemptAt: new Date("2026-08-10T06:01:00.000Z"),
    });
    expect(mockResolveBusinessContext).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      sourceId: "   ",
    });
    expect(mockChatCompletion).not.toHaveBeenCalled();
    expect(mockCommitReady).not.toHaveBeenCalled();
    expect(mockCommitReview).not.toHaveBeenCalled();
  });
});
