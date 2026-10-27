import { WhatsAppReconnectBanner } from "@/components/whatsapp/reconnect-banner";
import { hasCompletedProfile } from "@/lib/auth/setup-router";
import {
  AlertListener,
  LayoutContent,
  PanelMain,
  SiteHeader,
} from "@/features/panel/shared/shell";
import { LastVisitedPageRecorder } from "./last-visited-page-recorder";
import { getReadOnlySupabaseUser } from "@/features/panel/shared/workspace";
import { redirect } from "next/navigation";
import { Suspense } from "react";

export default async function LayoutDashboard({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ workspaceId: string }>;
}) {
  const [{ workspaceId }, user] = await Promise.all([
    params,
    getReadOnlySupabaseUser(),
  ]);

  if (!user) {
    redirect("/login");
  }

  if (!hasCompletedProfile(user.user_metadata)) {
    redirect("/setup");
  }

  return (
    <LayoutContent workspaceId={workspaceId}>
      <Suspense fallback={null}>
        <LastVisitedPageRecorder />
      </Suspense>
      <SiteHeader workspaceId={workspaceId} />
      <AlertListener workspaceId={workspaceId} />
      <Suspense fallback={null}>
        <WhatsAppReconnectBanner workspaceId={workspaceId} userId={user.id} />
      </Suspense>
      <PanelMain>{children}</PanelMain>
      {/* TODO(widget): re-introduce dashboard preview once Shadow DOM widget bundle is ready. */}
    </LayoutContent>
  );
}
