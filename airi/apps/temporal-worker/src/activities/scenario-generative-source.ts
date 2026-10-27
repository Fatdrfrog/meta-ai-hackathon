import { createHash } from "node:crypto";
import {
  canonicalGcsUri,
  matchesGcsObjectUri,
} from "@icecore/airi-runtime/media-api";

export type ScenarioGenerativeSourceInput = {
  workspaceId: string;
  conversationId: string;
  inputMessageId: string;
  whatsappMediaId: string;
  declaredMimeType: string | null;
  fileName: string | null;
};

type StoredObject = {
  exists: boolean;
  fileSize?: number | null;
  mimeType?: string | null;
  customMetadata?: Record<string, string>;
};

type SourceAsset = Record<string, unknown> | null;

export type ScenarioGenerativeSourceDependencies = {
  allowedImageMimeTypes: readonly string[];
  maxImageBytes: number;
  bucket: string;
  createPath: (input: {
    workspaceId: string;
    assetId: string;
    kind: "image";
    fileName: string;
  }) => string;
  findAsset: (assetId: string) => Promise<SourceAsset>;
  upsertPendingAsset: (asset: Record<string, unknown>) => Promise<unknown>;
  completeAsset: (
    assetId: string,
    update: Record<string, unknown>,
  ) => Promise<unknown | { matched: boolean }>;
  downloadOwnedWhatsAppMedia: (input: {
    conversationId: string;
    workspaceId: string;
    inputMessageId: string;
    mediaId: string;
    allowedMimeTypes: readonly string[];
    maxBytes: number;
  }) => Promise<{
    buffer: Buffer;
    contentType: string;
    sizeBytes: number;
    sha256: string;
  }>;
  upload: (input: {
    bucket: string;
    workspaceId: string;
    assetId: string;
    kind: "image";
    buffer: Buffer;
    mimeType: string;
    fileName: string;
    customMetadata: Record<string, string>;
    preconditionOpts: { ifGenerationMatch: 0 };
  }) => Promise<{
    storageProvider: "gcs";
    url: string;
    bucket: string;
    path: string;
    mimeType: string;
    fileName: string;
    fileSize: number;
  }>;
  stat: (input: {
    bucket: string;
    path: string;
    workspaceId: string;
  }) => Promise<StoredObject>;
};

const SOURCE_VERSION = 1;
const SOURCE_DOMAIN = "airi.scenario-generative-whatsapp-source.v1\0";

function required(value: unknown, field: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized)
    throw new Error(`Scenario generative source ${field} is required`);
  return normalized;
}

function lengthPrefixed(value: string): Buffer {
  const bytes = Buffer.from(value, "utf8");
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(bytes.byteLength, 0);
  return Buffer.concat([length, bytes]);
}

function normalizedMimeType(value: string): string {
  return value.split(";", 1)[0]!.trim().toLowerCase();
}

function extensionForMimeType(mimeType: string): string {
  if (mimeType === "image/png") return "png";
  if (mimeType === "image/webp") return "webp";
  return "jpg";
}

export function buildScenarioGenerativeSourceIdentity(
  input: ScenarioGenerativeSourceInput,
): {
  assetId: string;
  provenanceDigest: string;
} {
  const fields = [
    required(input.workspaceId, "workspaceId"),
    required(input.conversationId, "conversationId"),
    required(input.inputMessageId, "inputMessageId"),
    required(input.whatsappMediaId, "whatsappMediaId"),
  ];
  const provenanceDigest = createHash("sha256")
    .update(SOURCE_DOMAIN, "utf8")
    .update(Buffer.concat(fields.map(lengthPrefixed)))
    .digest("hex");
  return { assetId: provenanceDigest.slice(0, 24), provenanceDigest };
}

