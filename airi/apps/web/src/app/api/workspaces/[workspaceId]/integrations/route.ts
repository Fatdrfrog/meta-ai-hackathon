import {
  GOOGLE_AI_SOURCE_TYPE,
  toPublicGoogleAiCredentials,
} from "@/lib/google/google-ai-source";
import { toPublicWhatsAppConversionCredentials } from "@/lib/conversions/source-config";
import { getCompanyIdForWorkspace } from "@/lib/supabase/company-users";
import { getWorkspaceEmailProviderStatus } from "@/lib/email/provider-config";
import { toPublicElevenLabsCredentials } from "@/lib/elevenlabs/elevenlabs-source";
import {
  GOOGLE_CALENDAR_SOURCE_TYPE,
  toPublicGoogleCalendarCredentials,
} from "@/lib/google-calendar/google-calendar-source";
import { toPublicHiggsfieldCredentials } from "@/lib/higgsfield/higgsfield-source";
import { isRemovedWhatsAppSource } from "@/lib/integrations/source-status";
import {
  META_ADS_SOURCE_TYPE,
  toPublicMetaAdsCredentials,
} from "@/lib/meta-ads/meta-ads-source";
import { toPublicTelegramCredentials } from "@/lib/telegram/telegram-source";
import { resolveCompanyWhatsAppAccessToken } from "@/lib/whatsapp/company-access-token";
import { isOnboardingTestSource } from "@icecore/shared/types/sources";
import { NextRequest, NextResponse } from "next/server";
import { requireWorkspaceApiAccess } from "@/lib/supabase/workspace-api-access";

type Params = Promise<{ workspaceId: string }>;

export async function GET(
  _request: NextRequest,
  { params }: { params: Params }
) {
  const { workspaceId } = await params;

  try {
    const access = await requireWorkspaceApiAccess(workspaceId);
    if (!access.ok) return access.response;
    const { supabase } = access;

    // Parallel queries for better performance
    const [
      sourcesResult,
      emailSourcesResult,
      emailProviderStatus,
      companyId,
    ] = await Promise.all([
      supabase.from("sources").select("*").eq("workspace_id", workspaceId),
      supabase
        .from("workspace_email_addresses")
        .select(
          "id, local_part, full_address, created_at, status, kind, postmark_stream_outbound"
        )
        .eq("workspace_id", workspaceId)
        .eq("status", "active"),
      getWorkspaceEmailProviderStatus(workspaceId),
      getCompanyIdForWorkspace(supabase, workspaceId),
    ]);

    const emailProviderConnected = emailProviderStatus === "connected";

    // Integration screen is enabled globally; campaign rollout remains gated elsewhere.
    const emailIntegrationEnabled = true;

    const companyAccessToken = await resolveCompanyWhatsAppAccessToken({
      companyId,
    });
    const hasCompanyWhatsAppInventory = Boolean(companyAccessToken);

    const visibleSources = (sourcesResult.data ?? []).filter(
      source => !isOnboardingTestSource(source)
    );
    const toPublicSource = (source: (typeof visibleSources)[number]) => {
      if (source.type === GOOGLE_AI_SOURCE_TYPE) {
        return {
          ...source,
          credentials: toPublicGoogleAiCredentials(source.credentials),
        };
      }
      if (String(source.type) === "whatsapp") {
        return {
          ...source,
          credentials: toPublicWhatsAppConversionCredentials(
            source.credentials
          ),
        };
      }
      if (String(source.type) === "higgsfield") {
        return {
          ...source,
          credentials: toPublicHiggsfieldCredentials(source.credentials),
        };
      }
      if (String(source.type) === "elevenlabs") {
        return {
          ...source,
          credentials: toPublicElevenLabsCredentials(source.credentials),
        };
      }
      if (String(source.type) === GOOGLE_CALENDAR_SOURCE_TYPE) {
        return {
          ...source,
          credentials: toPublicGoogleCalendarCredentials(source.credentials),
        };
      }
      if (String(source.type) === META_ADS_SOURCE_TYPE) {
        return {
          ...source,
          credentials: toPublicMetaAdsCredentials(source.credentials),
        };
      }
      if (String(source.type) === "telegram") {
        return {
          ...source,
          credentials: toPublicTelegramCredentials(source.credentials),
        };
      }
      return source;
    };
    // Partner-removed WhatsApp sources are never usable channels, so they stay
    // out of `sources` (campaigns, setup and badges read it). Settings still
    // gets the newest one so it can offer the reconnect panel.
    const sources = visibleSources
      .filter(source => !isRemovedWhatsAppSource(source))
      .map(toPublicSource);
    const removedWhatsAppSource =
      visibleSources
        .filter(source => isRemovedWhatsAppSource(source))
        .sort(
          (a, b) =>
            (Date.parse(String(b.updated_at ?? "")) || 0) -
            (Date.parse(String(a.updated_at ?? "")) || 0)
        )
        .map(toPublicSource)[0] ?? null;

    return NextResponse.json({
      sources,
      removedWhatsAppSource,
      emailSources: emailSourcesResult.data ?? [],
      emailIntegrationEnabled,
      emailProviderStatus,
      emailProviderConnected,
      hasCompanyWhatsAppInventory,
    });
  } catch (error) {
    console.error("Error fetching integrations:", error);
    return NextResponse.json(
      { error: "Failed to fetch integrations" },
      { status: 500 }
    );
  }
}
