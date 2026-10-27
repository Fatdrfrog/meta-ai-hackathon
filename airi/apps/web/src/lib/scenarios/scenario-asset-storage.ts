import "server-only";

import { createCreativeAssetReadUrl } from "@icecore/airi-runtime/creative-asset-read-url";
import { ensureMediaApiCreativeAssetReadUrlPort } from "@/lib/google/creative-asset-read-url-media-api-adapter";
import {
  canCallGcpMediaApi,
  createRemoteCreativeAssetUpload,
  deleteRemoteCreativeAssetObject,
  statRemoteCreativeAssetObject,
  storeRemoteCreativeAssetBuffer,
} from "@/lib/google/gcp-media-api";
import { decryptString, encryptString } from "@/lib/crypto";
import {
  canonicalGcsUri,
  createCreativeAssetObjectPath,
  CREATIVE_ASSET_UPLOAD_SESSION_TTL_SECONDS,
  isCreativeAssetObjectPathForWorkspace,
  type MediaApiInitiateUploadResponse,
} from "@icecore/airi-runtime/media-api";
import type { ScenarioActionAttachmentMediaType } from "@icecore/scenario-contracts";
import { normalizeMediaMimeType } from "@/lib/whatsapp/media-types";
import crypto from "crypto";
import { z } from "zod";
import { resolveScenarioAssetMediaKind } from "./scenario-asset-resolve";
import {
  ScenarioAssetUploadError,
  type ScenarioAssetUploadMetadata,
  validateScenarioAssetUploadMetadata,
} from "./scenario-asset-upload-validation";

export type ScenarioAssetStorageRef = {
  url: string;
  bucket: string;
  path: string;
  mimeType: string;
  fileName: string;
  fileSize: number;
};

export type ScenarioAssetUploadResult = ScenarioAssetStorageRef & {
  /** Fresh signed HTTPS for immediate UI preview. Expires. */
  displayUrl: string;
  mediaType?: ScenarioActionAttachmentMediaType;
};

export type ScenarioAssetUploadInitiation = MediaApiInitiateUploadResponse &
  ScenarioAssetUploadMetadata & {
    mediaType?: ScenarioActionAttachmentMediaType;
    uploadToken: string;
  };

const MAX_UPLOAD_TOKEN_LENGTH = 16_384;
const MAX_UPLOAD_TICKET_BYTES = 8_192;
const CANONICAL_BASE64_PATTERN =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

const UPLOAD_TICKET_SCHEMA = z
  .object({
    purpose: z.literal("scenario-asset-upload"),
    v: z.literal(1),
    workspaceId: z.string().min(1).max(256),
    bucket: z.string().min(1).max(256),
    path: z.string().min(1).max(4096),
    fileName: z.string().min(1).max(2048),
    mimeType: z.string().min(1).max(256),
    fileSize: z.number().int().positive(),
    channel: z.enum(["whatsapp"]).optional(),
    iat: z.number().int().nonnegative(),
    exp: z.number().int().positive(),
  })
  .strict();

function isCanonicalBase64(value: string, expectedBytes?: number): boolean {
  if (!value || !CANONICAL_BASE64_PATTERN.test(value)) return false;
  const bytes = Buffer.from(value, "base64");
  return (
    bytes.toString("base64") === value &&
    (expectedBytes === undefined
      ? bytes.byteLength <= MAX_UPLOAD_TICKET_BYTES
      : bytes.byteLength === expectedBytes)
  );
}

const UPLOAD_ENVELOPE_SCHEMA = z
  .object({
    iv: z
      .string()
      .length(16)
      .refine(value => isCanonicalBase64(value, 12)),
    tag: z
      .string()
      .length(24)
      .refine(value => isCanonicalBase64(value, 16)),
    ciphertext: z
      .string()
      .min(1)
      .max(Math.ceil(MAX_UPLOAD_TICKET_BYTES / 3) * 4)
      .refine(value => isCanonicalBase64(value)),
  })
  .strict();

function invalidUploadToken(): ScenarioAssetUploadError {
  return new ScenarioAssetUploadError(
    "Invalid scenario upload token. Start the upload again.",
    400,
    "scenario_asset_upload_rejected"
  );
}

