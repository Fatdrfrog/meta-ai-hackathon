import { basename } from "node:path/posix";

import { canonicalGcsUri } from "@icecore/airi-runtime/media-api";
import { readTrimmedString as cleanString } from "@icecore/shared/lib/value-utils";

import {
  uploadGcsCreativeAssetBuffer,
  statGcsCreativeAssetObject,
} from "./gcs-creative-assets.js";
import { loadTemporalWorkerEnv } from "./load-env.js";

type CreativeAssetKind = "image" | "video" | "audio" | "text";

type LegacyCreativeAsset = {
  _id?: unknown;
  workspaceId?: string | null;
  kind?: CreativeAssetKind | null;
  status?: string | null;
  storageProvider?: string | null;
  url?: string | null;
  bucket?: string | null;
  path?: string | null;
  mimeType?: string | null;
  fileName?: string | null;
  fileSize?: number | null;
};

type SupabaseStorageClient = {
  storage: {
    from: (bucket: string) => {
      download: (path: string) => PromiseLike<{
        data?: Blob | null;
        error?: { message?: string } | null;
      }>;
    };
  };
};

type MigrationStats = {
  scanned: number;
  skipped: number;
  migrated: number;
  failed: number;
};

const DEFAULT_LIMIT = 100;
const VALID_KINDS = new Set<CreativeAssetKind>([
  "image",
  "video",
  "audio",
  "text",
]);

function parseArgs(argv: string[]): {
  apply: boolean;
  limit: number;
  workspaceId: string | null;
} {
  let limit = DEFAULT_LIMIT;
  let workspaceId: string | null = null;
  let apply = false;

  for (const arg of argv) {
    if (arg === "--apply") {
      apply = true;
      continue;
    }
    if (arg.startsWith("--limit=")) {
      const parsed = Number.parseInt(arg.slice("--limit=".length), 10);
      if (Number.isFinite(parsed) && parsed > 0) limit = parsed;
      continue;
    }
    if (arg.startsWith("--workspace-id=")) {
      workspaceId = cleanString(arg.slice("--workspace-id=".length)) || null;
    }
  }

  return { apply, limit, workspaceId };
}

function assetId(asset: LegacyCreativeAsset): string {
  return String(asset._id || "");
}

function resolveKind(value: unknown): CreativeAssetKind | null {
  return VALID_KINDS.has(value as CreativeAssetKind)
    ? (value as CreativeAssetKind)
    : null;
}

function sourceFileName(asset: LegacyCreativeAsset): string {
  return (
    cleanString(asset.fileName) ||
    basename(cleanString(asset.path)) ||
    `${assetId(asset) || "creative-asset"}.bin`
  );
}

async function downloadSupabaseObject(params: {
  supabase: SupabaseStorageClient;
  bucket: string;
  path: string;
}): Promise<Buffer> {
  const { data, error } = await params.supabase.storage
    .from(params.bucket)
    .download(params.path);
  if (error) {
    throw new Error(error.message || "Supabase object download failed");
  }
  if (!data) {
    throw new Error("Supabase object download returned no data");
  }
  return Buffer.from(await data.arrayBuffer());
}

