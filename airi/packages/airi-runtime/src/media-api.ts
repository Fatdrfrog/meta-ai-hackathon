export const MEDIA_API_PATHS = {
  health: "/readyz",
  legacyHealth: "/healthz",
  initiateUpload: "/v1/creative-assets/uploads/initiate",
  objectStat: "/v1/creative-assets/objects/stat",
  objectReadUrl: "/v1/creative-assets/objects/read-url",
  objectDelete: "/v1/creative-assets/objects/delete",
} as const;

export const DEFAULT_GCS_CREATIVE_ASSETS_BUCKET =
  "icecore-ai-creative-assets-prod";
export const CREATIVE_ASSET_UPLOAD_SESSION_TTL_SECONDS = 2 * 60 * 60;
export const CREATIVE_ASSET_SIGNED_READ_URL_TTL_SECONDS = 60 * 60;
export const CREATIVE_ASSET_UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;
export const CREATIVE_ASSET_CACHE_CONTROL = "public, max-age=3600";

export type CreativeAssetStorageProvider = "gcs" | "supabase";
export type MediaApiCreativeAssetKind = "image" | "video" | "audio" | "text";

export type MediaApiCreativeAssetObjectRef = {
  provider: "gcs";
  bucket: string;
  path: string;
  workspaceId?: string;
};

export type MediaApiInitiateUploadRequest = {
  workspaceId: string;
  assetId: string;
  kind: MediaApiCreativeAssetKind;
  fileName: string;
  mimeType: string;
  fileSize: number;
  bucket?: string;
  origin?: string | null;
};

export type MediaApiInitiateUploadResponse = {
  provider: "gcs";
  method: "PUT";
  uploadUrl: string;
  bucket: string;
  path: string;
  expiresInSeconds: number;
  cacheControl: string;
  mode?: "single";
  headers?: Record<string, string>;
};

export type MediaApiObjectStatRequest = MediaApiCreativeAssetObjectRef;

export type MediaApiObjectStatResponse = {
  provider: "gcs";
  bucket: string;
  path: string;
  exists: boolean;
  fileSize: number | null;
  mimeType: string | null;
  updatedAt: string | null;
};

export type MediaApiObjectReadUrlRequest = MediaApiCreativeAssetObjectRef & {
  expiresInSeconds?: number | null;
};

export type MediaApiObjectReadUrlResponse = {
  provider: "gcs";
  bucket: string;
  path: string;
  url: string;
  expiresAt: string;
};

export type MediaApiObjectDeleteRequest = MediaApiCreativeAssetObjectRef;

export type MediaApiObjectDeleteResponse = {
  provider: "gcs";
  bucket: string;
  path: string;
  deleted: boolean;
};

function cleanPathPart(value: string, fallback: string): string {
  const cleaned = value
    .trim()
    .replace(/\\/g, "/")
    .split("/")
    .filter(Boolean)
    .join("-")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  return cleaned || fallback;
}

export function sanitizeCreativeAssetObjectFileName(fileName: string): string {
  // GCS ownership checks reject any '..', including harmless title punctuation.
  return cleanPathPart(fileName, "creative-asset").replace(/\.{2,}/g, ".");
}

export function createCreativeAssetObjectPath(input: {
  workspaceId: string;
  assetId: string;
  kind: MediaApiCreativeAssetKind;
  fileName: string;
}): string {
  const workspaceId = cleanPathPart(input.workspaceId, "workspace");
  const assetId = cleanPathPart(input.assetId, "asset");
  const fileName = sanitizeCreativeAssetObjectFileName(input.fileName);
  return [
    "workspaces",
    workspaceId,
    "creative-assets",
    input.kind,
    assetId,
    fileName,
  ].join("/");
}

export function isCreativeAssetObjectPathForWorkspace(input: {
  workspaceId: string;
  path: string;
}): boolean {
  const workspaceId = cleanPathPart(input.workspaceId, "workspace");
  const prefix = `workspaces/${workspaceId}/creative-assets/`;
  return input.path.startsWith(prefix) && !input.path.includes("..");
}

export function canonicalGcsUri(bucket: string, path: string): string {
  return `gcs://${bucket}/${path.replace(/^\/+/, "")}`;
}

/**
 * Whether a stored URL names exactly this object. New records use the
 * `gcs://` form from `canonicalGcsUri`; older records may hold `gs://`.
 */
export function matchesGcsObjectUri(
  value: unknown,
  bucket: string,
  path: string,
): boolean {
  const canonical = canonicalGcsUri(bucket, path);
  return (
    value === canonical || value === `gs://${canonical.slice("gcs://".length)}`
  );
}

export function parseCanonicalGcsUri(
  value: string | null | undefined,
): { bucket: string; path: string } | null {
  const raw = String(value || "").trim();
  const withoutScheme = raw.startsWith("gcs://")
    ? raw.slice("gcs://".length)
    : raw.startsWith("gs://")
      ? raw.slice("gs://".length)
      : null;
  if (withoutScheme === null) return null;
  const slash = withoutScheme.indexOf("/");
  if (slash <= 0) return null;
  const bucket = withoutScheme.slice(0, slash).trim();
  const path = withoutScheme.slice(slash + 1).replace(/^\/+/, "");
  if (!bucket || !path) return null;
  return { bucket, path };
}

/** Prefer explicit bucket/path; fall back to parsing a `gcs://` or `gs://` URI. */
export function resolveCreativeAssetGcsObjectRef(params: {
  url?: string | null;
  bucket?: string | null;
  path?: string | null;
}): { bucket: string; path: string } | null {
  const parsed = parseCanonicalGcsUri(params.url);
  const bucket = String(params.bucket || "").trim() || parsed?.bucket || "";
  const path = String(params.path || "").trim() || parsed?.path || "";
  if (!bucket || !path) return null;
  return { bucket, path };
}
