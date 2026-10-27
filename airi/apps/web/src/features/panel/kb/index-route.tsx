import { Card, CardContent } from "@/components/ui/card";
import { getReadOnlySupabaseContext } from "@/features/panel/shared/workspace";
import { BookOpen, MousePointerClick } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";

export default async function WorkspaceKBPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const [{ workspaceId }, { supabase }, t] = await Promise.all([
    params,
    getReadOnlySupabaseContext(),
    getTranslations("KnowledgeBase"),
  ]);

  // Check if there are any articles - if so, redirect to the first root one
  const { data: firstArticle } = await supabase
    .from("kb_articles")
    .select("id")
    .eq("workspace_id", workspaceId)
    .is("parent_id", null)
    .order("sort_order", { ascending: true })
    .limit(1)
    .maybeSingle();

  // If there's at least one article, redirect to it
  if (firstArticle) {
    redirect(`/panel/w/${workspaceId}/kb/${firstArticle.id}`);
  }

  // Otherwise, show empty state
  return (
    <div className="flex items-center justify-center h-full p-6">
      <Card className="max-w-md">
        <CardContent className="flex flex-col items-center justify-center py-12 px-8">
          <div className="text-center space-y-4">
            <div className="w-16 h-16 bg-muted rounded-full flex items-center justify-center mx-auto">
              <BookOpen className="h-8 w-8 text-muted-foreground" />
            </div>
            <div>
              <h3 className="text-lg font-semibold">{t("emptyState.title")}</h3>
              <p className="text-muted-foreground mt-2 text-sm">
                {t("emptyState.description")}
              </p>
            </div>
            <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground pt-4">
              <MousePointerClick className="h-4 w-4" />
              <span>{t("emptyState.hint")}</span>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
