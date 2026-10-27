import "server-only";

import {
  canonicalGcsUri,
  type CreativeAssetStorageProvider,
} from "@icecore/airi-runtime/media-api";
import { storeRemoteCreativeAssetBuffer } from "@/lib/google/gcp-media-api";
import {
  JsonBodyTooLargeError,
  readBodyBytesWithinLimit,
} from "@/lib/api/json-body";
import type { CreativeAssetKind } from "@/models/creative-asset";
import {
  isDisallowedLocalHostname,
  isPrivateOrReservedIp,
} from "@icecore/shared/lib/network-safety";
import net from "net";
import { COMPANY_STORAGE_LIMIT_BYTES } from "@icecore/airi-runtime/storage-quota";
import { normalizeMediaMimeType } from "@/lib/whatsapp/media-types";

export type StoredCreativeAssetMedia = {
  storageProvider: CreativeAssetStorageProvider;
  url: string;
  bucket: string;
  path: string;
  mimeType: string;
  fileName: string;
  fileSize: number;
};

type CreativeAssetBucketClient = {
  upload: (
    path: string,
    body: Buffer,
    options: {
      contentType: string;
      cacheControl: string;
      upsert: boolean;
    }
  ) => Promise<{ error?: { message?: string } | null }>;
  list?: (
    path?: string,
    options?: {
      limit?: number;
      offset?: number;
      sortBy?: { column: string; order: "asc" | "desc" };
    }
  ) => Promise<{
    data?:
      | {
          name: string;
          id?: string | null;
          updated_at?: string | null;
          created_at?: string | null;
          metadata?: {
            size?: number;
            mimetype?: string;
            mimeType?: string;
            [key: string]: unknown;
          } | null;
        }[]
      | null;
    error?: { message?: string } | null;
  }>;
  remove?: (paths: string[]) => Promise<{
    data?: unknown;
    error?: { message?: string } | null;
  }>;
  createSignedUploadUrl?: (
    path: string,
    options?: { upsert: boolean }
  ) => Promise<{
    data?: {
      signedUrl?: string | null;
      token?: string | null;
      path?: string | null;
    } | null;
    error?: { message?: string } | null;
  }>;
  getPublicUrl: (path: string) => {
    data: { publicUrl?: string | null };
  };
};

export type CreativeAssetStorageClient = {
  storage: {
    from: (bucketName: string) => CreativeAssetBucketClient;
  };
};

const MAX_IMAGE_SIZE = 20 * 1024 * 1024;
const MAX_VIDEO_SIZE = 50 * 1024 * 1024;
const MAX_AUDIO_SIZE = 50 * 1024 * 1024;
const MAX_TEXT_SIZE = 5 * 1024 * 1024;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 60_000;
const MAX_PROVIDER_REDIRECTS = 3;
export const CREATIVE_ASSET_COMPANY_STORAGE_LIMIT_BYTES =
  COMPANY_STORAGE_LIMIT_BYTES;
export const CREATIVE_ASSET_COMPANY_STORAGE_LIMIT_LABEL = "10 GB";
const DEFAULT_HIGGSFIELD_MEDIA_HOST_ALLOWLIST = [
  "higgsfield.ai",
  "*.higgsfield.ai",
  // Alibaba Model Studio (HappyHorse / Wan / Qwen) result URLs land on OSS.
  "*.oss-accelerate.aliyuncs.com",
  "*.oss-accelerate-overseas.aliyuncs.com",
  "*.oss-ap-southeast-1.aliyuncs.com",
  "*.aliyuncs.com",
];
const ALLOWED_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);
const ALLOWED_VIDEO_TYPES = new Set([
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "video/3gpp",
]);
const ALLOWED_AUDIO_TYPES = new Set([
  "audio/mpeg",
  "audio/mp4",
  "audio/wav",
  "audio/x-wav",
  "audio/ogg",
  "audio/opus",
  "audio/webm",
  "audio/basic",
]);
const ALLOWED_TEXT_TYPES = new Set([
  "text/plain",
  "text/vtt",
  "application/x-subrip",
  "application/json",
]);
export const CREATIVE_ASSET_ALLOWED_MIME_TYPES = [
  ...Array.from(ALLOWED_IMAGE_TYPES),
  ...Array.from(ALLOWED_VIDEO_TYPES),
  ...Array.from(ALLOWED_AUDIO_TYPES),
  ...Array.from(ALLOWED_TEXT_TYPES),
].sort();

