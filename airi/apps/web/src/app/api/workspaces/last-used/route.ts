import { supabaseAdmin } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

const BodySchema = z.object({ workspaceId: z.string().uuid() });

function asUserMetadata(metadata: unknown): Record<string, unknown> {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return {};
  }

  return { ...(metadata as Record<string, unknown>) };
}

export async function POST(req: NextRequest) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user)
      return new NextResponse(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
      });

    const body = await req.json().catch(() => null);
    const parsed = BodySchema.safeParse(body);
    if (!parsed.success) {
      return new NextResponse(JSON.stringify({ error: "Invalid body" }), {
        status: 400,
      });
    }
    const { workspaceId } = parsed.data;

    const { data: membership, error: membershipError } = await supabase
      .from("company_users")
      .select("user_id")
      .eq("user_id", user.id)
      .eq("workspace_id", workspaceId)
      .maybeSingle();

    if (membershipError) {
      console.error(
        "[Workspaces Last Used POST] Membership lookup failed:",
        membershipError
      );
      return new NextResponse(
        JSON.stringify({ error: "Failed to verify workspace access" }),
        {
          status: 500,
        }
      );
    }

    if (!membership)
      return new NextResponse(JSON.stringify({ error: "Forbidden" }), {
        status: 403,
      });

    let authMetadataError: unknown = null;
    try {
      const { error } = await supabaseAdmin.auth.admin.updateUserById(user.id, {
        user_metadata: {
          ...asUserMetadata(user.user_metadata),
          last_workspace_id: workspaceId,
        },
      });
      authMetadataError = error;
    } catch (error) {
      authMetadataError = error;
    }

    const authMetadataRecorded = !authMetadataError;

    if (!authMetadataRecorded) {
      console.warn(
        "[Workspaces Last Used POST] Failed to record auth user metadata:",
        authMetadataError
      );
    }

    return NextResponse.json({
      ok: true,
      authMetadataRecorded,
    });
  } catch (error) {
    console.error("[Workspaces Last Used POST] Error:", error);
    return new NextResponse(
      JSON.stringify({ error: "Failed to record last used workspace" }),
      {
        status: 500,
      }
    );
  }
}
