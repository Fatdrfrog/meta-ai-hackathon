const mockAuthenticate = jest.fn();
const mockFind = jest.fn();
const mockSelect = jest.fn();
const mockRows = jest.fn();
const mockCount = jest.fn();
const mockAggregate = jest.fn();
const mockVisibility = jest.fn();

jest.mock("@/lib/api-auth", () => ({
  authenticateRequest: (...args: unknown[]) => mockAuthenticate(...args),
  hasPermission: (
    key: { permissions: Record<string, boolean> },
    permission: string
  ) => key.permissions[permission] === true,
}));
jest.mock("@/lib/mongoose", () => ({ __esModule: true, default: jest.fn() }));
jest.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: {} }));
jest.mock("@/lib/limits/company-limits", () => ({
  getCompanyConversationVisibilityGate: (...args: unknown[]) =>
    mockVisibility(...args),
}));
jest.mock("@/models/conversation", () => ({
  Conversation: {
    find: (...args: unknown[]) => {
      mockFind(...args);
      const query = {
        sort: () => query,
        skip: () => query,
        limit: () => query,
        select: (...fields: unknown[]) => {
          mockSelect(...fields);
          return query;
        },
        lean: () => mockRows(),
      };
      return query;
    },
    countDocuments: (...args: unknown[]) => mockCount(...args),
    aggregate: (...args: unknown[]) => mockAggregate(...args),
  },
}));

import mongoose from "mongoose";
import {
  buildCurrentConversationClassificationFilter,
  CONVERSATION_CLASSIFICATION_FRESHNESS_SELECT_PATHS,
} from "@icecore/shared/lib/conversation-classification-freshness";
import { GET as getConversations } from "./conversations/route";
import { GET as getAnalytics } from "./analytics/route";

function currentConversation(overrides: Record<string, unknown> = {}) {
  return {
    _id: "507f1f77bcf86cd799439011",
    status: "open",
    channel: "whatsapp",
    createdAt: new Date("2026-10-01T12:00:00.000Z"),
    updatedAt: new Date("2026-10-02T12:00:00.000Z"),
    lastMessageAt: new Date("2026-10-02T12:00:00.000Z"),
    user: "507f1f77bcf86cd799439012",
    chat: "507f1f77bcf86cd799439013",
    classification: { category: "Sales", summary: "Current summary" },
    is_classified: true,
    classification_revision: 9,
    classification_state: {
      contractVersion: 2,
      status: "ready",
      requestedRevision: 9,
      appliedRevision: 9,
      lease: { ownerToken: "private-owner-token" },
    },
    classification_meta: {
      source_revision: 9,
      provenance_kind: "v2",
      analysis_revision_id: "analysis-current",
    },
    ...overrides,
  };
}

