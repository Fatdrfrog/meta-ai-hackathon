import type {
  CompiledVideoPrompt,
  VideoGenerationSpec,
} from "@icecore/temporal";

export type NormalizedVideoProviderStatus =
  | "queued"
  | "in_progress"
  | "completed"
  | "failed"
  | "nsfw"
  | "cancelled";

export type VideoProviderSubmission = {
  providerRequestId: string;
  providerRequestLocator: string;
  status: NormalizedVideoProviderStatus;
};

export type VideoProviderPoll = {
  providerRequestId: string;
  status: NormalizedVideoProviderStatus;
};

export type SubmissionCertainty = "not_attempted" | "unknown";

export class VideoProviderError extends Error {
  readonly code: string;
  readonly providerCode: string | null;
  readonly phase: "submit" | "poll";
  readonly retryable: boolean;
  readonly certainty: SubmissionCertainty;
  readonly diagnostic: unknown;

  constructor(input: {
    code: string;
    message: string;
    providerCode?: string | null;
    phase: "submit" | "poll";
    retryable: boolean;
    certainty: SubmissionCertainty;
    diagnostic?: unknown;
  }) {
    super(input.message.slice(0, 1_000));
    this.name = "VideoProviderError";
    this.code = input.code.slice(0, 100);
    this.providerCode = input.providerCode?.slice(0, 100) ?? null;
    this.phase = input.phase;
    this.retryable = input.retryable;
    this.certainty = input.certainty;
    this.diagnostic = input.diagnostic ?? null;
  }
}

export function videoProviderResultUnavailable(
  status: NormalizedVideoProviderStatus,
): VideoProviderError {
  if (status === "nsfw") {
    return new VideoProviderError({
      code: "provider_nsfw",
      providerCode: "nsfw",
      message: "Provider rejected the video because of its safety policy",
      phase: "poll",
      retryable: false,
      certainty: "not_attempted",
    });
  }
  if (status === "failed" || status === "cancelled") {
    const cancelled = status === "cancelled";
    return new VideoProviderError({
      code: cancelled ? "provider_cancelled" : "provider_failed",
      providerCode: status,
      message: cancelled
        ? "Provider cancelled the video generation"
        : "Provider failed the video generation",
      phase: "poll",
      retryable: true,
      certainty: "not_attempted",
    });
  }
  return new VideoProviderError({
    code: "provider_result_not_ready",
    message: "Provider video result is not ready",
    phase: "poll",
    retryable: true,
    certainty: "not_attempted",
  });
}

export function classifyHappyHorseSubmitFailure(error: {
  statusCode?: unknown;
  message?: unknown;
  retryable?: unknown;
  payload?: unknown;
}): VideoProviderError {
  const statusCode =
    typeof error.statusCode === "number" ? error.statusCode : null;
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
      ? "HappyHorse rejected the generation request"
      : "HappyHorse submission outcome is unknown",
    providerCode: statusCode === null ? null : String(statusCode),
    phase: "submit",
    retryable: definitelyRejected ? false : error.retryable !== false,
    certainty: definitelyRejected ? "not_attempted" : "unknown",
    diagnostic: error.payload,
  });
}

