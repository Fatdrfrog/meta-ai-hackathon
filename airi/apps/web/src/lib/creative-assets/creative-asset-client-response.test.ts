import {
  fetchCreativeAssetStatuses,
  readJsonResponse,
  requireQueuedAsset,
} from "./creative-asset-client-response";

function response(input: {
  ok?: boolean;
  status?: number;
  json: () => Promise<unknown>;
}): Response {
  return {
    ok: input.ok ?? true,
    status: input.status ?? 200,
    json: input.json,
  } as Response;
}

describe("creative asset client responses", () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it.each([null, [], "ok"])("rejects non-object JSON %p", async decoded => {
    await expect(
      readJsonResponse(response({ json: async () => decoded }))
    ).rejects.toThrow(/response could not be read/i);
  });

  it("preserves an API error from an object response", async () => {
    await expect(
      readJsonResponse(
        response({
          ok: false,
          status: 409,
          json: async () => ({ error: "Idempotency conflict" }),
        })
      )
    ).rejects.toThrow("Idempotency conflict");
  });

  it("requires a definite queued asset before callers retire a request key", () => {
    expect(() => requireQueuedAsset({})).toThrow(/did not return/i);
    expect(requireQueuedAsset({ asset: { id: "asset-1" } })).toEqual({
      id: "asset-1",
    });
  });

  it("loads status ids in bounded batches", async () => {
    const fetcher = jest.fn(async (url: RequestInfo | URL) => {
      const ids = new URL(String(url), "https://airi.chat").searchParams
        .get("ids")!
        .split(",");
      return response({
        json: async () => ({ assets: ids.map(id => ({ id })) }),
      });
    });
    const assetIds = Array.from(
      { length: 205 },
      (_, index) => `asset-${index}`
    );

    await expect(
      fetchCreativeAssetStatuses(
        { workspaceId: "workspace/one", assetIds },
        fetcher as typeof fetch
      )
    ).resolves.toHaveLength(205);

    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(String(fetcher.mock.calls[0]?.[0])).toContain("workspace%2Fone");
  });

  it("aborts a stalled status request at its deadline", async () => {
    jest.useFakeTimers();
    let requestSignal: AbortSignal | undefined;
    const fetcher = jest.fn((_url: RequestInfo | URL, init?: RequestInit) => {
      requestSignal = init?.signal || undefined;
      return new Promise<Response>(() => undefined);
    });

    const request = fetchCreativeAssetStatuses(
      {
        workspaceId: "workspace-1",
        assetIds: ["asset-1"],
        requestTimeoutMs: 25,
      },
      fetcher as typeof fetch
    );
    const rejected = expect(request).rejects.toMatchObject({
      name: "TimeoutError",
    });

    expect(requestSignal?.aborted).toBe(false);
    jest.advanceTimersByTime(24);
    expect(requestSignal?.aborted).toBe(false);
    jest.advanceTimersByTime(1);

    await rejected;
    expect(requestSignal?.aborted).toBe(true);
  });

  it("propagates caller cancellation to an active status request", async () => {
    const caller = new AbortController();
    let requestSignal: AbortSignal | undefined;
    const fetcher = jest.fn((_url: RequestInfo | URL, init?: RequestInit) => {
      requestSignal = init?.signal || undefined;
      return new Promise<Response>(() => undefined);
    });

    const request = fetchCreativeAssetStatuses(
      {
        workspaceId: "workspace-1",
        assetIds: ["asset-1"],
        signal: caller.signal,
      },
      fetcher as typeof fetch
    );
    const rejected = expect(request).rejects.toMatchObject({
      name: "AbortError",
    });

    caller.abort();

    await rejected;
    expect(requestSignal?.aborted).toBe(true);
  });

  it("aborts sibling batches when one request in a wave fails", async () => {
    const requestSignals: AbortSignal[] = [];
    const fetcher = jest.fn(
      (_url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const signal = init?.signal as AbortSignal;
        requestSignals.push(signal);
        if (requestSignals.length === 1) {
          return Promise.reject(new Error("status endpoint unavailable"));
        }
        return new Promise<Response>(() => undefined);
      }
    );

    await expect(
      fetchCreativeAssetStatuses(
        {
          workspaceId: "workspace-1",
          assetIds: Array.from({ length: 205 }, (_, index) => `asset-${index}`),
        },
        fetcher as typeof fetch
      )
    ).rejects.toThrow("status endpoint unavailable");

    expect(requestSignals).toHaveLength(3);
    expect(requestSignals.slice(1).every(signal => signal.aborted)).toBe(true);
  });
});
