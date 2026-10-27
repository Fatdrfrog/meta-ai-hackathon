import {
  ElevenLabsSttError,
  submitElevenLabsAudioTranscriptionFromUrl,
  submitElevenLabsVideoTranscriptionFromUrl,
} from "@icecore/airi-runtime/elevenlabs-stt";
import { airiWorkerLogger } from "@icecore/airi-runtime/logging";
import {
  asRecord,
  cleanString,
  requireNonEmptyString as validateRequiredString,
} from "@icecore/shared/lib/value-utils";
import {
  assertContractVersion,
  ELEVENLABS_CREATIVE_TRANSCRIPTION_WORKFLOW_CONTRACT_VERSION,
  type ElevenLabsCreativeTranscriptionActivityResult,
  type ElevenLabsCreativeTranscriptionCompleteActivityInput,
  type ElevenLabsCreativeTranscriptionFailActivityInput,
  type ElevenLabsCreativeTranscriptionSubmitActivityInput,
  type ElevenLabsCreativeTranscriptionSubmitActivityResult,
} from "@icecore/temporal";
import { ApplicationFailure } from "@temporalio/activity";

type LeanQuery<T> = {
  lean: <R = T>() => Promise<R>;
};

type CreativeAssetModel = {
  updateOne: (
    query: Record<string, unknown>,
    update: Record<string, unknown>,
  ) => Promise<{ matchedCount: number }>;
  findOne: (
    query: Record<string, unknown>,
  ) => LeanQuery<Record<string, unknown> | null>;
};

function validateContractVersion(value: number, label: string): void {
  assertContractVersion(
    value,
    { max: ELEVENLABS_CREATIVE_TRANSCRIPTION_WORKFLOW_CONTRACT_VERSION },
    label,
  );
}

function nonRetryableFailure(error: unknown, type: string): ApplicationFailure {
  const message =
    error instanceof Error ? error.message : "ElevenLabs transcription failed";
  return ApplicationFailure.nonRetryable(message, type);
}

function isTerminalSttError(error: unknown): boolean {
  return error instanceof ElevenLabsSttError && !error.info.transient;
}

async function loadCreativeAssetModel(): Promise<CreativeAssetModel> {
  const [{ default: connectDB }, { CreativeAsset }] = await Promise.all([
    import("@/lib/mongoose"),
    import("@/models/creative-asset"),
  ]);
  await connectDB();
  return CreativeAsset as CreativeAssetModel;
}

async function resolveElevenLabsApiKey(params: {
  workspaceId: string;
  providerSourceId: string;
}): Promise<{ apiKey: string; sourceId: string }> {
  const { supabaseAdmin } = await import("@/lib/supabase/admin");
  const { resolveElevenLabsCredentialsForWorkspace } = await import(
    "@/lib/elevenlabs/elevenlabs-source"
  );
  const credentials = await resolveElevenLabsCredentialsForWorkspace({
    supabase: supabaseAdmin,
    workspaceId: params.workspaceId,
    sourceId: params.providerSourceId,
  });
  if (
    credentials.credentialSource !== "workspace_source" ||
    credentials.sourceId !== params.providerSourceId
  ) {
    throw ApplicationFailure.nonRetryable(
      "The saved ElevenLabs source is unavailable.",
      "own_ai_source_required",
    );
  }
  return { apiKey: credentials.apiKey, sourceId: credentials.sourceId };
}

async function resolveSourceMediaUrl(params: {
  asset: Record<string, unknown>;
}): Promise<string> {
  const { resolveCreativeAssetDisplayUrl } = await import(
    "@/lib/higgsfield/creative-asset-serialization"
  );
  const mediaUrl = await resolveCreativeAssetDisplayUrl(params.asset);
  if (!mediaUrl) {
    throw ApplicationFailure.nonRetryable(
      "Source audio or video asset is not available",
      "ElevenLabsCreativeTranscriptionSourceUnavailable",
    );
  }
  return mediaUrl;
}

function assertOutputAsset(
  asset: Record<string, unknown> | null,
): asserts asset is Record<string, unknown> {
  if (!asset) {
    throw ApplicationFailure.nonRetryable(
      "Creative transcription asset was not found",
      "ElevenLabsCreativeTranscriptionAssetMissing",
    );
  }
  if (
    asset.source !== "elevenlabs" ||
    asset.provider !== "elevenlabs" ||
    asset.kind !== "text"
  ) {
    throw ApplicationFailure.nonRetryable(
      "Creative transcription output asset is not an ElevenLabs text asset",
      "ElevenLabsCreativeTranscriptionAssetInvalid",
    );
  }
}

