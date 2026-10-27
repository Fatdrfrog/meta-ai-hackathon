const mockGetUser = jest.fn();
const mockMaybeSingle = jest.fn();
const mockAggregate = jest.fn();
const mockCustomerFind = jest.fn();
const mockSupabaseAdminFrom = jest.fn();
const mockFetchTelegramSubscriberContacts = jest.fn();
const mockScheduleTelegramSubscriberBackfill = jest.fn();

jest.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      getUser: mockGetUser,
    },
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: mockMaybeSingle,
          }),
        }),
      }),
    }),
  }),
}));

jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: {
    from: (...args: unknown[]) => mockSupabaseAdminFrom(...args),
  },
}));

jest.mock("@/lib/mongoose", () => jest.fn(async () => undefined));

jest.mock("@/lib/telegram/subscribers", () => ({
  fetchTelegramSubscriberContacts: (...args: unknown[]) =>
    mockFetchTelegramSubscriberContacts(...args),
  scheduleTelegramSubscriberBackfill: (...args: unknown[]) =>
    mockScheduleTelegramSubscriberBackfill(...args),
}));

jest.mock("@/models/conversation", () => ({
  Conversation: {
    aggregate: (...args: unknown[]) => mockAggregate(...args),
  },
}));

jest.mock("@/models/customer", () => ({
  __esModule: true,
  default: {
    find: (...args: unknown[]) => mockCustomerFind(...args),
  },
}));

jest.mock("@/models/chat", () => ({}));
jest.mock("@/models/user", () => ({}));

import { GET } from "./route";

function mockCustomers(rows: unknown[]) {
  const lean = jest.fn(async () => rows);
  const limit = jest.fn(() => ({ lean }));
  const select = jest.fn(() => ({ limit }));
  mockCustomerFind.mockReturnValue({ select });
  return { select, limit, lean };
}

function makeRequest(url: string) {
  return new Request(url);
}

