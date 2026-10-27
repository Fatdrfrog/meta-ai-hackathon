import "server-only";

import {
  buildWebVttFromElevenLabsWords,
  buildWebVttFromPlainText,
  extractElevenLabsTranscriptText,
  extractElevenLabsTranscriptWords,
} from "@/lib/elevenlabs/creative-assets";
import { storeCreativeAssetBuffer } from "@/lib/higgsfield/creative-asset-storage";
import connectDB from "@/lib/mongoose";
import { CreativeAsset, type ICreativeAsset } from "@/models/creative-asset";
import type { ElevenLabsCreativeTranscriptionMode } from "@icecore/temporal";
import { asRecord, cleanString } from "@icecore/shared/lib/value-utils";

type CreativeTranscriptionWebhookStatus = "completed" | "failed";

type CreativeTranscriptionAsset = Pick<
  Partial<ICreativeAsset>,
  | "_id"
  | "workspaceId"
  | "provider"
  | "status"
  | "providerRequestId"
  | "providerPayload"
>;

function textBuffer(value: string): Buffer {
  return Buffer.from(value, "utf8");
}

function mergeProviderPayload(params: {
  existing: unknown;
  mode: ElevenLabsCreativeTranscriptionMode;
  requestId: string;
  webhookType: string;
  providerStatus: string | null;
  payload: Record<string, unknown>;
}) {
  return {
    ...asRecord(params.existing),
    mode: params.mode,
    requestId: params.requestId,
    webhook: {
      type: params.webhookType,
      providerStatus: params.providerStatus,
      receivedAt: new Date().toISOString(),
      payload: params.payload,
    },
  };
}

export async function completeElevenLabsCreativeTranscriptionAsset(params: {
  workspaceId: string;
  assetId: string;
  requestId: string;
  mode: ElevenLabsCreativeTranscriptionMode;
  status: CreativeTranscriptionWebhookStatus;
  webhookType: string;
  data: Record<string, unknown>;
  error?: string | null;
}): Promise<void> {
  await connectDB();

  const asset = await CreativeAsset.findOne({
    _id: params.assetId,
    workspaceId: params.workspaceId,
    source: "elevenlabs",
    provider: "elevenlabs",
    kind: "text",
  }).lean<CreativeTranscriptionAsset | null>();

  if (!asset) {
    throw new Error("Creative transcription asset was not found.");
  }
  const storedRequestId = cleanString(asset.providerRequestId, 240);
  if (storedRequestId && storedRequestId !== params.requestId) {
    throw new Error("Creative transcription request id does not match asset.");
  }
  if (asset.status === "complete") return;

  const providerStatus = cleanString(params.data.status, 120) || null;
  const providerPayload = mergeProviderPayload({
    existing: asset.providerPayload,
    mode: params.mode,
    requestId: params.requestId,
    webhookType: params.webhookType,
    providerStatus,
    payload: params.data,
  });

  if (params.status === "failed") {
    await CreativeAsset.findByIdAndUpdate(params.assetId, {
      status: "failed",
      providerRequestId: params.requestId,
      providerPayload,
      error: params.error || "ElevenLabs transcription failed",
    });
    return;
  }

  const transcriptText = extractElevenLabsTranscriptText(params.data);
  if (!transcriptText) {
    throw new Error("ElevenLabs transcript text is missing.");
  }

  const words = extractElevenLabsTranscriptWords(params.data);
  const text =
    params.mode === "subtitles"
      ? words.length > 0
        ? buildWebVttFromElevenLabsWords(words)
        : buildWebVttFromPlainText(transcriptText)
      : transcriptText;
  const fileName =
    params.mode === "subtitles"
      ? "elevenlabs-subtitles.vtt"
      : "elevenlabs-transcript.txt";
  const mimeType = params.mode === "subtitles" ? "text/vtt" : "text/plain";

  const stored = await storeCreativeAssetBuffer({
    workspaceId: params.workspaceId,
    assetId: params.assetId,
    kind: "text",
    buffer: textBuffer(text),
    mimeType,
    fileName,
  });

  await CreativeAsset.findByIdAndUpdate(params.assetId, {
    status: "complete",
    providerRequestId: params.requestId,
    url: stored.url,
    storageProvider: stored.storageProvider,
    bucket: stored.bucket,
    path: stored.path,
    mimeType: stored.mimeType,
    fileName: stored.fileName,
    fileSize: stored.fileSize,
    providerPayload,
    error: null,
    completedAt: new Date(),
  });
}
