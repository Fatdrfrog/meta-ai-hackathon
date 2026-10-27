import { ScopedIntlProvider } from "@/components/i18n/scoped-intl-provider";
import { MessengersLayout } from "@/components/messengers/messengers-layout";
import { SourceRequiredState } from "@/components/onboarding/source-required-state";
import { PageHeader } from "@/components/ui/page-header";
import { WhatsAppFlowsManager } from "@/components/whatsapp-flows/flows-manager";
import {
  getConnectedScenarioSourceOptions,
  type ScenarioSourceReadinessRow,
} from "@/components/scenarios/scenario-onboarding";
import { getReadOnlySupabaseContext } from "@/features/panel/shared/workspace";
import { getWorkspaceSourceReadiness } from "@/features/panel/shared/workspace/source-readiness";
import {
  getLocaleFromCookie,
  loadScenariosClientMessages,
} from "@/i18n/message-loader";
import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";

export default async function WhatsAppFlowsPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const [{ workspaceId }, t, locale, { supabase, user }] = await Promise.all([
    params,
    getTranslations("WhatsAppFlows"),
    getLocaleFromCookie(),
    getReadOnlySupabaseContext(),
  ]);
  if (!user) redirect("/login");

  const [sourceReadiness, sourcesResult] = await Promise.all([
    getWorkspaceSourceReadiness(supabase, workspaceId),
    supabase
      .from("sources")
      .select("id, type, name, credentials")
      .eq("workspace_id", workspaceId)
      .eq("type", "whatsapp"),
  ]);
  const sourceOptions = getConnectedScenarioSourceOptions(
    (sourcesResult.data ?? []) as ScenarioSourceReadinessRow[]
  ).flatMap(option =>
    option.type === "whatsapp" ? [{ id: option.id, label: option.label }] : []
  );
  const messages = sourceReadiness.hasWhatsApp
    ? { Scenarios: (await loadScenariosClientMessages(locale)).Scenarios }
    : {};
  const connectWhatsAppHref = `/panel/w/${workspaceId}/settings/integrations?integration=whatsapp`;

  return (
    <MessengersLayout workspaceId={workspaceId}>
      <div className="min-w-0 space-y-4">
        <PageHeader title={t("title")} description={t("description")} />
        {sourceReadiness.hasWhatsApp ? (
          <ScopedIntlProvider messages={messages}>
            <WhatsAppFlowsManager
              workspaceId={workspaceId}
              sourceOptions={sourceOptions}
            />
          </ScopedIntlProvider>
        ) : (
          <SourceRequiredState
            icon="whatsapp"
            title={t("alerts.connectWhatsApp")}
            description={t("alerts.credentialsMissing")}
            primaryHref={connectWhatsAppHref}
            primaryLabel={t("alerts.connectWhatsApp")}
          />
        )}
      </div>
    </MessengersLayout>
  );
}
