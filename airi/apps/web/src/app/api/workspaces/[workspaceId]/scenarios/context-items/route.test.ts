const mockRequireScenarioWorkspaceAccess = jest.fn();
const mockGetCompanyIdForWorkspace = jest.fn();
const mockConnectDB = jest.fn();
const mockConversationFind = jest.fn();
const mockAnswerSnippetFind = jest.fn();
const mockEnsureAnswerSnippetIndexes = jest.fn();
const mockQuickReplyFind = jest.fn();

jest.mock("@/lib/supabase/workspace-api-access", () => ({
  ...jest.requireActual("@/lib/supabase/workspace-api-access"),
  requireWorkspaceApiAccess: (...args: unknown[]) =>
    mockRequireScenarioWorkspaceAccess(...args),
}));

jest.mock("@/lib/supabase/company-users", () => ({
  getCompanyIdForWorkspace: (...args: unknown[]) =>
    mockGetCompanyIdForWorkspace(...args),
}));

jest.mock("@/lib/mongoose", () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockConnectDB(...args),
}));

jest.mock("@/models/conversation", () => ({
  Conversation: {
    find: (...args: unknown[]) => mockConversationFind(...args),
  },
}));

jest.mock("@/models/answer-snippet", () => ({
  __esModule: true,
  default: {
    find: (...args: unknown[]) => mockAnswerSnippetFind(...args),
  },
  ensureAnswerSnippetIndexes: (...args: unknown[]) =>
    mockEnsureAnswerSnippetIndexes(...args),
}));

jest.mock("@/models/quick-reply", () => ({
  QuickReply: {
    find: (...args: unknown[]) => mockQuickReplyFind(...args),
  },
}));

import {
  buildCurrentConversationClassificationFilter,
  CONVERSATION_CLASSIFICATION_FRESHNESS_SELECT_PATHS,
} from "@icecore/shared/lib/conversation-classification-freshness";

import { GET } from "./route";

const conversationSelects: jest.Mock[] = [];
let conversationRows: unknown[] = [];

function createQuery(rows: unknown[], selectSink?: jest.Mock[]) {
  const query = {
    sort: jest.fn(),
    limit: jest.fn(),
    select: jest.fn(),
    lean: jest.fn(),
  };
  query.sort.mockReturnValue(query);
  query.limit.mockReturnValue(query);
  query.select.mockReturnValue(query);
  query.lean.mockResolvedValue(rows);
  selectSink?.push(query.select);
  return query;
}

function currentConversation(overrides: Record<string, unknown> = {}) {
  return {
    _id: "conversation-current",
    channel: "whatsapp",
    chat: "77000000002",
    classification: { category: "active" },
    is_classified: true,
    classification_revision: 9,
    classification_state: {
      contractVersion: 2,
      status: "ready",
      requestedRevision: 9,
      appliedRevision: 9,
    },
    classification_meta: {
      source_revision: 9,
      provenance_kind: "v2",
      analysis_revision_id: "analysis-current",
    },
    lastMessageAt: new Date("2026-08-10T12:00:00.000Z"),
    updatedAt: new Date("2026-08-10T12:00:00.000Z"),
    ...overrides,
  };
}

function requestFor(contextOptionId: string) {
  return {
    nextUrl: new URL(
      `http://localhost/api/workspaces/workspace-1/scenarios/context-items?contextOptionId=${contextOptionId}`
    ),
  } as never;
}

function expectCanonicalSelect(select: jest.Mock) {
  const selected = String(select.mock.calls[0]?.[0] || "")
    .split(/\s+/u)
    .filter(Boolean);
  for (const path of CONVERSATION_CLASSIFICATION_FRESHNESS_SELECT_PATHS) {
    expect(selected.filter(value => value === path)).toHaveLength(1);
  }
}

describe("GET /api/workspaces/[workspaceId]/scenarios/context-items", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    conversationSelects.length = 0;
    conversationRows = [];
    mockRequireScenarioWorkspaceAccess.mockResolvedValue({
      ok: true,
      supabase: {},
    });
    mockGetCompanyIdForWorkspace.mockResolvedValue(null);
    mockConnectDB.mockResolvedValue(undefined);
    mockConversationFind.mockImplementation(() =>
      createQuery(conversationRows, conversationSelects)
    );
    mockAnswerSnippetFind.mockImplementation(() => createQuery([]));
    mockQuickReplyFind.mockImplementation(() => createQuery([]));
    mockEnsureAnswerSnippetIndexes.mockResolvedValue(undefined);
  });

  it("omits stale timeline category while retaining history summary", async () => {
    conversationRows = [
      currentConversation({
        _id: "conversation-stale",
        classification: { category: "stale-pricing" },
        is_classified: false,
        history_summary: "Asked about an existing order.",
      }),
    ];

    const response = await GET(requestFor("conversation_timeline"), {
      params: Promise.resolve({ workspaceId: "workspace-1" }),
    });

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.items).toEqual([
      expect.objectContaining({
        id: "conversation-stale",
        description: "Asked about an existing order.",
        meta: "conversation",
      }),
    ]);
    expect(JSON.stringify(payload)).not.toContain("stale-pricing");
    expectCanonicalSelect(conversationSelects[0]);
  });

  it("omits stale profile category while retaining a manual stage label", async () => {
    conversationRows = [
      currentConversation({
        _id: "profile-stale",
        classification: { category: "stale-churn" },
        is_classified: false,
        internal_labels: ["stage:active"],
        preferred_language: "en",
      }),
    ];

    const response = await GET(requestFor("customer_profile"), {
      params: Promise.resolve({ workspaceId: "workspace-1" }),
    });

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.items).toEqual([
      expect.objectContaining({
        id: "profile-stale",
        description: "Lang: en | Stage: stage:active",
        meta: "profile",
      }),
    ]);
    expect(JSON.stringify(payload)).not.toContain("stale-churn");
    expectCanonicalSelect(conversationSelects[0]);
  });

  it("keeps manual active labels independent and gates only the category branch", async () => {
    conversationRows = [
      currentConversation({
        _id: "manual-active",
        classification: { category: "stale-category" },
        is_classified: false,
        internal_labels: ["stage:active"],
      }),
      currentConversation({ _id: "current-category-active" }),
    ];

    const response = await GET(requestFor("active_subscriptions"), {
      params: Promise.resolve({ workspaceId: "workspace-1" }),
    });

    expect(response.status).toBe(200);
    expect(mockConversationFind).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      $or: [
        {
          internal_labels: {
            $in: ["stage:active", "subscription:active"],
          },
        },
        {
          $and: [
            { "classification.category": "active" },
            buildCurrentConversationClassificationFilter(),
          ],
        },
      ],
    });
    const payload = await response.json();
    expect(payload.items).toEqual([
      expect.objectContaining({
        id: "manual-active",
        description: "Subscription stage: stage:active",
      }),
      expect.objectContaining({
        id: "current-category-active",
        description: "Subscription stage: active",
      }),
    ]);
    expect(JSON.stringify(payload)).not.toContain("stale-category");
    expectCanonicalSelect(conversationSelects[0]);
  });
});
