import { DashboardPageClient } from "@/components/dashboard/dashboard-page-client";
import { PageHeader } from "@/components/ui/page-header";
import { getTranslations } from "next-intl/server";
import { getReadOnlySupabaseUser } from "@/features/panel/shared/workspace/server-context";
import { redirect } from "next/navigation";

export default async function AnalyticsOverviewRoute({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const [{ workspaceId }, user, t] = await Promise.all([
    params,
    getReadOnlySupabaseUser(),
    getTranslations("DashboardClientPage.board"),
  ]);
  if (!user) redirect("/login");

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <PageHeader title={t("title")} description={t("description")} />
      <DashboardPageClient
        key={workspaceId}
        workspaceId={workspaceId}
        customizable
        memberId={user.id}
      />
    </div>
  );
}
