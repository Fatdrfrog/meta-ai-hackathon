import connectDB from "@/lib/mongoose";
import {
  AiriArtifactNotFoundError,
  validateAiriArtifact,
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

export async function POST(request: NextRequest, { params }: Params) {
  try {
    const { workspaceId, artifactId } = await params;
    const context = await resolveContext(request, workspaceId);
    if (context.error) return context.error;

    await connectDB();

    const validation = await validateAiriArtifact({ workspaceId, artifactId });
    return NextResponse.json({ validation });
  } catch (error) {
    if (error instanceof AiriArtifactNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    const message =
      error instanceof Error ? error.message : "Failed to validate artifact";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
