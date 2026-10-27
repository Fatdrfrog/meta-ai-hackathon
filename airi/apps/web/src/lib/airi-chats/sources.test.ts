const mockConnectDB = jest.fn();
const mockSearchAskDataContextLocal = jest.fn();
const mockRetrieveWorkspaceIndexedUrlSources = jest.fn();
const mockGetEffectiveKBArticleContent = jest.fn();
const mockGetCompanyIdForWorkspace = jest.fn();
const mockConversationFindOne = jest.fn();

jest.mock("@/lib/mongoose", () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockConnectDB(...args),
}));

jest.mock("@/lib/ai/ask-data-search-local", () => ({
  searchAskDataContextLocal: (...args: unknown[]) =>
    mockSearchAskDataContextLocal(...args),
}));

jest.mock("@/lib/airi/rag/workspace-knowledge", () => ({
  retrieveWorkspaceIndexedUrlSources: (...args: unknown[]) =>
    mockRetrieveWorkspaceIndexedUrlSources(...args),
}));

jest.mock("@/lib/kb/article-content", () => ({
  getEffectiveKBArticleContent: (...args: unknown[]) =>
    mockGetEffectiveKBArticleContent(...args),
}));

jest.mock("@/lib/supabase/company-users", () => ({
  getCompanyIdForWorkspace: (...args: unknown[]) =>
    mockGetCompanyIdForWorkspace(...args),
}));

jest.mock("@/models/answer-snippet", () => ({
  __esModule: true,
  default: { find: jest.fn(), findOne: jest.fn() },
}));

jest.mock("@/models/airi-chat-message", () => ({
  AiriChatMessage: { find: jest.fn() },
}));

jest.mock("@/models/airi-chat-thread", () => ({
  AiriChatThread: { find: jest.fn(), findOne: jest.fn() },
}));

jest.mock("@/models/conversation", () => ({
  Conversation: {
    findOne: (...args: unknown[]) => mockConversationFindOne(...args),
  },
}));

jest.mock("@/models/quick-reply", () => ({
  QuickReply: { find: jest.fn(), findOne: jest.fn() },
}));

jest.mock("@/models/whatsapp-template", () => ({
  WhatsAppTemplateModel: { find: jest.fn() },
}));

import {
  buildAiriChatCatalogOptions,
  buildSelectedAiriChatGroundingContext,
  filterAvailableAiriChatChannelSources,
  filterAvailableAiriChatIntegrationSources,
} from "./sources";
import { AiriChatSelectedSourceError } from "./errors";
import { CONVERSATION_CLASSIFICATION_FRESHNESS_SELECT_PATHS } from "@icecore/shared/lib/conversation-classification-freshness";

function buildSourcesSupabase(rows: Array<Record<string, unknown>>) {
  const query = {
    select: jest.fn(),
    eq: jest.fn(),
    in: jest.fn(),
  };
  query.select.mockReturnValue(query);
  query.eq.mockReturnValue(query);
  query.in.mockResolvedValue({ data: rows, error: null });
  return { supabase: { from: jest.fn(() => query) }, query };
}

