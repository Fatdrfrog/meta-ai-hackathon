import "server-only";

import {
  resolveCreativeAssetDisplayUrl,
  type LeanCreativeAsset,
} from "@/lib/higgsfield/creative-asset-serialization";
import {
  buildAiriCreativeAssetUri,
  parseAiriCreativeAssetUri,
} from "@/lib/airi-chats/creative-asset-refs";
import { sha256CanonicalJson } from "./confirmation-contract.server";
import { CreativeAsset } from "@/models/creative-asset";
import { Types } from "mongoose";
import { readNonEmptyString } from "@icecore/shared/lib/value-utils";

const META_ADS_CREATIVE_ASSET_PROJECTION =
  "_id workspaceId kind status fileName mimeType fileSize prompt url storageProvider bucket path";
const MAX_META_ADS_CREATIVE_ASSETS = 8;
const MAX_META_ADS_CREATIVE_ASSET_NAME_LENGTH = 240;
const MAX_META_ADS_CREATIVE_ASSET_MIME_TYPE_LENGTH = 128;
const MAX_META_ADS_CREATIVE_ASSET_PROMPT_LENGTH = 500;

type MetaAdsMcpCreativeAssetDocument = LeanCreativeAsset & {
  _id: unknown;
  kind: "image" | "video";
};

export type MetaAdsMcpCreativeAssetReference = {
  id: string;
  kind: "image" | "video";
  name: string;
  mimeType: string | null;
  fileSize: number | null;
  prompt: string | null;
  uri: string;
};

export type MaterializedMetaAdsMcpMutation = {
  effectiveArguments: Record<string, unknown>;
  effectiveArgumentsSha256: string;
  materializedCreativeAssetIds: string[];
};

const cleanString = (value: unknown, maxLength: number) =>
  readNonEmptyString(value, { trim: true, maxLength });

function uniqueValidAssetIds(assetIds: string[]): string[] {
  const unique = new Set<string>();
  for (const rawId of assetIds) {
    const id = rawId.trim();
    if (!id) continue;
    if (!Types.ObjectId.isValid(id)) {
      throw new Error("A Meta Ads creative asset reference is invalid");
    }
    unique.add(new Types.ObjectId(id).toHexString());
    if (unique.size > MAX_META_ADS_CREATIVE_ASSETS) {
      throw new Error(
        `Attach up to ${MAX_META_ADS_CREATIVE_ASSETS} Creative Assets to a Meta Ads action`
      );
    }
  }

  return Array.from(unique);
}

async function loadCreativeAssetDocuments(params: {
  workspaceId: string;
  assetIds: string[];
}): Promise<MetaAdsMcpCreativeAssetDocument[]> {
  const assetIds = uniqueValidAssetIds(params.assetIds);
  if (assetIds.length === 0) return [];

  const assets = await CreativeAsset.find({
    _id: { $in: assetIds },
    workspaceId: params.workspaceId,
    status: "complete",
    kind: { $in: ["image", "video"] },
  })
    .select(META_ADS_CREATIVE_ASSET_PROJECTION)
    .lean<MetaAdsMcpCreativeAssetDocument[]>();
  const byId = new Map(assets.map(asset => [String(asset._id), asset]));
  const missingId = assetIds.find(id => !byId.has(id));
  if (missingId) {
    throw new Error(
      `Creative asset ${missingId} is not available in this workspace`
    );
  }

  return assetIds.map(id => byId.get(id) as MetaAdsMcpCreativeAssetDocument);
}

export async function loadMetaAdsMcpCreativeAssetReferences(params: {
  workspaceId: string;
  assetIds: string[];
}): Promise<MetaAdsMcpCreativeAssetReference[]> {
  const assets = await loadCreativeAssetDocuments(params);
  return assets.map(asset => {
    const id = String(asset._id);
    return {
      id,
      kind: asset.kind,
      name:
        cleanString(asset.fileName, MAX_META_ADS_CREATIVE_ASSET_NAME_LENGTH) ||
        cleanString(asset.prompt, MAX_META_ADS_CREATIVE_ASSET_NAME_LENGTH) ||
        `${asset.kind} asset`,
      mimeType: cleanString(
        asset.mimeType,
        MAX_META_ADS_CREATIVE_ASSET_MIME_TYPE_LENGTH
      ),
      fileSize:
        typeof asset.fileSize === "number" && asset.fileSize >= 0
          ? asset.fileSize
          : null,
      prompt: cleanString(
        asset.prompt,
        MAX_META_ADS_CREATIVE_ASSET_PROMPT_LENGTH
      ),
      uri: buildAiriCreativeAssetUri(id),
    };
  });
}

