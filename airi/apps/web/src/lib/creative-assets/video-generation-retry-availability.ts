export type VideoGenerationProviderResultResume = {
  providerRequestId: string;
  providerRequestLocator: string;
  pollCount: 0;
  elapsedMs: 0;
};

export type VideoGenerationRetryAvailability = {
  canRetry: boolean;
  mode: "provider_result" | "fresh" | null;
  requiresDuplicateChargeAcknowledgement: boolean;
  providerResultResume: VideoGenerationProviderResultResume | null;
};

type VideoGenerationRetryAsset = {
  status?: unknown;
  providerRequestId?: unknown;
  providerStatusUrl?: unknown;
  generation?: {
    contractVersion?: unknown;
    submission?: {
      state?: unknown;
      providerRequestId?: unknown;
    } | null;
    failure?: {
      phase?: unknown;
      code?: unknown;
      retryable?: unknown;
      submissionUncertain?: unknown;
    } | null;
  } | null;
};

const RECOVERABLE_PROVIDER_RESULT_PHASES = new Set([
  "poll",
  "download",
  "probe",
  "store",
]);

const DEFINITIVE_PROVIDER_RESULT_CODES = new Set([
  "provider_failed",
  "provider_cancelled",
  "provider_nsfw",
]);

export function resolveVideoGenerationProviderResultResume(
  asset: VideoGenerationRetryAsset
): VideoGenerationProviderResultResume | null {
  const submission = asset.generation?.submission;
  const providerRequestId = submission?.providerRequestId;
  const providerRequestLocator = asset.providerStatusUrl;

  if (
    submission?.state !== "submitted" ||
    typeof providerRequestId !== "string" ||
    providerRequestId.length < 1 ||
    providerRequestId.length > 500 ||
    asset.providerRequestId !== providerRequestId ||
    typeof providerRequestLocator !== "string" ||
    providerRequestLocator.length < 1 ||
    providerRequestLocator.length > 500 ||
    /:\/\/|[?#]/.test(providerRequestLocator)
  ) {
    return null;
  }

  return {
    providerRequestId,
    providerRequestLocator,
    pollCount: 0,
    elapsedMs: 0,
  };
}

export function resolveVideoGenerationRetryAvailability(
  asset: VideoGenerationRetryAsset
): VideoGenerationRetryAvailability {
  const generation = asset.generation;
  const failure = generation?.failure;

  if (
    asset.status !== "failed" ||
    generation?.contractVersion !== 1 ||
    !failure
  ) {
    return {
      canRetry: false,
      mode: null,
      requiresDuplicateChargeAcknowledgement: false,
      providerResultResume: null,
    };
  }

  const providerResultResume =
    RECOVERABLE_PROVIDER_RESULT_PHASES.has(String(failure.phase)) &&
    (failure.retryable === true ||
      failure.code === "provider_result_not_ready") &&
    !DEFINITIVE_PROVIDER_RESULT_CODES.has(String(failure.code))
      ? resolveVideoGenerationProviderResultResume(asset)
      : null;

  if (providerResultResume) {
    return {
      canRetry: true,
      mode: "provider_result",
      requiresDuplicateChargeAcknowledgement: false,
      providerResultResume,
    };
  }

  const canRetry =
    failure.retryable === true || failure.submissionUncertain === true;
  return {
    canRetry,
    mode: canRetry ? "fresh" : null,
    requiresDuplicateChargeAcknowledgement:
      canRetry && failure.submissionUncertain === true,
    providerResultResume: null,
  };
}
