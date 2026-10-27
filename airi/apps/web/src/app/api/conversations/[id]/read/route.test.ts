const mockCacheDel = jest.fn();
const mockInvalidateCacheByPrefix = jest.fn();
const mockConnectDB = jest.fn();
const mockGetHiddenConversationPlanGateResponse = jest.fn();
const mockGetSupabaseRouteAuth = jest.fn();
const mockIsSupabaseRouteAuthError = jest.fn();
const mockConversationFindById = jest.fn();
const mockConversationUpdateOne = jest.fn();
const mockTriggerConversationChanged = jest.fn();

jest.mock("@icecore/shared/lib/cache", () => ({
  buildCacheKey: (namespace: string, parts: string[]) =>
    `icecore:${namespace}:${parts.join(":")}`,
  cache: {
    del: (...args: unknown[]) => mockCacheDel(...args),
  },
  invalidateCacheByPrefix: (...args: unknown[]) =>
    mockInvalidateCacheByPrefix(...args),
}));

jest.mock("@/lib/limits/company-limits", () => ({
  getHiddenConversationPlanGateResponse: (...args: unknown[]) =>
    mockGetHiddenConversationPlanGateResponse(...args),
}));

jest.mock("@/lib/mongoose", () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockConnectDB(...args),
}));

jest.mock("@/lib/realtime-updates", () => ({
  triggerConversationChanged: (...args: unknown[]) =>
    mockTriggerConversationChanged(...args),
}));

jest.mock("@/lib/supabase/route-auth", () => ({
  getSupabaseRouteAuth: (...args: unknown[]) =>
    mockGetSupabaseRouteAuth(...args),
  isSupabaseRouteAuthError: (...args: unknown[]) =>
    mockIsSupabaseRouteAuthError(...args),
}));

jest.mock("@/models/conversation", () => ({
  Conversation: {
    findById: (...args: unknown[]) => mockConversationFindById(...args),
    updateOne: (...args: unknown[]) => mockConversationUpdateOne(...args),
  },
}));

import { PATCH } from "./route";

const conversationId = "507f1f77bcf86cd799439011";

function makeSupabaseAccess({ member = true }: { member?: boolean } = {}) {
  return {
    from: jest.fn(() => ({
      select: jest.fn(() => ({
        eq: jest.fn(() => ({
          eq: jest.fn(() => ({
            maybeSingle: jest.fn(async () => ({
              data: member ? { user_id: "user-1" } : null,
            })),
          })),
        })),
      })),
    })),
  };
}

function mockConversationLookup(
  conversation: unknown = { workspaceId: "workspace-1" }
) {
  mockConversationFindById.mockReturnValue({
    select: jest.fn(() => ({
      lean: jest.fn(async () => conversation),
    })),
  });
}

function makePatchRequest(body?: string) {
  return new Request("http://localhost/read", {
    method: "PATCH",
    ...(body === undefined ? {} : { body }),
  });
}

async function patch(body?: string, id = conversationId) {
  return PATCH(makePatchRequest(body), {
    params: Promise.resolve({ id }),
  });
}

describe("PATCH /api/conversations/[id]/read", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockConnectDB.mockResolvedValue(undefined);
    mockGetSupabaseRouteAuth.mockResolvedValue({
      supabase: makeSupabaseAccess(),
      user: { id: "user-1" },
      authType: "cookie",
    });
    mockIsSupabaseRouteAuthError.mockReturnValue(false);
    mockGetHiddenConversationPlanGateResponse.mockResolvedValue(null);
    mockConversationLookup();
    mockConversationUpdateOne.mockResolvedValue({
      matchedCount: 1,
      modifiedCount: 1,
    });
    mockTriggerConversationChanged.mockResolvedValue(undefined);
  });

  it("marks an unread conversation read inside its workspace and fans out", async () => {
    const response = await patch();
    const result = await response.json();

    expect(response.status).toBe(200);
    expect(Object.keys(result)).toEqual(["readAt"]);
    expect(new Date(result.readAt).toISOString()).toBe(result.readAt);
    expect(mockConversationFindById).toHaveBeenCalledWith(conversationId);
    expect(mockConversationUpdateOne).toHaveBeenCalledWith(
      {
        _id: conversationId,
        workspaceId: "workspace-1",
        is_read_by_manager: { $ne: true },
      },
      { $set: { is_read_by_manager: true } }
    );
    expect(mockTriggerConversationChanged).toHaveBeenCalledWith(conversationId);
  });

  it("does not touch the shared cache, because request pages are not cached", async () => {
    const response = await patch();

    expect(response.status).toBe(200);
    expect(mockInvalidateCacheByPrefix).not.toHaveBeenCalled();
    expect(mockCacheDel).not.toHaveBeenCalled();
  });

  it("keeps the read when realtime fanout fails", async () => {
    mockTriggerConversationChanged.mockRejectedValue(
      new Error("realtime unavailable")
    );

    const response = await patch();

    expect(response.status).toBe(200);
    expect(mockTriggerConversationChanged).toHaveBeenCalledWith(conversationId);
  });

  it("does not rewrite or fan out an already-read conversation", async () => {
    mockConversationUpdateOne.mockResolvedValue({
      matchedCount: 0,
      modifiedCount: 0,
    });

    const response = await patch("{}");

    expect(response.status).toBe(200);
    expect(mockConversationUpdateOne).toHaveBeenCalledTimes(1);
    expect(mockTriggerConversationChanged).not.toHaveBeenCalled();
  });

  it("does not report success or fan out when the write fails", async () => {
    mockConversationUpdateOne.mockRejectedValue(new Error("write failed"));

    const response = await patch();

    expect(response.status).toBe(500);
    expect(mockTriggerConversationChanged).not.toHaveBeenCalled();
  });

  it("denies a non-member of the conversation workspace before writing", async () => {
    mockGetSupabaseRouteAuth.mockResolvedValue({
      supabase: makeSupabaseAccess({ member: false }),
      user: { id: "user-1" },
      authType: "cookie",
    });

    const response = await patch();

    expect(response.status).toBe(403);
    expect(mockConversationUpdateOne).not.toHaveBeenCalled();
  });

  it.each([
    "507F1F77BCF86CD799439011",
    "507f1f77bcf86cd79943901",
    "507f1f77bcf86cd79943901g",
  ])("rejects invalid path identity %s before Mongo", async invalidId => {
    const response = await patch(undefined, invalidId);

    expect(response.status).toBe(400);
    expect(mockConnectDB).not.toHaveBeenCalled();
    expect(mockConversationFindById).not.toHaveBeenCalled();
    expect(mockConversationUpdateOne).not.toHaveBeenCalled();
  });

  it.each([
    "{",
    "null",
    "[]",
    '"watermark"',
    "1",
    '{"sourceWatermark":"ffffffffffffffff"}',
    '{"unknown":true}',
  ])("rejects malformed or nonempty body %s before Mongo", async body => {
    const response = await patch(body);

    expect(response.status).toBe(400);
    expect(mockConnectDB).not.toHaveBeenCalled();
    expect(mockConversationFindById).not.toHaveBeenCalled();
    expect(mockConversationUpdateOne).not.toHaveBeenCalled();
  });
});
