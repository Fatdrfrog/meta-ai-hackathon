import { MessengersLayout } from "@/components/messengers/messengers-layout";
import { SourceRequiredState } from "@/components/onboarding/source-required-state";
import { UpgradeMessengerView } from "@/components/messengers/upgrade-messenger-view";
import { PageHeader } from "@/components/ui/page-header";
import { getReadOnlySupabaseContext } from "@/features/panel/shared/workspace";
import { getWorkspaceSourceReadiness } from "@/features/panel/shared/workspace/source-readiness";
import { redirect } from "next/navigation";

export default async function UpgradeMessengerPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const [{ workspaceId }, { supabase, user }] = await Promise.all([
    params,
    getReadOnlySupabaseContext(),
  ]);
  if (!user) redirect("/login");

  const sourceReadiness = await getWorkspaceSourceReadiness(
    supabase,
    workspaceId
  );
  const connectWhatsAppHref = `/panel/w/${workspaceId}/settings/integrations?integration=whatsapp`;

  return (
    <MessengersLayout workspaceId={workspaceId}>
      <div className="space-y-6">
        <PageHeader
          title="Official badge"
          description="Understand what Meta checks for Official Business Account approval, see your live readiness, and finish the setup work that actually matters."
        />
        {sourceReadiness.hasWhatsApp ? (
          <UpgradeMessengerView workspaceId={workspaceId} />
        ) : (
          <SourceRequiredState
            icon="whatsapp"
            title="Connect WhatsApp to check badge readiness"
            description="Official Business Account readiness depends on the connected WhatsApp Business account and phone number. Connect WhatsApp first so airi.chat can read the account status."
            primaryHref={connectWhatsAppHref}
            primaryLabel="Connect WhatsApp"
          />
        )}
      </div>
    </MessengersLayout>
  );
}
