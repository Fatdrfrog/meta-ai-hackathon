const mockInvalidateRequestsForWorkspace = jest.fn();
const mockConnectDB = jest.fn();
const mockCreateClient = jest.fn();
const mockConversationFind = jest.fn();
const mockConversationUpdateMany = jest.fn();
const mockTriggerRealtimeEvent = jest.fn();

jest.mock("@/lib/cache", () => ({
  invalidateRequestsForWorkspace: (...args: unknown[]) =>
    mockInvalidateRequestsForWorkspace(...args),
}));

jest.mock("@/lib/mongoose", () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockConnectDB(...args),
}));

jest.mock("@/lib/realtime/server", () => ({
  triggerRealtimeEvent: (...args: unknown[]) =>
    mockTriggerRealtimeEvent(...args),
}));

jest.mock("@/lib/supabase/server", () => ({
  createClient: (...args: unknown[]) => mockCreateClient(...args),
}));

jest.mock("@/models/conversation", () => ({
  Conversation: {
    find: (...args: unknown[]) => mockConversationFind(...args),
    updateMany: (...args: unknown[]) => mockConversationUpdateMany(...args),
  },
}));

import { POST } from "./route";

function makeSupabaseClient({
  user = { id: "user-1" },
  access = { workspace_id: "workspace-1" },
}: {
  user?: { id: string } | null;
  access?: { workspace_id: string } | null;
} = {}) {
  return {
    auth: {
      getUser: jest.fn(async () => ({ data: { user } })),
    },
    from: jest.fn(() => ({
      select: jest.fn(() => ({
        eq: jest.fn(() => ({
          eq: jest.fn(() => ({
            maybeSingle: jest.fn(async () => ({ data: access })),
          })),
        })),
      })),
    })),
  };
}

function mockUnreadConversationFind(rows: Array<{ _id: string }>) {
  mockConversationFind.mockReturnValue({
    select: jest.fn(() => ({
      limit: jest.fn(() => ({
        lean: jest.fn(() => ({
          exec: jest.fn(async () => rows),
        })),
      })),
    })),
  });
}

function makeRequest(body: string) {
  return new Request("http://localhost/api/requests/read-all", {
    method: "POST",
    body,
  });
}

describe("POST /api/requests/read-all", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCreateClient.mockResolvedValue(makeSupabaseClient());
    mockConnectDB.mockResolvedValue(undefined);
    mockUnreadConversationFind([{ _id: "conversation-1" }]);
    mockConversationUpdateMany.mockResolvedValue({
      modifiedCount: 1,
      matchedCount: 1,
    });
    mockInvalidateRequestsForWorkspace.mockResolvedValue(undefined);
    mockTriggerRealtimeEvent.mockResolvedValue(undefined);
  });

  it("retains the normalized updateMany and bounded legacy fanout", async () => {
    const response = await POST(
      makeRequest(JSON.stringify({ workspaceId: "  workspace-1  " }))
    );

    expect(response.status).toBe(200);
    expect(mockConversationFind).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      is_read_by_manager: { $ne: true },
    });
    expect(mockConversationUpdateMany).toHaveBeenCalledWith(
      {
        workspaceId: "workspace-1",
        is_read_by_manager: { $ne: true },
      },
      { $set: { is_read_by_manager: true } }
    );
    expect(mockInvalidateRequestsForWorkspace).toHaveBeenCalledWith(
      "workspace-1"
    );
    expect(mockTriggerRealtimeEvent).toHaveBeenCalledWith(
      "tenant-workspace-1",
      "requests.update",
      {
        _id: "conversation-1",
        conversationId: "conversation-1",
        workspaceId: "workspace-1",
      }
    );
  });

  it("returns only the read time, never counts", async () => {
    const response = await POST(
      makeRequest(JSON.stringify({ workspaceId: "workspace-1" }))
    );
    const result = await response.json();

    expect(response.status).toBe(200);
    expect(Object.keys(result)).toEqual(["readAt"]);
    expect(new Date(result.readAt).toISOString()).toBe(result.readAt);
  });

  it("does not publish realtime when nothing changed", async () => {
    mockConversationUpdateMany.mockResolvedValue({
      modifiedCount: 0,
      matchedCount: 0,
    });

    const response = await POST(
      makeRequest(JSON.stringify({ workspaceId: "workspace-1" }))
    );

    expect(response.status).toBe(200);
    expect(mockTriggerRealtimeEvent).not.toHaveBeenCalled();
  });

  it.each([
    "{",
    "null",
    "[]",
    '"workspace-1"',
    "1",
    "{}",
    '{"workspaceId":""}',
    '{"workspaceId":"   "}',
    '{"workspaceId":"workspace-1","sourceWatermark":"ffffffffffffffff"}',
    '{"workspaceId":"workspace-1","unknown":true}',
  ])("rejects invalid body %s before Mongo", async body => {
    const response = await POST(makeRequest(body));

    expect(response.status).toBe(400);
    expect(mockConnectDB).not.toHaveBeenCalled();
    expect(mockConversationFind).not.toHaveBeenCalled();
    expect(mockConversationUpdateMany).not.toHaveBeenCalled();
  });
});