it("stops before the channel search after cancellation", async () => {
  const controller = new AbortController();
  mockConnectDB.mockResolvedValue(undefined);
  mockGetCompanyIdForWorkspace.mockReset();
  mockSearchAskDataContextLocal.mockReset();
  mockSearchAskDataContextLocal.mockImplementationOnce(async () => {
    controller.abort();
    return { conversations: [], kbArticles: [] };
  });
  const { supabase } = buildSourcesSupabase([
    { id: "channel-1", type: "telegram", name: "Support bot" },
  ]);
  await expect(
    buildSelectedAiriChatGroundingContext({
      supabase: supabase as never,
      workspaceId: "workspace",
      query: "request",
      signal: controller.signal,
      selectedSources: [
        {
          kind: "context",
          optionId: "knowledge_base_articles",
          label: "Knowledge",
        },
        {
          kind: "channel_source",
          sourceId: "channel-1",
          sourceType: "telegram",
          label: "Support bot",
        },
      ],
    })
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(mockSearchAskDataContextLocal).toHaveBeenCalledTimes(1);
  expect(mockSearchAskDataContextLocal).toHaveBeenCalledWith(
    expect.objectContaining({ signal: controller.signal })
  );
  // The company id is only needed for indexed-URL items.
  expect(mockGetCompanyIdForWorkspace).not.toHaveBeenCalled();
});

describe("selected source resolution", () => {
  beforeEach(() => {
    mockConnectDB.mockResolvedValue(undefined);
    mockGetCompanyIdForWorkspace.mockReset();
    mockSearchAskDataContextLocal.mockReset();
    mockRetrieveWorkspaceIndexedUrlSources.mockReset();
  });

  it("validates every source-backed ref in one query", async () => {
    const { supabase, query } = buildSourcesSupabase([
      { id: "channel-1", type: "telegram", name: "Support bot" },
      { id: "channel-2", type: "instagram", name: "Shop" },
    ]);
    mockSearchAskDataContextLocal.mockResolvedValue({
      conversations: [{ id: "c-1", summary: "Asked about delivery." }],
      kbArticles: [],
    });

    const context = await buildSelectedAiriChatGroundingContext({
      supabase: supabase as never,
      workspaceId: "workspace",
      query: "delivery",
      selectedSources: [
        {
          kind: "channel_source",
          sourceId: "channel-1",
          sourceType: "telegram",
          label: "Support bot",
        },
        {
          kind: "channel_source",
          sourceId: "channel-2",
          sourceType: "instagram",
          label: "Shop",
        },
      ],
    });

    expect(supabase.from).toHaveBeenCalledTimes(1);
    expect(supabase.from).toHaveBeenCalledWith("sources");
    expect(query.eq).toHaveBeenCalledWith("workspace_id", "workspace");
    expect(query.in).toHaveBeenCalledWith("id", ["channel-1", "channel-2"]);
    expect(mockSearchAskDataContextLocal).toHaveBeenCalledWith(
      expect.objectContaining({ sourceIds: ["channel-1", "channel-2"] })
    );
    expect(context?.conversations).toHaveLength(1);
    expect(mockGetCompanyIdForWorkspace).not.toHaveBeenCalled();
  });

  it("rejects an unavailable source before any retrieval starts", async () => {
    const { supabase } = buildSourcesSupabase([
      { id: "channel-1", type: "telegram", name: "Support bot" },
    ]);
    await expect(
      buildSelectedAiriChatGroundingContext({
        supabase: supabase as never,
        workspaceId: "workspace",
        query: "delivery",
        selectedSources: [
          {
            kind: "context",
            optionId: "knowledge_base_articles",
            label: "Knowledge",
          },
          {
            kind: "channel_source",
            sourceId: "missing",
            sourceType: "telegram",
            label: "Old bot",
          },
        ],
      })
    ).rejects.toMatchObject({
      // Typed, so the routes answer 400 without matching message text.
      constructor: AiriChatSelectedSourceError,
      code: "selected_source_unavailable",
      message: "Selected source is unavailable: Old bot",
    });
    expect(mockSearchAskDataContextLocal).not.toHaveBeenCalled();
  });

  it("resolves independent refs concurrently and merges them in selection order", async () => {
    const { supabase } = buildSourcesSupabase([]);
    let releaseKnowledge!: () => void;
    const knowledgeReleased = new Promise<void>(resolve => {
      releaseKnowledge = resolve;
    });
    mockSearchAskDataContextLocal.mockImplementation(
      async (params: { includeKnowledge?: boolean }) => {
        if (params.includeKnowledge === false) {
          return {
            conversations: [{ id: "c-1", summary: "Timeline" }],
            kbArticles: [],
          };
        }
        await knowledgeReleased;
        return {
          conversations: [],
          kbArticles: [
            {
              id: "kb-1",
              title: "Refunds",
              content: "Refunds take 3 days.",
              relevance_score: 0.9,
            },
          ],
        };
      }
    );
    mockRetrieveWorkspaceIndexedUrlSources.mockImplementation(async () => {
      // Started while the knowledge search is still pending.
      releaseKnowledge();
      return [
        {
          id: "url-1",
          title: "Pricing page",
          content: "Prices",
          relevance_score: 0.8,
          source_type: "external_url",
        },
      ];
    });

    const context = await buildSelectedAiriChatGroundingContext({
      supabase: supabase as never,
      workspaceId: "workspace",
      query: "refunds",
      selectedSources: [
        {
          kind: "context",
          optionId: "knowledge_base_articles",
          label: "Knowledge",
        },
        { kind: "context", optionId: "indexed_public_urls", label: "URLs" },
        {
          kind: "context",
          optionId: "conversation_timeline",
          label: "Timeline",
        },
      ],
    });

    expect(context?.kbArticles.map(source => source.id)).toEqual([
      "kb-1",
      "url-1",
    ]);
    expect(context?.conversations.map(item => item.id)).toEqual(["c-1"]);
    // No source-backed refs: no sources query at all.
    expect(supabase.from).not.toHaveBeenCalled();
  });
});

const selectedConversationId = "507f1f77bcf86cd799439011";

function buildCurrentConversation(overrides: Record<string, unknown> = {}) {
  return {
    _id: selectedConversationId,
    classification: {
      category: "classifier-category",
      priority: "classifier-priority",
      summary: "classifier-summary",
    },
    is_classified: true,
    classification_revision: 7,
    classification_state: {
      contractVersion: 2,
      status: "ready",
      requestedRevision: 7,
      appliedRevision: 7,
    },
    classification_meta: {
      source_revision: 7,
      provenance_kind: "v2",
      analysis_revision_id: "analysis-7",
    },
    history_summary: "History summary from the conversation.",
    lastMessageAt: new Date("2026-08-10T12:00:00.000Z"),
    ...overrides,
  };
}

function buildConversationQuery(
  conversation: Record<string, unknown>,
  onSelect: (selection: string) => void
) {
  const query = {
    select: jest.fn(),
    lean: jest.fn(),
  };
  query.select.mockImplementation((selection: string) => {
    onSelect(selection);
    return query;
  });
  query.lean.mockResolvedValue(conversation);
  return query;
}

function expectCanonicalSelect(select: string) {
  const selected = select.split(/\s+/u).filter(Boolean);
  for (const path of CONVERSATION_CLASSIFICATION_FRESHNESS_SELECT_PATHS) {
    expect(selected.filter(value => value === path)).toHaveLength(1);
  }
}

function selectedConversationSource() {
  return {
    kind: "context_item" as const,
    optionId: "conversation_timeline" as const,
    itemId: selectedConversationId,
    label: "Selected conversation",
  };
}

describe("Airi chat source catalog", () => {
  it("filters conversation channel sources and onboarding test widgets", () => {
    const sources = filterAvailableAiriChatChannelSources([
      {
        id: "wa-1",
        type: "whatsapp",
        name: "Main WhatsApp",
        credentials: {},
      },
      {
        id: "ig-1",
        type: "instagram",
        name: "Instagram",
        credentials: {},
      },
      {
        id: "canva-1",
        type: "canva",
        name: "Canva",
        credentials: {},
      },
      {
        id: "widget-test",
        type: "web_widget",
        name: "Onboarding widget",
        credentials: { onboarding_test: true },
      },
    ]);

    expect(sources.map(source => source.id)).toEqual(["wa-1", "ig-1"]);
  });

  it("builds connected source options without context buckets or items", () => {
    const options = buildAiriChatCatalogOptions({
      channelSources: [
        {
          id: "wa-1",
          type: "whatsapp",
          name: "Main WhatsApp",
          credentials: {},
        },
        {
          id: "canva-1",
          type: "canva",
          name: "Canva",
          credentials: {},
        },
      ],
      query: "",
      limit: 10,
    });

    expect(options.map(option => option.id)).toEqual([
      "skill:meta",
      "connector:whatsapp:wa-1",
      "source:canva-1",
      "action:choose_chats",
    ]);
    expect(options.some(option => option.id.startsWith("context:"))).toBe(
      false
    );
    expect(options.some(option => option.id.startsWith("context_item:"))).toBe(
      false
    );
    expect(options[0]).toMatchObject({
      id: "skill:meta",
      group: "Skills",
      label: "meta",
      disabled: true,
    });
    expect(options[1]?.group).toBe("Sources");
  });

  it("prioritizes connected WhatsApp as a connector and exposes chat picker action", () => {
    const options = buildAiriChatCatalogOptions({
      channelSources: [
        {
          id: "wa-1",
          type: "whatsapp",
          name: "Main WhatsApp",
          credentials: {},
        },
        {
          id: "ig-1",
          type: "instagram",
          name: "Instagram",
          credentials: {},
        },
      ],
      query: "",
      limit: 20,
    });

    expect(options.find(option => option.id === "skill:meta")).toMatchObject({
      group: "Skills",
      label: "meta",
      disabled: true,
    });
    expect(
      options.find(option => option.id === "connector:whatsapp:wa-1")
    ).toMatchObject({
      id: "connector:whatsapp:wa-1",
      group: "Sources",
      label: "Main WhatsApp",
      ref: {
        kind: "connector",
        connector: "whatsapp",
        sourceId: "wa-1",
      },
    });
    expect(options.some(option => option.id === "action:choose_chats")).toBe(
      true
    );
    expect(options.some(option => option.id === "channel_source:wa-1")).toBe(
      false
    );
  });

  it("uses provider display names for Postmark and Instagram source labels", () => {
    const options = buildAiriChatCatalogOptions({
      channelSources: [
        {
          id: "email-1",
          type: "email",
          name: "Email",
          credentials: {
            provider: "postmark",
            email_address: "support@example.com",
          },
        },
        {
          id: "ig-1",
          type: "instagram",
          name: "Instagram (678233)",
          credentials: {
            name: "Airi Support",
            username: "airi.chat",
            instagram_business_account_id: "1784140678233",
          },
        },
      ],
      query: "",
      limit: 10,
    });

    expect(options).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "source:email-1",
          label: "Postmark",
          description: "Postmark email support and campaign context",
          ref: expect.objectContaining({ label: "Postmark" }),
        }),
        expect.objectContaining({
          id: "source:ig-1",
          label: "Airi Support",
          description:
            "Instagram conversations and account work for @airi.chat",
          ref: expect.objectContaining({ label: "Airi Support" }),
        }),
      ])
    );
  });

  it("exposes connected provider sources for the @ picker while excluding onboarding tests", () => {
    const sources = filterAvailableAiriChatIntegrationSources([
      {
        id: "canva-1",
        type: "canva",
        name: "Canva",
        credentials: {},
      },
      {
        id: "widget-test",
        type: "web_widget",
        name: "Onboarding widget",
        credentials: { onboarding_test: true },
      },
    ]);

    expect(sources.map(source => source.id)).toEqual(["canva-1"]);
  });
});

