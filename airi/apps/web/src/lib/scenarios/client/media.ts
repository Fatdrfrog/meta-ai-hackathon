import {
  errorMessageOrFallback,
  JSON_HEADERS,
  NO_STORE_OPTIONS,
  readResponseJson,
  ScenarioRequestError,
} from "./http";
import type { ScenarioActionAttachmentMediaType } from "@icecore/scenario-contracts";
import {
  GcsResumableUploadError,
  uploadGcsResumableAsset,
  type GcsResumableUploadTarget,
} from "@/lib/google/gcs-resumable-upload";
import {
  ScenarioAssetUploadError,
  validateScenarioAssetUploadMetadata,
} from "../scenario-asset-upload-validation";

type ScenarioMediaUploadResponse = {
  error?: string;
  code?: string;
  upload?: GcsResumableUploadTarget & {
    provider?: string;
    uploadToken?: string;
  };
  image?: {
    url?: string;
    bucket?: string;
    path?: string;
    mediaType?: ScenarioActionAttachmentMediaType;
    mimeType?: string;
    fileName?: string;
    fileSize?: number;
  };
};

function uploadFailureCode(status: number, storage = false): string {
  if (status === 413) return "scenario_asset_upload_too_large";
  if (storage && status >= 400 && status < 500)
    return "scenario_asset_upload_rejected";
  if (status === 401) return "scenario_asset_upload_auth_required";
  if (status === 403) return "scenario_asset_upload_forbidden";
  if (status >= 500) return "scenario_asset_upload_unavailable";
  return "scenario_asset_upload_failed";
}

async function postScenarioUploadMetadata(
  endpoint: string,
  body: unknown
): Promise<ScenarioMediaUploadResponse> {
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(body),
    });
  } catch {
    throw new ScenarioRequestError({
      message: "Upload connection failed",
      status: 0,
      code: "scenario_asset_upload_network_failed",
    });
  }
  const data = (await readResponseJson(
    response
  )) as ScenarioMediaUploadResponse | null;
  if (!response.ok) {
    throw new ScenarioRequestError({
      message: errorMessageOrFallback(data, "Failed to upload file"),
      status: response.status,
      code:
        typeof data?.code === "string"
          ? data.code
          : uploadFailureCode(response.status),
    });
  }
  return data ?? {};
}

export async function uploadScenarioActionImage(params: {
  workspaceId: string;
  file: File;
  channel?: "whatsapp";
}): Promise<{
  url: string;
  bucket: string;
  path: string;
  mediaType?: ScenarioActionAttachmentMediaType;
  mimeType?: string;
  fileName?: string;
  fileSize?: number;
}> {
  let metadata;
  try {
    metadata = validateScenarioAssetUploadMetadata({
      fileName: params.file.name,
      mimeType: params.file.type,
      fileSize: params.file.size,
      channel: params.channel,
    });
  } catch (error) {
    if (error instanceof ScenarioAssetUploadError) {
      throw new ScenarioRequestError({
        message: error.message,
        status: error.status,
        code: error.code,
      });
    }
    throw error;
  }
  const endpoint = `/api/workspaces/${encodeURIComponent(params.workspaceId)}/scenarios/action-image-upload`;
  const initiated = await postScenarioUploadMetadata(endpoint, {
    action: "initiate",
    fileName: metadata.fileName,
    mimeType: metadata.mimeType,
    fileSize: metadata.fileSize,
    ...(params.channel ? { channel: params.channel } : {}),
  });
  const upload = initiated.upload;
  if (
    upload?.provider !== "gcs" ||
    upload.method !== "PUT" ||
    !upload.uploadUrl ||
    !upload.uploadToken
  ) {
    throw new ScenarioRequestError({
      message: "Upload target missing",
      status: 502,
      code: "scenario_asset_upload_failed",
    });
  }
  try {
    await uploadGcsResumableAsset({ file: params.file, upload });
  } catch (error) {
    if (error instanceof GcsResumableUploadError) {
      throw new ScenarioRequestError({
        message: "Storage upload failed",
        status: error.status,
        code: uploadFailureCode(error.status, true),
      });
    }
    throw new ScenarioRequestError({
      message: "Upload connection failed",
      status: 0,
      code: "scenario_asset_upload_network_failed",
    });
  }
  const completed = await postScenarioUploadMetadata(endpoint, {
    action: "complete",
    uploadToken: upload.uploadToken,
  });
  const image = completed.image;
  if (!image?.url || !image.bucket || !image.path) {
    throw new ScenarioRequestError({
      message: "Upload payload missing",
      status: 502,
      code: "scenario_asset_upload_failed",
    });
  }

  return {
    url: image.url,
    bucket: image.bucket,
    path: image.path,
    mediaType: image.mediaType,
    mimeType: image.mimeType,
    fileName: image.fileName,
    fileSize: image.fileSize,
  };
}

