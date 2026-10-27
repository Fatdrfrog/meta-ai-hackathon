/**
 * @jest-environment node
 */

const mockReadWithStatus = jest.fn();
const mockWriteWithStatus = jest.fn();
const mockAfter = jest.fn();

jest.mock("next/server", () => ({
  after: (...args: unknown[]) => mockAfter(...args),
}));
jest.mock("@icecore/shared/lib/cache", () => ({
  ...jest.requireActual("@icecore/shared/lib/cache"),
  cache: {
    readWithStatus: (...args: unknown[]) => mockReadWithStatus(...args),
    writeWithStatus: (...args: unknown[]) => mockWriteWithStatus(...args),
  },
}));

import type {
  CreativeAssetReadUrlRequest,
  CreativeAssetReadUrlResponse,
} from "@icecore/airi-runtime/creative-asset-read-url";
import {
  isCreativeAssetDisplayReadUrlCacheEnabled,
  READ_URL_CACHE_EXPIRY_MARGIN_MS,
  READ_URL_CACHE_TIMEOUT_MS,
  readCreativeAssetReadUrlThroughCache,
  withCreativeAssetDisplayReadUrlCache,
} from "./creative-asset-read-url-cache";

const NOW = Date.parse("2026-09-30T12:00:00.000Z");
const PATH = "workspaces/ws-1/creative-assets/image/a/card.png";
const SIGNER = "https://media-api.example";

function request(
  overrides: Partial<CreativeAssetReadUrlRequest> = {}
): CreativeAssetReadUrlRequest {
  return {
    provider: "gcs",
    bucket: "media",
    path: PATH,
    workspaceId: "ws-1",
    ...overrides,
  };
}

function signed(
  url: string,
  validForMs = 60 * 60_000
): CreativeAssetReadUrlResponse {
  return {
    provider: "gcs",
    bucket: "media",
    path: PATH,
    url,
    expiresAt: new Date(NOW + validForMs).toISOString(),
  };
}

