const mockCreateClient = jest.fn();
const mockVerifyWorkspaceAccess = jest.fn();
const mockConnectDB = jest.fn();
const mockGetAiriChatThreadForUser = jest.fn();
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
}));

jest.mock("@/lib/limits/company-limits", () => ({
  ensureCompanyStudioChatCapacity: (...args: unknown[]) =>
    mockEnsureCompanyStudioChatCapacity(...args),
  recordCreativeStudioChat: (...args: unknown[]) =>
    mockRecordCreativeStudioChat(...args),
  buildCompanyStudioChatLimitExceededResponse: (...args: unknown[]) =>
    mockBuildCompanyStudioChatLimitExceededResponse(...args),
}));

// The run itself runs end to end in ../../../durable-runs.integration.test.ts.
const mockStartAiriChatRun = jest.fn();
const mockCreateAiriChatRunStreamResponse = jest.fn();
jest.mock("@/lib/airi-chats/runs", () => ({
  startAiriChatRun: (...args: unknown[]) => mockStartAiriChatRun(...args),
  createAiriChatRunStreamResponse: (...args: unknown[]) =>
    mockCreateAiriChatRunStreamResponse(...args),
}));

import { NextResponse } from "next/server";
import { POST, maxDuration } from "./route";
import { maxDuration as firstMessageMaxDuration } from "../../../messages/stream/route";
import { maxDuration as jsonMaxDuration } from "../route";
import { maxDuration as firstJsonMaxDuration } from "../../../messages/route";
import { maxDuration as resumeMaxDuration } from "../../runs/[runId]/stream/route";
import { mockSupabaseUser } from "@/test-support/supabase-auth-test-utils";
import { postJson } from "../../../airi-chats-route-test-utils";

it("declares a 300 s budget on every Airi chat message route", () => {
  expect([
    maxDuration,
    firstMessageMaxDuration,
    jsonMaxDuration,
    firstJsonMaxDuration,
    resumeMaxDuration,
  ]).toEqual([300, 300, 300, 300, 300]);
});

const threadId = "507f1f77bcf86cd799439011";
const params = {
  params: Promise.resolve({ workspaceId: "workspace-1", threadId }),
};

function mockSupabase(user?: { id: string } | null) {
  return mockSupabaseUser(mockCreateClient, user);
}

describe("/api/workspaces/[workspaceId]/airi-chats/[threadId]/messages/stream", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockConnectDB.mockResolvedValue(undefined);
    mockVerifyWorkspaceAccess.mockResolvedValue(true);
    mockGetAiriChatThreadForUser.mockResolvedValue({ id: threadId });
    mockEnsureCompanyStudioChatCapacity.mockResolvedValue({ allowed: true });
    mockRecordCreativeStudioChat.mockResolvedValue(undefined);
    mockBuildCompanyStudioChatLimitExceededResponse.mockImplementation(() =>
      NextResponse.json(
        { error: "Studio chat limit exceeded" },
        { status: 402 }
      )
    );
    mockCreateAiriChatRunStreamResponse.mockImplementation(
      () => new Response("event: run\n\n")
    );
  });

  it("returns not found before opening a stream when the thread is inaccessible", async () => {
    mockSupabase();
    mockGetAiriChatThreadForUser.mockResolvedValue(null);

    const response = await postJson(POST, { content: "Hello" }, params);

    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).not.toContain(
      "text/event-stream"
    );
    expect(mockStartAiriChatRun).not.toHaveBeenCalled();
  });

  it("preserves the existing 402 response before generation", async () => {
    mockSupabase();
    mockEnsureCompanyStudioChatCapacity.mockResolvedValue({
      allowed: false,
      limit: { limit: 1, used: 1 },
    });

    const response = await postJson(POST, { content: "Hello" }, params);

    expect(response.status).toBe(402);
    expect(mockStartAiriChatRun).not.toHaveBeenCalled();
  });

  it("reports a client that disconnects before the stream as cancelled, not as a server failure", async () => {
    mockSupabase();
    const disconnect = new AbortController();
    mockGetAiriChatThreadForUser.mockImplementation(async () => {
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

  it("starts a run with the client turn id, never the request's signal", async () => {
    const supabase = mockSupabase();
    mockStartAiriChatRun.mockResolvedValue({
      kind: "started",
      run: { runId: "run-1", threadId, clientTurnId: "turn-1" },
      outcome: new Promise(() => {}),
    });
    const clientTurnId = "8a6e0c1e-5f7b-4d8e-9a51-2a8b7f3f0c11";

    const response = await postJson(
      POST,
      { content: "Hello Airi", clientTurnId },
      params
    );

    expect(response.status).toBe(200);
    const [input] = mockStartAiriChatRun.mock.calls[0]!;
    expect(input).toMatchObject({
      supabase,
      workspaceId: "workspace-1",
      userId: "user-1",
      threadId,
      thread: { id: threadId },
      clientTurnId,
      content: "Hello Airi",
    });
    expect(input).not.toHaveProperty("signal");
    expect(mockCreateAiriChatRunStreamResponse).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run-1" })
    );

    // The quota callback counts answered turns only: not failed or busy
    // (retryable) replies.
    input.onTurnSaved({
      assistantMessage: { metadata: { failed: true } },
      thread: { id: threadId },
    });
    input.onTurnSaved({
      assistantMessage: {
        metadata: {
          retryable: true,
          errorCode: "provider_resource_exhausted",
        },
      },
      thread: { id: threadId },
    });
    input.onTurnSaved({
      assistantMessage: { metadata: {} },
      thread: { id: threadId },
    });
    await new Promise(resolve => setImmediate(resolve));
    expect(mockRecordCreativeStudioChat).toHaveBeenCalledTimes(1);
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
    expect(mockCreateAiriChatRunStreamResponse).not.toHaveBeenCalled();
  });

  it("rejects a clientTurnId that is not a uuid before starting a run", async () => {
    mockSupabase();

    const response = await postJson(
      POST,
      { content: "Hello", clientTurnId: "nope" },
      params
    );

    expect(response.status).toBe(400);
    expect(mockStartAiriChatRun).not.toHaveBeenCalled();
  });
});
