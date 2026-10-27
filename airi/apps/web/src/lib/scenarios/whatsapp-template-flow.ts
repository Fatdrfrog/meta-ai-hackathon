import type { WhatsAppComponent } from "@icecore/shared/types/whatsapp";
import {
  readSingleWhatsAppTemplateFlowButtonFlowId,
  resolveWhatsAppFlowProviderId,
  type ScenarioNodeData,
} from "@icecore/scenario-contracts";

export { normalizeWhatsAppTemplateFlowId as normalizeEditableTemplateFlowId } from "@icecore/scenario-contracts";

type TemplateComponentList = WhatsAppComponent[] | null | undefined;

export function canEditFlowForWhatsAppTemplateComponents(
  components: TemplateComponentList
): boolean {
  return readSingleWhatsAppTemplateFlowButtonFlowId(components) !== null;
}

export function getSingleFlowIdFromWhatsAppTemplateComponents(
  components: TemplateComponentList
): string | null {
  return readSingleWhatsAppTemplateFlowButtonFlowId(components);
}

/**
 * Drops the form data a step keeps for a Flow that the template it now sends
 * no longer opens, on a template pick or an inline-editor save: a Flow config
 * linked to another Flow, and the saved form fields once the template opens
 * no form. Such a config can't be sent with the template, and its fields
 * would replace the new form's. Fields saved from another Flow stay while
 * the template opens a form: the readers skip them, and loading the new
 * form's fields keeps their key, so prompts keep reading the answers it
 * still gives. The same Flow, such as the template in another language,
 * keeps both, and a config not linked to a Flow yet is kept.
 */
export function buildWhatsAppTemplateFormAlignmentPatch(
  current:
    | Pick<ScenarioNodeData, "actionFlowConfig" | "actionWhatsAppTemplateForm">
    | undefined,
  nextComponents: TemplateComponentList
): Partial<ScenarioNodeData> {
  const nextFlowId = readSingleWhatsAppTemplateFlowButtonFlowId(nextComponents);
  const configFlowId = resolveWhatsAppFlowProviderId({
    flowConfig: current?.actionFlowConfig,
  });
  return {
    ...(current?.actionWhatsAppTemplateForm && !nextFlowId
      ? { actionWhatsAppTemplateForm: undefined }
      : {}),
    ...(configFlowId && configFlowId !== nextFlowId
      ? {
          actionFlowConfig: undefined,
          actionReplyCtaType: undefined,
          actionReplyCtaFlowId: undefined,
          actionReplyCtaFlowName: undefined,
        }
      : {}),
  };
}
