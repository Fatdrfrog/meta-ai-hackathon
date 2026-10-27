const mockCreateClient = jest.fn();
const mockVerifyWorkspaceAccess = jest.fn();
const mockGetWorkspaceEmailProviderStatus = jest.fn();
const mockGetCompanyIdForWorkspace = jest.fn();
const mockResolveCompanyWhatsAppAccessToken = jest.fn();

jest.mock("@/lib/supabase/server", () => ({
  createClient: (...args: unknown[]) => mockCreateClient(...args),
}));

jest.mock("@/lib/supabase/queries", () => ({
  checkUserWorkspaceAccess: (...args: unknown[]) =>
    mockVerifyWorkspaceAccess(...args),
}));

jest.mock("@/lib/email/provider-config", () => ({
  getWorkspaceEmailProviderStatus: (...args: unknown[]) =>
    mockGetWorkspaceEmailProviderStatus(...args),
}));

jest.mock("@/lib/supabase/company-users", () => ({
  getCompanyIdForWorkspace: (...args: unknown[]) =>
    mockGetCompanyIdForWorkspace(...args),
}));

jest.mock("@/lib/whatsapp/company-access-token", () => ({
  resolveCompanyWhatsAppAccessToken: (...args: unknown[]) =>
    mockResolveCompanyWhatsAppAccessToken(...args),
}));

import type { NextRequest } from "next/server";
import { GET } from "./route";
import { createSupabaseQueryMock } from "@/test-support/supabase-query-test-utils";

const params = { params: Promise.resolve({ workspaceId: "workspace-1" }) };

function request(
  url = "http://localhost/api/workspaces/workspace-1/integrations"
) {
  return new Request(url) as unknown as NextRequest;
}

function mockSupabase(
  params: {
    user?: { id: string } | null;
    sources?: unknown[];
    emailSources?: unknown[];
  } = {}
) {
  const sourcesQuery = createSupabaseQueryMock({
    data: params.sources ?? [],
    error: null,
  });
  const emailSourcesQuery = createSupabaseQueryMock({
    data: params.emailSources ?? [],
    error: null,
  });
  const supabase = {
    auth: {
      getSession: async () => ({ data: { session: null } }),
      getUser: jest.fn(async () => ({
        data: {
          user: params.user === undefined ? { id: "user-1" } : params.user,
        },
      })),
    },
    from: jest.fn((table: string) => {
      if (table === "sources") return sourcesQuery;
      if (table === "workspace_email_addresses") return emailSourcesQuery;
      throw new Error(`Unexpected table ${table}`);
    }),
  };
  mockCreateClient.mockResolvedValue(supabase);
  return { supabase, sourcesQuery, emailSourcesQuery };
}

