import {
  classifyWhatsAppUploadMedia,
  getWhatsAppOfficialMediaMaxBytes,
  isWhatsAppTemplateHeaderMediaMimeType,
  normalizeWhatsAppMimeType,
} from "@/lib/whatsapp/media-types";
import { getWhatsAppGraphClient } from "@icecore/shared/lib/meta/api";

const graphClient = getWhatsAppGraphClient();

export type WhatsAppUploadMediaKind = "image" | "video" | "document";

export class WhatsAppTemplateMediaDownloadError extends Error {
  readonly code = "WHATSAPP_TEMPLATE_MEDIA_DOWNLOAD_FAILED";
  constructor(readonly status: number) {
    super(
      `Failed to download WhatsApp template header media before upload: HTTP ${status}`
    );
    this.name = "WhatsAppTemplateMediaDownloadError";
  }
}

export function isWhatsAppTemplateMediaDownloadError(
  error: unknown
): error is WhatsAppTemplateMediaDownloadError {
  return error instanceof WhatsAppTemplateMediaDownloadError;
}

export type WhatsAppMediaUploadFromUrlResult = {
  id: string;
  mimeType: string;
  sizeBytes: number;
};

export type WhatsAppMediaUploadFileResult = WhatsAppMediaUploadFromUrlResult;

export type WhatsAppVoicemailAnnouncementUploadResult = {
  id: string;
  mimeType: "audio/ogg";
  sizeBytes: number;
};

function chooseMimeType(
  responseMimeType: string | null,
  fallbackMimeType: string
): string {
  const normalized = normalizeWhatsAppMimeType(responseMimeType);
  if (!normalized || normalized === "application/octet-stream") {
    return fallbackMimeType;
  }
  return normalized;
}

function validateMimeType(
  kind: WhatsAppUploadMediaKind,
  mimeType: string
): void {
  if (
    !isWhatsAppTemplateHeaderMediaMimeType({
      kind,
      mimeType,
    })
  ) {
    throw new Error(
      `WhatsApp template header expected ${kind} media, received ${mimeType}`
    );
  }
}

function defaultFilename(
  kind: WhatsAppUploadMediaKind,
  mimeType: string
): string {
  const extension = mimeType.split("/")[1]?.split("+")[0] || "bin";
  return `template-header-${kind}.${extension}`;
}

