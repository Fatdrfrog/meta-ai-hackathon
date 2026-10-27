import {
  acquireTikTokProviderPermit,
  resetTikTokProviderPermitMemoryForTests,
} from "./provider-permit";

const NOW = Date.parse("2026-08-13T12:00:00.000Z");

afterEach(() => {
  resetTikTokProviderPermitMemoryForTests();
});

describe("TikTok Discovery provider permit", () => {
  it("preserves distributed limited and unavailable outcomes in production", async () => {
    const limited = {
      limit: jest.fn().mockResolvedValue({
        success: false,
        limit: 8,
        remaining: 0,
        reset: NOW + 1_000,
      }),
    };
    const broken = {
      limit: jest.fn().mockRejectedValue(new Error("redis unavailable")),
    };

    await expect(
      acquireTikTokProviderPermit(
        { endpoint: "trending_list", developerAppId: "app-1" },
        {
          limiters: { trending_list: limited, video_list: limited },
          nodeEnv: "production",
          nowMs: () => NOW,
        }
      )
    ).resolves.toEqual({
      permit: "limited",
      retryAt: "2026-08-13T12:00:01.000Z",
    });
    await expect(
      acquireTikTokProviderPermit(
        { endpoint: "video_list", developerAppId: "app-1" },
        {
          limiters: { trending_list: broken, video_list: broken },
          nodeEnv: "production",
          nowMs: () => NOW,
        }
      )
    ).resolves.toEqual({ permit: "unavailable", retryAt: null });
  });

  it("fails closed when production coordination is not configured", async () => {
    const memoryWindows = new Map<string, number[]>();

    await expect(
      acquireTikTokProviderPermit(
        { endpoint: "trending_list", developerAppId: "app-1" },
        {
          limiters: { trending_list: null, video_list: null },
          nodeEnv: "production",
          nowMs: () => NOW,
          memoryWindows,
        }
      )
    ).resolves.toEqual({ permit: "unavailable", retryAt: null });
    expect(memoryWindows).toEqual(new Map());
  });

  it("does not fail open to memory when configured coordination throws outside production", async () => {
    const broken = {
      limit: jest.fn().mockRejectedValue(new Error("redis unavailable")),
    };
    const memoryWindows = new Map<string, number[]>();

    await expect(
      acquireTikTokProviderPermit(
        { endpoint: "trending_list", developerAppId: "app-1" },
        {
          limiters: { trending_list: broken, video_list: broken },
          nodeEnv: "test",
          nowMs: () => NOW,
          memoryWindows,
        }
      )
    ).resolves.toEqual({ permit: "unavailable", retryAt: null });
    expect(memoryWindows).toEqual(new Map());
  });

  it("does not grant or use memory when production coordination times out", async () => {
    const timedOut = {
      limit: jest.fn().mockResolvedValue({
        success: true,
        limit: 0,
        remaining: 0,
        reset: 0,
        pending: Promise.resolve(),
        reason: "timeout" as const,
      }),
    };
    const memoryWindows = new Map<string, number[]>();

    await expect(
      acquireTikTokProviderPermit(
        { endpoint: "trending_list", developerAppId: "app-1" },
        {
          limiters: { trending_list: timedOut, video_list: timedOut },
          nodeEnv: "production",
          nowMs: () => NOW,
          memoryWindows,
        }
      )
    ).resolves.toEqual({ permit: "unavailable", retryAt: null });
    expect(timedOut.limit).toHaveBeenCalledTimes(1);
    expect(memoryWindows).toEqual(new Map());
  });

  it("uses only a hashed app identity for each distributed endpoint", async () => {
    const granted = {
      limit: jest.fn().mockResolvedValue({
        success: true,
        limit: 8,
        remaining: 7,
        reset: NOW + 1_000,
      }),
    };
    const developerAppId =
      "raw-app-market-category-workspace-user-advertiser-token";

    await expect(
      acquireTikTokProviderPermit(
        { endpoint: "trending_list", developerAppId },
        {
          limiters: { trending_list: granted, video_list: granted },
          nodeEnv: "production",
          nowMs: () => NOW,
        }
      )
    ).resolves.toEqual({ permit: "granted", retryAt: null });
    await expect(
      acquireTikTokProviderPermit(
        { endpoint: "video_list", developerAppId },
        {
          limiters: { trending_list: granted, video_list: granted },
          nodeEnv: "production",
          nowMs: () => NOW,
        }
      )
    ).resolves.toEqual({ permit: "granted", retryAt: null });

    expect(granted.limit).toHaveBeenCalledTimes(2);
    for (const [identifier] of granted.limit.mock.calls) {
      expect(identifier).toMatch(/^[a-f0-9]{64}$/);
      for (const sensitiveValue of [
        developerAppId,
        "raw-app",
        "market",
        "category",
        "workspace",
        "user",
        "advertiser",
        "token",
      ]) {
        expect(identifier).not.toContain(sensitiveValue);
      }
    }
  });

  it("grants only eight same-app endpoint permits in one rolling second", async () => {
    const overrides = {
      limiters: { trending_list: null, video_list: null },
      nodeEnv: "test",
      nowMs: () => NOW,
    } as const;

    const results = await Promise.all(
      Array.from({ length: 9 }, () =>
        acquireTikTokProviderPermit(
          { endpoint: "trending_list", developerAppId: "app-1" },
          overrides
        )
      )
    );

    expect(results.map(result => result.permit)).toEqual([
      "granted",
      "granted",
      "granted",
      "granted",
      "granted",
      "granted",
      "granted",
      "granted",
      "limited",
    ]);
    expect(results[8]).toEqual({
      permit: "limited",
      retryAt: "2026-08-13T12:00:01.000Z",
    });
    await expect(
      acquireTikTokProviderPermit(
        { endpoint: "video_list", developerAppId: "app-1" },
        overrides
      )
    ).resolves.toEqual({ permit: "granted", retryAt: null });
  });

  it("uses a true rolling boundary and bounds the local coordinate map", async () => {
    const memoryWindows = new Map<string, number[]>();
    let current = NOW;
    const overrides = {
      limiters: { trending_list: null, video_list: null },
      nodeEnv: "test",
      nowMs: () => current,
      memoryWindows,
    } as const;

    for (let index = 0; index < 8; index += 1) {
      await expect(
        acquireTikTokProviderPermit(
          { endpoint: "trending_list", developerAppId: "app-1" },
          overrides
        )
      ).resolves.toMatchObject({ permit: "granted" });
    }

    current += 999;
    await expect(
      acquireTikTokProviderPermit(
        { endpoint: "trending_list", developerAppId: "app-1" },
        overrides
      )
    ).resolves.toMatchObject({ permit: "limited" });

    current += 1;
    await expect(
      acquireTikTokProviderPermit(
        { endpoint: "trending_list", developerAppId: "app-1" },
        overrides
      )
    ).resolves.toMatchObject({ permit: "granted" });

    for (let index = 0; index < 600; index += 1) {
      current += 1_000;
      await acquireTikTokProviderPermit(
        { endpoint: "video_list", developerAppId: `app-${index + 2}` },
        overrides
      );
    }

    expect(memoryWindows.size).toBeLessThanOrEqual(512);
    expect(
      [...memoryWindows.values()].every(timestamps =>
        timestamps.every(timestamp => current - timestamp < 1_000)
      )
    ).toBe(true);
  });
});
