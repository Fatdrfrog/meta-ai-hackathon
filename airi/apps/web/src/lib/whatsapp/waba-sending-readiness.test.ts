import type { WhatsAppGraphClient } from "@icecore/shared/lib/meta/api";
import { cache } from "@icecore/shared/lib/cache";
import { getWABASendingReadiness } from "./waba-service";

jest.mock("@icecore/shared/lib/cache", () => ({
  buildCacheKey: (prefix: string, parts: string[]) =>
    [prefix, ...parts].join(":"),
  cache: { get: jest.fn(), set: jest.fn() },
}));

function check(payload: unknown) {
  const getJson = jest.fn().mockResolvedValue(payload);
  return {
    getJson,
    result: getWABASendingReadiness({
      wabaId: "waba-1",
      accessToken: "secret-token",
      client: { getJson } as unknown as WhatsAppGraphClient,
    }),
  };
}

describe("business sending readiness", () => {
  beforeEach(() => {
    jest.mocked(cache.get).mockReset().mockResolvedValue(null);
    jest.mocked(cache.set).mockReset();
  });

  it("keeps operator refresh live while worker reads may reuse a recent check", async () => {
    const cached = {
      state: "ready",
      checkedAt: new Date().toISOString(),
      remainingCapacity: null,
      reasons: [],
    };
    jest.mocked(cache.get).mockResolvedValue(cached);
    const getJson = jest
      .fn()
      .mockResolvedValue({ health_status: { can_send_message: "BLOCKED" } });
    const params = {
      wabaId: "waba-1",
      accessToken: "token-1",
      client: { getJson } as unknown as WhatsAppGraphClient,
    };
    expect(
      (await getWABASendingReadiness({ ...params, maxAgeSeconds: 20 })).state
    ).toBe("ready");
    expect(getJson).not.toHaveBeenCalled();
    expect((await getWABASendingReadiness(params)).state).toBe("blocked");
    expect(getJson).toHaveBeenCalledTimes(1);
  });

  it("refreshes stale or malformed worker checks and isolates rotated credentials", async () => {
    const getJson = jest
      .fn()
      .mockResolvedValue({ health_status: { can_send_message: "AVAILABLE" } });
    const params = {
      wabaId: "waba-1",
      client: { getJson } as unknown as WhatsAppGraphClient,
      maxAgeSeconds: 20,
    };
    jest
      .mocked(cache.get)
      .mockResolvedValueOnce({
        state: "ready",
        checkedAt: new Date(Date.now() - 21_000).toISOString(),
        remainingCapacity: null,
        reasons: [],
      });
    expect(
      (await getWABASendingReadiness({ ...params, accessToken: "old-secret" }))
        .state
    ).toBe("ready");
    jest.mocked(cache.get).mockResolvedValueOnce({ state: "ready" });
    expect(
      (await getWABASendingReadiness({ ...params, accessToken: "new-secret" }))
        .state
    ).toBe("ready");
    expect(getJson).toHaveBeenCalledTimes(2);
    const keys = jest.mocked(cache.get).mock.calls.map(([key]) => key);
    expect(keys[0]).not.toBe(keys[1]);
    expect(JSON.stringify(keys)).not.toContain("secret");
  });

  it("still uses the completed provider read if cache storage fails", async () => {
    jest.mocked(cache.get).mockRejectedValue(new Error("cache offline"));
    jest.mocked(cache.set).mockRejectedValue(new Error("cache offline"));
    const result = await getWABASendingReadiness({
      wabaId: "waba-1",
      accessToken: "token",
      maxAgeSeconds: 20,
      client: {
        getJson: jest
          .fn()
          .mockResolvedValue({
            health_status: { can_send_message: "BLOCKED" },
          }),
      } as unknown as WhatsAppGraphClient,
    });
    expect(result.state).toBe("blocked");
  });
  it("blocks a connected WABA when its business has exhausted capacity", async () => {
    const { result, getJson } = check({
      health_status: {
        can_send_message: "BLOCKED",
        entities: [
          { entity_type: "WABA", can_send_message: "AVAILABLE" },
          {
            entity_type: "BUSINESS",
            can_send_message: "BLOCKED",
            errors: [
              { error_code: 141015, error_description: "provider detail" },
            ],
          },
        ],
      },
    });
    expect(await result).toEqual(
      expect.objectContaining({
        state: "blocked",
        remainingCapacity: null,
        reasons: [{ code: "meta_business_limit", providerCode: "141015" }],
      })
    );
    expect(getJson).toHaveBeenCalledWith(
      "waba-1",
      expect.objectContaining({
        token: "secret-token",
        query: { fields: "health_status" },
        cache: "no-store",
      })
    );
  });

  it("does not turn missing or malformed health into permission to send", async () => {
    for (const payload of [
      {},
      { health_status: null },
      { health_status: { can_send_message: "NEW_STATE" } },
      { health_status: { can_send_message: "AVAILABLE", entities: [null] } },
      { health_status: { can_send_message: "AVAILABLE", entities: {} } },
    ]) {
      expect(await check(payload).result).toEqual(
        expect.objectContaining({
          state: "unavailable",
          reasons: [{ code: "meta_check_unavailable" }],
        })
      );
    }
  });

  it("preserves a nested block even when the aggregate says available", async () => {
    expect(
      await check({
        health_status: {
          can_send_message: "AVAILABLE",
          entities: [
            { can_send_message: "BLOCKED", errors: [{ error_code: 131042 }] },
          ],
        },
      }).result
    ).toEqual(
      expect.objectContaining({
        state: "blocked",
        reasons: [{ code: "meta_billing", providerCode: "131042" }],
      })
    );
  });

  it("marks available health ready without inventing remaining capacity", async () => {
    expect(
      await check({
        health_status: {
          can_send_message: "AVAILABLE",
          entities: [{ can_send_message: "AVAILABLE" }],
        },
      }).result
    ).toEqual(
      expect.objectContaining({
        state: "ready",
        remainingCapacity: null,
        reasons: [],
      })
    );
  });

  it("allows Meta LIMITED health because messages remain permitted within account limits", async () => {
    expect(
      await check({
        health_status: {
          can_send_message: "LIMITED",
          entities: [
            {
              can_send_message: "LIMITED",
              additional_info: ["Display name has not been approved yet"],
            },
            { can_send_message: "AVAILABLE" },
          ],
        },
      }).result
    ).toEqual(
      expect.objectContaining({
        state: "ready",
        remainingCapacity: null,
        reasons: [],
      })
    );
  });

  it("returns a safe unavailable result when the provider check fails", async () => {
    const result = await getWABASendingReadiness({
      wabaId: "waba-1",
      accessToken: "secret-token",
      client: {
        getJson: jest
          .fn()
          .mockRejectedValue(new Error("secret provider response")),
      } as unknown as WhatsAppGraphClient,
    });
    expect(result).toEqual(
      expect.objectContaining({
        state: "unavailable",
        reasons: [{ code: "meta_check_unavailable" }],
      })
    );
    expect(JSON.stringify(result)).not.toContain("secret");
  });
});