function assertSourceAsset(
  asset: Record<string, unknown> | null,
  mediaType: "audio" | "video",
): asserts asset is Record<string, unknown> {
  if (!asset || asset.kind !== mediaType || asset.status !== "complete") {
    throw ApplicationFailure.nonRetryable(
      "Source audio or video asset is not complete",
      "ElevenLabsCreativeTranscriptionSourceInvalid",
    );
  }
}

export async function elevenLabsCreativeTranscriptionSubmitActivity(
  input: ElevenLabsCreativeTranscriptionSubmitActivityInput,
): Promise<ElevenLabsCreativeTranscriptionSubmitActivityResult> {
  validateContractVersion(input.contractVersion, "ElevenLabs STT submit");
  const workspaceId = validateRequiredString(input.workspaceId, "workspaceId");
  const assetId = validateRequiredString(input.assetId, "assetId");
  const sourceAssetId = validateRequiredString(
    input.sourceAssetId,
    "sourceAssetId",
  );
  const modelId =
    cleanString(process.env.ELEVENLABS_STT_MODEL, 120) || "scribe_v2";
  const CreativeAsset = await loadCreativeAssetModel();

  const outputAsset = await CreativeAsset.findOne({
    _id: assetId,
    workspaceId,
  }).lean<Record<string, unknown> | null>();
  assertOutputAsset(outputAsset);

  const existingRequestId = cleanString(outputAsset.providerRequestId, 240);
  if (outputAsset.status === "complete") {
    return {
      assetId,
      requestId: existingRequestId || "already-complete",
      modelId: cleanString(outputAsset.modelId, 120) || modelId,
      alreadyComplete: true,
    };
  }
  if (existingRequestId) {
    return {
      assetId,
      requestId: existingRequestId,
      modelId: cleanString(outputAsset.modelId, 120) || modelId,
    };
  }

  const providerSourceId = cleanString(outputAsset.providerSourceId, 200);
  if (
    !providerSourceId ||
    (input.providerSourceId && input.providerSourceId !== providerSourceId)
  ) {
    throw ApplicationFailure.nonRetryable(
      "Connect an ElevenLabs source before creating a transcription.",
      "own_ai_source_required",
    );
  }

  const sourceAsset = await CreativeAsset.findOne({
    _id: sourceAssetId,
    workspaceId,
    kind: input.mediaType,
    status: "complete",
  }).lean<Record<string, unknown> | null>();
  assertSourceAsset(sourceAsset, input.mediaType);

  const mediaUrl = await resolveSourceMediaUrl({ asset: sourceAsset });
  const credentials = await resolveElevenLabsApiKey({
    workspaceId,
    providerSourceId,
  });
  const providerPayload = {
    ...asRecord(outputAsset.providerPayload),
    mode: input.mode,
    workflowId: input.workflowId,
    sourceAssetId,
    mediaType: input.mediaType,
    submitStartedAt: new Date().toISOString(),
  };

  const claim = await CreativeAsset.updateOne(
    {
      _id: assetId,
      workspaceId,
      status: { $in: ["queued", "in_progress"] },
      providerSourceId,
      providerRequestId: { $in: [null, ""] },
      "providerPayload.submitStartedAt": { $exists: false },
    },
    {
      $set: {
        status: "queued",
        providerPayload,
        error: null,
        updatedAt: new Date(),
      },
    },
  );
  if (claim.matchedCount !== 1) {
    throw ApplicationFailure.nonRetryable(
      "This transcription may already have been submitted. Wait for its result before creating another request.",
      "ElevenLabsCreativeTranscriptionOutcomeUnknown",
    );
  }

  let submission: Awaited<
    ReturnType<typeof submitElevenLabsAudioTranscriptionFromUrl>
  >;
  try {
    const submit =
      input.mediaType === "video"
        ? submitElevenLabsVideoTranscriptionFromUrl
        : submitElevenLabsAudioTranscriptionFromUrl;
    submission = await submit(
      mediaUrl,
      cleanString(sourceAsset.mimeType, 200) || undefined,
      {
        workflowKind: "creative_asset_transcription",
        workflowId: input.workflowId,
        workspaceId,
        assetId,
        sourceAssetId,
        mode: input.mode,
        mediaType: input.mediaType,
      },
      {
        apiKey: credentials.apiKey,
        timestampsGranularity: "word",
      },
    );
  } catch (error) {
    if (isTerminalSttError(error)) {
      throw nonRetryableFailure(
        error,
        "ElevenLabsCreativeTranscriptionRejected",
      );
    }
    throw ApplicationFailure.nonRetryable(
      "The transcription result is unknown. The saved submission will not be charged again by a retry.",
      "ElevenLabsCreativeTranscriptionOutcomeUnknown",
    );
  }

  try {
    await CreativeAsset.updateOne(
      {
        _id: assetId,
        workspaceId,
        status: { $in: ["queued", "in_progress"] },
        providerSourceId,
        "providerPayload.submitStartedAt": providerPayload.submitStartedAt,
      },
      {
        $set: {
          modelId: submission.model,
          providerRequestId: submission.requestId,
          providerSourceId: credentials.sourceId,
          providerPayload: {
            ...providerPayload,
            requestId: submission.requestId,
            start: {
              requestId: submission.requestId,
              model: submission.model,
              mimeType: submission.mimeType,
              inputMode: submission.inputMode,
              deliveryMode: submission.deliveryMode,
              inputBytes: submission.inputBytes,
              latencyMs: submission.latencyMs,
            },
          },
          error: null,
          updatedAt: new Date(),
        },
      },
    );
  } catch (error) {
    airiWorkerLogger.error(
      "airi.worker.elevenlabs_creative_transcription",
      error,
      {
        note: "asset_update_after_submit_failed",
        workspaceId,
        assetId,
        requestId: submission.requestId,
      },
    );
  }

  if (submission.deliveryMode === "inline") {
    const { completeElevenLabsCreativeTranscriptionAsset } = await import(
      "@/lib/elevenlabs/creative-transcription-webhook"
    );
    await completeElevenLabsCreativeTranscriptionAsset({
      workspaceId,
      assetId,
      requestId: submission.requestId,
      mode: input.mode,
      status: "completed",
      webhookType: "speech_to_text_inline",
      data:
        submission.responsePayload ||
        ({
          text: submission.transcriptText,
          language_code: submission.languageCode,
        } satisfies Record<string, unknown>),
    });

    airiWorkerLogger.info("airi.worker.elevenlabs_creative_transcription", {
      note: "completed_inline",
      workspaceId,
      assetId,
      sourceAssetId,
      requestId: submission.requestId,
      mediaType: input.mediaType,
      latencyMs: submission.latencyMs,
    });

    return {
      assetId,
      requestId: submission.requestId,
      modelId: submission.model,
      alreadyComplete: true,
    };
  }

  airiWorkerLogger.info("airi.worker.elevenlabs_creative_transcription", {
    note: "submitted",
    workspaceId,
    assetId,
    sourceAssetId,
    requestId: submission.requestId,
    mediaType: input.mediaType,
  });

  return {
    assetId,
    requestId: submission.requestId,
    modelId: submission.model,
  };
}