export function buildMetaAdsMcpCreativeAssetContext(
  references: MetaAdsMcpCreativeAssetReference[]
): string {
  if (references.length === 0) return "No Creative Assets attached.";
  return [
    "ATTACHED WORKSPACE CREATIVE ASSETS:",
    JSON.stringify(references),
    "Use an asset's exact airi://creative-assets/... URI only in a URL or link field accepted by the selected tool schema. Do not use it as a Meta image hash, video id, or other provider-owned id. The server resolves the URI to a fresh HTTPS read URL immediately before execution.",
  ].join("\n");
}

function collectCreativeAssetIds(value: unknown, output: Set<string>): void {
  if (typeof value === "string") {
    const assetId = parseAiriCreativeAssetUri(value);
    if (assetId && Types.ObjectId.isValid(assetId)) {
      output.add(new Types.ObjectId(assetId).toHexString());
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach(item => collectCreativeAssetIds(item, output));
    return;
  }
  if (!value || typeof value !== "object") return;
  Object.values(value as Record<string, unknown>).forEach(item =>
    collectCreativeAssetIds(item, output)
  );
}

function replaceCreativeAssetUris(
  value: unknown,
  replacementsById: ReadonlyMap<string, unknown>
): unknown {
  if (typeof value === "string") {
    const assetId = parseAiriCreativeAssetUri(value);
    const canonicalAssetId =
      assetId && Types.ObjectId.isValid(assetId)
        ? new Types.ObjectId(assetId).toHexString()
        : null;
    return canonicalAssetId
      ? (replacementsById.get(canonicalAssetId) ?? value)
      : value;
  }
  if (Array.isArray(value)) {
    return value.map(item => replaceCreativeAssetUris(item, replacementsById));
  }
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      replaceCreativeAssetUris(item, replacementsById),
    ])
  );
}

type MetaAdsMcpCreativeMaterialization = {
  effectiveArguments: Record<string, unknown>;
  auditArguments: Record<string, unknown>;
  materializedCreativeAssetIds: string[];
};

async function materializeMetaAdsMcpCreativeAssets(params: {
  workspaceId: string;
  arguments: Record<string, unknown>;
}): Promise<MetaAdsMcpCreativeMaterialization> {
  const referencedIds = new Set<string>();
  collectCreativeAssetIds(params.arguments, referencedIds);
  const materializedCreativeAssetIds = Array.from(referencedIds).sort();
  if (materializedCreativeAssetIds.length === 0) {
    return {
      effectiveArguments: params.arguments,
      auditArguments: params.arguments,
      materializedCreativeAssetIds,
    };
  }

  const assets = await loadCreativeAssetDocuments({
    workspaceId: params.workspaceId,
    assetIds: materializedCreativeAssetIds,
  });
  const urlsById = new Map<string, string>();
  const auditFactsById = new Map<string, unknown>();
  await Promise.all(
    assets.map(async asset => {
      const id = String(asset._id);
      const url = await resolveCreativeAssetDisplayUrl(asset);
      if (!url) {
        throw new Error(
          `Creative asset ${id} does not have an accessible media URL`
        );
      }
      urlsById.set(id, url);
      auditFactsById.set(id, {
        airiCreativeAsset: {
          id,
          kind: asset.kind,
          mimeType: cleanString(
            asset.mimeType,
            MAX_META_ADS_CREATIVE_ASSET_MIME_TYPE_LENGTH
          ),
          fileSize:
            typeof asset.fileSize === "number" && asset.fileSize >= 0
              ? asset.fileSize
              : null,
          storageProvider: cleanString(asset.storageProvider, 80),
          bucket: cleanString(asset.bucket, 240),
          path: cleanString(asset.path, 1_000),
        },
      });
    })
  );

  return {
    effectiveArguments: replaceCreativeAssetUris(
      params.arguments,
      urlsById
    ) as Record<string, unknown>,
    auditArguments: replaceCreativeAssetUris(
      params.arguments,
      auditFactsById
    ) as Record<string, unknown>,
    materializedCreativeAssetIds,
  };
}

export async function materializeMetaAdsMcpCreativeAssetArguments(params: {
  workspaceId: string;
  arguments: Record<string, unknown>;
}): Promise<Record<string, unknown>> {
  const materialized = await materializeMetaAdsMcpCreativeAssets(params);
  return materialized.effectiveArguments;
}

export async function materializeMetaAdsMcpMutationArguments(params: {
  workspaceId: string;
  arguments: Record<string, unknown>;
}): Promise<MaterializedMetaAdsMcpMutation> {
  const materialized = await materializeMetaAdsMcpCreativeAssets(params);
  return {
    effectiveArguments: materialized.effectiveArguments,
    effectiveArgumentsSha256: sha256CanonicalJson(materialized.auditArguments),
    materializedCreativeAssetIds: materialized.materializedCreativeAssetIds,
  };
}
