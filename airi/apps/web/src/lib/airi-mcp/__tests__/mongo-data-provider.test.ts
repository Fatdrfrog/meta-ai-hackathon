const mockVisibility = jest.fn();
const mockCount = jest.fn();
const mockAggregate = jest.fn();
const mockConversationFind = jest.fn();
const mockUserFind = jest.fn();
const mockChatFind = jest.fn();
const mockTemplateFind = jest.fn();
const mockListScenarios = jest.fn();

jest.mock("@/lib/mongoose", () => ({ __esModule: true, default: jest.fn() }));
jest.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: {} }));
jest.mock("@/lib/limits/company-limits", () => ({
  getCompanyConversationVisibilityGate: (...args: unknown[]) =>
    mockVisibility(...args),
}));
jest.mock("@/models/conversation", () => ({
  Conversation: {
    countDocuments: (...args: unknown[]) => mockCount(...args),
    aggregate: (...args: unknown[]) => mockAggregate(...args),
    find: (...args: unknown[]) => mockConversationFind(...args),
  },
}));
jest.mock("@/models/user", () => ({
  __esModule: true,
  default: { find: (...args: unknown[]) => mockUserFind(...args) },
}));
jest.mock("@/models/chat", () => ({
  __esModule: true,
  default: { find: (...args: unknown[]) => mockChatFind(...args) },
}));
jest.mock("@/models/whatsapp-template", () => ({
  WhatsAppTemplateModel: {
    find: (...args: unknown[]) => mockTemplateFind(...args),
  },
}));
jest.mock("@/lib/scenarios/list-workspace-scenario-summaries", () => ({
  listWorkspaceScenarioSummaries: (...args: unknown[]) =>
    mockListScenarios(...args),
}));

import { buildCurrentConversationClassificationFilter } from "@icecore/shared/lib/conversation-classification-freshness";
import mongoose from "mongoose";
import {
  AIRI_MCP_QUERY_MAX_TIME_MS,
  createAiriMcpMongoDataProvider,
} from "../mongo-data-provider";
import { WORKSPACE_ID } from "./fixtures";

type Chain = Record<string, jest.Mock>;

function queryChain(rows: unknown): Chain {
  const chain: Chain = {};
  for (const method of ["sort", "skip", "limit", "select", "maxTimeMS"]) {
    chain[method] = jest.fn(() => chain);
  }
  chain.lean = jest.fn(async () => rows);
  return chain;
}

function countQuery(total: number) {
  const query = { maxTimeMS: jest.fn(async () => total) };
  return query;
}

const VISIBLE_ID = "507f1f77bcf86cd799439011";
const LIMITED_GATE = {
  visibleConversationIds: [VISIBLE_ID],
  hiddenConversationCount: 42,
  reason: "conversation_limit",
};
const OPEN_GATE = {
  visibleConversationIds: null,
  hiddenConversationCount: 0,
  reason: null,
};

