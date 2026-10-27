import type {
  ScenarioNodeData,
  ScenarioWhatsAppTemplate,
} from "@icecore/scenario-contracts";
import { normalizeWhatsAppTemplateLanguageForSend } from "@icecore/shared/constants/whatsapp-templates";

export type BulkWhatsAppTemplateSendBlockReason =
  | "missing"
  | "stale"
  | "not_approved"
  | "draft"
  | "pending_review"
  | "rejected";

/**
 * Gate bulk campaign send when the connected WhatsApp template is not
 * sendable: missing, deleted/stale, not APPROVED, or still a draft / in review.
 */
export function resolveBulkWhatsAppTemplateSendBlockReason(params: {
  nodeData?: Partial<ScenarioNodeData> | null;
  whatsAppTemplates: ScenarioWhatsAppTemplate[];
}): BulkWhatsAppTemplateSendBlockReason | null {
  const { nodeData, whatsAppTemplates } = params;
  if (!nodeData) return "missing";

  const draft = nodeData.generatedTemplateDraft;
  if (draft?.status) {
    switch (draft.status) {
      case "draft":
      case "submitting":
        return "draft";
      case "submitted":
      case "pending":
        return "pending_review";
      case "rejected":
        return "rejected";
      case "approved":
        break;
      default: {
        const _exhaustive: never = draft.status;
        void _exhaustive;
        return "not_approved";
      }
    }
  }

  const templateName =
    nodeData.actionWhatsAppTemplateName?.trim() || draft?.name?.trim() || "";
  if (!templateName) return "missing";

  const liveTemplate = findMatchingScenarioWhatsAppTemplate({
    nodeData: {
      ...nodeData,
      actionWhatsAppTemplateName:
        nodeData.actionWhatsAppTemplateName?.trim() || draft?.name,
      actionWhatsAppTemplateLanguage:
        nodeData.actionWhatsAppTemplateLanguage?.trim() || draft?.language,
      actionWhatsAppTemplateId:
        nodeData.actionWhatsAppTemplateId?.trim() || draft?.metaTemplateId,
    },
    whatsAppTemplates,
  });
  if (!liveTemplate) {
    // Catalog for scenarios is APPROVED-only, so missing = stale or not approved.
    return "stale";
  }

  const status = liveTemplate.status?.trim().toUpperCase();
  if (status !== "APPROVED") {
    return "not_approved";
  }

  return null;
}

export function findMatchingScenarioWhatsAppTemplate(params: {
  nodeData?: Partial<ScenarioNodeData>;
  whatsAppTemplates: ScenarioWhatsAppTemplate[];
}): ScenarioWhatsAppTemplate | null {
  const { nodeData, whatsAppTemplates } = params;
  if (!nodeData || whatsAppTemplates.length === 0) return null;

  const selectedTemplateId =
    typeof nodeData.actionWhatsAppTemplateId === "string"
      ? nodeData.actionWhatsAppTemplateId.trim()
      : "";
  const selectedTemplateName =
    typeof nodeData.actionWhatsAppTemplateName === "string"
      ? nodeData.actionWhatsAppTemplateName.trim()
      : "";
  const selectedTemplateLanguage = normalizeWhatsAppTemplateLanguageForSend(
    nodeData.actionWhatsAppTemplateLanguage
  );

  if (selectedTemplateId) {
    const byId = whatsAppTemplates.find(
      template => (template.id || "").trim() === selectedTemplateId
    );
    if (byId) return byId;
  }

  if (!selectedTemplateName || !selectedTemplateLanguage) {
    return null;
  }

  return (
    whatsAppTemplates.find(
      template =>
        template.name.trim() === selectedTemplateName &&
        normalizeWhatsAppTemplateLanguageForSend(template.language) ===
          selectedTemplateLanguage
    ) || null
  );
}