describe("contacts API", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetUser.mockResolvedValue({ data: { user: { id: "user-1" } } });
    mockMaybeSingle.mockResolvedValue({ data: { role: "admin" } });
    mockAggregate.mockResolvedValue([]);
    mockCustomers([]);
    mockFetchTelegramSubscriberContacts.mockResolvedValue([]);
    mockSupabaseAdminFrom.mockImplementation((table: string) => {
      if (table === "telegram_business_connections") {
        return {
          select: jest.fn().mockReturnThis(),
          eq: jest.fn().mockReturnThis(),
          in: jest.fn().mockResolvedValue({
            data: [
              {
                business_connection_id: "business-connection-1",
              },
            ],
            error: null,
          }),
        };
      }
      throw new Error(`Unexpected Supabase admin table: ${table}`);
    });
  });

  it("returns synced WhatsApp customer contacts even when they have no conversations", async () => {
    mockCustomers([
      {
        _id: "customer-1",
        displayName: "Aibek",
        identities: [
          {
            type: "phone",
            channel: "whatsapp",
            sourceId: "source-1",
            normalizedValue: "77009990000",
          },
        ],
        profileSummary: {
          contactPoints: {
            phones: ["77009990000"],
          },
        },
      },
    ]);

    const response = await GET(
      makeRequest(
        "http://localhost/api/contacts?workspaceId=workspace-1&channel=whatsapp&sourceIds=source-1"
      )
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      data: [
        {
          identifier: "wa_77009990000",
          channel: "whatsapp",
          sourceId: "source-1",
          name: "Aibek",
        },
      ],
    });
  });

  it("uses a synced customer display name over an Unknown conversation fallback", async () => {
    mockAggregate.mockResolvedValue([
      {
        identifier: "wa_77009990000",
        channel: "whatsapp",
        name: "Unknown",
      },
    ]);
    mockCustomers([
      {
        _id: "customer-1",
        displayName: "Aibek",
        identities: [
          {
            type: "phone",
            channel: "whatsapp",
            normalizedValue: "77009990000",
          },
        ],
        profileSummary: {
          contactPoints: {
            phones: ["77009990000"],
          },
        },
      },
    ]);

    const response = await GET(
      makeRequest(
        "http://localhost/api/contacts?workspaceId=workspace-1&channel=whatsapp"
      )
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      data: [
        {
          identifier: "wa_77009990000",
          channel: "whatsapp",
          sourceId: null,
          name: "Aibek",
        },
      ],
    });
  });

  it("does not duplicate profile phones when a source-scoped identity already has the number", async () => {
    mockCustomers([
      {
        _id: "customer-1",
        displayName: "Aibek",
        identities: [
          {
            type: "phone",
            channel: "whatsapp",
            sourceId: "source-1",
            normalizedValue: "77009990000",
          },
        ],
        profileSummary: {
          contactPoints: {
            phones: ["77009990000"],
          },
        },
      },
    ]);

    const response = await GET(
      makeRequest(
        "http://localhost/api/contacts?workspaceId=workspace-1&channel=whatsapp"
      )
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.data).toEqual([
      {
        identifier: "wa_77009990000",
        channel: "whatsapp",
        sourceId: "source-1",
        name: "Aibek",
      },
    ]);
  });

  it("does not treat generic profile phones as WhatsApp contacts", async () => {
    mockCustomers([
      {
        _id: "customer-ig",
        displayName: "Instagram Lead",
        identities: [
          {
            type: "ig_sid",
            channel: "instagram",
            sourceId: "ig-1",
            value: "ig-user",
          },
        ],
        profileSummary: {
          contactPoints: {
            phones: ["77001112233"],
          },
        },
      },
    ]);

    const response = await GET(
      makeRequest(
        "http://localhost/api/contacts?workspaceId=workspace-1&channel=whatsapp"
      )
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(mockCustomerFind).toHaveBeenCalledWith(
      expect.objectContaining({
        $and: [
          {
            identities: {
              $elemMatch: { type: "phone", channel: "whatsapp" },
            },
          },
        ],
      })
    );
    expect(payload.data).toEqual([]);
  });

  it("limits Telegram contacts to bot subscribers and active Business reply-window conversations", async () => {
    await GET(
      makeRequest(
        "http://localhost/api/contacts?workspaceId=workspace-1&channel=telegram&sourceIds=telegram-source-1"
      )
    );

    const pipeline = mockAggregate.mock.calls[0]?.[0] as Array<
      Record<string, unknown>
    >;
    const matchStage = pipeline[0] as {
      $match: Record<string, unknown>;
    };
    const projectStage = pipeline.find(stage => "$project" in stage) as {
      $project: Record<string, unknown>;
    };

    expect(matchStage.$match).toEqual(
      expect.objectContaining({
        workspaceId: "workspace-1",
        channel: "telegram",
        sourceId: { $in: ["telegram-source-1"] },
        $or: expect.any(Array),
      })
    );
    expect(JSON.stringify(matchStage.$match)).toContain("first_inbound_at");
    expect(JSON.stringify(matchStage.$match)).toContain(
      "business-connection-1"
    );
    expect(JSON.stringify(projectStage.$project.identifier)).toContain(
      '"$chat"'
    );
  });

  it("includes imported Telegram subscribers in contact search results", async () => {
    mockAggregate.mockResolvedValue([
      {
        identifier: "123",
        channel: "telegram",
        sourceId: "telegram-source-1",
        name: "Existing",
      },
    ]);
    mockFetchTelegramSubscriberContacts.mockResolvedValue([
      {
        identifier: "456",
        channel: "telegram",
        sourceId: "telegram-source-1",
        name: "Imported Ada",
        status: "imported",
        origin: "import",
      },
    ]);

    const response = await GET(
      makeRequest(
        "http://localhost/api/contacts?workspaceId=workspace-1&channel=telegram&sourceIds=telegram-source-1&search=ada"
      )
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(mockFetchTelegramSubscriberContacts).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      sourceIds: ["telegram-source-1"],
      search: "ada",
      limit: 200,
    });
    expect(mockScheduleTelegramSubscriberBackfill).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      sourceId: "telegram-source-1",
      reason: "contacts_api",
    });
    expect(payload.data).toEqual([
      {
        identifier: "123",
        channel: "telegram",
        sourceId: "telegram-source-1",
        name: "Existing",
      },
      {
        identifier: "456",
        channel: "telegram",
        sourceId: "telegram-source-1",
        name: "Imported Ada",
        status: "imported",
        origin: "import",
      },
    ]);
  });
});
