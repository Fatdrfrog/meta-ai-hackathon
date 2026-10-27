import {
  resolveCreativeAssetStorageProvider,
  serializeCreativeAssetForResponse,
  type LeanCreativeAsset,
} from "@/lib/higgsfield/creative-asset-serialization";
import { deleteRemoteCreativeAssetObject } from "@/lib/google/gcp-media-api";
import { syncGoogleCreativeAsset } from "@/lib/google/creative-asset-sync";
import { syncElevenLabsCreativeAsset } from "@/lib/elevenlabs/creative-asset-sync";
import connectDB from "@/lib/mongoose";
import { requireWorkspaceApiAccess } from "@/lib/supabase/workspace-api-access";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { CreativeAsset } from "@/models/creative-asset";
import { Types } from "mongoose";
import { NextResponse } from "next/server";

type Params = Promise<{ workspaceId: string; assetId: string }>;

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Params }
): Promise<NextResponse> {
  try {
    const { workspaceId, assetId } = await params;
    const access = await requireWorkspaceApiAccess(workspaceId);
    if (!access.ok) return access.response;

    if (!Types.ObjectId.isValid(assetId)) {
      return NextResponse.json({ error: "Invalid asset id" }, { status: 400 });
    }

    await connectDB();
    const asset = (await CreativeAsset.findOne({
      _id: assetId,
      workspaceId,
    }).lean()) as LeanCreativeAsset | null;

    if (!asset) {
      return NextResponse.json({ error: "Asset not found" }, { status: 404 });
    }

    await syncGoogleCreativeAsset({
      storageClient: access.supabase,
      asset,
    }).catch(() => undefined);
    await syncElevenLabsCreativeAsset({
      supabase: access.supabase,
      storageClient: access.supabase,
      asset,
    }).catch(() => undefined);

    const refreshed = (await CreativeAsset.findOne({
      _id: assetId,
      workspaceId,
    }).lean()) as LeanCreativeAsset | null;

    return NextResponse.json({
      asset: await serializeCreativeAssetForResponse(refreshed || asset),
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Failed to load asset",
      },
      { status: 500 }
    );
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Params }
): Promise<NextResponse> {
  try {
    const { workspaceId, assetId } = await params;
    const access = await requireWorkspaceApiAccess(workspaceId);
    if (!access.ok) return access.response;

    if (!Types.ObjectId.isValid(assetId)) {
      return NextResponse.json({ error: "Invalid asset id" }, { status: 400 });
    }

    await connectDB();
    const asset = (await CreativeAsset.findOne({
      _id: assetId,
      workspaceId,
    }).lean()) as LeanCreativeAsset | null;

    if (!asset) {
      return NextResponse.json({ error: "Asset not found" }, { status: 404 });
    }

    if (asset.status === "queued" || asset.status === "in_progress") {
      return NextResponse.json(
        { error: "Generating assets cannot be deleted yet" },
        { status: 409 }
      );
    }

    if (asset.bucket && asset.path) {
      const storageProvider = resolveCreativeAssetStorageProvider(asset);
      if (storageProvider === "gcs") {
        await deleteRemoteCreativeAssetObject({
          provider: "gcs",
          bucket: asset.bucket,
          path: asset.path,
          workspaceId,
        });
      } else {
        const bucket = supabaseAdmin.storage.from(asset.bucket);
        if (typeof bucket.remove !== "function") {
          return NextResponse.json(
            { error: "Supabase storage delete is not available" },
            { status: 503 }
          );
        }

        const { error: removeError } = await bucket.remove([asset.path]);
        if (removeError) {
          return NextResponse.json(
            {
              error:
                removeError.message || "Failed to remove creative asset object",
            },
            { status: 502 }
          );
        }
      }
    }

    await CreativeAsset.deleteOne({ _id: assetId, workspaceId });

    return NextResponse.json({ success: true, assetId });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to delete asset",
      },
      { status: 500 }
    );
  }
}
