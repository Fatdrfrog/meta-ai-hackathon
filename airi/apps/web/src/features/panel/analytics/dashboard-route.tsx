import { AnalyticsLayout } from "@/components/analytics/analytics-layout";
import { DashboardPageClient } from "@/components/dashboard/dashboard-page-client";
import { PageHeader } from "@/components/ui/page-header";
import { getTranslations } from "next-intl/server";

export default async function DashboardPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  const t = await getTranslations("DashboardPage.header");

  return (
    <AnalyticsLayout workspaceId={workspaceId}>
      <div className="flex flex-col gap-6">
        <PageHeader
          title={t("title")}
          description={t("description")}
        />
        <DashboardPageClient workspaceId={workspaceId} />
      </div>
    </AnalyticsLayout>
  );
}
