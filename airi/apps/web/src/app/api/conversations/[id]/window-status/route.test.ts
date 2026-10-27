const mockConnectDB = jest.fn();
const mockGetSupabaseRouteAuth = jest.fn();
const mockCheckUserWorkspaceAccess = jest.fn();
const mockConversationFindById = jest.fn();
const mockBuildWindowStatus = jest.fn();

jest.mock("@/lib/mongoose", () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockConnectDB(...args),
}));
jest.mock("@/lib/supabase/route-auth", () => ({
  getSupabaseRouteAuth: (...args: unknown[]) =>
    mockGetSupabaseRouteAuth(...args),
  isSupabaseRouteAuthError: (value: unknown) =>
    Boolean((value as { error?: unknown }).error),
}));
jest.mock("@/lib/supabase/queries", () => ({
  checkUserWorkspaceAccess: (...args: unknown[]) =>
    mockCheckUserWorkspaceAccess(...args),
}));
jest.mock("@/lib/conversation-window-status", () => ({
  buildConversationMessagingWindowStatus: (...args: unknown[]) =>
    mockBuildWindowStatus(...args),
}));
jest.mock("@/models/conversation", () => ({
  Conversation: {
    findById: (...args: unknown[]) => mockConversationFindById(...args),
  },
}));

import { GET } from "./route";

const conversation = {
  _id: "conversation-1",
  workspaceId: "workspace-1",
  channel: "whatsapp",
  last_inbound_at: new Date("2026-10-21T08:00:00.000Z"),
};
const selectedFields: string[] = [];

function getWindowStatus() {
  return GET(
    new Request(
      "http://localhost/api/conversations/conversation-1/window-status"
    ),
    { params: Promise.resolve({ id: "conversation-1" }) }
  );
}

describe("GET /api/conversations/[id]/window-status", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    selectedFields.length = 0;
    mockConnectDB.mockResolvedValue(undefined);
    mockGetSupabaseRouteAuth.mockResolvedValue({
      supabase: {},
      user: { id: "user-1" },
    });
    mockConversationFindById.mockReturnValue({
      select: (fields: string) => {
        selectedFields.push(fields);
        return { lean: async () => conversation };
      },
    });
    mockCheckUserWorkspaceAccess.mockResolvedValue(true);
    mockBuildWindowStatus.mockResolvedValue({
      channel: "whatsapp",
      requiresWindow: true,
      windowInfo: null,
    });
  });

  it("returns the window status for a workspace member", async () => {
    const response = await getWindowStatus();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      channel: "whatsapp",
      requiresWindow: true,
    });
    expect(mockCheckUserWorkspaceAccess).toHaveBeenCalledWith(
      {},
      "user-1",
      "workspace-1"
    );
    expect(mockBuildWindowStatus).toHaveBeenCalledWith(conversation);
    expect(selectedFields).toEqual([
      "_id workspaceId sourceId channel last_inbound_at",
    ]);
  });

  it("always checks workspace access before reading the window", async () => {
    mockCheckUserWorkspaceAccess.mockResolvedValue(false);

    const response = await getWindowStatus();

    expect(response.status).toBe(403);
    expect(mockBuildWindowStatus).not.toHaveBeenCalled();
  });

  it("returns 404 for a missing conversation", async () => {
    mockConversationFindById.mockReturnValue({
      select: () => ({ lean: async () => null }),
    });

    const response = await getWindowStatus();

    expect(response.status).toBe(404);
    expect(mockCheckUserWorkspaceAccess).not.toHaveBeenCalled();
  });
});
