const mockFrom = jest.fn();
const mockCheckTokenExpiryAndAlert = jest.fn();

jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: { from: (...args: unknown[]) => mockFrom(...args) },
}));
jest.mock("@/lib/notifications/check-token-expiry", () => ({
  checkTokenExpiryAndAlert: (...args: unknown[]) =>
    mockCheckTokenExpiryAndAlert(...args),
}));

import { GET } from "./route";

const ORIGINAL_CRON_SECRET = process.env.CRON_SECRET;
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
const mutableEnvironment = process.env as Record<string, string | undefined>;

function cronRequest(authorization?: string) {
  return new Request("https://www.airi.chat/api/cron/refreshInstagramTokens", {
    headers: authorization ? { authorization } : {},
  });
}

describe("GET /api/cron/refreshInstagramTokens", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mutableEnvironment.NODE_ENV = "production";
    process.env.CRON_SECRET = "cron-secret";
    mockFrom.mockReturnValue({
      select: jest.fn().mockReturnValue({
        eq: jest.fn().mockResolvedValue({ data: [] }),
      }),
    });
  });

  afterEach(() => {
    if (ORIGINAL_CRON_SECRET === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = ORIGINAL_CRON_SECRET;
    mutableEnvironment.NODE_ENV = ORIGINAL_NODE_ENV;
  });

  it.each([
    ["without credentials", undefined],
    ["with a wrong secret", "Bearer wrong-secret"],
  ])(
    "refuses a caller %s before touching tenant tokens",
    async (_label, authorization) => {
      const response = await GET(cronRequest(authorization));

      expect(response.status).toBe(401);
      expect(mockFrom).not.toHaveBeenCalled();
      expect(mockCheckTokenExpiryAndAlert).not.toHaveBeenCalled();
    }
  );

  it("runs for the scheduler's bearer secret", async () => {
    const response = await GET(cronRequest("Bearer cron-secret"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, refreshed: 0 });
    expect(mockFrom).toHaveBeenCalledWith("sources");
  });
});
