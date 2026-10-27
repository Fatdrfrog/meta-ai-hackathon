import connectDB from "@/lib/mongoose";
import { errorMessageResponse } from "@/lib/api/json-body";
import { buildConversationMessagingWindowStatus } from "@/lib/conversation-window-status";
import {
  getSupabaseRouteAuth,
  isSupabaseRouteAuthError,
} from "@/lib/supabase/route-auth";
import { Conversation } from "@/models/conversation";
import { NextResponse } from "next/server";
import { checkUserWorkspaceAccess } from "@/lib/supabase/queries";

type Params = Promise<{ id: string }>;

export async function GET(request: Request, { params }: { params: Params }) {
  const [{ id: conversationId }, auth] = await Promise.all([
    params,
    getSupabaseRouteAuth(request),
  ]);

  if (isSupabaseRouteAuthError(auth)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { supabase, user } = auth;

  try {
    await connectDB();

    const conversation = await Conversation.findById(conversationId)
      .select("_id workspaceId sourceId channel last_inbound_at")
      .lean<{
        _id: unknown;
        workspaceId: string;
        sourceId?: string | null;
        channel?: string | null;
        last_inbound_at?: Date | null;
      } | null>();

    if (!conversation) {
      return NextResponse.json(
        { error: "Conversation not found" },
        { status: 404 }
      );
    }

    if (
      !(await checkUserWorkspaceAccess(
        supabase,
        user.id,
        conversation.workspaceId
      ))
    ) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    return NextResponse.json(
      await buildConversationMessagingWindowStatus(conversation)
    );
  } catch (error) {
    return errorMessageResponse(error, 500);
  }
}
