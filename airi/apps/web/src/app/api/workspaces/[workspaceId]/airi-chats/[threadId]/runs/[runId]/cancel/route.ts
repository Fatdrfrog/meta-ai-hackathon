import connectDB from "@/lib/mongoose";
import {
  airiChatRequestFailureResponse,
  resolveAiriChatRouteContext,
} from "@/lib/airi-chats/route-context";
import {
  cancelLiveAiriChatRun,
  requestAiriChatRunCancel,
} from "@/lib/airi-chats/runs";
import { Types } from "mongoose";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

type Params = {
  params: Promise<{ workspaceId: string; threadId: string; runId: string }>;
};

/**
 * The composer's Stop. Records the request on the run (the engine polls for
 * it about every second, wherever it runs) and stops a run executing on
 * this instance at once. The run then saves the answer so far, or a short
 * "Stopped." note, with metadata.cancelled. 202 also for a run that has
 * already ended: there is nothing left to stop.
 */
export async function POST(request: NextRequest, { params }: Params) {
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

    const run = await requestAiriChatRunCancel({
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
    if (run.status === "running") cancelLiveAiriChatRun(runId);

    return NextResponse.json({ runId, status: run.status }, { status: 202 });
  } catch (error) {
    return airiChatRequestFailureResponse(
      error,
      logContext,
      "Failed to stop the Airi answer"
    );
  }
}
