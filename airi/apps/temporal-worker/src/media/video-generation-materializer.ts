import { createHash } from "node:crypto";
import { open, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { VideoGenerationSpec } from "@icecore/temporal";

import {
  createGcsCreativeAssetPath,
  getGcsCreativeAssetsBucketName,
} from "../gcs-creative-assets";
import {
  downloadProviderVideoToFile,
  MAX_GENERATED_VIDEO_BYTES,
  type ProviderDownloadPolicy,
} from "./safe-provider-download";
import { probeVideoFile, type VideoProbeResult } from "./video-probe";
import {
  asVideoGenerationFinalizationError,
  VideoGenerationFinalizationError,
  type VideoGenerationFinalizationFailure,
} from "../video-generation-finalization-failure";

export type VideoGenerationResultWarning = {
  code: "duration_mismatch" | "mime_type_normalized";
  message: string;
};

export type MaterializedVideoResult = VideoProbeResult & {
  fileSize: number;
  sha256: string;
  providerUsage: Record<string, number | string> | null;
  warnings: VideoGenerationResultWarning[];
  startedAt: Date | null;
  completedAt: Date;
};

export type VideoGenerationMaterializerInput = {
  workspaceId: string;
  assetId: string;
  attemptToken: string;
  providerRequestId: string;
  recipeFingerprint: string;
  provider: VideoGenerationSpec["provider"];
  requestedDurationSeconds: number;
  startedAt?: Date | null;
  signal?: AbortSignal;
  recoverySource?: {
    assetId: string;
    attemptToken: string;
    providerRequestId: string;
    recipeFingerprint: string;
    provider: VideoGenerationSpec["provider"];
  } | null;
};

type StoredObject = {
  exists: boolean;
  fileSize: number | null;
  mimeType: string | null;
  updatedAt: string | null;
  customMetadata: Record<string, string>;
  generation: string | null;
  metageneration: string | null;
};

export type ProviderVideoResult =
  | {
      kind: "url";
      url: string;
      policy: ProviderDownloadPolicy;
      authorization?: string;
      requestHeaders?: Readonly<Record<string, string>>;
      mimeType?: string | null;
      providerUsage?: Record<string, unknown> | null;
    }
  | {
      kind: "base64";
      base64: string;
      mimeType: string;
      providerUsage?: Record<string, unknown> | null;
    };

type UploadResult = {
  storageProvider: "gcs";
  url: string;
  bucket: string;
  path: string;
  mimeType: string;
  fileName: string;
  fileSize: number;
  generation: string | null;
  metageneration: string | null;
};

type AssetState = {
  status: "queued" | "in_progress" | "complete" | "failed" | "nsfw";
  generationResult: MaterializedVideoResult | null;
};

export type VideoGenerationMaterializerDependencies = {
  bucketName?: string;
  getAsset: (
    identity: Pick<
      VideoGenerationMaterializerInput,
      "workspaceId" | "assetId" | "attemptToken" | "providerRequestId"
    >,
  ) => Promise<AssetState | null>;
  statObject: (params: {
    bucket: string;
    path: string;
    workspaceId: string;
  }) => Promise<StoredObject>;
  loadProviderResult: (
    input: VideoGenerationMaterializerInput,
  ) => Promise<ProviderVideoResult>;
  writeProviderResult?: (params: {
    result: ProviderVideoResult;
    destinationPath: string;
    signal?: AbortSignal;
  }) => Promise<{ fileSize: number; sha256: string; mimeType: string }>;
  probeVideoFile?: typeof probeVideoFile;
  uploadFile: (params: {
    bucket: string;
    workspaceId: string;
    assetId: string;
    kind: "video";
    localPath: string;
    mimeType: string;
    fileName: "generated-video.mp4";
    path: string;
    customMetadata: Record<string, string>;
    preconditionOpts: { ifGenerationMatch: 0 };
  }) => Promise<UploadResult>;
  copyObject: (params: {
    bucket: string;
    sourcePath: string;
    sourceGeneration: string;
    sourceMetageneration: string;
    destinationPath: string;
    workspaceId: string;
    mimeType: string;
    customMetadata: Record<string, string>;
  }) => Promise<{ generation: string; metageneration: string }>;
  deleteObject: (params: {
    bucket: string;
    path: string;
    workspaceId: string;
    ifGenerationMatch: string;
    ifMetagenerationMatch: string;
  }) => Promise<{ deleted: boolean }>;
  stageAsset: (params: {
    expected: Pick<
      VideoGenerationMaterializerInput,
      "workspaceId" | "assetId" | "attemptToken" | "providerRequestId"
    >;
    storage: {
      storageProvider: "gcs";
      url: string;
      bucket: string;
      path: string;
      mimeType: string;
      fileName: "generated-video.mp4";
      fileSize: number;
    };
  }) => Promise<{ matched: boolean }>;
  clearStagedAsset: (params: {
    expected: Pick<
      VideoGenerationMaterializerInput,
      "workspaceId" | "assetId" | "attemptToken" | "providerRequestId"
    >;
    storage: { bucket: string; path: string };
  }) => Promise<{ matched: boolean }>;
  completeAsset: (params: {
    expected: {
      workspaceId: string;
      assetId: string;
      attemptToken: string;
      providerRequestId: string;
      allowedStatuses: ["queued", "in_progress"];
    };
    storage: {
      storageProvider: "gcs";
      url: string;
      bucket: string;
      path: string;
      mimeType: string;
      fileName: "generated-video.mp4";
      fileSize: number;
    };
    result: MaterializedVideoResult;
  }) => Promise<{ matched: boolean }>;
};

async function finalizationStep<T>(
  failure: Omit<VideoGenerationFinalizationFailure, "contractVersion">,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw asVideoGenerationFinalizationError(error, failure);
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function boundedUsage(
  value: Record<string, unknown> | null | undefined,
): Record<string, number | string> | null {
  if (!value) return null;
  const result: Record<string, number | string> = {};
  for (const [rawKey, rawValue] of Object.entries(value).slice(0, 16)) {
    const key = rawKey.slice(0, 64);
    if (!key || Object.hasOwn(result, key)) continue;
    if (typeof rawValue === "number" && Number.isFinite(rawValue))
      result[key] = rawValue;
    else if (typeof rawValue === "string") result[key] = rawValue.slice(0, 256);
  }
  return Object.keys(result).length ? result : null;
}

const MAX_SAFE_GCS_CUSTOM_METADATA_BYTES = 6 * 1024;

function gcsCustomMetadataBytes(metadata: Record<string, string>): number {
  return Object.entries(metadata).reduce(
    (total, [key, value]) =>
      total + Buffer.byteLength(`x-goog-meta-${key}: ${value}\r\n`, "utf8"),
    0,
  );
}

function boundedStoredWarnings(value: unknown): VideoGenerationResultWarning[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 16).flatMap((warning) => {
    if (!warning || typeof warning !== "object" || Array.isArray(warning)) {
      return [];
    }
    const { code, message } = warning as Record<string, unknown>;
    if (
      (code !== "duration_mismatch" && code !== "mime_type_normalized") ||
      typeof message !== "string" ||
      !message ||
      message.length > 1_000
    ) {
      return [];
    }
    return [{ code, message }];
  });
}

function parseStoredResultManifest(
  metadata: Record<string, string>,
): Pick<MaterializedVideoResult, "providerUsage" | "warnings"> | null {
  try {
    let providerUsage: Record<string, number | string> | null = null;
    if (metadata.resultProviderUsage) {
      const decodedUsage = JSON.parse(metadata.resultProviderUsage) as unknown;
      if (
        !decodedUsage ||
        typeof decodedUsage !== "object" ||
        Array.isArray(decodedUsage)
      ) {
        return null;
      }
      providerUsage = boundedUsage(decodedUsage as Record<string, unknown>);
      if (
        !providerUsage ||
        Object.keys(providerUsage).length !== Object.keys(decodedUsage).length
      ) {
        return null;
      }
    }
    let warnings: VideoGenerationResultWarning[] = [];
    if (metadata.resultWarnings) {
      const decodedWarnings = JSON.parse(metadata.resultWarnings) as unknown;
      if (!Array.isArray(decodedWarnings)) return null;
      warnings = boundedStoredWarnings(decodedWarnings);
      if (warnings.length !== decodedWarnings.length) return null;
    }
    return { providerUsage, warnings };
  } catch {
    return null;
  }
}

function withBoundedResultManifestMetadata(
  baseMetadata: Record<string, string>,
  result: Pick<MaterializedVideoResult, "providerUsage" | "warnings">,
): {
  metadata: Record<string, string>;
  providerUsage: Record<string, number | string> | null;
  warnings: VideoGenerationResultWarning[];
} {
  const requestedWarnings = result.warnings.slice(0, 16);
  let warnings = requestedWarnings;
  let metadata: Record<string, string> = {
    ...baseMetadata,
    resultWarnings: JSON.stringify(warnings),
  };
  if (gcsCustomMetadataBytes(metadata) > MAX_SAFE_GCS_CUSTOM_METADATA_BYTES) {
    warnings = [];
    metadata = { ...baseMetadata, resultWarnings: "[]" };
  }
  if (gcsCustomMetadataBytes(metadata) > MAX_SAFE_GCS_CUSTOM_METADATA_BYTES) {
    throw new VideoGenerationFinalizationError({
      phase: "store",
      code: "result_metadata_too_large",
      providerCode: null,
      message: "Generated video identity metadata exceeds the storage limit",
      retryable: false,
    });
  }

  const providerUsage: Record<string, number | string> = {};
  for (const [key, value] of Object.entries(
    boundedUsage(result.providerUsage) ?? {},
  )) {
    const candidateUsage = { ...providerUsage, [key]: value };
    const candidate = {
      ...metadata,
      resultProviderUsage: JSON.stringify(candidateUsage),
    };
    if (
      gcsCustomMetadataBytes(candidate) <= MAX_SAFE_GCS_CUSTOM_METADATA_BYTES
    ) {
      providerUsage[key] = value;
    }
  }
  if (Object.keys(providerUsage).length > 0) {
    metadata = {
      ...metadata,
      resultProviderUsage: JSON.stringify(providerUsage),
    };
  }
  return {
    metadata,
    providerUsage: Object.keys(providerUsage).length ? providerUsage : null,
    warnings,
  };
}

function parseStoredResult(
  object: StoredObject,
): MaterializedVideoResult | null {
  const metadata = object.customMetadata;
  const manifest = parseStoredResultManifest(metadata);
  const durationSeconds = Number(metadata.durationSeconds);
  const width = Number(metadata.width);
  const height = Number(metadata.height);
  const fileSize = Number(metadata.fileSize);
  const observedFileSize = object.fileSize;
  const observedMimeType = object.mimeType?.trim().toLowerCase() || null;
  const metadataMimeType = metadata.mimeType?.trim().toLowerCase() || null;
  if (
    !metadata.sha256 ||
    !/^[a-f0-9]{64}$/.test(metadata.sha256) ||
    !Number.isFinite(durationSeconds) ||
    durationSeconds <= 0 ||
    !Number.isFinite(width) ||
    width <= 0 ||
    !Number.isFinite(height) ||
    height <= 0 ||
    !Number.isInteger(fileSize) ||
    fileSize <= 0 ||
    observedFileSize === null ||
    observedFileSize !== fileSize ||
    !metadataMimeType ||
    !observedMimeType ||
    observedMimeType !== metadataMimeType ||
    !manifest
  )
    return null;
  return {
    durationSeconds,
    width: Math.floor(width),
    height: Math.floor(height),
    mimeType: metadataMimeType,
    fileSize: Math.floor(fileSize),
    sha256: metadata.sha256,
    providerUsage: manifest.providerUsage,
    warnings: manifest.warnings,
    startedAt: metadata.startedAt ? new Date(metadata.startedAt) : null,
    completedAt: metadata.completedAt
      ? new Date(metadata.completedAt)
      : new Date(),
  };
}

function identityMetadata(
  input: VideoGenerationMaterializerInput,
): Record<string, string> {
  return {
    workspaceId: input.workspaceId,
    assetId: input.assetId,
    recipeFingerprint: input.recipeFingerprint,
    provider: input.provider,
    attemptTokenHash: sha256(input.attemptToken),
    providerRequestIdHash: sha256(input.providerRequestId),
  };
}

function objectIdentity(
  object: StoredObject,
  input: VideoGenerationMaterializerInput,
): "matching" | "same-incomplete" | "conflict" {
  const expected = identityMetadata(input);
  const metadata = object.customMetadata;
  const sameRecipe =
    metadata.workspaceId === expected.workspaceId &&
    metadata.assetId === expected.assetId &&
    metadata.recipeFingerprint === expected.recipeFingerprint &&
    metadata.provider === expected.provider;
  const sameAttempt =
    metadata.attemptTokenHash === expected.attemptTokenHash &&
    metadata.providerRequestIdHash === expected.providerRequestIdHash;
  if (!sameRecipe || !sameAttempt) return "conflict";
  return parseStoredResult(object) ? "matching" : "same-incomplete";
}

type RecoverySource = NonNullable<
  VideoGenerationMaterializerInput["recoverySource"]
>;

function recoverySourceInput(
  input: VideoGenerationMaterializerInput,
): VideoGenerationMaterializerInput | null {
  const source = input.recoverySource;
  if (!source) return null;
  if (
    !source.assetId ||
    source.assetId === input.assetId ||
    source.assetId.length > 128 ||
    !source.attemptToken ||
    source.attemptToken.length > 5_000 ||
    !source.providerRequestId ||
    source.providerRequestId.length > 500 ||
    source.providerRequestId !== input.providerRequestId ||
    !/^[a-f0-9]{64}$/.test(source.recipeFingerprint) ||
    source.provider !== input.provider
  ) {
    throw new VideoGenerationFinalizationError({
      phase: "store",
      code: "recovery_source_invalid",
      providerCode: null,
      message: "Stored video recovery identity is invalid",
      retryable: false,
    });
  }
  return {
    ...input,
    assetId: source.assetId,
    attemptToken: source.attemptToken,
    providerRequestId: source.providerRequestId,
    recipeFingerprint: source.recipeFingerprint,
    provider: source.provider,
    recoverySource: null,
  };
}

function recoveryLineageMetadata(
  source: RecoverySource,
  object: StoredObject,
): Record<string, string> {
  if (!object.generation || !object.metageneration) {
    throw new VideoGenerationFinalizationError({
      phase: "store",
      code: "recovery_source_version_unavailable",
      providerCode: null,
      message: "Stored video recovery source has no safe version",
      retryable: true,
    });
  }
  return {
    recoverySourceAssetIdHash: sha256(source.assetId),
    recoverySourceAttemptTokenHash: sha256(source.attemptToken),
    recoverySourceProviderRequestIdHash: sha256(source.providerRequestId),
    recoverySourceRecipeFingerprint: source.recipeFingerprint,
    recoverySourceProvider: source.provider,
    recoverySourceGeneration: object.generation,
    recoverySourceMetageneration: object.metageneration,
  };
}

type RecoveryLineage =
  | { kind: "none" }
  | {
      kind: "matching";
      generation: string;
      metageneration: string;
    }
  | { kind: "conflict" };

function recoveryLineage(
  object: StoredObject,
  source: RecoverySource | null | undefined,
): RecoveryLineage {
  const metadata = object.customMetadata;
  const keys = [
    "recoverySourceAssetIdHash",
    "recoverySourceAttemptTokenHash",
    "recoverySourceProviderRequestIdHash",
    "recoverySourceRecipeFingerprint",
    "recoverySourceProvider",
    "recoverySourceGeneration",
    "recoverySourceMetageneration",
  ] as const;
  if (!keys.some((key) => metadata[key])) return { kind: "none" };
  if (
    !source ||
    metadata.recoverySourceAssetIdHash !== sha256(source.assetId) ||
    metadata.recoverySourceAttemptTokenHash !== sha256(source.attemptToken) ||
    metadata.recoverySourceProviderRequestIdHash !==
      sha256(source.providerRequestId) ||
    metadata.recoverySourceRecipeFingerprint !== source.recipeFingerprint ||
    metadata.recoverySourceProvider !== source.provider ||
    !metadata.recoverySourceGeneration ||
    !metadata.recoverySourceMetageneration
  ) {
    return { kind: "conflict" };
  }
  return {
    kind: "matching",
    generation: metadata.recoverySourceGeneration,
    metageneration: metadata.recoverySourceMetageneration,
  };
}

function copiedResultMetadata(
  input: VideoGenerationMaterializerInput,
  source: RecoverySource,
  object: StoredObject,
): Record<string, string> {
  const result = parseStoredResult(object);
  if (!result) throw new Error("Stored video recovery result is incomplete");
  const metadata = object.customMetadata;
  const baseMetadata = {
    ...identityMetadata(input),
    ...recoveryLineageMetadata(source, object),
    sha256: result.sha256,
    width: String(result.width),
    height: String(result.height),
    durationSeconds: String(result.durationSeconds),
    mimeType: result.mimeType,
    fileSize: String(result.fileSize),
    ...(metadata.startedAt ? { startedAt: metadata.startedAt } : {}),
    ...(metadata.completedAt ? { completedAt: metadata.completedAt } : {}),
  };
  return withBoundedResultManifestMetadata(baseMetadata, result).metadata;
}

type Base64VideoFileHandle = {
  write: (
    buffer: Uint8Array,
    offset?: number,
    length?: number,
    position?: number | null,
  ) => Promise<{ bytesWritten: number }>;
  close: () => Promise<void>;
};

export type Base64VideoWriterDependencies = {
  openFile?: (
    destinationPath: string,
    flags: "wx",
  ) => Promise<Base64VideoFileHandle>;
};

async function writeFully(
  handle: Base64VideoFileHandle,
  buffer: Uint8Array,
): Promise<void> {
  let written = 0;
  while (written < buffer.byteLength) {
    const { bytesWritten } = await handle.write(
      buffer,
      written,
      buffer.byteLength - written,
      null,
    );
    if (
      !Number.isInteger(bytesWritten) ||
      bytesWritten <= 0 ||
      bytesWritten > buffer.byteLength - written
    ) {
      throw new Error("Google video file write made no progress");
    }
    written += bytesWritten;
  }
}

export async function writeBase64VideoToFile(
  base64: string,
  destinationPath: string,
  maxBytes = MAX_GENERATED_VIDEO_BYTES,
  dependencies: Base64VideoWriterDependencies = {},
): Promise<{ fileSize: number; sha256: string }> {
  const maxEncodedBytes = Math.ceil(maxBytes / 3) * 4 + 4;
  if (base64.length > maxEncodedBytes + 4_096) {
    throw new Error("Google video exceeds the encoded size limit");
  }
  const normalized = base64.replace(/\s+/g, "");
  if (
    !normalized ||
    normalized.length > maxEncodedBytes ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)
  ) {
    throw new Error(
      "Google video bytes are empty, invalid, or exceed the size limit",
    );
  }
  const handle = await (dependencies.openFile ?? open)(destinationPath, "wx");
  const hash = createHash("sha256");
  let fileSize = 0;
  try {
    let offset = 0;
    while (offset < normalized.length) {
      const tentativeEnd = Math.min(normalized.length, offset + 64 * 1024);
      const chunkEnd =
        tentativeEnd === normalized.length
          ? tentativeEnd
          : tentativeEnd - ((tentativeEnd - offset) % 4);
      const decoded = Buffer.from(normalized.slice(offset, chunkEnd), "base64");
      offset = chunkEnd;
      fileSize += decoded.byteLength;
      if (fileSize > maxBytes)
        throw new Error("Google video exceeds the decoded size limit");
      hash.update(decoded);
      await writeFully(handle, decoded);
    }
  } finally {
    await handle.close();
  }
  if (!fileSize) throw new Error("Google video result is empty");
  return { fileSize, sha256: hash.digest("hex") };
}

