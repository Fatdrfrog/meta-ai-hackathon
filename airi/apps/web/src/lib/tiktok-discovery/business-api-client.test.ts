const mockFetchJsonWithinLimits = jest.fn();
jest.mock("@/lib/http/bounded-json-response", () => {
  const actual = jest.requireActual<
    typeof import("@/lib/http/bounded-json-response")
  >("@/lib/http/bounded-json-response");
  return {
    ...actual,
    fetchJsonWithinLimits: (...args: unknown[]) =>
      mockFetchJsonWithinLimits(...args),
  };
});

import { BoundedJsonResponseError } from "@/lib/http/bounded-json-response";

import {
  fetchTikTokOEmbed,
  fetchTikTokTrendingHashtags,
  fetchTikTokTrendingVideos,
  parseTikTokRetryAfter,
} from "./business-api-client";

const trendingInput = {
  accessToken: "secret-token",
  advertiserId: "101",
  market: "KZ" as const,
  category: "ALL" as const,
};

const providerHashtag = (id: string) => ({
  hashtag_id: id,
  hashtag_name: id,
  rank_position: "1",
  top_country_list: ["KZ"],
});

const providerGroup = (id: string, count = 0) => ({
  hashtag_id: id,
  top_video_list: Array.from({ length: count }, (_, index) => ({
    video_id: `${id}-${index}`,
    share_url: `https://www.tiktok.com/@creator/video/${id}-${index}`,
  })),
});

