const mockSupabaseFrom = jest.fn();
const mockSendTelegramMessage = jest.fn();
const mockChatFindOneAndUpdate = jest.fn();

jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: {
    from: (...args: unknown[]) => mockSupabaseFrom(...args),
  },
}));

jest.mock("@/lib/telegram", () => ({
  sendTelegramMessage: (...args: unknown[]) => mockSendTelegramMessage(...args),
}));

jest.mock("@/models/chat", () => ({
  __esModule: true,
  default: {
    findOneAndUpdate: (...args: unknown[]) => mockChatFindOneAndUpdate(...args),
  },
}));

import { handleBusinessConnectionUpdate } from "./handleBusinessConnectionUpdate";

function createSourceQuery() {
  return {
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    maybeSingle: jest.fn().mockResolvedValue({
      data: {
        id: "telegram-source-1",
        workspace_id: "workspace-1",
        type: "telegram",
      },
      error: null,
    }),
  };
}

function createBusinessConnectionsQuery() {
  return {
    delete: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    neq: jest.fn().mockReturnThis(),
    upsert: jest.fn().mockResolvedValue({ data: null, error: null }),
  };
}

describe("handleBusinessConnectionUpdate", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSendTelegramMessage.mockResolvedValue({
      messageId: 1,
      date: 1711100000,
    });
    mockChatFindOneAndUpdate.mockResolvedValue(null);
  });

  it("does not infer Business can_reply permission when Telegram omits the rights flag", async () => {
    const businessConnectionsQuery = createBusinessConnectionsQuery();
    mockSupabaseFrom.mockImplementation((table: string) => {
      if (table === "sources") return createSourceQuery();
      if (table === "telegram_business_connections") {
        return businessConnectionsQuery;
      }
      throw new Error(`Unexpected table: ${table}`);
    });

    await handleBusinessConnectionUpdate(
      {
        id: "business-connection-1",
        user: {
          id: 123456,
          is_bot: false,
          first_name: "Aibek",
        },
        user_chat_id: 777000,
        date: 1711100000,
        is_enabled: true,
      },
      "telegram-source-1",
      "telegram-token"
    );

    expect(businessConnectionsQuery.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        business_connection_id: "business-connection-1",
        workspace_id: "workspace-1",
        source_id: "telegram-source-1",
        can_reply: false,
        is_enabled: true,
      }),
      { onConflict: "business_connection_id" }
    );
  });
});
