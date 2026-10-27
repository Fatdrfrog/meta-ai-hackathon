import { NextRequest } from "next/server";

const mockConfirmMutation = jest.fn();
const mockReconcileMutation = jest.fn();
const mockConnectDB = jest.fn();
const mockVerifyWorkspaceAccess = jest.fn();
const mockGetSupabaseRouteAuth = jest.fn();

jest.mock("@/lib/mongoose", () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockConnectDB(...args),
}));

jest.mock("@/lib/airi-chats/service", () => ({
  confirmAiriChatMetaAdsMcpMutation: (...args: unknown[]) =>
    mockConfirmMutation(...args),
  reconcileAiriChatMetaAdsMcpMutation: (...args: unknown[]) =>
    mockReconcileMutation(...args),
}));

jest.mock("@/lib/sources/utils", () => ({
  verifyWorkspaceAccess: (...args: unknown[]) =>
    mockVerifyWorkspaceAccess(...args),
}));

jest.mock("@/lib/supabase/route-auth", () => ({
  getSupabaseRouteAuth: (...args: unknown[]) =>
    mockGetSupabaseRouteAuth(...args),
  isSupabaseRouteAuthError: () => false,
}));

import { PATCH, POST } from "./route";

const THREAD_ID = "507f1f77bcf86cd799439011";
const MESSAGE_ID = "507f1f77bcf86cd799439012";

function context(): {
  params: Promise<{ workspaceId: string; threadId: string }>;
} {
  return {
    params: Promise.resolve({
      workspaceId: "workspace-1",
      threadId: THREAD_ID,
    }),
  };
}

describe("Airi Meta Ads MCP confirmation route", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetSupabaseRouteAuth.mockResolvedValue({
      user: { id: "user-1" },
      supabase: { auth: "client" },
    });
    mockVerifyWorkspaceAccess.mockResolvedValue(true);
    mockConnectDB.mockResolvedValue(undefined);
  });

  it("returns 400 for malformed JSON without performing side effects", async () => {
    const request = new NextRequest("http://localhost/api/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });

    const response = await POST(request, context());

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Invalid JSON body",
    });
    expect(mockConnectDB).not.toHaveBeenCalled();
    expect(mockConfirmMutation).not.toHaveBeenCalled();
  });

  it("returns 404 for an invalid message ObjectId", async () => {
    const request = new NextRequest("http://localhost/api/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messageId: "abc",
        mutationId: "mutation-1",
        transactionDigest: "a".repeat(64),
      }),
    });

    const response = await POST(request, context());

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "Message not found",
    });
    expect(mockConnectDB).not.toHaveBeenCalled();
    expect(mockConfirmMutation).not.toHaveBeenCalled();
  });

  it("forwards an explicit reconciliation without confirming again", async () => {
    mockReconcileMutation.mockResolvedValue({
      assistantMessage: { id: "result-1" },
      confirmedMutationId: "mutation-1",
      executionStatus: "succeeded",
      replayed: false,
    });
    const request = new NextRequest("http://localhost/api/confirm", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messageId: MESSAGE_ID,
        mutationId: "mutation-1",
        resolution: "succeeded",
        note: "Visible in Ads Manager",
      }),
    });

    const response = await PATCH(request, context());

    expect(response.status).toBe(200);
    expect(mockReconcileMutation).toHaveBeenCalledWith({
      supabase: { auth: "client" },
      workspaceId: "workspace-1",
      userId: "user-1",
      threadId: THREAD_ID,
      messageId: MESSAGE_ID,
      mutationId: "mutation-1",
      resolution: "succeeded",
      note: "Visible in Ads Manager",
    });
    expect(mockConfirmMutation).not.toHaveBeenCalled();
  });
});
