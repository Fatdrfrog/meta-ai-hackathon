import { LlmAnalyticsPage } from "@/components/analytics/llm-analytics-page";
import { PageHeader } from "@/components/ui/page-header";
import { resolveAnalyticsPageContext } from "@/features/panel/analytics/page-context";
import { getTranslations } from "next-intl/server";

export default async function LlmAnalyticsRoute({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<{ days?: string | string[] }>;
}) {
  const { workspaceId, daysPeriod } = await resolveAnalyticsPageContext(
    params,
    searchParams
  );
  const t = await getTranslations("LlmAnalytics");

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t("pageTitle")} description={t("pageDescription")} />
      <LlmAnalyticsPage workspaceId={workspaceId} initialDays={daysPeriod} />
    </div>
  );
}
