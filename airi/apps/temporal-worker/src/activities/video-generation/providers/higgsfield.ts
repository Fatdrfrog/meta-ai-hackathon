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

type HiggsfieldSpec = Extract<VideoGenerationSpec, { provider: "higgsfield" }>;

export function classifyHiggsfieldSubmitFailure(error: {
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
      ? "Higgsfield rejected the generation request"
      : "Higgsfield submission outcome is unknown",
    providerCode: statusCode === null ? null : String(statusCode),
    phase: "submit",
    retryable: definitelyRejected ? false : error.retryable !== false,
    certainty: definitelyRejected ? "not_attempted" : "unknown",
    diagnostic: error.payload,
  });
}

export type PreparedHiggsfieldSubmission = {
  provider: "higgsfield";
  assetId: string;
  spec: HiggsfieldSpec;
  prompt: CompiledVideoPrompt;
  sourceUrls: [string];
  authKey: string;
  post: () => Promise<VideoProviderSubmission>;
};

function locator(value: unknown, phase: "submit" | "poll"): string {
  return normalizeVideoProviderRequestLocator(value, phase);
}

function status(value: unknown, phase: "submit" | "poll") {
  const normalized =
    typeof value === "string" ? value.trim().toLowerCase() : "";
  if (
    [
      "queued",
      "in_progress",
      "completed",
      "failed",
      "nsfw",
      "cancelled",
    ].includes(normalized)
  ) {
    return normalized as VideoProviderPoll["status"];
  }
  throw new VideoProviderError({
    code: "provider_protocol_error",
    message: "Higgsfield returned an unknown generation status",
    phase,
    retryable: phase === "submit",
    certainty: phase === "submit" ? "unknown" : "not_attempted",
    diagnostic: { status: value },
  });
}

export function normalizeHiggsfieldSubmitResult(value: {
  requestId?: unknown;
  status?: unknown;
  [key: string]: unknown;
}): VideoProviderSubmission {
  const providerRequestId = locator(value.requestId, "submit");
  const normalized = status(value.status, "submit");
  return {
    providerRequestId,
    providerRequestLocator: providerRequestId,
    status: normalized,
  };
}

export function normalizeHiggsfieldPollResult(
  value: Record<string, unknown>,
  fallbackRequestId: string,
): VideoProviderPoll {
  return {
    providerRequestId: locator(value.request_id || fallbackRequestId, "poll"),
    status: status(value.status, "poll"),
  };
}

