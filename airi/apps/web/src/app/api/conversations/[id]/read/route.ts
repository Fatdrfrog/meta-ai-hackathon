import { getHiddenConversationPlanGateResponse } from "@/lib/limits/company-limits";
import connectDB from "@/lib/mongoose";
import { triggerConversationChanged } from "@/lib/realtime-updates";
import {
  getSupabaseRouteAuth,
  isSupabaseRouteAuthError,
} from "@/lib/supabase/route-auth";
import { Conversation } from "@/models/conversation";
import { NextResponse } from "next/server";
import { checkUserWorkspaceAccess } from "@/lib/supabase/queries";

type Params = Promise<{ id: string }>;
const EXACT_OBJECT_ID_PATTERN = /^[0-9a-f]{24}$/;

async function hasExactEmptyPatchBody(request: Request): Promise<boolean> {
  const rawBody = await request.text();
  if (rawBody.trim().length === 0) return true;

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return false;
  }
  return (
    !!body &&
    typeof body === "object" &&
    !Array.isArray(body) &&
    Object.getPrototypeOf(body) === Object.prototype &&
    Object.keys(body).length === 0
  );
}

export async function PATCH(request: Request, { params }: { params: Params }) {
  try {
    const auth = await getSupabaseRouteAuth(request);
    if (isSupabaseRouteAuthError(auth)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const { supabase, user } = auth;

    const { id: conversationId } = await params;
    if (
      !EXACT_OBJECT_ID_PATTERN.test(conversationId) ||
      !(await hasExactEmptyPatchBody(request))
    ) {
      return NextResponse.json({ error: "Invalid request" }, { status: 400 });
    }

    await connectDB();

    const conversation = await Conversation.findById(conversationId)
      .select("workspaceId")
      .lean<{ workspaceId?: unknown }>();

    if (!conversation) {
      return NextResponse.json(
        { error: "Conversation not found" },
        { status: 404 }
      );
    }

    const workspaceId =
      typeof conversation.workspaceId === "string"
        ? conversation.workspaceId.trim()
        : "";
    if (!workspaceId) {
      return NextResponse.json(
        { error: "Conversation has no workspace association" },
        { status: 400 }
      );
    }

    if (!(await checkUserWorkspaceAccess(supabase, user.id, workspaceId))) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    const planGateResponse = await getHiddenConversationPlanGateResponse(
      supabase,
      workspaceId,
      conversationId
    );
    if (planGateResponse) {
      return planGateResponse;
    }

    // Same filter as read-all: an already-read row is not rewritten, so it
    // emits no change event, cache invalidation, or realtime fanout.
    const updateResult = await Conversation.updateOne(
      { _id: conversationId, workspaceId, is_read_by_manager: { $ne: true } },
      { $set: { is_read_by_manager: true } }
    );
    const readAt = new Date().toISOString();

    if ((updateResult.modifiedCount ?? 0) > 0) {
      try {
        await triggerConversationChanged(conversationId);
      } catch {
        // Non-blocking realtime fanout.
      }
    }

    return NextResponse.json({ readAt });
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
}
