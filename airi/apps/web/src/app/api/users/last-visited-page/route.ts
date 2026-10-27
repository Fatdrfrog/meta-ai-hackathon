import {
  normalizeLastVisitedHref,
  normalizeStoredLastVisitedPath,
} from "@/features/panel/shared/routing";
import { logger } from "@/lib/logger";
import { createClient } from "@/lib/supabase/server";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

const BodySchema = z
  .object({
    path: z.string().min(1).max(4096).optional(),
    href: z.string().min(1).max(4096).optional(),
  })
  .refine(body => Boolean(body.path || body.href), {
    message: "path or href required",
  });

export async function POST(req: NextRequest) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json().catch(() => null);
    const parsed = BodySchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid body" }, { status: 400 });
    }

    const normalized = parsed.data.path
      ? normalizeStoredLastVisitedPath(parsed.data.path)
      : normalizeLastVisitedHref(parsed.data.href!);
    if (!normalized.ok) {
      return NextResponse.json({
        ok: true,
        stored: false,
        reason: normalized.reason,
      });
    }

    const { data: membership, error: membershipError } = await supabase
      .from("company_users")
      .select("user_id")
      .eq("user_id", user.id)
      .eq("workspace_id", normalized.workspaceId)
      .maybeSingle();

    if (membershipError) {
      logger.error(
        "[last-visited-page] Failed to verify workspace membership",
        membershipError,
        {
          workspaceId: normalized.workspaceId,
          userId: user.id,
        }
      );
      return NextResponse.json(
        { error: "Failed to verify workspace access" },
        { status: 500 }
      );
    }

    if (!membership) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const now = new Date().toISOString();
    const { error: upsertError } = await supabase
      .from("user_navigation_state")
      .upsert(
        {
          user_id: user.id,
          last_visited_path: normalized.path,
          last_visited_workspace_id: normalized.workspaceId,
          last_visited_at: now,
          updated_at: now,
        },
        { onConflict: "user_id" }
      );

    if (upsertError) {
      logger.error(
        "[last-visited-page] Failed to store navigation state",
        upsertError,
        {
          workspaceId: normalized.workspaceId,
          userId: user.id,
        }
      );
      return NextResponse.json(
        { error: "Failed to store last visited page" },
        { status: 500 }
      );
    }

    return NextResponse.json({
      ok: true,
      stored: true,
      path: normalized.path,
    });
  } catch (error) {
    logger.error("[last-visited-page] Unexpected error", error);
    return NextResponse.json(
      { error: "Failed to store last visited page" },
      { status: 500 }
    );
  }
}
