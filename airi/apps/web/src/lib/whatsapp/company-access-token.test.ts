const mockAdminFrom = jest.fn();

jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: {
    from: (...args: unknown[]) => mockAdminFrom(...args),
  },
}));

jest.mock("@/lib/whatsapp/credentials", () => ({
  normalizeWhatsAppCredentials: (value: unknown) => ({
    accessToken:
      value && typeof value === "object" && "access_token" in value
        ? (value as { access_token?: string }).access_token
        : undefined,
  }),
}));

import { resolveCompanyWhatsAppAccessToken } from "./company-access-token";

const NOW = Date.parse("2026-10-16T12:00:00.000Z");

function mockRows(rows: Array<Record<string, unknown>>) {
  const query = {
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    order: jest.fn().mockReturnThis(),
    limit: jest.fn(async () => ({
      data: rows.map((credentials, index) => ({
        id: `source-${index}`,
        credentials,
      })),
      error: null,
    })),
  };
  mockAdminFrom.mockReturnValue(query);
  return query;
}

describe("resolveCompanyWhatsAppAccessToken", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers({ now: NOW });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("uses an explicit token without reading stored sources", async () => {
    await expect(
      resolveCompanyWhatsAppAccessToken({
        companyId: "company-1",
        explicitAccessToken: " fresh-token ",
      })
    ).resolves.toBe("fresh-token");
    expect(mockAdminFrom).not.toHaveBeenCalled();
  });

  it.each([
    [
      "a partner-removed source",
      { coexistence_reonboarding_status: "removed" },
    ],
    ["an offboarded source", { coexistence_reonboarding_status: "offboarded" }],
    ["a suspended source", { cloud_api_messaging_suspended: true }],
    [
      "a token Meta confirmed invalid",
      {
        token_is_valid: false,
        token_verified_at: "2026-10-15T00:00:00.000Z",
      },
    ],
    [
      "a verified token that has expired",
      {
        token_verified_at: "2026-09-01T00:00:00.000Z",
        token_expires_at: "2026-10-01T00:00:00.000Z",
      },
    ],
  ])(
    "skips %s and falls back to the next usable token",
    async (_label, dead) => {
      mockRows([
        { access_token: "dead-token", ...dead },
        { access_token: "live-token" },
      ]);

      await expect(
        resolveCompanyWhatsAppAccessToken({ companyId: "company-1" })
      ).resolves.toBe("live-token");
    }
  );

  it("returns null when no stored token can still act", async () => {
    mockRows([
      {
        access_token: "removed-token",
        coexistence_reonboarding_status: "removed",
        cloud_api_messaging_suspended: true,
      },
      { access_token: "invalid-token", token_is_valid: false },
    ]);

    await expect(
      resolveCompanyWhatsAppAccessToken({ companyId: "company-1" })
    ).resolves.toBeNull();
  });

  it("keeps a working token that is close to expiry", async () => {
    mockRows([
      {
        access_token: "expiring-token",
        token_is_valid: true,
        token_verified_at: "2026-10-16T06:00:00.000Z",
        token_expires_at: "2026-10-20T00:00:00.000Z",
        token_maintenance_status: "reconnect_required",
      },
    ]);

    await expect(
      resolveCompanyWhatsAppAccessToken({ companyId: "company-1" })
    ).resolves.toBe("expiring-token");
  });
});
