const mockGetRequestsData = jest.fn();
const mockGetSupabaseRouteAuth = jest.fn();
const mockIsSupabaseRouteAuthError = jest.fn();
const mockValidateOptionalConversationChannelParam = jest.fn();
const mockFlushServerLogsAfterResponse = jest.fn();

jest.mock("@/features/panel/requests/data-projection", () => ({
  getRequestsData: (...args: unknown[]) => mockGetRequestsData(...args),
  RequestsProjectionNotReadyError: class RequestsProjectionNotReadyError extends Error {},
}));

jest.mock("@/lib/api/conversation-channel-query", () => ({
  validateOptionalConversationChannelParam: (...args: unknown[]) =>
    mockValidateOptionalConversationChannelParam(...args),
}));

jest.mock("@/lib/observability/server-logs", () => {
  const serverLogger = {
    error: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
  };

  return {
    __getRequestsRouteTestLogger: () => serverLogger,
    createServerLogger: () => serverLogger,
    flushServerLogsAfterResponse: (...args: unknown[]) =>
      mockFlushServerLogsAfterResponse(...args),
  };
});

jest.mock("@/lib/supabase/route-auth", () => ({
  getSupabaseRouteAuth: (...args: unknown[]) =>
    mockGetSupabaseRouteAuth(...args),
  isSupabaseRouteAuthError: (...args: unknown[]) =>
    mockIsSupabaseRouteAuthError(...args),
}));

import { GET } from "./route";

function getMockServerLogger(): {
  error: jest.Mock;
  info: jest.Mock;
  warn: jest.Mock;
} {
  return (
    jest.requireMock("@/lib/observability/server-logs") as {
      __getRequestsRouteTestLogger: () => {
        error: jest.Mock;
        info: jest.Mock;
        warn: jest.Mock;
      };
    }
  ).__getRequestsRouteTestLogger();
}

function createSupabaseClient(options?: { hasMembership?: boolean }) {
  return {
    from: jest.fn(() => ({
      select: jest.fn(() => ({
        eq: jest.fn(() => ({
          eq: jest.fn(() => ({
            maybeSingle: jest.fn(async () => ({
              data:
                options?.hasMembership === false
                  ? null
                  : { workspace_id: "workspace-1" },
              error: null,
            })),
          })),
        })),
      })),
    })),
  };
}

describe("GET /api/requests", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetSupabaseRouteAuth.mockResolvedValue({
      supabase: createSupabaseClient(),
      user: { id: "user-1" },
    });
    mockIsSupabaseRouteAuthError.mockReturnValue(false);
    mockValidateOptionalConversationChannelParam.mockReturnValue({
      ok: true,
      value: null,
    });
    mockGetRequestsData.mockResolvedValue({
      data: [],
      pagination: {
        page: 1,
        limit: 1,
        totalCount: 0,
        totalPages: 0,
        hasNextPage: false,
        hasPrevPage: false,
      },
    });
  });

  it("prevents browser caching for unread count responses", async () => {
    const response = await GET(
      new Request(
        "http://localhost/api/requests?workspaceId=workspace-1&unread=true&countOnly=true&page=1&limit=1&includeChannels=false"
      )
    );

    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("prevents caching of realtime row hydration responses", async () => {
    const response = await GET(
      new Request(
        "http://localhost/api/requests?workspaceId=workspace-1&conversationIds=conv-1&includeChannels=false",
        { headers: { "x-airi-realtime-hydration": "1" } }
      )
    );
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("bypasses the server response cache for realtime hydration reads", async () => {
    await GET(
      new Request("http://localhost/api/requests?workspaceId=workspace-1", {
        headers: {
          "x-airi-realtime-hydration": "1",
        },
      })
    );

    expect(mockGetRequestsData).toHaveBeenCalledWith(
      "workspace-1",
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        bypassCache: true,
      })
    );
  });

  it("passes Airi replied filters through without browser caching", async () => {
    const response = await GET(
      new Request(
        "http://localhost/api/requests?workspaceId=workspace-1&airiReplied=true&page=1&limit=20"
      )
    );

    expect(mockGetRequestsData).toHaveBeenCalledWith(
      "workspace-1",
      expect.objectContaining({
        airiReplied: true,
        page: 1,
        limit: 20,
      }),
      expect.anything(),
      expect.objectContaining({
        includeChannels: true,
        countOnly: false,
      })
    );
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("keeps short private caching for ordinary requests", async () => {
    const response = await GET(
      new Request(
        "http://localhost/api/requests?workspaceId=workspace-1&page=1&limit=20"
      )
    );

    expect(response.headers.get("Cache-Control")).toBe(
      "private, max-age=5, stale-while-revalidate=10"
    );
  });

  it("keeps auth rejection ahead of list work", async () => {
    mockIsSupabaseRouteAuthError.mockReturnValueOnce(true);

    const response = await GET(
      new Request("http://localhost/api/requests?workspaceId=workspace-1")
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("Cache-Control")).toBeNull();
    expect(mockGetRequestsData).not.toHaveBeenCalled();
  });

  it("keeps missing-workspace rejection ahead of list work", async () => {
    const response = await GET(new Request("http://localhost/api/requests"));

    expect(response.status).toBe(400);
    expect(mockGetRequestsData).not.toHaveBeenCalled();
  });

  it("keeps membership rejection ahead of list work", async () => {
    mockGetSupabaseRouteAuth.mockResolvedValueOnce({
      supabase: createSupabaseClient({ hasMembership: false }),
      user: { id: "user-1" },
    });

    const response = await GET(
      new Request("http://localhost/api/requests?workspaceId=workspace-1")
    );

    expect(response.status).toBe(403);
    expect(mockGetRequestsData).not.toHaveBeenCalled();
  });

  it("keeps channel rejection ahead of list work", async () => {
    mockValidateOptionalConversationChannelParam.mockReturnValueOnce({
      ok: false,
      response: new Response(JSON.stringify({ error: "Invalid channel" }), {
        status: 400,
      }),
    });

    const response = await GET(
      new Request(
        "http://localhost/api/requests?workspaceId=workspace-1&channel=invalid"
      )
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid channel" });
    expect(mockGetRequestsData).not.toHaveBeenCalled();
  });

  it("logs bounded counts and outcomes without raw IDs", async () => {
    const rawConversationId1 = "65f000000000000000000001";
    const rawConversationId2 = "65f000000000000000000002";
    mockGetRequestsData.mockResolvedValueOnce({
      data: [{ _id: rawConversationId1 }],
      pagination: {
        page: 1,
        limit: 20,
        totalCount: 1,
        totalPages: 1,
        hasNextPage: false,
        hasPrevPage: false,
      },
    });
    const request = new Request(
      `http://localhost/api/requests?workspaceId=workspace-1&conversationIds=${rawConversationId1},${rawConversationId2}`,
      { headers: { "x-airi-realtime-hydration": "1" } }
    );

    const response = await GET(request);
    const mockServerLogger = getMockServerLogger();

    expect(response.status).toBe(200);
    expect(mockServerLogger.info).toHaveBeenCalledTimes(1);
    const loggerArguments = JSON.stringify(mockServerLogger.info.mock.calls);
    expect(loggerArguments).not.toContain("workspace-1");
    expect(loggerArguments).not.toContain(rawConversationId1);
    expect(loggerArguments).not.toContain(rawConversationId2);
    expect(mockServerLogger.info).toHaveBeenCalledWith(
      "Requests realtime hydration completed",
      expect.objectContaining({
        conversationIdCount: 2,
        outcome: "success",
        returnedCount: 1,
        statusCode: 200,
      })
    );
  });
});
