const mockCheckRateLimit = jest.fn();
const mockUpsert = jest.fn();
const mockFrom = jest.fn();

jest.mock("@icecore/shared/lib/rate-limiter", () => ({
  createRateLimiter: jest.fn(() => ({})),
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
}));

jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: {
    from: (...args: unknown[]) => mockFrom(...args),
  },
}));

import { POST } from "./route";

function demoRequest(
  body: unknown,
  headers: Record<string, string> = {}
): Request {
  return new Request("http://localhost/api/landing/demo-request", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

describe("POST /api/landing/demo-request", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFrom.mockReturnValue({ upsert: mockUpsert });
    mockUpsert.mockResolvedValue({ error: null });
    mockCheckRateLimit.mockResolvedValue({
      success: true,
      limit: 5,
      remaining: 4,
      reset: Date.now() + 60_000,
    });
  });

  it("rate limits a valid request by the first trusted proxy IP before writing", async () => {
    const response = await POST(
      demoRequest(
        { email: "Sam@Company.com", website: "" },
        {
          "x-vercel-forwarded-for": "198.51.100.8",
          "x-forwarded-for": "203.0.113.10, 10.0.0.1",
        }
      )
    );

    expect(response.status).toBe(200);
    expect(mockCheckRateLimit).toHaveBeenCalledWith(
      expect.anything(),
      "198.51.100.8",
      5
    );
    expect(mockFrom).toHaveBeenCalledWith("demo_requests");
    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        email: "sam@company.com",
        source: "landing_hero",
      }),
      { onConflict: "email" }
    );
  });

  it("returns 429 with retry guidance without writing when the IP limit is exhausted", async () => {
    mockCheckRateLimit.mockResolvedValue({
      success: false,
      limit: 5,
      remaining: 0,
      reset: Date.now() + 30_000,
    });

    const response = await POST(
      demoRequest(
        { email: "sam@company.com", website: "" },
        { "x-forwarded-for": "203.0.113.10" }
      )
    );

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("30");
    await expect(response.json()).resolves.toEqual({
      error: "Too many requests. Please try again later.",
    });
    expect(mockFrom).not.toHaveBeenCalled();
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("quietly accepts a filled honeypot without rate limiting or writing", async () => {
    const response = await POST(
      demoRequest({
        email: "bot@example.com",
        website: "https://spam.example",
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(mockCheckRateLimit).not.toHaveBeenCalled();
    expect(mockFrom).not.toHaveBeenCalled();
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("fails closed before writing when the shared limiter is unavailable", async () => {
    mockCheckRateLimit.mockRejectedValue(new Error("redis unavailable"));

    const response = await POST(
      demoRequest(
        { email: "sam@company.com", website: "" },
        { "x-real-ip": "203.0.113.12" }
      )
    );

    expect(response.status).toBe(503);
    expect(mockFrom).not.toHaveBeenCalled();
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("rejects malformed bodies before rate limiting or writing", async () => {
    const response = await POST(demoRequest({ email: "not-an-email" }));

    expect(response.status).toBe(400);
    expect(mockCheckRateLimit).not.toHaveBeenCalled();
    expect(mockFrom).not.toHaveBeenCalled();
  });
});
