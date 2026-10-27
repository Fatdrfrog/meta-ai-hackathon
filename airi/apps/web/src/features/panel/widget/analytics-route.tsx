import { WidgetUrlAnalytics } from "@/components/analytics/widget-url-analytics";
import { AnalyticsLayout } from "@/components/analytics/analytics-layout";
import { ScopedIntlProvider } from "@/components/i18n/scoped-intl-provider";
import { Button } from "@/components/ui/button";
import { getReadOnlySupabaseContext } from "@/features/panel/shared/workspace";
import {
  getLocaleFromCookie,
  loadAnalyticsClientMessages,
} from "@/i18n/message-loader";
import { findPrimaryWebWidgetSource } from "@/lib/widget/source-selection";
import type { Source } from "@/types/supabase";
import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { redirect } from "next/navigation";

interface PageProps {
  params: Promise<{
    workspaceId: string;
  }>;
}

export default async function WidgetAnalyticsPage({ params }: PageProps) {
  const [{ workspaceId }, { supabase, user }, t, locale] = await Promise.all([
    params,
    getReadOnlySupabaseContext(),
    getTranslations("WidgetAnalytics"),
    getLocaleFromCookie(),
  ]);

  if (!user) {
    redirect("/login");
  }

  // Get workspace and company info
  const { data: companyUser } = await supabase
    .from("company_users")
    .select("workspace_id")
    .eq("user_id", user.id)
    .eq("workspace_id", workspaceId)
    .single();

  if (!companyUser) {
    redirect("/panel");
  }

  const { data: widgetSources } = await supabase
    .from("sources")
    .select("id, name, created_at, company_id, workspace_id, type, credentials")
    .eq("workspace_id", workspaceId)
    .eq("type", "web_widget")
    .order("created_at", { ascending: false })
    .limit(10);

  const widgetSource = findPrimaryWebWidgetSource(
    (widgetSources ?? []) as Source[]
  );
  const messages = await loadAnalyticsClientMessages(locale);

  return (
    <ScopedIntlProvider messages={messages}>
      <AnalyticsLayout workspaceId={workspaceId}>
        {widgetSource ? (
          <WidgetUrlAnalytics workspaceId={workspaceId} />
        ) : (
          <div className="mx-auto flex min-h-[min(36rem,70svh)] w-full max-w-3xl flex-col items-center justify-center px-4 py-12">
            <h3 className="mb-2 text-lg font-semibold">
              {t("emptyWidget.title")}
            </h3>
            <p className="mb-4 max-w-md text-center text-sm text-muted-foreground">
              {t("emptyWidget.description")}
            </p>
            <Button asChild size="sm">
              <Link href={`/panel/w/${workspaceId}/settings/integrations`}>
                {t("emptyWidget.cta")}
              </Link>
            </Button>
          </div>
        )}
      </AnalyticsLayout>
    </ScopedIntlProvider>
  );
}