async function migrateAsset(params: {
  asset: LegacyCreativeAsset;
  apply: boolean;
  supabase: SupabaseStorageClient;
  creativeAssetModel: {
    updateOne: (
      query: Record<string, unknown>,
      update: Record<string, unknown>,
    ) => PromiseLike<{ modifiedCount?: number }>;
  };
}): Promise<"skipped" | "migrated"> {
  const id = assetId(params.asset);
  const workspaceId = cleanString(params.asset.workspaceId);
  const bucket = cleanString(params.asset.bucket);
  const path = cleanString(params.asset.path);
  const kind = resolveKind(params.asset.kind);

  if (!id || !workspaceId || !bucket || !path || !kind) {
    console.warn("Skipping creative asset with incomplete metadata", {
      id,
      workspaceId,
      bucket,
      path,
      kind: params.asset.kind,
    });
    return "skipped";
  }

  if (
    params.asset.storageProvider === "gcs" ||
    cleanString(params.asset.url).startsWith("gcs://")
  ) {
    console.info("Skipping already migrated creative asset", { id });
    return "skipped";
  }

  const fileName = sourceFileName(params.asset);
  if (!params.apply) {
    console.info("Dry-run creative asset migration", {
      id,
      workspaceId,
      kind,
      source: `${bucket}/${path}`,
      fileName,
    });
    return "skipped";
  }

  const buffer = await downloadSupabaseObject({
    supabase: params.supabase,
    bucket,
    path,
  });
  const stored = await uploadGcsCreativeAssetBuffer({
    workspaceId,
    assetId: id,
    kind,
    buffer,
    mimeType: cleanString(params.asset.mimeType) || "application/octet-stream",
    fileName,
  });
  const stat = await statGcsCreativeAssetObject({
    bucket: stored.bucket,
    path: stored.path,
    workspaceId,
  });
  if (!stat.exists || stat.fileSize !== buffer.byteLength) {
    throw new Error("Uploaded GCS object verification failed");
  }

  const result = await params.creativeAssetModel.updateOne(
    {
      _id: id,
      workspaceId,
      status: "complete",
      bucket,
      path,
      $or: [
        { storageProvider: { $exists: false } },
        { storageProvider: null },
        { storageProvider: "supabase" },
      ],
    },
    {
      $set: {
        storageProvider: "gcs",
        url: canonicalGcsUri(stored.bucket, stored.path),
        bucket: stored.bucket,
        path: stored.path,
        mimeType: stored.mimeType,
        fileName: stored.fileName,
        fileSize: stored.fileSize,
        updatedAt: new Date(),
      },
    },
  );

  if (!result.modifiedCount) {
    console.warn(
      "Skipped creative asset after upload because metadata changed",
      {
        id,
      },
    );
    return "skipped";
  }

  console.info("Migrated creative asset to GCS", {
    id,
    workspaceId,
    bucket: stored.bucket,
    path: stored.path,
  });
  return "migrated";
}

async function main(): Promise<void> {
  loadTemporalWorkerEnv();
  const args = parseArgs(process.argv.slice(2));
  const [{ default: connectDB }, { CreativeAsset }, { supabaseAdmin }] =
    await Promise.all([
      import("@/lib/mongoose"),
      import("@/models/creative-asset"),
      import("@/lib/supabase/admin"),
    ]);

  await connectDB();
  const query: Record<string, unknown> = {
    status: "complete",
    bucket: { $type: "string", $ne: "" },
    path: { $type: "string", $ne: "" },
    $or: [
      { storageProvider: { $exists: false } },
      { storageProvider: null },
      { storageProvider: "supabase" },
    ],
  };
  if (args.workspaceId) query.workspaceId = args.workspaceId;

  const assets = (await CreativeAsset.find(query)
    .sort({ createdAt: 1, _id: 1 })
    .limit(args.limit)
    .lean()) as LegacyCreativeAsset[];
  const stats: MigrationStats = {
    scanned: assets.length,
    skipped: 0,
    migrated: 0,
    failed: 0,
  };

  console.info("Starting creative asset GCS migration", {
    mode: args.apply ? "apply" : "dry-run",
    limit: args.limit,
    workspaceId: args.workspaceId,
    count: assets.length,
  });

  for (const asset of assets) {
    try {
      const result = await migrateAsset({
        asset,
        apply: args.apply,
        supabase: supabaseAdmin as unknown as SupabaseStorageClient,
        creativeAssetModel: CreativeAsset as unknown as {
          updateOne: (
            query: Record<string, unknown>,
            update: Record<string, unknown>,
          ) => PromiseLike<{ modifiedCount?: number }>;
        },
      });
      stats[result] += 1;
    } catch (error) {
      stats.failed += 1;
      console.error("Failed to migrate creative asset", {
        id: assetId(asset),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  console.info("Creative asset GCS migration finished", stats);
  if (stats.failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error("Creative asset GCS migration crashed", error);
  process.exit(1);
});
