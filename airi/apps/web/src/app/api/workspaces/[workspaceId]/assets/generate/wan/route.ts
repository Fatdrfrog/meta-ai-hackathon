import { OwnCreativeAiSourceRequiredError } from "@/lib/google/creative-credentials";
import { resolveWorkspaceElevenLabsGenerationAccess } from "@/lib/elevenlabs/elevenlabs-source";
import { requireWorkspaceApiAccess } from "@/lib/supabase/workspace-api-access";
import { isTemporalConfigured } from "@/lib/temporal/client";
import {
  getWanS2VDefaultResolution,
  getWanS2VModel,
} from "@/lib/wan/wan-config";
import { NextRequest, NextResponse } from "next/server";

type Params = Promise<{ workspaceId: string }>;
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(
  _request: NextRequest,
  { params }: { params: Params }
): Promise<NextResponse> {
  try {
    const { workspaceId } = await params;
    const access = await requireWorkspaceApiAccess(workspaceId);
    if (!access.ok) return access.response;

    const elevenLabsAccess = await resolveWorkspaceElevenLabsGenerationAccess({
      supabase: access.supabase,
      workspaceId,
    });

    return NextResponse.json({
      configured: false,
      temporalConfigured: isTemporalConfigured(),
      model: getWanS2VModel(),
      defaultResolution: getWanS2VDefaultResolution(),
      elevenLabsAvailable: Boolean(
        elevenLabsAccess.available &&
          elevenLabsAccess.credentialSource === "workspace_source" &&
          elevenLabsAccess.apiKey &&
          elevenLabsAccess.sourceId
      ),
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
            : "Failed to load Wan avatar capability",
      },
      { status: 500 }
    );
  }
}

export async function POST(
  _request: NextRequest,
  { params }: { params: Params }
): Promise<NextResponse> {
  try {
    const { workspaceId } = await params;
    const access = await requireWorkspaceApiAccess(workspaceId);
    if (!access.ok) return access.response;
    throw new OwnCreativeAiSourceRequiredError("wan");
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
            : "Failed to start Wan talking avatar generation",
      },
      { status: 500 }
    );
  }
}