describe("TikTok Business API client", () => {
  beforeEach(() => {
    mockFetchJsonWithinLimits.mockReset();
  });

  it("parses string ranks and sends one correlated batch video request", async () => {
    mockFetchJsonWithinLimits
      .mockResolvedValueOnce({
        response: new Response("", { status: 200 }),
        payload: {
          code: 0,
          request_id: "trending-request",
          data: {
            list: [
              {
                hashtag_id: "tag-1",
                hashtag_name: "food",
                rank_position: "2",
                top_country_list: ["KZ", "KZ", "ZZ"],
              },
              {
                hashtag_id: "tag-2",
                hashtag_name: "travel",
                rank_position: "4",
                top_country_list: ["KZ"],
              },
            ],
          },
        },
      })
      .mockResolvedValueOnce({
        response: new Response("", { status: 200 }),
        payload: {
          code: 0,
          request_id: "video-request",
          data: {
            list: [
              {
                hashtag_id: "tag-2",
                hashtag_name: "travel",
                top_video_list: [],
              },
              {
                hashtag_id: "tag-1",
                hashtag_name: "food",
                top_video_list: [
                  {
                    video_id: "video-1",
                    share_url: "https://www.tiktok.com/@creator/video/1",
                    embed_url: "https://www.tiktok.com/embed/v2/1",
                  },
                ],
              },
            ],
          },
        },
      });

    await expect(
      fetchTikTokTrendingHashtags({
        accessToken: "secret-token",
        advertiserId: "101",
        market: "KZ",
        category: "FOOD_AND_BEVERAGE",
      })
    ).resolves.toEqual({
      requestId: "trending-request",
      hashtags: [
        { id: "tag-1", name: "food", rank: 2, topCountryList: ["KZ"] },
        {
          id: "tag-2",
          name: "travel",
          rank: 4,
          topCountryList: ["KZ"],
        },
      ],
    });
    await expect(
      fetchTikTokTrendingVideos({
        accessToken: "secret-token",
        advertiserId: "101",
        market: "KZ",
        hashtagIds: ["tag-1", "tag-2"],
      })
    ).resolves.toEqual({
      requestId: "video-request",
      groups: [
        {
          hashtagId: "tag-1",
          videos: [
            {
              videoId: "video-1",
              shareUrl: "https://www.tiktok.com/@creator/video/1",
              rank: 1,
            },
          ],
        },
        { hashtagId: "tag-2", videos: [] },
      ],
    });

    const [trendingUrl, trendingInit, trendingLimits] =
      mockFetchJsonWithinLimits.mock.calls[0];
    const parsedTrending = new URL(trendingUrl);
    expect(parsedTrending.pathname).toBe(
      "/open_api/v1.3/discovery/trending_list/"
    );
    expect(Object.fromEntries(parsedTrending.searchParams)).toEqual({
      advertiser_id: "101",
      discovery_type: "HASHTAG",
      country_code: "KZ",
      date_range: "7DAY",
      category_name: "FOOD_AND_BEVERAGE",
    });
    expect(trendingInit).toEqual({
      redirect: "error",
      headers: { "Access-Token": "secret-token" },
    });
    expect(trendingLimits).toEqual({
      maxBytes: 2 * 1024 * 1024,
      timeoutMs: 8_000,
    });

    const [videoUrl, videoInit, videoLimits] =
      mockFetchJsonWithinLimits.mock.calls[1];
    const parsed = new URL(videoUrl);
    expect(parsed.pathname).toBe("/open_api/v1.3/discovery/video_list/");
    expect(parsed.searchParams.get("hashtag_ids")).toBe('["tag-1","tag-2"]');
    expect(parsed.searchParams.get("country_code")).toBe("KZ");
    expect(parsed.searchParams.get("date_range")).toBe("7DAY");
    expect(parsed.searchParams.has("page")).toBe(false);
    expect(videoInit).toEqual({
      redirect: "error",
      headers: { "Access-Token": "secret-token" },
    });
    expect(videoLimits).toEqual({
      maxBytes: 2 * 1024 * 1024,
      timeoutMs: 8_000,
    });
    expect(videoUrl).not.toContain("secret-token");
  });

  it.each([
    [40105, "unauthorized", false],
    [40125, "forbidden", false],
    [40100, "rate_limited", true],
    [50000, "provider", true],
    [49999, "provider", false],
  ] as const)(
    "maps provider code %i without message matching",
    async (providerCode, code, retryable) => {
      mockFetchJsonWithinLimits.mockResolvedValue({
        response: new Response("", { status: 200 }),
        payload: {
          code: providerCode,
          message: "message text must not control mapping",
          request_id: "request-1",
        },
      });
      await expect(
        fetchTikTokTrendingHashtags(trendingInput)
      ).rejects.toMatchObject({
        name: "TikTokBusinessApiError",
        code,
        retryable,
        requestId: "request-1",
      });
    }
  );

  it.each([
    ["1", 1],
    ["3600", 3600],
    ["Thu, 13 Aug 2026 12:00:30 GMT", 30],
    ["Thu, 13 Aug 2026 11:59:59 GMT", null],
    ["0", null],
    ["-1", null],
    ["3601", null],
    ["not-a-delay", null],
  ] as const)("parses Retry-After %s", (value, expected) => {
    expect(
      parseTikTokRetryAfter(value, Date.parse("2026-08-13T12:00:00Z"))
    ).toBe(expected);
  });

  it("carries a provider Retry-After header into the normalized error", async () => {
    mockFetchJsonWithinLimits.mockResolvedValue({
      response: new Response("", {
        status: 429,
        headers: { "Retry-After": "30" },
      }),
      payload: { code: 0, request_id: "request-1" },
    });
    await expect(
      fetchTikTokTrendingHashtags(trendingInput)
    ).rejects.toMatchObject({
      code: "rate_limited",
      retryable: true,
      retryAfterSeconds: 30,
    });
  });

  it("normalizes bounded-fetch network rejection without retaining its message", async () => {
    mockFetchJsonWithinLimits.mockRejectedValue(
      new TypeError("socket detail must not escape")
    );
    const error = await fetchTikTokTrendingHashtags(trendingInput).catch(
      (value: unknown) => value
    );
    expect(error).toMatchObject({
      name: "TikTokBusinessApiError",
      code: "provider",
      retryable: true,
    });
    expect(JSON.stringify(error)).not.toContain("socket detail");
  });

  it("fails closed on a Business redirect without a token-bearing alternate-host request", async () => {
    mockFetchJsonWithinLimits.mockResolvedValue({
      response: new Response("", {
        status: 302,
        headers: { Location: "https://evil.example/collect" },
      }),
      payload: {
        code: 0,
        message: "redirect detail contains secret-token",
      },
    });

    const error = await fetchTikTokTrendingHashtags(trendingInput).catch(
      (value: unknown) => value
    );

    expect(error).toMatchObject({
      name: "TikTokBusinessApiError",
      code: "provider",
      retryable: false,
    });
    expect(JSON.stringify(error)).not.toContain("secret-token");
    expect(JSON.stringify(error)).not.toContain("evil.example");
    expect(mockFetchJsonWithinLimits).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetchJsonWithinLimits.mock.calls[0];
    expect(new URL(url).origin).toBe("https://business-api.tiktok.com");
    expect(init).toEqual({
      redirect: "error",
      headers: { "Access-Token": "secret-token" },
    });
  });

  it.each([
    [
      "timeout",
      new BoundedJsonResponseError("provider_response_timeout", 8_000),
    ],
    [
      "oversize",
      new BoundedJsonResponseError(
        "provider_response_too_large",
        2 * 1024 * 1024
      ),
    ],
  ] as const)("normalizes bounded-fetch %s", async (_name, failure) => {
    mockFetchJsonWithinLimits.mockRejectedValue(failure);
    const error = await fetchTikTokTrendingHashtags(trendingInput).catch(
      (value: unknown) => value
    );
    expect(error).toMatchObject({
      name: "TikTokBusinessApiError",
      code: "provider",
      retryable: true,
      requestId: null,
    });
    expect(JSON.stringify(error)).not.toContain(failure.message);
  });

  it.each([
    [429, 0, "rate_limited"],
    [500, 40105, "unauthorized"],
  ] as const)(
    "maps HTTP %i/provider %i to %s",
    async (status, providerCode, code) => {
      mockFetchJsonWithinLimits.mockResolvedValue({
        response: new Response("", { status }),
        payload: {
          code: providerCode,
          request_id: "request-1",
          data: { list: [] },
        },
      });
      await expect(
        fetchTikTokTrendingHashtags(trendingInput)
      ).rejects.toMatchObject({ code });
    }
  );

  it.each([
    [
      "numeric rank",
      {
        hashtag_id: "tag",
        hashtag_name: "tag",
        rank_position: 1,
        top_country_list: ["KZ"],
      },
    ],
    [
      "zero rank",
      {
        hashtag_id: "tag",
        hashtag_name: "tag",
        rank_position: "0",
        top_country_list: ["KZ"],
      },
    ],
    [
      "oversized rank",
      {
        hashtag_id: "tag",
        hashtag_name: "tag",
        rank_position: "1001",
        top_country_list: ["KZ"],
      },
    ],
  ] as const)("rejects %s", async (_name, hashtag) => {
    mockFetchJsonWithinLimits.mockResolvedValue({
      response: new Response("", { status: 200 }),
      payload: { code: 0, data: { list: [hashtag] } },
    });
    await expect(
      fetchTikTokTrendingHashtags(trendingInput)
    ).rejects.toMatchObject({ code: "provider", retryable: false });
  });

  it.each([
    [[], "zero IDs"],
    [["1", "2", "3", "4"], "four IDs"],
    [Array.from({ length: 11 }, (_, index) => String(index + 1)), "eleven IDs"],
    [["1", "1"], "duplicate IDs"],
  ] as const)("rejects %s before fetching", async (hashtagIds, _name) => {
    await expect(
      fetchTikTokTrendingVideos({
        accessToken: "secret-token",
        advertiserId: "101",
        market: "KZ",
        hashtagIds: [...hashtagIds] as unknown as readonly [string],
      })
    ).rejects.toMatchObject({ code: "provider", retryable: false });
    expect(mockFetchJsonWithinLimits).not.toHaveBeenCalled();
  });

  it("rejects a non-array hashtag ID cast before fetching", async () => {
    await expect(
      fetchTikTokTrendingVideos({
        accessToken: "secret-token",
        advertiserId: "101",
        market: "KZ",
        hashtagIds: {
          0: "tag-1",
          length: 1,
        } as unknown as readonly [string],
      })
    ).rejects.toMatchObject({ code: "provider", retryable: false });
    expect(mockFetchJsonWithinLimits).not.toHaveBeenCalled();
  });

  it.each([
    ["invalid trending market", { ...trendingInput, market: "ZZ" }],
    ["invalid trending category", { ...trendingInput, category: "food" }],
  ])("rejects %s cast before fetching", async (_name, input) => {
    await expect(
      fetchTikTokTrendingHashtags(
        input as unknown as Parameters<typeof fetchTikTokTrendingHashtags>[0]
      )
    ).rejects.toMatchObject({ code: "provider", retryable: false });
    expect(mockFetchJsonWithinLimits).not.toHaveBeenCalled();
  });

  it("rejects an invalid video market cast before fetching", async () => {
    await expect(
      fetchTikTokTrendingVideos({
        accessToken: "secret-token",
        advertiserId: "101",
        market: "ZZ" as unknown as "KZ",
        hashtagIds: ["tag-1"],
      })
    ).rejects.toMatchObject({ code: "provider", retryable: false });
    expect(mockFetchJsonWithinLimits).not.toHaveBeenCalled();
  });

  it.each([
    [
      "201 hashtags",
      {
        list: Array.from({ length: 201 }, (_, index) =>
          providerHashtag(String(index))
        ),
      },
    ],
    [
      "six countries",
      {
        list: [
          {
            ...providerHashtag("tag"),
            top_country_list: ["KZ", "US", "UZ", "GB", "DE", "FR"],
          },
        ],
      },
    ],
  ] as const)("rejects %s", async (_name, data) => {
    mockFetchJsonWithinLimits.mockResolvedValue({
      response: new Response("", { status: 200 }),
      payload: { code: 0, data },
    });
    await expect(
      fetchTikTokTrendingHashtags(trendingInput)
    ).rejects.toMatchObject({ code: "provider", retryable: false });
  });

  it.each([
    ["missing group", [providerGroup("tag-1")]],
    [
      "duplicate group",
      [providerGroup("tag-1"), providerGroup("tag-1"), providerGroup("tag-2")],
    ],
    [
      "unrequested group",
      [providerGroup("tag-1"), providerGroup("tag-2"), providerGroup("tag-3")],
    ],
    ["21 videos", [providerGroup("tag-1", 21), providerGroup("tag-2")]],
  ] as const)("rejects %s", async (_name, list) => {
    mockFetchJsonWithinLimits.mockResolvedValue({
      response: new Response("", { status: 200 }),
      payload: { code: 0, data: { list } },
    });
    await expect(
      fetchTikTokTrendingVideos({
        accessToken: "secret-token",
        advertiserId: "101",
        market: "KZ",
        hashtagIds: ["tag-1", "tag-2"],
      })
    ).rejects.toMatchObject({ code: "provider", retryable: false });
  });

  it("drops a video with an invalid share URL", async () => {
    mockFetchJsonWithinLimits.mockResolvedValue({
      response: new Response("", { status: 200 }),
      payload: {
        code: 0,
        data: {
          list: [
            {
              hashtag_id: "tag-1",
              top_video_list: [
                {
                  video_id: "video-1",
                  share_url: "https://tiktok.com.evil.test/video/1",
                },
              ],
            },
          ],
        },
      },
    });

    await expect(
      fetchTikTokTrendingVideos({
        accessToken: "secret-token",
        advertiserId: "101",
        market: "KZ",
        hashtagIds: ["tag-1"],
      })
    ).resolves.toEqual({
      requestId: null,
      groups: [{ hashtagId: "tag-1", videos: [] }],
    });
  });

  it.each([
    ["overlong", "r".repeat(129)],
    ["control characters", "request-id\r\nreflected"],
    ["provider prose", "raw provider request id"],
    ["reflected token", "request-secret-token-suffix"],
  ])("drops a %s provider request ID", async (_name, requestId) => {
    mockFetchJsonWithinLimits.mockResolvedValue({
      response: new Response("", { status: 200 }),
      payload: {
        code: 0,
        request_id: requestId,
        data: { list: [] },
      },
    });

    await expect(fetchTikTokTrendingHashtags(trendingInput)).resolves.toEqual({
      requestId: null,
      hashtags: [],
    });
  });

  it("ignores executable oEmbed HTML and uses the small bounded limit", async () => {
    mockFetchJsonWithinLimits.mockResolvedValue({
      response: new Response("", { status: 200 }),
      payload: {
        title: "Title",
        html: "<script>bad()</script>",
        author_name: "Creator",
      },
    });
    const result = await fetchTikTokOEmbed(
      "https://www.tiktok.com/@creator/video/1"
    );
    expect(result).toEqual({
      title: "Title",
      authorName: "Creator",
      authorUrl: null,
      thumbnailUrl: null,
    });
    expect(JSON.stringify(result)).not.toContain("html");
    expect(JSON.stringify(result)).not.toContain("<script>");
    expect(mockFetchJsonWithinLimits.mock.calls[0][2]).toEqual({
      maxBytes: 256 * 1024,
      timeoutMs: 8_000,
    });
  });

  it("parses oEmbed as plain HTTP and normalizes every returned URL", async () => {
    mockFetchJsonWithinLimits.mockResolvedValue({
      response: new Response("", { status: 200 }),
      payload: {
        code: 50000,
        title: "Plain oEmbed",
        author_name: "Creator",
        author_url: "https://www.tiktok.com/@creator#profile",
        thumbnail_url: "https://p16.muscdn.com/object/preview#tracking",
      },
    });

    await expect(
      fetchTikTokOEmbed("https://www.tiktok.com/@creator/video/1#tracking")
    ).resolves.toEqual({
      title: "Plain oEmbed",
      authorName: "Creator",
      authorUrl: "https://www.tiktok.com/@creator",
      thumbnailUrl: "https://p16.muscdn.com/object/preview",
    });
    const [url, init] = mockFetchJsonWithinLimits.mock.calls[0];
    expect(url).toBe(
      "https://www.tiktok.com/oembed?url=https%3A%2F%2Fwww.tiktok.com%2F%40creator%2Fvideo%2F1"
    );
    expect(init).toEqual({ redirect: "error" });
  });

  it("fails closed on an oEmbed redirect without an alternate-host request", async () => {
    mockFetchJsonWithinLimits.mockResolvedValue({
      response: new Response("", {
        status: 302,
        headers: { Location: "https://evil.example/collect" },
      }),
      payload: { html: "<script>redirect detail</script>" },
    });

    const error = await fetchTikTokOEmbed(
      "https://www.tiktok.com/@creator/video/1"
    ).catch((value: unknown) => value);

    expect(error).toMatchObject({
      name: "TikTokBusinessApiError",
      code: "provider",
      retryable: false,
    });
    expect(JSON.stringify(error)).not.toContain("evil.example");
    expect(JSON.stringify(error)).not.toContain("redirect detail");
    expect(mockFetchJsonWithinLimits).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetchJsonWithinLimits.mock.calls[0];
    expect(new URL(url).origin).toBe("https://www.tiktok.com");
    expect(init).toEqual({ redirect: "error" });
  });

  it("rejects an invalid oEmbed share URL before fetching", async () => {
    await expect(
      fetchTikTokOEmbed("https://tiktok.com.evil.test/video/1")
    ).rejects.toMatchObject({ code: "provider", retryable: false });
    expect(mockFetchJsonWithinLimits).not.toHaveBeenCalled();
  });

  it("normalizes oEmbed HTTP failure for the loader to handle fail-soft", async () => {
    mockFetchJsonWithinLimits.mockResolvedValue({
      response: new Response("", { status: 503 }),
      payload: { message: "raw oEmbed detail" },
    });

    const error = await fetchTikTokOEmbed(
      "https://www.tiktok.com/@creator/video/1"
    ).catch((value: unknown) => value);
    expect(error).toMatchObject({ code: "provider", retryable: true });
    expect(JSON.stringify(error)).not.toContain("raw oEmbed detail");
  });
});