describe("selected Airi chat conversation grounding", () => {
  let conversation: ReturnType<typeof buildCurrentConversation>;
  let conversationSelect = "";

  beforeEach(() => {
    jest.clearAllMocks();
    conversation = buildCurrentConversation();
    conversationSelect = "";
    mockConnectDB.mockResolvedValue(undefined);
    mockGetCompanyIdForWorkspace.mockResolvedValue(null);
    mockConversationFindOne.mockImplementation(() =>
      buildConversationQuery(conversation, selection => {
        conversationSelect = selection;
      })
    );
  });

  async function buildContext() {
    return buildSelectedAiriChatGroundingContext({
      supabase: {} as never,
      workspaceId: "workspace-1",
      userId: "user-1",
      query: "What happened?",
      selectedSources: [selectedConversationSource()],
    });
  }

  it("formats exact-current selected classification", async () => {
    const context = await buildContext();

    expect(context?.conversations).toEqual([
      expect.objectContaining({
        id: selectedConversationId,
        category: "classifier-category",
        priority: "classifier-priority",
        summary: "classifier-summary",
      }),
    ]);
    expect(context?.promptSections).toEqual([
      "[Conversation 1] classifier-category (classifier-priority): classifier-summary",
    ]);
    expectCanonicalSelect(conversationSelect);
  });

  it.each([
    {
      name: "revision-mismatch stale",
      overrides: {
        classification_state: {
          contractVersion: 2,
          status: "ready",
          requestedRevision: 8,
          appliedRevision: 7,
        },
      },
    },
    {
      name: "legacy",
      overrides: {
        classification_state: {
          contractVersion: 1,
          status: "ready",
          requestedRevision: 7,
          appliedRevision: 7,
        },
        classification_meta: {
          source_revision: 7,
          provenance_kind: "legacy_unknown",
          analysis_revision_id: "legacy-analysis-7",
        },
      },
    },
    {
      name: "partial",
      overrides: {
        classification_meta: {
          source_revision: 7,
          provenance_kind: "v2",
        },
      },
    },
    {
      name: "malformed",
      overrides: { classification_state: "ready" },
    },
  ])("uses neutral history context for $name classification", async row => {
    conversation = buildCurrentConversation(row.overrides);

    const context = await buildContext();

    expect(context?.conversations[0]).toEqual(
      expect.objectContaining({
        id: selectedConversationId,
        category: undefined,
        priority: undefined,
        summary: "History summary from the conversation.",
      })
    );
    expect(context?.promptSections).toEqual([
      "[Conversation 1]: History summary from the conversation.",
    ]);
    expect(JSON.stringify(context)).not.toContain("classifier-category");
    expect(JSON.stringify(context)).not.toContain("classifier-priority");
    expect(JSON.stringify(context)).not.toContain("classifier-summary");
    expect(JSON.stringify(context)).not.toContain("General");
    expect(JSON.stringify(context)).not.toContain("normal");
    expectCanonicalSelect(conversationSelect);
  });

  it("uses neutral generic context when noncurrent classification has no history", async () => {
    conversation = buildCurrentConversation({
      classification_state: {
        contractVersion: 2,
        status: "ready",
        requestedRevision: 8,
        appliedRevision: 7,
      },
      history_summary: null,
    });

    const context = await buildContext();

    expect(context?.conversations[0]).toEqual(
      expect.objectContaining({
        category: undefined,
        priority: undefined,
        summary: "Conversation context",
      })
    );
    expect(context?.promptSections).toEqual([
      "[Conversation 1]: Conversation context",
    ]);
    expectCanonicalSelect(conversationSelect);
  });
});