export async function prepareHiggsfieldVideoSubmission(
  input: Omit<PreparedHiggsfieldSubmission, "authKey" | "post"> & {
    workspaceId: string;
    providerSourceId: string | null;
  },
): Promise<PreparedHiggsfieldSubmission> {
  const [
    { supabaseAdmin },
    { resolveHiggsfieldAuthKeyForWorkspace },
    client,
    { buildHiggsfieldWebhookUrl },
    { assertProviderPrompt },
  ] = await Promise.all([
    import("@/lib/supabase/admin"),
    import("@/lib/higgsfield/higgsfield-source"),
    import("@/lib/higgsfield/higgsfield-client"),
    import("@/lib/higgsfield/higgsfield-webhook"),
    import("@/lib/creative-assets/video-generation-prompt"),
  ]);
  if (!input.providerSourceId)
    throw new VideoProviderError({
      code: "own_ai_source_required",
      message: "Connect your own Higgsfield source to generate video",
      phase: "submit",
      retryable: false,
      certainty: "not_attempted",
    });
  let auth: Awaited<ReturnType<typeof resolveHiggsfieldAuthKeyForWorkspace>>;
  try {
    auth = await resolveHiggsfieldAuthKeyForWorkspace({
      supabase: supabaseAdmin,
      workspaceId: input.workspaceId,
      sourceId: input.providerSourceId,
    });
  } catch {
    throw new VideoProviderError({
      code: "provider_not_configured",
      message: "Higgsfield generation is not configured",
      phase: "submit",
      retryable: false,
      certainty: "not_attempted",
    });
  }
  assertProviderPrompt(input.prompt.providerPrompt, 1_200);
  if (input.sourceUrls.length !== 1) {
    throw new VideoProviderError({
      code: "source_count_invalid",
      message: "Higgsfield requires exactly one source image",
      phase: "submit",
      retryable: false,
      certainty: "not_attempted",
    });
  }
  const sourceUrl = new URL(input.sourceUrls[0]);
  if (sourceUrl.protocol !== "https:") {
    throw new VideoProviderError({
      code: "source_url_invalid",
      message: "Higgsfield source image must use HTTPS",
      phase: "submit",
      retryable: false,
      certainty: "not_attempted",
    });
  }
  const webhookUrl = buildHiggsfieldWebhookUrl(input.assetId);
  const prepared = {
    provider: "higgsfield" as const,
    assetId: input.assetId,
    spec: input.spec,
    prompt: input.prompt,
    sourceUrls: [sourceUrl.toString()] as [string],
    authKey: auth.authKey,
  };
  const providerPost = client.prepareHiggsfieldGenerationContractV1({
    mode: "image_to_video",
    modelId: prepared.spec.modelId,
    prompt: prepared.prompt.providerPrompt,
    imageUrl: prepared.sourceUrls[0],
    duration: prepared.spec.durationSeconds,
    webhookUrl,
    authKey: prepared.authKey,
  });
  return {
    ...prepared,
    post: async () => {
      try {
        const result = await providerPost();
        return normalizeHiggsfieldSubmitResult(result);
      } catch (error) {
        if (error instanceof VideoProviderError) throw error;
        if (error instanceof client.HiggsfieldProtocolError) {
          throw new VideoProviderError({
            code: "provider_protocol_error",
            message: "Higgsfield returned an invalid submission response",
            phase: "submit",
            retryable: true,
            certainty: "unknown",
            diagnostic: error.value,
          });
        }
        if (error instanceof client.HiggsfieldApiError) {
          throw classifyHiggsfieldSubmitFailure(error);
        }
        throw new VideoProviderError({
          code: "provider_submission_uncertain",
          message: "Higgsfield submission outcome is unknown",
          phase: "submit",
          retryable: true,
          certainty: "unknown",
        });
      }
    },
  };
}

export async function submitHiggsfieldVideoProvider(
  input: PreparedHiggsfieldSubmission,
): Promise<VideoProviderSubmission> {
  return input.post();
}

export async function pollHiggsfieldVideoProvider(
  input: {
    providerRequestId: string;
    providerRequestLocator: string;
    authKey: string;
  },
  persistDiagnostic: (value: unknown) => Promise<void>,
): Promise<VideoProviderPoll> {
  const client = await import("@/lib/higgsfield/higgsfield-client");
  try {
    const raw = await client.fetchHiggsfieldRequestStatusContractV1({
      requestId: locator(input.providerRequestLocator, "poll"),
      authKey: input.authKey,
    });
    await persistDiagnostic(raw);
    return normalizeHiggsfieldPollResult(raw, input.providerRequestId);
  } catch (error) {
    if (error instanceof VideoProviderError) throw error;
    if (error instanceof client.HiggsfieldProtocolError) {
      throw new VideoProviderError({
        code: "provider_protocol_error",
        message: "Higgsfield returned an invalid poll response",
        phase: "poll",
        retryable: false,
        certainty: "not_attempted",
        diagnostic: error.value,
      });
    }
    const details = error instanceof client.HiggsfieldApiError ? error : null;
    throw new VideoProviderError({
      code: "provider_poll_failed",
      message: "Higgsfield status could not be read",
      providerCode:
        typeof details?.statusCode === "number"
          ? String(details.statusCode)
          : null,
      phase: "poll",
      retryable: details?.retryable ?? true,
      certainty: "not_attempted",
      diagnostic: details?.payload ?? {
        message: error instanceof Error ? error.message : String(error),
      },
    });
  }
}

export async function loadFinalHiggsfieldVideoResult(input: {
  providerRequestId: string;
  authKey: string;
}): Promise<{ url: string }> {
  const { fetchHiggsfieldRequestStatusContractV1, extractHiggsfieldResultUrl } =
    await import("@/lib/higgsfield/higgsfield-client");
  const raw = await fetchHiggsfieldRequestStatusContractV1({
    requestId: input.providerRequestId,
    authKey: input.authKey,
  });
  const normalized = normalizeHiggsfieldPollResult(
    raw,
    input.providerRequestId,
  );
  const url = extractHiggsfieldResultUrl(raw, "video");
  if (normalized.status !== "completed" || !url)
    throw videoProviderResultUnavailable(normalized.status);
  return { url };
}
