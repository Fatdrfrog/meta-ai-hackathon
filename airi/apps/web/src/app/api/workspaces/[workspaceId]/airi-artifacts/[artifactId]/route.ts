import connectDB from "@/lib/mongoose";
import {
  AiriArtifactConflictError,
  AiriArtifactNotFoundError,
  archiveAiriArtifact,
  getAiriArtifact,
  updateAiriArtifact,
} from "@/lib/airi-artifacts/service";
import { verifyWorkspaceAccess } from "@/lib/sources/utils";
import {
  getSupabaseRouteAuth,
  isSupabaseRouteAuthError,
} from "@/lib/supabase/route-auth";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { readJsonBodyOrResponse, zodErrorResponse } from "@/lib/api/json-body";

export const runtime = "nodejs";

type Params = {
  params: Promise<{ workspaceId: string; artifactId: string }>;
};

const updateArtifactBodySchema = z.object({
  baseRevision: z.number().int().nonnegative(),
  snapshot: z.unknown(),
  changeSummary: z.string().trim().max(240).optional(),
});

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
  if (error instanceof AiriArtifactConflictError) {
    return NextResponse.json(
      {
        error: error.message,
        current: error.current,
      },
      { status: 409 }
    );
  }

  if (error instanceof AiriArtifactNotFoundError) {
    return NextResponse.json({ error: error.message }, { status: 404 });
  }

  const message =
    error instanceof Error ? error.message : "Failed to manage Airi artifact";
  const status =
    error instanceof Error && error.name === "AiriArtifactValidationError"
      ? 400
      : 500;
  return NextResponse.json({ error: message }, { status });
}

export async function GET(request: NextRequest, { params }: Params) {
  try {
    const { workspaceId, artifactId } = await params;
    const context = await resolveContext(request, workspaceId);
    if (context.error) return context.error;

    await connectDB();

    const artifact = await getAiriArtifact({ workspaceId, artifactId });
    if (!artifact) {
      return NextResponse.json(
        { error: "Airi artifact not found" },
        { status: 404 }
      );
    }

    return NextResponse.json({ artifact });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PATCH(request: NextRequest, { params }: Params) {
  try {
    const { workspaceId, artifactId } = await params;
    const context = await resolveContext(request, workspaceId);
    if (context.error) return context.error;

    const bodyResult = await readJsonBodyOrResponse(request);
    if (!bodyResult.ok) return bodyResult.response;

    const parsed = updateArtifactBodySchema.safeParse(bodyResult.body);
    if (!parsed.success) return zodErrorResponse(parsed.error);

    await connectDB();

    const artifact = await updateAiriArtifact({
      workspaceId,
      artifactId,
      userId: context.user.id,
      baseRevision: parsed.data.baseRevision,
      snapshot: parsed.data.snapshot,
      actor: { type: "user", id: context.user.id },
      changeSummary: parsed.data.changeSummary,
    });

    return NextResponse.json({ artifact });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: NextRequest, { params }: Params) {
  try {
    const { workspaceId, artifactId } = await params;
    const context = await resolveContext(request, workspaceId);
    if (context.error) return context.error;

    await connectDB();

    const artifact = await archiveAiriArtifact({
      workspaceId,
      artifactId,
      userId: context.user.id,
    });

    return NextResponse.json({ artifact });
  } catch (error) {
    return errorResponse(error);
  }
}
