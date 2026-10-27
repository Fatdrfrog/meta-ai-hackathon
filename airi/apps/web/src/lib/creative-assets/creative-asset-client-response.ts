export async function readJsonResponse<T>(response: Response): Promise<T> {
  let decoded: unknown;
  try {
    decoded = await response.json();
  } catch {
    throw new Error(
      response.ok
        ? "The server accepted the request but its response could not be read. Retry the same request."
        : `Request failed with ${response.status}`
    );
  }

  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
    throw new Error(
      response.ok
        ? "The server accepted the request but its response could not be read. Retry the same request."
        : `Request failed with ${response.status}`
    );
  }
  const payload = decoded as T & { error?: unknown };
  if (!response.ok) {
    throw new Error(
      typeof payload.error === "string" && payload.error
        ? payload.error
        : `Request failed with ${response.status}`
    );
  }
  return payload;
}

export function requireQueuedAsset<T>(payload: { asset?: T }): T {
  if (!payload.asset) {
    throw new Error(
      "The server accepted the request but did not return the queued asset. Retry the same request."
    );
  }
  return payload.asset;
}

const ASSET_STATUS_BATCH_SIZE = 100;
const ASSET_STATUS_BATCH_CONCURRENCY = 4;
export const CREATIVE_ASSET_STATUS_REQUEST_TIMEOUT_MS = 10_000;

function createRequestTimeoutError() {
  const error = new Error("Creative asset status request timed out");
  error.name = "TimeoutError";
  return error;
}

function getAbortReason(signal: AbortSignal) {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error("Creative asset status request was aborted");
  error.name = "AbortError";
  return error;
}

async function fetchWithRequestDeadline(
  fetcher: typeof fetch,
  url: string,
  input: {
    signal?: AbortSignal;
    timeoutMs: number;
  }
) {
  const requestController = new AbortController();
  const callerSignal = input.signal;
  const abortFromCaller = () => {
    if (callerSignal) requestController.abort(getAbortReason(callerSignal));
  };

  if (callerSignal?.aborted) {
    abortFromCaller();
  } else {
    callerSignal?.addEventListener("abort", abortFromCaller, { once: true });
  }

  if (requestController.signal.aborted) {
    throw getAbortReason(requestController.signal);
  }

  let rejectOnAbort: ((reason: Error) => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    rejectOnAbort = reject;
  });
  const rejectAbortedRequest = () => {
    rejectOnAbort?.(getAbortReason(requestController.signal));
  };
  requestController.signal.addEventListener("abort", rejectAbortedRequest, {
    once: true,
  });

  const timeout = setTimeout(() => {
    requestController.abort(createRequestTimeoutError());
  }, input.timeoutMs);

  try {
    return await Promise.race([
      fetcher(url, {
        cache: "no-store",
        signal: requestController.signal,
      }),
      aborted,
    ]);
  } finally {
    clearTimeout(timeout);
    callerSignal?.removeEventListener("abort", abortFromCaller);
    requestController.signal.removeEventListener("abort", rejectAbortedRequest);
  }
}

export async function fetchCreativeAssetStatuses<T extends { id: string }>(
  input: {
    workspaceId: string;
    assetIds: string[];
    signal?: AbortSignal;
    requestTimeoutMs?: number;
  },
  fetcher: typeof fetch = fetch
): Promise<T[]> {
  const ids = Array.from(
    new Set(input.assetIds.map(id => id.trim()).filter(Boolean))
  );
  const chunks: string[][] = [];
  for (let offset = 0; offset < ids.length; offset += ASSET_STATUS_BATCH_SIZE) {
    chunks.push(ids.slice(offset, offset + ASSET_STATUS_BATCH_SIZE));
  }
  const configuredTimeoutMs = input.requestTimeoutMs;
  const requestTimeoutMs =
    typeof configuredTimeoutMs === "number" &&
    Number.isFinite(configuredTimeoutMs) &&
    configuredTimeoutMs > 0
      ? configuredTimeoutMs
      : CREATIVE_ASSET_STATUS_REQUEST_TIMEOUT_MS;

  const assets: T[] = [];
  for (
    let offset = 0;
    offset < chunks.length;
    offset += ASSET_STATUS_BATCH_CONCURRENCY
  ) {
    const waveController = new AbortController();
    const abortWaveFromCaller = () => {
      if (input.signal) {
        waveController.abort(getAbortReason(input.signal));
      }
    };
    if (input.signal?.aborted) abortWaveFromCaller();
    else
      input.signal?.addEventListener("abort", abortWaveFromCaller, {
        once: true,
      });

    let wave: T[][];
    try {
      wave = await Promise.all(
        chunks
          .slice(offset, offset + ASSET_STATUS_BATCH_CONCURRENCY)
          .map(async chunk => {
            try {
              const payload = await readJsonResponse<{ assets?: T[] }>(
                await fetchWithRequestDeadline(
                  fetcher,
                  `/api/workspaces/${encodeURIComponent(input.workspaceId)}/assets?surface=status&ids=${encodeURIComponent(chunk.join(","))}`,
                  {
                    signal: waveController.signal,
                    timeoutMs: requestTimeoutMs,
                  }
                )
              );
              return payload.assets || [];
            } catch (error) {
              if (!waveController.signal.aborted) {
                waveController.abort(
                  error instanceof Error
                    ? error
                    : new Error("Creative asset status request failed")
                );
              }
              throw error;
            }
          })
      );
    } finally {
      input.signal?.removeEventListener("abort", abortWaveFromCaller);
    }
    for (const batch of wave) assets.push(...batch);
  }
  return assets;
}