describe("/api/workspaces/[workspaceId]/integrations", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockVerifyWorkspaceAccess.mockResolvedValue(true);
    mockGetWorkspaceEmailProviderStatus.mockResolvedValue("disconnected");
    mockGetCompanyIdForWorkspace.mockResolvedValue("company-1");
    mockResolveCompanyWhatsAppAccessToken.mockResolvedValue(null);
  });

  it("withholds both WhatsApp token aliases and the commerce webhook secret", async () => {
    mockSupabase({
      sources: [
        {
          id: "source-1",
          type: "whatsapp",
          credentials: {
            waba_id: "waba-1",
            sales_webhook_secret: { ciphertext: "private-key" },
            sales_webhook_enabled: true,
            access_token: { ciphertext: "stored-token" },
            accessToken: "legacy-token",
          },
        },
      ],
    });
    const payload = await (await GET(request(), params)).json();
    expect(payload.sources[0].credentials).toEqual({
      waba_id: "waba-1",
      sales_webhook_enabled: true,
    });
  });

  it("sanitizes ElevenLabs credentials before returning sources", async () => {
    mockSupabase({
      sources: [
        {
          id: "source-1",
          name: "ElevenLabs",
          type: "elevenlabs",
          workspace_id: "workspace-1",
          credentials: {
            api_key: "elevenlabs-secret-api-key",
            default_voice_id: "voice-1",
            connected_at: "2026-07-03T00:00:00.000Z",
          },
        },
      ],
    });

    const response = await GET(request(), params);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        sources: [
          expect.objectContaining({
            id: "source-1",
            type: "elevenlabs",
            credentials: {
              has_api_key: true,
              key_label: "****-key",
              default_voice_id: "voice-1",
              connected_at: "2026-07-03T00:00:00.000Z",
            },
          }),
        ],
      })
    );
  });

  it("never returns Google AI secrets or ciphertext in the integrations list", async () => {
    mockSupabase({
      sources: [
        {
          id: "google-1",
          type: "google_ai",
          credentials: {
            api_key: {
              iv: "AAAAAAAAAAAAAAAA",
              tag: "AAAAAAAAAAAAAAAAAAAAAA==",
              ciphertext: "c2Vuc2l0aXZlLWNpcGhlcnRleHQ=",
            },
            key_label: "****1234",
            connected_at: "2026-09-17T00:00:00.000Z",
            validated_at: "2026-09-17T00:00:00.000Z",
            model_count: 3,
            unexpected_secret: "private",
          },
        },
      ],
    });
    const payload = await (await GET(request(), params)).json();
    expect(payload.sources[0].credentials).toEqual({
      has_api_key: true,
      key_label: "****1234",
      connected_at: "2026-09-17T00:00:00.000Z",
      validated_at: "2026-09-17T00:00:00.000Z",
      model_count: 3,
    });
    expect(JSON.stringify(payload)).not.toContain("sensitive-ciphertext");
    expect(JSON.stringify(payload)).not.toContain("ciphertext");
    expect(JSON.stringify(payload)).not.toContain("unexpected_secret");
  });

  it.each([
    ["an encrypted", { iv: "aXY=", tag: "dGFn", ciphertext: "c2VjcmV0" }],
    ["a plain-text legacy", "123456:legacy-bot-token"],
  ])(
    "never returns %s Telegram bot token or the webhook secret",
    async (_label, botToken) => {
      mockSupabase({
        sources: [
          {
            id: "telegram-1",
            type: "telegram",
            credentials: {
              bot_token: botToken,
              bot_username: "airi_bot",
              webhook_secret_token: "webhook-secret",
              ai_reactions_enabled: true,
            },
          },
        ],
      });
      const payload = await (await GET(request(), params)).json();
      expect(payload.sources[0].credentials).toEqual({
        has_bot_token: true,
        bot_username: "airi_bot",
        ai_reactions_enabled: true,
      });
      const body = JSON.stringify(payload);
      expect(body).not.toContain("legacy-bot-token");
      expect(body).not.toContain("ciphertext");
      expect(body).not.toContain("webhook-secret");
    }
  );

  it("rejects users without workspace access before listing sources", async () => {
    const { supabase } = mockSupabase();
    mockVerifyWorkspaceAccess.mockResolvedValue(false);

    const response = await GET(request(), params);

    expect(response.status).toBe(403);
    expect(mockVerifyWorkspaceAccess).toHaveBeenCalledWith(
      supabase,
      "user-1",
      "workspace-1"
    );
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it("keeps a partner-removed WhatsApp source out of the channel list but returns it for reconnecting", async () => {
    const removedCredentials = {
      waba_id: "waba-1",
      phone_number_id: "phone-1",
      coexistence_reonboarding_status: "removed",
      cloud_api_messaging_suspended: true,
      access_token: { ciphertext: "stored-token" },
      accessToken: "legacy-token",
      sales_webhook_secret: { ciphertext: "private-key" },
    };
    mockSupabase({
      sources: [
        {
          id: "removed-older",
          type: "whatsapp",
          updated_at: "2026-07-01T00:00:00.000Z",
          credentials: removedCredentials,
        },
        {
          id: "removed-newer",
          type: "whatsapp",
          updated_at: "2026-08-10T00:00:00.000Z",
          credentials: removedCredentials,
        },
        { id: "telegram-1", type: "telegram", credentials: {} },
      ],
    });

    const payload = await (await GET(request(), params)).json();

    expect(payload.sources.map((source: { id: string }) => source.id)).toEqual([
      "telegram-1",
    ]);
    expect(payload.removedWhatsAppSource).toEqual(
      expect.objectContaining({
        id: "removed-newer",
        credentials: {
          waba_id: "waba-1",
          phone_number_id: "phone-1",
          coexistence_reonboarding_status: "removed",
          cloud_api_messaging_suspended: true,
        },
      })
    );
  });

  it("returns no removed WhatsApp source when the connection is active", async () => {
    mockSupabase({
      sources: [
        {
          id: "source-1",
          type: "whatsapp",
          credentials: { waba_id: "waba-1" },
        },
      ],
    });

    const payload = await (await GET(request(), params)).json();

    expect(payload.sources).toHaveLength(1);
    expect(payload.removedWhatsAppSource).toBeNull();
  });

  it("reports whether the company already has WhatsApp Meta access", async () => {
    mockSupabase();
    mockResolveCompanyWhatsAppAccessToken.mockResolvedValue("company-token");

    const response = await GET(request(), params);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.hasCompanyWhatsAppInventory).toBe(true);
    expect(mockResolveCompanyWhatsAppAccessToken).toHaveBeenCalledWith({
      companyId: "company-1",
    });
  });
});
