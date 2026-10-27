const mockCreateClient = jest.fn();
const mockVerifyWorkspaceAccess = jest.fn();
const mockConnectDB = jest.fn();
const mockGetAiriChatThreadForUser = jest.fn();
const mockArchiveAiriChatThreadForUser = jest.fn();
const mockSerializeAiriChatThread = jest.fn();
const mockGetAiriChatActiveRun = jest.fn();

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
  archiveAiriChatThreadForUser: (...args: unknown[]) =>
    mockArchiveAiriChatThreadForUser(...args),
  getAiriChatThreadForUser: (...args: unknown[]) =>
    mockGetAiriChatThreadForUser(...args),
  serializeAiriChatThread: (...args: unknown[]) =>
    mockSerializeAiriChatThread(...args),
}));

jest.mock("@/lib/airi-chats/runs", () => ({
  getAiriChatActiveRun: (...args: unknown[]) =>
    mockGetAiriChatActiveRun(...args),
}));

import { DELETE, GET, PATCH } from "./route";
import { mockSupabaseUser } from "@/test-support/supabase-auth-test-utils";
import { postJson, request } from "../airi-chats-route-test-utils";

const threadId = "507f1f77bcf86cd799439011";
const params = {
  params: Promise.resolve({ workspaceId: "workspace-1", threadId }),
};

function mockSupabase(user?: { id: string } | null) {
  return mockSupabaseUser(mockCreateClient, user);
}

describe("/api/workspaces/[workspaceId]/airi-chats/[threadId]", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockConnectDB.mockResolvedValue(undefined);
    mockVerifyWorkspaceAccess.mockResolvedValue(true);
    mockArchiveAiriChatThreadForUser.mockResolvedValue(true);
    mockGetAiriChatActiveRun.mockResolvedValue(null);
    mockSerializeAiriChatThread.mockImplementation(thread => ({
      id: String(thread._id),
      title: thread.title,
      pinnedAt: thread.pinnedAt?.toISOString?.() ?? thread.pinnedAt ?? null,
    }));
  });

  it("loads the thread with its active run after the access checks", async () => {
    const supabase = mockSupabase();
    const thread = {
      _id: threadId,
      title: "Support Plan",
      pinnedAt: null,
      toObject() {
        return this;
      },
    };
    mockGetAiriChatThreadForUser.mockResolvedValue(thread);
    const activeRun = {
      runId: "507f1f77bcf86cd799439022",
      status: "running",
      startedAt: "2026-10-11T09:00:00.000Z",
    };
    mockGetAiriChatActiveRun.mockResolvedValue(activeRun);

    const response = await GET(request(), params);

    expect(response.status).toBe(200);
    expect(mockGetAiriChatActiveRun).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      threadId,
      supabase,
    });
    expect(await response.json()).toEqual({
      thread: { id: threadId, title: "Support Plan", pinnedAt: null },
      activeRun,
    });
  });

  it("answers 404 for a thread that is not the caller's, without a run read", async () => {
    mockSupabase();
    mockGetAiriChatThreadForUser.mockResolvedValue(null);

    const response = await GET(request(), params);

    expect(response.status).toBe(404);
    expect(mockGetAiriChatActiveRun).not.toHaveBeenCalled();
  });

  it("pins a workspace-scoped chat thread", async () => {
    const supabase = mockSupabase();
    const thread = {
      _id: threadId,
      title: "Support Plan",
      pinnedAt: null as Date | null,
      save: jest.fn(async () => undefined),
      toObject() {
        return this;
      },
    };
    mockGetAiriChatThreadForUser.mockResolvedValue(thread);

    const response = await postJson(PATCH, { pinned: true }, params, {
      method: "PATCH",
    });

    expect(response.status).toBe(200);
    expect(mockVerifyWorkspaceAccess).toHaveBeenCalledWith(
      supabase,
      "user-1",
      "workspace-1"
    );
    expect(mockGetAiriChatThreadForUser).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      userId: "user-1",
      threadId,
    });
    expect(thread.pinnedAt).toBeInstanceOf(Date);
    expect(thread.save).toHaveBeenCalled();
    expect((await response.json()).thread).toEqual({
      id: threadId,
      title: "Support Plan",
      pinnedAt: thread.pinnedAt?.toISOString(),
    });
  });

  it("rejects empty updates", async () => {
    mockSupabase();

    const response = await postJson(PATCH, {}, params, { method: "PATCH" });

    expect(response.status).toBe(400);
    expect(mockGetAiriChatThreadForUser).not.toHaveBeenCalled();
  });

  it("archives a workspace-scoped chat thread through the fast update path", async () => {
    const supabase = mockSupabase();

    const response = await DELETE(request("http://localhost/api"), params);

    expect(response.status).toBe(200);
    expect(mockVerifyWorkspaceAccess).toHaveBeenCalledWith(
      supabase,
      "user-1",
      "workspace-1"
    );
    expect(mockArchiveAiriChatThreadForUser).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      userId: "user-1",
      threadId,
    });
    expect(await response.json()).toEqual({ success: true });
  });

  it("returns 404 when archive finds no active thread", async () => {
    mockSupabase();
    mockArchiveAiriChatThreadForUser.mockResolvedValue(false);

    const response = await DELETE(request("http://localhost/api"), params);

    expect(response.status).toBe(404);
  });
});
