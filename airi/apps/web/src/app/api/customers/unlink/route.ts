import { unlinkConversation } from "@/lib/customers/service";
import connectDB from "@/lib/mongoose";
import { verifyWorkspaceAccess } from "@/lib/sources/utils";
import { createClient } from "@/lib/supabase/server";
import { getWorkspaceFeatureFlags } from "@/lib/workspace-feature-flags";
import { Conversation } from "@/models/conversation";
import { NextRequest, NextResponse } from "next/server";
import { requiredFieldResponse } from "@/lib/api/json-body";

type UnlinkRequestBody = {
  conversationId?: string;
};

export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = (await request.json()) as UnlinkRequestBody;
    if (!body.conversationId) return requiredFieldResponse("conversationId");

    await connectDB();

    const conversation = await Conversation.findById(body.conversationId)
      .select("workspaceId")
      .lean<{ workspaceId?: string } | null>();

    if (!conversation?.workspaceId) {
      return NextResponse.json(
        { error: "Conversation not found" },
        { status: 404 }
      );
    }

    const hasAccess = await verifyWorkspaceAccess(
      supabase,
      user.id,
      conversation.workspaceId
    );
    if (!hasAccess) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const flags = await getWorkspaceFeatureFlags(conversation.workspaceId, [
      "customer_identity",
    ]);
    if (!flags.customer_identity) {
      return NextResponse.json({ error: "Feature disabled" }, { status: 404 });
    }

    const customer = await unlinkConversation({
      conversationId: body.conversationId,
      actor: {
        type: "manager",
        userId: user.id,
        label: "manual_unlink",
      },
    });

    return NextResponse.json({
      success: true,
      customer,
    });
  } catch (error) {
    console.error("[Customer Unlink API] POST failed", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to unlink conversation",
      },
      { status: 500 }
    );
  }
}
