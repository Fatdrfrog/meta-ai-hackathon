import { MessengersLayout } from "@/components/messengers/messengers-layout";
import {
  getConnectedScenarioSourceOptions,
  type ScenarioSourceReadinessRow,
} from "@/components/scenarios/scenario-onboarding";
import { WhatsAppQrEntryPointWorkspace } from "@/components/whatsapp-qr/whatsapp-qr-entry-point-editor";
import { requirePanelWorkspaceAccess } from "@/features/panel/shared/workspace";
import { getWorkspaceSourceReadiness } from "@/features/panel/shared/workspace/source-readiness";
import { normalizeWhatsAppQrEntryPointUuid } from "@/lib/whatsapp/qr-entry-points/normalization";
import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";

export default async function WhatsAppQrEntryRoute({
  params,
}: {
  params: Promise<{ workspaceId: string; entryPointId: string }>;
}) {
  const [{ workspaceId, entryPointId }, t] = await Promise.all([
    params,
    getTranslations("WhatsAppQr"),
  ]);
  const normalizedEntryPointId =
    normalizeWhatsAppQrEntryPointUuid(entryPointId);
  if (!normalizedEntryPointId) notFound();

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
  const providerMutationUnavailableReason = sourceReadiness.loadError
    ? t("source.loadErrorDescription")
    : sourceOptions.length === 0
      ? t("source.requiredDescription")
      : undefined;

  return (
    <MessengersLayout workspaceId={workspaceId}>
      <WhatsAppQrEntryPointWorkspace
        workspaceId={workspaceId}
        entryPointId={normalizedEntryPointId}
        sourceOptions={sourceOptions}
        providerMutationUnavailableReason={providerMutationUnavailableReason}
      />
    </MessengersLayout>
  );
}
