import connectDB from "@/lib/mongoose";
import {
  AiriArtifactNotFoundError,
  AiriArtifactSubmitError,
  AiriArtifactValidationError,
  submitAiriArtifact,
} from "@/lib/airi-artifacts/service";
import { verifyWorkspaceAccess } from "@/lib/sources/utils";
import {
  getSupabaseRouteAuth,
  isSupabaseRouteAuthError,
} from "@/lib/supabase/route-auth";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

type Params = {
  params: Promise<{ workspaceId: string; artifactId: string }>;
};

async function resolveContext(request: NextRequest, workspaceId: string) {
  const auth = await getSupabaseRouteAuth(request);
  if (isSupabaseRouteAuthError(auth)) {
    return {
      error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    };
  }

  const hasAccess = await verifyWorkspaceAccess(
    auth.supabase,
    auth.user.id,
    workspaceId
  );
  if (!hasAccess) {
    return {
      error: NextResponse.json({ error: "Forbidden" }, { status: 403 }),
    };
  }

  return { supabase: auth.supabase, user: auth.user };
}

function errorResponse(error: unknown) {
  if (error instanceof AiriArtifactNotFoundError) {
    return NextResponse.json({ error: error.message }, { status: 404 });
  }
  if (error instanceof AiriArtifactValidationError) {
    return NextResponse.json(
      { error: error.message, validation: error.validation },
      { status: 400 }
    );
  }
  if (error instanceof AiriArtifactSubmitError) {
    return NextResponse.json(
      { error: error.message, details: error.details },
      { status: error.status }
    );
  }
  const message =
    error instanceof Error ? error.message : "Failed to submit artifact";
  return NextResponse.json({ error: message }, { status: 500 });
}

export async function POST(request: NextRequest, { params }: Params) {
  try {
    const { workspaceId, artifactId } = await params;
    const context = await resolveContext(request, workspaceId);
    if (context.error) return context.error;

    await connectDB();

    const result = await submitAiriArtifact({
      supabase: context.supabase,
      workspaceId,
      artifactId,
      userId: context.user.id,
    });

    return NextResponse.json(result);
  } catch (error) {
    return errorResponse(error);
  }
}
