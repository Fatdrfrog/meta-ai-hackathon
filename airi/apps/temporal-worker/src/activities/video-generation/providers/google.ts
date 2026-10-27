import type {
  CompiledVideoPrompt,
  VideoGenerationSpec,
} from "@icecore/temporal";
import {
  normalizeVideoProviderRequestLocator,
  videoProviderResultUnavailable,
  VideoProviderError,
  type VideoProviderPoll,
  type VideoProviderSubmission,
} from "./happyhorse.js";

const MAX_GOOGLE_SOURCE_BYTES = 20 * 1024 * 1024;
const GOOGLE_SOURCE_DOWNLOAD_TIMEOUT_MS = 60_000;

type GoogleSpec = Extract<VideoGenerationSpec, { provider: "google" }>;

export type PreparedGoogleSubmission = {
  provider: "google";
  spec: GoogleSpec;
  prompt: CompiledVideoPrompt;
  sourceImage: { data: string; mimeType: string };
  post: () => Promise<VideoProviderSubmission>;
};

export function classifyGoogleSubmitFailure(
  error: unknown,
): VideoProviderError {
  const typed =
    error && typeof error === "object"
      ? (error as {
          statusCode?: unknown;
          payload?: unknown;
          retryable?: unknown;
        })
      : null;
  const message = error instanceof Error ? error.message : "";
  const statusMatch = /HTTP\s+(\d{3})/i.exec(message);
  const statusCode =
    typeof typed?.statusCode === "number"
      ? typed.statusCode
      : statusMatch?.[1]
        ? Number(statusMatch[1])
        : null;
  const definitelyRejected =
    statusCode !== null &&
    statusCode >= 400 &&
    statusCode < 500 &&
    statusCode !== 408 &&
    statusCode !== 429;
  return new VideoProviderError({
    code: definitelyRejected
      ? "provider_rejected"
      : "provider_submission_uncertain",
    message: definitelyRejected
      ? "Google rejected the generation request"
      : "Google submission outcome is unknown",
    providerCode: statusCode === null ? null : String(statusCode),
    phase: "submit",
    retryable: definitelyRejected ? false : typed?.retryable !== false,
    certainty: definitelyRejected ? "not_attempted" : "unknown",
    diagnostic: typed?.payload,
  });
}

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Best-effort release of a rejected or oversized source response.
  }
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("Google source image download was cancelled");
}

function withAbort<T>(
  signal: AbortSignal,
  operation: () => Promise<T>,
): Promise<T> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(abortReason(signal)));
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve()
      .then(operation)
      .then(
        (value) => finish(() => resolve(value)),
        (error) => finish(() => reject(error)),
      );
  });
}

function operationName(value: unknown, phase: "submit" | "poll"): string {
  const name = normalizeVideoProviderRequestLocator(value, phase);
  return normalizeVideoProviderRequestLocator(name.replace(/^\/+/, ""), phase);
}

export function normalizeGoogleSubmitResult(value: {
  name?: unknown;
  done?: unknown;
  response?: unknown;
  error?: unknown;
  [key: string]: unknown;
}): VideoProviderSubmission {
  const providerRequestId = operationName(value.name, "submit");
  if (
    value.error &&
    typeof value.error === "object" &&
    Object.keys(value.error).length > 0
  ) {
    return {
      providerRequestId,
      providerRequestLocator: providerRequestId,
      status: "failed",
    };
  }
  if (
    value.done === true &&
    (!value.response ||
      typeof value.response !== "object" ||
      Object.keys(value.response).length === 0)
  ) {
    throw new VideoProviderError({
      code: "provider_protocol_error",
      message: "Google returned an incomplete successful submission response",
      phase: "submit",
      retryable: true,
      certainty: "unknown",
    });
  }
  return {
    providerRequestId,
    providerRequestLocator: providerRequestId,
    status: value.done === true ? "completed" : "queued",
  };
}

export function normalizeGooglePollResult(value: {
  name?: unknown;
  done?: unknown;
  response?: unknown;
  error?: unknown;
  [key: string]: unknown;
}): VideoProviderPoll {
  const providerRequestId = operationName(value.name, "poll");
  if (
    value.error &&
    typeof value.error === "object" &&
    Object.keys(value.error).length > 0
  )
    return { providerRequestId, status: "failed" };
  if (value.done === false) return { providerRequestId, status: "in_progress" };
  if (
    value.done === true &&
    value.response &&
    typeof value.response === "object" &&
    Object.keys(value.response).length > 0
  )
    return { providerRequestId, status: "completed" };
  throw new VideoProviderError({
    code: "provider_protocol_error",
    message: "Google returned an unknown operation state",
    phase: "poll",
    retryable: false,
    certainty: "not_attempted",
    diagnostic: { done: value.done, error: value.error },
  });
}

