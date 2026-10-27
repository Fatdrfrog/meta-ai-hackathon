import connectDB from "@/lib/mongoose";
import {
  getAiriChatThreadForUser,
  listAiriChatMessagePage,
} from "@/lib/airi-chats/service";
import { airiChatMessageBodySchema } from "@/lib/airi-chats/request-schemas";
import {
  admitAiriChatMessageRequest,
  airiChatRequestFailureResponse,
  airiChatRunActiveResponse,
  resolveAiriChatRouteContext,
  scheduleAiriChatStudioChatQuota,
} from "@/lib/airi-chats/route-context";
import {
  awaitAiriChatRunTurn,
  getAiriChatActiveRun,
  startAiriChatRun,
} from "@/lib/airi-chats/runs";
import { Types } from "mongoose";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { zodErrorResponse } from "@/lib/api/json-body";

export const runtime = "nodejs";
// A run (retrieval, generation, Meta Ads tools) can outlast the default.
export const maxDuration = 300;

type Params = { params: Promise<{ workspaceId: string; threadId: string }> };

/** ?before=<messageId>&limit=N (default 50, at most 100). */
const messagePageQuerySchema = z.object({
  before: z
    .string()
    .refine(value => Types.ObjectId.isValid(value), "Invalid message cursor")
    .optional(),
  limit: z.coerce.number().int().min(1).optional(),
});

export async function GET(request: NextRequest, { params }: Params) {
  let logContext: { workspaceId?: string; threadId?: string } = {};
  try {
    const { workspaceId, threadId } = await params;
    logContext = { workspaceId, threadId };
    if (!Types.ObjectId.isValid(threadId)) {
      return NextResponse.json({ error: "Chat not found" }, { status: 404 });
    }

    const context = await resolveAiriChatRouteContext(request, workspaceId);
    if (!context.ok) return context.response;

    const searchParams = new URL(request.url).searchParams;
    const query = messagePageQuerySchema.safeParse({
      before: searchParams.get("before") ?? undefined,
      limit: searchParams.get("limit") ?? undefined,
    });
    if (!query.success)
      return zodErrorResponse(query.error, {
        fallback: "Invalid request",
        code: "invalid_request",
      });

    await connectDB();

    const thread = await getAiriChatThreadForUser({
      workspaceId,
      userId: context.user.id,
      threadId,
    });
    if (!thread) {
      return NextResponse.json({ error: "Chat not found" }, { status: 404 });
    }

    // The run first: reconciling an interrupted run saves its failure reply,
    // which this page then includes.
    const activeRun = await getAiriChatActiveRun({
      workspaceId,
      threadId,
      supabase: context.supabase,
    });
    const page = await listAiriChatMessagePage({
      workspaceId,
      threadId,
      before: query.data.before,
      limit: query.data.limit,
    });
    return NextResponse.json({ ...page, activeRun });
  } catch (error) {
    return airiChatRequestFailureResponse(
      error,
      logContext,
      "Failed to load Airi messages"
    );
  }
}

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

    // Start the durable run and wait for it: the response shape stays the
    // same (mobile), and a dropped request does not stop the answer.
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
    const turn = await awaitAiriChatRunTurn(start, {
      supabase: auth.supabase,
    });
    return NextResponse.json(turn);
  } catch (error) {
    return airiChatRequestFailureResponse(
      error,
      logContext,
      undefined,
      request.signal
    );
  }
}