describe("readCreativeAssetReadUrlThroughCache", () => {
  const options = { signer: SIGNER, now: () => NOW };
  const store = new Map<string, unknown>();
  const originalVercelEnv = process.env.VERCEL_ENV;

  afterEach(() => {
    jest.useRealTimers();
    if (originalVercelEnv === undefined) delete process.env.VERCEL_ENV;
    else process.env.VERCEL_ENV = originalVercelEnv;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    store.clear();
    mockReadWithStatus.mockImplementation(async (key: string) =>
      store.has(key)
        ? { status: "hit", value: store.get(key) }
        : { status: "miss" }
    );
    mockWriteWithStatus.mockImplementation(
      async (key: string, value: unknown) => {
        store.set(key, value);
        return "stored";
      }
    );
  });

  it("signs once and serves the same URL until ten minutes before it expires", async () => {
    const createReadUrl = jest.fn(async () => signed("https://signed/1"));

    await expect(
      readCreativeAssetReadUrlThroughCache(request(), createReadUrl, options)
    ).resolves.toEqual(signed("https://signed/1"));
    await expect(
      readCreativeAssetReadUrlThroughCache(request(), createReadUrl, options)
    ).resolves.toEqual(signed("https://signed/1"));

    expect(createReadUrl).toHaveBeenCalledTimes(1);
    expect(createReadUrl).toHaveBeenCalledWith(request());
    const [key, value, ttlSeconds] = mockWriteWithStatus.mock.calls[0] ?? [];
    expect(value).toEqual(signed("https://signed/1"));
    expect(ttlSeconds).toBe(
      (60 * 60_000 - READ_URL_CACHE_EXPIRY_MARGIN_MS) / 1000
    );
    // The key is a digest: no object path or URL in Redis key space or logs.
    expect(key).toMatch(
      /^icecore:media:creative-asset-read-url:v1:[0-9a-f]{64}$/
    );
  });

  it("keys by workspace, so one workspace never receives another's signed URL", async () => {
    const createReadUrl = jest.fn(async (input: CreativeAssetReadUrlRequest) =>
      signed(`https://signed/${input.workspaceId}`)
    );

    await readCreativeAssetReadUrlThroughCache(
      request(),
      createReadUrl,
      options
    );
    await expect(
      readCreativeAssetReadUrlThroughCache(
        request({ workspaceId: "ws-2" }),
        createReadUrl,
        options
      )
    ).resolves.toEqual(signed("https://signed/ws-2"));

    expect(createReadUrl).toHaveBeenCalledTimes(2);
    const keys = mockWriteWithStatus.mock.calls.map(([key]) => key);
    expect(new Set(keys).size).toBe(2);
  });

  it("keys by requested expiry as well as bucket and path", async () => {
    const createReadUrl = jest.fn(async () => signed("https://signed/x"));

    await readCreativeAssetReadUrlThroughCache(
      request(),
      createReadUrl,
      options
    );
    await readCreativeAssetReadUrlThroughCache(
      request({ expiresInSeconds: 7_200 }),
      createReadUrl,
      options
    );
    await readCreativeAssetReadUrlThroughCache(
      request({ path: `${PATH}.2` }),
      createReadUrl,
      options
    );

    expect(createReadUrl).toHaveBeenCalledTimes(3);
  });

  it("never caches a request without a workspace", async () => {
    const createReadUrl = jest.fn(async () => signed("https://signed/anon"));

    await readCreativeAssetReadUrlThroughCache(
      request({ workspaceId: undefined }),
      createReadUrl,
      options
    );
    await readCreativeAssetReadUrlThroughCache(
      request({ workspaceId: "  " }),
      createReadUrl,
      options
    );

    expect(createReadUrl).toHaveBeenCalledTimes(2);
    expect(mockReadWithStatus).not.toHaveBeenCalled();
    expect(mockWriteWithStatus).not.toHaveBeenCalled();
  });

  it("re-signs a cached URL that has less than ten minutes left", async () => {
    const createReadUrl = jest
      .fn()
      .mockResolvedValueOnce(signed("https://signed/old"))
      .mockResolvedValueOnce(signed("https://signed/new"));
    await readCreativeAssetReadUrlThroughCache(
      request(),
      createReadUrl,
      options
    );

    const later = () => NOW + 50 * 60_000 + 1;
    await expect(
      readCreativeAssetReadUrlThroughCache(request(), createReadUrl, {
        ...options,
        now: later,
      })
    ).resolves.toEqual(signed("https://signed/new"));
    expect(createReadUrl).toHaveBeenCalledTimes(2);
  });

  it("does not cache a URL that would be servable for under a minute", async () => {
    const createReadUrl = jest.fn(async () =>
      signed("https://signed/short", READ_URL_CACHE_EXPIRY_MARGIN_MS + 59_000)
    );

    await readCreativeAssetReadUrlThroughCache(
      request(),
      createReadUrl,
      options
    );

    expect(mockWriteWithStatus).not.toHaveBeenCalled();
  });

  it("signs as before when Redis is unavailable or failing", async () => {
    mockReadWithStatus.mockResolvedValueOnce({ status: "unavailable" });
    mockReadWithStatus.mockRejectedValueOnce(new Error("redis down"));
    mockWriteWithStatus.mockResolvedValueOnce("unavailable");
    mockWriteWithStatus.mockRejectedValueOnce(new Error("redis down"));
    const createReadUrl = jest.fn(async () => signed("https://signed/live"));

    await expect(
      readCreativeAssetReadUrlThroughCache(request(), createReadUrl, options)
    ).resolves.toEqual(signed("https://signed/live"));
    await expect(
      readCreativeAssetReadUrlThroughCache(request(), createReadUrl, options)
    ).resolves.toEqual(signed("https://signed/live"));
    expect(createReadUrl).toHaveBeenCalledTimes(2);
  });

  it("ignores a malformed cached value", async () => {
    mockReadWithStatus.mockResolvedValueOnce({
      status: "hit",
      value: { provider: "gcs", url: "", expiresAt: "not a date" },
    });
    const createReadUrl = jest.fn(async () => signed("https://signed/fresh"));

    await expect(
      readCreativeAssetReadUrlThroughCache(request(), createReadUrl, options)
    ).resolves.toEqual(signed("https://signed/fresh"));
  });

  it("shares one signing call between identical requests in flight", async () => {
    let finish: (value: CreativeAssetReadUrlResponse) => void = () => {};
    const createReadUrl = jest.fn(
      () =>
        new Promise<CreativeAssetReadUrlResponse>(resolve => {
          finish = resolve;
        })
    );

    const first = readCreativeAssetReadUrlThroughCache(
      request(),
      createReadUrl,
      options
    );
    const second = readCreativeAssetReadUrlThroughCache(
      request(),
      createReadUrl,
      options
    );
    await new Promise(resolve => setImmediate(resolve));
    finish(signed("https://signed/shared"));

    await expect(Promise.all([first, second])).resolves.toEqual([
      signed("https://signed/shared"),
      signed("https://signed/shared"),
    ]);
    expect(createReadUrl).toHaveBeenCalledTimes(1);
  });

  it("does not cache a failed signing call and retries it next time", async () => {
    const failure = new Error("Media API HTTP 503");
    const createReadUrl = jest
      .fn()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(signed("https://signed/retry"));

    await expect(
      readCreativeAssetReadUrlThroughCache(request(), createReadUrl, options)
    ).rejects.toBe(failure);
    expect(mockWriteWithStatus).not.toHaveBeenCalled();
    await expect(
      readCreativeAssetReadUrlThroughCache(request(), createReadUrl, options)
    ).resolves.toEqual(signed("https://signed/retry"));
  });

  it("never shares a URL between deployment environments or signers", async () => {
    const createReadUrl = jest.fn(async () => signed("https://signed/env"));

    process.env.VERCEL_ENV = "preview";
    await readCreativeAssetReadUrlThroughCache(
      request(),
      createReadUrl,
      options
    );
    process.env.VERCEL_ENV = "production";
    await readCreativeAssetReadUrlThroughCache(
      request(),
      createReadUrl,
      options
    );
    await readCreativeAssetReadUrlThroughCache(request(), createReadUrl, {
      ...options,
      signer: "http://127.0.0.1:8080",
    });
    await readCreativeAssetReadUrlThroughCache(
      request(),
      createReadUrl,
      options
    );

    expect(createReadUrl).toHaveBeenCalledTimes(3);
    const keys = mockWriteWithStatus.mock.calls.map(([key]) => key);
    expect(new Set(keys).size).toBe(3);
  });

  it("signs without waiting longer than the timeout for a slow Redis read", async () => {
    jest.useFakeTimers();
    mockReadWithStatus.mockReturnValueOnce(new Promise(() => undefined));
    const createReadUrl = jest.fn(async () => signed("https://signed/slow"));

    const result = readCreativeAssetReadUrlThroughCache(
      request(),
      createReadUrl,
      options
    );
    await jest.advanceTimersByTimeAsync(READ_URL_CACHE_TIMEOUT_MS - 1);
    expect(createReadUrl).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);

    await expect(result).resolves.toEqual(signed("https://signed/slow"));
  });

  it("answers without waiting for the cache write, which runs after the response", async () => {
    jest.useFakeTimers();
    mockWriteWithStatus.mockReturnValueOnce(new Promise(() => undefined));
    const createReadUrl = jest.fn(async () => signed("https://signed/fresh"));
    let answered = false;

    const result = readCreativeAssetReadUrlThroughCache(
      request(),
      createReadUrl,
      options
    ).then(response => {
      answered = true;
      return response;
    });
    await jest.advanceTimersByTimeAsync(0);

    expect(answered).toBe(true);
    await expect(result).resolves.toEqual(signed("https://signed/fresh"));
    expect(mockWriteWithStatus).toHaveBeenCalledTimes(1);
    expect(mockAfter).toHaveBeenCalledTimes(1);
    const write = mockAfter.mock.calls[0]?.[0] as Promise<unknown>;
    await jest.advanceTimersByTimeAsync(READ_URL_CACHE_TIMEOUT_MS);
    await expect(write).resolves.toBe("unavailable");
  });

  it("hands the cache write to after() before it answers", async () => {
    // Signing that outlived a response is itself kept alive by after() until
    // it answers, so the function is still running when the write joins it.
    const createReadUrl = jest.fn(async () => signed("https://signed/1"));

    const afterCallsWhenAnswered = await readCreativeAssetReadUrlThroughCache(
      request(),
      createReadUrl,
      options
    ).then(() => mockAfter.mock.calls.length);

    expect(afterCallsWhenAnswered).toBe(1);
  });

  it("still answers outside a request scope, where after() is unavailable", async () => {
    mockAfter.mockImplementationOnce(() => {
      throw new Error("`after` was called outside a request scope.");
    });
    const createReadUrl = jest.fn(async () => signed("https://signed/1"));

    await expect(
      readCreativeAssetReadUrlThroughCache(request(), createReadUrl, options)
    ).resolves.toEqual(signed("https://signed/1"));
    expect(mockWriteWithStatus).toHaveBeenCalledTimes(1);
  });
});

