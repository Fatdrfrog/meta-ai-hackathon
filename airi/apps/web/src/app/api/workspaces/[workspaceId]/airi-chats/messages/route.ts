import { airiChatFirstMessageBodySchema } from "@/lib/airi-chats/request-schemas";
import {
  admitAiriChatMessageRequest,
  airiChatRequestFailureResponse,
  airiChatRunActiveResponse,
  scheduleAiriChatStudioChatQuota,
} from "@/lib/airi-chats/route-context";
import { awaitAiriChatRunTurn, startAiriChatRun } from "@/lib/airi-chats/runs";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
// A run (retrieval, generation, Meta Ads tools) can outlast the default.
export const maxDuration = 300;

type Params = { params: Promise<{ workspaceId: string }> };

export async function POST(request: NextRequest, { params }: Params) {
  let logContext: { workspaceId?: string } = {};
  try {
    const { workspaceId } = await params;
    logContext = { workspaceId };
    const admission = await admitAiriChatMessageRequest({
      request,
      workspaceId,
      schema: airiChatFirstMessageBodySchema,
    });
    if (!admission.ok) return admission.response;
    const { auth, body } = admission;

    // Start the durable run and wait for it: the response shape stays the
    // same (mobile), and a dropped request does not stop the answer.
    const start = await startAiriChatRun({
      supabase: auth.supabase,
      workspaceId,
      userId: auth.user.id,
      clientTurnId: body.clientTurnId,
      content: body.content,
      source: body.source,
      selectedSources: body.selectedSources,
      attachedFiles: body.attachments,
      activeBuilder: body.activeBuilder,
      onTurnSaved: turn => scheduleAiriChatStudioChatQuota(workspaceId, turn),
    });
    if (start.kind === "conflict") {
      return airiChatRunActiveResponse(start.runId);
    }
    const turn = await awaitAiriChatRunTurn(start, {
      supabase: auth.supabase,
    });
    return NextResponse.json(turn, { status: 201 });
  } catch (error) {
    return airiChatRequestFailureResponse(
      error,
      logContext,
      undefined,
      request.signal
    );
  }
}
