import { supabaseAdmin } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { createRequestLogger } from "@/lib/observability/server-logs";
import { NextResponse } from "next/server";

/**
 * Updates user profile data after completing invite form
 * Called after user sets password and name in complete-invite page
 * NOTE: Initial profile sync is done by processInvite() during invite flow
 * This endpoint handles updates AFTER the user completes the form
 */
export async function POST(request: Request) {
  const requestLogger = createRequestLogger("api.auth.sync-profile", request, {
    route: "/api/auth/sync-profile",
  });
  requestLogger.start("Profile sync request received");

  const supabase = await createClient();

  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if (userError || !user) {
    requestLogger.warn("Profile sync rejected for unauthenticated request", {
      authError: userError?.message ?? null,
    });
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const metadata = user.user_metadata as Record<string, unknown> | undefined;
    const fullName = (metadata?.full_name || metadata?.name) as
      | string
      | undefined;
    const avatarUrl = metadata?.avatar_url as string | undefined;

    await supabaseAdmin.from("users").upsert(
      {
        id: user.id,
        full_name: fullName ?? null,
        avatar_url: avatarUrl ?? null,
      },
      { onConflict: "id" }
    );

    requestLogger.success("Profile sync completed", {
      userId: user.id,
      hasFullName: Boolean(fullName),
      hasAvatarUrl: Boolean(avatarUrl),
    });

    return NextResponse.json({
      success: true,
      message: "Profile updated successfully",
    });
  } catch (error) {
    requestLogger.error("Profile sync failed", error, {
      userId: user.id,
    });
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
}
