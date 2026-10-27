import {
  assertCreativeCustomerProviderSupported,
  OwnCreativeAiSourceRequiredError,
} from "@/lib/google/creative-credentials";
import { expandStudioSkillPrompt } from "@/lib/creative-assets/studio-skill-prompts";
import { serializeCreativeAssetForResponse } from "@/lib/higgsfield/creative-asset-serialization";
import connectDB from "@/lib/mongoose";
import { requireWorkspaceApiAccess } from "@/lib/supabase/workspace-api-access";
import {
  isTemporalConfigured,
  startWanMorphWorkflow,
} from "@/lib/temporal/wan-morph";
import {
  getWanI2VModel,
  getWanS2VDefaultResolution,
  isWanMorphConfigured,
  normalizeWanS2VDuration,
  normalizeWanS2VResolution,
} from "@/lib/wan/wan-config";
import { CreativeAsset } from "@/models/creative-asset";
import { Types } from "mongoose";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { readJsonBodyOrResponse, zodErrorResponse } from "@/lib/api/json-body";
import { cleanString } from "@icecore/shared/lib/value-utils";

type Params = Promise<{ workspaceId: string }>;

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const wanMorphBodySchema = z.object({
  prompt: z.string().trim().min(3).max(5000),
  firstFrameAssetId: z.string().trim().min(1).max(80),
  lastFrameAssetId: z.string().trim().min(1).max(80),
  duration: z.number().optional(),
  resolution: z.string().trim().max(16).optional(),
});

export async function GET(
  _request: NextRequest,
  { params }: { params: Params }
): Promise<NextResponse> {
  try {
    const { workspaceId } = await params;
    const access = await requireWorkspaceApiAccess(workspaceId);
    if (!access.ok) return access.response;

    return NextResponse.json({
      configured: false,
      temporalConfigured: isTemporalConfigured(),
      model: getWanI2VModel(),
      defaultResolution: getWanS2VDefaultResolution(),
      durationMin: 2,
      durationMax: 15,
    });
  } catch (error) {
    if (error instanceof OwnCreativeAiSourceRequiredError)
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: 403 }
      );
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to load Wan morph capability",
      },
      { status: 500 }
    );
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Params }
): Promise<NextResponse> {
  try {
    const { workspaceId } = await params;
    const access = await requireWorkspaceApiAccess(workspaceId);
    if (!access.ok) return access.response;
    assertCreativeCustomerProviderSupported("Wan");

    if (!isWanMorphConfigured()) {
      return NextResponse.json(
        {
          error:
            "Wan morph video is not configured. Set ALIBABA_API_KEY and ALIBABA_API_HOST (Singapore Model Studio).",
          configured: false,
        },
        { status: 503 }
      );
    }

    if (!isTemporalConfigured()) {
      return NextResponse.json(
        { error: "Temporal is not configured for Wan morph video generation" },
        { status: 503 }
      );
    }

    const bodyResult = await readJsonBodyOrResponse(request);
    if (!bodyResult.ok) return bodyResult.response;

    const parsedBody = wanMorphBodySchema.safeParse(bodyResult.body);
    if (!parsedBody.success) return zodErrorResponse(parsedBody.error);

    const body = parsedBody.data;
    const userPrompt = cleanString(body.prompt, 5000);
    const firstFrameAssetId = cleanString(body.firstFrameAssetId, 80);
    const lastFrameAssetId = cleanString(body.lastFrameAssetId, 80);
    if (
      !Types.ObjectId.isValid(firstFrameAssetId) ||
      !Types.ObjectId.isValid(lastFrameAssetId)
    ) {
      return NextResponse.json(
        { error: "firstFrameAssetId and lastFrameAssetId must be valid ids" },
        { status: 400 }
      );
    }
    if (firstFrameAssetId === lastFrameAssetId) {
      return NextResponse.json(
        { error: "first and last frame assets must be different images" },
        { status: 400 }
      );
    }

    const resolution =
      normalizeWanS2VResolution(body.resolution) ||
      getWanS2VDefaultResolution();
    const duration = normalizeWanS2VDuration(body.duration) ?? 5;

    await connectDB();

    const frames = await CreativeAsset.find({
      _id: { $in: [firstFrameAssetId, lastFrameAssetId] },
      workspaceId,
      kind: "image",
      status: "complete",
    })
      .select("_id")
      .lean();
    const found = new Set(frames.map(row => String(row._id)));
    if (!found.has(firstFrameAssetId) || !found.has(lastFrameAssetId)) {
      return NextResponse.json(
        {
          error:
            "Both first and last frames must be completed image assets in this workspace",
        },
        { status: 400 }
      );
    }

    const { modelPrompt } = expandStudioSkillPrompt({
      skill: "morph",
      variables: {
        user_prompt: userPrompt,
        duration_seconds: duration,
        resolution,
        mode: "first_last_frame",
        reference_count: 2,
      },
    });

    const asset = await CreativeAsset.create({
      workspaceId,
      kind: "video",
      source: "wan",
      provider: "wan",
      status: "queued",
      prompt: userPrompt,
      modelId: getWanI2VModel(),
      sourceAssetId: firstFrameAssetId,
      providerPayload: {
        mode: "first_last_frame",
        firstFrameAssetId,
        lastFrameAssetId,
        resolution,
        duration,
        skill: "morph",
        skillPromptApplied: true,
      },
      createdBy: access.userId || null,
      updatedBy: access.userId || null,
    });
    const outputAssetId = String(asset._id);

    try {
      await startWanMorphWorkflow({
        workspaceId,
        outputAssetId,
        prompt: modelPrompt,
        firstFrameAssetId,
        lastFrameAssetId,
        resolution,
        duration,
      });
    } catch (error) {
      await CreativeAsset.findByIdAndUpdate(outputAssetId, {
        status: "failed",
        error:
          error instanceof Error
            ? error.message
            : "Failed to start Wan morph workflow",
        updatedAt: new Date(),
      });
      throw error;
    }

    const fresh =
      (await CreativeAsset.findById(outputAssetId).lean()) || asset.toObject();

    return NextResponse.json(
      {
        asset: await serializeCreativeAssetForResponse(fresh),
      },
      { status: 202 }
    );
  } catch (error) {
    if (error instanceof OwnCreativeAiSourceRequiredError)
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: 403 }
      );
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to start Wan morph video generation",
      },
      { status: 500 }
    );
  }
}
