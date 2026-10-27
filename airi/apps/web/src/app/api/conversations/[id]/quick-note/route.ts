import {
  invalidateConversationCache,
  invalidateRequestsForWorkspace,
} from "@/lib/cache";
import { getHiddenConversationPlanGateResponse } from "@/lib/limits/company-limits";
import connectDB from "@/lib/mongoose";
import { triggerRealtimeEvent } from "@/lib/realtime/server";
import {
  getSupabaseRouteAuth,
  isSupabaseRouteAuthError,
} from "@/lib/supabase/route-auth";
import { Conversation } from "@/models/conversation";
import mongoose from "mongoose";
import { NextResponse } from "next/server";
import {
  errorMessageResponse,
  readJsonBodyOrResponse,
} from "@/lib/api/json-body";
import { checkUserWorkspaceAccess } from "@/lib/supabase/queries";

type Params = Promise<{ id: string }>;

const MAX_QUICK_NOTE_LENGTH = 1000;

function normalizeQuickNote(value: string | null): string | null {
  if (value === null) return null;
  const normalized = value.trim().slice(0, MAX_QUICK_NOTE_LENGTH);
  return normalized.length > 0 ? normalized : null;
}

export async function PATCH(request: Request, { params }: { params: Params }) {
  try {
    const auth = await getSupabaseRouteAuth(request);
    if (isSupabaseRouteAuthError(auth)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const { supabase, user } = auth;
    const { id: conversationId } = await params;

    if (!mongoose.Types.ObjectId.isValid(conversationId)) {
      return NextResponse.json(
        { error: "Invalid conversation id" },
        { status: 400 }
      );
    }

    const bodyResult = await readJsonBodyOrResponse(request);
    if (!bodyResult.ok) return bodyResult.response;
    const body = bodyResult.body as { note?: string | null } | null;

    if (!body || !Object.prototype.hasOwnProperty.call(body, "note")) {
      return NextResponse.json(
        { error: "Field 'note' is required" },
        { status: 400 }
      );
    }
    if (typeof body.note !== "string" && body.note !== null) {
      return NextResponse.json(
        { error: "Field 'note' must be a string or null" },
        { status: 400 }
      );
    }

    const noteToSave = normalizeQuickNote(body.note);

    await connectDB();

    const conversation = await Conversation.findById(conversationId)
      .select("workspaceId")
      .lean<{ workspaceId: string } | null>();

    if (!conversation) {
      return NextResponse.json(
        { error: "Conversation not found" },
        { status: 404 }
      );
    }

    const { workspaceId } = conversation;
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

    const updatedAt = new Date();
    await Conversation.updateOne(
      { _id: conversationId },
      {
        $set: {
          quick_note: noteToSave,
          quick_note_updated_at: updatedAt,
          quick_note_updated_by: user.id,
          updatedAt,
        },
      }
    );

    try {
      await Promise.all([
        invalidateConversationCache(workspaceId, conversationId),
        invalidateRequestsForWorkspace(workspaceId),
      ]);
    } catch {
      // Cache invalidation is best-effort; the write is already complete.
    }

    try {
      await triggerRealtimeEvent(
        `private-conversation-${conversationId}`,
        "conversation.note.changed",
        {
          workspaceId,
          conversationId,
          note: noteToSave,
          updatedAt: updatedAt.toISOString(),
          updatedBy: user.id,
        }
      );
    } catch {
      // Realtime fanout is best-effort for manager metadata.
    }

    return NextResponse.json({ note: noteToSave });
  } catch (error) {
    return errorMessageResponse(error, 500);
  }
}
