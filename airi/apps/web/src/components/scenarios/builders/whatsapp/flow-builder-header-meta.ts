import type { WhatsAppFlowConfig } from "@/components/scenarios/types";
import { createWhatsAppFlowEditableContentDigest } from "@/lib/scenarios/whatsapp-flow-projection";
import type { ExistingFlow } from "./template-picker";
import { getFlowTemplate, type FlowTemplateId } from "./templates";

/**
 * Name + status shown for the current flow in the green header bar (full) or
 * the template drawer title (inline).
 */
export function getFlowBuilderHeaderMeta(
  flowConfig: WhatsAppFlowConfig | null | undefined,
  existingFlows: ExistingFlow[] | undefined,
  t: (key: string) => string
): {
  displayFlowName: string;
  displayFlowStatus: string;
  hasUnpublishedChanges?: true;
} {
  const managedProjection = flowConfig?.managedProvisioning;
  const providerFlowId =
    managedProjection?.flowId ||
    flowConfig?.providerReference?.flowId ||
    flowConfig?.metaFlowId ||
    null;
  const selectedExistingFlow =
    providerFlowId && Array.isArray(existingFlows)
      ? existingFlows.find(flow => flow.id === providerFlowId)
      : null;
  const displayFlowName =
    (selectedExistingFlow?.name || "").trim() ||
    (managedProjection?.flowName || "").trim() ||
    (flowConfig?.providerReference?.flowName || "").trim() ||
    (flowConfig?.metaFlowName || "").trim() ||
    t(
      getFlowTemplate(flowConfig?.templateId as FlowTemplateId)?.titleKey ??
        "flowBuilderLabel"
    );
  const displayFlowStatus = (
    (managedProjection?.providerStatus || "").trim() ||
    (selectedExistingFlow?.status || "").trim() ||
    (flowConfig?.providerReference?.providerStatus || "").trim() ||
    (flowConfig?.metaFlowStatus || "").trim()
  ).toUpperCase();
  let hasUnpublishedChanges = false;
  if (flowConfig && managedProjection?.contentDigest) {
    try {
      hasUnpublishedChanges =
        createWhatsAppFlowEditableContentDigest(flowConfig) !==
        managedProjection.contentDigest;
    } catch {
      // Unserializable local content cannot be the released provider revision.
      hasUnpublishedChanges = true;
    }
  }
  return {
    displayFlowName,
    displayFlowStatus,
    ...(hasUnpublishedChanges ? { hasUnpublishedChanges: true as const } : {}),
  };
}