export async function prepareGoogleSourceImage(
  sourceUrl: string,
  fetcher: typeof fetch = fetch,
  options: { timeoutMs?: number; maxBytes?: number } = {},
): Promise<{ data: string; mimeType: string }> {
  let url: URL;
  try {
    url = new URL(sourceUrl);
  } catch {
    throw new VideoProviderError({
      code: "source_url_invalid",
      message: "Source image is unavailable",
      phase: "submit",
      retryable: true,
      certainty: "not_attempted",
    });
  }
  if (url.protocol !== "https:")
    throw new VideoProviderError({
      code: "source_url_invalid",
      message: "Source image must use HTTPS",
      phase: "submit",
      retryable: true,
      certainty: "not_attempted",
    });
  const requestedTimeout = options.timeoutMs;
  const maxBytes =
    typeof options.maxBytes === "number" &&
    Number.isSafeInteger(options.maxBytes) &&
    options.maxBytes > 0
      ? Math.min(options.maxBytes, MAX_GOOGLE_SOURCE_BYTES)
      : MAX_GOOGLE_SOURCE_BYTES;
  const timeoutMs =
    typeof requestedTimeout === "number" &&
    Number.isFinite(requestedTimeout) &&
    requestedTimeout > 0
      ? Math.min(120_000, Math.floor(requestedTimeout))
      : GOOGLE_SOURCE_DOWNLOAD_TIMEOUT_MS;
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error("Google source image download timed out")),
    timeoutMs,
  );
  try {
    const response = await withAbort(controller.signal, () =>
      fetcher(url.toString(), {
        method: "GET",
        redirect: "error",
        signal: controller.signal,
      }),
    );
    if (!response.ok) {
      await cancelResponseBody(response);
      throw new VideoProviderError({
        code: "source_download_failed",
        message: "Source image could not be downloaded",
        phase: "submit",
        retryable: true,
        certainty: "not_attempted",
        diagnostic: { statusCode: response.status },
      });
    }
    const mimeType =
      (response.headers.get("content-type") || "")
        .split(";")[0]
        ?.trim()
        .toLowerCase() || "";
    const declaredSize = Number(response.headers.get("content-length") || 0);
    if (
      !mimeType.startsWith("image/") ||
      (declaredSize > 0 && declaredSize > maxBytes)
    ) {
      await cancelResponseBody(response);
      throw new VideoProviderError({
        code: "source_media_invalid",
        message: "Source image has an unsupported type or size",
        phase: "submit",
        retryable: false,
        certainty: "not_attempted",
      });
    }
    if (!response.body)
      throw new VideoProviderError({
        code: "source_media_invalid",
        message: "Source image has an unsupported type or size",
        phase: "submit",
        retryable: false,
        certainty: "not_attempted",
      });
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let byteLength = 0;
    let finished = false;
    try {
      for (;;) {
        const part = await withAbort(controller.signal, () => reader.read());
        if (part.done) break;
        byteLength += part.value.byteLength;
        if (byteLength > maxBytes) {
          await reader.cancel();
          throw new VideoProviderError({
            code: "source_media_invalid",
            message: "Source image has an unsupported type or size",
            phase: "submit",
            retryable: false,
            certainty: "not_attempted",
          });
        }
        chunks.push(part.value);
      }
      finished = true;
    } finally {
      if (!finished) {
        try {
          await reader.cancel();
        } catch {
          // The stream may already be errored or cancelled.
        }
      }
      reader.releaseLock();
    }
    const buffer = Buffer.concat(
      chunks.map((chunk) => Buffer.from(chunk)),
      byteLength,
    );
    if (buffer.byteLength === 0)
      throw new VideoProviderError({
        code: "source_media_invalid",
        message: "Source image has an unsupported type or size",
        phase: "submit",
        retryable: false,
        certainty: "not_attempted",
      });
    return { data: buffer.toString("base64"), mimeType };
  } catch (error) {
    if (error instanceof VideoProviderError) throw error;
    throw new VideoProviderError({
      code: "source_download_failed",
      message: "Source image could not be downloaded",
      phase: "submit",
      retryable: true,
      certainty: "not_attempted",
    });
  } finally {
    clearTimeout(timeout);
  }
}

