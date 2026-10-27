import {
  serializeCreativeAssetForResponse,
  type LeanCreativeAsset,
} from "@/lib/higgsfield/creative-asset-serialization";
import { canUsePlatformGreenScreenGeneration } from "@/lib/creative-assets/green-screen-access";
import {
  AIRI_GREEN_SCREEN_MODEL_ID,
  AIRI_GREEN_SCREEN_RETRY_MODEL_IDS,
} from "@icecore/temporal";
import connectDB from "@/lib/mongoose";
import { requireWorkspaceApiAccess } from "@/lib/supabase/workspace-api-access";
import { startCreativeAssetEditWorkflow } from "@/lib/temporal/creative-asset-edits";
import { CreativeAsset } from "@/models/creative-asset";
import { queueTimelineRender } from "@/lib/creative-assets/timeline/queue";
import { timelineSchema } from "@/lib/creative-assets/timeline/schema";
import { TimelineRenderValidationError } from "@/lib/creative-assets/timeline/sources";
import { Types } from "mongoose";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { readJsonBodyOrResponse, zodErrorResponse } from "@/lib/api/json-body";
import { readTrimmedString as cleanString } from "@icecore/shared/lib/value-utils";

type Params = Promise<{ workspaceId: string; assetId: string }>;

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const editBodySchema = z.discriminatedUnion("operation", [
  z.object({
    operation: z.literal("green_screen"),
    retryAssetId: z.string().trim().optional(),
  }),
  z.object({
    operation: z.literal("timeline_render"),
    timeline: timelineSchema,
  }),
]);

function sourceAssetTitle(asset: LeanCreativeAsset, assetId: string): string {
  return cleanString(asset.fileName) || cleanString(asset.prompt) || assetId;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Failed to queue asset edit";
}

