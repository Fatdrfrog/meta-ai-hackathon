const mockCreateClient = jest.fn();
const mockVerifyWorkspaceAccess = jest.fn();
const mockConnectDB = jest.fn();
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

jest.mock("@/lib/limits/company-limits", () => ({
  ensureCompanyStudioChatCapacity: (...args: unknown[]) =>
    mockEnsureCompanyStudioChatCapacity(...args),
  recordCreativeStudioChat: (...args: unknown[]) =>
    mockRecordCreativeStudioChat(...args),
  buildCompanyStudioChatLimitExceededResponse: (...args: unknown[]) =>
    mockBuildCompanyStudioChatLimitExceededResponse(...args),
}));

// The run itself runs end to end in ../durable-runs.integration.test.ts.
jest.mock("@/lib/airi-chats/runs", () => ({
  startAiriChatRun: (...args: unknown[]) => mockStartAiriChatRun(...args),
  awaitAiriChatRunTurn: (...args: unknown[]) =>
    mockAwaitAiriChatRunTurn(...args),
}));

import { NextResponse } from "next/server";
import { POST } from "./route";
import { mockSupabaseUser } from "@/test-support/supabase-auth-test-utils";
import { postJson } from "../airi-chats-route-test-utils";

const params = { params: Promise.resolve({ workspaceId: "workspace-1" }) };

const turn = {
  userMessage: { id: "message-user", role: "user", content: "Hello" },
  assistantMessage: {
    id: "message-assistant",
    role: "assistant",
    content: "Hi",
  },
  thread: { id: "thread-1", title: "Support Plan" },
};

function mockSupabase(user?: { id: string } | null) {
  return mockSupabaseUser(mockCreateClient, user);
}

describe("/api/workspaces/[workspaceId]/airi-chats/messages", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockConnectDB.mockResolvedValue(undefined);
    mockVerifyWorkspaceAccess.mockResolvedValue(true);
    mockEnsureCompanyStudioChatCapacity.mockResolvedValue({ allowed: true });
    mockRecordCreativeStudioChat.mockResolvedValue(undefined);
    mockStartAiriChatRun.mockResolvedValue({
      kind: "started",
      run: { runId: "run-1", threadId: "thread-1", clientTurnId: "turn-1" },
      outcome: new Promise(() => {}),
    });
    mockAwaitAiriChatRunTurn.mockResolvedValue(turn);
    mockBuildCompanyStudioChatLimitExceededResponse.mockImplementation(() =>
      NextResponse.json(
        { error: "Studio chat limit exceeded" },
        { status: 402 }
      )
    );
  });

  it("rejects unauthorized requests before creating a thread", async () => {
    mockSupabase(null);

    const response = await postJson(POST, { content: "Hello" }, params);

    expect(response.status).toBe(401);
    expect(mockStartAiriChatRun).not.toHaveBeenCalled();
  });

  it("creates the thread only as part of first message submission", async () => {
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
      {
        content: "Hello Airi",
        source: "global",
        selectedSources,
      },
      params
    );

    expect(response.status).toBe(201);
    const [input] = mockStartAiriChatRun.mock.calls[0]!;
    expect(input).toMatchObject({
      supabase,
      workspaceId: "workspace-1",
      userId: "user-1",
      content: "Hello Airi",
      source: "global",
      selectedSources,
    });
    expect(input).not.toHaveProperty("signal");
    expect(await response.json()).toEqual(turn);
  });

  it("preserves the existing studio chat 402 behavior", async () => {
    mockSupabase();
    mockEnsureCompanyStudioChatCapacity.mockResolvedValue({
      allowed: false,
      limit: { limit: 1, used: 1 },
    });

    const response = await postJson(POST, { content: "Hello" }, params);

    expect(response.status).toBe(402);
    expect(mockStartAiriChatRun).not.toHaveBeenCalled();
  });
});