function sourceMetadata(
  input: ScenarioGenerativeSourceInput & { declaredMimeType: string },
  identity: { assetId: string; provenanceDigest: string },
  contentSha256: string,
): Record<string, string> {
  return {
    workspaceId: input.workspaceId,
    assetId: identity.assetId,
    kind: "image",
    scenarioGenerativeSourceVersion: String(SOURCE_VERSION),
    scenarioGenerativeSourceDigest: identity.provenanceDigest,
    scenarioGenerativeSourceWorkspaceId: input.workspaceId,
    scenarioGenerativeSourceConversationId: input.conversationId,
    scenarioGenerativeSourceInputMessageId: input.inputMessageId,
    scenarioGenerativeSourceWhatsAppMediaId: input.whatsappMediaId,
    scenarioGenerativeSourceDeclaredMimeType: input.declaredMimeType,
    scenarioGenerativeContentSha256: contentSha256,
  };
}

function assertObjectMatches(
  input: ScenarioGenerativeSourceInput & { declaredMimeType: string },
  identity: { assetId: string; provenanceDigest: string },
  object: StoredObject,
  maxImageBytes: number,
  expectedContentSha256?: string,
): string {
  const metadata = object.customMetadata || {};
  const expected = sourceMetadata(
    input,
    identity,
    expectedContentSha256 || metadata.scenarioGenerativeContentSha256 || "",
  );
  const identityKeys = Object.keys(expected).filter(
    (key) => key !== "scenarioGenerativeContentSha256",
  );
  if (
    !object.exists ||
    identityKeys.some((key) => metadata[key] !== expected[key])
  ) {
    throw new Error("Scenario generative source object provenance conflict");
  }
  const contentSha256 = metadata.scenarioGenerativeContentSha256 || "";
  if (
    !/^[a-f0-9]{64}$/.test(contentSha256) ||
    (expectedContentSha256 && contentSha256 !== expectedContentSha256)
  ) {
    throw new Error(
      "Scenario generative source object content metadata conflict",
    );
  }
  const fileSize = object.fileSize;
  if (typeof fileSize === "number" && fileSize > maxImageBytes) {
    throw new Error("Scenario generative source object exceeds the size limit");
  }
  if (
    typeof fileSize !== "number" ||
    !Number.isSafeInteger(fileSize) ||
    fileSize <= 0 ||
    fileSize > maxImageBytes ||
    object.mimeType?.trim().toLowerCase() !== input.declaredMimeType
  ) {
    throw new Error(
      "Scenario generative source object storage metadata conflict",
    );
  }
  return contentSha256;
}

function assertAssetMatches(
  asset: SourceAsset,
  input: ScenarioGenerativeSourceInput & { declaredMimeType: string },
  identity: { assetId: string; provenanceDigest: string },
  contentSha256?: string,
): void {
  if (!asset) return;
  const sourceMedia = asset.sourceMedia as
    | Record<string, unknown>
    | null
    | undefined;
  if (
    String(asset._id) !== identity.assetId ||
    asset.workspaceId !== input.workspaceId ||
    asset.kind !== "image" ||
    asset.source !== "uploaded" ||
    !sourceMedia ||
    sourceMedia.version !== SOURCE_VERSION ||
    sourceMedia.provenanceDigest !== identity.provenanceDigest ||
    sourceMedia.workspaceId !== input.workspaceId ||
    sourceMedia.conversationId !== input.conversationId ||
    sourceMedia.inputMessageId !== input.inputMessageId ||
    sourceMedia.whatsappMediaId !== input.whatsappMediaId ||
    (sourceMedia.declaredMimeType !== input.declaredMimeType &&
      !(
        asset.status === "in_progress" &&
        sourceMedia.declaredMimeType === null &&
        sourceMedia.contentSha256 === null
      )) ||
    (contentSha256 &&
      sourceMedia.contentSha256 &&
      sourceMedia.contentSha256 !== contentSha256)
  ) {
    throw new Error("Scenario generative source asset provenance conflict");
  }
}

