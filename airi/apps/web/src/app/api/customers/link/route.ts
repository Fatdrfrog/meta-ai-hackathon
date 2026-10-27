import { linkConversations } from "@/lib/customers/service";
import connectDB from "@/lib/mongoose";
import { verifyWorkspaceAccess } from "@/lib/sources/utils";
import { createClient } from "@/lib/supabase/server";
import { getWorkspaceFeatureFlags } from "@/lib/workspace-feature-flags";
import { Conversation } from "@/models/conversation";
import { NextRequest, NextResponse } from "next/server";

type LinkRequestBody = {
  sourceConversationId?: string;
  targetConversationId?: string;
  linkMethod?: "manual" | "suggested" | "rule";
  linkConfidence?: number | null;
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

    const body = (await request.json()) as LinkRequestBody;
    if (!body.sourceConversationId || !body.targetConversationId) {
      return NextResponse.json(
        { error: "sourceConversationId and targetConversationId are required" },
        { status: 400 }
      );
    }

    await connectDB();

    const sourceConversation = await Conversation.findById(
      body.sourceConversationId
    )
      .select("workspaceId")
      .lean<{ workspaceId?: string } | null>();

    if (!sourceConversation?.workspaceId) {
      return NextResponse.json(
        { error: "Source conversation not found" },
        { status: 404 }
      );
    }

    const hasAccess = await verifyWorkspaceAccess(
      supabase,
      user.id,
      sourceConversation.workspaceId
    );
    if (!hasAccess) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const flags = await getWorkspaceFeatureFlags(
      sourceConversation.workspaceId,
      ["customer_identity"]
    );
    if (!flags.customer_identity) {
      return NextResponse.json({ error: "Feature disabled" }, { status: 404 });
    }

    const customer = await linkConversations({
      sourceConversationId: body.sourceConversationId,
      targetConversationId: body.targetConversationId,
      actor: {
        type: "manager",
        userId: user.id,
        label: "manual_link",
      },
      linkMethod: body.linkMethod || "manual",
      linkConfidence:
        typeof body.linkConfidence === "number" ? body.linkConfidence : null,
    });

    return NextResponse.json({
      success: true,
      customer,
    });
  } catch (error) {
    console.error("[Customer Link API] POST failed", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to link conversations",
      },
      { status: 500 }
    );
  }
}
