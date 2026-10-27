import {
  retryVideoGeneration,
  VideoGenerationQueueError,
} from "@/lib/creative-assets/video-generation-queue";
import { videoGenerationQueueErrorResponse } from "@/lib/creative-assets/video-generation-http";
import {
  serializeCreativeAssetForResponse,
  type LeanCreativeAsset,
} from "@/lib/higgsfield/creative-asset-serialization";
import connectDB from "@/lib/mongoose";
import { requireWorkspaceApiAccess } from "@/lib/supabase/workspace-api-access";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { readJsonBodyOrResponse, zodErrorResponse } from "@/lib/api/json-body";

type Params = Promise<{ workspaceId: string; assetId: string }>;

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const retryBodySchema = z
  .object({
    acknowledgePossibleDuplicateCharge: z.boolean().optional(),
  })
  .strict();

const RFC_4122_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function POST(
  request: NextRequest,
  { params }: { params: Params }
): Promise<NextResponse> {
  try {
    const { workspaceId, assetId } = await params;
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

    const bodyResult = await readJsonBodyOrResponse(request, {
      code: "invalid_request_body",
    });
    if (!bodyResult.ok) return bodyResult.response;
    const parsedBody = retryBodySchema.safeParse(bodyResult.body);
    if (!parsedBody.success)
      return zodErrorResponse(parsedBody.error, {
        code: "invalid_request_body",
      });

    await connectDB();
    const result = await retryVideoGeneration({
      workspaceId,
      assetId,
      createdBy: access.userId || null,
      idempotencyKey,
      acknowledgePossibleDuplicateCharge:
        parsedBody.data.acknowledgePossibleDuplicateCharge,
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
      { error: "Failed to retry video generation" },
      { status: 500 }
    );
  }
}
