import { getAiriChatThreadForUser } from "@/lib/airi-chats/service";
import { airiChatMessageBodySchema } from "@/lib/airi-chats/request-schemas";
import {
  admitAiriChatMessageRequest,
  airiChatRequestFailureResponse,
  airiChatRunActiveResponse,
  scheduleAiriChatStudioChatQuota,
} from "@/lib/airi-chats/route-context";
import {
  createAiriChatRunStreamResponse,
  startAiriChatRun,
} from "@/lib/airi-chats/runs";
import { Types } from "mongoose";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
// A run (retrieval, generation, Meta Ads tools) can outlast the default.
export const maxDuration = 300;

type Params = { params: Promise<{ workspaceId: string; threadId: string }> };

export async function POST(request: NextRequest, { params }: Params) {
  let logContext: { workspaceId?: string; threadId?: string } = {};
  try {
    const { workspaceId, threadId } = await params;
    logContext = { workspaceId, threadId };
    if (!Types.ObjectId.isValid(threadId)) {
      return NextResponse.json({ error: "Chat not found" }, { status: 404 });
    }

    const admission = await admitAiriChatMessageRequest({
      request,
      workspaceId,
      schema: airiChatMessageBodySchema,
      loadThread: userId =>
        getAiriChatThreadForUser({ workspaceId, userId, threadId }),
    });
    if (!admission.ok) return admission.response;
    const { auth, body, thread } = admission;

    // The run is not tied to this request: closing the drawer only
    // detaches the stream (resume: GET .../runs/[runId]/stream).
    const start = await startAiriChatRun({
      supabase: auth.supabase,
      workspaceId,
      userId: auth.user.id,
      clientTurnId: body.clientTurnId,
      threadId,
      thread,
      content: body.content,
      selectedSources: body.selectedSources,
      attachedFiles: body.attachments,
      activeBuilder: body.activeBuilder,
      onTurnSaved: turn => scheduleAiriChatStudioChatQuota(workspaceId, turn),
    });
    if (start.kind === "conflict") {
      return airiChatRunActiveResponse(start.runId);
    }
    return createAiriChatRunStreamResponse({
      runId: start.run.runId,
      signal: request.signal,
      supabase: auth.supabase,
    });
  } catch (error) {
    // Before the stream starts a failure is a plain JSON error.
    // Only the request's own abort is a cancellation (499).
    return airiChatRequestFailureResponse(
      error,
      logContext,
      undefined,
      request.signal
    );
  }
}