function assertAssetClaim(
  asset: SourceAsset,
  input: ScenarioGenerativeSourceInput,
  identity: { assetId: string; provenanceDigest: string },
): asserts asset is Record<string, unknown> {
  if (!asset) throw new Error("Scenario generative source claim disappeared");
  const sourceMedia = asset.sourceMedia as Record<string, unknown> | null;
  if (
    String(asset._id) !== identity.assetId ||
    asset.workspaceId !== input.workspaceId ||
    asset.kind !== "image" ||
    asset.source !== "uploaded" ||
    (asset.status !== "in_progress" && asset.status !== "complete") ||
    !sourceMedia ||
    sourceMedia.version !== SOURCE_VERSION ||
    sourceMedia.provenanceDigest !== identity.provenanceDigest ||
    sourceMedia.workspaceId !== input.workspaceId ||
    sourceMedia.conversationId !== input.conversationId ||
    sourceMedia.inputMessageId !== input.inputMessageId ||
    sourceMedia.whatsappMediaId !== input.whatsappMediaId ||
    (input.declaredMimeType &&
      sourceMedia.declaredMimeType !== null &&
      sourceMedia.declaredMimeType !== input.declaredMimeType)
  ) {
    throw new Error("Scenario generative source asset provenance conflict");
  }
}

async function completeClaimedAsset(
  deps: ScenarioGenerativeSourceDependencies,
  assetId: string,
  update: Record<string, unknown>,
): Promise<void> {
  const result = await deps.completeAsset(assetId, update);
  if (
    result &&
    typeof result === "object" &&
    "matched" in result &&
    result.matched === false
  ) {
    const winner = await deps.findAsset(assetId);
    const expectedSource = update.sourceMedia as Record<string, unknown>;
    const actualSource = winner?.sourceMedia as
      | Record<string, unknown>
      | undefined;
    if (
      winner?.status === "complete" &&
      winner.workspaceId === update.workspaceId &&
      winner.kind === update.kind &&
      winner.source === update.source &&
      winner.storageProvider === update.storageProvider &&
      typeof update.bucket === "string" &&
      typeof update.path === "string" &&
      matchesGcsObjectUri(winner.url, update.bucket, update.path) &&
      winner.bucket === update.bucket &&
      winner.path === update.path &&
      winner.mimeType === update.mimeType &&
      winner.fileName === update.fileName &&
      winner.fileSize === update.fileSize &&
      actualSource?.version === expectedSource.version &&
      actualSource?.provenanceDigest === expectedSource.provenanceDigest &&
      actualSource?.workspaceId === expectedSource.workspaceId &&
      actualSource?.conversationId === expectedSource.conversationId &&
      actualSource?.inputMessageId === expectedSource.inputMessageId &&
      actualSource?.whatsappMediaId === expectedSource.whatsappMediaId &&
      actualSource?.declaredMimeType === expectedSource.declaredMimeType &&
      actualSource?.contentSha256 === expectedSource.contentSha256
    )
      return;
    throw new Error("Scenario generative source completion claim was lost");
  }
}

function isAlreadyExists(error: unknown): boolean {
  const code =
    typeof error === "object" && error
      ? (error as { code?: unknown }).code
      : null;
  return code === 409 || code === 412 || code === "409" || code === "412";
}

function completeUpdate(
  input: ScenarioGenerativeSourceInput & { declaredMimeType: string },
  identity: { assetId: string; provenanceDigest: string },
  stored: {
    storageProvider: "gcs";
    url: string;
    bucket: string;
    path: string;
    mimeType: string;
    fileName: string;
    fileSize: number;
  },
  contentSha256: string,
): Record<string, unknown> {
  return {
    workspaceId: input.workspaceId,
    kind: "image",
    source: "uploaded",
    status: "complete",
    ...stored,
    sourceMedia: {
      version: SOURCE_VERSION,
      provenanceDigest: identity.provenanceDigest,
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      inputMessageId: input.inputMessageId,
      whatsappMediaId: input.whatsappMediaId,
      declaredMimeType: input.declaredMimeType,
      contentSha256,
    },
    error: null,
    completedAt: new Date(),
    updatedAt: new Date(),
  };
}