export async function generateScenarioActionVoice(params: {
  workspaceId: string;
  text: string;
  voiceId?: string;
}): Promise<{
  url: string;
  bucket: string;
  path: string;
  mediaType: "audio";
  mimeType?: string;
  fileName?: string;
  fileSize?: number;
}> {
  const response = await fetch(
    `/api/workspaces/${encodeURIComponent(params.workspaceId)}/scenarios/generate-voice`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: params.text,
        ...(params.voiceId ? { voiceId: params.voiceId } : {}),
      }),
    }
  );

  const data = (await readResponseJson(response)) as {
    error?: string;
    attachment?: {
      url?: string;
      bucket?: string;
      path?: string;
      mediaType?: ScenarioActionAttachmentMediaType;
      mimeType?: string;
      fileName?: string;
      fileSize?: number;
    };
  } | null;
  if (!response.ok) {
    throw new Error(
      errorMessageOrFallback(data, "Failed to generate voice note")
    );
  }

  const attachment = data?.attachment;
  if (!attachment?.url || !attachment.bucket || !attachment.path) {
    throw new Error("Voice generation payload missing");
  }

  return {
    url: attachment.url,
    bucket: attachment.bucket,
    path: attachment.path,
    mediaType: "audio",
    mimeType: attachment.mimeType,
    fileName: attachment.fileName,
    fileSize: attachment.fileSize,
  };
}

export async function fetchElevenLabsScribeToken(params: {
  workspaceId: string;
}): Promise<{ token: string; expiresAt?: string | null }> {
  const response = await fetch("/api/elevenlabs/scribe-token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workspaceId: params.workspaceId }),
  });

  const data = (await readResponseJson(response)) as {
    error?: string;
    token?: string;
    expiresAt?: string | null;
  } | null;
  if (!response.ok) {
    throw new Error(
      errorMessageOrFallback(data, "Failed to start voice dictation")
    );
  }
  if (!data?.token) {
    throw new Error("Voice dictation token missing");
  }

  return {
    token: data.token,
    expiresAt: data.expiresAt ?? null,
  };
}

export async function fetchWorkspaceCreativeAsset(params: {
  workspaceId: string;
  assetId: string;
  signal?: AbortSignal;
}): Promise<{ asset?: unknown; error?: string }> {
  const response = await fetch(
    `/api/workspaces/${encodeURIComponent(params.workspaceId)}/assets/${encodeURIComponent(params.assetId)}`,
    {
      ...NO_STORE_OPTIONS,
      signal: params.signal,
    }
  );
  const data = (await readResponseJson(response)) as {
    asset?: unknown;
    error?: string;
  } | null;
  if (!response.ok) {
    throw new Error(
      errorMessageOrFallback(data, `Request failed with ${response.status}`)
    );
  }
  return data ?? {};
}

export async function generateWorkspaceCreativeImage(params: {
  workspaceId: string;
  prompt: string;
  signal?: AbortSignal;
}): Promise<{ asset?: unknown; error?: string }> {
  const body = JSON.stringify({
    mode: "text_to_image" as const,
    prompt: params.prompt,
    aspectRatio: "9:16",
    resolution: "720p",
  });
  const requestInit: RequestInit = {
    method: "POST",
    headers: JSON_HEADERS,
    signal: params.signal,
    body,
  };
  let response = await fetch(
    `/api/workspaces/${encodeURIComponent(params.workspaceId)}/assets/generate/alibaba`,
    requestInit
  );
  if (response.status === 503) {
    const alibabaBody = (await readResponseJson(response)) as {
      asset?: unknown;
      configured?: boolean;
      error?: string;
    } | null;
    if (alibabaBody?.configured !== false) {
      throw new Error(
        errorMessageOrFallback(
          alibabaBody,
          `Request failed with ${response.status}`
        )
      );
    }
    response = await fetch(
      `/api/workspaces/${encodeURIComponent(params.workspaceId)}/assets/generate/higgsfield`,
      requestInit
    );
  }
  const data = (await readResponseJson(response)) as {
    asset?: unknown;
    error?: string;
  } | null;
  if (!response.ok) {
    throw new Error(
      errorMessageOrFallback(data, `Request failed with ${response.status}`)
    );
  }
  return data ?? {};
}