function readUploadTicket(workspaceId: string, token: string) {
  let ticket: z.infer<typeof UPLOAD_TICKET_SCHEMA>;
  try {
    if (
      typeof token !== "string" ||
      token.length > MAX_UPLOAD_TOKEN_LENGTH ||
      !/^[A-Za-z0-9_-]+$/.test(token)
    ) {
      throw invalidUploadToken();
    }
    const bytes = Buffer.from(token, "base64url");
    if (bytes.toString("base64url") !== token) throw invalidUploadToken();
    const envelope = UPLOAD_ENVELOPE_SCHEMA.parse(
      JSON.parse(bytes.toString("utf8"))
    );
    ticket = UPLOAD_TICKET_SCHEMA.parse(JSON.parse(decryptString(envelope)));
  } catch {
    throw invalidUploadToken();
  }

  const now = Math.floor(Date.now() / 1000);
  const assetId = ticket.path.split("/")[4] || "";
  if (
    ticket.workspaceId !== workspaceId ||
    !Number.isSafeInteger(ticket.fileSize) ||
    !Number.isSafeInteger(ticket.iat) ||
    !Number.isSafeInteger(ticket.exp) ||
    ticket.iat > now ||
    ticket.exp <= ticket.iat ||
    ticket.exp - ticket.iat > CREATIVE_ASSET_UPLOAD_SESSION_TTL_SECONDS ||
    !/^scenario-[a-f0-9]{16}$/.test(assetId) ||
    ticket.path !==
      createCreativeAssetObjectPath({
        workspaceId,
        assetId,
        kind: resolveScenarioAssetMediaKind(ticket.mimeType),
        fileName: ticket.fileName,
      }) ||
    !isCreativeAssetObjectPathForWorkspace({
      workspaceId,
      path: ticket.path,
    })
  ) {
    throw invalidUploadToken();
  }
  if (ticket.exp <= now) {
    throw new ScenarioAssetUploadError(
      "Scenario upload expired. Start the upload again.",
      400,
      "scenario_asset_upload_rejected"
    );
  }
  return ticket;
}

export async function initiateScenarioAssetUpload(
  params: ScenarioAssetUploadMetadata & {
    workspaceId: string;
    origin?: string | null;
  }
): Promise<ScenarioAssetUploadInitiation> {
  assertMediaApiReadyForUpload();
  const metadata = validateScenarioAssetUploadMetadata({
    fileName: params.fileName,
    mimeType: params.mimeType,
    fileSize: params.fileSize,
    channel: params.channel,
  });
  const assetId = `scenario-${crypto.randomBytes(8).toString("hex")}`;
  const kind = resolveScenarioAssetMediaKind(metadata.mimeType);
  const upload = await createRemoteCreativeAssetUpload({
    workspaceId: params.workspaceId,
    assetId,
    kind,
    fileName: metadata.fileName,
    mimeType: metadata.mimeType,
    fileSize: metadata.fileSize,
    origin: params.origin,
  });
  if (
    upload.path !==
    createCreativeAssetObjectPath({
      workspaceId: params.workspaceId,
      assetId,
      kind,
      fileName: metadata.fileName,
    })
  ) {
    throw new Error(
      "GCP media API returned an unexpected scenario upload target"
    );
  }
  const iat = Math.floor(Date.now() / 1000);
  const expiresInSeconds = Math.min(
    CREATIVE_ASSET_UPLOAD_SESSION_TTL_SECONDS,
    upload.expiresInSeconds
  );
  // The generic assets flow accepts caller-provided bucket/path with prefix checks.
  // Authenticate this issued target and the Media API's configured bucket.
  const ticket = UPLOAD_TICKET_SCHEMA.parse({
    purpose: "scenario-asset-upload",
    v: 1,
    workspaceId: params.workspaceId,
    bucket: upload.bucket,
    path: upload.path,
    fileName: metadata.fileName,
    mimeType: metadata.mimeType,
    fileSize: metadata.fileSize,
    channel: metadata.channel,
    iat,
    exp: iat + expiresInSeconds,
  });
  const plaintext = JSON.stringify(ticket);
  if (Buffer.byteLength(plaintext, "utf8") > MAX_UPLOAD_TICKET_BYTES) {
    throw new ScenarioAssetUploadError(
      "Scenario upload metadata is too large.",
      400,
      "scenario_asset_upload_rejected"
    );
  }
  const uploadToken = Buffer.from(
    JSON.stringify(encryptString(plaintext)),
    "utf8"
  ).toString("base64url");
  return { ...upload, ...metadata, expiresInSeconds, uploadToken };
}

