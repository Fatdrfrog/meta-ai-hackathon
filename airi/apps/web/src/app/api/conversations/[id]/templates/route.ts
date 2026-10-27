import connectDB from "@/lib/mongoose";
import { errorMessageResponse } from "@/lib/api/json-body";
import { getHiddenConversationPlanGateResponse } from "@/lib/limits/company-limits";
import { createClient } from "@/lib/supabase/server";
import { listApprovedWhatsAppTemplatesForSend } from "@/lib/whatsapp/templates/send-lookup";
import { Conversation } from "@/models/conversation";
import { getTemplateVariables } from "@icecore/shared/types/whatsapp";
import { NextResponse } from "next/server";
import { checkUserWorkspaceAccess } from "@/lib/supabase/queries";

type Params = Promise<{ id: string }>;

/**
 * GET list of available WhatsApp templates for a conversation
 * This allows the UI to show a dropdown of approved templates
 */
export async function GET(_request: Request, { params }: { params: Params }) {
  const [{ id: conversationId }, supabase] = await Promise.all([
    params,
    createClient(),
  ]);
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    await connectDB();

    const conversation = await Conversation.findById(conversationId)
      .select("workspaceId channel sourceId")
      .lean<{
        workspaceId: string;
        channel?: string;
        sourceId?: string | null;
      } | null>();

    if (!conversation) {
      return NextResponse.json(
        { error: "Conversation not found" },
        { status: 404 }
      );
    }

    // Verify channel is WhatsApp
    if (conversation.channel !== "whatsapp") {
      return NextResponse.json({ templates: [] });
    }

    const { workspaceId } = conversation;
    const access = await checkUserWorkspaceAccess(
      supabase,
      user.id,
      workspaceId
    );

    if (!access) {
      return NextResponse.json(
        { error: "Access denied to this conversation" },
        { status: 403 }
      );
    }

    const planGateResponse = await getHiddenConversationPlanGateResponse(
      supabase,
      workspaceId,
      conversationId
    );
    if (planGateResponse) {
      return planGateResponse;
    }

    // List the WABA the send-template route sends from: the conversation's own
    // source, not the workspace's newest WhatsApp connection.
    const sourceId =
      typeof conversation.sourceId === "string"
        ? conversation.sourceId.trim()
        : "";
    const templates = await listApprovedWhatsAppTemplatesForSend(
      workspaceId,
      sourceId ? { sourceId } : {}
    );

    return NextResponse.json({
      templates: templates
        .map(t => ({
          name: t.name,
          language: t.language,
          category: t.category,
          status: t.status,
          components: t.components,
          variables: getTemplateVariables(t),
        }))
        .sort(
          (a, b) =>
            a.name.localeCompare(b.name) || a.language.localeCompare(b.language)
        ),
    });
  } catch (error) {
    return errorMessageResponse(error, 500);
  }
}