export async function prepareGoogleVideoSubmission(input: {
  spec: GoogleSpec;
  prompt: CompiledVideoPrompt;
  sourceUrl: string;
  workspaceId: string;
  providerSourceId: string | null;
}): Promise<PreparedGoogleSubmission> {
  const [client, { assertProviderPrompt }] = await Promise.all([
    import("@/lib/google/creative-assets"),
    import("@/lib/creative-assets/video-generation-prompt"),
  ]);
  const apiKey = await client.resolveGoogleCreativeWorkerApiKey(input);
  assertProviderPrompt(input.prompt.providerPrompt, 1_200);
  const sourceImage = await prepareGoogleSourceImage(input.sourceUrl);
  const prepared = {
    provider: "google" as const,
    spec: input.spec,
    prompt: input.prompt,
    sourceImage,
  };
  const providerPost = client.prepareGoogleVideoGenerationContractV1({
    apiKey,
    modelId: prepared.spec.modelId,
    prompt: prepared.prompt.providerPrompt,
    aspectRatio: prepared.spec.aspectRatio,
    durationSeconds: prepared.spec.durationSeconds,
    image: prepared.sourceImage,
  });
  return {
    ...prepared,
    post: async () => {
      try {
        return normalizeGoogleSubmitResult(await providerPost());
      } catch (error) {
        if (error instanceof VideoProviderError) throw error;
        if (error instanceof client.GoogleCreativeProtocolError) {
          throw new VideoProviderError({
            code: "provider_protocol_error",
            message: "Google returned an invalid submission response",
            phase: "submit",
            retryable: true,
            certainty: "unknown",
            diagnostic: error.value,
          });
        }
        throw classifyGoogleSubmitFailure(error);
      }
    },
  };
}

export async function submitGoogleVideoProvider(
  input: PreparedGoogleSubmission,
): Promise<VideoProviderSubmission> {
  return input.post();
}

export async function pollGoogleVideoProvider(
  input: {
    providerRequestLocator: string;
    workspaceId: string;
    providerSourceId: string | null;
  },
  persistDiagnostic: (value: unknown) => Promise<void>,
): Promise<VideoProviderPoll> {
  const client = await import("@/lib/google/creative-assets");
  try {
    const operation = await client.pollGoogleVideoOperationContractV1(
      operationName(input.providerRequestLocator, "poll"),
      await client.resolveGoogleCreativeWorkerApiKey({
        ...input,
        allowLegacyPlatform: true,
      }),
    );
    await persistDiagnostic(operation.raw);
    return normalizeGooglePollResult(operation);
  } catch (error) {
    if (error instanceof VideoProviderError) throw error;
    if (error instanceof client.GoogleCreativeProtocolError) {
      throw new VideoProviderError({
        code: "provider_protocol_error",
        message: "Google returned an invalid poll response",
        phase: "poll",
        retryable: false,
        certainty: "not_attempted",
        diagnostic: error.value,
      });
    }
    if (error instanceof client.GoogleCreativeApiError) {
      throw new VideoProviderError({
        code: "provider_poll_failed",
        message: "Google status could not be read",
        providerCode: String(error.statusCode),
        phase: "poll",
        retryable: error.retryable,
        certainty: "not_attempted",
        diagnostic: error.payload,
      });
    }
    throw new VideoProviderError({
      code: "provider_poll_failed",
      message: "Google status could not be read",
      phase: "poll",
      retryable: true,
      certainty: "not_attempted",
    });
  }
}

export async function loadFinalGoogleVideoResult(input: {
  providerRequestLocator: string;
  workspaceId: string;
  providerSourceId: string | null;
}): Promise<{ url?: string; videoBytes?: string; mimeType: string }> {
  const {
    pollGoogleVideoOperationContractV1,
    extractGoogleVideoResult,
    assertGoogleMediaUrl,
    resolveGoogleCreativeWorkerApiKey,
  } = await import("@/lib/google/creative-assets");
  const operation = await pollGoogleVideoOperationContractV1(
    operationName(input.providerRequestLocator, "poll"),
    await resolveGoogleCreativeWorkerApiKey({
      ...input,
      allowLegacyPlatform: true,
    }),
  );
  let normalized: VideoProviderPoll;
  try {
    normalized = normalizeGooglePollResult(operation);
  } catch (error) {
    const hasProviderError =
      operation.error &&
      typeof operation.error === "object" &&
      Object.keys(operation.error).length > 0;
    if (
      error instanceof VideoProviderError &&
      error.code === "provider_protocol_error" &&
      operation.done === true &&
      !hasProviderError
    ) {
      throw videoProviderResultUnavailable("in_progress");
    }
    throw error;
  }
  const result = extractGoogleVideoResult(operation.response);
  if (normalized.status !== "completed" || !result)
    throw videoProviderResultUnavailable(normalized.status);
  return {
    ...(result.uri ? { url: assertGoogleMediaUrl(result.uri).toString() } : {}),
    ...(result.videoBytes ? { videoBytes: result.videoBytes } : {}),
    mimeType: result.mimeType,
  };
}
