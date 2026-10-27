export type BoundedJsonResponseErrorCode =
  | "provider_response_too_large"
  | "provider_response_timeout";

export class BoundedJsonResponseError extends Error {
  constructor(
    readonly code: BoundedJsonResponseErrorCode,
    readonly limit: number
  ) {
    super(
      code === "provider_response_too_large"
        ? `Provider JSON response exceeds ${limit} bytes`
        : `Provider JSON response exceeded its ${limit}ms deadline`
    );
    this.name = "BoundedJsonResponseError";
  }
}

type BoundedJsonFetchOptions = {
  maxBytes: number;
  timeoutMs: number;
};

function abortReason(signal: AbortSignal): unknown {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("Provider JSON request was aborted");
}

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Best-effort release; the body may already be locked or errored.
  }
}

async function readResponseTextWithinLimit(
  response: Response,
  maxBytes: number,
  signal: AbortSignal
): Promise<string> {
  const declaredBytes = Number(response.headers.get("content-length") || 0);
  if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
    await cancelResponseBody(response);
    throw new BoundedJsonResponseError("provider_response_too_large", maxBytes);
  }

  if (!response.body) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maxBytes) {
      throw new BoundedJsonResponseError(
        "provider_response_too_large",
        maxBytes
      );
    }
    return text;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let receivedBytes = 0;
  let complete = false;
  let cancelPromise: Promise<void> | null = null;
  const cancelReader = (reason?: unknown) => {
    cancelPromise ??= reader.cancel(reason).catch(() => undefined);
    return cancelPromise;
  };
  const onAbort = () => {
    void cancelReader(signal.reason);
  };
  signal.addEventListener("abort", onAbort, { once: true });

  try {
    for (;;) {
      const part = await reader.read();
      if (signal.aborted) throw abortReason(signal);
      if (part.done) {
        complete = true;
        break;
      }
      receivedBytes += part.value.byteLength;
      if (receivedBytes > maxBytes) {
        throw new BoundedJsonResponseError(
          "provider_response_too_large",
          maxBytes
        );
      }
      chunks.push(decoder.decode(part.value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return chunks.join("");
  } finally {
    signal.removeEventListener("abort", onAbort);
    if (!complete) await cancelReader();
    reader.releaseLock();
  }
}

export async function fetchJsonWithinLimits(
  input: RequestInfo | URL,
  init: RequestInit,
  options: BoundedJsonFetchOptions
): Promise<{ response: Response; payload: unknown }> {
  const controller = new AbortController();
  const upstreamSignal = init.signal;
  const relayAbort = () => controller.abort(upstreamSignal?.reason);
  if (upstreamSignal?.aborted) relayAbort();
  else upstreamSignal?.addEventListener("abort", relayAbort, { once: true });

  let removeAbortListener: () => void = () => undefined;
  const aborted = new Promise<never>((_, reject) => {
    const rejectAbort = () => reject(abortReason(controller.signal));
    if (controller.signal.aborted) {
      rejectAbort();
      return;
    }
    controller.signal.addEventListener("abort", rejectAbort, { once: true });
    removeAbortListener = () => {
      controller.signal.removeEventListener("abort", rejectAbort);
    };
  });
  const timer = setTimeout(
    () =>
      controller.abort(
        new BoundedJsonResponseError(
          "provider_response_timeout",
          options.timeoutMs
        )
      ),
    options.timeoutMs
  );

  try {
    const response = await Promise.race([
      fetch(input, { ...init, signal: controller.signal }),
      aborted,
    ]);
    const text = await Promise.race([
      readResponseTextWithinLimit(
        response,
        options.maxBytes,
        controller.signal
      ),
      aborted,
    ]);
    let payload: unknown = null;
    try {
      payload = JSON.parse(text);
    } catch {
      // Match Response.json().catch(() => null) at the existing client seams.
    }
    return { response, payload };
  } catch (error) {
    if (!controller.signal.aborted) controller.abort(error);
    throw error;
  } finally {
    clearTimeout(timer);
    removeAbortListener();
    upstreamSignal?.removeEventListener("abort", relayAbort);
  }
}
