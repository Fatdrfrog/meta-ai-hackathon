const mockCreateClient = jest.fn();
const mockVerifyWorkspaceAccess = jest.fn();
const mockConnectDB = jest.fn();
const mockGetAiriChatThreadForUser = jest.fn();
const mockListAiriChatMessagePage = jest.fn();
const mockGetAiriChatActiveRun = jest.fn();
const mockStartAiriChatRun = jest.fn();
const mockAwaitAiriChatRunTurn = jest.fn();
const mockEnsureCompanyStudioChatCapacity = jest.fn();
const mockRecordCreativeStudioChat = jest.fn();
const mockBuildCompanyStudioChatLimitExceededResponse = jest.fn();

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
  getAiriChatThreadForUser: (...args: unknown[]) =>
    mockGetAiriChatThreadForUser(...args),
  listAiriChatMessagePage: (...args: unknown[]) =>
    mockListAiriChatMessagePage(...args),
}));

jest.mock("@/lib/limits/company-limits", () => ({
  ensureCompanyStudioChatCapacity: (...args: unknown[]) =>
    mockEnsureCompanyStudioChatCapacity(...args),
  recordCreativeStudioChat: (...args: unknown[]) =>
    mockRecordCreativeStudioChat(...args),
  buildCompanyStudioChatLimitExceededResponse: (...args: unknown[]) =>
    mockBuildCompanyStudioChatLimitExceededResponse(...args),
}));

// The run itself runs end to end in ../../durable-runs.integration.test.ts.
jest.mock("@/lib/airi-chats/runs", () => ({
  startAiriChatRun: (...args: unknown[]) => mockStartAiriChatRun(...args),
  awaitAiriChatRunTurn: (...args: unknown[]) =>
    mockAwaitAiriChatRunTurn(...args),
  getAiriChatActiveRun: (...args: unknown[]) =>
    mockGetAiriChatActiveRun(...args),
}));

import { NextResponse } from "next/server";
import {
  AiriChatSelectedSourceError,
  AiriChatThreadNotFoundError,
} from "@/lib/airi-chats/errors";
import { GET, POST } from "./route";
import { mockSupabaseUser } from "@/test-support/supabase-auth-test-utils";
import { postJson, request } from "../../airi-chats-route-test-utils";

const threadId = "507f1f77bcf86cd799439011";
const params = {
  params: Promise.resolve({ workspaceId: "workspace-1", threadId }),
};

function mockSupabase(user?: { id: string } | null) {
  return mockSupabaseUser(mockCreateClient, user);
}

