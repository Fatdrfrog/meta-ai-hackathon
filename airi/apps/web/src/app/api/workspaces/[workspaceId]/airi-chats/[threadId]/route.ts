import connectDB from "@/lib/mongoose";
import {
  archiveAiriChatThreadForUser,
  getAiriChatThreadForUser,
  serializeAiriChatThread,
} from "@/lib/airi-chats/service";
import { resolveAiriChatRouteContext } from "@/lib/airi-chats/route-context";
import { getAiriChatActiveRun } from "@/lib/airi-chats/runs";
import { NextRequest, NextResponse } from "next/server";
import { Types } from "mongoose";
import { z } from "zod";
import { zodErrorResponse } from "@/lib/api/json-body";

export const runtime = "nodejs";

type Params = { params: Promise<{ workspaceId: string; threadId: string }> };
type SerializableThread = Parameters<typeof serializeAiriChatThread>[0];

const updateThreadSchema = z
  .object({
    title: z.string().trim().min(1).max(120).optional(),
    pinned: z.boolean().optional(),
  })
  .refine(data => data.title !== undefined || data.pinned !== undefined, {
    message: "No thread updates provided",
  });

export async function GET(request: NextRequest, { params }: Params) {
  try {
    const { workspaceId, threadId } = await params;
    if (!Types.ObjectId.isValid(threadId)) {
      return NextResponse.json({ error: "Chat not found" }, { status: 404 });
    }

    const context = await resolveAiriChatRouteContext(request, workspaceId);
    if (!context.ok) return context.response;

    await connectDB();

    const thread = await getAiriChatThreadForUser({
      workspaceId,
      userId: context.user.id,
      threadId,
    });
    if (!thread) {
      return NextResponse.json({ error: "Chat not found" }, { status: 404 });
    }

    // A run that lost its process is reconciled here (interrupted, with its
    // failure reply saved), so a returning client never waits on it.
    const activeRun = await getAiriChatActiveRun({
      workspaceId,
      threadId,
      supabase: context.supabase,
    });
    return NextResponse.json({
      thread: serializeAiriChatThread(
        thread.toObject() as unknown as SerializableThread
      ),
      activeRun,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to load Airi chat";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest, { params }: Params) {
  try {
    const { workspaceId, threadId } = await params;
    if (!Types.ObjectId.isValid(threadId)) {
      return NextResponse.json({ error: "Chat not found" }, { status: 404 });
    }

    const context = await resolveAiriChatRouteContext(request, workspaceId);
    if (!context.ok) return context.response;

    const body = await request.json().catch(() => ({}));
    const parsed = updateThreadSchema.safeParse(body);
    if (!parsed.success) return zodErrorResponse(parsed.error);

    await connectDB();

    const thread = await getAiriChatThreadForUser({
      workspaceId,
      userId: context.user.id,
      threadId,
    });
    if (!thread) {
      return NextResponse.json({ error: "Chat not found" }, { status: 404 });
    }

    if (parsed.data.title) {
      thread.title = parsed.data.title;
    }
    if (typeof parsed.data.pinned === "boolean") {
      thread.pinnedAt = parsed.data.pinned ? new Date() : null;
    }
    await thread.save();

    return NextResponse.json({
      thread: serializeAiriChatThread(
        thread.toObject() as unknown as SerializableThread
      ),
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to update Airi chat";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest, { params }: Params) {
  try {
    const { workspaceId, threadId } = await params;
    if (!Types.ObjectId.isValid(threadId)) {
      return NextResponse.json({ error: "Chat not found" }, { status: 404 });
    }

    const context = await resolveAiriChatRouteContext(request, workspaceId);
    if (!context.ok) return context.response;

    await connectDB();

    const archived = await archiveAiriChatThreadForUser({
      workspaceId,
      userId: context.user.id,
      threadId,
    });
    if (!archived) {
      return NextResponse.json({ error: "Chat not found" }, { status: 404 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to archive Airi chat";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
