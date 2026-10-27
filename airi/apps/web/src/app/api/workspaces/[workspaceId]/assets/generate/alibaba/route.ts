import { getQwenImageModel } from "@/lib/alibaba/qwen-image-config";
import { requireWorkspaceApiAccess } from "@/lib/supabase/workspace-api-access";
import { NextRequest, NextResponse } from "next/server";

type Params = Promise<{ workspaceId: string }>;
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: NextRequest,
  { params }: { params: Params }
): Promise<NextResponse> {
  const { workspaceId } = await params;
  const access = await requireWorkspaceApiAccess(workspaceId);
  if (!access.ok) return access.response;
  return NextResponse.json({
    configured: false,
    model: getQwenImageModel(),
    provider: "alibaba",
    code: "own_ai_source_required",
  });
}

export async function POST(
  _request: NextRequest,
  { params }: { params: Params }
): Promise<NextResponse> {
  const { workspaceId } = await params;
  const access = await requireWorkspaceApiAccess(workspaceId);
  if (!access.ok) return access.response;
  return NextResponse.json(
    {
      error:
        "Customer-funded Alibaba generation is not available. Use a connected Google AI or Higgsfield source.",
      code: "own_ai_source_required",
      configured: false,
    },
    { status: 403 }
  );
}
