import { ScopedIntlProvider } from "@/components/i18n/scoped-intl-provider";
import { MessengersLayout } from "@/components/messengers/messengers-layout";
import { SourceRequiredState } from "@/components/onboarding/source-required-state";
import { PageHeader } from "@/components/ui/page-header";
import { WhatsAppTemplatesManager } from "@/components/whatsapp-templates/templates-manager";
import { getReadOnlySupabaseContext } from "@/features/panel/shared/workspace";
import { getWorkspaceSourceReadiness } from "@/features/panel/shared/workspace/source-readiness";
import {
  getLocaleFromCookie,
  loadPanelFeatureMessages,
  loadWhatsAppTemplatesClientMessages,
} from "@/i18n/message-loader";

import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";
import { Suspense } from "react";

export default async function WhatsAppTemplatesPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const [{ workspaceId }, tTemplates, locale, { supabase, user }] =
    await Promise.all([
      params,
      getTranslations("templates"),
      getLocaleFromCookie(),
      getReadOnlySupabaseContext(),
    ]);
  if (!user) redirect("/login");

  const sourceReadiness = await getWorkspaceSourceReadiness(
    supabase,
    workspaceId
  );
  const [templatesMessages, panelMessages] = await Promise.all([
    loadWhatsAppTemplatesClientMessages(locale),
    loadPanelFeatureMessages(locale),
  ]);
  const messages = { ...panelMessages, ...templatesMessages };
  const connectWhatsAppHref = `/panel/w/${workspaceId}/settings/integrations?integration=whatsapp`;

  return (
    <ScopedIntlProvider messages={messages}>
      <MessengersLayout
        workspaceId={workspaceId}
        contentClassName="flex flex-col"
      >
        <div className="flex h-full min-h-0 flex-col gap-6">
          <PageHeader
            title={tTemplates("title")}
            description={tTemplates("description")}
          />
          <div className="min-h-0 flex-1">
            {sourceReadiness.hasWhatsApp ? (
              <Suspense
                fallback={<div className="rounded-xl border bg-muted/20" />}
              >
                <WhatsAppTemplatesManager workspaceId={workspaceId} />
              </Suspense>
            ) : (
              <SourceRequiredState
                icon="whatsapp"
                title={tTemplates("connectRequiredTitle")}
                description={tTemplates("connectRequiredDescription")}
                primaryHref={connectWhatsAppHref}
                primaryLabel={tTemplates("connectRequiredAction")}
              />
            )}
          </div>
        </div>
      </MessengersLayout>
    </ScopedIntlProvider>
  );
}