async function defaultWriteProviderResult(params: {
  result: ProviderVideoResult;
  destinationPath: string;
  signal?: AbortSignal;
}): Promise<{ fileSize: number; sha256: string; mimeType: string }> {
  if (params.result.kind === "url") {
    return downloadProviderVideoToFile({
      url: params.result.url,
      destinationPath: params.destinationPath,
      policy: params.result.policy,
      authorization: params.result.authorization,
      requestHeaders: params.result.requestHeaders,
      signal: params.signal,
    });
  }
  const written = await writeBase64VideoToFile(
    params.result.base64,
    params.destinationPath,
  );
  return { ...written, mimeType: params.result.mimeType };
}

function providerDurationLimit(
  provider: VideoGenerationMaterializerInput["provider"],
): number {
  return provider === "happyhorse" ? 15 : 8;
}

export async function materializeVideoGenerationResult(
  input: VideoGenerationMaterializerInput,
  deps: VideoGenerationMaterializerDependencies,
): Promise<{ status: "complete"; result: MaterializedVideoResult }> {
  const identity = {
    workspaceId: input.workspaceId,
    assetId: input.assetId,
    attemptToken: input.attemptToken,
    providerRequestId: input.providerRequestId,
  };
  const current = await finalizationStep(
    {
      phase: "store",
      code: "result_state_read_failed",
      providerCode: null,
      message: "Generated video state could not be read",
      retryable: true,
    },
    () => deps.getAsset(identity),
  );
  if (!current)
    throw new VideoGenerationFinalizationError({
      phase: "store",
      code: "result_asset_unavailable",
      providerCode: null,
      message: "Generated video state is unavailable",
      retryable: false,
    });
  if (current.status === "complete" && current.generationResult) {
    return { status: "complete", result: current.generationResult };
  }

  const bucket = deps.bucketName || getGcsCreativeAssetsBucketName();
  const objectPath = createGcsCreativeAssetPath({
    workspaceId: input.workspaceId,
    assetId: input.assetId,
    kind: "video",
    fileName: "generated-video.mp4",
  });
  const sourceInput = recoverySourceInput(input);
  const sourcePath = sourceInput
    ? createGcsCreativeAssetPath({
        workspaceId: input.workspaceId,
        assetId: sourceInput.assetId,
        kind: "video",
        fileName: "generated-video.mp4",
      })
    : null;
  const inspectStoredObject = (path = objectPath) =>
    finalizationStep(
      {
        phase: "store" as const,
        code: "result_store_read_failed",
        providerCode: null,
        message: "Generated video storage could not be inspected",
        retryable: true,
      },
      () =>
        deps.statObject({
          bucket,
          path,
          workspaceId: input.workspaceId,
        }),
    );
  const deleteStoredObject = (
    path: string,
    object: StoredObject,
    message: string,
  ) => {
    if (!object.generation || !object.metageneration) {
      throw new VideoGenerationFinalizationError({
        phase: "store",
        code: "storage_object_conflict",
        providerCode: null,
        message,
        retryable: false,
      });
    }
    return finalizationStep(
      {
        phase: "store" as const,
        code: "result_store_cleanup_failed",
        providerCode: null,
        message: "Generated video storage could not be cleaned up",
        retryable: true,
      },
      () =>
        deps.deleteObject({
          bucket,
          path,
          workspaceId: input.workspaceId,
          ifGenerationMatch: object.generation!,
          ifMetagenerationMatch: object.metageneration!,
        }),
    );
  };
  const cleanupRecoverySource = async (
    destination: StoredObject | null,
  ): Promise<void> => {
    if (!sourceInput || !sourcePath || !input.recoverySource) return;
    const clearSourceReference = () =>
      finalizationStep(
        {
          phase: "store" as const,
          code: "recovery_source_reference_cleanup_failed",
          providerCode: null,
          message: "Recovered video source reference could not be cleared",
          retryable: true,
        },
        () =>
          deps.clearStagedAsset({
            expected: {
              workspaceId: sourceInput.workspaceId,
              assetId: sourceInput.assetId,
              attemptToken: sourceInput.attemptToken,
              providerRequestId: sourceInput.providerRequestId,
            },
            storage: { bucket, path: sourcePath },
          }),
      );
    const lineage = destination
      ? recoveryLineage(destination, input.recoverySource)
      : ({ kind: "none" } as const);
    if (lineage.kind === "conflict") {
      throw new VideoGenerationFinalizationError({
        phase: "store",
        code: "recovery_source_conflict",
        providerCode: null,
        message: "Stored video recovery lineage does not match this attempt",
        retryable: false,
      });
    }
    const source = await inspectStoredObject(sourcePath);
    if (!source.exists) {
      await clearSourceReference();
      return;
    }
    const ownership = objectIdentity(source, sourceInput);
    if (lineage.kind === "matching") {
      if (
        ownership !== "matching" ||
        source.generation !== lineage.generation ||
        source.metageneration !== lineage.metageneration
      ) {
        throw new VideoGenerationFinalizationError({
          phase: "store",
          code: "recovery_source_conflict",
          providerCode: null,
          message: "Stored video recovery source changed during recovery",
          retryable: false,
        });
      }
    } else if (ownership === "conflict") {
      return;
    }
    await deleteStoredObject(
      sourcePath,
      source,
      "storage_object_conflict: recovery source has no safe version",
    );
    await clearSourceReference();
  };
  const stageStoredResult = async (
    result: MaterializedVideoResult,
  ): Promise<void> => {
    const staged = await finalizationStep(
      {
        phase: "store",
        code: "result_stage_failed",
        providerCode: null,
        message: "Generated video storage reference could not be staged",
        retryable: true,
      },
      () =>
        deps.stageAsset({
          expected: identity,
          storage: {
            storageProvider: "gcs",
            url: `gs://${bucket}/${objectPath}`,
            bucket,
            path: objectPath,
            mimeType: result.mimeType,
            fileName: "generated-video.mp4",
            fileSize: result.fileSize,
          },
        }),
    );
    if (!staged.matched) {
      throw new VideoGenerationFinalizationError({
        phase: "store",
        code: "result_stage_conflict",
        providerCode: null,
        message: "Generated video storage identity changed before staging",
        retryable: true,
      });
    }
  };

  if (current.status === "nsfw") {
    const terminalObject = await inspectStoredObject();
    if (
      terminalObject.exists &&
      objectIdentity(terminalObject, input) !== "conflict"
    ) {
      await deleteStoredObject(
        objectPath,
        terminalObject,
        "storage_object_conflict: NSFW video has no safe version",
      );
    }
    await cleanupRecoverySource(null);
    throw new Error("Video generation is already terminal: nsfw");
  }
  if (current.status === "failed") {
    throw new Error("Video generation is already terminal: failed");
  }

  let observed = await inspectStoredObject();
  if (!observed.exists && sourceInput && sourcePath && input.recoverySource) {
    const source = await inspectStoredObject(sourcePath);
    if (source.exists && objectIdentity(source, sourceInput) === "matching") {
      if (!source.generation || !source.metageneration) {
        throw new VideoGenerationFinalizationError({
          phase: "store",
          code: "recovery_source_version_unavailable",
          providerCode: null,
          message: "Stored video recovery source has no safe version",
          retryable: true,
        });
      }
      await finalizationStep(
        {
          phase: "store",
          code: "recovery_source_copy_failed",
          providerCode: null,
          message: "Stored video result could not be recovered",
          retryable: true,
        },
        () =>
          deps.copyObject({
            bucket,
            sourcePath,
            sourceGeneration: source.generation!,
            sourceMetageneration: source.metageneration!,
            destinationPath: objectPath,
            workspaceId: input.workspaceId,
            mimeType: parseStoredResult(source)!.mimeType,
            customMetadata: copiedResultMetadata(
              input,
              input.recoverySource!,
              source,
            ),
          }),
      );
      observed = await inspectStoredObject();
      if (
        !observed.exists ||
        objectIdentity(observed, input) !== "matching" ||
        recoveryLineage(observed, input.recoverySource).kind !== "matching"
      ) {
        throw new VideoGenerationFinalizationError({
          phase: "store",
          code: "recovery_copy_verification_failed",
          providerCode: null,
          message: "Recovered video copy did not satisfy its identity contract",
          retryable: false,
        });
      }
    }
  }
  if (observed.exists) {
    const ownership = objectIdentity(observed, input);
    if (ownership === "conflict")
      throw new VideoGenerationFinalizationError({
        phase: "store",
        code: "storage_object_conflict",
        providerCode: null,
        message:
          "storage_object_conflict: generated video belongs to another attempt",
        retryable: false,
      });
    if (ownership === "matching") {
      const storedResult = parseStoredResult(observed)!;
      await stageStoredResult(storedResult);
      await cleanupRecoverySource(observed);
      const completed = await finalizationStep(
        {
          phase: "store",
          code: "result_store_failed",
          providerCode: null,
          message: "Generated video could not be stored",
          retryable: true,
        },
        () =>
          deps.completeAsset({
            expected: {
              ...identity,
              allowedStatuses: ["queued", "in_progress"],
            },
            storage: {
              storageProvider: "gcs",
              url: `gs://${bucket}/${objectPath}`,
              bucket,
              path: objectPath,
              mimeType: storedResult.mimeType,
              fileName: "generated-video.mp4",
              fileSize: storedResult.fileSize,
            },
            result: storedResult,
          }),
      );
      if (completed.matched)
        return { status: "complete", result: storedResult };
      const winner = await deps.getAsset(identity);
      if (
        winner?.status === "complete" &&
        winner.generationResult?.sha256 === storedResult.sha256
      ) {
        return { status: "complete", result: winner.generationResult };
      }
      if (winner?.status === "failed") {
        throw new Error("Video generation completion race was lost");
      }
      if (!observed.generation || !observed.metageneration)
        throw new VideoGenerationFinalizationError({
          phase: "store",
          code: "storage_object_conflict",
          providerCode: null,
          message:
            "storage_object_conflict: recovered video has no safe version",
          retryable: false,
        });
      await deps.deleteObject({
        bucket,
        path: objectPath,
        workspaceId: input.workspaceId,
        ifGenerationMatch: observed.generation,
        ifMetagenerationMatch: observed.metageneration,
      });
      throw new Error("Video generation completion race was lost");
    }
    if (!observed.generation || !observed.metageneration)
      throw new VideoGenerationFinalizationError({
        phase: "store",
        code: "storage_object_conflict",
        providerCode: null,
        message:
          "storage_object_conflict: incomplete video has no safe version",
        retryable: false,
      });
    await deps.deleteObject({
      bucket,
      path: objectPath,
      workspaceId: input.workspaceId,
      ifGenerationMatch: observed.generation,
      ifMetagenerationMatch: observed.metageneration,
    });
  }

  const tempDirectory = await mkdtemp(
    path.join(tmpdir(), "airi-video-generation-"),
  );
  const localPath = path.join(tempDirectory, "generated-video.mp4");
  let uploaded: UploadResult | null = null;
  try {
    const providerResult = await finalizationStep(
      {
        phase: "download",
        code: "provider_result_load_failed",
        providerCode: null,
        message: "Provider video result could not be loaded",
        retryable: true,
      },
      () => deps.loadProviderResult(input),
    );
    const downloaded = await finalizationStep(
      {
        phase: "download",
        code: "result_download_failed",
        providerCode: null,
        message: "Generated video could not be downloaded safely",
        retryable: true,
      },
      () =>
        (deps.writeProviderResult ?? defaultWriteProviderResult)({
          result: providerResult,
          destinationPath: localPath,
          signal: input.signal,
        }),
    );
    const probe = await finalizationStep(
      {
        phase: "probe",
        code: "result_probe_failed",
        providerCode: null,
        message: "Generated video could not be verified",
        retryable: true,
      },
      () => (deps.probeVideoFile ?? probeVideoFile)(localPath),
    );
    const durationLimit = Math.min(30, providerDurationLimit(input.provider));
    if (probe.durationSeconds > durationLimit) {
      throw new VideoGenerationFinalizationError({
        phase: "probe",
        code: "result_duration_invalid",
        providerCode: null,
        message: `Generated video duration exceeds the ${durationLimit}s provider/platform limit`,
        retryable: false,
      });
    }

    const warnings: VideoGenerationResultWarning[] = [];
    if (
      Math.abs(probe.durationSeconds - input.requestedDurationSeconds) >
      Math.max(1, input.requestedDurationSeconds * 0.25)
    ) {
      warnings.push({
        code: "duration_mismatch",
        message: "Generated video duration differs from the requested duration",
      });
    }
    if (downloaded.mimeType !== probe.mimeType) {
      warnings.push({
        code: "mime_type_normalized",
        message: "Generated video MIME type was normalized from probed media",
      });
    }
    const completedAt = new Date();
    const probedResult: MaterializedVideoResult = {
      ...probe,
      fileSize: downloaded.fileSize,
      sha256: downloaded.sha256,
      providerUsage: boundedUsage(providerResult.providerUsage),
      warnings: warnings.slice(0, 16),
      startedAt: input.startedAt ?? null,
      completedAt,
    };
    const baseMetadata = {
      ...identityMetadata(input),
      sha256: probedResult.sha256,
      width: String(probedResult.width),
      height: String(probedResult.height),
      durationSeconds: String(probedResult.durationSeconds),
      mimeType: probedResult.mimeType,
      fileSize: String(probedResult.fileSize),
      ...(probedResult.startedAt
        ? { startedAt: probedResult.startedAt.toISOString() }
        : {}),
      completedAt: probedResult.completedAt.toISOString(),
    };
    const manifest = withBoundedResultManifestMetadata(
      baseMetadata,
      probedResult,
    );
    const result: MaterializedVideoResult = {
      ...probedResult,
      providerUsage: manifest.providerUsage,
      warnings: manifest.warnings,
    };
    const metadata = manifest.metadata;
    uploaded = await finalizationStep(
      {
        phase: "store",
        code: "result_store_failed",
        providerCode: null,
        message: "Generated video could not be stored",
        retryable: true,
      },
      () =>
        deps.uploadFile({
          bucket,
          workspaceId: input.workspaceId,
          assetId: input.assetId,
          kind: "video",
          localPath,
          mimeType: probe.mimeType,
          fileName: "generated-video.mp4",
          path: objectPath,
          customMetadata: metadata,
          preconditionOpts: { ifGenerationMatch: 0 },
        }),
    );
    if (!uploaded.generation || !uploaded.metageneration) {
      throw new Error("GCS upload did not return generation preconditions");
    }
    await stageStoredResult(result);
    await cleanupRecoverySource(null);
    const completed = await finalizationStep(
      {
        phase: "store",
        code: "result_store_failed",
        providerCode: null,
        message: "Generated video could not be stored",
        retryable: true,
      },
      () =>
        deps.completeAsset({
          expected: {
            ...identity,
            allowedStatuses: ["queued", "in_progress"],
          },
          storage: {
            storageProvider: "gcs",
            url: uploaded!.url,
            bucket: uploaded!.bucket,
            path: uploaded!.path,
            mimeType: result.mimeType,
            fileName: "generated-video.mp4",
            fileSize: result.fileSize,
          },
          result,
        }),
    );
    if (completed.matched) return { status: "complete", result };
    const winner = await deps.getAsset(identity);
    if (
      winner?.status === "complete" &&
      winner.generationResult?.sha256 === result.sha256
    ) {
      return { status: "complete", result: winner.generationResult };
    }
    if (winner?.status === "failed") {
      throw new Error("Video generation completion race was lost");
    }
    await deps.deleteObject({
      bucket: uploaded.bucket,
      path: uploaded.path,
      workspaceId: input.workspaceId,
      ifGenerationMatch: uploaded.generation,
      ifMetagenerationMatch: uploaded.metageneration,
    });
    uploaded = null;
    throw new Error("Video generation completion race was lost");
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
}
