const mockAiAdmissionRpc = jest.fn();
jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: { rpc: (...args: unknown[]) => mockAiAdmissionRpc(...args) },
}));
const mockBuildSelectedAiriChatGroundingContext = jest.fn();
const mockFormatAiriChatConversationContextLine = jest.fn(
  (
    conversation: {
      summary?: string;
      category?: string;
      priority?: string;
    },
    index: number
  ) => {
    const label = conversation.category
      ? conversation.priority
        ? `${conversation.category} (${conversation.priority})`
        : conversation.category
      : conversation.priority
        ? `(${conversation.priority})`
        : "";
    return `[Conversation ${index + 1}]${label ? ` ${label}` : ""}: ${conversation.summary || "No summary available."}`;
  }
);
const mockAiriChatThreadFindOne = jest.fn();
const mockAiriChatThreadUpdateOne = jest.fn(async (..._args: unknown[]) => ({
  matchedCount: 1,
  modifiedCount: 1,
}));
const mockAiriChatMessageCreate = jest.fn();
const mockAiriChatMessageFind = jest.fn();
const mockAiriChatMessageCountDocuments = jest.fn();
const mockMessageFind = jest.fn();
const mockChatCompletionWithFallback = jest.fn();
const mockSearchAskDataContextLocal = jest.fn();
const mockResolveAiriMarketingToolAccess = jest.fn();
const mockCreateAiriArtifact = jest.fn();
const mockUpdateAiriArtifact = jest.fn();
const mockClassifyAiriChatIntent = jest.fn();
const mockCreateQueuedAiriImageGeneration = jest.fn();
const mockStartQueuedAiriImageGeneration = jest.fn();
const mockUpdateQueuedAiriImageGenerationTarget = jest.fn();
const mockRunMetaAdsMcpTurn = jest.fn();
const mockLoadMetaAdsMcpBusinessEvidence = jest
  .fn()
  .mockResolvedValue("bounded business facts");
jest.mock("@/lib/meta-ads/mcp/business-evidence", () => ({
  loadMetaAdsMcpBusinessEvidence: (...args: unknown[]) =>
    mockLoadMetaAdsMcpBusinessEvidence(...args),
}));
jest.mock("./meta-ads-mcp-conversation", () => ({
  getMetaAdsMcpConversationId: async () => "ABCDEFGHIJKLMNOPQRST",
}));
const mockLoggerError = jest.fn();
const mockRetrieveAiriProductKbArticles = jest.fn();

jest.mock("@/lib/airi-chats/sources", () => ({
  buildSelectedAiriChatGroundingContext: (...args: unknown[]) =>
    mockBuildSelectedAiriChatGroundingContext(...args),
  formatAiriChatConversationContextLine: (
    ...args: [
      {
        summary?: string;
        category?: string;
        priority?: string;
      },
      number,
    ]
  ) => mockFormatAiriChatConversationContextLine(...args),
}));

jest.mock("@/lib/airi-chats/analytics", () => ({
  buildAiriChatAnalyticsSourceContext: jest.fn(() => ({
    sourceIds: [],
    conversationSourceIds: [],
    kbSourceIds: [],
    retrievalPath: "none",
  })),
  recordAiriChatTurnAnalyticsEvents: jest.fn(),
}));

jest.mock("@/lib/airi-chats/marketing-tool-access", () => ({
  resolveAiriMarketingToolAccess: (...args: unknown[]) =>
    mockResolveAiriMarketingToolAccess(...args),
}));

jest.mock("@/lib/airi-artifacts/service", () => {
  // Same shapes as the real classes; the real module pulls in Mongo models.
  class AiriArtifactConflictError extends Error {
    current: unknown;
    constructor(current?: unknown) {
      super("Airi artifact revision conflict");
      this.name = "AiriArtifactConflictError";
      this.current = current ?? null;
    }
  }
  class AiriArtifactValidationError extends Error {
    validation: unknown;
    constructor(validation: unknown) {
      super("Invalid Airi artifact snapshot");
      this.name = "AiriArtifactValidationError";
      this.validation = validation;
    }
  }
  return {
    AiriArtifactConflictError,
    AiriArtifactValidationError,
    createAiriArtifact: (...args: unknown[]) => mockCreateAiriArtifact(...args),
    updateAiriArtifact: (...args: unknown[]) => mockUpdateAiriArtifact(...args),
  };
});

jest.mock("@/lib/airi-chats/generated-image-generation", () => ({
  createQueuedAiriImageGeneration: (...args: unknown[]) =>
    mockCreateQueuedAiriImageGeneration(...args),
  startQueuedAiriImageGeneration: (...args: unknown[]) =>
    mockStartQueuedAiriImageGeneration(...args),
  updateQueuedAiriImageGenerationTarget: (...args: unknown[]) =>
    mockUpdateQueuedAiriImageGenerationTarget(...args),
}));

jest.mock("@/lib/airi-chats/intent-classifier", () => ({
  classifyAiriChatIntent: (...args: unknown[]) =>
    mockClassifyAiriChatIntent(...args),
}));

jest.mock("@/lib/airi-chats/product-knowledge", () => ({
  AIRI_PRODUCT_KB_COMPANY_SLUG: "airichat",
  retrieveAiriProductKbArticles: (...args: unknown[]) =>
    mockRetrieveAiriProductKbArticles(...args),
  formatAiriProductKbPromptContext: (
    articles: Array<{
      title: string;
      content: string;
      url?: string | null;
    }>
  ) => {
    if (articles.length === 0) {
      return [
        "PUBLISHED AIRI.CHAT PRODUCT KB",
        "No matching published airi.chat help articles were retrieved.",
      ].join("\n");
    }
    return [
      "PUBLISHED AIRI.CHAT PRODUCT KB",
      ...articles.map(
        (article, index) =>
          `### Product KB ${index + 1}: "${article.title}"\n${article.content}`
      ),
    ].join("\n\n");
  },
}));

jest.mock("@/lib/meta-ads/mcp/agent-loop", () => ({
  runMetaAdsMcpTurn: (...args: unknown[]) => mockRunMetaAdsMcpTurn(...args),
}));

jest.mock("@/lib/ai", () => {
  // The real error and classifier: the facade always fails with an
  // AIChatProviderAggregateError, so a fake classifier that matches raw
  // provider messages would hide how production failures are handled.
  const providerErrors = jest.requireActual<
    typeof import("@/lib/ai/provider-errors")
  >("@/lib/ai/provider-errors");
  return {
    AIChatProviderAggregateError: providerErrors.AIChatProviderAggregateError,
    chatCompletionWithFallback: (...args: unknown[]) =>
      mockChatCompletionWithFallback(...args),
    getHeavyTextModel: jest.fn(() => "heavy-text-model"),
    getLightTextModel: jest.fn(() => "light-text-model"),
    isRetryableAIProviderError: jest.fn(
      providerErrors.isRetryableAIProviderError
    ),
  };
});

jest.mock("@/lib/ai/ask-data-search-local", () => ({
  searchAskDataContextLocal: (...args: unknown[]) =>
    mockSearchAskDataContextLocal(...args),
}));

jest.mock("@/lib/ai/gcp-ai-gateway", () => ({
  canCallGcpAIGateway: jest.fn(() => false),
  getRemoteAskDataContext: jest.fn(),
}));

jest.mock("@/lib/logger", () => ({
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: (...args: unknown[]) => mockLoggerError(...args),
  },
}));

jest.mock("@/lib/airi/shared/language-policy", () => ({
  getAiriResponseLanguageInstruction: jest.fn(() => "Answer in English."),
  normalizeAiriLanguage: jest.fn(() => "en"),
}));

jest.mock("@/models/airi-chat-thread", () => ({
  AiriChatThread: {
    findOne: (...args: unknown[]) => mockAiriChatThreadFindOne(...args),
    updateOne: (...args: unknown[]) => mockAiriChatThreadUpdateOne(...args),
    find: jest.fn(),
    create: jest.fn(),
  },
}));

jest.mock("@/models/airi-chat-message", () => ({
  AIRI_CHAT_MESSAGE_CONTENT_MAX_LENGTH: 12000,
  AiriChatMessage: {
    create: (...args: unknown[]) => mockAiriChatMessageCreate(...args),
    find: (...args: unknown[]) => mockAiriChatMessageFind(...args),
    countDocuments: (...args: unknown[]) =>
      mockAiriChatMessageCountDocuments(...args),
  },
}));

jest.mock("@/models/message", () => ({
  __esModule: true,
  default: {
    find: (...args: unknown[]) => mockMessageFind(...args),
  },
}));

import {
  appendAiriChatTurn,
  createAndAppendAiriChatTurn,
  generateAiriChatReply,
  AIRI_CHAT_DELTA_THROTTLE_MS,
  AIRI_CHAT_GATEWAY_RETRIEVAL_BUDGET_MS,
  AIRI_CHAT_LOCAL_RETRIEVAL_TIMEOUT_MS,
  generateAiriChatTitle,
  AIRI_CHAT_TURN_HISTORY_PROJECTION,
  listAiriChatMessages,
  listAiriChatTurnHistory,
  searchWorkspaceContextForAiriChat,
} from "./service";
import type { AiriChatRunEvent } from "./run-events";
import { createAiriTurnDeadline } from "./turn/deadline";
import { buildAiriChatMetaSkillRef } from "./source-types";
import { AIChatProviderAggregateError } from "@/lib/ai";
import {
  resolveWorkspaceTextAiBilling,
  WorkspaceAiSourceRequiredError,
} from "@/lib/ai/workspace-ai-policy";
import { AIRI_PRODUCT_CONTEXT_VERSION } from "@/lib/airi-product-context";
import {
  AIRI_CHAT_INPUT_CHAR_LIMIT,
  AIRI_CHAT_INPUT_TOKEN_LIMIT,
} from "./prompt-budget";

const defaultMarketingToolAccess = {
  whatsapp: {
    available: true,
    label: "WhatsApp",
    source: "workspace_source",
    sourceId: "wa-1",
    actionHref: "/panel/w/workspace-1/messengers/whatsapp-templates",
  },
  scenarios: {
    available: true,
    label: "Scenarios",
    source: "built_in",
    actionHref: "/panel/w/workspace-1/scenarios",
  },
  bulkCampaigns: {
    available: true,
    label: "Bulk campaigns",
    source: "built_in",
    actionHref: "/panel/w/workspace-1/bulk-campaigns",
  },
  canva: {
    available: false,
    label: "Canva",
    source: "not_configured",
    reason: "Connect Canva to use approved brand templates.",
    actionHref: "/panel/w/workspace-1/settings/integrations?integration=canva",
  },
  visualGeneration: {
    available: false,
    label: "Visual generation",
    source: "not_configured",
    reason: "Connect Higgsfield or use configured Google creative generation.",
    actionHref:
      "/panel/w/workspace-1/settings/integrations?integration=higgsfield",
  },
  audioGeneration: {
    available: false,
    label: "Audio generation",
    source: "not_configured",
    reason:
      "Connect ElevenLabs in Settings > Integrations to generate voiceovers for this workspace.",
    actionHref:
      "/panel/w/workspace-1/settings/integrations?integration=elevenlabs",
  },
  metaAds: {
    available: false,
    label: "Meta Ads",
    source: "not_configured",
    reason: "Connect Meta Ads before ad planning or creative sync.",
    actionHref:
      "/panel/w/workspace-1/settings/integrations?integration=meta_ads",
  },
} as const;

type MockAiriChatIntent =
  | "general_answer"
  | "product_capability"
  | "whatsapp_template"
  | "whatsapp_flow"
  | "opportunity_scan"
  | "marketing_campaign"
  | "image_generation"
  | "meta_ads_mcp";

function buildMockIntentClassification(intent: MockAiriChatIntent) {
  return {
    intent,
    confidence: 0.9,
    reason: "test intent",
    provider: "vertex",
    model: "gemini-light",
    latencyMs: 10,
    usage: null,
  };
}

function mockAiriChatIntent(intent: MockAiriChatIntent): void {
  mockClassifyAiriChatIntent.mockResolvedValue(
    buildMockIntentClassification(intent)
  );
}

function mockCustomerMessageExcerpts(
  messages: Array<{
    direction: "inbound" | "outbound";
    text: string;
    date: Date;
  }> = []
): void {
  mockMessageFind.mockReturnValue({
    sort: jest.fn().mockReturnValue({
      limit: jest.fn().mockReturnValue({
        select: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue(messages),
        }),
      }),
    }),
  });
}

function draftCallTimeoutMs(traceSuffix: string): unknown {
  const call = mockChatCompletionWithFallback.mock.calls.find(([request]) =>
    String(request?.analytics?.traceId || "").endsWith(`:${traceSuffix}`)
  );
  return call?.[0]?.resilience?.timeoutMs;
}

/** The first message content sent on the given model call. */
function generationPrompt(call = 0): string {
  return mockChatCompletionWithFallback.mock.calls[call]?.[0]?.messages?.[0]
    ?.content as string;
}

function mockPlatformAdmission(): void {
  mockAiAdmissionRpc.mockResolvedValue({
    data: {
      workspace_id: "workspace-1",
      company_id: "company-1",
      plan: "pro",
      billing_source: "platform",
      source_id: null,
      period_start: "2026-09-01T00:00:00.000Z",
      reset_at: null,
      allowance_period: "lifetime",
    },
    error: null,
  });
}

/** Stores each message as given, with a stable id per role. */
function mockEchoedMessageCreate(createdAt?: string): void {
  mockAiriChatMessageCreate.mockImplementation(
    async (doc: Record<string, unknown>) => ({
      ...doc,
      _id: doc.role === "user" ? "message-user" : "message-assistant",
      createdAt: createdAt ? new Date(createdAt) : new Date(),
    })
  );
}

function mockExistingThread() {
  const thread = {
    _id: "thread-1",
    title: "Existing chat",
    source: "manual",
    save: jest.fn(),
  };
  mockAiriChatThreadFindOne.mockResolvedValue(thread);
  return thread;
}

function mockEmptyTurnHistory(): void {
  mockAiriChatMessageFind.mockReturnValue({
    sort: () => ({ limit: () => ({ lean: async () => [] }) }),
  });
}

function mockNoWorkspaceRetrieval(): void {
  mockSearchAskDataContextLocal.mockResolvedValue({
    conversations: [],
    kbArticles: [],
    metadata: {
      retrievalPath: "none",
      vectorIndex: null,
      fallbackConversationCount: 0,
    },
  });
}

/** The stored user message followed by the stored assistant reply. */
function mockPersistedTurn(userContent: string, assistantContent: string) {
  mockAiriChatMessageCreate
    .mockResolvedValueOnce({
      _id: "user-message-1",
      threadId: "thread-1",
      workspaceId: "workspace-1",
      role: "user",
      content: userContent,
      createdAt: new Date("2026-06-12T00:00:00.000Z"),
    })
    .mockResolvedValueOnce({
      _id: "assistant-message-1",
      threadId: "thread-1",
      workspaceId: "workspace-1",
      role: "assistant",
      content: assistantContent,
      metadata: {},
      createdAt: new Date("2026-06-12T00:00:01.000Z"),
    });
}

/** A Supabase client whose profile lookups find nothing. */
function profilelessSupabase() {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: null }) }),
      }),
    }),
  };
}

/** Same as profilelessSupabase, built from chainable jest mocks. */
function chainedSupabase() {
  return {
    from: jest.fn().mockReturnValue({
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({ data: null }),
    }),
  };
}

function turnParams(supabase: unknown, content: string) {
  return {
    supabase: supabase as never,
    workspaceId: "workspace-1",
    userId: "user-1",
    threadId: "thread-1",
    content,
  };
}

/**
 * An existing thread with no history whose turn stores `userContent` and then
 * `assistantContent`. Retrieval and the model reply stay with each test.
 */
function prepareAnswerTurn(userContent: string, assistantContent: string) {
  const thread = mockExistingThread();
  mockEmptyTurnHistory();
  mockPersistedTurn(userContent, assistantContent);
  const supabase = chainedSupabase();
  return { thread, supabase, params: turnParams(supabase, userContent) };
}

