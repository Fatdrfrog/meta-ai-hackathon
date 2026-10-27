const mockAuthenticate = jest.fn();
const mockFind = jest.fn();
const mockCount = jest.fn();
const mockAggregate = jest.fn();
const mockVisibility = jest.fn();
const mockLimit = jest.fn();
const mockSkip = jest.fn();
import mongoose from "mongoose";

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
      return {
        sort: () => ({
          skip: (skip: number) => {
            mockSkip(skip);
            return {
              limit: (limit: number) => {
                mockLimit(limit);
                return { select: () => ({ lean: () => Promise.resolve([]) }) };
              },
            };
          },
        }),
      };
    },
    countDocuments: (...args: unknown[]) => mockCount(...args),
    aggregate: (...args: unknown[]) => mockAggregate(...args),
  },
}));

import { GET as getConversations } from "./conversations/route";
import { GET as getAnalytics } from "./analytics/route";

const endpoints = [
  { name: "conversations", handler: getConversations },
  { name: "analytics", handler: getAnalytics },
] as const;

describe.each(endpoints)(
  "customer $name API read authorization",
  ({ name, handler }) => {
    function request() {
      return new Request(`https://airi.chat/api/v1/${name}`);
    }

    function permissions(value: Record<string, boolean>) {
      mockAuthenticate.mockResolvedValue({
        apiKey: { workspace_id: "workspace-1", permissions: value },
        error: null,
      });
    }

    beforeEach(() => {
      jest.clearAllMocks();
      mockCount.mockResolvedValue(0);
      mockAggregate.mockResolvedValue([]);
      mockVisibility.mockResolvedValue({ visibleConversationIds: null });
    });

    it("rejects a write-only key even when its domain flag is enabled", async () => {
      permissions({
        read: false,
        write: true,
        conversations: true,
        analytics: true,
      });
      expect((await handler(request())).status).toBe(403);
      expect(mockFind).not.toHaveBeenCalled();
      expect(mockCount).not.toHaveBeenCalled();
    });

    it("honors an explicit domain-scope deny on a read key", async () => {
      permissions({ read: true, write: false, [name]: false });
      expect((await handler(request())).status).toBe(403);
      expect(mockCount).not.toHaveBeenCalled();
    });

    it("preserves legacy read-only keys that have no domain flags", async () => {
      permissions({ read: true, write: false });
      expect((await handler(request())).status).toBe(200);
      expect(mockCount).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceId: "workspace-1" })
      );
    });

    it("filters paid-hidden conversations using the canonical company visibility gate", async () => {
      permissions({ read: true, write: false });
      mockVisibility.mockResolvedValue({
        visibleConversationIds: ["507f1f77bcf86cd799439011"],
      });
      expect((await handler(request())).status).toBe(200);
      expect(mockCount).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceId: "workspace-1",
          _id: {
            $in: [new mongoose.Types.ObjectId("507f1f77bcf86cd799439011")],
          },
        })
      );
    });
    it("does not return conversation data when plan visibility cannot be resolved", async () => {
      permissions({ read: true, write: false });
      mockVisibility.mockRejectedValueOnce(
        new Error("Plan lookup unavailable")
      );
      const consoleError = jest
        .spyOn(console, "error")
        .mockImplementation(() => undefined);
      try {
        const response = await handler(request());
        expect(response.status).toBe(503);
        expect(mockFind).not.toHaveBeenCalled();
        expect(mockCount).not.toHaveBeenCalled();
        expect(mockAggregate).not.toHaveBeenCalled();
      } finally {
        consoleError.mockRestore();
      }
    });
  }
);

describe("customer conversation API query admission", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAuthenticate.mockResolvedValue({
      apiKey: { workspace_id: "workspace-1", permissions: { read: true } },
      error: null,
    });
    mockVisibility.mockResolvedValue({ visibleConversationIds: null });
    mockCount.mockResolvedValue(0);
  });

  it("does not allow limit zero to turn a paged request into an unlimited Mongo query", async () => {
    const response = await getConversations(
      new Request("https://airi.chat/api/v1/conversations?limit=0")
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ pagination: { limit: 1 } });
    expect(mockLimit).toHaveBeenCalledWith(1);
  });
});

describe("customer conversation API deep-pagination admission", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAuthenticate.mockResolvedValue({
      apiKey: { workspace_id: "workspace-1", permissions: { read: true } },
      error: null,
    });
    mockVisibility.mockResolvedValue({ visibleConversationIds: null });
    mockCount.mockResolvedValue(0);
  });

  it.each(["page=1000000000", "page=102&limit=100", "page=10002&limit=1"])(
    "rejects a deep page without querying conversations (%s)",
    async query => {
      const response = await getConversations(
        new Request(`https://airi.chat/api/v1/conversations?${query}`)
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        code: "INVALID_PAGINATION",
      });
      expect(mockVisibility).not.toHaveBeenCalled();
      expect(mockFind).not.toHaveBeenCalled();
      expect(mockCount).not.toHaveBeenCalled();
    }
  );

  it("allows the existing page contract at the maximum bounded offset", async () => {
    const response = await getConversations(
      new Request("https://airi.chat/api/v1/conversations?page=101&limit=100")
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      pagination: { page: 101, limit: 100 },
    });
    expect(mockSkip).toHaveBeenCalledWith(10000);
  });
});

describe("customer analytics API query admission", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAuthenticate.mockResolvedValue({
      apiKey: { workspace_id: "workspace-1", permissions: { read: true } },
      error: null,
    });
    mockVisibility.mockResolvedValue({ visibleConversationIds: null });
    mockCount.mockResolvedValue(0);
    mockAggregate.mockResolvedValue([]);
  });

  it.each([
    ["10000", 365],
    ["not-a-number", 30],
    ["-10", 1],
  ])("bounds the analytics horizon for days=%s", async (days, expectedDays) => {
    const consoleError = jest
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    try {
      const response = await getAnalytics(
        new Request(`https://airi.chat/api/v1/analytics?days=${days}`)
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        period: { days: expectedDays },
      });
    } finally {
      consoleError.mockRestore();
    }
  });
});