const MIME_TYPE_BY_EXTENSION = new Map<string, string>([
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".png", "image/png"],
  [".webp", "image/webp"],
  [".gif", "image/gif"],
  [".mp4", "video/mp4"],
  [".webm", "video/webm"],
  [".mov", "video/quicktime"],
  [".3gp", "video/3gpp"],
  [".3gpp", "video/3gpp"],
  [".mp3", "audio/mpeg"],
  [".m4a", "audio/mp4"],
  [".wav", "audio/wav"],
  [".ogg", "audio/ogg"],
  [".opus", "audio/opus"],
  [".txt", "text/plain"],
  [".vtt", "text/vtt"],
  [".srt", "application/x-subrip"],
  [".json", "application/json"],
]);

export class CreativeAssetValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CreativeAssetValidationError";
  }
}

function getDownloadTimeoutMs(): number {
  const parsed = Number.parseInt(
    process.env.HIGGSFIELD_MEDIA_DOWNLOAD_TIMEOUT_MS || "",
    10
  );
  if (!Number.isFinite(parsed)) return DEFAULT_DOWNLOAD_TIMEOUT_MS;
  return Math.min(5 * 60_000, Math.max(1_000, parsed));
}

function getMediaHostAllowlist(): string[] {
  const configured = (process.env.HIGGSFIELD_MEDIA_HOST_ALLOWLIST || "")
    .split(",")
    .map(value => value.trim().toLowerCase())
    .filter(Boolean);
  return configured.length > 0
    ? configured
    : DEFAULT_HIGGSFIELD_MEDIA_HOST_ALLOWLIST;
}

function filenameFromUrl(url: string): string {
  try {
    const pathname = new URL(url).pathname;
    return pathname.split("/").filter(Boolean).at(-1) || "creative-asset";
  } catch {
    return "creative-asset";
  }
}

function inferMimeTypeFromFilename(filename: string): string {
  const normalized = filename.toLowerCase();
  for (const [extension, mimeType] of MIME_TYPE_BY_EXTENSION) {
    if (normalized.endsWith(extension)) return mimeType;
  }
  return "";
}

function normalizeHostname(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, "");
}

function hostMatchesAllowlist(hostname: string, pattern: string): boolean {
  const host = normalizeHostname(hostname);
  const normalizedPattern = normalizeHostname(pattern);
  if (normalizedPattern.startsWith("*.")) {
    const suffix = normalizedPattern.slice(1);
    return host.endsWith(suffix) && host.length > suffix.length;
  }
  return host === normalizedPattern;
}

function assertSafeProviderMediaUrl(mediaUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(mediaUrl);
  } catch {
    throw new CreativeAssetValidationError(
      "Provider media URL is not a valid URL"
    );
  }

  if (parsed.protocol !== "https:") {
    throw new CreativeAssetValidationError("Provider media URL must use HTTPS");
  }

  const hostname = normalizeHostname(parsed.hostname);
  if (isDisallowedLocalHostname(hostname)) {
    throw new CreativeAssetValidationError(
      "Provider media URL cannot target local hosts"
    );
  }

  const ipVersion = net.isIP(hostname);
  if (ipVersion !== 0 && isPrivateOrReservedIp(hostname)) {
    throw new CreativeAssetValidationError(
      "Provider media URL cannot target private networks"
    );
  }

  if (
    !getMediaHostAllowlist().some(pattern =>
      hostMatchesAllowlist(hostname, pattern)
    )
  ) {
    throw new CreativeAssetValidationError(
      `Provider media URL host is not allowed: ${hostname}`
    );
  }

  return parsed;
}

async function fetchProviderMediaResponse(
  mediaUrl: string,
  signal: AbortSignal
): Promise<Response> {
  let currentUrl = mediaUrl;
  for (let redirects = 0; redirects <= MAX_PROVIDER_REDIRECTS; redirects += 1) {
    const safeUrl = assertSafeProviderMediaUrl(currentUrl);
    const response = await fetch(safeUrl, {
      redirect: "manual",
      signal,
    });

    const redirectLocation = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && redirectLocation) {
      currentUrl = new URL(redirectLocation, safeUrl).toString();
      continue;
    }

    return response;
  }

  throw new CreativeAssetValidationError(
    "Provider media URL redirected too many times"
  );
}

async function readResponseBufferWithLimit(
  response: Response,
  maxBytes: number
): Promise<Buffer> {
  try {
    const body = await readBodyBytesWithinLimit(response, maxBytes);
    return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  } catch (error) {
    if (error instanceof JsonBodyTooLargeError) {
      throw new CreativeAssetValidationError(
        "Creative asset exceeds the provider download size limit"
      );
    }
    throw error;
  }
}

export function resolveCreativeAssetMimeType(params: {
  fileName?: string | null;
  mimeType?: string | null;
}): string {
  const provided = normalizeMediaMimeType(params.mimeType);
  const inferred = inferMimeTypeFromFilename(params.fileName || "");
  if (provided && CREATIVE_ASSET_ALLOWED_MIME_TYPES.includes(provided)) {
    return provided;
  }
  if (inferred) return inferred;
  return provided || "application/octet-stream";
}

