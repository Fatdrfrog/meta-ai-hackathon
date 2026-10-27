import connectDB from "@/lib/mongoose";
import {
  createAiriChatThread,
  listAiriChatThreads,
} from "@/lib/airi-chats/service";
import { verifyWorkspaceAccess } from "@/lib/sources/utils";
import {
  getSupabaseRouteAuth,
  isSupabaseRouteAuthError,
} from "@/lib/supabase/route-auth";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { zodErrorResponse } from "@/lib/api/json-body";

export const runtime = "nodejs";

type Params = { params: Promise<{ workspaceId: string }> };

const createThreadSchema = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  source: z.enum(["manual", "onboarding", "global"]).optional(),
});

async function resolveAiriChatContext(
  request: NextRequest,
  workspaceId: string
) {
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

export async function GET(request: NextRequest, { params }: Params) {
  try {
    const { workspaceId } = await params;
    const context = await resolveAiriChatContext(request, workspaceId);
    if (context.error) return context.error;

    await connectDB();

    const threads = await listAiriChatThreads({
      workspaceId,
      userId: context.user.id,
    });

    return NextResponse.json({ threads });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to list Airi chats";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: NextRequest, { params }: Params) {
  try {
    const { workspaceId } = await params;
    const context = await resolveAiriChatContext(request, workspaceId);
    if (context.error) return context.error;

    const body = await request.json().catch(() => ({}));
    const parsed = createThreadSchema.safeParse(body);
    if (!parsed.success) return zodErrorResponse(parsed.error);

    await connectDB();

    const thread = await createAiriChatThread({
      workspaceId,
      userId: context.user.id,
      title: parsed.data.title,
      source: parsed.data.source,
    });

    return NextResponse.json({ thread }, { status: 201 });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to create Airi chat";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