export function normalizeVideoProviderRequestLocator(
  value: unknown,
  phase: "submit" | "poll" = "submit",
): string {
  const raw = typeof value === "string" ? value : "";
  const locator = raw.trim();
  if (
    !locator ||
    raw.length > 500 ||
    /[\u0000-\u001f\u007f-\u009f]/.test(raw) ||
    /^[a-z][a-z\d+.-]*:/i.test(locator) ||
    /:\/\/|[?#]/.test(locator)
  ) {
    throw new VideoProviderError({
      code: "provider_protocol_error",
      message: "Provider returned an invalid request locator",
      phase,
      retryable: phase === "submit",
      certainty: phase === "submit" ? "unknown" : "not_attempted",
    });
  }
  return locator;
}

function normalizeHappyHorseStatus(
  value: unknown,
  phase: "submit" | "poll",
): NormalizedVideoProviderStatus {
  const status = typeof value === "string" ? value.trim().toUpperCase() : "";
  if (status === "PENDING") return "queued";
  if (status === "RUNNING") return "in_progress";
  if (status === "SUCCEEDED") return "completed";
  if (status === "FAILED") return "failed";
  if (status === "CANCELED" || status === "CANCELLED") return "cancelled";
  throw new VideoProviderError({
    code: "provider_protocol_error",
    message: "HappyHorse returned an unknown generation status",
    phase,
    retryable: phase === "submit",
    certainty: phase === "submit" ? "unknown" : "not_attempted",
    diagnostic: { status: value },
  });
}

export function normalizeHappyHorseSubmitResult(value: {
  taskId?: unknown;
  taskStatus?: unknown;
  [key: string]: unknown;
}): VideoProviderSubmission {
  const providerRequestId = normalizeVideoProviderRequestLocator(
    value.taskId,
    "submit",
  );
  const status = normalizeHappyHorseStatus(value.taskStatus, "submit");
  return {
    providerRequestId,
    providerRequestLocator: providerRequestId,
    status,
  };
}

export function normalizeHappyHorsePollResult(value: {
  taskId?: unknown;
  taskStatus?: unknown;
  [key: string]: unknown;
}): VideoProviderPoll {
  return {
    providerRequestId: normalizeVideoProviderRequestLocator(
      value.taskId,
      "poll",
    ),
    status: normalizeHappyHorseStatus(value.taskStatus, "poll"),
  };
}

export type PreparedHappyHorseSubmission = {
  provider: "happyhorse";
  spec: Extract<VideoGenerationSpec, { provider: "happyhorse" }>;
  prompt: CompiledVideoPrompt;
  sourceUrls: string[];
  post: () => Promise<VideoProviderSubmission>;
};

export async function submitHappyHorseVideoProvider(
  input: PreparedHappyHorseSubmission,
): Promise<VideoProviderSubmission> {
  return input.post();
}

export async function pollHappyHorseVideoProvider(
  input: { providerRequestLocator: string },
  persistDiagnostic: (value: unknown) => Promise<void>,
): Promise<VideoProviderPoll> {
  const client = await import("@/lib/happyhorse/happyhorse-client");
  try {
    const raw = await client.pollHappyHorseTask(
      normalizeVideoProviderRequestLocator(
        input.providerRequestLocator,
        "poll",
      ),
    );
    await persistDiagnostic(raw.raw);
    return normalizeHappyHorsePollResult(raw);
  } catch (error) {
    if (error instanceof VideoProviderError) throw error;
    if (error instanceof client.HappyHorseApiError) {
      throw new VideoProviderError({
        code: "provider_poll_failed",
        message: "HappyHorse status could not be read",
        providerCode: String(error.statusCode),
        phase: "poll",
        retryable: error.retryable,
        certainty: "not_attempted",
        diagnostic: error.payload,
      });
    }
    throw new VideoProviderError({
      code: "provider_poll_failed",
      message: "HappyHorse status could not be read",
      phase: "poll",
      retryable: true,
      certainty: "not_attempted",
    });
  }
}

export async function loadFinalHappyHorseVideoResult(input: {
  providerRequestLocator: string;
}): Promise<{
  url: string;
  providerUsage: Record<string, unknown> | null;
}> {
  const { pollHappyHorseTask } = await import(
    "@/lib/happyhorse/happyhorse-client"
  );
  const result = await pollHappyHorseTask(
    normalizeVideoProviderRequestLocator(input.providerRequestLocator, "poll"),
  );
  const normalized = normalizeHappyHorsePollResult(result);
  if (normalized.status !== "completed" || !result.videoUrl) {
    throw videoProviderResultUnavailable(normalized.status);
  }
  return { url: result.videoUrl, providerUsage: result.usage };
}
