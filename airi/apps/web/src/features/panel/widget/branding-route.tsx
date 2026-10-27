import { WidgetBrandingEditor } from "@/components/widget/widget-branding-editor";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { getReadOnlySupabaseContext } from "@/features/panel/shared/workspace";
import { getWorkspaceRecommendedQuickReplies } from "@/lib/widget/quick-reply-recommendations";
import type { Source } from "@/types/supabase";
import { Palette } from "lucide-react";
import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { redirect } from "next/navigation";

interface PageProps {
  params: Promise<{
    workspaceId: string;
  }>;
}

export default async function WidgetBrandingPage({ params }: PageProps) {
  const [{ workspaceId }, { supabase, user }, t] = await Promise.all([
    params,
    getReadOnlySupabaseContext(),
    getTranslations("WidgetBrandingPage"),
  ]);

  if (!user) {
    redirect("/login");
  }

  const { data: companyUser } = await supabase
    .from("company_users")
    .select("workspace_id")
    .eq("user_id", user.id)
    .eq("workspace_id", workspaceId)
    .single();

  if (!companyUser) {
    redirect("/panel");
  }

  const { data: widgetSource } = await supabase
    .from("sources")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("type", "web_widget")
    .maybeSingle();

  const recommendedQuickReplies = widgetSource
    ? await getWorkspaceRecommendedQuickReplies(workspaceId)
    : [];

  return (
    <div className="h-full overflow-y-auto px-4 py-4 lg:px-6 lg:py-6">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
        <PageHeader title={t("title")} description={t("description")} />

        {widgetSource ? (
          <WidgetBrandingEditor
            source={widgetSource as Source}
            recommendedQuickReplies={recommendedQuickReplies}
          />
        ) : (
          <div className="flex flex-col items-center justify-center rounded-lg border-2 border-dashed px-4 py-12">
            <Palette className="mb-4 h-12 w-12 text-muted-foreground" />
            <h3 className="mb-2 text-lg font-semibold">{t("empty.title")}</h3>
            <p className="mb-4 max-w-md text-center text-sm text-muted-foreground">
              {t("empty.description")}
            </p>
            <Button asChild size="sm">
              <Link href={`/panel/w/${workspaceId}/settings/integrations`}>
                {t("empty.cta")}
              </Link>
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