export function getCreativeAssetMaxBytes(kind: CreativeAssetKind): number {
  if (kind === "video") return MAX_VIDEO_SIZE;
  if (kind === "audio") return MAX_AUDIO_SIZE;
  if (kind === "text") return MAX_TEXT_SIZE;
  return MAX_IMAGE_SIZE;
}

export function assertCreativeAssetMimeTypeAllowed(
  kind: CreativeAssetKind,
  mimeType: string
) {
  if (kind === "image" && !ALLOWED_IMAGE_TYPES.has(mimeType)) {
    throw new CreativeAssetValidationError(
      "Creative image assets must be JPEG, PNG, WebP, or GIF"
    );
  }
  if (kind === "video" && !ALLOWED_VIDEO_TYPES.has(mimeType)) {
    throw new CreativeAssetValidationError(
      "Creative video assets must be MP4, WebM, MOV, 3GP, or 3GPP"
    );
  }
  if (kind === "audio" && !ALLOWED_AUDIO_TYPES.has(mimeType)) {
    throw new CreativeAssetValidationError(
      "Creative audio assets must be MP3, M4A, WAV, OGG, Opus, WebM, or basic audio"
    );
  }
  if (kind === "text" && !ALLOWED_TEXT_TYPES.has(mimeType)) {
    throw new CreativeAssetValidationError(
      "Creative text assets must be plain text, WebVTT, SRT, or JSON"
    );
  }
}

export function assertCreativeAssetAllowed(
  kind: CreativeAssetKind,
  mimeType: string,
  size: number
) {
  assertCreativeAssetMimeTypeAllowed(kind, mimeType);
  const maxSize = getCreativeAssetMaxBytes(kind);
  if (size > maxSize) {
    throw new CreativeAssetValidationError(
      `Creative ${kind} asset exceeds the provider download size limit of ${Math.round(
        maxSize / (1024 * 1024)
      )}MB`
    );
  }
}

export async function storeCreativeAssetBuffer(params: {
  storageClient?: CreativeAssetStorageClient;
  workspaceId: string;
  assetId: string;
  kind: CreativeAssetKind;
  buffer: Buffer;
  mimeType: string;
  fileName: string;
}): Promise<StoredCreativeAssetMedia> {
  const mimeType = resolveCreativeAssetMimeType({
    fileName: params.fileName,
    mimeType: params.mimeType,
  });
  assertCreativeAssetAllowed(params.kind, mimeType, params.buffer.byteLength);

  const stored = await storeRemoteCreativeAssetBuffer({
    workspaceId: params.workspaceId,
    assetId: params.assetId,
    kind: params.kind,
    buffer: params.buffer,
    mimeType,
    fileName: params.fileName,
  });

  return {
    storageProvider: "gcs",
    url: canonicalGcsUri(stored.bucket, stored.path),
    bucket: stored.bucket,
    path: stored.path,
    mimeType: stored.mimeType,
    fileName: stored.fileName,
    fileSize: stored.fileSize,
  };
}

export async function downloadAndStoreCreativeAsset(params: {
  storageClient: CreativeAssetStorageClient;
  workspaceId: string;
  assetId: string;
  kind: CreativeAssetKind;
  mediaUrl: string;
  fileName?: string | null;
  storeBuffer?: (params: {
    storageClient?: CreativeAssetStorageClient;
    workspaceId: string;
    assetId: string;
    kind: CreativeAssetKind;
    buffer: Buffer;
    mimeType: string;
    fileName: string;
  }) => Promise<StoredCreativeAssetMedia>;
}): Promise<StoredCreativeAssetMedia> {
  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(),
    getDownloadTimeoutMs()
  );

  try {
    const response = await fetchProviderMediaResponse(
      params.mediaUrl,
      controller.signal
    );
    if (!response.ok) {
      throw new Error(
        `Failed to download provider media: HTTP ${response.status}`
      );
    }
    const fileName = params.fileName || filenameFromUrl(params.mediaUrl);
    const mimeType = resolveCreativeAssetMimeType({
      fileName,
      mimeType: response.headers.get("content-type"),
    });
    const maxBytes = getCreativeAssetMaxBytes(params.kind);
    const contentLength = Number.parseInt(
      response.headers.get("content-length") || "",
      10
    );
    if (Number.isFinite(contentLength) && contentLength > 0) {
      assertCreativeAssetAllowed(params.kind, mimeType, contentLength);
    }
    const buffer = await readResponseBufferWithLimit(response, maxBytes);
    const storeBuffer = params.storeBuffer || storeCreativeAssetBuffer;
    return storeBuffer({
      storageClient: params.storageClient,
      workspaceId: params.workspaceId,
      assetId: params.assetId,
      kind: params.kind,
      buffer,
      mimeType,
      fileName,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("Timed out downloading provider media");
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}
