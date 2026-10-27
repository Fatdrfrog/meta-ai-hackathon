import { MessengersLayout } from "@/components/messengers/messengers-layout";
import { SourceRequiredState } from "@/components/onboarding/source-required-state";
import {
  getConnectedScenarioSourceOptions,
  type ScenarioSourceReadinessRow,
} from "@/components/scenarios/scenario-onboarding";
import { PageHeader } from "@/components/ui/page-header";
import {
  WhatsAppQrManager,
  WhatsAppQrSourceLoadError,
} from "@/components/whatsapp-qr/whatsapp-qr-manager";
import { requirePanelWorkspaceAccess } from "@/features/panel/shared/workspace";
import { getWorkspaceSourceReadiness } from "@/features/panel/shared/workspace/source-readiness";
import { getTranslations } from "next-intl/server";

export default async function WhatsAppQrRoute({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const [{ workspaceId }, t] = await Promise.all([
    params,
    getTranslations("WhatsAppQr"),
  ]);
  const access = await requirePanelWorkspaceAccess(workspaceId);
  const sourceReadiness = await getWorkspaceSourceReadiness(
    access.supabase,
    workspaceId
  );
  const sourceOptions = getConnectedScenarioSourceOptions(
    sourceReadiness.configuredSources as ScenarioSourceReadinessRow[]
  ).flatMap(option =>
    option.type === "whatsapp" ? [{ id: option.id, label: option.label }] : []
  );

  if (!sourceReadiness.loadError && sourceReadiness.hasWhatsApp) {
    return (
      <MessengersLayout workspaceId={workspaceId}>
        <WhatsAppQrManager
          workspaceId={workspaceId}
          sourceOptions={sourceOptions}
        />
      </MessengersLayout>
    );
  }

  const connectWhatsAppHref = `/panel/w/${workspaceId}/settings/integrations?integration=whatsapp`;

  return (
    <MessengersLayout workspaceId={workspaceId}>
      <div className="flex min-w-0 flex-col gap-6">
        <PageHeader
          title={t("page.title")}
          description={t("page.description")}
        />

        {sourceReadiness.loadError ? (
          <WhatsAppQrSourceLoadError />
        ) : (
          <SourceRequiredState
            icon="whatsapp"
            title={t("source.requiredTitle")}
            description={t("source.requiredDescription")}
            primaryHref={connectWhatsAppHref}
            primaryLabel={t("source.connectAction")}
          />
        )}
      </div>
    </MessengersLayout>
  );
}
