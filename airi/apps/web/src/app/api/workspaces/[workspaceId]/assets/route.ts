import { serializeCreativeAssetsForResponse } from "@/lib/higgsfield/creative-asset-serialization";
import {
  AIRI_GREEN_SCREEN_RETRY_MODEL_IDS,
  collectGreenScreenSourceAssetIds,
} from "@/lib/creative-assets/green-screen";
import { getWorkspaceCreativeGenerationQuotas } from "@/lib/google/creative-asset-quota";
import { resolveWorkspaceGoogleCreativeCredentials } from "@/lib/google/creative-credentials";
import { syncWorkspaceGoogleCreativeAssets } from "@/lib/google/creative-asset-sync";
import { syncWorkspaceElevenLabsCreativeAssets } from "@/lib/elevenlabs/creative-asset-sync";
import { resolveWorkspaceElevenLabsGenerationAccess } from "@/lib/elevenlabs/elevenlabs-source";
import { resolveWorkspaceHiggsfieldGenerationAccess } from "@/lib/higgsfield/higgsfield-source";
import { isHiggsfieldWebhookConfigured } from "@/lib/higgsfield/higgsfield-webhook";
import connectDB from "@/lib/mongoose";
import { requireWorkspaceApiAccess } from "@/lib/supabase/workspace-api-access";
import { isTemporalConfigured } from "@/lib/temporal/higgsfield-assets";
import { CreativeAsset, type CreativeAssetKind } from "@/models/creative-asset";
import { Types } from "mongoose";
import { NextRequest, NextResponse } from "next/server";
import { parsePositiveInt } from "@/lib/api/query-params";

type Params = Promise<{ workspaceId: string }>;

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function parseKind(value: string | null): CreativeAssetKind | null {
  return value === "image" ||
    value === "video" ||
    value === "audio" ||
    value === "text"
    ? value
    : null;
}

function parseStatusAssetIds(value: string | null): string[] | null {
  if (value === null) return null;
  const ids = Array.from(
    new Set(
      value
        .split(",")
        .map(id => id.trim())
        .filter(Boolean)
    )
  );
  if (
    ids.length === 0 ||
    ids.length > 100 ||
    ids.some(id => !Types.ObjectId.isValid(id))
  ) {
    return null;
  }
  return ids;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Params }
): Promise<NextResponse> {
  try {
    const { workspaceId } = await params;
    const access = await requireWorkspaceApiAccess(workspaceId);
    if (!access.ok) return access.response;

    const url = new URL(request.url);
    const kind = parseKind(url.searchParams.get("kind"));
    const status = url.searchParams.get("status")?.trim();
    const surface = url.searchParams.get("surface");
    const isPickerSurface = surface === "picker";
    const isStatusSurface = surface === "status";
    const query: Record<string, unknown> = { workspaceId };
    const statusAssetIds = isStatusSurface
      ? parseStatusAssetIds(url.searchParams.get("ids"))
      : null;
    if (isStatusSurface && !statusAssetIds) {
      return NextResponse.json(
        { error: "Status polling requires 1-100 valid asset ids" },
        { status: 400 }
      );
    }
    if (statusAssetIds) query._id = { $in: statusAssetIds };
    if (kind) query.kind = kind;
    if (
      status === "queued" ||
      status === "in_progress" ||
      status === "complete" ||
      status === "failed" ||
      status === "nsfw"
    ) {
      query.status = status;
    }

    await connectDB();
    if (!isPickerSurface && !isStatusSurface) {
      await syncWorkspaceGoogleCreativeAssets({
        storageClient: access.supabase,
        workspaceId,
      }).catch(() => undefined);
      await syncWorkspaceElevenLabsCreativeAssets({
        supabase: access.supabase,
        storageClient: access.supabase,
        workspaceId,
      }).catch(() => undefined);
    }

    const assets = await CreativeAsset.find(query)
      .sort({ createdAt: -1 })
      .limit(
        statusAssetIds?.length ??
          parsePositiveInt(url.searchParams.get("limit"), 60, 1, 100)
      )
      .lean();
    if (isPickerSurface || isStatusSurface) {
      return NextResponse.json({
        assets: await serializeCreativeAssetsForResponse(assets),
      });
    }
    const greenScreenCandidateSourceAssetIds = assets
      .filter(
        asset =>
          asset.kind === "video" &&
          asset.status === "complete" &&
          asset.source !== "edited"
      )
      .map(asset => String(asset._id || "").trim())
      .filter(Boolean);

    const [
      higgsfieldAccess,
      quotas,
      elevenLabsAccess,
      greenScreenDerivatives,
      googleGenerationConfigured,
    ] = await Promise.all([
      resolveWorkspaceHiggsfieldGenerationAccess({
        supabase: access.supabase,
        workspaceId,
      }),
      getWorkspaceCreativeGenerationQuotas(workspaceId).catch(() => null),
      resolveWorkspaceElevenLabsGenerationAccess({
        supabase: access.supabase,
        workspaceId,
      }),
      greenScreenCandidateSourceAssetIds.length
        ? (CreativeAsset.find({
            workspaceId,
            source: "edited",
            provider: "airi",
            modelId: { $in: [...AIRI_GREEN_SCREEN_RETRY_MODEL_IDS] },
            sourceAssetId: { $in: greenScreenCandidateSourceAssetIds },
          })
            .select({
              source: 1,
              provider: 1,
              modelId: 1,
              sourceAssetId: 1,
              status: 1,
            })
            .lean() as Promise<
            Array<{
              source?: string;
              provider?: string | null;
              modelId?: string | null;
              sourceAssetId?: string | null;
              status?: string | null;
            }>
          >)
        : Promise.resolve([]),
      resolveWorkspaceGoogleCreativeCredentials({
        supabase: access.supabase,
        workspaceId,
      })
        .then(() => true)
        .catch(() => false),
    ]);
    const platformQuota = quotas?.platform ?? null;
    const higgsfieldGenerationConfigured =
      higgsfieldAccess.available &&
      higgsfieldAccess.credentialSource === "workspace_source" &&
      isHiggsfieldWebhookConfigured() &&
      isTemporalConfigured();
    const elevenLabsConfigured = Boolean(
      elevenLabsAccess.available &&
        elevenLabsAccess.credentialSource === "workspace_source" &&
        elevenLabsAccess.apiKey &&
        elevenLabsAccess.sourceId
    );
    const higgsfieldConfigured =
      higgsfieldGenerationConfigured || googleGenerationConfigured;

    return NextResponse.json({
      assets: await serializeCreativeAssetsForResponse(assets),
      greenScreenSourceAssetIds: collectGreenScreenSourceAssetIds(
        greenScreenDerivatives
      ),
      higgsfieldConfigured,
      generationProvider: higgsfieldGenerationConfigured
        ? "higgsfield"
        : googleGenerationConfigured
          ? "google"
          : null,
      elevenLabsConfigured,
      elevenLabsDisabledReason: elevenLabsConfigured
        ? null
        : elevenLabsAccess.reason || "source_required",
      freeGenerations: platformQuota,
      higgsfieldDisabledReason: higgsfieldConfigured
        ? null
        : higgsfieldAccess.reason || "source_required",
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Failed to list assets",
      },
      { status: 500 }
    );
  }
}