describe("withCreativeAssetDisplayReadUrlCache", () => {
  it("enables the cache only for work started inside it", async () => {
    expect(isCreativeAssetDisplayReadUrlCacheEnabled()).toBe(false);

    const seen = await withCreativeAssetDisplayReadUrlCache(async () => {
      const before = isCreativeAssetDisplayReadUrlCacheEnabled();
      await new Promise(resolve => setImmediate(resolve));
      return [before, isCreativeAssetDisplayReadUrlCacheEnabled()];
    });

    expect(seen).toEqual([true, true]);
    expect(isCreativeAssetDisplayReadUrlCacheEnabled()).toBe(false);
  });

  it("is one scope for every copy of this module", async () => {
    // Instrumentation and pages each load their own copy of this module.
    let isEnabledInOtherCopy = () => false;
    await jest.isolateModulesAsync(async () => {
      const otherCopy = await import("./creative-asset-read-url-cache");
      isEnabledInOtherCopy =
        otherCopy.isCreativeAssetDisplayReadUrlCacheEnabled;
    });

    const seen = await withCreativeAssetDisplayReadUrlCache(async () =>
      isEnabledInOtherCopy()
    );

    expect(isEnabledInOtherCopy).not.toBe(
      isCreativeAssetDisplayReadUrlCacheEnabled
    );
    expect(seen).toBe(true);
  });
});
