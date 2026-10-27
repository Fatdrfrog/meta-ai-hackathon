const mockCreateClient = jest.fn();
const mockVerifyWorkspaceAccess = jest.fn();
const mockConnectDB = jest.fn();
const mockListAiriChatThreads = jest.fn();
const mockCreateAiriChatThread = jest.fn();

jest.mock("@/lib/supabase/server", () => ({
  createClient: (...args: unknown[]) => mockCreateClient(...args),
}));

jest.mock("@/lib/sources/utils", () => ({
  verifyWorkspaceAccess: (...args: unknown[]) =>
    mockVerifyWorkspaceAccess(...args),
}));

jest.mock("@/lib/mongoose", () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockConnectDB(...args),
}));

jest.mock("@/lib/airi-chats/service", () => ({
  listAiriChatThreads: (...args: unknown[]) => mockListAiriChatThreads(...args),
  createAiriChatThread: (...args: unknown[]) =>
    mockCreateAiriChatThread(...args),
}));

import { GET, POST } from "./route";
import { mockSupabaseUser } from "@/test-support/supabase-auth-test-utils";
import { postJson, request } from "./airi-chats-route-test-utils";

const params = { params: Promise.resolve({ workspaceId: "workspace-1" }) };

function mockSupabase(user?: { id: string } | null) {
  return mockSupabaseUser(mockCreateClient, user);
}

describe("/api/workspaces/[workspaceId]/airi-chats", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockConnectDB.mockResolvedValue(undefined);
    mockVerifyWorkspaceAccess.mockResolvedValue(true);
    mockListAiriChatThreads.mockResolvedValue([]);
    mockCreateAiriChatThread.mockResolvedValue({
      id: "thread-1",
      title: "New chat",
      source: "manual",
      updatedAt: new Date().toISOString(),
    });
  });

  it("rejects unauthorized requests", async () => {
    mockSupabase(null);

    const response = await GET(request(), params);

    expect(response.status).toBe(401);
    expect(mockListAiriChatThreads).not.toHaveBeenCalled();
  });

  it("rejects users without workspace access", async () => {
    const supabase = mockSupabase();
    mockVerifyWorkspaceAccess.mockResolvedValue(false);

    const response = await GET(request(), params);

    expect(mockVerifyWorkspaceAccess).toHaveBeenCalledWith(
      supabase,
      "user-1",
      "workspace-1"
    );
    expect(response.status).toBe(403);
  });

  it("lists active user threads scoped to the workspace", async () => {
    mockSupabase();
    mockListAiriChatThreads.mockResolvedValue([
      { id: "thread-1", title: "Support gaps" },
    ]);

    const response = await GET(request(), params);

    expect(response.status).toBe(200);
    expect(mockListAiriChatThreads).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      userId: "user-1",
    });
    expect(await response.json()).toEqual({
      threads: [{ id: "thread-1", title: "Support gaps" }],
    });
  });

  it("creates a workspace-scoped thread for the current user", async () => {
    mockSupabase();

    const response = await postJson(
      POST,
      { title: "Launch plan", source: "global" },
      params
    );

    expect(response.status).toBe(201);
    expect(mockCreateAiriChatThread).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      userId: "user-1",
      title: "Launch plan",
      source: "global",
    });
  });
});
