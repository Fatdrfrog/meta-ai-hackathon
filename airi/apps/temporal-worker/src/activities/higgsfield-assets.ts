import {
  assertContractVersion,
  HIGGSFIELD_ASSET_GENERATION_WORKFLOW_CONTRACT_VERSION,
  type HiggsfieldAssetGenerationWorkflowInput,
  type HiggsfieldAssetGenerationWebhookSignalInput,
  type HiggsfieldPollStatusActivityInput,
  type HiggsfieldProcessWebhookActivityInput,
  type HiggsfieldProcessWebhookActivityResult,
  type HiggsfieldProviderLifecycleStatus,
  type HiggsfieldSubmitGenerationActivityResult,
} from "@icecore/temporal";
import { airiWorkerLogger } from "@icecore/airi-runtime/logging";
import { ApplicationFailure } from "@temporalio/activity";
import { uploadGcsCreativeAssetBuffer } from "../gcs-creative-assets.js";
import {
  readTrimmedString as cleanString,
  requireNonEmptyString as validateRequiredString,
} from "@icecore/shared/lib/value-utils";

function validateContractVersion(value: number, label: string): void {
  assertContractVersion(
    value,
    { max: HIGGSFIELD_ASSET_GENERATION_WORKFLOW_CONTRACT_VERSION },
    label,
  );
}

function toAssetStatus(
  status: HiggsfieldProviderLifecycleStatus,
): HiggsfieldProcessWebhookActivityResult["status"] {
  if (status === "completed") return "complete";
  if (status === "nsfw") return "nsfw";
  if (status === "failed" || status === "cancelled") return "failed";
  if (status === "in_progress") return "in_progress";
  return "queued";
}

function statusError(
  status: HiggsfieldProviderLifecycleStatus,
  payload: Record<string, unknown>,
): string {
  if (status === "nsfw") return "Higgsfield marked this generation as NSFW";
  return cleanString(payload.error) || `Higgsfield generation ${status}`;
}

export async function higgsfieldSubmitGenerationActivity(
  input: HiggsfieldAssetGenerationWorkflowInput,
): Promise<HiggsfieldSubmitGenerationActivityResult> {
  validateContractVersion(
    input.contractVersion,
    "Higgsfield submit generation activity",
  );
  const workspaceId = validateRequiredString(input.workspaceId, "workspaceId");
  const assetId = validateRequiredString(input.assetId, "assetId");
  const prompt = validateRequiredString(input.prompt, "prompt");

  const [
    { default: connectDB },
    { CreativeAsset },
    { supabaseAdmin },
    { resolveHiggsfieldAuthKeyForWorkspace },
    { buildHiggsfieldWebhookUrl },
    { isPermanentHiggsfieldApiError, submitHiggsfieldGeneration },
  ] = await Promise.all([
    import("@/lib/mongoose"),
    import("@/models/creative-asset"),
    import("@/lib/supabase/admin"),
    import("@/lib/higgsfield/higgsfield-source"),
    import("@/lib/higgsfield/higgsfield-webhook"),
    import("@/lib/higgsfield/higgsfield-client"),
  ]);

  if (!input.providerSourceId)
    throw ApplicationFailure.nonRetryable(
      "Connect your own Higgsfield credentials to generate images or video",
      "own_ai_source_required",
    );
  await connectDB();
  const ownedAsset = await CreativeAsset.findOne({
    _id: assetId,
    workspaceId,
    provider: "higgsfield",
    providerSourceId: input.providerSourceId,
  }).lean();
  if (!ownedAsset)
    throw ApplicationFailure.nonRetryable(
      "Creative generation source does not match the stored asset",
      "CreativeGenerationAssetInvalid",
    );
  const auth = await resolveHiggsfieldAuthKeyForWorkspace({
    supabase: supabaseAdmin,
    workspaceId,
    sourceId: input.providerSourceId || null,
  });
  const webhookUrl = buildHiggsfieldWebhookUrl(assetId);
  let start: Awaited<ReturnType<typeof submitHiggsfieldGeneration>>;
  try {
    start = await submitHiggsfieldGeneration({
      mode: input.mode,
      prompt,
      aspectRatio: input.aspectRatio || undefined,
      resolution: input.resolution || undefined,
      imageUrl: input.imageUrl || undefined,
      duration: input.duration || undefined,
      webhookUrl,
      authKey: auth.authKey,
    });
  } catch (error) {
    if (isPermanentHiggsfieldApiError(error)) {
      throw ApplicationFailure.nonRetryable(
        error.message,
        "HiggsfieldGenerationRejected",
      );
    }
    throw error;
  }
  const assetStatus = toAssetStatus(start.status);

  await connectDB();
  await CreativeAsset.findByIdAndUpdate(assetId, {
    status: assetStatus,
    providerRequestId: start.requestId,
    providerStatusUrl: start.statusUrl,
    providerCancelUrl: start.cancelUrl,
    providerSourceId: auth.sourceId,
    error: null,
    updatedAt: new Date(),
  });

  airiWorkerLogger.info("airi.worker.higgsfield_asset", {
    note: "generation_submitted",
    workspaceId,
    assetId,
    requestId: start.requestId,
    status: start.status,
  });

  return {
    assetId,
    providerRequestId: start.requestId,
    providerStatusUrl: start.statusUrl,
    providerCancelUrl: start.cancelUrl,
    status: start.status,
  };
}

