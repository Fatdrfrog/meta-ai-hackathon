import { MessengersLayout } from "@/components/messengers/messengers-layout";
import { SourceRequiredState } from "@/components/onboarding/source-required-state";
import { PageHeader } from "@/components/ui/page-header";
import { WhatsAppCatalogManager } from "@/components/whatsapp-catalog/catalog-manager";
import { getReadOnlySupabaseContext } from "@/features/panel/shared/workspace";
import { getWorkspaceSourceReadiness } from "@/features/panel/shared/workspace/source-readiness";
import { redirect } from "next/navigation";

export default async function WhatsAppCatalogPage({
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
        <PageHeader title="Catalog" />
        {sourceReadiness.hasWhatsApp ? (
          <WhatsAppCatalogManager workspaceId={workspaceId} />
        ) : (
          <SourceRequiredState
            icon="whatsapp"
            title="Connect WhatsApp to manage catalogs"
            description="Catalog products and commerce settings require a WhatsApp Business account in this workspace. Connect WhatsApp before importing products or sending catalog messages."
            primaryHref={connectWhatsAppHref}
            primaryLabel="Connect WhatsApp"
          />
        )}
      </div>
    </MessengersLayout>
  );
}
