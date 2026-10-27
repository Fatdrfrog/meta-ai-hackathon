const mockCreateClient = jest.fn();
const mockVerifyWorkspaceAccess = jest.fn();
const mockConnectDB = jest.fn();
const mockStartAiriChatRun = jest.fn();
const mockCreateAiriChatRunStreamResponse = jest.fn();
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
  createAiriChatRunStreamResponse: (...args: unknown[]) =>
    mockCreateAiriChatRunStreamResponse(...args),
}));

import { NextResponse } from "next/server";
import { POST } from "./route";
import { mockSupabaseUser } from "@/test-support/supabase-auth-test-utils";
import { postJson } from "../../airi-chats-route-test-utils";

const params = { params: Promise.resolve({ workspaceId: "workspace-1" }) };

function mockSupabase(user?: { id: string } | null) {
  return mockSupabaseUser(mockCreateClient, user);
}

describe("/api/workspaces/[workspaceId]/airi-chats/messages/stream", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockConnectDB.mockResolvedValue(undefined);
    mockVerifyWorkspaceAccess.mockResolvedValue(true);
    mockEnsureCompanyStudioChatCapacity.mockResolvedValue({ allowed: true });
    mockRecordCreativeStudioChat.mockResolvedValue(undefined);
    mockBuildCompanyStudioChatLimitExceededResponse.mockImplementation(() =>
      NextResponse.json(
        { error: "Studio chat limit exceeded" },
        { status: 402 }
      )
    );
    mockStartAiriChatRun.mockResolvedValue({
      kind: "started",
      run: { runId: "run-1", threadId: "thread-1", clientTurnId: "turn-1" },
      outcome: new Promise(() => {}),
    });
    mockCreateAiriChatRunStreamResponse.mockImplementation(
      () =>
        new Response("event: run\n\n", {
          headers: { "content-type": "text/event-stream" },
        })
    );
  });

  it("starts a run for a first Airi chat message and streams it", async () => {
    const supabase = mockSupabase();

    const response = await postJson(
      POST,
      { content: "Hello Airi", source: "global" },
      params
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const [input] = mockStartAiriChatRun.mock.calls[0]!;
    expect(input).toMatchObject({
      supabase,
      workspaceId: "workspace-1",
      userId: "user-1",
      content: "Hello Airi",
      source: "global",
    });
    expect(input).not.toHaveProperty("signal");
    expect(mockCreateAiriChatRunStreamResponse).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run-1", supabase })
    );
  });

  it("returns existing 402 behavior before opening a stream", async () => {
    mockSupabase();
    mockEnsureCompanyStudioChatCapacity.mockResolvedValue({
      allowed: false,
      limit: { limit: 1, used: 1 },
    });

    const response = await postJson(POST, { content: "Hello" }, params);

    expect(response.status).toBe(402);
    expect(response.headers.get("content-type")).not.toContain(
      "text/event-stream"
    );
    expect(mockStartAiriChatRun).not.toHaveBeenCalled();
  });

  it("rejects an invalid body with a 400 before any database work or stream", async () => {
    mockSupabase();

    const response = await postJson(POST, { content: "" }, params);

    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).not.toContain(
      "text/event-stream"
    );
    expect(await response.json()).toEqual({
      error: expect.stringContaining(
        "String must contain at least 1 character"
      ),
      code: "invalid_request",
    });
    expect(mockConnectDB).not.toHaveBeenCalled();
    expect(mockEnsureCompanyStudioChatCapacity).not.toHaveBeenCalled();
    expect(mockStartAiriChatRun).not.toHaveBeenCalled();
  });

  it("answers 403 before 400 when a non-member sends an invalid body", async () => {
    mockSupabase();
    mockVerifyWorkspaceAccess.mockResolvedValue(false);

    const response = await postJson(POST, { content: "" }, params);

    expect(response.status).toBe(403);
  });

  it("turns a failure before the stream into a coded JSON error without internals", async () => {
    mockSupabase();
    mockConnectDB.mockRejectedValue(
      new Error("MongoServerSelectionError: connect ECONNREFUSED 10.0.0.5")
    );

    const response = await postJson(POST, { content: "Hello" }, params);

    expect(response.status).toBe(500);
    expect(response.headers.get("content-type")).not.toContain(
      "text/event-stream"
    );
    const body = await response.json();
    expect(body).toEqual({
      error: "Failed to send Airi message",
      code: "airi_chat_failed",
    });
    expect(JSON.stringify(body)).not.toContain("ECONNREFUSED");
    expect(mockStartAiriChatRun).not.toHaveBeenCalled();
  });

  it("reports a client that disconnects before the stream as cancelled, not as a server failure", async () => {
    mockSupabase();
    const disconnect = new AbortController();
    mockConnectDB.mockImplementation(async () => {
      disconnect.abort();
      throw new Error("socket closed");
    });

    const response = await postJson(POST, { content: "Hello" }, params, {
      signal: disconnect.signal,
    });

    expect(response.status).toBe(499);
    expect(await response.json()).toEqual({
      error: "Request cancelled",
      code: "cancelled",
    });
    expect(mockStartAiriChatRun).not.toHaveBeenCalled();
  });
});
