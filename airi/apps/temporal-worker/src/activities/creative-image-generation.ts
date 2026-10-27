import { airiWorkerLogger } from "@icecore/airi-runtime/logging";
import { createCreativeAssetReadUrl } from "@icecore/airi-runtime/creative-asset-read-url";
import { readDefaultExport } from "@icecore/airi-runtime/module-interop";
import {
  isCreativeAssetObjectPathForWorkspace,
  resolveCreativeAssetGcsObjectRef,
} from "@icecore/airi-runtime/media-api";
import {
  findGenerativeAIReferenceImageIssue,
  GENERATIVE_AI_REFERENCE_IMAGE_LIMITS,
  isSameGenerativeAIReferenceImageList,
  type GenerativeAIReferenceImageMimeType,
} from "@icecore/airi-runtime/generative-ai-auto-reply";
import {
  asRecord,
  readTrimmedString as cleanString,
} from "@icecore/shared/lib/value-utils";
import {
  GENERATIVE_AI_IMAGE_ASPECT_RATIOS,
  isGenerativeAIImageModel,
  isGenerativeAIImageProvider,
  type CreativeImageGenerationProvider,
  type ScenarioActionAttachment,
} from "@icecore/temporal";
import {
  CREATIVE_IMAGE_GENERATION_ACTIVITY_MAX_ATTEMPTS,
  CREATIVE_IMAGE_GENERATION_WORKFLOW_CONTRACT_VERSION,
  type CreativeImageGenerationActivityInput,
  type CreativeImageGenerationActivityResult,
} from "@icecore/temporal";
import { activityInfo, ApplicationFailure } from "@temporalio/activity";
import { randomUUID } from "node:crypto";
import {
  getGcsCreativeAssetsBucketName,
  uploadGcsCreativeAssetBuffer,
} from "../gcs-creative-assets.js";
import { prepareGoogleSourceImage } from "./video-generation/providers/google.js";

type CreativeAssetModel = {
  findOne: (query: Record<string, unknown>) => {
    select: (fields: string) => { lean: <T>() => Promise<T> };
  };
  updateOne: (
    query: Record<string, unknown>,
    update: Record<string, unknown>,
  ) => Promise<{ matchedCount: number }>;
};
type Asset = Record<string, unknown>;
const UNKNOWN_MESSAGE =
  "The image generation outcome could not be confirmed. Automatic resubmission was stopped to avoid another charge.";
const UNAVAILABLE_MESSAGE =
  "Image generation could not start because a service was temporarily unavailable. Try again later.";
const STILL_GENERATING_MESSAGE =
  "The image is still being generated; this attempt resumes reading it.";
const PROVIDER_LABELS: Record<CreativeImageGenerationProvider, string> = {
  google: "Google AI",
  elevenlabs: "ElevenLabs",
};
/** ElevenLabs serves 1K images of about 1-3 MB; storage caps images anyway. */
const ELEVENLABS_RESULT_MAX_BYTES = 20 * 1024 * 1024;

type GeneratedImage = {
  buffer: Buffer;
  mimeType: string;
  fileName: string;
  raw: Record<string, unknown>;
};

function imageExtension(mimeType: string): string {
  if (mimeType === "image/jpeg") return "jpg";
  if (mimeType === "image/webp") return "webp";
  return "png";
}

/** The last attempt records its own failure: nothing retries it. */
function isFinalActivityAttempt(): boolean {
  try {
    return (
      activityInfo().attempt >= CREATIVE_IMAGE_GENERATION_ACTIVITY_MAX_ATTEMPTS
    );
  } catch {
    return true;
  }
}

/**
 * Whether an error before the paid request may pass on its own: outages
 * reading the source, signing or downloading a reference. Invalid settings
 * and a missing source stay terminal.
 */
function isTransientBeforeSubmission(
  error: unknown,
  sourceLookupUnavailable: boolean,
): boolean {
  if (sourceLookupUnavailable) return true;
  if (error instanceof ApplicationFailure) return !error.nonRetryable;
  if (!(error instanceof Error)) return true;
  if ("code" in error && error.code === "own_ai_source_required") return false;
  return "retryable" in error && typeof error.retryable === "boolean"
    ? error.retryable
    : true;
}