describe("appendAiriChatTurn", () => {
  it("reads the latest owned history before classifying a Meta follow-up", async () => {
    const sort = jest.fn().mockReturnValue({
      limit: () => ({
        lean: async () => [
          {
            _id: "message-current",
            threadId: "thread-1",
            workspaceId: "workspace-1",
            role: "user",
            content: "Compare with last month",
          },
          {
            _id: "message-previous-assistant",
            threadId: "thread-1",
            workspaceId: "workspace-1",
            role: "assistant",
            content: "Live campaign report",
            metadata: { intent: "meta_ads_mcp" },
          },
          {
            _id: "message-previous-user",
            threadId: "thread-1",
            workspaceId: "workspace-1",
            role: "user",
            content: "@meta Show campaign spend",
          },
        ],
      }),
    });
    mockAiriChatMessageFind.mockReturnValue({ sort });
    const stop = new Error("Stop after routing evidence");
    mockClassifyAiriChatIntent.mockImplementationOnce(async params => {
      expect(params.recentMessages).toEqual([
        {
          role: "user",
          content: "@meta Show campaign spend",
          intent: undefined,
        },
        {
          role: "assistant",
          content: "Live campaign report",
          intent: "meta_ads_mcp",
        },
      ]);
      throw stop;
    });
    await expect(
      generateAiriChatReply({
        supabase: {} as never,
        workspaceId: "workspace-1",
        userId: "user-1",
        threadId: "thread-1",
        userMessageId: "message-current",
        userMessage: "Compare with last month",
      })
    ).rejects.toBe(stop);
    expect(mockAiriChatMessageFind).toHaveBeenCalledWith(
      {
        workspaceId: "workspace-1",
        threadId: "thread-1",
      },
      AIRI_CHAT_TURN_HISTORY_PROJECTION
    );
    expect(sort).toHaveBeenCalledWith({ createdAt: -1 });
    expect(mockAiriChatMessageFind).toHaveBeenCalledTimes(1);
  });

  it("projects the per-turn history read to prompt and legacy confirmation fields", async () => {
    const sort = jest.fn().mockReturnValue({
      limit: () => ({
        lean: async () => [
          {
            _id: "message-legacy-confirmation",
            threadId: "thread-1",
            workspaceId: "workspace-1",
            role: "assistant",
            content: "Raw legacy provider payload",
            metadata: {
              intent: "meta_ads_mcp",
              confirmedMutationId: "mutation-1",
              confirmedToolName: "update_campaign",
              confirmationStatus: "succeeded",
            },
          },
        ],
      }),
    });
    mockAiriChatMessageFind.mockReturnValue({ sort });
    const history = await listAiriChatTurnHistory({
      workspaceId: "workspace-1",
      threadId: "thread-1",
    });
    const projection = mockAiriChatMessageFind.mock.calls[0][1];
    expect(Object.keys(projection).sort()).toEqual(
      [
        "_id",
        "threadId",
        "workspaceId",
        "role",
        "content",
        "createdAt",
        "metadata.intent",
        "metadata.confirmedMutationId",
        "metadata.confirmedToolName",
        "metadata.confirmationStatus",
      ].sort()
    );
    expect(projection).not.toHaveProperty("metadata");
    expect(sort).toHaveBeenCalledWith({ createdAt: -1 });
    // The legacy confirmation still renders its redacted summary.
    expect(history[0].content).toContain(
      "Unavailable for this legacy confirmation"
    );
    expect(history[0].content).toContain("update_campaign");
    expect(history[0].content).not.toContain("Raw legacy provider payload");
    expect(history[0].metadata).toMatchObject({ intent: "meta_ads_mcp" });
  });

  it("preserves ordinary chronological message listing", async () => {
    const sort = jest.fn().mockReturnValue({
      limit: () => ({ lean: async () => [] }),
    });
    mockAiriChatMessageFind.mockReturnValue({ sort });
    await listAiriChatMessages({
      workspaceId: "workspace-1",
      threadId: "thread-1",
    });
    expect(sort).toHaveBeenCalledWith({ createdAt: 1 });
  });

  function prepareCancelledTurn(intent: MockAiriChatIntent = "general_answer") {
    mockAiriChatIntent(intent);
    const thread = mockExistingThread();
    mockSearchAskDataContextLocal.mockResolvedValue({
      conversations: [],
      kbArticles: [],
    });
    mockEmptyTurnHistory();
    mockEchoedMessageCreate();
    const supabase = profilelessSupabase();
    return {
      thread,
      params: {
        supabase: supabase as never,
        workspaceId: "workspace-1",
        userId: "user-1",
        threadId: "thread-1",
        content: "Review the current customer request",
      },
    };
  }

  it.each(["AbortError", "TimeoutError"])(
    "does not persist a generic failure or analytics for thrown %s",
    async name => {
      const { params } = prepareCancelledTurn();
      const error = new DOMException("Request stopped", name);
      mockClassifyAiriChatIntent.mockRejectedValueOnce(error);
      await expect(appendAiriChatTurn(params)).rejects.toBe(error);
      expect(
        mockAiriChatMessageCreate.mock.calls.map(([doc]) => doc.role)
      ).toEqual(["user"]);
      expect(mockAiriChatThreadUpdateOne).not.toHaveBeenCalled();
      expect(
        jest.requireMock("@/lib/airi-chats/analytics")
          .recordAiriChatTurnAnalyticsEvents
      ).not.toHaveBeenCalled();
    }
  );

  it("rejects a pre-cancelled turn before persistence or classification", async () => {
    const { params } = prepareCancelledTurn();
    const controller = new AbortController();
    controller.abort();
    await expect(
      appendAiriChatTurn({ ...params, signal: controller.signal })
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(mockAiriChatMessageCreate).not.toHaveBeenCalled();
    expect(mockClassifyAiriChatIntent).not.toHaveBeenCalled();
  });

  it.each<MockAiriChatIntent>([
    "general_answer",
    "product_capability",
    "whatsapp_template",
    "whatsapp_flow",
    "image_generation",
    "opportunity_scan",
    "marketing_campaign",
  ])(
    "forwards cancellation into %s generation and avoids saving a stale reply",
    async intent => {
      const { params } = prepareCancelledTurn(intent);
      const controller = new AbortController();
      mockChatCompletionWithFallback.mockImplementationOnce(async () => {
        controller.abort();
        throw controller.signal.reason;
      });
      await expect(
        appendAiriChatTurn({ ...params, signal: controller.signal })
      ).rejects.toMatchObject({ name: "AbortError" });
      expect(mockClassifyAiriChatIntent).toHaveBeenCalledWith(
        expect.objectContaining({ signal: controller.signal })
      );
      // Local search runs under its own time limit combined with the caller.
      const localSignal = mockSearchAskDataContextLocal.mock.calls[0][0]
        .signal as AbortSignal;
      expect(localSignal.aborted).toBe(true);
      expect(mockChatCompletionWithFallback.mock.calls[0][0].signal).toBe(
        controller.signal
      );
      expect(
        mockAiriChatMessageCreate.mock.calls.map(([doc]) => doc.role)
      ).toEqual(["user"]);
      expect(mockAiriChatThreadUpdateOne).not.toHaveBeenCalled();
    }
  );

  it("stops after cancelled grounding without beginning normal generation", async () => {
    const { params } = prepareCancelledTurn();
    const controller = new AbortController();
    mockSearchAskDataContextLocal.mockImplementationOnce(async () => {
      controller.abort();
      return { conversations: [], kbArticles: [] };
    });
    await expect(
      appendAiriChatTurn({ ...params, signal: controller.signal })
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(mockChatCompletionWithFallback).not.toHaveBeenCalled();
  });

  it.each<MockAiriChatIntent>(["general_answer", "meta_ads_mcp"])(
    "does not save a completed %s reply cancelled immediately before persistence",
    async intent => {
      const { params } = prepareCancelledTurn(intent);
      const controller = new AbortController();
      if (intent === "general_answer")
        mockChatCompletionWithFallback.mockResolvedValueOnce({
          content: "Completed answer",
          provider: "vertex",
          model: "test-model",
          latencyMs: 10,
        });
      await expect(
        appendAiriChatTurn({
          ...params,
          signal: controller.signal,
          emitProgress: async event => {
            if (event.type === "stage" && event.id === "assistant_message")
              controller.abort();
          },
        })
      ).rejects.toMatchObject({ name: "AbortError" });
      expect(
        mockAiriChatMessageCreate.mock.calls.map(([doc]) => doc.role)
      ).toEqual(["user"]);
      expect(mockAiriChatThreadUpdateOne).not.toHaveBeenCalled();
    }
  );

  it.each([false, true])(
    "keeps gateway fallback only while caller is live (cancelled=%s)",
    async cancelled => {
      const { params } = prepareCancelledTurn();
      const controller = new AbortController();
      const error = new DOMException("Gateway deadline", "TimeoutError");
      const gateway = jest.requireMock("@/lib/ai/gcp-ai-gateway");
      gateway.canCallGcpAIGateway.mockReturnValue(true);
      gateway.getRemoteAskDataContext.mockImplementationOnce(async () => {
        if (cancelled) controller.abort(error);
        throw error;
      });
      if (!cancelled)
        mockChatCompletionWithFallback.mockResolvedValueOnce({
          content: "Answer from local context",
          provider: "vertex",
          model: "test-model",
          latencyMs: 10,
        });
      const work = appendAiriChatTurn({ ...params, signal: controller.signal });
      if (cancelled) {
        await expect(work).rejects.toBe(error);
        // Local search starts alongside the gateway and stops with the caller.
        expect(
          mockSearchAskDataContextLocal.mock.calls[0][0].signal.aborted
        ).toBe(true);
        expect(mockChatCompletionWithFallback).not.toHaveBeenCalled();
      } else {
        await expect(work).resolves.toMatchObject({
          assistantMessage: { content: "Answer from local context" },
        });
        expect(mockSearchAskDataContextLocal).toHaveBeenCalledTimes(1);
      }
    }
  );

  beforeEach(() => {
    jest.clearAllMocks();
    mockLoggerError.mockReset();
    mockCreateAiriArtifact.mockReset();
    mockUpdateAiriArtifact.mockReset();
    mockClassifyAiriChatIntent.mockReset();
    mockCreateQueuedAiriImageGeneration.mockReset();
    mockStartQueuedAiriImageGeneration.mockReset();
    mockUpdateQueuedAiriImageGenerationTarget.mockReset();
    mockRunMetaAdsMcpTurn.mockReset();
    mockRetrieveAiriProductKbArticles.mockReset();
    mockRetrieveAiriProductKbArticles.mockResolvedValue([]);
    mockMessageFind.mockReset();
    mockCustomerMessageExcerpts();
    mockAiriChatIntent("general_answer");
    const gcpGateway = jest.requireMock("@/lib/ai/gcp-ai-gateway") as {
      canCallGcpAIGateway: jest.Mock;
      getRemoteAskDataContext: jest.Mock;
    };
    gcpGateway.canCallGcpAIGateway.mockReturnValue(false);
    gcpGateway.getRemoteAskDataContext.mockReset();
    mockResolveAiriMarketingToolAccess.mockResolvedValue(
      defaultMarketingToolAccess
    );
    mockCreateAiriArtifact.mockImplementation(
      async (params: { kind?: string }) => ({
        id:
          params.kind === "marketing_campaign"
            ? "campaign-artifact-1"
            : params.kind === "opportunity_scan"
              ? "opportunity-artifact-1"
              : "artifact-1",
        kind: params.kind ?? "whatsapp_template",
        revision: 0,
        status: "draft",
        validation: { status: "valid", issues: [] },
      })
    );
    mockUpdateAiriArtifact.mockResolvedValue({
      id: "artifact-1",
      kind: "whatsapp_template",
      revision: 6,
      status: "draft",
      validation: { status: "valid", issues: [] },
    });
    mockCreateQueuedAiriImageGeneration.mockResolvedValue(null);
    mockStartQueuedAiriImageGeneration.mockResolvedValue(undefined);
    mockUpdateQueuedAiriImageGenerationTarget.mockResolvedValue(undefined);
    mockRunMetaAdsMcpTurn.mockResolvedValue({
      content: "Meta Ads answer",
      pendingMutations: [],
      toolTrace: [],
    });
    mockAiriChatThreadFindOne.mockResolvedValue({
      _id: "thread-1",
      title: "New chat",
      source: "manual",
      save: jest.fn(),
    });
  });

  it.each(["append", "create"])(
    "uses the persisted message identity for %s and direct reply retries",
    async operation => {
      const model = jest.requireMock(
        "@/models/airi-chat-thread"
      ).AiriChatThread;
      model.create.mockImplementation(async (doc: Record<string, unknown>) => ({
        ...doc,
        _id: "thread-1",
      }));
      mockPlatformAdmission();
      mockEmptyTurnHistory();
      mockAiriChatMessageCreate.mockImplementation(
        async (doc: Record<string, unknown>) => ({
          ...doc,
          _id:
            doc._id ??
            (doc.role === "user" ? "message-user" : "message-assistant"),
          createdAt: new Date(),
        })
      );
      mockSearchAskDataContextLocal.mockResolvedValue({
        conversations: [],
        kbArticles: [],
      });
      mockBuildSelectedAiriChatGroundingContext.mockImplementationOnce(
        async () => {
          await resolveWorkspaceTextAiBilling();
          return {
            conversations: [],
            kbArticles: [],
            selectedSources: [],
            selectedSourceLabels: [],
            promptSections: [],
            sourceIds: [],
            conversationSourceIds: [],
            kbSourceIds: [],
            retrievalPath: "none",
          };
        }
      );
      mockClassifyAiriChatIntent.mockImplementationOnce(async () => {
        await resolveWorkspaceTextAiBilling();
        return buildMockIntentClassification("general_answer");
      });
      mockChatCompletionWithFallback.mockImplementation(async () => {
        await resolveWorkspaceTextAiBilling();
        return {
          content: "A helpful answer",
          provider: "vertex",
          model: "gemini-heavy",
        };
      });
      const supabase = profilelessSupabase();
      const append =
        operation === "append"
          ? appendAiriChatTurn
          : createAndAppendAiriChatTurn;
      const result = await append({
        supabase: supabase as never,
        workspaceId: "workspace-1",
        userId: "user-1",
        threadId: "thread-1",
        content: "Analyze our sales",
        selectedSources: [
          {
            kind: "workspace_source",
            sourceId: "source-1",
            sourceType: "canva",
            label: "Canva",
          },
        ],
      });
      expect(mockChatCompletionWithFallback).toHaveBeenCalledTimes(2);
      expect(mockAiAdmissionRpc).toHaveBeenCalledTimes(1);
      const persistedMessage = mockAiriChatMessageCreate.mock.calls[0][0];
      expect(persistedMessage._id).toBeDefined();
      expect(String(persistedMessage._id)).toBe(result.userMessage.id);
      expect(mockAiAdmissionRpc).toHaveBeenLastCalledWith(
        "admit_workspace_text_ai_action",
        {
          p_workspace_id: "workspace-1",
          p_action_id: `airi-chat:${result.userMessage.id}`,
        }
      );

      mockClassifyAiriChatIntent.mockImplementationOnce(async () => {
        await resolveWorkspaceTextAiBilling();
        throw new Error("Stop after retry admission");
      });
      await expect(
        generateAiriChatReply({
          supabase: supabase as never,
          workspaceId: "workspace-1",
          userId: "user-1",
          threadId: result.thread.id,
          userMessageId: result.userMessage.id,
          userMessage: "Analyze our sales",
        })
      ).rejects.toThrow("Stop after retry admission");
      expect(mockAiAdmissionRpc).toHaveBeenCalledTimes(2);
      expect(mockAiAdmissionRpc.mock.calls[1]).toEqual(
        mockAiAdmissionRpc.mock.calls[0]
      );
    }
  );

  it("bounds combined workspace input while retaining every selected file and the latest request", async () => {
    mockAiriChatMessageFind.mockReturnValue({
      sort: () => ({
        limit: () => ({
          // The recent read sorts newest first; HISTORY-11 is the latest.
          lean: async () =>
            Array.from({ length: 12 }, (_, i) => ({
              role: "user",
              content: `HISTORY-${11 - i} ${"история ".repeat(3000)}`,
              createdAt: new Date(),
            })),
        }),
      }),
    });
    mockSearchAskDataContextLocal.mockResolvedValue({
      conversations: [
        {
          id: "conversation-1",
          summary:
            "Customer needs a refund. " + "customer context ".repeat(10000),
        },
      ],
      kbArticles: [
        {
          id: "article-1",
          title: "Refund policy",
          content: "Refunds within 30 days. " + "knowledge ".repeat(10000),
          relevance_score: 0.9,
        },
      ],
    });
    mockChatCompletionWithFallback.mockResolvedValue({
      content: "Grounded answer",
      provider: "vertex",
      model: "gemini-heavy",
      latencyMs: 10,
    });
    const supabase = chainedSupabase();
    await generateAiriChatReply({
      supabase: supabase as never,
      workspaceId: "workspace-1",
      userId: "user-1",
      threadId: "thread-1",
      userMessage:
        "LATEST-REQUEST: Compare the refund evidence in all eight files.",
      attachedFiles: Array.from({ length: 8 }, (_, index) => ({
        name: `SELECTED-${index}.txt`,
        size: 50000,
        textExcerpt: `FILE-EVIDENCE-${index} ` + "附件内容 ".repeat(10000),
      })),
    });
    const prompt = mockChatCompletionWithFallback.mock.calls[0][0].messages[0]
      .content as string;
    const { estimateTokenCount } = jest.requireActual(
      "@/lib/airi/shared/token-budget"
    );
    expect(prompt.length).toBeLessThanOrEqual(AIRI_CHAT_INPUT_CHAR_LIMIT);
    expect(estimateTokenCount(prompt)).toBeLessThanOrEqual(
      AIRI_CHAT_INPUT_TOKEN_LIMIT
    );
    for (let i = 0; i < 8; i++) expect(prompt).toContain(`SELECTED-${i}.txt`);
    expect(prompt).toContain("LATEST-REQUEST");
    expect(prompt).toContain("HISTORY-11");
    expect(prompt).toContain("Refund policy");
    expect(prompt).toContain("Do not invent an answer");
    expect(prompt.indexOf("WORKSPACE KNOWLEDGE:")).toBeLessThan(
      prompt.indexOf("THREAD HISTORY:")
    );
  });

  it("pins direct reply requests to their user message identity", async () => {
    mockPlatformAdmission();
    mockClassifyAiriChatIntent.mockImplementationOnce(async () => {
      await resolveWorkspaceTextAiBilling();
      throw new Error("Stop after intent");
    });
    await expect(
      generateAiriChatReply({
        supabase: {} as never,
        workspaceId: "workspace-1",
        userId: "user-1",
        threadId: "thread-1",
        userMessageId: "message-stable",
        userMessage: "Analyze",
      })
    ).rejects.toThrow("Stop after intent");
    expect(mockAiAdmissionRpc).toHaveBeenCalledWith(
      "admit_workspace_text_ai_action",
      { p_workspace_id: "workspace-1", p_action_id: "airi-chat:message-stable" }
    );
  });

  it("marks selected sources with no excerpts while retaining automatic workspace evidence", async () => {
    const selectedSource = {
      kind: "context_item" as const,
      optionId: "conversation_timeline" as const,
      itemId: "selected-empty",
      label: "Selected conversation",
    };
    mockBuildSelectedAiriChatGroundingContext.mockResolvedValue({
      selectedSources: [selectedSource],
      selectedSourceLabels: [selectedSource.label],
      conversations: [],
      kbArticles: [],
      promptSections: [],
      sourceIds: [],
      conversationSourceIds: [],
      kbSourceIds: [],
      retrievalPath: "none",
    });
    mockEmptyTurnHistory();
    mockSearchAskDataContextLocal.mockResolvedValue({
      conversations: [],
      kbArticles: [
        {
          id: "kb-1",
          title: "Refund policy",
          content: "Refunds within 30 days.",
          relevance_score: 0.9,
        },
      ],
    });
    mockChatCompletionWithFallback.mockResolvedValue({
      content: "Refunds within 30 days.",
      provider: "vertex",
      model: "gemini-heavy",
    });
    const supabase = profilelessSupabase();
    await generateAiriChatReply({
      supabase: supabase as never,
      workspaceId: "workspace-1",
      userId: "user-1",
      threadId: "thread-1",
      userMessage: "What is our refund policy?",
      selectedSources: [selectedSource],
    });

    const prompt = mockChatCompletionWithFallback.mock.calls[0][0].messages[0]
      .content as string;
    expect(prompt).toContain("- Selected conversation");
    expect(prompt).toContain(
      "No additional excerpts were found for those attached sources."
    );
    expect(prompt).toContain("Refunds within 30 days.");
    expect(prompt).toContain(
      "If an attached source does not contain enough information, say that clearly"
    );
  });

  it("persists a source requirement raised during selected grounding", async () => {
    mockBuildSelectedAiriChatGroundingContext.mockRejectedValueOnce(
      new WorkspaceAiSourceRequiredError(
        "workspace-1",
        "2026-10-01T00:00:00.000Z"
      )
    );
    mockEchoedMessageCreate();
    await appendAiriChatTurn({
      supabase: {} as never,
      workspaceId: "workspace-1",
      userId: "user-1",
      threadId: "thread-1",
      content: "Analyze",
      selectedSources: [
        {
          kind: "workspace_source",
          sourceId: "source-1",
          sourceType: "canva",
          label: "Canva",
        },
      ],
    });
    expect(mockAiriChatMessageCreate).toHaveBeenLastCalledWith(
      expect.objectContaining({
        role: "assistant",
        metadata: expect.objectContaining({
          errorCode: "own_ai_source_required",
        }),
      })
    );
    expect(mockClassifyAiriChatIntent).not.toHaveBeenCalled();
    expect(mockChatCompletionWithFallback).not.toHaveBeenCalled();
  });

  it("persists a new chat when selected grounding requires an AI source", async () => {
    const model = jest.requireMock("@/models/airi-chat-thread").AiriChatThread;
    model.create.mockImplementation(async (doc: Record<string, unknown>) => ({
      ...doc,
      _id: "thread-1",
    }));
    mockBuildSelectedAiriChatGroundingContext.mockRejectedValueOnce(
      new WorkspaceAiSourceRequiredError(
        "workspace-1",
        "2026-10-01T00:00:00.000Z"
      )
    );
    mockEchoedMessageCreate();
    const result = await createAndAppendAiriChatTurn({
      supabase: {} as never,
      workspaceId: "workspace-1",
      userId: "user-1",
      content: "Analyze",
      selectedSources: [
        {
          kind: "workspace_source",
          sourceId: "source-1",
          sourceType: "canva",
          label: "Canva",
        },
      ],
    });
    expect(result.assistantMessage.metadata).toMatchObject({
      errorCode: "own_ai_source_required",
    });
    expect(mockBuildSelectedAiriChatGroundingContext).toHaveBeenCalledTimes(1);
    expect(mockChatCompletionWithFallback).not.toHaveBeenCalled();
  });

  it("establishes the allowance scope before selected grounding", async () => {
    mockPlatformAdmission();
    mockBuildSelectedAiriChatGroundingContext.mockImplementationOnce(
      async () => {
        expect(await resolveWorkspaceTextAiBilling()).toMatchObject({
          workspaceId: "workspace-1",
          billingSource: "platform",
        });
        throw new Error("Stop after grounding");
      }
    );
    await expect(
      appendAiriChatTurn({
        supabase: {} as never,
        workspaceId: "workspace-1",
        userId: "user-1",
        threadId: "thread-1",
        content: "Analyze",
        selectedSources: [
          {
            kind: "workspace_source",
            sourceId: "source-1",
            sourceType: "canva",
            label: "Canva",
          },
        ],
      })
    ).rejects.toThrow("Stop after grounding");
    expect(mockAiAdmissionRpc).toHaveBeenCalledTimes(1);
  });

  it("persists an actionable allowance denial and does not generate a title", async () => {
    mockClassifyAiriChatIntent.mockRejectedValueOnce(
      new WorkspaceAiSourceRequiredError(
        "workspace-1",
        "2026-10-01T00:00:00.000Z"
      )
    );
    mockEchoedMessageCreate();
    await appendAiriChatTurn({
      supabase: {} as never,
      workspaceId: "workspace-1",
      userId: "user-1",
      threadId: "thread-1",
      content: "Analyze our sales",
    });
    expect(mockAiriChatMessageCreate).toHaveBeenLastCalledWith(
      expect.objectContaining({
        role: "assistant",
        content: expect.stringContaining(
          "/panel/w/workspace-1/settings/integrations"
        ),
        metadata: expect.objectContaining({
          failed: true,
          errorCode: "own_ai_source_required",
        }),
      })
    );
    expect(mockChatCompletionWithFallback).not.toHaveBeenCalled();
  });

  it("validates selected sources before persisting the user message", async () => {
    const supabase = {};
    mockBuildSelectedAiriChatGroundingContext.mockRejectedValue(
      new Error("Selected source is unavailable: Canva")
    );

    await expect(
      appendAiriChatTurn({
        supabase: supabase as never,
        workspaceId: "workspace-1",
        userId: "user-1",
        threadId: "thread-1",
        content: "Check pricing",
        selectedSources: [
          {
            kind: "workspace_source",
            sourceId: "source-1",
            sourceType: "canva",
            label: "Canva",
          },
        ],
      })
    ).rejects.toThrow("Selected source is unavailable");

    expect(mockBuildSelectedAiriChatGroundingContext).toHaveBeenCalledWith({
      supabase,
      workspaceId: "workspace-1",
      userId: "user-1",
      query: "Check pricing",
      selectedSources: [
        {
          kind: "workspace_source",
          sourceId: "source-1",
          sourceType: "canva",
          label: "Canva",
        },
      ],
    });
    expect(mockAiriChatMessageCreate).not.toHaveBeenCalled();
  });

  it("keeps automatic workspace context and neutrally formats a stale selected conversation", async () => {
    const { supabase } = prepareAnswerTurn(
      "@Selected conversation Plan support content",
      "Use delivery questions in support content."
    );
    mockBuildSelectedAiriChatGroundingContext.mockResolvedValue({
      selectedSources: [
        {
          kind: "context_item",
          optionId: "conversation_timeline",
          itemId: "selected-stale",
          label: "Selected conversation",
        },
      ],
      selectedSourceLabels: ["Selected conversation"],
      conversations: [
        {
          id: "selected-stale",
          summary: "Asked about an existing order.",
        },
      ],
      kbArticles: [],
      promptSections: ["[Conversation 1]: Asked about an existing order."],
      sourceIds: ["conversation:selected-stale"],
      conversationSourceIds: ["conversation:selected-stale"],
      kbSourceIds: [],
      retrievalPath: "snippet",
    });
    mockSearchAskDataContextLocal.mockResolvedValue({
      conversations: [
        {
          id: "conversation-1",
          summary: "Customers ask about delivery windows.",
          category: "Support",
          priority: "medium",
        },
      ],
      kbArticles: [
        {
          id: "kb-1",
          title: "Delivery policy",
          content: "Delivery takes two business days.",
          relevance_score: 0.9,
        },
      ],
      metadata: {
        retrievalPath: "blended",
        vectorIndex: "vector_search_conversations_v2",
        fallbackConversationCount: 0,
      },
    });
    mockChatCompletionWithFallback.mockResolvedValue({
      content: "Use delivery questions in support content.",
      provider: "vertex",
      model: "gemini-heavy",
      latencyMs: 100,
    });

    await appendAiriChatTurn({
      supabase: supabase as never,
      workspaceId: "workspace-1",
      userId: "user-1",
      threadId: "thread-1",
      content: "@Selected conversation Plan support content",
      selectedSources: [
        {
          kind: "context_item",
          optionId: "conversation_timeline",
          itemId: "selected-stale",
          label: "Selected conversation",
        },
      ],
    });

    const prompt = generationPrompt();
    expect(prompt).toContain("ATTACHED SOURCES:");
    expect(prompt).toContain(
      "[Conversation 1]: Asked about an existing order."
    );
    expect(prompt).toContain('[KB Article 1] "Delivery policy"');
    expect(prompt).toContain(
      "[Conversation 2] Support (medium): Customers ask about delivery windows."
    );
    expect(prompt).not.toContain("General (normal)");
    expect(prompt).not.toContain("Use only the selected source");
  });

  it("persists a cancelled Meta Ads report without starting a new title generation", async () => {
    const controller = new AbortController();
    const thread = {
      _id: "thread-1",
      title: "New chat",
      source: "manual",
      save: jest.fn(),
    };
    mockAiriChatThreadFindOne.mockResolvedValue(thread);
    mockAiriChatIntent("meta_ads_mcp");
    mockBuildSelectedAiriChatGroundingContext.mockResolvedValue({
      selectedSources: [],
      selectedSourceLabels: [],
      conversations: [],
      kbArticles: [],
      promptSections: [],
      sourceIds: [],
      conversationSourceIds: [],
      kbSourceIds: [],
      retrievalPath: "none",
    });
    mockSearchAskDataContextLocal.mockResolvedValue({
      conversations: [],
      kbArticles: [],
    });
    mockEmptyTurnHistory();
    mockEchoedMessageCreate();
    mockRunMetaAdsMcpTurn.mockImplementationOnce(async () => {
      controller.abort();
      return {
        content: "The Meta Ads request stopped before it finished.",
        pendingMutations: [],
        toolTrace: [],
        coverage: {
          complete: false,
          successfulReads: 0,
          pendingPages: 0,
          pendingContinuations: 0,
          reasons: ["cancelled"],
        },
      };
    });
    const supabase = profilelessSupabase();
    await appendAiriChatTurn({
      supabase: supabase as never,
      workspaceId: "workspace-1",
      userId: "user-1",
      threadId: "thread-1",
      content: "@meta summarize campaigns",
      signal: controller.signal,
    });
    expect(mockAiriChatMessageCreate).toHaveBeenLastCalledWith(
      expect.objectContaining({
        role: "assistant",
        content: "The Meta Ads request stopped before it finished.",
      })
    );
    expect(thread.title).toBe("New chat");
    // Only updatedAt moves; no title is written for a cancelled turn.
    expect(mockAiriChatThreadUpdateOne.mock.calls).toEqual([
      [{ _id: "thread-1" }, { $set: { updatedAt: expect.any(Date) } }],
    ]);
    expect(mockChatCompletionWithFallback).not.toHaveBeenCalled();
  });

  it("passes thread, selected, and Creative Asset context to Meta Ads MCP without searching the workspace", async () => {
    const controller = new AbortController();
    const coverage = {
      complete: false,
      successfulReads: 1,
      reason: "budget_exhausted",
    };
    mockRunMetaAdsMcpTurn.mockResolvedValueOnce({
      content: "Partial report",
      pendingMutations: [],
      toolTrace: [],
      coverage,
    });
    const assetId = "507f1f77bcf86cd799439011";
    mockAiriChatIntent("meta_ads_mcp");
    mockAiriChatMessageFind.mockReturnValue({
      sort: jest.fn().mockReturnValue({
        limit: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue([
            {
              _id: "user-message-1",
              role: "user",
              content: "@meta create an ad using my attached launch image",
              createdAt: new Date("2026-08-05T08:01:00.000Z"),
            },
            {
              role: "user",
              content: "We are launching Product A",
              createdAt: new Date("2026-08-05T08:00:00.000Z"),
            },
          ]),
        }),
      }),
    });
    mockSearchAskDataContextLocal.mockResolvedValue({
      conversations: [
        {
          id: "conversation-1",
          summary: "Customers ask for annual billing.",
          category: "Sales",
          priority: "high",
        },
      ],
      kbArticles: [
        {
          id: "kb-1",
          title: "Product A",
          content: "Product A is the premium plan.",
          relevance_score: 0.95,
        },
      ],
      metadata: {
        retrievalPath: "blended",
        vectorIndex: "vector_search_conversations_v2",
        fallbackConversationCount: 0,
      },
    });
    mockCustomerMessageExcerpts([
      {
        direction: "inbound",
        text: "Can I pay annually?",
        date: new Date("2026-08-05T08:10:00.000Z"),
      },
    ]);
    const selectedContext = {
      selectedSources: [
        {
          kind: "workspace_source" as const,
          sourceId: "canva-1",
          sourceType: "canva",
          label: "Canva",
        },
      ],
      selectedSourceLabels: ["Canva"],
      conversations: [],
      kbArticles: [
        {
          id: "canva-brand-kit",
          title: "Brand kit",
          content: "Use the launch palette.",
          relevance_score: 1,
        },
      ],
      promptSections: ["Canva brand kit is connected."],
      sourceIds: ["workspace_source:canva-1"],
      conversationSourceIds: [],
      kbSourceIds: ["workspace_source:canva-1"],
      retrievalPath: "kb" as const,
    };
    const supabase = chainedSupabase();

    const reply = await generateAiriChatReply({
      supabase: supabase as never,
      workspaceId: "workspace-1",
      userId: "user-1",
      threadId: "thread-1",
      userMessageId: "user-message-1",
      userMessage: "@meta create an ad using my attached launch image",
      signal: controller.signal,
      selectedSources: selectedContext.selectedSources,
      preparedSelectedContext: selectedContext,
      attachedFiles: [
        {
          name: "launch.jpg",
          type: "image/jpeg",
          size: 1200,
          creativeAssetId: assetId,
        },
      ],
    });

    expect(mockRunMetaAdsMcpTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-1",
        clientConversationId: "ABCDEFGHIJKLMNOPQRST",
        threadId: "thread-1",
        analytics: {
          conversationId: "thread-1",
          messageId: "user-message-1",
        },
        signal: controller.signal,
        creativeAssetIds: [assetId],
        groundingContext: {
          threadHistory: expect.stringContaining("We are launching Product A"),
          attachedSources: expect.stringContaining(
            "Canva brand kit is connected"
          ),
          attachedFiles: expect.stringContaining("launch.jpg"),
          // Attached sources still ground the turn; the automatic workspace
          // KB/chat search does not run for Meta Ads.
          workspaceKnowledge: expect.stringContaining("Use the launch palette"),
          customerContext: "",
        },
      })
    );
    expect(mockSearchAskDataContextLocal).not.toHaveBeenCalled();
    const grounding = mockRunMetaAdsMcpTurn.mock.calls[0][0].groundingContext;
    expect(grounding.workspaceKnowledge).not.toContain(
      "Product A is the premium plan"
    );
    expect(reply.analytics.sourceIds).toEqual(
      expect.arrayContaining(["workspace_source:canva-1"])
    );
    expect(reply.metadata.airiMetaAdsMcpCoverage).toEqual(coverage);
    const loadBusinessEvidence =
      mockRunMetaAdsMcpTurn.mock.calls[0][0].loadBusinessEvidence;
    expect(loadBusinessEvidence).toEqual(expect.any(Function));
    const selectedAdAccount = {
      id: "act_123",
      currency: "USD",
      timezone_name: "UTC",
    };
    await loadBusinessEvidence({
      sourceId: "meta-source",
      selectedAdAccount,
      signal: controller.signal,
    });
    expect(mockLoadMetaAdsMcpBusinessEvidence).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-1",
        sourceId: "meta-source",
        selectedAdAccount,
        userMessage: "@meta create an ad using my attached launch image",
        previousUserMessages: ["We are launching Product A"],
        signal: controller.signal,
      })
    );
  });

  it("creates durable opportunity scan artifacts from connected channel scans", async () => {
    mockAiriChatIntent("opportunity_scan");
    mockBuildSelectedAiriChatGroundingContext.mockResolvedValue({
      selectedSources: [
        {
          kind: "connector",
          connector: "whatsapp",
          sourceId: "wa-1",
          label: "WhatsApp",
          capabilities: ["docs", "templates", "flows"],
        },
      ],
      selectedSourceLabels: ["WhatsApp"],
      conversations: [],
      kbArticles: [],
      promptSections: [],
      sourceIds: ["connector:whatsapp:wa-1"],
      conversationSourceIds: [],
      kbSourceIds: [],
      retrievalPath: "selected_sources",
    });
    mockEmptyTurnHistory();
    mockSearchAskDataContextLocal.mockResolvedValue({
      conversations: [
        {
          id: "conversation-1",
          summary: "Leads ask for appointment times and then stop replying.",
          category: "Sales",
          priority: "high",
        },
      ],
      kbArticles: [],
      metadata: {
        retrievalPath: "blended",
        vectorIndex: "vector_search_conversations_v2",
        fallbackConversationCount: 0,
      },
    });
    mockCustomerMessageExcerpts([
      {
        direction: "inbound",
        text: "Do you have a free slot tomorrow?",
        date: new Date("2026-06-17T08:00:00.000Z"),
      },
    ]);
    mockChatCompletionWithFallback.mockResolvedValueOnce({
      content: JSON.stringify({
        title: "Customer channel opportunities",
        summary: "Customers are asking for bookings but need faster follow-up.",
        opportunities: [
          {
            id: "booking-follow-up",
            title: "Recover booking leads",
            priority: "high",
            problem: "Booking leads stop after asking for appointment times.",
            customerSignal:
              "A recent inbound message asks for a free slot tomorrow.",
            recommendedAction:
              "Create a WhatsApp reminder scenario with booking confirmation and no-reply recovery.",
            evidence: ["Inbound: Do you have a free slot tomorrow?"],
            recommendedArtifacts: [
              "scenario",
              "whatsapp_template",
              "bulk_campaign",
            ],
            missingInputs: ["Calendar availability source"],
          },
        ],
        nextAction: "Create the booking reminder scenario from this scan.",
      }),
      provider: "anthropic",
      model: "claude-sonnet-5-5",
      latencyMs: 70,
      usage: { totalTokens: 300 },
    });
    const supabase = chainedSupabase();

    const reply = await generateAiriChatReply({
      supabase: supabase as never,
      workspaceId: "workspace-1",
      userId: "user-1",
      threadId: "thread-1",
      userMessageId: "user-message-1",
      userMessage:
        "Scan my connected customer channels and create a ranked opportunity plan.",
      selectedSources: [
        {
          kind: "connector",
          connector: "whatsapp",
          sourceId: "wa-1",
          label: "WhatsApp",
          capabilities: ["docs", "templates", "flows"],
        },
      ],
    });

    expect(mockChatCompletionWithFallback.mock.calls[0]?.[0]?.model).toBe(
      "heavy-text-model"
    );
    // Long JSON on the heavy tier: past the 30 s AI default.
    expect(draftCallTimeoutMs("opportunity_scan")).toBe(60_000);
    // Analytics and metadata record the model that served the scan.
    expect(reply.analytics).toEqual(
      expect.objectContaining({ generationModel: "claude-sonnet-5-5" })
    );
    expect(reply.metadata).toEqual(
      expect.objectContaining({
        provider: "anthropic",
        model: "claude-sonnet-5-5",
        airiOpportunityScan: expect.objectContaining({
          title: "Customer channel opportunities",
          opportunities: expect.arrayContaining([
            expect.objectContaining({
              id: "booking-follow-up",
              priority: "high",
              recommendedArtifacts: expect.arrayContaining(["scenario"]),
            }),
          ]),
        }),
        airiOpportunityArtifact: expect.objectContaining({
          id: "opportunity-artifact-1",
          kind: "opportunity_scan",
          revision: 0,
          status: "draft",
        }),
      })
    );
    expect(mockCreateAiriArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-1",
        threadId: "thread-1",
        userId: "user-1",
        kind: "opportunity_scan",
        sourceMessageId: "user-message-1",
        snapshot: {
          opportunityScan: expect.objectContaining({
            title: "Customer channel opportunities",
          }),
        },
      })
    );
  });

  it("persists a source-aware campaign package for marketing content intent", async () => {
    mockAiriChatIntent("marketing_campaign");
    const { supabase, params } = prepareAnswerTurn(
      "Create an engagement campaign with video and voiceover",
      "I prepared a campaign package."
    );
    mockSearchAskDataContextLocal.mockResolvedValue({
      conversations: [
        {
          id: "conversation-1",
          summary: "Several warm leads asked about pricing but did not book.",
          category: "Sales",
          priority: "high",
        },
      ],
      kbArticles: [
        {
          id: "kb-1",
          title: "Offer rules",
          content: "Do not promise discounts unless supplied by the manager.",
          relevance_score: 0.8,
        },
      ],
      metadata: {
        retrievalPath: "blended",
        vectorIndex: "vector_search_conversations_v2",
        fallbackConversationCount: 0,
      },
    });
    mockChatCompletionWithFallback
      .mockResolvedValueOnce({
        content: JSON.stringify({
          title: "Pricing lead win-back",
          goal: "Recover warm leads who asked about pricing.",
          audience: "Warm WhatsApp leads from recent pricing conversations",
          angle: "Helpful follow-up with a clear reply",
          evidence: ["Recent conversations mention pricing."],
          tools: defaultMarketingToolAccess,
          steps: [
            {
              id: "template",
              kind: "whatsapp_template",
              title: "Draft WhatsApp template",
              description: "Create a compliant re-engagement template.",
              status: "ready",
              tool: "whatsapp",
            },
            {
              id: "video",
              kind: "visual_asset",
              title: "Generate video",
              description: "Create a vertical campaign video.",
              status: "blocked",
              tool: "visualGeneration",
              blockers: ["Connect Higgsfield first."],
            },
            {
              id: "voiceover",
              kind: "audio_asset",
              title: "Generate voiceover",
              description: "Create a short voiceover.",
              status: "blocked",
              tool: "audioGeneration",
              blockers: ["Connect ElevenLabs first."],
            },
          ],
          checks: [
            { label: "WhatsApp category", status: "pending" },
            { label: "Human approval", status: "pending" },
          ],
          nextAction: "Review the WhatsApp template.",
        }),
        provider: "vertex",
        model: "gemini-light",
        latencyMs: 90,
      })
      .mockResolvedValueOnce({
        content: JSON.stringify({
          name: "pricing_lead_winback",
          language: "en",
          category: "MARKETING",
          components: [{ type: "BODY", text: "Hi {{1}}, want help booking?" }],
        }),
        provider: "vertex",
        model: "gemini-light",
        latencyMs: 60,
      });
    mockUpdateAiriArtifact.mockResolvedValueOnce({
      id: "artifact-flow-1",
      kind: "whatsapp_flow",
      revision: 9,
      status: "draft",
      validation: { status: "valid", issues: [] },
    });

    await appendAiriChatTurn(params);

    expect(mockResolveAiriMarketingToolAccess).toHaveBeenCalledWith({
      supabase,
      workspaceId: "workspace-1",
    });
    expect(mockChatCompletionWithFallback.mock.calls[0]?.[0]?.model).toBe(
      "heavy-text-model"
    );
    expect(draftCallTimeoutMs("campaign_package")).toBe(90_000);
    const prompt = generationPrompt();
    expect(prompt).toContain("TOOL AVAILABILITY:");
    expect(prompt).toContain("Connect ElevenLabs");
    expect(mockAiriChatMessageCreate).toHaveBeenLastCalledWith(
      expect.objectContaining({
        role: "assistant",
        metadata: expect.objectContaining({
          airiCampaignPackage: expect.objectContaining({
            title: "Pricing lead win-back",
            tools: expect.objectContaining({
              visualGeneration: expect.objectContaining({ available: false }),
              audioGeneration: expect.objectContaining({ available: false }),
            }),
            steps: expect.arrayContaining([
              expect.objectContaining({
                kind: "whatsapp_template",
                actionHref:
                  "/panel/w/workspace-1/messengers/whatsapp-templates",
              }),
              expect.objectContaining({
                kind: "visual_asset",
                status: "blocked",
              }),
              expect.objectContaining({
                kind: "audio_asset",
                status: "blocked",
              }),
            ]),
          }),
          airiCampaignArtifact: expect.objectContaining({
            id: "campaign-artifact-1",
            kind: "marketing_campaign",
            revision: 0,
            status: "draft",
          }),
        }),
      })
    );
    expect(mockCreateAiriArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-1",
        threadId: "thread-1",
        userId: "user-1",
        kind: "marketing_campaign",
        sourceMessageId: "user-message-1",
        snapshot: expect.objectContaining({
          campaignPackage: expect.objectContaining({
            title: "Pricing lead win-back",
          }),
        }),
      })
    );
  });

  it("persists creative asset handoff drafts for connected campaign tools", async () => {
    mockAiriChatIntent("marketing_campaign");
    const thread = {
      _id: "thread-1",
      title: "Existing chat",
      source: "manual",
      save: jest.fn(),
    };
    const creativeToolAccess = {
      ...defaultMarketingToolAccess,
      canva: {
        available: true,
        label: "Canva",
        source: "workspace_source",
        sourceId: "canva-1",
        actionHref: "/panel/w/workspace-1/assets",
      },
      visualGeneration: {
        available: true,
        label: "Higgsfield visual generation",
        source: "workspace_source",
        sourceId: "higgsfield-1",
        actionHref: "/panel/w/workspace-1/assets",
      },
      audioGeneration: {
        available: true,
        label: "ElevenLabs audio generation",
        source: "workspace_source",
        sourceId: "elevenlabs-1",
        actionHref: "/panel/w/workspace-1/assets",
      },
    } as const;
    mockResolveAiriMarketingToolAccess.mockResolvedValue(creativeToolAccess);
    mockAiriChatThreadFindOne.mockResolvedValue(thread);
    mockSearchAskDataContextLocal.mockResolvedValue({
      conversations: [
        {
          id: "conversation-1",
          summary: "Warm leads asked to see the offer before booking.",
          category: "Sales",
          priority: "high",
        },
      ],
      kbArticles: [],
      metadata: {
        retrievalPath: "blended",
        vectorIndex: "vector_search_conversations_v2",
        fallbackConversationCount: 0,
      },
    });
    mockEmptyTurnHistory();
    mockPersistedTurn(
      "Create campaign creative with Canva video and voiceover",
      "I prepared a campaign package."
    );
    mockChatCompletionWithFallback.mockResolvedValue({
      content: JSON.stringify({
        title: "Demo lead creative push",
        goal: "Turn warm demo leads into booked calls.",
        audience: "Warm WhatsApp leads from demo conversations",
        angle: "Show the offer visually, then ask for a simple reply",
        evidence: ["Warm leads asked to see the offer."],
        tools: creativeToolAccess,
        steps: [
          {
            id: "canva",
            kind: "canva_design",
            title: "Prepare Canva story",
            description: "Use connected brand templates for the story layout.",
            status: "ready",
            tool: "canva",
          },
          {
            id: "video",
            kind: "visual_asset",
            title: "Generate vertical video",
            description: "Create a mobile-first product reveal video.",
            status: "approval_required",
            tool: "visualGeneration",
          },
          {
            id: "voiceover",
            kind: "audio_asset",
            title: "Generate voiceover",
            description: "Create a warm short voiceover.",
            status: "ready",
            tool: "audioGeneration",
          },
        ],
        checks: [{ label: "Human approval", status: "pending" }],
        nextAction: "Review the creative drafts.",
      }),
      provider: "vertex",
      model: "gemini-light",
      latencyMs: 90,
    });
    const supabase = chainedSupabase();

    await appendAiriChatTurn(
      turnParams(
        supabase,
        "Create campaign creative with Canva video and voiceover"
      )
    );

    expect(mockChatCompletionWithFallback).toHaveBeenCalledTimes(1);
    expect(mockAiriChatMessageCreate).toHaveBeenLastCalledWith(
      expect.objectContaining({
        role: "assistant",
        metadata: expect.objectContaining({
          airiCreativeAssetDrafts: expect.arrayContaining([
            expect.objectContaining({
              kind: "canva_design",
              provider: "canva",
              mode: "canva_template",
              sourceIds: ["canva-1"],
            }),
            expect.objectContaining({
              kind: "visual_asset",
              provider: "higgsfield",
              mode: "image_to_video",
              sourceIds: ["higgsfield-1"],
            }),
            expect.objectContaining({
              kind: "audio_asset",
              provider: "elevenlabs",
              mode: "text_to_speech",
              sourceIds: ["elevenlabs-1"],
            }),
          ]),
          airiCampaignArtifact: expect.objectContaining({
            id: "campaign-artifact-1",
            kind: "marketing_campaign",
          }),
        }),
      })
    );
    expect(mockCreateAiriArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "marketing_campaign",
        snapshot: expect.objectContaining({
          campaignPackage: expect.objectContaining({
            title: "Demo lead creative push",
          }),
          creativeAssetDrafts: expect.arrayContaining([
            expect.objectContaining({ kind: "canva_design" }),
            expect.objectContaining({ kind: "visual_asset" }),
            expect.objectContaining({ kind: "audio_asset" }),
          ]),
        }),
      })
    );
  });

  it("materializes a WhatsApp template draft for ready campaign template steps", async () => {
    mockAiriChatIntent("marketing_campaign");
    const { params } = prepareAnswerTurn(
      "Create a launch campaign for dormant leads",
      "I prepared a campaign package."
    );
    mockSearchAskDataContextLocal.mockResolvedValue({
      conversations: [
        {
          id: "conversation-1",
          summary: "Dormant leads asked for a demo but never booked.",
          category: "Sales",
          priority: "high",
        },
      ],
      kbArticles: [],
      metadata: {
        retrievalPath: "blended",
        vectorIndex: "vector_search_conversations_v2",
        fallbackConversationCount: 0,
      },
    });
    mockChatCompletionWithFallback
      .mockResolvedValueOnce({
        content: JSON.stringify({
          title: "Dormant demo lead launch",
          goal: "Book demos from dormant high-intent leads.",
          audience: "Dormant WhatsApp leads who asked for demos",
          angle: "Helpful reminder with a low-friction reply",
          evidence: ["Recent conversations mention demo intent."],
          tools: defaultMarketingToolAccess,
          steps: [
            {
              id: "template",
              kind: "whatsapp_template",
              title: "Draft WhatsApp template",
              description: "Create a compliant demo reactivation message.",
              status: "ready",
              tool: "whatsapp",
            },
          ],
          checks: [{ label: "Human approval", status: "pending" }],
          nextAction: "Review the WhatsApp template.",
        }),
        provider: "vertex",
        model: "gemini-light",
        latencyMs: 90,
      })
      .mockResolvedValueOnce({
        content: JSON.stringify({
          name: "dormant_demo_reactivation",
          language: "en",
          category: "MARKETING",
          components: [
            {
              type: "BODY",
              text: "Hi {{1}}, still interested in seeing how this works? Reply here and we will help you book a demo.",
            },
            {
              type: "BUTTONS",
              buttons: [{ type: "QUICK_REPLY", text: "Book demo" }],
            },
          ],
        }),
        provider: "vertex",
        model: "gemini-light",
        latencyMs: 80,
      });

    await appendAiriChatTurn(params);

    expect(mockChatCompletionWithFallback).toHaveBeenCalledTimes(2);
    expect(
      mockChatCompletionWithFallback.mock.calls.map(
        ([request]) => request.model
      )
    ).toEqual(["heavy-text-model", "heavy-text-model"]);
    const templatePrompt = generationPrompt(1);
    expect(templatePrompt).toContain("CAMPAIGN PACKAGE:");
    expect(templatePrompt).toContain("Dormant demo lead launch");
    expect(templatePrompt).toContain("Dormant WhatsApp leads");
    expect(mockAiriChatMessageCreate).toHaveBeenLastCalledWith(
      expect.objectContaining({
        role: "assistant",
        metadata: expect.objectContaining({
          airiCampaignPackage: expect.objectContaining({
            title: "Dormant demo lead launch",
          }),
          whatsappTemplateDraft: expect.objectContaining({
            name: "dormant_demo_reactivation",
          }),
          airiBuilderPatch: expect.objectContaining({
            kind: "whatsapp_template",
            baseRevision: 0,
            nextRevision: 1,
            snapshot: {
              templateDraft: expect.objectContaining({
                name: "dormant_demo_reactivation",
              }),
            },
          }),
          airiCampaignArtifact: expect.objectContaining({
            id: "campaign-artifact-1",
            kind: "marketing_campaign",
          }),
        }),
      })
    );
  });

  it("persists a scenario generator draft for ready campaign scenario steps", async () => {
    mockAiriChatIntent("marketing_campaign");
    const { params } = prepareAnswerTurn(
      "Create a campaign scenario for implementation leads",
      "I prepared a campaign package."
    );
    mockSearchAskDataContextLocal.mockResolvedValue({
      conversations: [
        {
          id: "conversation-1",
          summary: "High-intent leads asked for implementation help.",
          category: "Sales",
          priority: "high",
        },
      ],
      kbArticles: [],
      metadata: {
        retrievalPath: "blended",
        vectorIndex: "vector_search_conversations_v2",
        fallbackConversationCount: 0,
      },
    });
    mockChatCompletionWithFallback.mockResolvedValueOnce({
      content: JSON.stringify({
        title: "Implementation lead follow-up",
        goal: "Convert implementation leads into booked onboarding calls.",
        audience: "Warm WhatsApp leads asking for implementation help",
        angle: "Helpful setup guidance with an easy reply",
        evidence: ["Recent conversations mention implementation help."],
        tools: defaultMarketingToolAccess,
        steps: [
          {
            id: "scenario",
            kind: "scenario",
            title: "Wire follow-up automation",
            description: "Create reply and no-reply paths for the campaign.",
            status: "ready",
            tool: "scenarios",
          },
          {
            id: "bulk",
            kind: "bulk_campaign",
            title: "Prepare bulk campaign",
            description: "Review recipients before dispatch.",
            status: "approval_required",
            tool: "bulkCampaigns",
          },
        ],
        checks: [{ label: "Human approval", status: "pending" }],
        nextAction: "Open Airi Create and review the scenario draft.",
      }),
      provider: "vertex",
      model: "gemini-light",
      latencyMs: 90,
    });

    await appendAiriChatTurn(params);

    expect(mockChatCompletionWithFallback).toHaveBeenCalledTimes(1);
    expect(mockAiriChatMessageCreate).toHaveBeenLastCalledWith(
      expect.objectContaining({
        role: "assistant",
        metadata: expect.objectContaining({
          airiScenarioGeneratorDraft: expect.objectContaining({
            workspaceId: "workspace-1",
            title: "Implementation lead follow-up",
            workflowKind: "follow_up_workflow",
            sendMode: "trigger",
            channels: ["whatsapp"],
            recipientSourceSummary:
              "Warm WhatsApp leads asking for implementation help",
            prompt: expect.stringContaining("@WhatsApp"),
          }),
          airiBulkCampaignDraft: expect.objectContaining({
            workspaceId: "workspace-1",
            title: "Implementation lead follow-up",
            channel: "whatsapp",
            campaignName: "Implementation lead follow-up",
            recipientSourceSummary:
              "Warm WhatsApp leads asking for implementation help",
            templateReadiness: "select_approved_template",
            sourceIds: ["wa-1"],
          }),
          airiCampaignArtifact: expect.objectContaining({
            id: "campaign-artifact-1",
            kind: "marketing_campaign",
          }),
        }),
      })
    );
    expect(
      mockAiriChatMessageCreate.mock.calls.at(-1)?.[0]?.metadata
        ?.airiScenarioGeneratorDraft
    ).not.toHaveProperty("triggerStrategy");
    expect(mockCreateAiriArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "marketing_campaign",
        snapshot: expect.objectContaining({
          campaignPackage: expect.objectContaining({
            title: "Implementation lead follow-up",
          }),
          scenarioDraft: expect.objectContaining({
            title: "Implementation lead follow-up",
          }),
          bulkCampaignDraft: expect.objectContaining({
            title: "Implementation lead follow-up",
          }),
        }),
      })
    );
  });

  it("turns booking reminder and no-show recovery requests into a scenario draft with customer-message evidence", async () => {
    mockAiriChatIntent("marketing_campaign");
    const { params } = prepareAnswerTurn(
      "Create an executable booking reminder and no-show recovery workflow using calendar context, recent customer messages, and connected messaging channels.",
      "I prepared a campaign package."
    );
    mockSearchAskDataContextLocal.mockResolvedValue({
      conversations: [
        {
          id: "conversation-1",
          summary:
            "Customer scheduled a demo and needs reminder/no-show follow-up.",
          category: "Sales",
          priority: "high",
          createdAt: "2026-07-05T19:39:13.000Z",
        },
      ],
      kbArticles: [],
      metadata: {
        retrievalPath: "blended",
        vectorIndex: "vector_search_conversations_v2",
        fallbackConversationCount: 0,
      },
    });
    mockCustomerMessageExcerpts([
      {
        direction: "inbound",
        text: "Can we meet at 19:00 tomorrow?",
        date: new Date("2026-07-05T19:35:00.000Z"),
      },
      {
        direction: "outbound",
        text: "Booked for July 6 at 19:00. Join here: https://meet.example/private",
        date: new Date("2026-07-05T19:39:00.000Z"),
      },
    ]);
    mockChatCompletionWithFallback.mockResolvedValueOnce({
      content: JSON.stringify({
        title: "Booking reminder and no-show recovery",
        goal: "Reduce missed appointments and recover customers who do not attend.",
        audience: "Customers with scheduled demos or appointments",
        angle: "Helpful reminders with a simple reschedule path",
        evidence: [
          "Customer chose a 19:00 appointment.",
          "Manager sent a booking confirmation.",
        ],
        tools: defaultMarketingToolAccess,
        steps: [
          {
            id: "scenario",
            kind: "scenario",
            title: "Create booking reminder and no-show automation",
            description:
              "Send a reminder before the appointment, branch on replies, and send a recovery message if there is no attendance signal.",
            status: "ready",
            tool: "scenarios",
          },
          {
            id: "measurement",
            kind: "measurement",
            title: "Track booking recovery",
            description:
              "Measure reminders sent, replies, reschedules, attended appointments, and no-show recovery replies.",
            status: "ready",
            tool: "bulkCampaigns",
          },
        ],
        checks: [{ label: "Human approval", status: "pending" }],
        nextAction: "Open Airi Create and review the scenario draft.",
      }),
      provider: "vertex",
      model: "gemini-light",
      latencyMs: 90,
    });

    await appendAiriChatTurn(params);

    expect(mockMessageFind).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      conversation: "conversation-1",
    });
    const campaignPrompt = generationPrompt();
    expect(campaignPrompt).toContain(
      "Recent customer-message excerpts for planning"
    );
    expect(campaignPrompt).toContain(
      "customer: Can we meet at 19:00 tomorrow?"
    );
    expect(campaignPrompt).toContain("manager: Booked for July 6 at 19:00");
    expect(campaignPrompt).toContain("[link]");
    expect(campaignPrompt).not.toContain("https://meet.example/private");
    expect(mockAiriChatMessageCreate).toHaveBeenLastCalledWith(
      expect.objectContaining({
        role: "assistant",
        metadata: expect.objectContaining({
          airiCampaignPackage: expect.objectContaining({
            title: "Booking reminder and no-show recovery",
          }),
          airiScenarioGeneratorDraft: expect.objectContaining({
            title: "Booking reminder and no-show recovery",
            prompt: expect.stringContaining("Package steps to preserve"),
          }),
          airiCampaignArtifact: expect.objectContaining({
            id: "campaign-artifact-1",
            kind: "marketing_campaign",
          }),
        }),
      })
    );
  });

  it("turns single-manager capacity pain into a triage scenario draft", async () => {
    mockAiriChatIntent("marketing_campaign");
    const { params } = prepareAnswerTurn(
      "Create an executable WhatsApp triage and follow-up workflow for a small team that cannot answer every customer message immediately.",
      "I prepared a campaign package."
    );
    mockSearchAskDataContextLocal.mockResolvedValue({
      conversations: [
        {
          id: "conversation-1",
          summary:
            "Customer says one manager cannot keep up with WhatsApp while selling offline.",
          category: "Support",
          priority: "high",
          createdAt: "2026-07-05T19:35:56.000Z",
        },
      ],
      kbArticles: [],
      metadata: {
        retrievalPath: "blended",
        vectorIndex: "vector_search_conversations_v2",
        fallbackConversationCount: 0,
      },
    });
    mockCustomerMessageExcerpts([
      {
        direction: "inbound",
        text: "We have one manager and cannot answer WhatsApp while also selling offline.",
        date: new Date("2026-07-05T19:35:56.000Z"),
      },
      {
        direction: "outbound",
        text: "We can automate first replies, booking intent, and handoff.",
        date: new Date("2026-07-05T19:39:13.000Z"),
      },
    ]);
    mockChatCompletionWithFallback.mockResolvedValueOnce({
      content: JSON.stringify({
        title: "Small-team WhatsApp triage",
        goal: "Protect response quality when one manager cannot answer immediately.",
        audience:
          "Inbound WhatsApp customers with booking, pricing, or help intent",
        angle:
          "Fast first response, clear triage, and manager handoff only when needed",
        evidence: [
          "Customer said one manager cannot keep up with WhatsApp.",
          "Recent messages mention offline selling and booking/help intent.",
        ],
        tools: defaultMarketingToolAccess,
        steps: [
          {
            id: "scenario",
            kind: "scenario",
            title: "Create triage and handoff automation",
            description:
              "Classify urgent intent, answer common first questions, route booking/help-needed branches, and hand off qualified conversations to a manager.",
            status: "ready",
            tool: "scenarios",
          },
          {
            id: "measurement",
            kind: "measurement",
            title: "Track manager load reduction",
            description:
              "Measure first replies, automation completions, handoffs, no-reply recoveries, and manager response time.",
            status: "ready",
            tool: "bulkCampaigns",
          },
        ],
        checks: [{ label: "Human approval", status: "pending" }],
        nextAction: "Open Airi Create and review the triage scenario draft.",
      }),
      provider: "vertex",
      model: "gemini-light",
      latencyMs: 90,
    });

    await appendAiriChatTurn(params);

    const campaignPrompt = generationPrompt();
    expect(campaignPrompt).toContain("one manager and cannot answer WhatsApp");
    expect(campaignPrompt).toContain("manager: We can automate first replies");
    expect(mockAiriChatMessageCreate).toHaveBeenLastCalledWith(
      expect.objectContaining({
        role: "assistant",
        metadata: expect.objectContaining({
          airiCampaignPackage: expect.objectContaining({
            title: "Small-team WhatsApp triage",
          }),
          airiScenarioGeneratorDraft: expect.objectContaining({
            title: "Small-team WhatsApp triage",
            prompt: expect.stringContaining("handoff automation"),
          }),
          airiCampaignArtifact: expect.objectContaining({
            id: "campaign-artifact-1",
            kind: "marketing_campaign",
          }),
        }),
      })
    );
  });

  it("keeps generic content questions on the normal answer path", async () => {
    const { params } = prepareAnswerTurn(
      "What content is in the refund policy?",
      "Refund requests are reviewed within 3 business days."
    );
    mockSearchAskDataContextLocal.mockResolvedValue({
      conversations: [],
      kbArticles: [
        {
          id: "kb-1",
          title: "Refund policy",
          content: "Refund requests are reviewed within 3 business days.",
          relevance_score: 0.9,
        },
      ],
      metadata: {
        retrievalPath: "vector",
        vectorIndex: "knowledge_base",
        fallbackConversationCount: 0,
      },
    });
    mockChatCompletionWithFallback.mockResolvedValue({
      content: "Refund requests are reviewed within 3 business days.",
      provider: "vertex",
      model: "gemini-light",
      latencyMs: 70,
    });

    await appendAiriChatTurn(params);

    expect(mockResolveAiriMarketingToolAccess).not.toHaveBeenCalled();
    const prompt = generationPrompt();
    expect(prompt).not.toContain("AIRI.CHAT PRODUCT CAPABILITIES");
    expect(mockAiriChatMessageCreate).toHaveBeenLastCalledWith(
      expect.objectContaining({
        role: "assistant",
        metadata: expect.not.objectContaining({
          airiCampaignPackage: expect.anything(),
          airiProductContext: expect.anything(),
        }),
      })
    );
  });

  it("keeps broad marketing opportunity analysis on the normal answer path", async () => {
    const { params } = prepareAnswerTurn(
      "Use my connected customer channels to identify the best support and marketing opportunities.",
      "Start with appointment reminders and clearer pricing."
    );
    mockSearchAskDataContextLocal.mockResolvedValue({
      conversations: [
        {
          id: "conversation-1",
          summary: "Customers ask about appointment reminders and pricing.",
          category: "Sales",
          priority: "high",
        },
      ],
      kbArticles: [
        {
          id: "kb-1",
          title: "Booking policy",
          content: "Appointments can be rescheduled up to 24 hours before.",
          relevance_score: 0.89,
        },
      ],
      metadata: {
        retrievalPath: "blended",
        vectorIndex: "vector_search_conversations_v2",
        fallbackConversationCount: 0,
      },
    });
    mockChatCompletionWithFallback.mockResolvedValue({
      content: "Start with appointment reminders and clearer pricing.",
      provider: "vertex",
      model: "gemini-heavy",
      latencyMs: 70,
    });

    await appendAiriChatTurn(params);

    expect(mockResolveAiriMarketingToolAccess).not.toHaveBeenCalled();
    expect(mockCreateAiriArtifact).not.toHaveBeenCalled();
    expect(mockChatCompletionWithFallback).toHaveBeenCalledTimes(1);
    expect(mockChatCompletionWithFallback.mock.calls[0]?.[0]?.model).toBe(
      "heavy-text-model"
    );
    const prompt = generationPrompt();
    expect(prompt).toContain("RECENT CUSTOMER CONTEXT:");
    expect(prompt).not.toContain("Return ONLY valid JSON");
    expect(mockAiriChatMessageCreate).toHaveBeenLastCalledWith(
      expect.objectContaining({
        role: "assistant",
        metadata: expect.not.objectContaining({
          airiCampaignPackage: expect.anything(),
        }),
      })
    );
    // The provider that actually served the turn is recorded, not the tier.
    expect(mockAiriChatMessageCreate).toHaveBeenLastCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          provider: "vertex",
          model: "gemini-heavy",
          resourceReceipt: expect.objectContaining({
            provider: "vertex",
            model: "gemini-heavy",
          }),
        }),
      })
    );
  });

  it("answers product capability questions with product context and workspace readiness", async () => {
    mockAiriChatIntent("product_capability");
    const { supabase, params } = prepareAnswerTurn(
      "What can Airi do for marketing in this workspace?",
      "Airi can help with WhatsApp templates, Flows, campaigns, scenarios, and creative planning."
    );
    mockNoWorkspaceRetrieval();
    mockChatCompletionWithFallback.mockResolvedValue({
      content:
        "Airi can help with WhatsApp templates, Flows, campaigns, scenarios, and creative planning.",
      provider: "vertex",
      model: "gemini-heavy",
      latencyMs: 80,
    });

    await appendAiriChatTurn(params);

    expect(mockResolveAiriMarketingToolAccess).toHaveBeenCalledWith({
      supabase,
      workspaceId: "workspace-1",
    });
    expect(mockChatCompletionWithFallback.mock.calls[0]?.[0]?.model).toBe(
      "heavy-text-model"
    );
    const prompt = generationPrompt();
    expect(prompt).toContain("AIRI.CHAT PRODUCT CAPABILITIES");
    expect(prompt).toContain("CURRENT WORKSPACE READINESS");
    expect(prompt).toContain("PUBLISHED AIRI.CHAT PRODUCT KB");
    expect(prompt).toContain("WhatsApp templates");
    expect(prompt).toContain("WhatsApp Flows");
    expect(prompt).toContain("Connect Canva to use approved brand templates.");
    expect(mockAiriChatMessageCreate).toHaveBeenLastCalledWith(
      expect.objectContaining({
        role: "assistant",
        metadata: expect.objectContaining({
          airiProductContext: {
            version: AIRI_PRODUCT_CONTEXT_VERSION,
            sourceIds: expect.arrayContaining([
              `airi_product:${AIRI_PRODUCT_CONTEXT_VERSION}:capabilities`,
            ]),
          },
          resourceReceipt: expect.objectContaining({
            resources: expect.arrayContaining([
              expect.objectContaining({
                id: "airi-product-context",
                label: "airi.chat capabilities",
                kind: "model",
              }),
            ]),
          }),
        }),
      })
    );
  });

  it("does not create WhatsApp drafts when the user asks what Airi can do with templates and flows", async () => {
    mockAiriChatIntent("product_capability");
    const { params } = prepareAnswerTurn(
      "What can Airi do with WhatsApp templates and flows?",
      "Airi can explain, draft, and help review WhatsApp templates and Flows."
    );
    mockNoWorkspaceRetrieval();
    mockChatCompletionWithFallback.mockResolvedValue({
      content:
        "Airi can explain, draft, and help review WhatsApp templates and Flows.",
      provider: "vertex",
      model: "gemini-heavy",
      latencyMs: 75,
    });

    await appendAiriChatTurn(params);

    const prompt = generationPrompt();
    expect(prompt).toContain("AIRI.CHAT PRODUCT CAPABILITIES");
    expect(mockAiriChatMessageCreate).toHaveBeenLastCalledWith(
      expect.objectContaining({
        role: "assistant",
        metadata: expect.objectContaining({
          airiProductContext: expect.objectContaining({
            version: AIRI_PRODUCT_CONTEXT_VERSION,
          }),
        }),
      })
    );
    expect(mockAiriChatMessageCreate).toHaveBeenLastCalledWith(
      expect.objectContaining({
        metadata: expect.not.objectContaining({
          whatsappTemplateDraft: expect.anything(),
          whatsappFlowDraft: expect.anything(),
          airiBuilderPatch: expect.anything(),
        }),
      })
    );
    expect(mockCreateAiriArtifact).not.toHaveBeenCalled();
    expect(mockUpdateAiriArtifact).not.toHaveBeenCalled();
  });

  it("grounds product how-to answers on published airi.chat KB", async () => {
    mockAiriChatIntent("product_capability");
    mockRetrieveAiriProductKbArticles.mockResolvedValue([
      {
        id: "kb-whatsapp-connect",
        title: "Connect WhatsApp",
        content: "Open Messengers and start Embedded Signup.",
        url: "https://www.airi.chat/airichat/kb/kb-whatsapp-connect",
        relevanceScore: 0.91,
        workspaceId: "airi-public-ws",
      },
    ]);
    const { params } = prepareAnswerTurn(
      "хочу регистрацию через вотсап сделать",
      "Open Messengers and start Embedded Signup."
    );
    mockNoWorkspaceRetrieval();
    mockChatCompletionWithFallback.mockResolvedValue({
      content: "Open Messengers and start Embedded Signup.",
      provider: "vertex",
      model: "gemini-heavy",
      latencyMs: 70,
    });

    await appendAiriChatTurn(params);

    expect(mockRetrieveAiriProductKbArticles).toHaveBeenCalledWith({
      query: "хочу регистрацию через вотсап сделать",
      locale: "en",
    });
    const prompt = generationPrompt();
    expect(prompt).toContain("PUBLISHED AIRI.CHAT PRODUCT KB");
    expect(prompt).toContain("Connect WhatsApp");
    expect(prompt).toContain("Embedded Signup");
    expect(prompt).toContain("Never refuse a platform how-to");
    expect(mockAiriChatMessageCreate).toHaveBeenLastCalledWith(
      expect.objectContaining({
        role: "assistant",
        metadata: expect.objectContaining({
          airiProductKb: {
            companySlug: "airichat",
            articleIds: ["kb-whatsapp-connect"],
          },
          resourceReceipt: expect.objectContaining({
            resources: expect.arrayContaining([
              expect.objectContaining({
                id: "airi-product-kb:kb-whatsapp-connect",
                label: "Connect WhatsApp",
                kind: "knowledge_base",
              }),
            ]),
          }),
        }),
      })
    );
  });

  it("reroutes an empty-tenant classifier miss to published airi.chat KB", async () => {
    mockAiriChatIntent("general_answer");
    mockNoWorkspaceRetrieval();
    mockEmptyTurnHistory();
    mockPersistedTurn(
      "what is airi.chat",
      "airi.chat is an AI engagement assistant."
    );
    mockChatCompletionWithFallback.mockResolvedValue({
      content: "airi.chat is an AI engagement assistant.",
      provider: "vertex",
      model: "gemini-heavy",
      latencyMs: 60,
    });
    const supabase = chainedSupabase();

    await appendAiriChatTurn(turnParams(supabase, "what is airi.chat"));

    expect(mockRetrieveAiriProductKbArticles).toHaveBeenCalledWith({
      query: "what is airi.chat",
      locale: "en",
    });
    const prompt = generationPrompt();
    expect(prompt).toContain("AIRI.CHAT PRODUCT CAPABILITIES");
    expect(prompt).toContain("PUBLISHED AIRI.CHAT PRODUCT KB");
    expect(mockAiriChatMessageCreate).toHaveBeenLastCalledWith(
      expect.objectContaining({
        role: "assistant",
        metadata: expect.objectContaining({
          airiProductKbSafetyNet: {
            fromIntent: "general_answer",
            reason: "empty_tenant_platform_safety_net",
          },
        }),
      })
    );
  });

  it("keeps empty-tenant company questions off airi.chat KB", async () => {
    mockAiriChatIntent("general_answer");
    mockNoWorkspaceRetrieval();
    mockEmptyTurnHistory();
    mockPersistedTurn(
      "Какая у нас политика возврата?",
      "This workspace has no matching knowledge base articles."
    );
    mockChatCompletionWithFallback.mockResolvedValue({
      content: "This workspace has no matching knowledge base articles.",
      provider: "vertex",
      model: "gemini-heavy",
      latencyMs: 55,
    });
    const supabase = chainedSupabase();

    await appendAiriChatTurn(
      turnParams(supabase, "Какая у нас политика возврата?")
    );

    expect(mockRetrieveAiriProductKbArticles).not.toHaveBeenCalled();
    expect(mockResolveAiriMarketingToolAccess).not.toHaveBeenCalled();
    const prompt = generationPrompt();
    expect(prompt).not.toContain("AIRI.CHAT PRODUCT CAPABILITIES");
    expect(prompt).toContain("Do not use airi.chat product documentation");
    expect(prompt).toContain("no matching knowledge base articles");
  });

  it("queues Nano Banana image attachments for image generation intent", async () => {
    mockAiriChatIntent("image_generation");
    const { params } = prepareAnswerTurn(
      "Generate a realistic image for a booking reminder",
      "I started generating Booking reminder visual."
    );
    mockNoWorkspaceRetrieval();
    mockChatCompletionWithFallback.mockResolvedValue({
      content: JSON.stringify({
        title: "Booking reminder visual",
        summary: "Header image for appointment reminders",
        prompt:
          "Realistic vertical image of a clean appointment reminder on a phone beside a calendar.",
        aspectRatio: "9:16",
      }),
      provider: "vertex",
      model: "gemini-light",
      latencyMs: 42,
      usage: null,
    });
    mockCreateQueuedAiriImageGeneration.mockResolvedValue({
      assetId: "asset-1",
      attachment: {
        id: "asset-1",
        workspaceId: "workspace-1",
        kind: "image",
        provider: "google",
        providerLabel: "Nano Banana",
        status: "queued",
        title: "Booking reminder visual",
        prompt:
          "Realistic vertical image of a clean appointment reminder on a phone beside a calendar.",
        target: "chat_attachment",
      },
    });

    await appendAiriChatTurn(params);

    expect(mockChatCompletionWithFallback).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "light-text-model",
        responseFormat: { type: "json_object" },
      })
    );
    expect(mockCreateQueuedAiriImageGeneration).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-1",
        userId: "user-1",
        threadId: "thread-1",
        userMessageId: "user-message-1",
        title: "Booking reminder visual",
        aspectRatio: "9:16",
        target: { kind: "chat_attachment" },
      })
    );
    expect(mockStartQueuedAiriImageGeneration).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-1",
        assetId: "asset-1",
        aspectRatio: "9:16",
      })
    );
    expect(mockAiriChatMessageCreate).toHaveBeenLastCalledWith(
      expect.objectContaining({
        role: "assistant",
        metadata: expect.objectContaining({
          airiImageGenerationBrief: expect.objectContaining({
            title: "Booking reminder visual",
          }),
          airiGeneratedAssetAttachments: [
            expect.objectContaining({
              id: "asset-1",
              providerLabel: "Nano Banana",
              target: "chat_attachment",
            }),
          ],
          resourceReceipt: expect.objectContaining({
            resources: expect.arrayContaining([
              expect.objectContaining({
                id: "creative-asset:asset-1",
                kind: "creative_asset",
                status: "running",
              }),
            ]),
          }),
        }),
      })
    );
    expect(mockCreateAiriArtifact).not.toHaveBeenCalled();
  });

  it("persists a structured WhatsApp template draft for template intent", async () => {
    mockAiriChatIntent("whatsapp_template");
    const { supabase } = prepareAnswerTurn(
      "@Main WhatsApp Draft a WhatsApp template",
      "Done. I drafted the WhatsApp template."
    );
    mockBuildSelectedAiriChatGroundingContext.mockResolvedValue({
      selectedSources: [
        {
          kind: "connector",
          connector: "whatsapp",
          sourceId: "wa-1",
          label: "Main WhatsApp",
          capabilities: ["docs", "templates", "flows"],
        },
      ],
      selectedSourceLabels: ["Main WhatsApp"],
      conversations: [],
      kbArticles: [
        {
          id: "whatsapp_connector:workspace",
          title: "WhatsApp connector",
          content: "WhatsApp templates and campaign context.",
          relevance_score: 1,
        },
      ],
      promptSections: [],
      sourceIds: ["whatsapp_connector:workspace"],
      conversationSourceIds: [],
      kbSourceIds: ["whatsapp_connector:workspace"],
      retrievalPath: "kb",
    });
    mockSearchAskDataContextLocal.mockResolvedValue({
      conversations: [],
      kbArticles: [],
      metadata: {
        retrievalPath: "knowledge_only",
        vectorIndex: null,
        fallbackConversationCount: 0,
      },
    });
    mockChatCompletionWithFallback.mockResolvedValue({
      content: JSON.stringify({
        name: "customer_reengagement",
        language: "en",
        category: "MARKETING",
        components: [
          {
            type: "BODY",
            text: "Hi {{1}}, would you like help choosing a plan?",
          },
          {
            type: "BUTTONS",
            buttons: [
              { type: "QUICK_REPLY", text: "Tell me more" },
              { type: "QUICK_REPLY", text: "Later" },
            ],
          },
        ],
      }),
      provider: "vertex",
      model: "gemini-light",
      latencyMs: 80,
    });

    await appendAiriChatTurn({
      supabase: supabase as never,
      workspaceId: "workspace-1",
      userId: "user-1",
      threadId: "thread-1",
      content: "@Main WhatsApp Draft a WhatsApp template",
      selectedSources: [
        {
          kind: "connector",
          connector: "whatsapp",
          sourceId: "wa-1",
          label: "Main WhatsApp",
          capabilities: ["docs", "templates", "flows"],
        },
      ],
    });

    expect(mockChatCompletionWithFallback).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "heavy-text-model",
        messages: [
          expect.objectContaining({
            content: expect.stringContaining("Return ONLY valid JSON"),
          }),
        ],
      })
    );
    expect(draftCallTimeoutMs("whatsapp_template_draft")).toBe(60_000);
    expect(mockAiriChatMessageCreate).toHaveBeenLastCalledWith(
      expect.objectContaining({
        role: "assistant",
        metadata: expect.objectContaining({
          airiArtifact: expect.objectContaining({
            id: "artifact-1",
            kind: "whatsapp_template",
            revision: 0,
          }),
          whatsappTemplateDraft: expect.objectContaining({
            name: "customer_reengagement",
            category: "MARKETING",
            components: expect.arrayContaining([
              expect.objectContaining({ type: "BODY" }),
              expect.objectContaining({ type: "BUTTONS" }),
            ]),
          }),
          pendingActions: [],
        }),
      })
    );
    expect(mockCreateAiriArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-1",
        threadId: "thread-1",
        userId: "user-1",
        kind: "whatsapp_template",
        sourceMessageId: "user-message-1",
      })
    );
  });

  it("queues generated images for unresolved WhatsApp template image headers", async () => {
    mockAiriChatIntent("whatsapp_template");
    const { params } = prepareAnswerTurn(
      "Draft a WhatsApp template with a generated header image",
      "Done. I drafted the WhatsApp template."
    );
    mockSearchAskDataContextLocal.mockResolvedValue({
      conversations: [],
      kbArticles: [
        {
          id: "kb-1",
          title: "Booking reminders",
          content: "Customers need friendly appointment reminders.",
        },
      ],
      metadata: {
        retrievalPath: "knowledge_only",
        vectorIndex: null,
        fallbackConversationCount: 0,
      },
    });
    mockChatCompletionWithFallback.mockResolvedValue({
      content: JSON.stringify({
        name: "booking_reminder",
        language: "en",
        category: "MARKETING",
        components: [
          { type: "HEADER", format: "IMAGE" },
          {
            type: "BODY",
            text: "Hi {{1}}, your appointment is coming up tomorrow.",
          },
        ],
      }),
      provider: "vertex",
      model: "gemini-light",
      latencyMs: 80,
    });
    mockCreateQueuedAiriImageGeneration.mockResolvedValue({
      assetId: "asset-1",
      attachment: {
        id: "asset-1",
        workspaceId: "workspace-1",
        kind: "image",
        provider: "google",
        providerLabel: "Nano Banana",
        status: "queued",
        title: "booking_reminder header image",
        prompt: "Create a realistic WhatsApp template header image.",
        target: "whatsapp_template_header",
      },
    });

    await appendAiriChatTurn(params);

    expect(mockCreateQueuedAiriImageGeneration).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "booking_reminder header image",
        aspectRatio: "16:9",
        target: { kind: "whatsapp_template_header" },
      })
    );
    expect(mockUpdateQueuedAiriImageGenerationTarget).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      assetId: "asset-1",
      target: {
        kind: "whatsapp_template_header",
        templateArtifactId: "artifact-1",
        templateRevision: 0,
      },
    });
    expect(mockStartQueuedAiriImageGeneration).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-1",
        assetId: "asset-1",
        aspectRatio: "16:9",
      })
    );
    expect(mockAiriChatMessageCreate).toHaveBeenLastCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          whatsappTemplateDraft: expect.objectContaining({
            components: expect.arrayContaining([
              expect.objectContaining({
                type: "HEADER",
                format: "IMAGE",
                example: {
                  header_handle: ["airi://creative-assets/asset-1"],
                },
              }),
            ]),
          }),
          airiGeneratedAssetAttachments: [
            expect.objectContaining({
              id: "asset-1",
              target: "whatsapp_template_header",
              templateArtifactId: "artifact-1",
            }),
          ],
        }),
      })
    );
  });

  it("returns WhatsApp template builder metadata for active template edits", async () => {
    mockAiriChatIntent("whatsapp_template");
    const { supabase } = prepareAnswerTurn(
      "Make the active builder draft warmer",
      "Done. I drafted the WhatsApp template."
    );
    mockNoWorkspaceRetrieval();
    mockChatCompletionWithFallback.mockResolvedValue({
      content: JSON.stringify({
        name: "existing_template_v2",
        language: "en",
        category: "MARKETING",
        components: [
          {
            type: "BODY",
            text: "Hi {{1}}, thanks for reaching out. Want help choosing the right plan?",
          },
        ],
      }),
      provider: "vertex",
      model: "gemini-light",
      latencyMs: 80,
    });

    await appendAiriChatTurn({
      supabase: supabase as never,
      workspaceId: "workspace-1",
      userId: "user-1",
      threadId: "thread-1",
      content: "Make the active builder draft warmer",
      activeBuilder: {
        kind: "whatsapp_template",
        artifactId: "artifact-1",
        revision: 5,
        dirty: true,
        templateDraft: {
          kind: "whatsapp_template",
          name: "existing_template",
          language: "en",
          category: "MARKETING",
          components: [
            {
              type: "BODY",
              text: "Hi {{1}}, want help choosing a plan?",
            },
          ],
        },
      },
    });

    const prompt = generationPrompt();
    expect(prompt).toContain("ACTIVE TEMPLATE DRAFT:");
    expect(prompt).toContain("existing_template");
    expect(mockAiriChatMessageCreate).toHaveBeenLastCalledWith(
      expect.objectContaining({
        role: "assistant",
        metadata: expect.objectContaining({
          whatsappTemplateDraft: expect.objectContaining({
            name: "existing_template_v2",
          }),
          airiBuilderPatch: expect.objectContaining({
            kind: "whatsapp_template",
            baseRevision: 5,
            nextRevision: 6,
            snapshot: {
              templateDraft: expect.objectContaining({
                name: "existing_template_v2",
              }),
            },
          }),
          airiArtifact: expect.objectContaining({
            id: "artifact-1",
            kind: "whatsapp_template",
            revision: 6,
          }),
        }),
      })
    );
    expect(mockUpdateAiriArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-1",
        artifactId: "artifact-1",
        userId: "user-1",
        baseRevision: 5,
      })
    );
  });

  it("returns sanitized WhatsApp Flow builder metadata for active Flow edits", async () => {
    mockAiriChatIntent("whatsapp_flow");
    const { supabase } = prepareAnswerTurn(
      "Add consent to the active builder",
      "Done. I updated the WhatsApp Flow."
    );
    mockNoWorkspaceRetrieval();
    mockChatCompletionWithFallback.mockResolvedValue({
      content: JSON.stringify({
        templateId: "lead_generation",
        ctaText: "Start",
        bodyText: "<b>Please complete this form.</b>",
        flowUiLocale: "en",
        flowSubmitLabel: "Submit this detailed lead generation form",
        screens: [
          {
            id: "lead-form",
            title: "Lead Form",
            fields: [
              {
                id: "name",
                label: "Full Name",
                fieldType: "TextInput",
                required: true,
              },
              {
                id: "consent",
                label: "Consent",
                fieldType: "CheckboxGroup",
                options: [{ id: "yes", title: "I agree" }],
              },
            ],
          },
        ],
      }),
      provider: "vertex",
      model: "gemini-light",
      latencyMs: 90,
    });
    mockUpdateAiriArtifact.mockResolvedValueOnce({
      id: "artifact-flow-1",
      kind: "whatsapp_flow",
      revision: 9,
      status: "draft",
      validation: { status: "valid", issues: [] },
    });

    await appendAiriChatTurn({
      supabase: supabase as never,
      workspaceId: "workspace-1",
      userId: "user-1",
      threadId: "thread-1",
      content: "Add consent to the active builder",
      activeBuilder: {
        kind: "whatsapp_flow",
        artifactId: "artifact-flow-1",
        revision: 8,
        flowConfig: {
          templateId: "lead_generation",
          ctaText: "Start",
          bodyText: "Please complete this form.",
          flowUiLocale: "en",
          screens: [
            {
              id: "LEAD_FORM",
              title: "Lead Form",
              fields: [
                {
                  id: "name",
                  label: "Full Name",
                  fieldType: "TextInput",
                },
              ],
            },
          ],
        },
      },
    });

    expect(mockChatCompletionWithFallback.mock.calls[0]?.[0]?.model).toBe(
      "heavy-text-model"
    );
    expect(draftCallTimeoutMs("whatsapp_flow_draft")).toBe(90_000);
    const prompt = generationPrompt();
    expect(prompt).toContain("ACTIVE FLOW DRAFT:");
    expect(prompt).toContain("LEAD_FORM");
    expect(mockAiriChatMessageCreate).toHaveBeenLastCalledWith(
      expect.objectContaining({
        role: "assistant",
        metadata: expect.objectContaining({
          airiBuilderPatch: expect.objectContaining({
            kind: "whatsapp_flow",
            baseRevision: 8,
            nextRevision: 9,
            snapshot: {
              flowConfig: expect.objectContaining({
                flowSubmitLabel: expect.stringMatching(/^.{35}$/),
                screens: [
                  expect.objectContaining({
                    id: "lead_form",
                    fields: expect.arrayContaining([
                      expect.objectContaining({ id: "consent" }),
                    ]),
                  }),
                ],
              }),
            },
          }),
          airiArtifact: expect.objectContaining({
            id: "artifact-flow-1",
            kind: "whatsapp_flow",
            revision: 9,
          }),
        }),
      })
    );
    expect(mockUpdateAiriArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-1",
        artifactId: "artifact-flow-1",
        userId: "user-1",
        baseRevision: 8,
      })
    );
  });

  it("persists a friendly retryable assistant message when Vertex quota is exhausted", async () => {
    mockExistingThread();
    mockEmptyTurnHistory();
    mockAiriChatMessageCountDocuments.mockResolvedValue(2);
    mockSearchAskDataContextLocal.mockResolvedValue({
      conversations: [],
      kbArticles: [],
    });
    mockAiriChatMessageCreate
      .mockResolvedValueOnce({
        _id: "user-message-1",
        threadId: "thread-1",
        workspaceId: "workspace-1",
        role: "user",
        content: "What requests do customers have?",
        createdAt: new Date("2026-06-12T00:00:00.000Z"),
      })
      .mockResolvedValueOnce({
        _id: "assistant-message-1",
        threadId: "thread-1",
        workspaceId: "workspace-1",
        role: "assistant",
        content:
          "Airi is temporarily busy. Please try sending the request again in a minute.",
        metadata: {
          retryable: true,
          errorCode: "provider_resource_exhausted",
        },
        createdAt: new Date("2026-06-12T00:00:01.000Z"),
      });
    mockChatCompletionWithFallback.mockRejectedValue(
      new Error(
        'Vertex AI provider failed: vertex: Vertex Gemini HTTP 429: { "error": { "status": "RESOURCE_EXHAUSTED" } }'
      )
    );
    const supabase = chainedSupabase();

    const result = await appendAiriChatTurn(
      turnParams(supabase, "What requests do customers have?")
    );

    expect(result.assistantMessage.content).toBe(
      "Airi is temporarily busy. Please try sending the request again in a minute."
    );
    expect(mockAiriChatMessageCreate).toHaveBeenLastCalledWith(
      expect.objectContaining({
        role: "assistant",
        metadata: expect.objectContaining({
          retryable: true,
          errorCode: "provider_resource_exhausted",
        }),
      })
    );
  });

  it.each([
    {
      label: "the requested heavy model without a provider",
      makeError: () =>
        new Error(
          'Vertex Gemini HTTP 429: { "error": { "status": "RESOURCE_EXHAUSTED" } }'
        ),
      expected: { provider: null, model: "heavy-text-model" },
    },
    {
      label: "the last attempted provider and model",
      makeError: () =>
        new AIChatProviderAggregateError([
          {
            provider: "anthropic",
            model: "claude-sonnet-5-5",
            attempt: 1,
            fallbackIndex: 0,
            retryable: true,
            finishReason: null,
            promptBlockReason: null,
            httpStatus: 529,
          },
          {
            provider: "vertex",
            model: "gemini-3.5-flash",
            attempt: 1,
            fallbackIndex: 1,
            retryable: true,
            finishReason: null,
            promptBlockReason: null,
            httpStatus: 429,
          },
        ]),
      expected: { provider: "vertex", model: "gemini-3.5-flash" },
    },
  ])(
    "records $label on a retryable generation failure",
    async ({ makeError, expected }) => {
      const { params } = prepareCancelledTurn();
      mockChatCompletionWithFallback.mockRejectedValueOnce(makeError());

      await appendAiriChatTurn(params);

      expect(mockAiriChatMessageCreate).toHaveBeenLastCalledWith(
        expect.objectContaining({
          role: "assistant",
          metadata: expect.objectContaining({
            retryable: true,
            errorCode: "provider_resource_exhausted",
            provider: expected.provider,
            model: expected.model,
            resourceReceipt: expect.objectContaining(expected),
          }),
        })
      );
      expect(
        jest.requireMock("@/lib/airi-chats/analytics")
          .recordAiriChatTurnAnalyticsEvents
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          analytics: expect.objectContaining({
            generationModel: expected.model,
          }),
        })
      );
    }
  );

  function providerFailure(
    provider: "anthropic" | "vertex",
    retryable: boolean,
    httpStatus: number,
    attempt = 1
  ) {
    return {
      provider,
      model:
        provider === "anthropic" ? "claude-sonnet-5-5" : "gemini-3.5-flash",
      attempt,
      fallbackIndex: provider === "anthropic" ? 0 : 1,
      retryable,
      finishReason: null,
      promptBlockReason: null,
      httpStatus,
    };
  }

  it.each([
    {
      label: "both providers out of capacity",
      components: [
        providerFailure("anthropic", true, 529),
        providerFailure("vertex", true, 429),
      ],
    },
    {
      label: "Claude rejecting the request while Gemini is rate limited",
      components: [
        providerFailure("anthropic", false, 400),
        providerFailure("vertex", true, 429),
      ],
    },
  ])(
    "shows the busy reply when the facade fails with $label",
    async ({ components }) => {
      const { params } = prepareCancelledTurn();
      mockChatCompletionWithFallback.mockRejectedValueOnce(
        new AIChatProviderAggregateError(components)
      );

      const result = await appendAiriChatTurn(params);

      expect(result.assistantMessage.content).toBe(
        "Airi is temporarily busy. Please try sending the request again in a minute."
      );
      expect(mockAiriChatMessageCreate).toHaveBeenLastCalledWith(
        expect.objectContaining({
          role: "assistant",
          metadata: expect.objectContaining({
            retryable: true,
            errorCode: "provider_resource_exhausted",
          }),
        })
      );
    }
  );

  it("keeps the generic failure reply when no provider ended on a transient error", async () => {
    const { params } = prepareCancelledTurn();
    mockChatCompletionWithFallback.mockRejectedValueOnce(
      new AIChatProviderAggregateError([
        // A capacity error that was retried does not count once the provider
        // finally rejected the request.
        providerFailure("anthropic", true, 529, 1),
        providerFailure("anthropic", false, 400, 2),
        providerFailure("vertex", false, 400),
      ])
    );

    const result = await appendAiriChatTurn(params);

    expect(result.assistantMessage.content).toContain(
      "I saved your request, but I could not finish the answer"
    );
    expect(mockAiriChatMessageCreate).toHaveBeenLastCalledWith(
      expect.objectContaining({
        role: "assistant",
        metadata: expect.objectContaining({
          failed: true,
          errorCode: "airi_generation_failed",
        }),
      })
    );
  });

  it("shortens an answer longer than a stored message instead of failing the insert", async () => {
    const { params } = prepareCancelledTurn();
    const longAnswer = "This sentence explains the refund flow. ".repeat(500);
    mockChatCompletionWithFallback.mockResolvedValueOnce({
      content: longAnswer,
      provider: "anthropic",
      model: "claude-sonnet",
      latencyMs: 10,
    });

    const result = await appendAiriChatTurn(params);

    const saved = mockAiriChatMessageCreate.mock.calls.at(-1)?.[0];
    expect(saved.role).toBe("assistant");
    expect(saved.content.length).toBeLessThanOrEqual(12000);
    expect(saved.content.endsWith("[...]")).toBe(true);
    expect(saved.metadata.contentShortened).toEqual({
      originalLength: longAnswer.trim().length,
    });
    expect(result.assistantMessage.content).toBe(saved.content);
  });

  it.each<MockAiriChatIntent>([
    "whatsapp_template",
    "whatsapp_flow",
    "opportunity_scan",
    "marketing_campaign",
  ])(
    "drafts %s on the heavy model and records it on a retryable failure",
    async intent => {
      const { params } = prepareCancelledTurn(intent);
      mockChatCompletionWithFallback.mockRejectedValueOnce(
        new Error(
          'Vertex Gemini HTTP 429: { "error": { "status": "RESOURCE_EXHAUSTED" } }'
        )
      );

      await appendAiriChatTurn(params);

      expect(mockChatCompletionWithFallback.mock.calls[0]?.[0]?.model).toBe(
        "heavy-text-model"
      );
      expect(mockAiriChatMessageCreate).toHaveBeenLastCalledWith(
        expect.objectContaining({
          role: "assistant",
          metadata: expect.objectContaining({
            retryable: true,
            errorCode: "provider_resource_exhausted",
            provider: null,
            model: "heavy-text-model",
          }),
        })
      );
      expect(
        jest.requireMock("@/lib/airi-chats/analytics")
          .recordAiriChatTurnAnalyticsEvents
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          analytics: expect.objectContaining({
            generationModel: "heavy-text-model",
          }),
        })
      );
    }
  );

  it("persists a failure assistant message when generation fails after the user message is saved", async () => {
    mockExistingThread();
    mockEmptyTurnHistory();
    mockAiriChatMessageCountDocuments.mockResolvedValue(2);
    mockSearchAskDataContextLocal.mockResolvedValue({
      conversations: [],
      kbArticles: [],
    });
    mockAiriChatMessageCreate
      .mockImplementationOnce(async (doc: unknown) => ({
        ...(doc as Record<string, unknown>),
        _id: "user-message-1",
        createdAt: new Date("2026-06-12T00:00:00.000Z"),
      }))
      .mockImplementationOnce(async (doc: unknown) => ({
        ...(doc as Record<string, unknown>),
        _id: "assistant-message-1",
        createdAt: new Date("2026-06-12T00:00:01.000Z"),
      }));
    mockChatCompletionWithFallback.mockRejectedValue(
      new Error("campaign artifact write failed")
    );
    const supabase = chainedSupabase();

    const result = await appendAiriChatTurn(
      turnParams(
        supabase,
        "Use calendar context and connected messaging channels to design a booking reminder and no-show recovery flow."
      )
    );

    expect(result.assistantMessage.content).toContain(
      "I saved your request, but I could not finish the answer"
    );
    expect(mockAiriChatMessageCreate).toHaveBeenLastCalledWith(
      expect.objectContaining({
        role: "assistant",
        content: expect.stringContaining("I saved your request"),
        metadata: expect.objectContaining({
          failed: true,
          errorCode: "airi_generation_failed",
        }),
      })
    );
    expect(mockLoggerError).toHaveBeenCalledWith(
      "airi_chat.reply_generation_failed",
      expect.any(Error),
      expect.objectContaining({
        workspaceId: "workspace-1",
        threadId: "thread-1",
        userMessageId: "user-message-1",
      })
    );
  });

  it("fills missing KB from local retrieval when the gateway returns chats only", async () => {
    const gcpGateway = jest.requireMock("@/lib/ai/gcp-ai-gateway") as {
      canCallGcpAIGateway: jest.Mock;
      getRemoteAskDataContext: jest.Mock;
    };
    gcpGateway.canCallGcpAIGateway.mockReturnValue(true);
    gcpGateway.getRemoteAskDataContext.mockResolvedValue({
      conversations: [
        {
          id: "conversation-1",
          summary: "Customers ask about refunds.",
          category: "Support",
          priority: "medium",
        },
      ],
      kbArticles: [],
      metadata: {
        retrievalPath: "vector_filter",
        vectorIndex: "vector_search_conversations_v2",
        vectorConversationCount: 1,
        fallbackConversationCount: 0,
      },
    });
    mockSearchAskDataContextLocal.mockResolvedValue({
      conversations: [],
      kbArticles: [
        {
          id: "kb-1",
          title: "Refund policy",
          content: "Refunds take three business days.",
          relevance_score: 0.91,
        },
      ],
      metadata: {
        retrievalPath: "knowledge_only",
        vectorIndex: null,
        vectorConversationCount: 0,
        fallbackConversationCount: 0,
      },
    });
    mockEmptyTurnHistory();
    mockPersistedTurn(
      "What should I improve in support?",
      "Improve refund clarity."
    );
    mockChatCompletionWithFallback.mockResolvedValue({
      content: "Improve refund clarity.",
      provider: "vertex",
      model: "gemini-heavy",
      latencyMs: 100,
    });
    const supabase = chainedSupabase();

    await appendAiriChatTurn(
      turnParams(supabase, "What should I improve in support?")
    );

    // Local search runs in parallel with the gateway, not after it.
    expect(mockSearchAskDataContextLocal).toHaveBeenCalledTimes(1);
    expect(mockSearchAskDataContextLocal).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-1",
        query: "What should I improve in support?",
      })
    );
    const prompt = generationPrompt();
    expect(prompt).toContain('[KB Article 1] "Refund policy"');
    expect(prompt).toContain("[Conversation 1] Support");

    gcpGateway.canCallGcpAIGateway.mockReturnValue(false);
    gcpGateway.getRemoteAskDataContext.mockReset();
  });

  describe("generator failures", () => {
    function savedAssistantMetadata(): Record<string, unknown> {
      const saved = mockAiriChatMessageCreate.mock.calls
        .map(([doc]) => doc)
        .filter(doc => doc.role === "assistant")
        .at(-1);
      return saved?.metadata ?? {};
    }

    function savedStage(id: string, status = "error") {
      const trace = savedAssistantMetadata().thinkingTrace as {
        stages: Array<{ id: string; status: string; detail: string | null }>;
      };
      return trace.stages.find(
        stage => stage.id === id && stage.status === status
      );
    }

    function recordedTurnAnalytics() {
      return jest.requireMock("@/lib/airi-chats/analytics")
        .recordAiriChatTurnAnalyticsEvents as jest.Mock;
    }

    // A deadline that ran out on Claude: retryable, but no HTTP response.
    const timedOut = () =>
      new AIChatProviderAggregateError([
        {
          provider: "anthropic",
          model: "claude-sonnet-5-5",
          attempt: 1,
          fallbackIndex: 0,
          retryable: true,
          finishReason: null,
          promptBlockReason: null,
          httpStatus: null,
        },
      ]);
    const rejected = () =>
      new AIChatProviderAggregateError([
        {
          provider: "anthropic",
          model: "claude-sonnet-5-5",
          attempt: 1,
          fallbackIndex: 0,
          retryable: false,
          finishReason: null,
          promptBlockReason: null,
          httpStatus: 400,
        },
        {
          provider: "vertex",
          model: "gemini-3.5-flash",
          attempt: 1,
          fallbackIndex: 1,
          retryable: false,
          finishReason: null,
          promptBlockReason: null,
          httpStatus: 400,
        },
      ]);
    const overloaded = () =>
      new AIChatProviderAggregateError([
        {
          provider: "anthropic",
          model: "claude-sonnet-5-5",
          attempt: 1,
          fallbackIndex: 0,
          retryable: true,
          finishReason: null,
          promptBlockReason: null,
          httpStatus: 529,
        },
      ]);

    it.each<[MockAiriChatIntent, string]>([
      ["general_answer", "generation"],
      ["product_capability", "generation"],
      ["whatsapp_template", "template_draft"],
      ["whatsapp_flow", "flow_draft"],
      ["opportunity_scan", "opportunity_scan"],
      ["marketing_campaign", "campaign_package"],
      ["image_generation", "image_brief"],
    ])(
      "saves the busy reply with a safe error class when %s times out",
      async (intent, stageId) => {
        const { params } = prepareCancelledTurn(intent);
        mockChatCompletionWithFallback.mockRejectedValueOnce(timedOut());

        const result = await appendAiriChatTurn(params);

        expect(result.assistantMessage.content).toBe(
          "Airi is temporarily busy. Please try sending the request again in a minute."
        );
        const metadata = savedAssistantMetadata();
        expect(metadata).toMatchObject({
          retryable: true,
          errorCode: "provider_resource_exhausted",
          errorClass: "ai_chat_provider_failed",
          errorProvider: "anthropic",
          provider: "anthropic",
          model: "claude-sonnet-5-5",
          resourceReceipt: expect.objectContaining({
            errorClass: "ai_chat_provider_failed",
            errorProvider: "anthropic",
          }),
        });
        expect(metadata).not.toHaveProperty("errorHttpStatus");
        expect(metadata).not.toHaveProperty("failed");
        // A timeout is not reported as exhausted capacity.
        expect(savedStage(stageId)?.detail).toBe(
          "Provider unavailable: ai_chat_provider_failed (anthropic)"
        );
        expect(JSON.stringify(metadata)).not.toContain("capacity exhausted");
        expect(recordedTurnAnalytics()).toHaveBeenCalledWith(
          expect.objectContaining({
            outcome: "failed",
            metadata: expect.objectContaining({
              errorCode: "provider_resource_exhausted",
              errorClass: "ai_chat_provider_failed",
            }),
          })
        );
      }
    );

    it("prepares the image brief on the light model and starts no image when it fails", async () => {
      const { params } = prepareCancelledTurn("image_generation");
      mockChatCompletionWithFallback.mockRejectedValueOnce(overloaded());

      await appendAiriChatTurn(params);

      expect(mockChatCompletionWithFallback.mock.calls[0]?.[0]?.model).toBe(
        "light-text-model"
      );
      expect(mockCreateQueuedAiriImageGeneration).not.toHaveBeenCalled();
      expect(savedAssistantMetadata()).toMatchObject({
        retryable: true,
        errorHttpStatus: 529,
      });
    });

    it("records the error class of a rejected product capability answer on its failure reply", async () => {
      const { params } = prepareCancelledTurn("product_capability");
      mockChatCompletionWithFallback.mockRejectedValueOnce(rejected());

      const result = await appendAiriChatTurn(params);

      expect(result.assistantMessage.content).toContain(
        "I saved your request, but I could not finish the answer"
      );
      const metadata = savedAssistantMetadata();
      expect(metadata).toMatchObject({
        failed: true,
        errorCode: "airi_generation_failed",
        errorClass: "ai_chat_provider_failed",
        errorProvider: "vertex",
        errorHttpStatus: 400,
        resourceReceipt: expect.objectContaining({
          errorClass: "ai_chat_provider_failed",
          errorProvider: "vertex",
          errorHttpStatus: 400,
        }),
      });
      expect(savedStage("generation")?.detail).toBe(
        "ai_chat_provider_failed (vertex HTTP 400)"
      );
      expect(savedStage("generation_recovery", "complete")?.detail).toBe(
        "ai_chat_provider_failed (vertex HTTP 400)"
      );
      expect(recordedTurnAnalytics()).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: "failed" })
      );
    });

    it("records a successful answer as ok", async () => {
      const { params } = prepareCancelledTurn();
      mockChatCompletionWithFallback.mockResolvedValueOnce({
        content: "Customers ask about delivery.",
        provider: "anthropic",
        model: "claude-sonnet",
        latencyMs: 10,
      });

      await appendAiriChatTurn(params);

      expect(recordedTurnAnalytics()).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: "ok" })
      );
      expect(
        recordedTurnAnalytics().mock.calls[0]?.[0]?.metadata
      ).not.toHaveProperty("errorCode");
    });

    const campaignPackageResponse = {
      content: JSON.stringify({
        title: "Dormant demo lead launch",
        goal: "Book demos from dormant high-intent leads.",
        audience: "Dormant WhatsApp leads who asked for demos",
        angle: "Helpful reminder with a low-friction reply",
        evidence: ["Recent conversations mention demo intent."],
        tools: defaultMarketingToolAccess,
        steps: [
          {
            id: "template",
            kind: "whatsapp_template",
            title: "Draft WhatsApp template",
            description: "Create a compliant demo reactivation message.",
            status: "ready",
            tool: "whatsapp",
          },
        ],
        checks: [{ label: "Human approval", status: "pending" }],
        nextAction: "Review the WhatsApp template.",
      }),
      provider: "anthropic",
      model: "claude-sonnet",
      latencyMs: 90,
    };
    const campaignTemplateResponse = {
      content: JSON.stringify({
        name: "dormant_demo_reactivation",
        language: "en",
        category: "MARKETING",
        components: [
          {
            type: "BODY",
            text: "Hi {{1}}, still interested in a demo? Reply here and we will help you book one.",
          },
        ],
      }),
      provider: "anthropic",
      model: "claude-sonnet",
      latencyMs: 80,
    };

    it.each([
      { label: "a retryable", makeError: overloaded, status: 529 },
      { label: "a non-retryable", makeError: rejected, status: 400 },
    ])(
      "keeps the campaign package when its template draft hits $label failure",
      async ({ makeError, status }) => {
        const { params } = prepareCancelledTurn("marketing_campaign");
        mockChatCompletionWithFallback
          .mockResolvedValueOnce(campaignPackageResponse)
          .mockRejectedValueOnce(makeError());

        const result = await appendAiriChatTurn(params);

        expect(result.assistantMessage.content).toContain(
          "I prepared the campaign package **Dormant demo lead launch**"
        );
        expect(result.assistantMessage.content).toContain(
          "I could not draft its WhatsApp template this time"
        );
        const metadata = savedAssistantMetadata();
        expect(metadata).toMatchObject({
          airiCampaignPackage: expect.objectContaining({
            title: "Dormant demo lead launch",
          }),
          airiCampaignArtifact: expect.objectContaining({
            id: "campaign-artifact-1",
          }),
          airiCampaignTemplateDraftFailure: expect.objectContaining({
            errorClass: "ai_chat_provider_failed",
            errorHttpStatus: status,
          }),
        });
        expect(metadata).not.toHaveProperty("failed");
        expect(metadata).not.toHaveProperty("retryable");
        expect(metadata).not.toHaveProperty("airiBuilderPatch");
        expect(savedStage("template_draft")?.detail).toContain(
          "ai_chat_provider_failed"
        );
        expect(recordedTurnAnalytics()).toHaveBeenCalledWith(
          expect.objectContaining({ outcome: "ok" })
        );
      }
    );

    it("drafts a campaign's template as a new draft, never over the open template", async () => {
      const { params } = prepareCancelledTurn("marketing_campaign");
      mockChatCompletionWithFallback
        .mockResolvedValueOnce(campaignPackageResponse)
        .mockResolvedValueOnce(campaignTemplateResponse);

      await appendAiriChatTurn({
        ...params,
        activeBuilder: {
          kind: "whatsapp_template",
          artifactId: "artifact-open",
          revision: 4,
          templateDraft: {
            kind: "whatsapp_template",
            name: "open_template",
            language: "en",
            category: "MARKETING",
            components: [{ type: "BODY", text: "The open template body" }],
          },
        },
      });

      const templatePrompt = generationPrompt(1);
      expect(templatePrompt).toContain("No active template draft.");
      expect(templatePrompt).not.toContain("The open template body");
      const patch = savedAssistantMetadata().airiBuilderPatch;
      expect(patch).toMatchObject({
        kind: "whatsapp_template",
        baseRevision: 0,
        nextRevision: 1,
      });
      expect(patch).not.toHaveProperty("artifactId");
      expect(mockUpdateAiriArtifact).not.toHaveBeenCalled();
      expect(
        mockCreateAiriArtifact.mock.calls.map(([request]) => request.kind)
      ).toEqual(["marketing_campaign"]);
    });

    const templateResponse = {
      content: JSON.stringify({
        name: "warm_follow_up",
        language: "en",
        category: "MARKETING",
        components: [{ type: "BODY", text: "Hi {{1}}, can we help?" }],
      }),
      provider: "anthropic",
      model: "claude-sonnet",
      latencyMs: 50,
    };

    it("names the open artifact on a builder patch that edits it", async () => {
      const { params } = prepareCancelledTurn("whatsapp_template");
      mockChatCompletionWithFallback.mockResolvedValueOnce(templateResponse);

      await appendAiriChatTurn({
        ...params,
        activeBuilder: {
          kind: "whatsapp_template",
          artifactId: "artifact-1",
          revision: 5,
          templateDraft: {
            kind: "whatsapp_template",
            name: "existing_template",
            language: "en",
            category: "MARKETING",
            components: [{ type: "BODY", text: "Hi {{1}}" }],
          },
        },
      });

      expect(savedAssistantMetadata().airiBuilderPatch).toMatchObject({
        artifactId: "artifact-1",
        baseRevision: 5,
      });
      expect(mockUpdateAiriArtifact).toHaveBeenCalledWith(
        expect.objectContaining({ artifactId: "artifact-1", baseRevision: 5 })
      );
    });

    it.each([
      { label: "no builder is open", activeBuilder: undefined },
      {
        label: "a Flow is open",
        activeBuilder: {
          kind: "whatsapp_flow",
          artifactId: "flow-artifact-open",
          revision: 3,
          flowConfig: {
            templateId: "lead_generation",
            ctaText: "Open",
            screens: [
              {
                id: "LEAD_FORM",
                title: "Contact",
                fields: [
                  {
                    id: "name",
                    label: "Name",
                    fieldType: "TextInput",
                  },
                ],
              },
            ],
          },
        },
      },
    ])(
      "creates a new template artifact with an unnamed patch when $label",
      async ({ activeBuilder }) => {
        const { params } = prepareCancelledTurn("whatsapp_template");
        mockChatCompletionWithFallback.mockResolvedValueOnce(templateResponse);

        await appendAiriChatTurn({ ...params, activeBuilder });

        const metadata = savedAssistantMetadata();
        expect(metadata.airiBuilderPatch).toMatchObject({ baseRevision: 0 });
        expect(metadata.airiBuilderPatch).not.toHaveProperty("artifactId");
        expect(metadata.airiArtifact).toMatchObject({ id: "artifact-1" });
        expect(mockUpdateAiriArtifact).not.toHaveBeenCalled();
        expect(mockCreateAiriArtifact).toHaveBeenCalledWith(
          expect.objectContaining({ kind: "whatsapp_template" })
        );
      }
    );

    function flowResponse(flow: unknown) {
      return {
        content: JSON.stringify(flow),
        provider: "anthropic",
        model: "claude-sonnet",
        latencyMs: 70,
      };
    }

    it("repairs a generated Flow the artifact validator would reject before saving it", async () => {
      const { params } = prepareCancelledTurn("whatsapp_flow");
      mockChatCompletionWithFallback.mockResolvedValueOnce(
        flowResponse({
          templateId: "lead_generation",
          ctaText: "Book a consultation with our team today",
          screens: [
            {
              id: "CONTACT",
              title: "Contact",
              fields: [
                {
                  id: "name",
                  label: "Your full name as on your passport",
                  fieldType: "TextInput",
                  required: true,
                },
                { id: "topic", label: "Topic", fieldType: "Dropdown" },
              ],
            },
            {
              id: "DETAILS",
              title: "Details",
              fields: [
                { id: "name", label: "Company name", fieldType: "TextInput" },
              ],
            },
          ],
        })
      );

      const result = await appendAiriChatTurn(params);

      const saved = mockCreateAiriArtifact.mock.calls[0]?.[0]?.snapshot
        ?.flowConfig as {
        ctaText: string;
        screens: Array<{
          fields: Array<{ id: string; label: string; fieldType: string }>;
        }>;
      };
      expect(saved.ctaText.length).toBeLessThanOrEqual(35);
      expect(saved.screens[0]?.fields).toEqual([
        expect.objectContaining({
          id: "name",
          label: "Your full name as on",
          fieldType: "TextInput",
        }),
      ]);
      expect(saved.screens[1]?.fields[0]).toMatchObject({ id: "name_2" });
      expect(result.assistantMessage.content).toContain(
        "Done. I updated the WhatsApp Flow"
      );
      expect(savedAssistantMetadata()).not.toHaveProperty(
        "airiArtifactInvalid"
      );
    });

    it("keeps a finished Flow draft the artifact validator rejects and reports what to fix", async () => {
      const { params } = prepareCancelledTurn("whatsapp_flow");
      const { AiriArtifactValidationError } = jest.requireMock(
        "@/lib/airi-artifacts/service"
      );
      mockCreateAiriArtifact.mockRejectedValueOnce(
        new AiriArtifactValidationError({
          status: "invalid",
          issues: [
            {
              code: "screen_id_reserved",
              path: "screens[0].id",
              message: "screen_id_reserved",
              severity: "error",
            },
          ],
        })
      );
      mockChatCompletionWithFallback.mockResolvedValueOnce(
        flowResponse({
          screens: [
            {
              id: "LEAD",
              title: "Lead",
              fields: [{ id: "name", label: "Name", fieldType: "TextInput" }],
            },
          ],
        })
      );

      const result = await appendAiriChatTurn(params);

      expect(result.assistantMessage.content).toContain(
        "Done. I updated the WhatsApp Flow"
      );
      expect(result.assistantMessage.content).toContain(
        "I could not save this draft yet: fix 1 validation issue in the builder"
      );
      const metadata = savedAssistantMetadata();
      expect(metadata).not.toHaveProperty("failed");
      expect(metadata).not.toHaveProperty("airiArtifact");
      expect(metadata.airiBuilderPatch).toMatchObject({
        kind: "whatsapp_flow",
      });
      expect(metadata.airiArtifactInvalid).toEqual({
        kind: "whatsapp_flow",
        status: "invalid",
        issues: [{ code: "screen_id_reserved", path: "screens[0].id" }],
      });
      expect(savedStage("builder_artifact")?.detail).toBe("1 validation issue");
      expect(recordedTurnAnalytics()).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: "ok" })
      );
    });
  });

  describe("turn pipeline", () => {
    function preparePipelineTurn(title = "Existing chat") {
      const thread: Record<string, unknown> & { save: jest.Mock } = {
        _id: "thread-1",
        workspaceId: "workspace-1",
        title,
        status: "active",
        source: "manual",
        save: jest.fn().mockResolvedValue(undefined),
      };
      mockAiriChatThreadFindOne.mockResolvedValue(thread);
      mockEmptyTurnHistory();
      mockEchoedMessageCreate("2026-10-07T00:00:00.000Z");
      mockSearchAskDataContextLocal.mockResolvedValue({
        conversations: [],
        kbArticles: [],
      });
      const supabase = profilelessSupabase();
      const events: AiriChatRunEvent[] = [];
      return {
        thread,
        events,
        params: {
          supabase: supabase as never,
          workspaceId: "workspace-1",
          userId: "user-1",
          threadId: "thread-1",
          content: "How do customers feel about delivery times?",
          emitProgress: async (event: AiriChatRunEvent) => {
            events.push(event);
          },
        },
      };
    }

    it.each(["append", "create"])(
      "starts workspace retrieval before attached sources are grounded (%s)",
      async operation => {
        const { params } = preparePipelineTurn();
        const threadModel = jest.requireMock(
          "@/models/airi-chat-thread"
        ).AiriChatThread;
        threadModel.create.mockImplementationOnce(
          async (doc: Record<string, unknown>) => ({
            ...doc,
            _id: "thread-1",
            save: jest.fn(),
          })
        );
        let localStartedBeforeGrounding: boolean | undefined;
        mockBuildSelectedAiriChatGroundingContext.mockImplementationOnce(
          async () => {
            // Let work that already started reach its first call.
            await new Promise(resolve => setTimeout(resolve, 0));
            localStartedBeforeGrounding =
              mockSearchAskDataContextLocal.mock.calls.length > 0;
            return {
              conversations: [],
              kbArticles: [],
              selectedSources: [],
              selectedSourceLabels: [],
              promptSections: [],
              sourceIds: [],
              conversationSourceIds: [],
              kbSourceIds: [],
              retrievalPath: "none",
            };
          }
        );
        mockChatCompletionWithFallback.mockResolvedValue({
          content: "Answer",
          provider: "anthropic",
          model: "claude-sonnet",
        });

        const run =
          operation === "append"
            ? appendAiriChatTurn
            : createAndAppendAiriChatTurn;
        await run({
          ...params,
          selectedSources: [
            {
              kind: "workspace_source",
              sourceId: "canva-1",
              sourceType: "canva",
              label: "Canva",
            },
          ],
        });

        expect(localStartedBeforeGrounding).toBe(true);
        // Started once, by the turn, and reused by the reply.
        expect(mockSearchAskDataContextLocal).toHaveBeenCalledTimes(1);
      }
    );

    it("stops early workspace retrieval when an attached source is unavailable", async () => {
      const { params } = preparePipelineTurn();
      let localSignal: AbortSignal | undefined;
      mockSearchAskDataContextLocal.mockImplementation(
        (request: { signal: AbortSignal }) => {
          localSignal = request.signal;
          return new Promise(() => undefined);
        }
      );
      const unavailable = new Error("Selected source is unavailable: Canva");
      mockBuildSelectedAiriChatGroundingContext.mockImplementationOnce(
        async () => {
          await new Promise(resolve => setTimeout(resolve, 0));
          throw unavailable;
        }
      );

      await expect(
        appendAiriChatTurn({
          ...params,
          selectedSources: [
            {
              kind: "workspace_source",
              sourceId: "canva-1",
              sourceType: "canva",
              label: "Canva",
            },
          ],
        })
      ).rejects.toBe(unavailable);

      expect(localSignal?.aborted).toBe(true);
      // A bad source still fails before anything is saved.
      expect(mockAiriChatMessageCreate).not.toHaveBeenCalled();
    });

    it("does not answer a retrieval timeout as an empty workspace", async () => {
      const { params, events } = preparePipelineTurn();
      const realTimeout = AbortSignal.timeout.bind(AbortSignal);
      const localDeadline = new AbortController();
      const timeoutSpy = jest
        .spyOn(AbortSignal, "timeout")
        .mockImplementation(ms =>
          ms === AIRI_CHAT_LOCAL_RETRIEVAL_TIMEOUT_MS
            ? localDeadline.signal
            : realTimeout(ms)
        );
      mockSearchAskDataContextLocal.mockImplementation(
        (request: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            request.signal.addEventListener("abort", () =>
              reject(request.signal.reason)
            );
            // The local deadline passes while the search is still running.
            setTimeout(() =>
              localDeadline.abort(
                new DOMException("The operation timed out", "TimeoutError")
              )
            );
          })
      );
      mockChatCompletionWithFallback.mockResolvedValue({
        content: "The workspace search did not finish. Try again.",
        provider: "anthropic",
        model: "claude-sonnet",
      });

      try {
        // Reads like a platform question: an empty tenant would be rerouted.
        await appendAiriChatTurn({ ...params, content: "what is airi.chat" });
      } finally {
        timeoutSpy.mockRestore();
      }

      expect(mockRetrieveAiriProductKbArticles).not.toHaveBeenCalled();
      const prompt = mockChatCompletionWithFallback.mock.calls[0][0].messages[0]
        .content as string;
      expect(prompt).not.toContain(
        "say this workspace has no matching knowledge base articles"
      );
      expect(prompt).not.toContain("No relevant KB articles found.");
      expect(prompt).toContain("could not be loaded in time");
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "stage",
          id: "workspace_retrieval",
          status: "error",
        })
      );
    });

    it("starts workspace retrieval before the intent is classified", async () => {
      const { params, events } = preparePipelineTurn();
      mockClassifyAiriChatIntent.mockImplementation(async () => {
        // Retrieval is already running while the classifier works.
        expect(mockSearchAskDataContextLocal).toHaveBeenCalledTimes(1);
        return buildMockIntentClassification("general_answer");
      });
      mockChatCompletionWithFallback.mockResolvedValue({
        content: "Delivery is the top complaint.",
        provider: "anthropic",
        model: "claude-sonnet",
      });

      await appendAiriChatTurn(params);

      const stages = events.flatMap(event =>
        event.type === "stage" ? [`${event.id}:${event.status}`] : []
      );
      expect(stages.indexOf("workspace_retrieval:running")).toBeLessThan(
        stages.indexOf("intent:running")
      );
      const retrievalComplete = events.find(
        event =>
          event.type === "stage" &&
          event.id === "workspace_retrieval" &&
          event.status === "complete"
      );
      expect(retrievalComplete).toMatchObject({
        durationMs: expect.any(Number),
      });
      expect(
        events.find(
          event =>
            event.type === "stage" && event.id === "workspace_retrieval_local"
        )
      ).toMatchObject({ status: "complete", durationMs: expect.any(Number) });
      expect(mockClassifyAiriChatIntent).toHaveBeenCalledTimes(1);
    });

    it("starts marketing tool access while retrieval is still running", async () => {
      const { params } = preparePipelineTurn();
      mockAiriChatIntent("opportunity_scan");
      let releaseRetrieval!: () => void;
      const retrievalReleased = new Promise<void>(resolve => {
        releaseRetrieval = resolve;
      });
      mockSearchAskDataContextLocal.mockImplementation(async () => {
        await retrievalReleased;
        return { conversations: [], kbArticles: [] };
      });
      mockResolveAiriMarketingToolAccess.mockImplementation(async () => {
        releaseRetrieval();
        return defaultMarketingToolAccess;
      });
      mockChatCompletionWithFallback.mockResolvedValue({
        content: JSON.stringify({ title: "Scan", opportunities: [] }),
        provider: "anthropic",
        model: "claude-sonnet",
      });

      await appendAiriChatTurn(params);

      expect(mockResolveAiriMarketingToolAccess).toHaveBeenCalledTimes(1);
    });

    it("streams general answers as throttled full-text assistant_delta events", async () => {
      const { params, events } = preparePipelineTurn();
      // The throttle reads Date.now(); a fixed clock makes every throttle
      // decision independent of how fast this machine runs the test.
      let now = 1_000_000;
      const clock = jest.spyOn(Date, "now").mockImplementation(() => now);
      const deltaWaiters = new Map<string, () => void>();
      const emitProgress = params.emitProgress;
      params.emitProgress = async (event: AiriChatRunEvent) => {
        await emitProgress(event);
        if (event.type === "assistant_delta") deltaWaiters.get(event.text)?.();
      };
      const deltaSent = (text: string) =>
        new Promise<void>(resolve => deltaWaiters.set(text, resolve));
      mockChatCompletionWithFallback.mockImplementationOnce(
        async (request: {
          onDelta?: (event: { delta: string; accumulated: string }) => void;
        }) => {
          // The first chunk goes out at once.
          request.onDelta?.({ delta: "Deli", accumulated: "Deli" });
          // The next one is held for the rest of the throttle window and
          // sent by the window's timer.
          const held = deltaSent("Delivery");
          request.onDelta?.({ delta: "very", accumulated: "Delivery" });
          await held;
          // Halfway through the next window: still held when generation
          // returns, so it is dropped and assistant_message carries it.
          now += AIRI_CHAT_DELTA_THROTTLE_MS / 2;
          request.onDelta?.({
            delta: " is slow",
            accumulated: "Delivery is slow",
          });
          return {
            content: "Delivery is slow.",
            provider: "anthropic",
            model: "claude-sonnet",
          };
        }
      );

      try {
        await appendAiriChatTurn(params);
        // A dropped chunk's timer would have been due before this one fires
        // (timers fire in due order), so this proves it was cancelled.
        await new Promise(resolve =>
          setTimeout(resolve, AIRI_CHAT_DELTA_THROTTLE_MS)
        );
      } finally {
        clock.mockRestore();
      }

      const deltas = events.filter(event => event.type === "assistant_delta");
      expect(deltas).toEqual([
        expect.objectContaining({ threadId: "thread-1", text: "Deli" }),
        expect.objectContaining({ threadId: "thread-1", text: "Delivery" }),
      ]);
      const types = events.map(event => event.type);
      expect(types.lastIndexOf("assistant_delta")).toBeLessThan(
        types.indexOf("assistant_message")
      );
      expect(
        events.find(event => event.type === "assistant_message")
      ).toMatchObject({ message: { content: "Delivery is slow." } });
    });

    it("does not stream when no live client listens", async () => {
      const { params } = preparePipelineTurn();
      mockChatCompletionWithFallback.mockResolvedValue({
        content: "Answer",
        provider: "anthropic",
        model: "claude-sonnet",
      });
      await appendAiriChatTurn({ ...params, emitProgress: undefined });
      expect(
        mockChatCompletionWithFallback.mock.calls[0][0]
      ).not.toHaveProperty("onDelta");
    });

    it("emits done right after the answer and names the chat in the background", async () => {
      const { params, events, thread } = preparePipelineTurn("New chat");
      let resolveTitle!: (value: unknown) => void;
      mockChatCompletionWithFallback
        .mockResolvedValueOnce({
          content: "Delivery is slow.",
          provider: "anthropic",
          model: "claude-sonnet",
        })
        .mockImplementationOnce(
          () =>
            new Promise(resolve => {
              resolveTitle = resolve;
            })
        );

      const result = await appendAiriChatTurn(params);

      // The turn finished while the title call is still pending.
      const types = events.map(event => event.type);
      expect(types.slice(-2)).toEqual(["assistant_message", "done"]);
      const done = events.find(event => event.type === "done");
      expect(done).toMatchObject({
        thread: { title: "How do customers feel about delivery times?" },
      });
      expect(result.thread.title).toBe(
        "How do customers feel about delivery times?"
      );
      expect(
        events.some(event => event.type === "stage" && event.id === "title")
      ).toBe(false);
      // The first-message title was stored with the answer, before 'done',
      // and only over the default title the turn started from.
      expect(mockAiriChatThreadUpdateOne.mock.calls).toEqual([
        [
          { _id: "thread-1", title: "New chat" },
          {
            $set: {
              title: "How do customers feel about delivery times?",
              updatedAt: expect.any(Date),
            },
          },
        ],
      ]);

      resolveTitle({
        content: "Delivery complaints",
        provider: "anthropic",
        model: "claude-haiku",
      });
      await new Promise(resolve => setTimeout(resolve, 0));
      // The generated title replaces only that fallback.
      expect(mockAiriChatThreadUpdateOne).toHaveBeenLastCalledWith(
        {
          _id: "thread-1",
          title: "How do customers feel about delivery times?",
        },
        { $set: { title: "Delivery complaints" } },
        { timestamps: false }
      );
      expect(thread.save).not.toHaveBeenCalled();
      // The stream is over by then; no event is sent after 'done'.
      expect(events.at(-1)?.type).toBe("done");
    });

    it("bumps the thread updatedAt on every turn", async () => {
      const { params, events, thread } = preparePipelineTurn();
      const before = Date.now();
      mockChatCompletionWithFallback.mockResolvedValue({
        content: "Answer",
        provider: "anthropic",
        model: "claude-sonnet",
      });

      await appendAiriChatTurn(params);

      expect(thread.updatedAt).toBeInstanceOf(Date);
      expect((thread.updatedAt as Date).getTime()).toBeGreaterThanOrEqual(
        before
      );
      expect(mockAiriChatThreadUpdateOne.mock.calls).toEqual([
        [{ _id: "thread-1" }, { $set: { updatedAt: thread.updatedAt } }],
      ]);
      const done = events.find(event => event.type === "done");
      expect(done?.type === "done" && Date.parse(done.thread.updatedAt)).toBe(
        (thread.updatedAt as Date).getTime()
      );
    });

    afterEach(() => {
      // Implementations set below would outlive clearAllMocks.
      mockChatCompletionWithFallback.mockReset();
      mockAiriChatThreadUpdateOne.mockReset();
      mockAiriChatThreadUpdateOne.mockImplementation(async () => ({
        matchedCount: 1,
        modifiedCount: 1,
      }));
    });

    /** The stored thread, read at each turn's admission and written by updateOne. */
    function useStoredThread(title: string) {
      const stored: Record<string, unknown> = {
        _id: "thread-1",
        workspaceId: "workspace-1",
        title,
        status: "active",
        source: "manual",
      };
      mockAiriChatThreadFindOne.mockImplementation(async () => {
        const doc: Record<string, unknown> = { ...stored };
        // Like a Mongoose document: save() writes the paths it changed.
        doc.save = jest.fn(async () => {
          Object.assign(stored, { title: doc.title, updatedAt: doc.updatedAt });
        });
        return doc;
      });
      mockAiriChatThreadUpdateOne.mockImplementation(
        async (...args: unknown[]) => {
          const [filter, update] = args as [
            Record<string, unknown>,
            { $set: Record<string, unknown> },
          ];
          if ("title" in filter && stored.title !== filter.title) {
            return { matchedCount: 0, modifiedCount: 0 };
          }
          Object.assign(stored, update.$set);
          return { matchedCount: 1, modifiedCount: 1 };
        }
      );
      return stored;
    }

    const titleCalls = () =>
      mockChatCompletionWithFallback.mock.calls.filter(
        ([request]) => request.analytics?.operation === "airi_chat.title"
      );

    it("does not name the chat again when a follow-up arrives before the title", async () => {
      const { params } = preparePipelineTurn();
      const stored = useStoredThread("New chat");
      let resolveTitle!: (value: unknown) => void;
      mockChatCompletionWithFallback.mockImplementation(
        (request: { analytics?: { operation?: string } }) =>
          request.analytics?.operation === "airi_chat.title"
            ? new Promise(resolve => {
                resolveTitle = resolve;
              })
            : Promise.resolve({
                content: "Answer",
                provider: "anthropic",
                model: "claude-sonnet",
              })
      );

      await appendAiriChatTurn(params);
      expect(stored.title).toBe("How do customers feel about delivery times?");
      // Turn 2 is admitted while turn 1's title call is still running.
      const second = await appendAiriChatTurn({
        ...params,
        content: "yes, do it",
      });

      expect(second.thread.title).toBe(
        "How do customers feel about delivery times?"
      );
      expect(titleCalls()).toHaveLength(1);
      resolveTitle({
        content: "Delivery complaints",
        provider: "anthropic",
        model: "claude-haiku",
      });
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(stored.title).toBe("Delivery complaints");
    });

    it("keeps a rename made between 'done' and the generated title", async () => {
      const { params } = preparePipelineTurn();
      const stored = useStoredThread("New chat");
      let resolveTitle!: (value: unknown) => void;
      mockChatCompletionWithFallback.mockImplementation(
        (request: { analytics?: { operation?: string } }) =>
          request.analytics?.operation === "airi_chat.title"
            ? new Promise(resolve => {
                resolveTitle = resolve;
              })
            : Promise.resolve({
                content: "Answer",
                provider: "anthropic",
                model: "claude-sonnet",
              })
      );

      await appendAiriChatTurn(params);
      // The user renames the chat in the drawer.
      stored.title = "Delivery research";
      resolveTitle({
        content: "Delivery complaints",
        provider: "anthropic",
        model: "claude-haiku",
      });
      await new Promise(resolve => setTimeout(resolve, 0));

      expect(stored.title).toBe("Delivery research");
    });

    it("persists the routing intent on general answers and failure replies", async () => {
      const { params } = preparePipelineTurn();
      mockChatCompletionWithFallback.mockResolvedValueOnce({
        content: "Answer",
        provider: "anthropic",
        model: "claude-sonnet",
      });
      await appendAiriChatTurn(params);
      expect(mockAiriChatMessageCreate).toHaveBeenLastCalledWith(
        expect.objectContaining({
          role: "assistant",
          metadata: expect.objectContaining({
            intent: "general_answer",
            intentConfidence: 0.9,
            intentReason: "test intent",
          }),
        })
      );

      mockChatCompletionWithFallback.mockRejectedValueOnce(
        new Error("unexpected failure")
      );
      await appendAiriChatTurn(params);
      expect(mockAiriChatMessageCreate).toHaveBeenLastCalledWith(
        expect.objectContaining({
          role: "assistant",
          metadata: expect.objectContaining({
            failed: true,
            intent: "general_answer",
            intentReason: "test intent",
          }),
        })
      );
    });

    it("reuses a thread the route already loaded", async () => {
      const { params, thread } = preparePipelineTurn();
      mockChatCompletionWithFallback.mockResolvedValue({
        content: "Answer",
        provider: "anthropic",
        model: "claude-sonnet",
      });
      await appendAiriChatTurn({ ...params, thread: thread as never });
      expect(mockAiriChatThreadFindOne).not.toHaveBeenCalled();
    });

    describe("Meta Ads workspace retrieval", () => {
      const metaReport = {
        content: "Spend is up 12% week over week.",
        pendingMutations: [],
        toolTrace: [],
      };
      const workspaceRetrievalStages = (events: AiriChatRunEvent[]) =>
        events.flatMap(event =>
          event.type === "stage" && event.id.startsWith("workspace_retrieval")
            ? [`${event.id}:${event.status}:${event.detail ?? ""}`]
            : []
        );

      it.each([
        ["an @meta mention", { content: "@meta show campaign spend" }],
        [
          "the attached Meta skill",
          {
            content: "Show campaign spend",
            selectedSources: [buildAiriChatMetaSkillRef()],
          },
        ],
      ])("never searches the workspace for %s", async (_label, overrides) => {
        const { params, events } = preparePipelineTurn();
        mockAiriChatIntent("meta_ads_mcp");
        mockBuildSelectedAiriChatGroundingContext.mockResolvedValue(null);
        mockRunMetaAdsMcpTurn.mockResolvedValueOnce(metaReport);

        const result = await appendAiriChatTurn({ ...params, ...overrides });

        expect(mockSearchAskDataContextLocal).not.toHaveBeenCalled();
        expect(workspaceRetrievalStages(events)).toEqual([]);
        expect(mockRunMetaAdsMcpTurn).toHaveBeenCalledWith(
          expect.objectContaining({
            groundingContext: expect.objectContaining({
              workspaceKnowledge: "",
              customerContext: "",
            }),
          })
        );
        expect(result.assistantMessage.content).toBe(metaReport.content);
      });

      it("stops a running search when the classifier routes a follow-up to Meta Ads", async () => {
        const { params, events } = preparePipelineTurn();
        mockAiriChatIntent("meta_ads_mcp");
        // The search never answers on its own: Meta must not wait for it.
        mockSearchAskDataContextLocal.mockImplementation(
          (request: { signal: AbortSignal }) =>
            new Promise((_resolve, reject) => {
              request.signal.addEventListener("abort", () =>
                reject(request.signal.reason)
              );
            })
        );
        mockRunMetaAdsMcpTurn.mockResolvedValueOnce(metaReport);

        const result = await appendAiriChatTurn({
          ...params,
          content: "Compare with last month",
        });

        const localSignal = mockSearchAskDataContextLocal.mock.calls[0][0]
          .signal as AbortSignal;
        expect(localSignal.aborted).toBe(true);
        expect(workspaceRetrievalStages(events)).toEqual([
          "workspace_retrieval:running:",
          "workspace_retrieval:complete:Not used for Meta Ads",
        ]);
        expect(mockRunMetaAdsMcpTurn).toHaveBeenCalledWith(
          expect.objectContaining({
            groundingContext: expect.objectContaining({
              workspaceKnowledge: "",
              customerContext: "",
            }),
          })
        );
        expect(result.assistantMessage.content).toBe(metaReport.content);
      });

      it("ignores workspace context the search already found for a Meta Ads turn", async () => {
        const { params } = preparePipelineTurn();
        mockAiriChatIntent("meta_ads_mcp");
        mockSearchAskDataContextLocal.mockResolvedValue({
          conversations: [
            { id: "conversation-1", summary: "Customers ask for refunds." },
          ],
          kbArticles: [
            {
              id: "kb-1",
              title: "Refund policy",
              content: "Refunds take 5 days.",
              relevance_score: 0.9,
            },
          ],
        });
        mockRunMetaAdsMcpTurn.mockResolvedValueOnce(metaReport);

        await appendAiriChatTurn({
          ...params,
          content: "Compare with last month",
        });

        expect(mockSearchAskDataContextLocal).toHaveBeenCalledTimes(1);
        expect(
          mockRunMetaAdsMcpTurn.mock.calls[0][0].groundingContext
        ).toMatchObject({ workspaceKnowledge: "", customerContext: "" });
      });

      it("still searches the workspace for other intents", async () => {
        const { params } = preparePipelineTurn();
        mockChatCompletionWithFallback.mockResolvedValue({
          content: "Answer",
          provider: "anthropic",
          model: "claude-sonnet",
        });

        await appendAiriChatTurn({
          ...params,
          content: "What do customers say about meta tags?",
        });

        expect(mockSearchAskDataContextLocal).toHaveBeenCalledTimes(1);
        expect(mockRunMetaAdsMcpTurn).not.toHaveBeenCalled();
      });
    });

    describe("Meta Ads native answer", () => {
      const savedAssistantDoc = () =>
        mockAiriChatMessageCreate.mock.calls
          .map(call => call[0] as Record<string, unknown>)
          .filter(doc => doc.role === "assistant")
          .at(-1) as { content: string; metadata: Record<string, unknown> };

      it("streams the Meta Ads answer as full-text assistant_delta events in the workspace language", async () => {
        const { params, events } = preparePipelineTurn();
        mockAiriChatIntent("meta_ads_mcp");
        let now = 1_000_000;
        const clock = jest.spyOn(Date, "now").mockImplementation(() => now);
        mockRunMetaAdsMcpTurn.mockImplementationOnce(
          async (request: { onTextDelta?: (text: string) => unknown }) => {
            // Text between tool calls goes out at once.
            await request.onTextDelta?.("Let me check the account.");
            // The next model step restarts the preview with a shorter text.
            now += AIRI_CHAT_DELTA_THROTTLE_MS;
            await request.onTextDelta?.("Spend is up");
            // Still held by the throttle when the loop returns: dropped, the
            // saved answer replaces the preview.
            now += AIRI_CHAT_DELTA_THROTTLE_MS / 2;
            await request.onTextDelta?.("Spend is up 12%");
            return {
              content: "Spend is up 12% week over week.",
              pendingMutations: [],
              toolTrace: [],
            };
          }
        );

        try {
          await appendAiriChatTurn({ ...params, content: "@meta show spend" });
          await new Promise(resolve =>
            setTimeout(resolve, AIRI_CHAT_DELTA_THROTTLE_MS)
          );
        } finally {
          clock.mockRestore();
        }

        expect(mockRunMetaAdsMcpTurn).toHaveBeenCalledWith(
          expect.objectContaining({
            language: "en",
            onTextDelta: expect.any(Function),
          })
        );
        const deltas = events.filter(event => event.type === "assistant_delta");
        expect(deltas).toEqual([
          expect.objectContaining({
            threadId: "thread-1",
            text: "Let me check the account.",
          }),
          expect.objectContaining({
            threadId: "thread-1",
            text: "Spend is up",
          }),
        ]);
        const types = events.map(event => event.type);
        expect(types.lastIndexOf("assistant_delta")).toBeLessThan(
          types.indexOf("assistant_message")
        );
        expect(
          events.find(event => event.type === "assistant_message")
        ).toMatchObject({
          message: { content: "Spend is up 12% week over week." },
        });
        expect(savedAssistantDoc().metadata).not.toHaveProperty("failed");
      });

      it("does not stream the Meta Ads answer when no live client listens", async () => {
        const { params } = preparePipelineTurn();
        mockAiriChatIntent("meta_ads_mcp");
        mockRunMetaAdsMcpTurn.mockResolvedValueOnce({
          content: "Spend is up.",
          pendingMutations: [],
          toolTrace: [],
        });

        await appendAiriChatTurn({
          ...params,
          content: "@meta show spend",
          emitProgress: undefined,
        });

        expect(mockRunMetaAdsMcpTurn.mock.calls[0][0]).not.toHaveProperty(
          "onTextDelta"
        );
        expect(mockRunMetaAdsMcpTurn.mock.calls[0][0]).toMatchObject({
          language: "en",
        });
      });

      it("saves the Claude-only failure as a failed turn with its typed code, keeping prepared cards", async () => {
        const { params, events } = preparePipelineTurn();
        mockAiriChatIntent("meta_ads_mcp");
        const notice =
          "Meta Ads in Airi runs on Claude, which is unavailable right now.";
        mockRunMetaAdsMcpTurn.mockResolvedValueOnce({
          content: notice,
          pendingMutations: [
            {
              id: "mutation-1",
              summary: "Pause campaign Spring",
              transactionDigest: "digest-1",
            },
          ],
          toolTrace: [],
          coverage: {
            complete: false,
            successfulReads: 1,
            reasons: ["meta_ads_requires_claude"],
          },
          failureCode: "meta_ads_requires_claude",
        });

        await appendAiriChatTurn({ ...params, content: "@meta pause Spring" });

        const saved = savedAssistantDoc();
        expect(saved.content).toBe(notice);
        expect(saved.metadata).toMatchObject({
          intent: "meta_ads_mcp",
          failed: true,
          errorCode: "meta_ads_requires_claude",
          pendingActions: [
            expect.objectContaining({
              kind: "meta_ads_mcp_mutation",
              mutationId: "mutation-1",
            }),
          ],
        });
        // No general-model fallback runs for Meta Ads.
        expect(mockChatCompletionWithFallback).not.toHaveBeenCalled();
        expect(events.at(-1)).toMatchObject({ type: "done" });
      });

      it("does not mark other Meta Ads failure codes as a Claude failure", async () => {
        const { params } = preparePipelineTurn();
        mockAiriChatIntent("meta_ads_mcp");
        mockRunMetaAdsMcpTurn.mockResolvedValueOnce({
          content: "Connect Meta Ads first.",
          pendingMutations: [],
          toolTrace: [],
          failureCode: "not_connected",
        });

        await appendAiriChatTurn({ ...params, content: "@meta show spend" });

        expect(savedAssistantDoc().metadata).not.toHaveProperty("errorCode");
        expect(savedAssistantDoc().metadata).not.toHaveProperty("failed");
      });
    });

    describe("turn deadline", () => {
      function turnClock() {
        let now = Date.now();
        return {
          now: () => now,
          advance: (ms: number) => {
            now += ms;
          },
        };
      }

      it("caps the classifier and the answer by what is left of the turn", async () => {
        const { params } = preparePipelineTurn();
        const time = turnClock();
        const deadline = createAiriTurnDeadline({
          budgetMs: 40_000,
          saveReserveMs: 10_000,
          now: time.now,
        });
        mockClassifyAiriChatIntent.mockImplementation(
          async (request: { timeoutBudgetMs?: number }) => {
            expect(request.timeoutBudgetMs).toBe(30_000);
            // Classification and retrieval used 15 s of the turn.
            time.advance(15_000);
            return buildMockIntentClassification("general_answer");
          }
        );
        mockChatCompletionWithFallback.mockResolvedValue({
          content: "Answer",
          provider: "anthropic",
          model: "claude-sonnet",
        });

        await appendAiriChatTurn({ ...params, deadline });

        expect(mockClassifyAiriChatIntent).toHaveBeenCalledTimes(1);
        // The answer gets the 15 s the turn has left, not its own 30 s.
        expect(
          mockChatCompletionWithFallback.mock.calls[0][0].resilience.timeoutMs
        ).toBe(15_000);
      });

      it("gives a full turn's answer its own 30 s limit", async () => {
        const { params } = preparePipelineTurn();
        mockChatCompletionWithFallback.mockResolvedValue({
          content: "Answer",
          provider: "anthropic",
          model: "claude-sonnet",
        });

        await appendAiriChatTurn(params);

        expect(
          mockChatCompletionWithFallback.mock.calls[0][0].resilience.timeoutMs
        ).toBe(30_000);
      });

      it("shortens a draft's own limit to the time the turn has left", async () => {
        const { params } = preparePipelineTurn();
        const time = turnClock();
        const deadline = createAiriTurnDeadline({
          budgetMs: 40_000,
          saveReserveMs: 10_000,
          now: time.now,
        });
        mockClassifyAiriChatIntent.mockImplementation(async () => {
          time.advance(10_000);
          return buildMockIntentClassification("whatsapp_template");
        });
        mockChatCompletionWithFallback.mockResolvedValue({
          content: "{}",
          provider: "anthropic",
          model: "claude-sonnet",
        });

        await appendAiriChatTurn({ ...params, deadline });

        expect(draftCallTimeoutMs("whatsapp_template_draft")).toBe(20_000);
      });

      it("saves the failure reply when no time is left to start the answer", async () => {
        const { params, events } = preparePipelineTurn();
        const time = turnClock();
        const deadline = createAiriTurnDeadline({
          budgetMs: 40_000,
          saveReserveMs: 10_000,
          now: time.now,
        });
        mockClassifyAiriChatIntent.mockImplementation(async () => {
          time.advance(29_500);
          return buildMockIntentClassification("general_answer");
        });

        const result = await appendAiriChatTurn({ ...params, deadline });

        expect(mockChatCompletionWithFallback).not.toHaveBeenCalled();
        expect(result.assistantMessage.metadata).toMatchObject({
          failed: true,
          errorCode: "airi_generation_failed",
          errorClass: "airi_turn_deadline_exceeded",
          intent: "general_answer",
        });
        expect(events).toContainEqual(
          expect.objectContaining({
            type: "stage",
            id: "generation",
            status: "error",
            detail: "airi_turn_deadline_exceeded",
          })
        );
        expect(events.at(-1)).toMatchObject({ type: "done" });
      });
    });
  });

  describe("workspace retrieval race", () => {
    const gateway = () =>
      jest.requireMock("@/lib/ai/gcp-ai-gateway") as {
        canCallGcpAIGateway: jest.Mock;
        getRemoteAskDataContext: jest.Mock;
      };
    const kbArticle = {
      id: "kb-1",
      title: "Delivery policy",
      content: "Orders ship in 2 days.",
      relevance_score: 0.9,
    };

    afterEach(() => {
      gateway().canCallGcpAIGateway.mockReturnValue(false);
      gateway().getRemoteAskDataContext.mockReset();
    });

    it("answers from local search when the gateway exceeds its budget", async () => {
      gateway().canCallGcpAIGateway.mockReturnValue(true);
      gateway().getRemoteAskDataContext.mockImplementation(
        (_request: unknown, options: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            options.signal.addEventListener("abort", () =>
              reject(options.signal.reason)
            );
          })
      );
      mockSearchAskDataContextLocal.mockResolvedValue({
        conversations: [],
        kbArticles: [kbArticle],
      });

      const startedAt = Date.now();
      const retrieval = await searchWorkspaceContextForAiriChat({
        workspaceId: "workspace-1",
        query: "delivery",
        conversationLimit: 5,
        kbLimit: 3,
        gatewayBudgetMs: 50,
      });

      expect(Date.now() - startedAt).toBeLessThan(1_000);
      expect(retrieval.gateway.status).toBe("timeout");
      expect(retrieval.local.status).toBe("complete");
      expect(retrieval.result.kbArticles).toEqual([kbArticle]);
      expect(AIRI_CHAT_GATEWAY_RETRIEVAL_BUDGET_MS).toBeGreaterThanOrEqual(
        2_000
      );
      expect(AIRI_CHAT_GATEWAY_RETRIEVAL_BUDGET_MS).toBeLessThanOrEqual(4_000);
    });

    it("skips the local result when the gateway returns chats and KB", async () => {
      gateway().canCallGcpAIGateway.mockReturnValue(true);
      gateway().getRemoteAskDataContext.mockResolvedValue({
        conversations: [{ id: "c-1", summary: "Late parcel" }],
        kbArticles: [kbArticle],
      });
      let localSignal: AbortSignal | undefined;
      mockSearchAskDataContextLocal.mockImplementation(
        (request: { signal: AbortSignal }) => {
          localSignal = request.signal;
          return new Promise(() => undefined);
        }
      );

      const retrieval = await searchWorkspaceContextForAiriChat({
        workspaceId: "workspace-1",
        query: "delivery",
        conversationLimit: 5,
        kbLimit: 3,
      });

      expect(retrieval.gateway.status).toBe("complete");
      expect(retrieval.result.conversations).toHaveLength(1);
      expect(localSignal?.aborted).toBe(true);
    });

    it("continues without context when local search exceeds its time limit", async () => {
      mockSearchAskDataContextLocal.mockImplementation(
        (request: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            request.signal.addEventListener("abort", () =>
              reject(request.signal.reason)
            );
          })
      );

      const retrieval = await searchWorkspaceContextForAiriChat({
        workspaceId: "workspace-1",
        query: "delivery",
        conversationLimit: 5,
        kbLimit: 3,
        localTimeoutMs: 50,
      });

      expect(retrieval.gateway.status).toBe("skipped");
      expect(retrieval.local.status).toBe("timeout");
      expect(retrieval.result).toMatchObject({
        conversations: [],
        kbArticles: [],
      });
      // Not the same as a workspace that has nothing.
      expect(retrieval.unavailable).toBe(true);
    });

    it("stops waiting for the gateway once local search brings chats and KB", async () => {
      gateway().canCallGcpAIGateway.mockReturnValue(true);
      let gatewaySignal: AbortSignal | undefined;
      gateway().getRemoteAskDataContext.mockImplementation(
        (_request: unknown, options: { signal: AbortSignal }) => {
          gatewaySignal = options.signal;
          return new Promise(() => undefined);
        }
      );
      mockSearchAskDataContextLocal.mockResolvedValue({
        conversations: [{ id: "c-1", summary: "Late parcel" }],
        kbArticles: [kbArticle],
      });

      const startedAt = Date.now();
      const retrieval = await searchWorkspaceContextForAiriChat({
        workspaceId: "workspace-1",
        query: "delivery",
        conversationLimit: 5,
        kbLimit: 3,
      });

      // Well inside the default gateway budget.
      expect(Date.now() - startedAt).toBeLessThan(
        AIRI_CHAT_GATEWAY_RETRIEVAL_BUDGET_MS / 2
      );
      expect(retrieval.gateway.status).toBe("cancelled");
      expect(gatewaySignal?.aborted).toBe(true);
      expect(retrieval.local.status).toBe("complete");
      expect(retrieval.unavailable).toBe(false);
      expect(retrieval.result.conversations).toHaveLength(1);
      expect(retrieval.result.kbArticles).toEqual([kbArticle]);
    });

    it("still waits for the gateway when local search answers without KB", async () => {
      gateway().canCallGcpAIGateway.mockReturnValue(true);
      gateway().getRemoteAskDataContext.mockImplementation(
        () =>
          new Promise(resolve =>
            setTimeout(
              () => resolve({ conversations: [], kbArticles: [kbArticle] }),
              20
            )
          )
      );
      mockSearchAskDataContextLocal.mockResolvedValue({
        conversations: [{ id: "c-1", summary: "Late parcel" }],
        kbArticles: [],
      });

      const retrieval = await searchWorkspaceContextForAiriChat({
        workspaceId: "workspace-1",
        query: "delivery",
        conversationLimit: 5,
        kbLimit: 3,
      });

      expect(retrieval.gateway.status).toBe("complete");
      expect(retrieval.result.conversations).toHaveLength(1);
      expect(retrieval.result.kbArticles).toEqual([kbArticle]);
    });

    it("still fails the turn when local search errors and no gateway answered", async () => {
      const error = new Error("Mongo unavailable");
      mockSearchAskDataContextLocal.mockRejectedValue(error);
      await expect(
        searchWorkspaceContextForAiriChat({
          workspaceId: "workspace-1",
          query: "delivery",
          conversationLimit: 5,
          kbLimit: 3,
        })
      ).rejects.toBe(error);
    });
  });
});