export async function importScenarioGenerativeWhatsAppSource(
  input: ScenarioGenerativeSourceInput,
  deps: ScenarioGenerativeSourceDependencies,
): Promise<{ assetId: string; mimeType: string; fileSize: number }> {
  const normalizedInput = {
    ...input,
    workspaceId: required(input.workspaceId, "workspaceId"),
    conversationId: required(input.conversationId, "conversationId"),
    inputMessageId: required(input.inputMessageId, "inputMessageId"),
    whatsappMediaId: required(input.whatsappMediaId, "whatsappMediaId"),
    declaredMimeType:
      typeof input.declaredMimeType === "string" &&
      input.declaredMimeType.trim()
        ? normalizedMimeType(input.declaredMimeType)
        : null,
  };
  if (
    normalizedInput.declaredMimeType &&
    !deps.allowedImageMimeTypes.includes(normalizedInput.declaredMimeType)
  ) {
    throw new Error("Scenario generative source MIME type is not allowed");
  }
  const identity = buildScenarioGenerativeSourceIdentity(normalizedInput);
  let existingAsset = await deps.findAsset(identity.assetId);
  if (existingAsset) assertAssetClaim(existingAsset, normalizedInput, identity);
  const bucket = required(deps.bucket, "bucket");
  const candidateMimeTypes = normalizedInput.declaredMimeType
    ? [normalizedInput.declaredMimeType]
    : Array.from(
        new Set(
          deps.allowedImageMimeTypes.map((mimeType) =>
            normalizedMimeType(mimeType),
          ),
        ),
      );
  const candidates = await Promise.all(
    candidateMimeTypes.map(async (mimeType) => {
      const fileName = `${identity.assetId}.${extensionForMimeType(mimeType)}`;
      const path = deps.createPath({
        workspaceId: normalizedInput.workspaceId,
        assetId: identity.assetId,
        kind: "image",
        fileName,
      });
      return {
        mimeType,
        fileName,
        path,
        object: await deps.stat({
          bucket,
          path,
          workspaceId: normalizedInput.workspaceId,
        }),
      };
    }),
  );
  const existingObjects = candidates.filter(
    (candidate) => candidate.object.exists,
  );
  if (existingObjects.length > 1) {
    throw new Error(
      "Scenario generative source has multiple canonical objects",
    );
  }
  const existingObject = existingObjects[0];
  let object = existingObject?.object || { exists: false };
  if (object.exists) {
    const declaredMimeType = normalizedMimeType(
      object.customMetadata?.scenarioGenerativeSourceDeclaredMimeType ||
        object.mimeType ||
        "",
    );
    if (
      !deps.allowedImageMimeTypes.includes(declaredMimeType) ||
      (normalizedInput.declaredMimeType &&
        normalizedInput.declaredMimeType !== declaredMimeType)
    ) {
      throw new Error("Scenario generative source object MIME type conflict");
    }
    const resolvedInput = { ...normalizedInput, declaredMimeType };
    const fileName = `${identity.assetId}.${extensionForMimeType(declaredMimeType)}`;
    const canonicalPath = deps.createPath({
      workspaceId: resolvedInput.workspaceId,
      assetId: identity.assetId,
      kind: "image",
      fileName,
    });
    if (
      existingObject?.mimeType !== declaredMimeType ||
      existingObject.fileName !== fileName ||
      existingObject.path !== canonicalPath
    ) {
      throw new Error(
        "Scenario generative source object canonical path conflict",
      );
    }
    const path = canonicalPath;
    const contentSha256 = assertObjectMatches(
      resolvedInput,
      identity,
      object,
      deps.maxImageBytes,
    );
    if (!existingAsset) {
      await deps.upsertPendingAsset({
        _id: identity.assetId,
        workspaceId: resolvedInput.workspaceId,
        kind: "image",
        source: "uploaded",
        status: "in_progress",
        sourceMedia: {
          version: SOURCE_VERSION,
          provenanceDigest: identity.provenanceDigest,
          workspaceId: resolvedInput.workspaceId,
          conversationId: resolvedInput.conversationId,
          inputMessageId: resolvedInput.inputMessageId,
          whatsappMediaId: resolvedInput.whatsappMediaId,
          declaredMimeType: resolvedInput.declaredMimeType,
          contentSha256: null,
        },
      });
      existingAsset = await deps.findAsset(identity.assetId);
      assertAssetClaim(existingAsset, resolvedInput, identity);
    }
    assertAssetMatches(existingAsset, resolvedInput, identity, contentSha256);
    if (
      existingAsset?.status === "complete" &&
      (existingAsset.storageProvider !== "gcs" ||
        !matchesGcsObjectUri(existingAsset.url, bucket, path) ||
        existingAsset.bucket !== bucket ||
        existingAsset.path !== path ||
        existingAsset.mimeType !== declaredMimeType ||
        existingAsset.fileName !== fileName ||
        existingAsset.fileSize !== object.fileSize ||
        (existingAsset.sourceMedia as Record<string, unknown>).contentSha256 !==
          contentSha256)
    ) {
      throw new Error(
        "Scenario generative source asset storage metadata conflict",
      );
    }
    if (!existingAsset || existingAsset.status !== "complete") {
      await completeClaimedAsset(
        deps,
        identity.assetId,
        completeUpdate(
          resolvedInput,
          identity,
          {
            storageProvider: "gcs",
            url: canonicalGcsUri(bucket, path),
            bucket,
            path,
            mimeType: declaredMimeType,
            fileName,
            fileSize: object.fileSize!,
          },
          contentSha256,
        ),
      );
    }
    return {
      assetId: identity.assetId,
      mimeType: declaredMimeType,
      fileSize: object.fileSize!,
    };
  }

  if (!existingAsset) {
    await deps.upsertPendingAsset({
      _id: identity.assetId,
      workspaceId: normalizedInput.workspaceId,
      kind: "image",
      source: "uploaded",
      status: "in_progress",
      sourceMedia: {
        version: SOURCE_VERSION,
        provenanceDigest: identity.provenanceDigest,
        workspaceId: normalizedInput.workspaceId,
        conversationId: normalizedInput.conversationId,
        inputMessageId: normalizedInput.inputMessageId,
        whatsappMediaId: normalizedInput.whatsappMediaId,
        declaredMimeType: normalizedInput.declaredMimeType,
        contentSha256: null,
      },
    });
    existingAsset = await deps.findAsset(identity.assetId);
    assertAssetClaim(existingAsset, normalizedInput, identity);
  }
  const downloaded = await deps.downloadOwnedWhatsAppMedia({
    conversationId: normalizedInput.conversationId,
    workspaceId: normalizedInput.workspaceId,
    inputMessageId: normalizedInput.inputMessageId,
    mediaId: normalizedInput.whatsappMediaId,
    allowedMimeTypes: deps.allowedImageMimeTypes,
    maxBytes: deps.maxImageBytes,
  });
  const declaredMimeType = normalizedMimeType(downloaded.contentType);
  if (
    !deps.allowedImageMimeTypes.includes(declaredMimeType) ||
    (normalizedInput.declaredMimeType &&
      downloaded.contentType !== normalizedInput.declaredMimeType) ||
    downloaded.sizeBytes !== downloaded.buffer.byteLength
  ) {
    throw new Error("Scenario generative source download metadata conflict");
  }
  const resolvedInput = { ...normalizedInput, declaredMimeType };
  const fileName = `${identity.assetId}.${extensionForMimeType(declaredMimeType)}`;
  const path = deps.createPath({
    workspaceId: resolvedInput.workspaceId,
    assetId: identity.assetId,
    kind: "image",
    fileName,
  });
  const metadata = sourceMetadata(resolvedInput, identity, downloaded.sha256);
  let stored;
  try {
    stored = await deps.upload({
      bucket,
      workspaceId: resolvedInput.workspaceId,
      assetId: identity.assetId,
      kind: "image",
      buffer: downloaded.buffer,
      mimeType: declaredMimeType,
      fileName,
      customMetadata: metadata,
      preconditionOpts: { ifGenerationMatch: 0 },
    });
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
  }
  object = await deps.stat({
    bucket,
    path,
    workspaceId: resolvedInput.workspaceId,
  });
  const contentSha256 = assertObjectMatches(
    resolvedInput,
    identity,
    object,
    deps.maxImageBytes,
    downloaded.sha256,
  );
  if (
    stored &&
    (stored.bucket !== bucket ||
      stored.storageProvider !== "gcs" ||
      stored.path !== path ||
      stored.url !== canonicalGcsUri(bucket, path) ||
      stored.mimeType !== declaredMimeType ||
      stored.fileName !== fileName ||
      stored.fileSize !== downloaded.sizeBytes)
  ) {
    throw new Error(
      "Scenario generative source upload returned a non-canonical object",
    );
  }
  if (object.fileSize !== downloaded.sizeBytes) {
    throw new Error(
      "Scenario generative source object size did not match download",
    );
  }
  const completedStorage = stored || {
    storageProvider: "gcs" as const,
    url: canonicalGcsUri(bucket, path),
    bucket,
    path,
    mimeType: declaredMimeType,
    fileName,
    fileSize: object.fileSize!,
  };
  await completeClaimedAsset(
    deps,
    identity.assetId,
    completeUpdate(resolvedInput, identity, completedStorage, contentSha256),
  );
  return {
    assetId: identity.assetId,
    mimeType: declaredMimeType,
    fileSize: object.fileSize!,
  };
}