function invalid(
  message = "The image generation configuration is invalid",
): never {
  throw ApplicationFailure.nonRetryable(
    message,
    "CreativeImageGenerationInvalidInput",
  );
}
function result(
  assetId: string,
  asset: Asset,
): CreativeImageGenerationActivityResult {
  return {
    assetId,
    status: asset.status === "complete" ? "complete" : "failed",
    terminal: true,
    providerRequestId: cleanString(asset.providerRequestId) || null,
  };
}
/** The web code this activity uses, through its one host module. */
async function loadWebHost() {
  const host = await import(
    "@/lib/creative-assets/image-generation-worker-host"
  );
  return readDefaultExport<typeof host>(host);
}

async function loadCreativeAssetModel(): Promise<CreativeAssetModel> {
  const { connectDB, CreativeAsset } = await loadWebHost();
  await connectDB();
  return CreativeAsset as CreativeAssetModel;
}

/** Leading bytes of each reference MIME type the shared limits allow. */
const REFERENCE_IMAGE_SIGNATURES: Record<
  GenerativeAIReferenceImageMimeType,
  Buffer
> = {
  "image/png": Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  "image/jpeg": Buffer.from([255, 216, 255]),
};

function detectReferenceImageMimeType(
  buffer: Buffer,
): GenerativeAIReferenceImageMimeType | null {
  return (
    GENERATIVE_AI_REFERENCE_IMAGE_LIMITS.mimeTypes.find((mimeType) => {
      const signature = REFERENCE_IMAGE_SIGNATURES[mimeType];
      return buffer.subarray(0, signature.length).equals(signature);
    }) ?? null
  );
}

async function prepareReferenceImages(
  workspaceId: string,
  references: ScenarioActionAttachment[],
) {
  const declaredIssue = findGenerativeAIReferenceImageIssue(references);
  if (declaredIssue === "count") invalid("Too many reference images");
  if (declaredIssue) {
    invalid(
      "Reference images must be owned workspace PNG or JPEG uploads within the size limit",
    );
  }
  const images: Array<{ data: string; mimeType: string }> = [];
  const actualImages: Array<{ mimeType: string; fileSize: number }> = [];
  for (const reference of references) {
    const ref = resolveCreativeAssetGcsObjectRef(reference);
    if (
      !ref ||
      ref.bucket !== getGcsCreativeAssetsBucketName() ||
      !isCreativeAssetObjectPathForWorkspace({ workspaceId, path: ref.path }) ||
      !ref.path.startsWith(
        `workspaces/${workspaceId}/creative-assets/image/`,
      ) ||
      reference.mediaType !== "image"
    ) {
      invalid(
        "Reference images must be owned workspace PNG or JPEG uploads within the size limit",
      );
    }
    const read = await createCreativeAssetReadUrl({
      provider: "gcs",
      ...ref,
      workspaceId,
    });
    const image = await prepareGoogleSourceImage(read.url, fetch, {
      maxBytes: GENERATIVE_AI_REFERENCE_IMAGE_LIMITS.maxFileBytes,
    });
    const buffer = Buffer.from(image.data, "base64");
    const actualMimeType = detectReferenceImageMimeType(buffer);
    if (
      !actualMimeType ||
      actualMimeType !== image.mimeType ||
      actualMimeType !== reference.mimeType ||
      buffer.byteLength !== reference.fileSize
    ) {
      invalid(
        "Reference image content does not match the uploaded image metadata",
      );
    }
    images.push(image);
    actualImages.push({
      mimeType: actualMimeType,
      fileSize: buffer.byteLength,
    });
  }
  if (findGenerativeAIReferenceImageIssue(actualImages))
    invalid("Reference images exceed the size limits");
  return images;
}

/**
 * A durable dispatch fence allows at most one paid POST for a creative asset.
 * Google answers the POST with the image. ElevenLabs answers with a job id,
 * recorded before the job is read, so a later attempt reads that job again
 * instead of paying for another.
 */