function formatUploadLimit(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${Math.round(bytes / 1024 / 1024)} MB`
    : `${Math.round(bytes / 1024)} KB`;
}

export async function uploadWhatsAppMediaFile(params: {
  phoneNumberId: string;
  accessToken: string;
  file: File;
  fallbackMimeType?: string;
  filename?: string;
}): Promise<WhatsAppMediaUploadFileResult> {
  const filename = params.filename || params.file.name || "attachment";
  const classification = classifyWhatsAppUploadMedia({
    mimeType: params.file.type || params.fallbackMimeType,
    fileName: filename,
  });
  if (!classification.mediaType) {
    throw new Error(
      `${filename}: this file type is not supported for WhatsApp media uploads.`
    );
  }

  if (params.file.size <= 0) {
    throw new Error(`${filename}: empty file`);
  }

  const maxBytes = getWhatsAppOfficialMediaMaxBytes(classification.mediaType);
  if (params.file.size > maxBytes) {
    throw new Error(
      `${filename}: WhatsApp ${classification.mediaType} media is too large. Maximum size is ${formatUploadLimit(
        maxBytes
      )}.`
    );
  }

  const mimeType = classification.mimeType;

  const formData = new FormData();
  formData.set("messaging_product", "whatsapp");
  formData.set("type", mimeType);
  formData.set("file", params.file, filename);

  const uploaded = await graphClient.postJson<{ id?: string }>(
    `${encodeURIComponent(params.phoneNumberId)}/media`,
    {
      token: params.accessToken,
      body: formData,
    }
  );

  const mediaId = uploaded.id?.trim();
  if (!mediaId) {
    throw new Error("WhatsApp media upload response did not include an id");
  }

  return {
    id: mediaId,
    mimeType,
    sizeBytes: params.file.size,
  };
}

export async function uploadWhatsAppVoicemailAnnouncementFile(params: {
  phoneNumberId: string;
  accessToken: string;
  file: File;
  description?: string;
  filename?: string;
}): Promise<WhatsAppVoicemailAnnouncementUploadResult> {
  const filename =
    params.filename || params.file.name || "voicemail-announcement.ogg";
  const mimeType = normalizeWhatsAppMimeType(params.file.type);

  if (params.file.size <= 0) {
    throw new Error(`${filename}: empty file`);
  }

  if (mimeType !== "audio/ogg") {
    throw new Error(
      `${filename}: WhatsApp voicemail announcements must be audio/ogg with the OPUS codec.`
    );
  }

  const maxBytes = getWhatsAppOfficialMediaMaxBytes("audio");
  if (params.file.size > maxBytes) {
    throw new Error(
      `${filename}: WhatsApp voicemail announcement media is too large. Maximum size is ${formatUploadLimit(
        maxBytes
      )}.`
    );
  }

  const formData = new FormData();
  formData.set("messaging_product", "whatsapp");
  formData.set("use_case", "call_voicemail_announcement");
  if (params.description?.trim()) {
    formData.set("description", params.description.trim());
  }
  formData.set("file", params.file, filename);

  const uploaded = await graphClient.postJson<{ id?: string }>(
    `${encodeURIComponent(params.phoneNumberId)}/media`,
    {
      token: params.accessToken,
      body: formData,
    }
  );

  const mediaId = uploaded.id?.trim();
  if (!mediaId) {
    throw new Error(
      "WhatsApp voicemail announcement upload response did not include an id"
    );
  }

  return {
    id: mediaId,
    mimeType,
    sizeBytes: params.file.size,
  };
}

export async function uploadWhatsAppMediaFromUrl(params: {
  phoneNumberId: string;
  accessToken: string;
  mediaUrl: string;
  kind: WhatsAppUploadMediaKind;
  fallbackMimeType: string;
  filename?: string;
}): Promise<WhatsAppMediaUploadFromUrlResult> {
  const downloadResponse = await fetch(params.mediaUrl, {
    signal: AbortSignal.timeout(30_000),
  });
  if (!downloadResponse.ok) {
    throw new WhatsAppTemplateMediaDownloadError(downloadResponse.status);
  }

  const mimeType = chooseMimeType(
    downloadResponse.headers.get("content-type"),
    params.fallbackMimeType
  );
  validateMimeType(params.kind, mimeType);

  const contentLengthHeader = downloadResponse.headers.get("content-length");
  const contentLength = contentLengthHeader
    ? Number.parseInt(contentLengthHeader, 10)
    : Number.NaN;
  const maxBytes = getWhatsAppOfficialMediaMaxBytes(params.kind);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error(
      `WhatsApp template header ${params.kind} media is too large for Cloud API upload (${contentLength} bytes)`
    );
  }

  const bytes = await downloadResponse.arrayBuffer();
  if (bytes.byteLength > maxBytes) {
    throw new Error(
      `WhatsApp template header ${params.kind} media is too large for Cloud API upload (${bytes.byteLength} bytes)`
    );
  }

  const formData = new FormData();
  formData.set("messaging_product", "whatsapp");
  formData.set("type", mimeType);
  formData.set(
    "file",
    new Blob([bytes], { type: mimeType }),
    params.filename || defaultFilename(params.kind, mimeType)
  );

  const uploaded = await graphClient.postJson<{ id?: string }>(
    `${encodeURIComponent(params.phoneNumberId)}/media`,
    {
      token: params.accessToken,
      body: formData,
      signal: AbortSignal.timeout(30_000),
    }
  );

  const mediaId = uploaded.id?.trim();
  if (!mediaId) {
    throw new Error("WhatsApp media upload response did not include an id");
  }

  return {
    id: mediaId,
    mimeType,
    sizeBytes: bytes.byteLength,
  };
}
