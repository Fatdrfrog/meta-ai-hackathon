const mockCreateClient = jest.fn();
const mockValidateStoredToken = jest.fn();
jest.mock("@/lib/supabase/server", () => ({
  createClient: () => mockCreateClient(),
}));
jest.mock("@/lib/whatsapp/token-refresh", () => ({
  validateStoredToken: (...args: unknown[]) => mockValidateStoredToken(...args),
}));

import { GET, POST } from "./route";
const now = Date.parse("2026-09-17T12:00:00Z");
const request = () =>
  new Request(
    "https://airi.chat/api/whatsapp/refresh-token?workspaceId=workspace-1"
  );

function setup(
  credentials: Record<string, unknown> = {},
  options: { user?: boolean; member?: boolean } = {}
) {
  const sourceQuery = {
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    maybeSingle: jest
      .fn()
      .mockResolvedValue({ data: { id: "source-1", credentials } }),
  };
  const membershipQuery = {
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    maybeSingle: jest
      .fn()
      .mockResolvedValue({
        data: options.member === false ? null : { workspace_id: "workspace-1" },
      }),
  };
  mockCreateClient.mockResolvedValue({
    auth: {
      getUser: async () => ({
        data: { user: options.user === false ? null : { id: "user-1" } },
      }),
    },
    from: (table: string) =>
      table === "sources" ? sourceQuery : membershipQuery,
  });
}

describe("legacy WhatsApp maintenance status endpoint", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers().setSystemTime(now);
  });
  afterEach(() => jest.useRealTimers());
  it("reports automatic maintenance rather than reconnecting an expiring connection", async () => {
    setup({ token_expires_at: new Date(now + 5 * 86400000).toISOString() });
    expect(await (await GET(request())).json()).toMatchObject({
      needsRefresh: true,
      actionRequired: "validate",
    });
  });
  it("does not declare a legacy cached expiry to be verified disconnection", async () => {
    setup({ token_expires_at: new Date(now - 86400000).toISOString() });
    expect(await (await GET(request())).json()).toMatchObject({
      actionRequired: "validate",
    });
  });
  it("requires recovery for verified expired access", async () => {
    setup({
      token_expires_at: new Date(now - 1).toISOString(),
      token_verified_at: new Date(now).toISOString(),
      token_is_valid: false,
    });
    expect(await (await GET(request())).json()).toMatchObject({
      actionRequired: "reconnect",
    });
  });
  it.each([
    ["user", 401],
    ["member", 403],
  ] as const)("retains the %s access guard", async (guard, status) => {
    setup({}, { [guard]: false });
    expect((await GET(request())).status).toBe(status);
    expect(mockValidateStoredToken).not.toHaveBeenCalled();
  });
  it("preserves temporary verification status without demanding reconnection", async () => {
    setup({
      access_token: { iv: "cipher", tag: "cipher", ciphertext: "cipher" },
    });
    mockValidateStoredToken.mockResolvedValue({
      valid: false,
      needsRefresh: false,
      actionRequired: "validate",
      message: "We are checking the WhatsApp connection.",
    });
    expect(await (await POST(request())).json()).toMatchObject({
      needsRefresh: false,
      actionRequired: "validate",
    });
  });
});
