const mockSearchPublicKBArticles = jest.fn();
const mockCheckRateLimit = jest.fn();

jest.mock("@/lib/kb/public-kb-search", () => ({
  PUBLIC_KB_SEARCH_DEFAULT_LIMIT: 8,
  normalizePublicKBSearchLimit: (value: string | number | null) => {
    const parsed = Number.parseInt(String(value ?? ""), 10);
    if (!Number.isFinite(parsed)) return 8;
    return Math.min(20, Math.max(1, parsed));
  },
  normalizePublicKBSearchQuery: (value: string | null | undefined) =>
    String(value ?? "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120),
  searchPublicKBArticles: (...args: unknown[]) =>
    mockSearchPublicKBArticles(...args),
}));

jest.mock("@icecore/shared/lib/rate-limiter", () => ({
  createRateLimiter: jest.fn(() => ({})),
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
}));

import { NextRequest } from "next/server";
import { GET } from "./route";

function request(url: string, headers?: HeadersInit) {
  return new NextRequest(url, { headers });
}

describe("GET /api/public-kb/[companySlug]/search", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCheckRateLimit.mockResolvedValue({
      success: true,
      limit: 60,
      remaining: 59,
      reset: Date.now() + 60_000,
    });
    mockSearchPublicKBArticles.mockResolvedValue([]);
  });

  it("returns an empty result for short queries without rate limiting", async () => {
    const response = await GET(
      request("http://localhost/api/public-kb/airichat/search?q=r"),
      { params: Promise.resolve({ companySlug: "airichat" }) }
    );

    await expect(response.json()).resolves.toEqual({
      items: [],
      query: "r",
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(mockCheckRateLimit).not.toHaveBeenCalled();
    expect(mockSearchPublicKBArticles).not.toHaveBeenCalled();
  });

  it("searches public articles inside the company slug and locale scope", async () => {
    mockSearchPublicKBArticles.mockResolvedValue([
      {
        id: "article-1",
        title: "Refund policy",
        excerpt: "Refund windows",
        href: "/airichat/kb/article-1?locale=en",
        publishedAt: "2026-07-01T00:00:00.000Z",
        updatedAt: "2026-07-02T00:00:00.000Z",
        locale: "en",
      },
    ]);

    const response = await GET(
      request(
        "http://localhost/api/public-kb/airichat/search?q=refund&locale=en&limit=4",
        { "x-forwarded-for": "203.0.113.9, 10.0.0.1" }
      ),
      { params: Promise.resolve({ companySlug: "airichat" }) }
    );

    await expect(response.json()).resolves.toMatchObject({
      query: "refund",
      items: [{ id: "article-1", title: "Refund policy" }],
    });
    expect(mockCheckRateLimit).toHaveBeenCalledWith(
      expect.anything(),
      "airichat:203.0.113.9",
      60
    );
    expect(mockSearchPublicKBArticles).toHaveBeenCalledWith({
      companySlug: "airichat",
      query: "refund",
      locale: "en",
      limit: 4,
    });
  });

  it("returns a bounded response when rate limited", async () => {
    mockCheckRateLimit.mockResolvedValue({
      success: false,
      limit: 60,
      remaining: 0,
      reset: Date.now() + 60_000,
    });

    const response = await GET(
      request("http://localhost/api/public-kb/airichat/search?q=refund"),
      { params: Promise.resolve({ companySlug: "airichat" }) }
    );

    await expect(response.json()).resolves.toEqual({
      items: [],
      query: "refund",
      error: "Too many requests",
    });
    expect(response.status).toBe(429);
    expect(mockSearchPublicKBArticles).not.toHaveBeenCalled();
  });
});
