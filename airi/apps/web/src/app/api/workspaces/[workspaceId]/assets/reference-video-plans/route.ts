import { NextRequest, NextResponse } from "next/server";
import { requireWorkspaceApiAccess } from "@/lib/supabase/workspace-api-access";
import { createReferenceVideoPlan } from "@/lib/creative-assets/reference-video/service";
import { referenceVideoPlanErrorResponse } from "@/lib/creative-assets/reference-video/http";
import { readJsonBodyOrResponse } from "@/lib/api/json-body";

type Params = Promise<{ workspaceId: string }>;
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  { params }: { params: Params }
): Promise<NextResponse> {
  try {
    const { workspaceId } = await params;
    const access = await requireWorkspaceApiAccess(workspaceId);
    if (!access.ok) return access.response;
    const bodyResult = await readJsonBodyOrResponse(request);
    if (!bodyResult.ok) return bodyResult.response;
    const plan = await createReferenceVideoPlan({
      workspaceId,
      userId: access.userId,
      input: bodyResult.body,
    });
    return NextResponse.json({ plan }, { status: 201 });
  } catch (error) {
    return referenceVideoPlanErrorResponse(error, "draft");
  }
}
