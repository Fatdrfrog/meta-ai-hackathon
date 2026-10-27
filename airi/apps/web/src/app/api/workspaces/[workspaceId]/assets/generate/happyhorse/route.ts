import {
  queueVideoGeneration,
  VideoGenerationQueueError,
} from "@/lib/creative-assets/video-generation-queue";
import { videoGenerationQueueErrorResponse } from "@/lib/creative-assets/video-generation-http";
import {
  getHappyHorseDefaultRatio,
  getHappyHorseDefaultResolution,
  getHappyHorseI2VModel,
  getHappyHorseR2VModel,
  getHappyHorseT2VModel,
  HAPPYHORSE_REFERENCE_MAX,
  HAPPYHORSE_REFERENCE_MIN,
  isHappyHorseConfigured,
} from "@/lib/happyhorse/happyhorse-config";
import {
  serializeCreativeAssetForResponse,
  type LeanCreativeAsset,
} from "@/lib/higgsfield/creative-asset-serialization";
import connectDB from "@/lib/mongoose";
import { requireWorkspaceApiAccess } from "@/lib/supabase/workspace-api-access";
import { isTemporalConfigured } from "@/lib/temporal/client";
import { CreativeAsset } from "@/models/creative-asset";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { readJsonBodyOrResponse, zodErrorResponse } from "@/lib/api/json-body";

type Params = Promise<{ workspaceId: string }>;

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const happyHorseBodySchema = z.object({
  mode: z.enum(["text_to_video", "image_to_video", "reference_to_video"]),
  prompt: z.string().min(3).max(5000),
  sourceAssetId: z.string().trim().max(80).optional(),
  referenceAssetIds: z
    .array(z.string().trim().min(1).max(80))
    .max(9)
    .optional(),
  duration: z.number().optional(),
  resolution: z.string().trim().max(16).optional(),
  ratio: z.string().trim().max(16).optional(),
  skill: z.enum(["video", "character"]).optional(),
});

const RFC_4122_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
      code: "own_ai_source_required",
      temporalConfigured: isTemporalConfigured(),
      t2vModel: getHappyHorseT2VModel(),
      i2vModel: getHappyHorseI2VModel(),
      r2vModel: getHappyHorseR2VModel(),
      defaultResolution: getHappyHorseDefaultResolution(),
      defaultRatio: getHappyHorseDefaultRatio(),
      durationMin: 3,
      durationMax: 15,
      referenceMin: HAPPYHORSE_REFERENCE_MIN,
      referenceMax: HAPPYHORSE_REFERENCE_MAX,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to load HappyHorse capability",
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

    const idempotencyKey = request.headers.get("Idempotency-Key") || "";
    if (!RFC_4122_UUID.test(idempotencyKey)) {
      return NextResponse.json(
        {
          error: "Idempotency-Key must be an RFC-4122 UUID",
          code: "invalid_idempotency_key",
        },
        { status: 400 }
      );
    }

    const bodyResult = await readJsonBodyOrResponse(request);
    if (!bodyResult.ok) return bodyResult.response;
    const parsedBody = happyHorseBodySchema.safeParse(bodyResult.body);
    if (!parsedBody.success) return zodErrorResponse(parsedBody.error);

    const body = parsedBody.data;
    await connectDB();
    const acceptedReplay = await CreativeAsset.findOne({
      workspaceId,
      "generation.contractVersion": 1,
      "generation.requestIdempotencyKey": idempotencyKey,
    }).lean();
    if (!acceptedReplay && !isHappyHorseConfigured()) {
      return NextResponse.json(
        {
          error:
            "HappyHorse video is not configured. Set ALIBABA_API_KEY and ALIBABA_API_HOST (Singapore Model Studio).",
          configured: false,
        },
        { status: 503 }
      );
    }
    if (!acceptedReplay && !isTemporalConfigured()) {
      return NextResponse.json(
        { error: "Temporal is not configured for HappyHorse video generation" },
        { status: 503 }
      );
    }
    const result = await queueVideoGeneration({
      workspaceId,
      createdBy: access.userId || null,
      idempotencyKey,
      providerPolicy: { provider: "happyhorse" },
      request: {
        mode: body.mode,
        prompt: body.prompt,
        skill: body.skill,
        durationSeconds: body.duration,
        aspectRatio: body.mode === "image_to_video" ? null : body.ratio,
        resolution: body.resolution,
        sourceAssetId:
          body.mode === "image_to_video" ? body.sourceAssetId : null,
        referenceAssetIds:
          body.mode === "reference_to_video" ? body.referenceAssetIds : [],
      },
    });

    return NextResponse.json(
      {
        success: true,
        asset: await serializeCreativeAssetForResponse(
          result.asset as LeanCreativeAsset
        ),
      },
      { status: 202 }
    );
  } catch (error) {
    if (error instanceof VideoGenerationQueueError) {
      return videoGenerationQueueErrorResponse(error);
    }
    return NextResponse.json(
      { error: "Failed to start HappyHorse video generation" },
      { status: 500 }
    );
  }
}
