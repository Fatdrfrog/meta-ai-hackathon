const mockConnectDB = jest.fn();
const mockCreateClient = jest.fn();
const mockConversationAggregate = jest.fn();

jest.mock("@/lib/mongoose", () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockConnectDB(...args),
}));

jest.mock("@/lib/supabase/server", () => ({
  createClient: (...args: unknown[]) => mockCreateClient(...args),
}));

jest.mock("@/models/conversation", () => ({
  Conversation: {
    aggregate: (...args: unknown[]) => mockConversationAggregate(...args),
  },
}));

import { GET } from "@/app/api/internal-labels/suggestions/route";
import { buildCurrentConversationClassificationFilter } from "@icecore/shared/lib/conversation-classification-freshness";
import { supabaseAuth } from "@/test-support/supabase-auth-test-utils";

function buildSupabaseClient() {
  const membershipQuery: {
    select: jest.Mock;
    eq: jest.Mock;
    maybeSingle: jest.Mock;
  } = {
    select: jest.fn(),
    eq: jest.fn(),
    maybeSingle: jest.fn().mockResolvedValue({
      data: { role: "manager" },
      error: null,
    }),
  };
  membershipQuery.select.mockReturnValue(membershipQuery);
  membershipQuery.eq.mockReturnValue(membershipQuery);

  return {
    auth: supabaseAuth(),
    from: jest.fn(() => membershipQuery),
  };
}

describe("internal label suggestion classification gate", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockConnectDB.mockResolvedValue(undefined);
    mockCreateClient.mockResolvedValue(buildSupabaseClient());
    mockConversationAggregate.mockResolvedValue([{ _id: "vip", count: 3 }]);
  });

  it("adds the exact current-classification predicate with a category", async () => {
    const response = await GET(
      new Request(
        "http://localhost/api/internal-labels/suggestions?workspaceId=ws-1&category=Sales"
      )
    );

    expect(response.status).toBe(200);
    const pipeline = mockConversationAggregate.mock.calls[0]?.[0] as Array<{
      $match?: Record<string, unknown>;
    }>;
    expect(pipeline[0]?.$match).toEqual({
      workspaceId: "ws-1",
      channel: "whatsapp",
      "classification.category": "Sales",
      ...buildCurrentConversationClassificationFilter(),
    });
  });

  it("leaves the no-category aggregation unchanged", async () => {
    const response = await GET(
      new Request(
        "http://localhost/api/internal-labels/suggestions?workspaceId=ws-1"
      )
    );

    expect(response.status).toBe(200);
    const pipeline = mockConversationAggregate.mock.calls[0]?.[0] as Array<{
      $match?: Record<string, unknown>;
    }>;
    expect(pipeline[0]?.$match).toEqual({
      workspaceId: "ws-1",
      channel: "whatsapp",
    });
    expect(pipeline[0]?.$match).not.toHaveProperty("$expr");
  });
});
