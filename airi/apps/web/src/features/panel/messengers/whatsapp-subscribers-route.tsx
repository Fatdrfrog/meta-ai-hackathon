import { ScopedIntlProvider } from "@/components/i18n/scoped-intl-provider";
import { MessengersLayout } from "@/components/messengers/messengers-layout";
import { SourceRequiredState } from "@/components/onboarding/source-required-state";
import { PageHeader } from "@/components/ui/page-header";
import { WhatsAppSubscribersManager } from "@/components/whatsapp-subscribers/subscribers-manager";
import { getReadOnlySupabaseContext } from "@/features/panel/shared/workspace";
import { getWorkspaceSourceReadiness } from "@/features/panel/shared/workspace/source-readiness";
import {
  getLocaleFromCookie,
  loadPanelFeatureMessages,
} from "@/i18n/message-loader";
import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";

export default async function WhatsAppSubscribersPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const [{ workspaceId }, locale, t, { supabase, user }] = await Promise.all([
    params,
    getLocaleFromCookie(),
    getTranslations("WhatsAppSubscribers"),
    getReadOnlySupabaseContext(),
  ]);
  if (!user) redirect("/login");

  const [sourceReadiness, panelMessages] = await Promise.all([
    getWorkspaceSourceReadiness(supabase, workspaceId),
    loadPanelFeatureMessages(locale),
  ]);
  const connectWhatsAppHref = `/panel/w/${workspaceId}/settings/integrations?integration=whatsapp`;

  return (
    <ScopedIntlProvider messages={panelMessages}>
      <MessengersLayout
        workspaceId={workspaceId}
        contentClassName="flex flex-col"
      >
        <div className="flex h-full min-h-0 flex-col gap-6">
          <PageHeader
            title={t("page.title")}
            description={t("page.description")}
          />
          <div className="min-h-0 flex-1">
            {sourceReadiness.hasWhatsApp ? (
              <WhatsAppSubscribersManager workspaceId={workspaceId} />
            ) : (
              <SourceRequiredState
                icon="whatsapp"
                title={t("connectRequired.title")}
                description={t("connectRequired.description")}
                primaryHref={connectWhatsAppHref}
                primaryLabel={t("connectRequired.action")}
              />
            )}
          </div>
        </div>
      </MessengersLayout>
    </ScopedIntlProvider>
  );
}