describe("generateAiriChatTitle", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("does not start generation for a cancelled title request", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      generateAiriChatTitle({
        workspaceId: "workspace-1",
        threadId: "thread-1",
        userMessage: "Campaign summary",
        assistantMessage: "Partial report",
        signal: controller.signal,
      })
    ).resolves.toBe("Campaign summary");
    expect(mockChatCompletionWithFallback).not.toHaveBeenCalled();
  });

  it("passes cancellation to an in-flight title generation", async () => {
    const controller = new AbortController();
    mockChatCompletionWithFallback.mockImplementationOnce(async () => {
      controller.abort();
      throw controller.signal.reason;
    });
    await expect(
      generateAiriChatTitle({
        workspaceId: "workspace-1",
        threadId: "thread-1",
        userMessage: "Campaign summary",
        assistantMessage: "Partial report",
        signal: controller.signal,
      })
    ).resolves.toBe("Campaign summary");
    expect(mockChatCompletionWithFallback.mock.calls[0][0].signal).toBe(
      controller.signal
    );
  });

  it("uses the light model to generate a short clean chat title", async () => {
    mockChatCompletionWithFallback.mockResolvedValue({
      content: '"Pricing Questions"',
      model: "gemini-light",
      provider: "vertex",
    });

    await expect(
      generateAiriChatTitle({
        workspaceId: "workspace-1",
        threadId: "thread-1",
        userMessage: "Can you check whether our pricing answer is good?",
        assistantMessage: "The pricing answer should mention the Pro plan.",
      })
    ).resolves.toBe("Pricing Questions");

    expect(mockChatCompletionWithFallback).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "light-text-model",
        temperature: 0.2,
        analytics: expect.objectContaining({
          operation: "airi_chat.title",
        }),
      })
    );
  });

  it.each([
    ["**Pricing Questions**", "Pricing Questions"],
    ["Title: Pricing Questions", "Pricing Questions"],
    ["**Title:** Pricing Questions", "Pricing Questions"],
    ["# Pricing Questions", "Pricing Questions"],
  ])(
    "strips markdown and an echoed title label from %j",
    async (content, expected) => {
      mockChatCompletionWithFallback.mockResolvedValue({
        content,
        model: "light-text-model",
        provider: "anthropic",
      });

      await expect(
        generateAiriChatTitle({
          workspaceId: "workspace-1",
          threadId: "thread-1",
          userMessage: "Can you check whether our pricing answer is good?",
          assistantMessage: "The pricing answer should mention the Pro plan.",
        })
      ).resolves.toBe(expected);
    }
  );

  it("falls back to the first user message when title generation fails", async () => {
    mockChatCompletionWithFallback.mockRejectedValue(new Error("LLM failed"));

    await expect(
      generateAiriChatTitle({
        workspaceId: "workspace-1",
        threadId: "thread-1",
        userMessage: "Plan Instagram content for my product launch",
        assistantMessage: "Here is a plan.",
      })
    ).resolves.toBe("Plan Instagram content for my product launch");
  });
});