export async function POST(
  request: NextRequest,
  { params }: { params: Params }
): Promise<NextResponse> {
  try {
    const { workspaceId, assetId } = await params;
    const access = await requireWorkspaceApiAccess(workspaceId);
    if (!access.ok) return access.response;

    const bodyResult = await readJsonBodyOrResponse(request);
    if (!bodyResult.ok) return bodyResult.response;

    const parsedBody = editBodySchema.safeParse(bodyResult.body);
    if (!parsedBody.success) return zodErrorResponse(parsedBody.error);

    if (!Types.ObjectId.isValid(assetId)) {
      return NextResponse.json({ error: "Invalid asset id" }, { status: 400 });
    }

    const body = parsedBody.data;
    if (body.operation === "green_screen") {
      const canUseGreenScreen = await canUsePlatformGreenScreenGeneration({
        supabase: access.supabase,
        workspaceId,
      });
      if (!canUseGreenScreen) {
        return NextResponse.json(
          {
            error:
              "Green-screen generation is currently available only for the Airi.chat company.",
          },
          { status: 403 }
        );
      }
    }

    await connectDB();
    const sourceAsset = (await CreativeAsset.findOne({
      _id: assetId,
      workspaceId,
    }).lean()) as LeanCreativeAsset | null;

    if (
      !sourceAsset ||
      (sourceAsset.kind !== "video" &&
        !(
          body.operation === "timeline_render" && sourceAsset.kind === "image"
        )) ||
      sourceAsset.status !== "complete" ||
      !cleanString(sourceAsset.url)
    ) {
      return NextResponse.json(
        {
          error:
            body.operation === "green_screen"
              ? "Green-screen edits require a completed video asset"
              : "Timeline renders require a completed image or video asset",
        },
        { status: 400 }
      );
    }

    const title = sourceAssetTitle(sourceAsset, assetId);
    if (body.operation === "timeline_render") {
      try {
        const result = await queueTimelineRender({
          workspaceId,
          userId: access.userId,
          sourceAssetId: assetId,
          timeline: body.timeline,
          title: `Timeline export of ${title}`,
        });
        return NextResponse.json(
          {
            success: true,
            duplicate: result.duplicate,
            asset: await serializeCreativeAssetForResponse(result.asset),
          },
          { status: result.duplicate ? 200 : 202 }
        );
      } catch (error) {
        return NextResponse.json(
          { error: errorMessage(error) },
          {
            status:
              error instanceof TimelineRenderValidationError ||
              error instanceof z.ZodError
                ? 400
                : 502,
          }
        );
      }
    }
    const operation = body.operation;
    const modelId = AIRI_GREEN_SCREEN_MODEL_ID;
    const prompt = `Green-screen derivative of ${title}`;
    const providerPayload: Record<string, unknown> = {
      operation,
      provider: "bria",
      processor: "bria-video-green-screen-api",
      modelId: AIRI_GREEN_SCREEN_MODEL_ID,
      sourceAssetId: assetId,
      greenShade: "chroma_green",
      backgroundColor: "#00ff00",
      outputContainerAndCodec: "mp4_h264",
      preserveAudio: true,
    };
    const existingDerivativeQuery: Record<string, unknown> = {
      workspaceId,
      source: "edited",
      provider: "airi",
      sourceAssetId: assetId,
    };

    if (body.operation === "green_screen") {
      const retryAssetId = cleanString(body.retryAssetId);
      if (retryAssetId && !Types.ObjectId.isValid(retryAssetId)) {
        return NextResponse.json(
          { error: "Invalid retry asset id" },
          { status: 400 }
        );
      }

      if (retryAssetId) {
        const retryAsset = (await CreativeAsset.findOne({
          _id: retryAssetId,
          workspaceId,
          source: "edited",
          provider: "airi",
          status: "failed",
          modelId: { $in: [...AIRI_GREEN_SCREEN_RETRY_MODEL_IDS] },
          sourceAssetId: assetId,
        }).lean()) as LeanCreativeAsset | null;

        if (!retryAsset) {
          return NextResponse.json(
            { error: "Green-screen retry asset was not found" },
            { status: 400 }
          );
        }
        existingDerivativeQuery._id = { $ne: retryAssetId };
      }
      existingDerivativeQuery.modelId = AIRI_GREEN_SCREEN_MODEL_ID;
    }

    const existingDerivative = (await CreativeAsset.findOne(
      existingDerivativeQuery
    ).lean()) as LeanCreativeAsset | null;

    if (existingDerivative) {
      return NextResponse.json(
        {
          success: true,
          duplicate: true,
          asset: await serializeCreativeAssetForResponse(existingDerivative),
        },
        { status: 200 }
      );
    }

    const outputAssetId = new Types.ObjectId();
    const asset = await CreativeAsset.create({
      _id: outputAssetId,
      workspaceId,
      kind: "video",
      source: "edited",
      provider: "airi",
      status: "queued",
      storageProvider: "gcs",
      prompt,
      modelId,
      sourceAssetId: assetId,
      providerPayload,
      createdBy: access.userId || null,
      updatedBy: access.userId || null,
    });
    const createdAssetId = String(asset._id || outputAssetId);

    try {
      await startCreativeAssetEditWorkflow({
        workspaceId,
        sourceAssetId: assetId,
        outputAssetId: createdAssetId,
        operation,
      });
    } catch (error) {
      const message = errorMessage(error);
      const failed =
        (await CreativeAsset.findOneAndUpdate(
          {
            _id: createdAssetId,
            workspaceId,
            status: { $in: ["queued", "in_progress"] },
          },
          {
            status: "failed",
            error: message,
            updatedBy: access.userId || null,
            updatedAt: new Date(),
          },
          { new: true }
        )) || asset;

      return NextResponse.json(
        {
          success: false,
          asset: await serializeCreativeAssetForResponse(failed),
          error: message,
        },
        { status: 502 }
      );
    }

    return NextResponse.json(
      {
        success: true,
        asset: await serializeCreativeAssetForResponse(asset),
      },
      { status: 202 }
    );
  } catch (error) {
    return NextResponse.json({ error: errorMessage(error) }, { status: 500 });
  }
}
