const mockCreateClient = jest.fn();
const mockVerifyWorkspaceAccess = jest.fn();
const mockListAiriChatSourceOptions = jest.fn();

jest.mock("@/lib/supabase/server", () => ({
  createClient: (...args: unknown[]) => mockCreateClient(...args),
}));

jest.mock("@/lib/sources/utils", () => ({
  verifyWorkspaceAccess: (...args: unknown[]) =>
    mockVerifyWorkspaceAccess(...args),
}));

jest.mock("@/lib/airi-chats/sources", () => ({
  listAiriChatSourceOptions: (...args: unknown[]) =>
    mockListAiriChatSourceOptions(...args),
}));

import { GET } from "./route";
import { mockSupabaseUser } from "@/test-support/supabase-auth-test-utils";
import { request } from "../airi-chats-route-test-utils";

const params = { params: Promise.resolve({ workspaceId: "workspace-1" }) };

function mockSupabase(user?: { id: string } | null) {
  return mockSupabaseUser(mockCreateClient, user);
}

describe("/api/workspaces/[workspaceId]/airi-chats/sources", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockVerifyWorkspaceAccess.mockResolvedValue(true);
    mockListAiriChatSourceOptions.mockResolvedValue([
      {
        id: "connector:whatsapp:wa-1",
        group: "Sources",
        label: "Main WhatsApp",
      },
    ]);
  });

  it("rejects unauthorized requests", async () => {
    mockSupabase(null);

    const response = await GET(request(), params);

    expect(response.status).toBe(401);
    expect(mockListAiriChatSourceOptions).not.toHaveBeenCalled();
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

  it("returns workspace-scoped source options with query and limit", async () => {
    const supabase = mockSupabase();

    const response = await GET(
      request("http://localhost/api?q=pricing&limit=12"),
      params
    );

    expect(response.status).toBe(200);
    expect(mockListAiriChatSourceOptions).toHaveBeenCalledWith({
      supabase,
      workspaceId: "workspace-1",
      userId: "user-1",
      query: "pricing",
      limit: 12,
      mode: "sources",
    });
    expect(await response.json()).toEqual({
      sources: [
        {
          id: "connector:whatsapp:wa-1",
          group: "Sources",
          label: "Main WhatsApp",
        },
      ],
    });
  });

  it("switches the catalog into chat-picker mode", async () => {
    mockSupabase();

    const response = await GET(
      request("http://localhost/api?mode=chats&q=support"),
      params
    );

    expect(response.status).toBe(200);
    expect(mockListAiriChatSourceOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "chats",
        query: "support",
      })
    );
  });
});
