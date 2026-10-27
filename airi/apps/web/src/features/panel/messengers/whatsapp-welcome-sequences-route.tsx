import { ScopedIntlProvider } from "@/components/i18n/scoped-intl-provider";
import { MessengersLayout } from "@/components/messengers/messengers-layout";
import { SourceRequiredState } from "@/components/onboarding/source-required-state";
import { PageHeader } from "@/components/ui/page-header";
import { WhatsAppWelcomeSequencesManager } from "@/components/whatsapp-welcome-sequences/welcome-sequences-manager";
import { getReadOnlySupabaseContext } from "@/features/panel/shared/workspace";
import { getWorkspaceSourceReadiness } from "@/features/panel/shared/workspace/source-readiness";
import {
  getLocaleFromCookie,
  loadWhatsAppWelcomeSequencesClientMessages,
} from "@/i18n/message-loader";
import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";

export default async function WhatsAppWelcomeSequencesPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const [{ workspaceId }, locale, t, { supabase, user }] = await Promise.all([
    params,
    getLocaleFromCookie(),
    getTranslations("WhatsAppWelcomeSequences"),
    getReadOnlySupabaseContext(),
  ]);
  if (!user) redirect("/login");

  const [sourceReadiness, messages] = await Promise.all([
    getWorkspaceSourceReadiness(supabase, workspaceId),
    loadWhatsAppWelcomeSequencesClientMessages(locale),
  ]);
  const connectWhatsAppHref = `/panel/w/${workspaceId}/settings/integrations?integration=whatsapp`;

  return (
    <ScopedIntlProvider messages={messages}>
      <MessengersLayout workspaceId={workspaceId}>
        <div className="space-y-6">
          <PageHeader
            title={t("page.title")}
            description={t("page.description")}
          />
          {sourceReadiness.hasWhatsApp ? (
            <WhatsAppWelcomeSequencesManager workspaceId={workspaceId} />
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
      </MessengersLayout>
    </ScopedIntlProvider>
  );
}
