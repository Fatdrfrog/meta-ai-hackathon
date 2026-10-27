import { getHiddenConversationPlanGateResponse } from "@/lib/limits/company-limits";
import connectDB from "@/lib/mongoose";
import { createClient } from "@/lib/supabase/server";
import { applyClearedHandoffStateToConversation } from "@/lib/airi/reply/runtime/handoff-state";
import { getWorkspaceScenariosDefault } from "@/lib/airi/workspace-bot-default";
import { resolveConversationScenariosEnabled } from "@/lib/airi/workspace-bot-contract";
import { Conversation } from "@/models/conversation";
import { NextResponse } from "next/server";
import { checkUserWorkspaceAccess } from "@/lib/supabase/queries";

type Params = Promise<{ id: string }>;

export async function PATCH(request: Request, { params }: { params: Params }) {
  try {
    const { id } = await params;
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = (await request.json()) as {
      bot_enabled?: boolean; // AI bot auto-replies
      scenario_enabled?: boolean; // AI scenarios
      coach_enabled?: boolean; // AI coaching suggestions
    };
    const { bot_enabled, scenario_enabled, coach_enabled } = body || {};

    await connectDB();
    const conversation = await Conversation.findById(id);
    if (!conversation)
      return NextResponse.json(
        { error: "Conversation not found" },
        { status: 404 }
      );

    // Verify user has access to the workspace this conversation belongs to
    const workspaceId = conversation.workspaceId;
    const access = await checkUserWorkspaceAccess(
      supabase,
      user.id,
      workspaceId
    );

    if (!access) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    const planGateResponse = await getHiddenConversationPlanGateResponse(
      supabase,
      workspaceId,
      id
    );
    if (planGateResponse) {
      return planGateResponse;
    }

    if (typeof bot_enabled === "boolean") {
      if (typeof conversation.get("airi_scenarios_enabled") !== "boolean") {
        conversation.set(
          "airi_scenarios_enabled",
          resolveConversationScenariosEnabled(
            {
              airi_bot_enabled: conversation.get("airi_bot_enabled") as
                | boolean
                | null
                | undefined,
              airi_enabled: conversation.get("airi_enabled") as
                | boolean
                | null
                | undefined,
            },
            await getWorkspaceScenariosDefault(workspaceId)
          )
        );
      }
      conversation.set("airi_bot_enabled", bot_enabled);
    }
    if (typeof scenario_enabled === "boolean") {
      conversation.set("airi_scenarios_enabled", scenario_enabled);
    }
    if (typeof coach_enabled === "boolean") {
      conversation.set("airi_coach_enabled", coach_enabled);
    }

    if (bot_enabled === true && conversation.get("airi_handoff_active")) {
      applyClearedHandoffStateToConversation(conversation);
    }

    await conversation.save();

    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
