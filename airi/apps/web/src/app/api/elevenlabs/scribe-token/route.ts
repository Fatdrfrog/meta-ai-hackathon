import {
  createScribeRealtimeToken,
  ElevenLabsError,
} from "@/lib/ai/elevenlabs";
import {
  InvalidJsonBodyError,
  invalidJsonBodyResponse,
  readJsonObjectBody,
  requiredFieldResponse,
} from "@/lib/api/json-body";
import { verifyWorkspaceAccess } from "@/lib/sources/utils";
import { resolveElevenLabsSessionAccess } from "@/lib/elevenlabs/session-access";
import {
  getSupabaseRouteAuth,
  isSupabaseRouteAuthError,
} from "@/lib/supabase/route-auth";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const auth = await getSupabaseRouteAuth(request);
    if (isSupabaseRouteAuthError(auth)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const { supabase, user } = auth;

    const payload = await readJsonObjectBody(request);
    const workspaceId =
      typeof payload.workspaceId === "string" ? payload.workspaceId.trim() : "";

    if (!workspaceId) return requiredFieldResponse("workspaceId");

    const hasAccess = await verifyWorkspaceAccess(
      supabase,
      user.id,
      workspaceId
    );
    if (!hasAccess) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const access = await resolveElevenLabsSessionAccess({
      supabase,
      workspaceId,
    });
    if (access.response) return access.response;
    const tokenResult = await createScribeRealtimeToken(access.apiKey);
    return NextResponse.json({
      success: true,
      token: tokenResult.token,
      expiresAt: tokenResult.expiresAt || null,
    });
  } catch (error) {
    if (error instanceof InvalidJsonBodyError) {
      return invalidJsonBodyResponse(error);
    }
    if (error instanceof ElevenLabsError) {
      return NextResponse.json(
        {
          error: error.info.message,
          kind: error.info.kind,
        },
        { status: error.info.status || (error.info.transient ? 503 : 400) }
      );
    }

    const message =
      error instanceof Error
        ? error.message
        : "Failed to create ElevenLabs Scribe token";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
