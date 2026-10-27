import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { verifyWorkspaceAccess } from "@/lib/sources/utils";
import {
  readJsonBodyWithinLimit,
  JsonBodyTooLargeError,
  InvalidJsonBodyError,
} from "@/lib/api/json-body";
import { isCustomerContactPolicy } from "@icecore/scenario-contracts";
import {
  recordCustomerBehaviorEvent,
  CustomerBehaviorEventError,
} from "@/lib/customers/behavior-events";
import { loadCustomerContactPolicy } from "@/lib/campaign/customer-contact-policy";
import CustomerContactPolicy from "@/models/customer-contact-policy";
import ScenarioBehaviorRun from "@/models/scenario-behavior-run";
import { Conversation } from "@/models/conversation";
import connectDB from "@/lib/mongoose";

async function authorize(request: NextRequest) {
  const workspaceId = request.nextUrl.searchParams.get("workspaceId") || "";
  if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(workspaceId))
    throw new CustomerBehaviorEventError("Invalid workspace", 400);
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new CustomerBehaviorEventError("Unauthorized", 401);
  if (!(await verifyWorkspaceAccess(supabase, user.id, workspaceId)))
    throw new CustomerBehaviorEventError("Forbidden", 403);
  return { workspaceId, userId: user.id };
}
function errorResponse(error: unknown) {
  const status =
    error instanceof CustomerBehaviorEventError
      ? error.status
      : error instanceof JsonBodyTooLargeError
        ? 413
        : error instanceof InvalidJsonBodyError || error instanceof SyntaxError
          ? 400
          : 500;
  return NextResponse.json(
    {
      error:
        error instanceof CustomerBehaviorEventError
          ? error.message
          : "Customer journey request failed",
    },
    { status }
  );
}
export async function GET(request: NextRequest) {
  try {
    const { workspaceId } = await authorize(request);
    await connectDB();
    const conversationId = request.nextUrl.searchParams.get("conversationId");
    if (
      conversationId &&
      (!/^[a-f0-9]{24}$/i.test(conversationId) ||
        !(await Conversation.exists({ _id: conversationId, workspaceId })))
    )
      throw new CustomerBehaviorEventError("Conversation not found", 404);
    const runs = conversationId
      ? await ScenarioBehaviorRun.find({ workspaceId, conversationId })
          .sort({ createdAt: -1, _id: -1 })
          .limit(20)
          .select("config.preset status reason dueAt referenceId")
          .lean()
      : [];
    return NextResponse.json({
      policy: await loadCustomerContactPolicy(workspaceId),
      runs,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
export async function POST(request: NextRequest) {
  try {
    const auth = await authorize(request);
    const event = await readJsonBodyWithinLimit(request, 16 * 1024);
    return NextResponse.json(
      await recordCustomerBehaviorEvent({ ...auth, event })
    );
  } catch (error) {
    return errorResponse(error);
  }
}
export async function PATCH(request: NextRequest) {
  try {
    const { workspaceId } = await authorize(request);
    const policy = await readJsonBodyWithinLimit(request, 1024);
    if (!isCustomerContactPolicy(policy))
      throw new CustomerBehaviorEventError("Invalid contact policy", 400);
    await connectDB();
    await CustomerContactPolicy.updateOne(
      { workspaceId },
      {
        $set: {
          minIntervalHours: policy.minIntervalHours,
          maxPerWeek: policy.maxPerWeek,
        },
      },
      { upsert: true }
    );
    return NextResponse.json({ success: true });
  } catch (error) {
    return errorResponse(error);
  }
}