export async function higgsfieldPollStatusActivity(
  input: HiggsfieldPollStatusActivityInput,
): Promise<HiggsfieldAssetGenerationWebhookSignalInput> {
  validateContractVersion(
    input.contractVersion,
    "Higgsfield poll status activity",
  );
  const assetId = validateRequiredString(input.assetId, "assetId");
  const providerRequestId = validateRequiredString(
    input.providerRequestId,
    "providerRequestId",
  );

  const { fetchHiggsfieldRequestStatus, normalizeHiggsfieldProviderStatus } =
    await import("@/lib/higgsfield/higgsfield-client");
  const [
    { default: connectDB },
    { CreativeAsset },
    { supabaseAdmin },
    { resolveHiggsfieldAuthKeyForWorkspace },
  ] = await Promise.all([
    import("@/lib/mongoose"),
    import("@/models/creative-asset"),
    import("@/lib/supabase/admin"),
    import("@/lib/higgsfield/higgsfield-source"),
  ]);
  await connectDB();
  const asset = await CreativeAsset.findById(assetId).lean<{
    workspaceId?: string | null;
    providerSourceId?: string | null;
  } | null>();
  if (!asset?.workspaceId) {
    throw new Error(
      `Creative asset not found for Higgsfield status poll: ${assetId}`,
    );
  }
  const auth = await resolveHiggsfieldAuthKeyForWorkspace({
    supabase: supabaseAdmin,
    workspaceId: String(asset.workspaceId),
    sourceId: asset?.providerSourceId || null,
  });
  const payload = await fetchHiggsfieldRequestStatus({
    statusUrl: input.providerStatusUrl || null,
    requestId: providerRequestId,
    authKey: auth.authKey,
  });
  const requestId = cleanString(payload.request_id) || providerRequestId;
  const status = normalizeHiggsfieldProviderStatus(payload.status);

  airiWorkerLogger.info("airi.worker.higgsfield_asset", {
    note: "generation_status_polled",
    assetId,
    requestId,
    status,
  });

  return {
    requestId,
    status,
    payload,
    receivedAt: new Date().toISOString(),
  };
}

export async function higgsfieldProcessWebhookActivity(
  input: HiggsfieldProcessWebhookActivityInput,
): Promise<HiggsfieldProcessWebhookActivityResult> {
  validateContractVersion(
    input.contractVersion,
    "Higgsfield process webhook activity",
  );
  const assetId = validateRequiredString(input.assetId, "assetId");
  const webhook = input.webhook;
  const providerStatus = webhook.status;
  const requestId = cleanString(webhook.requestId);
  const payload = webhook.payload || {};

  const [
    { default: connectDB },
    { CreativeAsset },
    { supabaseAdmin },
    { downloadAndStoreCreativeAsset },
    { extractHiggsfieldResultUrl },
  ] = await Promise.all([
    import("@/lib/mongoose"),
    import("@/models/creative-asset"),
    import("@/lib/supabase/admin"),
    import("@/lib/higgsfield/creative-asset-storage"),
    import("@/lib/higgsfield/higgsfield-client"),
  ]);

  await connectDB();
  const asset = await CreativeAsset.findOne({ _id: assetId }).lean<{
    _id: unknown;
    workspaceId?: string;
    kind?: "image" | "video";
    status?: string;
    providerRequestId?: string | null;
  } | null>();

  if (!asset) {
    throw new Error(`Creative asset not found: ${assetId}`);
  }

  if (
    requestId &&
    asset.providerRequestId &&
    requestId !== asset.providerRequestId
  ) {
    throw new Error("Higgsfield request id mismatch");
  }

  if (asset.status === "complete") {
    return {
      assetId,
      status: "complete",
      terminal: true,
      duplicate: true,
    };
  }

  if (
    providerStatus === "failed" ||
    providerStatus === "nsfw" ||
    providerStatus === "cancelled"
  ) {
    const status = toAssetStatus(providerStatus);
    await CreativeAsset.findByIdAndUpdate(assetId, {
      status,
      providerPayload: payload,
      error: statusError(providerStatus, payload),
      updatedAt: new Date(),
    });
    return { assetId, status, terminal: true };
  }

  if (providerStatus !== "completed") {
    const status = toAssetStatus(providerStatus);
    await CreativeAsset.findByIdAndUpdate(assetId, {
      status,
      providerPayload: payload,
      updatedAt: new Date(),
    });
    return { assetId, status, terminal: false };
  }

  const kind = asset.kind === "video" ? "video" : "image";
  const mediaUrl = extractHiggsfieldResultUrl(payload, kind);
  if (!mediaUrl) {
    await CreativeAsset.findByIdAndUpdate(assetId, {
      status: "failed",
      providerPayload: payload,
      error: "Completed Higgsfield webhook did not include media URL",
      updatedAt: new Date(),
    });
    return { assetId, status: "failed", terminal: true };
  }

  const stored = await downloadAndStoreCreativeAsset({
    storageClient: supabaseAdmin,
    workspaceId: String(asset.workspaceId || ""),
    assetId,
    kind,
    mediaUrl,
    storeBuffer: async (storeInput) => uploadGcsCreativeAssetBuffer(storeInput),
  });

  await CreativeAsset.findByIdAndUpdate(assetId, {
    status: "complete",
    url: stored.url,
    storageProvider: stored.storageProvider,
    bucket: stored.bucket,
    path: stored.path,
    mimeType: stored.mimeType,
    fileName: stored.fileName,
    fileSize: stored.fileSize,
    providerPayload: payload,
    error: null,
    completedAt: new Date(),
    updatedAt: new Date(),
  });

  airiWorkerLogger.info("airi.worker.higgsfield_asset", {
    note: "generation_completed",
    workspaceId: String(asset.workspaceId || ""),
    assetId,
    requestId,
    kind,
  });

  return { assetId, status: "complete", terminal: true };
}
