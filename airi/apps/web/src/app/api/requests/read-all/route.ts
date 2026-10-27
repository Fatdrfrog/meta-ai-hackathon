import { invalidateRequestsForWorkspace } from "@/lib/cache";
import connectDB from "@/lib/mongoose";
import { triggerRealtimeEvent } from "@/lib/realtime/server";
import { createClient } from "@/lib/supabase/server";
import { Conversation } from "@/models/conversation";
import { NextResponse } from "next/server";
import { checkUserWorkspaceAccess } from "@/lib/supabase/queries";
import { requiredFieldResponse } from "@/lib/api/json-body";

const READ_ALL_REALTIME_LIMIT = 200;

type ReadAllRequestBody = {
  workspaceId: string;
};

async function parseReadAllRequestBody(
  request: Request
): Promise<ReadAllRequestBody | null> {
  let body: unknown;
  try {
    body = JSON.parse(await request.text());
  } catch {
    return null;
  }
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.getPrototypeOf(body) !== Object.prototype ||
    Object.keys(body).length !== 1 ||
    !("workspaceId" in body) ||
    typeof body.workspaceId !== "string"
  ) {
    return null;
  }
  const workspaceId = body.workspaceId.trim();
  return workspaceId ? { workspaceId } : null;
}

export async function POST(request: Request) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await parseReadAllRequestBody(request);

    if (!body) return requiredFieldResponse("workspaceId");
    const { workspaceId } = body;

    if (!(await checkUserWorkspaceAccess(supabase, user.id, workspaceId))) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    await connectDB();

    const unreadConversations = await Conversation.find({
      workspaceId,
      is_read_by_manager: { $ne: true },
    })
      .select("_id")
      .limit(READ_ALL_REALTIME_LIMIT)
      .lean<{ _id: unknown }[]>()
      .exec();

    const updateResult = await Conversation.updateMany(
      {
        workspaceId,
        is_read_by_manager: { $ne: true },
      },
      {
        $set: { is_read_by_manager: true },
      }
    );
    const readAt = new Date().toISOString();

    try {
      await invalidateRequestsForWorkspace(workspaceId);
    } catch {
      // Non-blocking cache invalidation.
    }

    if ((updateResult.modifiedCount ?? 0) > 0) {
      await Promise.allSettled(
        unreadConversations.map(conversation =>
          triggerRealtimeEvent(`tenant-${workspaceId}`, "requests.update", {
            _id: String(conversation._id),
            conversationId: String(conversation._id),
            workspaceId,
          })
        )
      );
    }

    return NextResponse.json({ readAt });
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
}
