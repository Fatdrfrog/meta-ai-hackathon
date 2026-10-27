import "server-only";

import { resolveWorkspaceGoogleCreativeCredentials } from "@/lib/google/creative-credentials";
import { resolveWorkspaceElevenLabsGenerationAccess } from "@/lib/elevenlabs/elevenlabs-source";
import { resolveWorkspaceHiggsfieldGenerationAccess } from "@/lib/higgsfield/higgsfield-source";
import { isHiggsfieldWebhookConfigured } from "@/lib/higgsfield/higgsfield-webhook";
import type { createClient } from "@/lib/supabase/server";
import { isTemporalConfigured } from "@/lib/temporal/higgsfield-assets";
import { cleanString } from "@icecore/shared/lib/value-utils";
import type { AiriMarketingToolAccess } from "./marketing-package";

type SupabaseClient = Awaited<ReturnType<typeof createClient>>;
type SupabaseSourceClient = Pick<SupabaseClient, "from">;

type SourceRow = {
  id?: string | null;
  type?: string | null;
  name?: string | null;
};

const CREATIVE_SOURCE_TYPES = [
  "whatsapp",
  "canva",
  "higgsfield",
  "elevenlabs",
  "meta_ads",
] as const;

function integrationHref(workspaceId: string, integration: string) {
  return `/panel/w/${workspaceId}/settings/integrations?integration=${integration}`;
}

function firstSource(
  sources: SourceRow[],
  type: (typeof CREATIVE_SOURCE_TYPES)[number]
): SourceRow | null {
  return sources.find(source => cleanString(source.type, 240) === type) || null;
}

async function loadCreativeSources(params: {
  supabase: SupabaseSourceClient;
  workspaceId: string;
}): Promise<SourceRow[]> {
  const { data, error } = await params.supabase
    .from("sources")
    .select("id, type, name")
    .eq("workspace_id", params.workspaceId)
    .in("type", [...CREATIVE_SOURCE_TYPES]);

  if (error || !Array.isArray(data)) return [];
  return data
    .map(source => {
      const record = source as SourceRow;
      return {
        id: cleanString(record.id, 160) || null,
        type: cleanString(record.type, 80) || null,
        name: cleanString(record.name, 120) || null,
      };
    })
    .filter(source => Boolean(source.id && source.type));
}

function sourceLabel(source: SourceRow | null, fallback: string): string {
  return cleanString(source?.name, 80) || fallback;
}

export async function resolveAiriMarketingToolAccess(params: {
  supabase: SupabaseSourceClient;
  workspaceId: string;
}): Promise<AiriMarketingToolAccess> {
  const [sources, higgsfieldAccess, elevenLabsAccess, googleSourceId] =
    await Promise.all([
      loadCreativeSources(params),
      resolveWorkspaceHiggsfieldGenerationAccess(params),
      resolveWorkspaceElevenLabsGenerationAccess(params),
      resolveWorkspaceGoogleCreativeCredentials(params)
        .then(({ sourceId }) => sourceId)
        .catch(() => null),
    ]);

  const whatsapp = firstSource(sources, "whatsapp");
  const canva = firstSource(sources, "canva");
  const metaAds = firstSource(sources, "meta_ads");
  const canUseWorkspaceHiggsfield =
    higgsfieldAccess.available &&
    higgsfieldAccess.credentialSource === "workspace_source" &&
    isHiggsfieldWebhookConfigured() &&
    isTemporalConfigured();
  const canUseGoogle = Boolean(googleSourceId);
  const canUseWorkspaceElevenLabs =
    elevenLabsAccess.available &&
    elevenLabsAccess.credentialSource === "workspace_source" &&
    Boolean(elevenLabsAccess.apiKey);

  return {
    whatsapp: whatsapp
      ? {
          available: true,
          label: sourceLabel(whatsapp, "WhatsApp"),
          source: "workspace_source",
          sourceId: cleanString(whatsapp.id, 160),
          actionHref: `/panel/w/${params.workspaceId}/messengers/whatsapp-templates`,
        }
      : {
          available: false,
          label: "WhatsApp",
          source: "not_configured",
          reason: "Connect WhatsApp before creating templates or Flows.",
          actionHref: integrationHref(params.workspaceId, "whatsapp"),
        },
    scenarios: {
      available: true,
      label: "Scenarios",
      source: "built_in",
      actionHref: `/panel/w/${params.workspaceId}/scenarios`,
    },
    bulkCampaigns: {
      available: true,
      label: "Bulk campaigns",
      source: "built_in",
      actionHref: `/panel/w/${params.workspaceId}/bulk-campaigns`,
    },
    canva: canva
      ? {
          available: true,
          label: sourceLabel(canva, "Canva"),
          source: "workspace_source",
          sourceId: cleanString(canva.id, 160),
          actionHref: `/panel/w/${params.workspaceId}/assets`,
        }
      : {
          available: false,
          label: "Canva",
          source: "not_configured",
          reason: "Connect Canva to use approved brand templates.",
          actionHref: integrationHref(params.workspaceId, "canva"),
        },
    visualGeneration: canUseWorkspaceHiggsfield
      ? {
          available: true,
          label: "Higgsfield visual generation",
          source: "workspace_source",
          sourceId: higgsfieldAccess.sourceId || undefined,
          actionHref: `/panel/w/${params.workspaceId}/assets`,
        }
      : canUseGoogle
        ? {
            available: true,
            label: "Google visual generation",
            source: "workspace_source",
            sourceId: googleSourceId || undefined,
            actionHref: `/panel/w/${params.workspaceId}/assets`,
          }
        : {
            available: false,
            label: "Visual generation",
            source: "not_configured",
            reason:
              higgsfieldAccess.credentialSource === "workspace_source"
                ? "Higgsfield is connected, but webhook or Temporal generation is not configured."
                : "Connect your Google AI or Higgsfield credentials in Settings > Integrations to generate images and video.",
            actionHref: `/panel/w/${params.workspaceId}/assets`,
          },
    audioGeneration: canUseWorkspaceElevenLabs
      ? {
          available: true,
          label: "ElevenLabs audio generation",
          source: "workspace_source",
          sourceId: elevenLabsAccess.sourceId || undefined,
          actionHref: `/panel/w/${params.workspaceId}/assets`,
        }
      : {
          available: false,
          label: "Audio generation",
          source: "not_configured",
          reason:
            "Connect ElevenLabs in Settings > Integrations to generate voiceovers for this workspace.",
          actionHref: integrationHref(params.workspaceId, "elevenlabs"),
        },
    metaAds: metaAds
      ? {
          available: true,
          label: sourceLabel(metaAds, "Meta Ads"),
          source: "workspace_source",
          sourceId: cleanString(metaAds.id, 160),
          actionHref: `/panel/w/${params.workspaceId}/bulk-campaigns`,
        }
      : {
          available: false,
          label: "Meta Ads",
          source: "not_configured",
          reason: "Connect Meta Ads before ad planning or creative sync.",
          actionHref: integrationHref(params.workspaceId, "meta_ads"),
        },
  };
}