export async function scenarioGenerativeWhatsAppSourceActivity(
  input: ScenarioGenerativeSourceInput,
): Promise<{ assetId: string; mimeType: string; fileSize: number }> {
  const [
    { default: connectDB },
    { CreativeAsset },
    mediaServer,
    gcs,
    mediaTypes,
  ] = await Promise.all([
    import("@/lib/mongoose"),
    import("@/models/creative-asset"),
    import("@/lib/media/whatsapp-media-server"),
    import("../gcs-creative-assets.js"),
    import("@icecore/whatsapp/mediaTypes"),
  ]);
  await connectDB();
  return importScenarioGenerativeWhatsAppSource(input, {
    allowedImageMimeTypes: mediaTypes.WHATSAPP_OFFICIAL_MEDIA_MIME_TYPES.image,
    maxImageBytes: mediaTypes.WHATSAPP_OFFICIAL_MEDIA_MAX_BYTES.image,
    bucket: gcs.getGcsCreativeAssetsBucketName(),
    createPath: gcs.createGcsCreativeAssetPath,
    findAsset: (assetId) => CreativeAsset.findById(assetId).lean<SourceAsset>(),
    upsertPendingAsset: (asset) =>
      CreativeAsset.updateOne(
        {
          _id: asset._id,
          workspaceId: asset.workspaceId,
          "sourceMedia.provenanceDigest": (
            asset.sourceMedia as Record<string, unknown>
          ).provenanceDigest,
          "sourceMedia.conversationId": (
            asset.sourceMedia as Record<string, unknown>
          ).conversationId,
          "sourceMedia.inputMessageId": (
            asset.sourceMedia as Record<string, unknown>
          ).inputMessageId,
          "sourceMedia.whatsappMediaId": (
            asset.sourceMedia as Record<string, unknown>
          ).whatsappMediaId,
        },
        { $setOnInsert: asset },
        { upsert: true, runValidators: true },
      ),
    completeAsset: async (assetId, update) => {
      const sourceMedia = update.sourceMedia as Record<string, unknown>;
      const result = await CreativeAsset.updateOne(
        {
          _id: assetId,
          workspaceId: update.workspaceId,
          kind: "image",
          source: "uploaded",
          status: "in_progress",
          "sourceMedia.version": SOURCE_VERSION,
          "sourceMedia.provenanceDigest": sourceMedia.provenanceDigest,
          "sourceMedia.workspaceId": sourceMedia.workspaceId,
          "sourceMedia.conversationId": sourceMedia.conversationId,
          "sourceMedia.inputMessageId": sourceMedia.inputMessageId,
          "sourceMedia.whatsappMediaId": sourceMedia.whatsappMediaId,
          "sourceMedia.declaredMimeType": {
            $in: [null, sourceMedia.declaredMimeType],
          },
          "sourceMedia.contentSha256": {
            $in: [null, sourceMedia.contentSha256],
          },
        },
        { $set: update },
        { runValidators: true },
      );
      return { matched: result.matchedCount === 1 };
    },
    downloadOwnedWhatsAppMedia: mediaServer.downloadOwnedWhatsAppMedia,
    upload: gcs.uploadGcsCreativeAssetBuffer,
    stat: gcs.statGcsCreativeAssetObject,
  });
}
