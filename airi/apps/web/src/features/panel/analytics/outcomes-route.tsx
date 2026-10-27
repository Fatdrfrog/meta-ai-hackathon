import { JourneyAnalytics } from "@/components/analytics/journey-analytics";
import { getReadOnlySupabaseUser } from "@/features/panel/shared/workspace/server-context";
import { redirect } from "next/navigation";

export default async function OutcomesRoute({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const [{ workspaceId }, user] = await Promise.all([
    params,
    getReadOnlySupabaseUser(),
  ]);
  if (!user) redirect("/login");

  return (
    <JourneyAnalytics
      key={`${workspaceId}:${user.id}`}
      workspaceId={workspaceId}
      memberId={user.id}
    />
  );
}