export async function elevenLabsCreativeTranscriptionCompleteActivity(
  input: ElevenLabsCreativeTranscriptionCompleteActivityInput,
): Promise<ElevenLabsCreativeTranscriptionActivityResult> {
  validateContractVersion(input.contractVersion, "ElevenLabs STT complete");
  const { completeElevenLabsCreativeTranscriptionAsset } = await import(
    "@/lib/elevenlabs/creative-transcription-webhook"
  );

  await completeElevenLabsCreativeTranscriptionAsset({
    workspaceId: input.workspaceId,
    assetId: input.assetId,
    requestId: input.transcription.requestId,
    mode: input.mode,
    status: input.transcription.status,
    webhookType: input.transcription.webhookType,
    data: input.transcription.data,
    error: input.transcription.error || null,
  });

  return {
    assetId: input.assetId,
    status: input.transcription.status === "failed" ? "failed" : "complete",
    providerRequestId: input.transcription.requestId,
    terminal: true,
  };
}

export async function elevenLabsCreativeTranscriptionFailActivity(
  input: ElevenLabsCreativeTranscriptionFailActivityInput,
): Promise<ElevenLabsCreativeTranscriptionActivityResult> {
  validateContractVersion(input.contractVersion, "ElevenLabs STT fail");
  const CreativeAsset = await loadCreativeAssetModel();
  const assetId = validateRequiredString(input.assetId, "assetId");
  const error = validateRequiredString(input.error, "error");
  const requestId = cleanString(input.requestId, 240) || null;

  const failed = await CreativeAsset.updateOne(
    {
      _id: assetId,
      workspaceId: input.workspaceId,
      status: { $ne: "complete" },
    },
    {
      $set: {
        status: "failed",
        ...(requestId ? { providerRequestId: requestId } : {}),
        error,
        updatedAt: new Date(),
      },
    },
  );
  if (failed.matchedCount === 0) {
    const existing = await CreativeAsset.findOne({
      _id: assetId,
      workspaceId: input.workspaceId,
    }).lean();
    if (existing?.status === "complete") {
      return {
        assetId,
        status: "complete",
        providerRequestId: cleanString(existing.providerRequestId, 240) || null,
        terminal: true,
      };
    }
  }

  airiWorkerLogger.warn("airi.worker.elevenlabs_creative_transcription", {
    note: "failed",
    workspaceId: input.workspaceId,
    assetId,
    requestId,
    error,
  });

  return {
    assetId,
    status: "failed",
    providerRequestId: requestId,
    terminal: true,
  };
}
