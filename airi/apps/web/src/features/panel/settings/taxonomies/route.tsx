import { TaxonomyEditor } from "@/components/admin/taxonomy-editor";
import { PageHeader } from "@/components/ui/page-header";
import { DEFAULT_TAXONOMY } from "@/lib/classifier/taxonomy";
import { getReadOnlySupabaseContext } from "@/features/panel/shared/workspace";
import { getTranslations } from "next-intl/server";

interface PageProps {
  params: Promise<{
    workspaceId: string;
  }>;
}

export default async function TaxonomiesPage({ params }: PageProps) {
  const [{ workspaceId }, { supabase }, t] = await Promise.all([
    params,
    getReadOnlySupabaseContext(),
    getTranslations("TaxonomiesPage"),
  ]);

  const { data, error } = await supabase
    .from("taxonomies")
    .select(
      "id, workspace_id, vertical, labels, guidelines, few_shots, confidence_threshold, version, updated_at"
    )
    .eq("workspace_id", workspaceId)
    .order("updated_at", { ascending: false })
    .limit(10);

  const items = error ? [] : data || [];

  return (
    <div className="flex min-w-0 flex-col gap-4 overflow-x-hidden p-3 sm:gap-6 sm:p-4 lg:p-6">
      <PageHeader title={t("title")} description={t("description")} />

      <TaxonomyEditor initialItems={items} defaultTemplate={DEFAULT_TAXONOMY} />
    </div>
  );
}