export async function creativeImageGenerationActivity(
  input: CreativeImageGenerationActivityInput,
): Promise<CreativeImageGenerationActivityResult> {
  if (
    input.contractVersion !==
    CREATIVE_IMAGE_GENERATION_WORKFLOW_CONTRACT_VERSION
  )
    invalid("Unsupported creative image generation contract version");
  const workspaceId = cleanString(input.workspaceId);
  const assetId = cleanString(input.assetId);
  const provider = input.provider;
  if (
    !workspaceId ||
    !assetId ||
    !cleanString(input.prompt) ||
    !isGenerativeAIImageProvider(provider)
  )
    invalid();
  const CreativeAsset = await loadCreativeAssetModel();
  const scope = { _id: assetId, workspaceId };
  const load = () =>
    CreativeAsset.findOne(scope)
      .select(
        "_id workspaceId kind source provider status prompt modelId providerPayload providerRequestId providerSourceId",
      )
      .lean<Asset | null>();
  const asset = await load();
  if (
    !asset ||
    asset.kind !== "image" ||
    asset.source !== provider ||
    asset.provider !== provider
  )
    invalid("Creative image generation asset was not found");
  if (asset.status === "complete" || asset.status === "failed")
    return result(assetId, asset);
  const providerPayload = asRecord(asset.providerPayload);
  const submission = asRecord(providerPayload.imageSubmission);
  const resumeToken = cleanString(submission.token);
  // A recorded ElevenLabs job is read again; reading it costs nothing.
  const resumeGenerationId =
    provider === "elevenlabs" &&
    asset.status === "in_progress" &&
    submission.state === "submitted" &&
    resumeToken
      ? cleanString(asset.providerRequestId) || null
      : null;
  const markUnknown = async (filter: Record<string, unknown>) => {
    await CreativeAsset.updateOne(filter, {
      $set: {
        status: "failed",
        error: UNKNOWN_MESSAGE,
        "providerPayload.errorCode": "submission_outcome_unknown",
        "providerPayload.imageSubmission.state": "unknown",
        updatedAt: new Date(),
      },
    });
    throw ApplicationFailure.nonRetryable(
      UNKNOWN_MESSAGE,
      "CreativeImageGenerationOutcomeUnknown",
    );
  };
  if (
    !resumeGenerationId &&
    (submission.state ||
      providerPayload.submitStartedAt ||
      asset.status === "in_progress")
  ) {
    await markUnknown({ ...scope, status: asset.status });
  }

  const {
    googleCreativeAssets: google,
    elevenLabsImageGeneration: elevenLabs,
    creativeCredentials: credentials,
    assertCreativeAssetAllowed,
    resolveCreativeAssetMimeType,
  } = await loadWebHost();
  const providerLabel = PROVIDER_LABELS[provider];
  let apiKey: string;
  let images: Array<{ data: string; mimeType: string }> = [];
  let modelId: string;
  const aspectRatio = input.aspectRatio || "9:16";
  try {
    if (
      !input.providerSourceId ||
      input.providerSourceId !== asset.providerSourceId
    ) {
      throw ApplicationFailure.nonRetryable(
        `Connect your own ${providerLabel} source to generate images`,
        "own_ai_source_required",
      );
    }
    modelId =
      input.modelId ??
      (provider === "google"
        ? cleanString(asset.modelId) || google.getGoogleImageGenerationModel()
        : "");
    if (
      (input.modelId &&
        (input.modelId !== asset.modelId ||
          !isGenerativeAIImageModel(provider, modelId))) ||
      // Only legacy Airi Google assets run without a frozen model.
      (!input.modelId && provider !== "google") ||
      // Legacy Airi assets compact the prompt for storage but pass the original
      // brief to the workflow. Scenario assets store the exact frozen prompt.
      (providerPayload.scenario && input.prompt !== asset.prompt) ||
      !GENERATIVE_AI_IMAGE_ASPECT_RATIOS.some(
        (ratio) => ratio === aspectRatio,
      ) ||
      (providerPayload.aspectRatio &&
        aspectRatio !== providerPayload.aspectRatio) ||
      (providerPayload.referenceImages &&
        !isSameGenerativeAIReferenceImageList(
          input.referenceImages ?? [],
          providerPayload.referenceImages,
        ))
    )
      invalid();
    const keyInput = { workspaceId, providerSourceId: input.providerSourceId };
    apiKey =
      provider === "elevenlabs"
        ? await credentials.resolveElevenLabsCreativeWorkerApiKey(keyInput)
        : await credentials.resolveGoogleCreativeWorkerApiKey(keyInput);
    // A recorded job already holds its references.
    if (!resumeGenerationId) {
      images = await prepareReferenceImages(
        workspaceId,
        input.referenceImages ?? [],
      );
    }
  } catch (error) {
    const sourceLookupUnavailable =
      credentials.isCreativeAiSourceLookupUnavailable(error);
    // Nothing new has reached the provider, so a passing outage retries safely.
    const transient = isTransientBeforeSubmission(
      error,
      sourceLookupUnavailable,
    );
    if (transient && !isFinalActivityAttempt()) {
      throw ApplicationFailure.retryable(
        UNAVAILABLE_MESSAGE,
        "CreativeImageGenerationUnavailable",
      );
    }
    // A paid job that can no longer be read has an unknown outcome.
    if (resumeGenerationId) {
      await markUnknown({
        ...scope,
        status: "in_progress",
        "providerPayload.imageSubmission.token": resumeToken,
      });
    }
    const sourceRequired =
      !sourceLookupUnavailable &&
      error instanceof Error &&
      (("code" in error && error.code === "own_ai_source_required") ||
        (error instanceof ApplicationFailure &&
          error.type === "own_ai_source_required"));
    const message = sourceRequired
      ? `Connect your own ${providerLabel} source in Settings > Integrations to generate images.`
      : transient
        ? UNAVAILABLE_MESSAGE
        : "Image generation could not start. Check the model and reference image configuration.";
    const code = sourceRequired
      ? "own_ai_source_required"
      : transient
        ? "image_generation_unavailable"
        : "image_generation_invalid_input";
    await CreativeAsset.updateOne(
      {
        ...scope,
        status: "queued",
        "providerPayload.imageSubmission": { $exists: false },
      },
      {
        $set: {
          status: "failed",
          error: message,
          "providerPayload.errorCode": code,
          updatedAt: new Date(),
        },
      },
    );
    throw ApplicationFailure.nonRetryable(
      message,
      sourceRequired
        ? code
        : transient
          ? "CreativeImageGenerationUnavailable"
          : "CreativeImageGenerationInvalidInput",
    );
  }

  let token = resumeToken;
  if (!resumeGenerationId) {
    token = randomUUID();
    const claimed = await CreativeAsset.updateOne(
      {
        ...scope,
        status: "queued",
        providerSourceId: input.providerSourceId,
        "providerPayload.imageSubmission": { $exists: false },
        "providerPayload.submitStartedAt": { $exists: false },
      },
      {
        $set: {
          status: "in_progress",
          modelId,
          "providerPayload.workflowId": input.workflowId,
          "providerPayload.imageSubmission": {
            state: "dispatching",
            token,
            startedAt: new Date().toISOString(),
          },
          error: null,
          updatedAt: new Date(),
        },
      },
    );
    if (claimed.matchedCount !== 1) {
      const current = await load();
      if (
        current &&
        (current.status === "complete" || current.status === "failed")
      )
        return result(assetId, current);
      throw ApplicationFailure.nonRetryable(
        UNKNOWN_MESSAGE,
        "CreativeImageGenerationOutcomeUnknown",
      );
    }
  }
  const claimedScope = {
    ...scope,
    status: "in_progress",
    "providerPayload.imageSubmission.token": token,
  };
  // Set once ElevenLabs' job id is stored: from then on, read it, never resubmit.
  let generationId = resumeGenerationId;
  try {
    let generated: GeneratedImage;
    if (provider === "elevenlabs") {
      if (!generationId) {
        const submitted = await elevenLabs.submitElevenLabsImageGeneration({
          apiKey,
          modelId,
          prompt: input.prompt,
          aspectRatio,
          images,
        });
        const recorded = await CreativeAsset.updateOne(claimedScope, {
          $set: {
            providerRequestId: submitted.generationId,
            "providerPayload.imageSubmission.state": "submitted",
            "providerPayload.imageSubmission.submittedAt":
              new Date().toISOString(),
            updatedAt: new Date(),
          },
        });
        if (recorded.matchedCount !== 1) {
          throw new Error("Image submission fence changed");
        }
        generationId = submitted.generationId;
      }
      const ready = await elevenLabs.waitForElevenLabsImageGeneration({
        apiKey,
        generationId,
      });
      const image = await prepareGoogleSourceImage(
        elevenLabs.assertElevenLabsImageUrl(ready.contentUrl).toString(),
        fetch,
        { maxBytes: ELEVENLABS_RESULT_MAX_BYTES },
      );
      generated = {
        buffer: Buffer.from(image.data, "base64"),
        mimeType: image.mimeType,
        fileName: `elevenlabs-generated-image.${imageExtension(image.mimeType)}`,
        raw: { generationId },
      };
    } else {
      const image = await google.submitGoogleImageGeneration({
        apiKey,
        prompt: input.prompt,
        modelId: input.modelId ? modelId : undefined,
        aspectRatio,
        images,
      });
      generated = { ...image, raw: asRecord(image.raw) };
    }
    const mimeType = resolveCreativeAssetMimeType({
      fileName: generated.fileName,
      mimeType: generated.mimeType,
    });
    assertCreativeAssetAllowed("image", mimeType, generated.buffer.byteLength);
    const stored = await uploadGcsCreativeAssetBuffer({
      workspaceId,
      assetId,
      kind: "image",
      buffer: generated.buffer,
      mimeType,
      fileName: generated.fileName,
    });
    const completed = await CreativeAsset.updateOne(claimedScope, {
      $set: {
        status: "complete",
        ...stored,
        "providerPayload.imageSubmission.state": "complete",
        "providerPayload.completedAt": new Date().toISOString(),
        [`providerPayload.${provider}`]: generated.raw,
        error: null,
        completedAt: new Date(),
        updatedAt: new Date(),
      },
    });
    if (completed.matchedCount !== 1) {
      const current = await load();
      if (current?.status === "complete") return result(assetId, current);
      throw new Error("Image completion fence changed");
    }
  } catch (error) {
    const failureReason =
      error instanceof elevenLabs.ElevenLabsImageGenerationFailedError
        ? error.failureReason
        : null;
    // A recorded job still running, or whose image could not be fetched or
    // stored yet, is read again by the next attempt instead of failing.
    if (
      generationId &&
      !failureReason &&
      !(error instanceof elevenLabs.ElevenLabsImageApiError) &&
      !(
        error instanceof Error &&
        "retryable" in error &&
        error.retryable === false
      ) &&
      !isFinalActivityAttempt()
    ) {
      airiWorkerLogger.info("airi.worker.creative_image_generation", {
        note: "still_generating",
        workspaceId,
        assetId,
        provider,
        errorName: error instanceof Error ? error.name : typeof error,
      });
      throw ApplicationFailure.retryable(
        STILL_GENERATING_MESSAGE,
        "CreativeImageGenerationPending",
      );
    }
    // Otherwise a failure after the fence is final for this asset: retrying
    // the POST could charge the customer twice. The provider's own answer is
    // recorded; other messages may carry secrets.
    const providerError =
      error instanceof google.GoogleCreativeApiError
        ? google.describeGoogleCreativeApiError(error, apiKey)
        : error instanceof elevenLabs.ElevenLabsImageApiError
          ? elevenLabs.describeElevenLabsImageApiError(error, apiKey)
          : null;
    // Refused before anything ran (no credits, bad key, unknown model):
    // certain, and named as such.
    const rejection =
      error instanceof google.GoogleCreativeApiError
        ? google.readGoogleImageRejectionMessage(error)
        : error instanceof elevenLabs.ElevenLabsImageApiError && !generationId
          ? elevenLabs.readElevenLabsImageRejectionMessage(error)
          : null;
    // A job ElevenLabs reports as failed is certain too, and not charged.
    const outcome = rejection
      ? {
          code: "provider_rejected",
          state: "rejected",
          message: rejection,
          type: "CreativeImageGenerationProviderRejected",
        }
      : failureReason
        ? {
            code: "provider_failed",
            state: "failed",
            message:
              elevenLabs.readElevenLabsImageFailureMessage(failureReason),
            type: "CreativeImageGenerationProviderFailed",
          }
        : {
            code: "submission_outcome_unknown",
            state: "unknown",
            message: UNKNOWN_MESSAGE,
            type: "CreativeImageGenerationOutcomeUnknown",
          };
    airiWorkerLogger.warn("airi.worker.creative_image_generation", {
      note: "failed_after_submission_fence",
      workspaceId,
      assetId,
      provider,
      providerRejected: Boolean(rejection),
      providerFailureReason: failureReason,
      errorName: error instanceof Error ? error.name : typeof error,
      providerHttpStatus: providerError?.httpStatus ?? null,
      providerStatus: providerError?.status ?? null,
      providerReason:
        providerError && "reason" in providerError
          ? providerError.reason
          : null,
      providerMessage: providerError?.message ?? null,
    });
    await CreativeAsset.updateOne(claimedScope, {
      $set: {
        status: "failed",
        error: outcome.message,
        "providerPayload.errorCode": outcome.code,
        "providerPayload.imageSubmission.state": outcome.state,
        ...(failureReason
          ? { "providerPayload.providerFailureReason": failureReason }
          : {}),
        ...(providerError
          ? { "providerPayload.providerError": providerError }
          : {}),
        updatedAt: new Date(),
      },
    });
    throw ApplicationFailure.nonRetryable(outcome.message, outcome.type);
  }
  airiWorkerLogger.info("airi.worker.creative_image_generation", {
    note: "completed",
    workspaceId,
    assetId,
    provider,
  });
  return {
    assetId,
    status: "complete",
    terminal: true,
    providerRequestId: generationId,
  };
}
