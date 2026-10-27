const mockFetchSourceWithCredentialsResult = jest.fn();
const mockDomainUnauthorized = jest.fn();
const mockCheckRateLimit = jest.fn();

jest.mock("@/lib/sources/utils", () => ({
  fetchSourceWithCredentialsResult: (...args: unknown[]) =>
    mockFetchSourceWithCredentialsResult(...args),
}));

jest.mock("@/lib/logger", () => ({
  widgetLogger: {
    configFetched: jest.fn(),
    domainUnauthorized: (...args: unknown[]) => mockDomainUnauthorized(...args),
    error: jest.fn(),
    rateLimitExceeded: jest.fn(),
  },
}));

jest.mock("@icecore/shared/lib/rate-limiter", () => ({
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
  createRateLimiter: jest.fn(() => ({})),
  rateLimitPresets: {
    widgetConfig: {},
  },
}));

jest.mock("@/lib/widget/quick-reply-recommendations", () => ({
  getWorkspaceRecommendedQuickReplies: jest.fn(async () => []),
  isLegacyDefaultWidgetQuickReplies: jest.fn(() => false),
}));

import { GET } from "@/app/api/widget/config/route";
import { NextRequest } from "next/server";

describe("GET /api/widget/config", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCheckRateLimit.mockResolvedValue({
      success: true,
      limit: 30,
      remaining: 29,
    });
    mockFetchSourceWithCredentialsResult.mockResolvedValue({
      ok: true,
      source: {
        id: "source-1",
        workspace_id: "workspace-1",
        company_id: "company-1",
        credentials: {
          client_key: "widget_test",
          allowed_domains: ["www.airi.chat"],
          status: "active",
        },
      },
    });
  });

  it("rejects config fetches from origins outside the widget allowlist", async () => {
    const response = await GET(
      new NextRequest(
        "https://www.airi.chat/api/widget/config?client_key=widget_test",
        {
          headers: {
            origin:
              "https://nest-ai-front-8q6yj82dg-fatdrfrogs-projects.vercel.app",
          },
        }
      )
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: "Domain not authorized",
    });
    expect(mockDomainUnauthorized).toHaveBeenCalledWith(
      "https://nest-ai-front-8q6yj82dg-fatdrfrogs-projects.vercel.app",
      "widget_test",
      "workspace-1",
      "company-1"
    );
  });
});