export async function completeScenarioAssetUpload(params: {
  workspaceId: string;
  uploadToken: string;
}): Promise<ScenarioAssetUploadResult> {
  const ticket = readUploadTicket(params.workspaceId, params.uploadToken);
  assertMediaApiReadyForUpload();
  const object = await statRemoteCreativeAssetObject({
    provider: "gcs",
    bucket: ticket.bucket,
    path: ticket.path,
    workspaceId: params.workspaceId,
  });
  if (object.exists !== true) {
    throw new ScenarioAssetUploadError(
      "Uploaded scenario file was not found in storage.",
      400,
      "scenario_asset_upload_rejected"
    );
  }
  let metadata: ReturnType<typeof validateScenarioAssetUploadMetadata>;
  try {
    const mimeType =
      typeof object.mimeType === "string"
        ? normalizeMediaMimeType(object.mimeType)
        : "";
    if (
      !Number.isSafeInteger(object.fileSize) ||
      !object.fileSize ||
      object.fileSize <= 0 ||
      !mimeType
    ) {
      throw new ScenarioAssetUploadError(
        "Uploaded scenario file has invalid storage metadata.",
        400,
        "scenario_asset_upload_rejected"
      );
    }
    // Validate the provider's size first so an oversized object keeps its useful
    // channel limit error. MIME equality uses provider metadata, never inference.
    metadata = validateScenarioAssetUploadMetadata({
      fileName: ticket.fileName,
      mimeType,
      fileSize: object.fileSize,
      channel: ticket.channel,
    });
    if (object.fileSize !== ticket.fileSize || mimeType !== ticket.mimeType) {
      throw new ScenarioAssetUploadError(
        "Uploaded scenario file does not match its initiated metadata.",
        400,
        "scenario_asset_upload_rejected"
      );
    }
  } catch (error) {
    if (error instanceof ScenarioAssetUploadError) {
      // Only a verified ticket and positive stat may authorize rejection cleanup.
      // Cleanup is best effort; its failure must preserve the useful validation error.
      await deleteRemoteCreativeAssetObject({
        provider: "gcs",
        bucket: ticket.bucket,
        path: ticket.path,
        workspaceId: params.workspaceId,
      }).catch(() => undefined);
    }
    throw error;
  }

  const displayUrl = await createScenarioAssetDisplayUrl({
    bucket: ticket.bucket,
    path: ticket.path,
    workspaceId: params.workspaceId,
  });
  return {
    url: canonicalGcsUri(ticket.bucket, ticket.path),
    displayUrl,
    bucket: ticket.bucket,
    path: ticket.path,
    fileName: metadata.fileName,
    mimeType: metadata.mimeType,
    fileSize: metadata.fileSize,
    ...(metadata.mediaType ? { mediaType: metadata.mediaType } : {}),
  };
}

function assertMediaApiReadyForUpload(): void {
  if (!canCallGcpMediaApi()) {
    throw new Error(
      "GCP media API is not configured. Set GCP_MEDIA_API_URL (and Vercel OIDC in deployed environments)."
    );
  }
}

async function createScenarioAssetDisplayUrl(params: {
  workspaceId: string;
  bucket: string;
  path: string;
}): Promise<string> {
  ensureMediaApiCreativeAssetReadUrlPort();
  const read = await createCreativeAssetReadUrl({ provider: "gcs", ...params });
  return read.url;
}

/**
 * Web upload path only — Media API + Vercel OIDC.
 * Outbound send must not import this module for resolve.
 */
export async function storeScenarioAssetBuffer(params: {
  workspaceId: string;
  buffer: Buffer;
  mimeType: string;
  fileName: string;
}): Promise<ScenarioAssetUploadResult> {
  assertMediaApiReadyForUpload();

  const assetId = `scenario-${crypto.randomBytes(8).toString("hex")}`;
  const kind = resolveScenarioAssetMediaKind(params.mimeType);
  const stored = await storeRemoteCreativeAssetBuffer({
    workspaceId: params.workspaceId,
    assetId,
    kind,
    buffer: params.buffer,
    mimeType: params.mimeType,
    fileName: params.fileName,
  });

  const displayUrl = await createScenarioAssetDisplayUrl({
    bucket: stored.bucket,
    path: stored.path,
    workspaceId: params.workspaceId,
  });

  return {
    url: stored.url,
    displayUrl,
    bucket: stored.bucket,
    path: stored.path,
    mimeType: stored.mimeType,
    fileName: stored.fileName,
    fileSize: stored.fileSize,
  };
}
