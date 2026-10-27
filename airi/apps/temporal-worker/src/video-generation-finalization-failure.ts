export const VIDEO_GENERATION_FINALIZATION_FAILURE_TYPE =
  "VideoGenerationFinalizationFailure";

export type VideoGenerationFinalizationFailure = {
  contractVersion: 1;
  phase: "poll" | "download" | "probe" | "store";
  code: string;
  providerCode: string | null;
  message: string;
  retryable: boolean;
};

type FinalizationFailureInput = Omit<
  VideoGenerationFinalizationFailure,
  "contractVersion"
>;

const FINALIZATION_PHASES = new Set<
  VideoGenerationFinalizationFailure["phase"]
>(["poll", "download", "probe", "store"]);

function boundedCode(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const code = value.trim().slice(0, 100);
  return /^[a-z0-9_]+$/i.test(code) ? code : null;
}

function boundedMessage(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const message = value
    .replace(/(?:https?|gs):\/\/\S+/gi, "provider resource")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .trim()
    .slice(0, 1_000);
  return message || null;
}

function normalizeFailure(
  value: FinalizationFailureInput | VideoGenerationFinalizationFailure,
): VideoGenerationFinalizationFailure {
  return {
    contractVersion: 1,
    phase: value.phase,
    code: boundedCode(value.code) || "result_materialization_failed",
    providerCode: boundedCode(value.providerCode),
    message:
      boundedMessage(value.message) ||
      "Generated video could not be verified and stored",
    retryable: value.retryable === true,
  };
}

export class VideoGenerationFinalizationError extends Error {
  readonly failure: VideoGenerationFinalizationFailure;

  constructor(input: FinalizationFailureInput) {
    const failure = normalizeFailure(input);
    super(failure.message);
    this.name = VIDEO_GENERATION_FINALIZATION_FAILURE_TYPE;
    this.failure = failure;
  }
}

export function asVideoGenerationFinalizationError(
  error: unknown,
  fallback: FinalizationFailureInput,
): VideoGenerationFinalizationError {
  return error instanceof VideoGenerationFinalizationError
    ? error
    : new VideoGenerationFinalizationError(fallback);
}

function parseFailure(
  value: unknown,
): VideoGenerationFinalizationFailure | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (
    candidate.contractVersion !== 1 ||
    typeof candidate.phase !== "string" ||
    !FINALIZATION_PHASES.has(
      candidate.phase as VideoGenerationFinalizationFailure["phase"],
    ) ||
    !boundedCode(candidate.code) ||
    !boundedMessage(candidate.message) ||
    typeof candidate.retryable !== "boolean"
  ) {
    return null;
  }
  return normalizeFailure({
    contractVersion: 1,
    phase: candidate.phase as VideoGenerationFinalizationFailure["phase"],
    code: candidate.code as string,
    providerCode:
      candidate.providerCode === null
        ? null
        : boundedCode(candidate.providerCode),
    message: candidate.message as string,
    retryable: candidate.retryable,
  });
}

export function readVideoGenerationFinalizationFailure(
  error: unknown,
): VideoGenerationFinalizationFailure | null {
  let current = error;
  for (let depth = 0; depth < 6; depth += 1) {
    if (current instanceof VideoGenerationFinalizationError)
      return current.failure;
    if (!current || typeof current !== "object") return null;
    const candidate = current as Record<string, unknown>;
    if (
      candidate.type === VIDEO_GENERATION_FINALIZATION_FAILURE_TYPE &&
      Array.isArray(candidate.details)
    ) {
      return parseFailure(candidate.details[0]);
    }
    current = candidate.cause;
  }
  return null;
}

export function resolveVideoGenerationFinalizationTerminalStatus(
  failure: VideoGenerationFinalizationFailure | null,
): "failed" | "nsfw" {
  return failure?.code === "provider_nsfw" ? "nsfw" : "failed";
}
