const mockGetPublicKBWorkspaceIds = jest.fn();
const mockRetrieveWorkspaceKbArticleSources = jest.fn();
const mockLoggerError = jest.fn();

jest.mock("@/lib/kb/public-kb", () => ({
  getPublicKBWorkspaceIds: (...args: unknown[]) =>
    mockGetPublicKBWorkspaceIds(...args),
}));

jest.mock("@/lib/airi/rag/workspace-knowledge", () => ({
  retrieveWorkspaceKbArticleSources: (...args: unknown[]) =>
    mockRetrieveWorkspaceKbArticleSources(...args),
}));

jest.mock("@/lib/logger", () => ({
  logger: {
    error: (...args: unknown[]) => mockLoggerError(...args),
  },
}));

import {
  AIRI_PRODUCT_KB_COMPANY_SLUG,
  formatAiriProductKbPromptContext,
  retrieveAiriProductKbArticles,
} from "./product-knowledge";

describe("retrieveAiriProductKbArticles", () => {
  it("propagates cancellation instead of an empty product KB fallback", async () => {
    const controller = new AbortController();
    mockGetPublicKBWorkspaceIds.mockImplementationOnce(async () => {
      controller.abort();
      throw controller.signal.reason;
    });
    await expect(
      retrieveAiriProductKbArticles({
        query: "How to connect?",
        signal: controller.signal,
      })
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(mockLoggerError).not.toHaveBeenCalled();
  });
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetPublicKBWorkspaceIds.mockReset();
    mockRetrieveWorkspaceKbArticleSources.mockReset();
    mockLoggerError.mockReset();
  });

  it("returns an empty list for a short query", async () => {
    await expect(
      retrieveAiriProductKbArticles({ query: " " })
    ).resolves.toEqual([]);
    expect(mockGetPublicKBWorkspaceIds).not.toHaveBeenCalled();
  });

  it("retrieves published kb_article sources from airichat public workspaces", async () => {
    mockGetPublicKBWorkspaceIds.mockResolvedValue(["airi-ws-1"]);
    mockRetrieveWorkspaceKbArticleSources.mockResolvedValue([
      {
        id: "article-1",
        title: "Connect WhatsApp",
        content: "Open Settings > Messengers and start Embedded Signup.",
        relevance_score: 0.88,
        source_type: "article",
        url: "https://www.airi.chat/airichat/kb/article-1",
      },
    ]);

    await expect(
      retrieveAiriProductKbArticles({
        query: "как подключить WhatsApp",
        locale: "ru",
      })
    ).resolves.toEqual([
      {
        id: "article-1",
        title: "Connect WhatsApp",
        content: "Open Settings > Messengers and start Embedded Signup.",
        url: "https://www.airi.chat/airichat/kb/article-1",
        relevanceScore: 0.88,
        workspaceId: "airi-ws-1",
      },
    ]);

    expect(mockGetPublicKBWorkspaceIds).toHaveBeenCalledWith(
      AIRI_PRODUCT_KB_COMPANY_SLUG
    );
    expect(mockRetrieveWorkspaceKbArticleSources).toHaveBeenCalledWith({
      workspaceId: "airi-ws-1",
      query: "как подключить WhatsApp",
      locale: "ru",
      limit: 3,
      threshold: 0.62,
      includeFullContent: true,
      matchAllowedVisibilities: ["public"],
    });
  });

  it("dedupes and ranks articles across public workspaces", async () => {
    mockGetPublicKBWorkspaceIds.mockResolvedValue(["airi-ws-1", "airi-ws-2"]);
    mockRetrieveWorkspaceKbArticleSources
      .mockResolvedValueOnce([
        {
          id: "article-shared",
          title: "WhatsApp",
          content: "Older hit",
          relevance_score: 0.7,
        },
      ])
      .mockResolvedValueOnce([
        {
          id: "article-shared",
          title: "WhatsApp",
          content: "Older hit",
          relevance_score: 0.9,
        },
        {
          id: "article-2",
          title: "Telegram",
          content: "Connect Telegram",
          relevance_score: 0.81,
          url: "https://www.airi.chat/airichat/kb/article-2",
        },
      ]);

    await expect(
      retrieveAiriProductKbArticles({ query: "connect channels" })
    ).resolves.toEqual([
      {
        id: "article-shared",
        title: "WhatsApp",
        content: "Older hit",
        url: null,
        relevanceScore: 0.9,
        workspaceId: "airi-ws-2",
      },
      {
        id: "article-2",
        title: "Telegram",
        content: "Connect Telegram",
        url: "https://www.airi.chat/airichat/kb/article-2",
        relevanceScore: 0.81,
        workspaceId: "airi-ws-2",
      },
    ]);
  });

  it("returns an empty list when public workspace lookup fails", async () => {
    mockGetPublicKBWorkspaceIds.mockRejectedValue(new Error("supabase down"));

    await expect(
      retrieveAiriProductKbArticles({ query: "connect WhatsApp" })
    ).resolves.toEqual([]);
    expect(mockRetrieveWorkspaceKbArticleSources).not.toHaveBeenCalled();
    expect(mockLoggerError).toHaveBeenCalled();
  });
});

describe("formatAiriProductKbPromptContext", () => {
  it("labels published product KB and forbids invention when empty", () => {
    const context = formatAiriProductKbPromptContext([]);
    expect(context).toContain("PUBLISHED AIRI.CHAT PRODUCT KB");
    expect(context).toContain("Do not invent");
    expect(context).toContain("support@airi.chat");
  });

  it("formats retrieved published articles", () => {
    const context = formatAiriProductKbPromptContext([
      {
        id: "article-1",
        title: "Connect WhatsApp",
        content: "Start Embedded Signup from Messengers.",
        url: "https://www.airi.chat/airichat/kb/article-1",
        relevanceScore: 0.91,
        workspaceId: "airi-ws-1",
      },
    ]);

    expect(context).toContain('### Product KB 1: "Connect WhatsApp"');
    expect(context).toContain(
      "URL: https://www.airi.chat/airichat/kb/article-1"
    );
    expect(context).toContain("Embedded Signup");
    expect(context).toContain("unpublished Airi conversations");
  });
});