describe("customer API classification freshness", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAuthenticate.mockResolvedValue({
      apiKey: { workspace_id: "workspace-1", permissions: { read: true } },
      error: null,
    });
    mockVisibility.mockResolvedValue({ visibleConversationIds: null });
    mockRows.mockResolvedValue([]);
    mockCount.mockResolvedValue(0);
    mockAggregate.mockResolvedValue([]);
  });

  it("returns matching current classification with safe freshness metadata and existing pagination", async () => {
    mockRows.mockResolvedValue([currentConversation()]);
    mockCount.mockResolvedValue(1);

    const response = await getConversations(
      new Request("https://airi.chat/api/v1/conversations")
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toEqual({
      data: [
        {
          _id: "507f1f77bcf86cd799439011",
          status: "open",
          channel: "whatsapp",
          createdAt: "2026-10-01T12:00:00.000Z",
          updatedAt: "2026-10-02T12:00:00.000Z",
          lastMessageAt: "2026-10-02T12:00:00.000Z",
          user: "507f1f77bcf86cd799439012",
          chat: "507f1f77bcf86cd799439013",
          classification: { category: "Sales", summary: "Current summary" },
          classification_is_current: true,
        },
      ],
      pagination: { page: 1, limit: 20, total: 1, pages: 1 },
    });
    expect(JSON.stringify(payload)).not.toContain("private-owner-token");
    const selected = String(mockSelect.mock.calls[0]?.[0]).split(/\s+/u);
    for (const path of CONVERSATION_CLASSIFICATION_FRESHNESS_SELECT_PATHS) {
      expect(selected).toContain(path);
    }
  });

  it.each([
    [
      "pending",
      {
        is_classified: false,
        classification_state: {
          contractVersion: 2,
          status: "pending",
          requestedRevision: 9,
          appliedRevision: 8,
        },
      },
    ],
    [
      "blocked",
      {
        is_classified: false,
        classification_state: {
          contractVersion: 2,
          status: "blocked",
          requestedRevision: 9,
          appliedRevision: 8,
        },
      },
    ],
    ["newer input revision", { classification_revision: 10 }],
    [
      "older applied revision",
      {
        classification_state: {
          contractVersion: 2,
          status: "ready",
          requestedRevision: 9,
          appliedRevision: 8,
        },
      },
    ],
    [
      "older source revision",
      {
        classification_meta: {
          source_revision: 8,
          provenance_kind: "v2",
          analysis_revision_id: "analysis-old",
        },
      },
    ],
    [
      "legacy provenance",
      {
        classification_meta: {
          source_revision: 9,
          provenance_kind: "legacy_unknown",
          analysis_revision_id: "legacy-analysis",
        },
      },
    ],
    ["unclassified", { is_classified: false, classification: undefined }],
  ])(
    "returns null instead of stale classification for %s",
    async (_name, overrides) => {
      mockRows.mockResolvedValue([
        currentConversation(overrides as Record<string, unknown>),
      ]);

      const response = await getConversations(
        new Request("https://airi.chat/api/v1/conversations")
      );
      const payload = await response.json();

      expect(response.status).toBe(200);
      expect(payload.data).toHaveLength(1);
      expect(payload.data[0]).toMatchObject({
        classification: null,
        classification_is_current: false,
      });
      expect(JSON.stringify(payload)).not.toContain("Current summary");
      expect(payload.data[0]).not.toHaveProperty("classification_state");
      expect(payload.data[0]).not.toHaveProperty("classification_meta");
      expect(payload.data[0]).not.toHaveProperty("classification_revision");
      expect(payload.data[0]).not.toHaveProperty("is_classified");
    }
  );

  it("requires current classification for category counts while retaining workspace, date and visibility gates", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-10-07T12:00:00.000Z"));
    const visibleId = new mongoose.Types.ObjectId("507f1f77bcf86cd799439011");
    mockVisibility.mockResolvedValue({
      visibleConversationIds: [String(visibleId)],
    });
    mockAggregate.mockResolvedValue([{ category: "Sales", count: 1 }]);
    try {
      const response = await getAnalytics(
        new Request(
          "https://airi.chat/api/v1/analytics?metric=by_category&days=7"
        )
      );
      const payload = await response.json();
      const match = mockAggregate.mock.calls[0]?.[0]?.[0]?.$match;

      expect(response.status).toBe(200);
      expect(payload.categories).toEqual([{ category: "Sales", count: 1 }]);
      expect(match).toEqual({
        workspaceId: "workspace-1",
        createdAt: { $gte: new Date("2026-09-30T12:00:00.000Z") },
        _id: { $in: [visibleId] },
        ...buildCurrentConversationClassificationFilter(),
      });
      expect(match).toMatchObject({
        is_classified: true,
        "classification_state.status": "ready",
        "classification_meta.provenance_kind": "v2",
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it.each(["total", "daily"])(
    "keeps %s analytics independent of classification readiness",
    async metric => {
      const response = await getAnalytics(
        new Request(`https://airi.chat/api/v1/analytics?metric=${metric}`)
      );

      expect(response.status).toBe(200);
      for (const [pipeline] of mockAggregate.mock.calls) {
        expect(pipeline[0].$match).toMatchObject({
          workspaceId: "workspace-1",
        });
        expect(pipeline[0].$match).not.toHaveProperty("is_classified");
        expect(pipeline[0].$match).not.toHaveProperty(
          "classification_state.status"
        );
      }
    }
  );
});
