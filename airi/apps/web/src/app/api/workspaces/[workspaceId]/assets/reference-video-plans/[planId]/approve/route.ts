import { NextRequest, NextResponse } from "next/server";
import { requireWorkspaceApiAccess } from "@/lib/supabase/workspace-api-access";
import { approveReferenceVideoPlan } from "@/lib/creative-assets/reference-video/service";
import { referenceVideoPlanErrorResponse } from "@/lib/creative-assets/reference-video/http";
import { referenceVideoPlanApprovalSchema } from "@/lib/creative-assets/reference-video/contracts";
import { serializeCreativeAssetForResponse } from "@/lib/higgsfield/creative-asset-serialization";
import { readJsonBodyOrResponse } from "@/lib/api/json-body";

type Params = Promise<{ workspaceId: string; planId: string }>;
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(
  request: NextRequest,
  { params }: { params: Params }
): Promise<NextResponse> {
  try {
    const { workspaceId, planId } = await params;
    const access = await requireWorkspaceApiAccess(workspaceId);
    if (!access.ok) return access.response;
    const bodyResult = await readJsonBodyOrResponse(request);
    if (!bodyResult.ok) return bodyResult.response;
    const parsed = referenceVideoPlanApprovalSchema.safeParse(bodyResult.body);
    if (!parsed.success)
      return NextResponse.json(
        { error: "Approve the saved video plan using its review hash." },
        { status: 400 }
      );
    const result = await approveReferenceVideoPlan({
      workspaceId,
      userId: access.userId,
      planId,
      hash: parsed.data.hash,
    });
    return NextResponse.json(
      {
        plan: result.plan,
        asset: await serializeCreativeAssetForResponse(result.asset),
        duplicate: result.duplicate,
      },
      { status: result.duplicate ? 200 : 202 }
    );
  } catch (error) {
    return referenceVideoPlanErrorResponse(error, "approve");
  }
}
