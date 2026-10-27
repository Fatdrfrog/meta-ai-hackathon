import { CreativeAssetsWorkspace } from "@/components/assets/creative-assets-workspace";
import { panelWorkspaceAiriHref } from "@/features/panel/shared/routing/hrefs";
import { getReadOnlySupabaseContext } from "@/features/panel/shared/workspace";
import {
  canUsePlatformFreeCreativeGeneration,
  getWorkspacePlatformCreativeGenerationQuota,
  type GoogleCreativeGenerationQuota,
} from "@/lib/google/creative-asset-quota";
import { resolveWorkspaceGoogleCreativeCredentials } from "@/lib/google/creative-credentials";
import { resolveWorkspaceElevenLabsGenerationAccess } from "@/lib/elevenlabs/elevenlabs-source";
import { resolveWorkspaceHiggsfieldGenerationAccess } from "@/lib/higgsfield/higgsfield-source";
import { isHiggsfieldWebhookConfigured } from "@/lib/higgsfield/higgsfield-webhook";
import connectDB from "@/lib/mongoose";
import { isTemporalConfigured } from "@/lib/temporal/higgsfield-assets";
import { redirect } from "next/navigation";
import { firstSearchParam } from "@/lib/api/query-params";

type Params = Promise<{ workspaceId: string }>;
type AssetsSearchParams = {
  airiAssetDraft?: string | string[];
};

export default async function AssetsPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: Promise<AssetsSearchParams>;
}) {
  const [{ workspaceId }, resolvedSearchParams, { supabase, user }] =
    await Promise.all([params, searchParams, getReadOnlySupabaseContext()]);

  if (!user) {
    redirect("/login");
  }

  const { data: membership } = await supabase
    .from("company_users")
    .select("workspace_id")
    .eq("user_id", user.id)
    .eq("workspace_id", workspaceId)
    .maybeSingle();

  if (!membership?.workspace_id) {
    redirect(panelWorkspaceAiriHref(workspaceId));
  }

  const [higgsfieldAccess, elevenLabsAccess, googleGenerationConfigured] =
    await Promise.all([
      resolveWorkspaceHiggsfieldGenerationAccess({ supabase, workspaceId }),
      resolveWorkspaceElevenLabsGenerationAccess({ supabase, workspaceId }),
      resolveWorkspaceGoogleCreativeCredentials({ supabase, workspaceId })
        .then(() => true)
        .catch(() => false),
    ]);
  let freeGenerations: GoogleCreativeGenerationQuota | null = null;
  try {
    await connectDB();
    freeGenerations =
      await getWorkspacePlatformCreativeGenerationQuota(workspaceId);
  } catch {
    freeGenerations = null;
  }
  const higgsfieldGenerationConfigured =
    higgsfieldAccess.available &&
    higgsfieldAccess.credentialSource === "workspace_source" &&
    isHiggsfieldWebhookConfigured() &&
    isTemporalConfigured();
  const elevenLabsConfigured =
    elevenLabsAccess.credentialSource === "workspace_source" ||
    Boolean(
      elevenLabsAccess.credentialSource === "platform" &&
        freeGenerations &&
        canUsePlatformFreeCreativeGeneration(freeGenerations)
    );
  const higgsfieldConfigured =
    higgsfieldGenerationConfigured || googleGenerationConfigured;

  return (
    <CreativeAssetsWorkspace
      workspaceId={workspaceId}
      higgsfieldConfigured={higgsfieldConfigured}
      openAiriAssetDraftOnMount={
        firstSearchParam(resolvedSearchParams.airiAssetDraft) === "1"
      }
      generationProvider={
        higgsfieldGenerationConfigured
          ? "higgsfield"
          : googleGenerationConfigured
            ? "google"
            : null
      }
      freeGenerations={freeGenerations}
      elevenLabsConfigured={elevenLabsConfigured}
      elevenLabsDisabledReason={
        elevenLabsConfigured ? null : elevenLabsAccess.reason
      }
      higgsfieldDisabledReason={
        higgsfieldConfigured
          ? null
          : higgsfieldAccess.reason || "source_required"
      }
      higgsfieldIntegrationUrl={`/panel/w/${workspaceId}/settings/integrations?integration=google_ai`}
      elevenLabsIntegrationUrl={`/panel/w/${workspaceId}/settings/integrations?integration=elevenlabs`}
      wanAvatarConfigured={false}
      wanMorphConfigured={false}
      happyHorseConfigured={false}
      alibabaImageConfigured={false}
    />
  );
}