describe("Airi MCP Mongo data provider", () => {
  const provider = createAiriMcpMongoDataProvider();
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    mockVisibility.mockResolvedValue(OPEN_GATE);
    fetchSpy = jest.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    // Every read is stored data: no Meta Graph (or any HTTP) call.
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  describe("getAnalyticsCounts", () => {
    const currentStart = new Date("2026-10-07T12:00:00.000Z");
    const previousStart = new Date("2026-09-30T12:00:00.000Z");
    let options: jest.Mock;

    beforeEach(() => {
      options = jest.fn();
      mockCount.mockImplementation(() => countQuery(3));
      mockAggregate.mockImplementation(
        (pipeline: Array<Record<string, unknown>>) => ({
          option: (value: unknown) => {
            options(value);
            const group = pipeline.find(stage => stage.$group) as {
              $group: { _id: string };
            };
            if (group.$group._id === "$classification.category") {
              return Promise.resolve(
                Array.from({ length: 21 }, (_, index) => ({
                  category: `C${index}`,
                  count: 21 - index,
                }))
              );
            }
            return Promise.resolve([
              { status: "open", channel: "whatsapp", count: 3 },
            ]);
          },
        })
      );
    });

    it("applies the plan gate to both windows with the v1 pipelines", async () => {
      mockVisibility.mockResolvedValue(LIMITED_GATE);
      const counts = await provider.getAnalyticsCounts({
        workspaceId: WORKSPACE_ID,
        currentStart,
        previousStart,
      });

      expect(mockVisibility).toHaveBeenCalledTimes(1);
      expect(mockVisibility).toHaveBeenCalledWith({}, WORKSPACE_ID);
      const visible = { $in: [new mongoose.Types.ObjectId(VISIBLE_ID)] };
      const currentMatch = {
        workspaceId: WORKSPACE_ID,
        createdAt: { $gte: currentStart },
        _id: visible,
      };
      const previousMatch = {
        workspaceId: WORKSPACE_ID,
        createdAt: { $gte: previousStart, $lt: currentStart },
        _id: visible,
      };
      expect(mockCount.mock.calls).toEqual([[currentMatch], [previousMatch]]);
      const matches = mockAggregate.mock.calls.map(
        (call: unknown[]) => (call[0] as Array<{ $match?: unknown }>)[0]?.$match
      );
      expect(matches).toEqual(
        expect.arrayContaining([
          currentMatch,
          previousMatch,
          {
            ...currentMatch,
            ...buildCurrentConversationClassificationFilter(),
          },
          {
            ...previousMatch,
            ...buildCurrentConversationClassificationFilter(),
          },
        ])
      );
      expect(mockAggregate).toHaveBeenCalledTimes(6);

      for (const query of mockCount.mock.results) {
        expect(query.value.maxTimeMS).toHaveBeenCalledWith(
          AIRI_MCP_QUERY_MAX_TIME_MS
        );
      }
      expect(options).toHaveBeenCalledTimes(6);
      expect(options).toHaveBeenCalledWith({
        maxTimeMS: AIRI_MCP_QUERY_MAX_TIME_MS,
      });

      expect(counts.visibility).toEqual({
        limited: true,
        hiddenConversationCount: 42,
        reason: "conversation_limit",
      });
      expect(counts.current.total).toBe(3);
      expect(counts.current.byStatus).toEqual([{ status: "open", count: 3 }]);
      expect(counts.current.byCategory).toHaveLength(20);
      expect(counts.current.categoriesTruncated).toBe(true);
    });

    it("asks for one category beyond the v1 top 20 to detect truncation", async () => {
      await provider.getAnalyticsCounts({
        workspaceId: WORKSPACE_ID,
        currentStart,
        previousStart,
      });
      const limits = mockAggregate.mock.calls
        .map((call: unknown[]) =>
          (call[0] as Array<{ $limit?: number }>).find(stage => stage.$limit)
        )
        .filter(Boolean);
      expect(limits).toEqual([{ $limit: 21 }, { $limit: 21 }]);
      expect(mockCount.mock.calls[0]?.[0]).not.toHaveProperty("_id");
    });

    it("applies a capped plan's gate without flagging it when nothing is hidden", async () => {
      // Free plans under their cap still get an id list from the gate.
      mockVisibility.mockResolvedValue({
        visibleConversationIds: [VISIBLE_ID],
        hiddenConversationCount: 0,
        reason: null,
      });
      const counts = await provider.getAnalyticsCounts({
        workspaceId: WORKSPACE_ID,
        currentStart,
        previousStart,
      });

      expect(mockCount.mock.calls[0]?.[0]).toMatchObject({
        _id: { $in: [new mongoose.Types.ObjectId(VISIBLE_ID)] },
      });
      expect(counts.visibility).toEqual({
        limited: false,
        hiddenConversationCount: 0,
        reason: null,
      });
    });

    it.each([
      [
        "a trial that expired",
        { visibleConversationIds: [], hiddenConversationCount: 0 },
        "trial_expired",
      ],
      [
        "hidden conversations",
        { visibleConversationIds: [VISIBLE_ID], hiddenConversationCount: 3 },
        null,
      ],
    ] as const)(
      "flags plan visibility for %s",
      async (_label, gate, reason) => {
        mockVisibility.mockResolvedValue({ ...gate, reason });
        const counts = await provider.getAnalyticsCounts({
          workspaceId: WORKSPACE_ID,
          currentStart,
          previousStart,
        });
        expect(counts.visibility.limited).toBe(true);
      }
    );

    it("reads nothing when plan visibility cannot be resolved", async () => {
      mockVisibility.mockRejectedValue(new Error("plan lookup down"));
      await expect(
        provider.getAnalyticsCounts({
          workspaceId: WORKSPACE_ID,
          currentStart,
          previousStart,
        })
      ).rejects.toThrow("plan lookup down");
      expect(mockCount).not.toHaveBeenCalled();
      expect(mockAggregate).not.toHaveBeenCalled();
    });
  });

  describe("listConversations", () => {
    it("pages within the gate and resolves names without staff emails", async () => {
      mockVisibility.mockResolvedValue(LIMITED_GATE);
      const conversations = [
        {
          _id: "a",
          channel: "whatsapp",
          user: "wa_77011234567",
          chat: "wa_77011234567",
        },
        { _id: "b", channel: "telegram", user: 123456, chat: 123456 },
        {
          _id: "c",
          channel: "web_widget",
          user: { _id: "inline", firstName: "Inline" },
        },
      ];
      const conversationQuery = queryChain(conversations);
      mockConversationFind.mockReturnValue(conversationQuery);
      const userQuery = queryChain([
        { _id: "wa_77011234567", firstName: "Aigerim" },
        { _id: 123456, firstName: "Daniyar" },
      ]);
      mockUserFind.mockReturnValue(userQuery);
      const chatQuery = queryChain([{ _id: 123456, title: "Daniyar chat" }]);
      mockChatFind.mockReturnValue(chatQuery);

      const page = await provider.listConversations({
        workspaceId: WORKSPACE_ID,
        limit: 2,
        offset: 40,
        status: "open",
        channel: "whatsapp",
      });

      expect(mockConversationFind).toHaveBeenCalledWith({
        workspaceId: WORKSPACE_ID,
        _id: { $in: [new mongoose.Types.ObjectId(VISIBLE_ID)] },
        status: "open",
        channel: "whatsapp",
      });
      expect(conversationQuery.sort).toHaveBeenCalledWith({
        lastMessageAt: -1,
      });
      expect(conversationQuery.skip).toHaveBeenCalledWith(40);
      expect(conversationQuery.limit).toHaveBeenCalledWith(3);
      expect(conversationQuery.maxTimeMS).toHaveBeenCalledWith(
        AIRI_MCP_QUERY_MAX_TIME_MS
      );
      const selected = String(
        conversationQuery.select.mock.calls[0]?.[0]
      ).split(/\s+/u);
      expect(selected).toEqual(
        expect.arrayContaining([
          "rename",
          "subject",
          "classification.summary",
          "classification_state.status",
        ])
      );
      expect(selected).not.toContain("messages");

      // Mixed ids keep their stored type, as in the customers service.
      expect(mockUserFind).toHaveBeenCalledWith({
        _id: { $in: ["wa_77011234567", 123456] },
      });
      expect(String(userQuery.select.mock.calls[0]?.[0])).not.toContain(
        "email"
      );
      expect(userQuery.maxTimeMS).toHaveBeenCalledWith(
        AIRI_MCP_QUERY_MAX_TIME_MS
      );
      expect(chatQuery.maxTimeMS).toHaveBeenCalledWith(
        AIRI_MCP_QUERY_MAX_TIME_MS
      );

      expect(page.hasMore).toBe(true);
      expect(page.visibility.limited).toBe(true);
      expect(page.rows).toHaveLength(2);
      expect(page.rows[0]?.user).toMatchObject({ firstName: "Aigerim" });
      expect(page.rows[1]).toMatchObject({
        user: { firstName: "Daniyar" },
        chat: { title: "Daniyar chat" },
      });
    });

    it("uses inline profiles without a lookup and reports the last page", async () => {
      mockConversationFind.mockReturnValue(
        queryChain([{ _id: "c", user: { _id: "inline", firstName: "Inline" } }])
      );
      const page = await provider.listConversations({
        workspaceId: WORKSPACE_ID,
        limit: 5,
        offset: 0,
      });
      expect(mockConversationFind).toHaveBeenCalledWith({
        workspaceId: WORKSPACE_ID,
      });
      expect(mockUserFind).not.toHaveBeenCalled();
      expect(mockChatFind).not.toHaveBeenCalled();
      expect(page.hasMore).toBe(false);
      expect(page.rows[0]?.user).toEqual({
        _id: "inline",
        firstName: "Inline",
      });
    });
  });

  describe("listWhatsAppTemplates", () => {
    it("reads the stored snapshot only, bounded and workspace-scoped", async () => {
      const query = queryChain([{ name: "a" }, { name: "b" }, { name: "c" }]);
      mockTemplateFind.mockReturnValue(query);
      const result = await provider.listWhatsAppTemplates({
        workspaceId: WORKSPACE_ID,
        limit: 2,
        status: "REJECTED",
      });

      expect(mockTemplateFind).toHaveBeenCalledWith({
        workspaceId: WORKSPACE_ID,
        status: "REJECTED",
      });
      expect(query.sort).toHaveBeenCalledWith({ name: 1, language: 1 });
      expect(query.limit).toHaveBeenCalledWith(3);
      expect(query.maxTimeMS).toHaveBeenCalledWith(AIRI_MCP_QUERY_MAX_TIME_MS);
      expect(result).toEqual({
        rows: [{ name: "a" }, { name: "b" }],
        hasMore: true,
      });
      expect(mockVisibility).not.toHaveBeenCalled();
    });
  });

  describe("listScenarios", () => {
    it("reuses the scenario list with a status filter and a time limit", async () => {
      mockListScenarios.mockResolvedValue({
        items: [],
        hasMore: false,
        nextCursor: null,
      });
      await provider.listScenarios({
        workspaceId: WORKSPACE_ID,
        status: "inactive",
        limit: 25,
        cursor: "abc",
      });
      expect(mockListScenarios).toHaveBeenCalledWith({
        workspaceId: WORKSPACE_ID,
        mode: "all",
        status: "inactive",
        limit: 25,
        cursor: "abc",
        maxTimeMS: AIRI_MCP_QUERY_MAX_TIME_MS,
      });
    });
  });
});
