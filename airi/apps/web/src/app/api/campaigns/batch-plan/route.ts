import type { BulkCampaignBatchPlanPreviewResponse } from "@/lib/campaign/bulk-campaign-contracts";
import { resolveCampaignBatchPlanPreview } from "@/lib/campaign/campaign-batch-plan";
import { createClient } from "@/lib/supabase/server";
import { resolveWhatsAppSendContext } from "@/lib/whatsapp/send-context";
import { NextResponse } from "next/server";
import { checkUserWorkspaceAccess } from "@/lib/supabase/queries";

const ALLOWED_CHANNELS = new Set(["whatsapp", "telegram", "email"]);

export async function GET(request: Request) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const workspaceId = String(searchParams.get("workspaceId") || "").trim();
    const channel = String(searchParams.get("channel") || "").trim();

    if (!workspaceId || !ALLOWED_CHANNELS.has(channel)) {
      return NextResponse.json(
        { error: "workspaceId and a valid channel are required" },
        { status: 400 }
      );
    }

    if (!(await checkUserWorkspaceAccess(supabase, user.id, workspaceId))) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    if (channel === "whatsapp") {
      const sendContext = await resolveWhatsAppSendContext({
        workspaceId,
        ...(searchParams.get("sourceId")?.trim()
          ? { sourceId: searchParams.get("sourceId")!.trim() }
          : {}),
      });

      if (
        !sendContext?.sourceId ||
        !sendContext.phoneNumberId ||
        !sendContext.accessToken
      ) {
        return NextResponse.json({
          configured: false,
          channel,
          code: sendContext?.sourceId
            ? "whatsapp_credentials_incomplete"
            : "whatsapp_not_connected",
          error: "WhatsApp credentials are incomplete for this workspace.",
        } satisfies BulkCampaignBatchPlanPreviewResponse);
      }

      const preview = await resolveCampaignBatchPlanPreview({
        channel: "whatsapp",
        wabaId: sendContext.wabaId,
        phoneNumberId: sendContext.phoneNumberId,
        accessToken: sendContext.accessToken,
        cachedMessagingLimit: sendContext.cachedMessagingLimit,
      });

      return NextResponse.json(
        {
          configured: true,
          ...preview,
          whatsappMeta: preview.whatsappMeta
            ? {
                ...preview.whatsappMeta,
                sourceId: sendContext.sourceId,
              }
            : undefined,
        },
        { headers: { "Cache-Control": "private, no-store" } }
      );
    }

    const preview = await resolveCampaignBatchPlanPreview({
      channel: channel as "telegram" | "email",
    });

    return NextResponse.json({
      configured: true,
      ...preview,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}
