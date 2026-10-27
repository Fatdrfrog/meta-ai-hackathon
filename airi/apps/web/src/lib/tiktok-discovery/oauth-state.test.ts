import type {
  CacheConsumeResult,
  CacheLockAcquisition,
} from "@icecore/shared/lib/cache";

import type { TikTokOAuthStateDependencies } from "./oauth-state";
import {
  consumeTikTokOAuthState,
  generateTikTokOAuthState,
  registerTikTokOAuthState,
  TIKTOK_OAUTH_STATE_TTL_SECONDS,
} from "./oauth-state";

const context = {
  state: "raw-state",
  userId: "user-1",
  redirectUri: "https://www.airi.chat/api/internal/tiktok/callback",
};

function createMapCache(): {
  cacheClient: TikTokOAuthStateDependencies["cacheClient"];
  entries: Map<string, string>;
  registrations: Array<{ key: string; value: string; ttl: number }>;
} {
  const entries = new Map<string, string>();
  const registrations: Array<{ key: string; value: string; ttl: number }> = [];
  return {
    entries,
    registrations,
    cacheClient: {
      async acquireLock<T>(
        key: string,
        value: T,
        ttl: number
      ): Promise<CacheLockAcquisition> {
        if (typeof value !== "string") return "unavailable";
        registrations.push({ key, value, ttl });
        if (entries.has(key)) return "contended";
        entries.set(key, value);
        return "acquired";
      },
      async consumeIfMatches(
        key: string,
        expectedValue: string
      ): Promise<CacheConsumeResult> {
        if (entries.get(key) !== expectedValue) return "invalid";
        entries.delete(key);
        return "consumed";
      },
    },
  };
}

describe("TikTok OAuth replay state", () => {
  it("generates independent 256-bit URL-safe raw state values", () => {
    const first = generateTikTokOAuthState();
    const second = generateTikTokOAuthState();

    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(second).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(second).not.toBe(first);
  });

  it("stores only the state digest key and versioned binding digest", async () => {
    const { cacheClient, registrations } = createMapCache();

    await expect(
      registerTikTokOAuthState(context, { cacheClient })
    ).resolves.toBe("acquired");

    expect(registrations).toHaveLength(1);
    const [{ key, value, ttl }] = registrations;
    expect(key).toContain(
      "7808e2ac2f438f9cd4cfe78f5262f51c28d01087fd2bad20edacc927acf6ee7d"
    );
    expect(value).toBe(
      "2c3bd8da84fae481416783906f4017afd7092eaf9ade8619abe64b83e04a496f"
    );
    expect(value).toMatch(/^[a-f0-9]{64}$/);
    expect(ttl).toBe(TIKTOK_OAUTH_STATE_TTL_SECONDS);
    expect(ttl).toBe(900);

    const cachedMaterial = JSON.stringify(registrations);
    expect(cachedMaterial).not.toContain(context.state);
    expect(cachedMaterial).not.toContain(context.userId);
    expect(cachedMaterial).not.toContain(context.redirectUri);
  });

  it("rejects changed bindings without consuming the registered state", async () => {
    const { cacheClient, entries } = createMapCache();
    await registerTikTokOAuthState(context, { cacheClient });

    await expect(
      consumeTikTokOAuthState(
        { ...context, userId: "other-user" },
        { cacheClient }
      )
    ).resolves.toBe("invalid");
    await expect(
      consumeTikTokOAuthState(
        {
          ...context,
          redirectUri: "https://www.airi.chat/api/internal/tiktok/other",
        },
        { cacheClient }
      )
    ).resolves.toBe("invalid");
    expect(entries.size).toBe(1);

    await expect(
      consumeTikTokOAuthState(context, { cacheClient })
    ).resolves.toBe("consumed");
    await expect(
      consumeTikTokOAuthState(context, { cacheClient })
    ).resolves.toBe("invalid");
  });

  it("preserves cache outages as fail-closed registration and consume results", async () => {
    const cacheClient: TikTokOAuthStateDependencies["cacheClient"] = {
      acquireLock: async () => "unavailable",
      consumeIfMatches: async () => "unavailable",
    };

    await expect(
      registerTikTokOAuthState(context, { cacheClient })
    ).resolves.toBe("unavailable");
    await expect(
      consumeTikTokOAuthState(context, { cacheClient })
    ).resolves.toBe("unavailable");
  });
});
