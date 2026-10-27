import { InternalLabelsManager } from "@/components/campaigns/internal-labels-manager";
import { TaxonomyManager } from "@/components/settings/taxonomy-manager";
import { PageHeader } from "@/components/ui/page-header";
import { ErrorState } from "@/components/ui/async-states";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DEFAULT_TAXONOMY } from "@/lib/classifier/taxonomy";
import { getReadOnlySupabaseContext } from "@/features/panel/shared/workspace";
import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";

export default async function TaxonomySettingsPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const [{ workspaceId }, { supabase, user }, t] = await Promise.all([
    params,
    getReadOnlySupabaseContext(),
    getTranslations("Settings"),
  ]);

  if (!user) {
    redirect("/login");
  }

  const taxonomyResult = await supabase
    .from("taxonomies")
    .select(
      "labels, guidelines, few_shots, confidence_threshold, version, updated_at"
    )
    .eq("workspace_id", workspaceId)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const currentTaxonomy = taxonomyResult.data || null;

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("taxonomyPageTitle")}
        description={t("taxonomyPageDescription")}
      />

      <Tabs defaultValue="topics" className="gap-4">
        <TabsList>
          <TabsTrigger value="topics">{t("classificationTopics")}</TabsTrigger>
          <TabsTrigger value="tags">{t("manualTags")}</TabsTrigger>
        </TabsList>
        <TabsContent value="topics">
          {taxonomyResult.error ? (
            <ErrorState message={t("taxonomyLoadFailed")} />
          ) : (
            <TaxonomyManager
              key={workspaceId}
              workspaceId={workspaceId}
              initialTaxonomy={currentTaxonomy}
              defaultTemplate={DEFAULT_TAXONOMY}
            />
          )}
        </TabsContent>
        <TabsContent value="tags">
          <InternalLabelsManager key={workspaceId} workspaceId={workspaceId} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
