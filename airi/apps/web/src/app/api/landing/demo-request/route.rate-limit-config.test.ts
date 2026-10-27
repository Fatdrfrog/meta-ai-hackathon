const mockCheckRateLimit = jest.fn();
const mockFrom = jest.fn();

jest.mock("@icecore/shared/lib/rate-limiter", () => ({
  createRateLimiter: jest.fn(() => null),
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
}));

jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: {
    from: (...args: unknown[]) => mockFrom(...args),
  },
}));

import { POST } from "./route";

describe("POST /api/landing/demo-request without a shared limiter", () => {
  it("fails closed before checking or writing", async () => {
    const response = await POST(
      new Request("http://localhost/api/landing/demo-request", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: "sam@company.com",
          website: "",
        }),
      })
    );

    expect(response.status).toBe(503);
    expect(mockCheckRateLimit).not.toHaveBeenCalled();
    expect(mockFrom).not.toHaveBeenCalled();
  });
});
