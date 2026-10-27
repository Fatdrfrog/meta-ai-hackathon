import connectDB from "@/lib/mongoose";
import {
  airiChatRequestFailureResponse,
  resolveAiriChatRouteContext,
} from "@/lib/airi-chats/route-context";
import {
  createAiriChatRunStreamResponse,
  findAiriChatRunForUser,
} from "@/lib/airi-chats/runs";
import { Types } from "mongoose";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
// Following a run can take as long as the run itself.
export const maxDuration = 300;

type Params = {
  params: Promise<{ workspaceId: string; threadId: string; runId: string }>;
};

/**
 * Resumes a run's stream (the drawer was closed, the page reloaded, or the
 * send happened on another device): "run", the saved user message, the
 * stages so far and the answer preview, then live progress until the run
 * ends with assistant_message and done {status}. Leaving only detaches.
 */
export async function GET(request: NextRequest, { params }: Params) {
  let logContext: { workspaceId?: string; threadId?: string } = {};
  try {
    const { workspaceId, threadId, runId } = await params;
    logContext = { workspaceId, threadId };
    if (!Types.ObjectId.isValid(threadId) || !Types.ObjectId.isValid(runId)) {
      return NextResponse.json(
        { error: "Run not found", code: "airi_run_not_found" },
        { status: 404 }
      );
    }

    const context = await resolveAiriChatRouteContext(request, workspaceId);
    if (!context.ok) return context.response;

    await connectDB();

    const run = await findAiriChatRunForUser({
      runId,
      workspaceId,
      threadId,
      userId: context.user.id,
    });
    if (!run) {
      return NextResponse.json(
        { error: "Run not found", code: "airi_run_not_found" },
        { status: 404 }
      );
    }

    return createAiriChatRunStreamResponse({
      runId,
      signal: request.signal,
      supabase: context.supabase,
    });
  } catch (error) {
    return airiChatRequestFailureResponse(
      error,
      logContext,
      "Failed to resume the Airi answer",
      request.signal
    );
  }
}