describe("/api/workspaces/[workspaceId]/airi-chats/[threadId]/messages", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockConnectDB.mockResolvedValue(undefined);
    mockVerifyWorkspaceAccess.mockResolvedValue(true);
    mockGetAiriChatThreadForUser.mockResolvedValue({ id: threadId });
    mockListAiriChatMessagePage.mockResolvedValue({
      messages: [],
      hasMore: false,
    });
    mockGetAiriChatActiveRun.mockResolvedValue(null);
    mockEnsureCompanyStudioChatCapacity.mockResolvedValue({ allowed: true });
    mockRecordCreativeStudioChat.mockResolvedValue(undefined);
    mockStartAiriChatRun.mockResolvedValue({
      kind: "started",
      run: { runId: "run-1", threadId, clientTurnId: "turn-1" },
      outcome: new Promise(() => {}),
    });
    mockAwaitAiriChatRunTurn.mockResolvedValue({
      userMessage: { id: "message-user", role: "user", content: "Hello" },
      assistantMessage: {
        id: "message-assistant",
        role: "assistant",
        content: "Hi",
      },
      thread: { id: threadId, title: "Hello" },
    });
    mockBuildCompanyStudioChatLimitExceededResponse.mockImplementation(() =>
      NextResponse.json(
        { error: "Studio chat limit exceeded" },
        { status: 402 }
      )
    );
  });

  it("rejects unauthorized requests", async () => {
    mockSupabase(null);

    const response = await GET(request(), params);

    expect(response.status).toBe(401);
    expect(mockListAiriChatMessagePage).not.toHaveBeenCalled();
  });

  it("loads a message page and the active run after workspace and thread access checks", async () => {
    const supabase = mockSupabase();
    mockListAiriChatMessagePage.mockResolvedValue({
      messages: [{ id: "message-1", role: "user", content: "Hello" }],
      hasMore: true,
    });
    const activeRun = {
      runId: "507f1f77bcf86cd799439022",
      status: "running",
      startedAt: "2026-10-11T09:00:00.000Z",
    };
    mockGetAiriChatActiveRun.mockResolvedValue(activeRun);

    const response = await GET(
      request("http://localhost/api?before=507f1f77bcf86cd799439033&limit=20"),
      params
    );

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
    expect(mockGetAiriChatActiveRun).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      threadId,
      supabase,
    });
    expect(mockListAiriChatMessagePage).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      threadId,
      before: "507f1f77bcf86cd799439033",
      limit: 20,
    });
    expect(await response.json()).toEqual({
      messages: [{ id: "message-1", role: "user", content: "Hello" }],
      hasMore: true,
      activeRun,
    });
  });

  it("rejects an invalid page cursor or limit before any database read", async () => {
    mockSupabase();

    for (const query of ["?before=not-an-id", "?limit=0", "?limit=abc"]) {
      const response = await GET(
        request(`http://localhost/api${query}`),
        params
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: "invalid_request" });
    }
    expect(mockConnectDB).not.toHaveBeenCalled();
    expect(mockListAiriChatMessagePage).not.toHaveBeenCalled();
  });

  it("returns the existing 402 response when studio chat capacity is exceeded", async () => {
    mockSupabase();
    mockEnsureCompanyStudioChatCapacity.mockResolvedValue({
      allowed: false,
      limit: { limit: 1, used: 1 },
    });

    const response = await postJson(POST, { content: "Hello" }, params);

    expect(response.status).toBe(402);
    expect(mockStartAiriChatRun).not.toHaveBeenCalled();
  });

  it("starts a run with the loaded thread and returns its turn", async () => {
    const supabase = mockSupabase();
    const selectedSources = [
      {
        kind: "workspace_source",
        sourceId: "canva-1",
        sourceType: "canva",
        label: "Canva",
      },
    ];

    const response = await postJson(
      POST,
      { content: "Hello Airi", selectedSources },
      params
    );

    expect(response.status).toBe(200);
    const [input] = mockStartAiriChatRun.mock.calls[0]!;
    expect(input).toMatchObject({
      supabase,
      workspaceId: "workspace-1",
      userId: "user-1",
      threadId,
      // The ownership check's thread is reused instead of read again.
      thread: { id: threadId },
      content: "Hello Airi",
      selectedSources,
    });
    expect(input).not.toHaveProperty("signal");
    expect(await response.json()).toEqual({
      userMessage: { id: "message-user", role: "user", content: "Hello" },
      assistantMessage: {
        id: "message-assistant",
        role: "assistant",
        content: "Hi",
      },
      thread: { id: threadId, title: "Hello" },
    });
  });

  it("answers 409 airi_run_active while the thread has another run", async () => {
    mockSupabase();
    mockStartAiriChatRun.mockResolvedValue({
      kind: "conflict",
      runId: "run-active",
    });

    const response = await postJson(POST, { content: "Hello Airi" }, params);

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "airi_run_active",
      runId: "run-active",
    });
    expect(mockAwaitAiriChatRunTurn).not.toHaveBeenCalled();
  });

  it("checks access, the thread and capacity together but answers 403 first", async () => {
    mockSupabase();
    let releaseAccess!: (value: boolean) => void;
    mockVerifyWorkspaceAccess.mockImplementation(
      () =>
        new Promise<boolean>(resolve => {
          releaseAccess = resolve;
        })
    );
    mockGetAiriChatThreadForUser.mockRejectedValue(new Error("not a member"));

    const pending = POST(
      request("http://localhost/api", {
        method: "POST",
        body: JSON.stringify({ content: "Hello Airi" }),
      }),
      params
    );
    await new Promise(resolve => setTimeout(resolve, 0));
    // The thread read and capacity check started before access resolved.
    expect(mockGetAiriChatThreadForUser).toHaveBeenCalled();
    expect(mockEnsureCompanyStudioChatCapacity).toHaveBeenCalled();
    releaseAccess(false);

    const response = await pending;
    expect(response.status).toBe(403);
    expect(mockStartAiriChatRun).not.toHaveBeenCalled();
  });

  it("returns 400 when a selected source is unavailable", async () => {
    mockSupabase();
    mockAwaitAiriChatRunTurn.mockRejectedValue(
      new AiriChatSelectedSourceError("Selected source is unavailable: Canva")
    );

    const response = await postJson(
      POST,
      {
        content: "Hello Airi",
        selectedSources: [
          {
            kind: "workspace_source",
            sourceId: "canva-1",
            sourceType: "canva",
            label: "Canva",
          },
        ],
      },
      params
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Selected source is unavailable: Canva",
      code: "selected_source_unavailable",
    });
  });

  it("does not choose a status from message text", async () => {
    mockSupabase();
    // A plain error that merely reads like a selected-source error.
    mockAwaitAiriChatRunTurn.mockRejectedValue(
      new Error("Selected source is unavailable: secret-internal-host:27017")
    );

    const response = await postJson(POST, { content: "Hello Airi" }, params);

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: "Failed to send Airi message",
      code: "airi_chat_failed",
    });
  });

  it("answers a server-side timeout with 504, not a client cancellation", async () => {
    mockSupabase();
    mockAwaitAiriChatRunTurn.mockRejectedValue(
      new DOMException("The operation timed out", "TimeoutError")
    );

    const response = await postJson(POST, { content: "Hello Airi" }, params);

    expect(response.status).toBe(504);
    expect(await response.json()).toMatchObject({ code: "timed_out" });
  });

  it("maps a chat deleted mid-turn to a coded 404", async () => {
    mockSupabase();
    mockAwaitAiriChatRunTurn.mockRejectedValue(
      new AiriChatThreadNotFoundError()
    );

    const response = await postJson(POST, { content: "Hello Airi" }, params);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: "Airi chat thread not found",
      code: "thread_not_found",
    });
  });

  it("validates the body before any database work", async () => {
    mockSupabase();

    const response = await POST(
      request("http://localhost/api", {
        method: "POST",
        body: "{not json",
      }),
      params
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "invalid_request" });
    expect(mockConnectDB).not.toHaveBeenCalled();
    expect(mockGetAiriChatThreadForUser).not.toHaveBeenCalled();
    expect(mockEnsureCompanyStudioChatCapacity).not.toHaveBeenCalled();
  });

  it("hides a load failure's message from the client", async () => {
    mockSupabase();
    mockListAiriChatMessagePage.mockRejectedValue(
      new Error("connection <monitor> to 10.0.0.5:27017 closed")
    );

    const response = await GET(request(), params);

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: "Failed to load Airi messages",
      code: "airi_chat_failed",
    });
  });
});
