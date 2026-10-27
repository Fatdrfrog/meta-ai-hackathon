import {
  SCENARIO_TRIGGER_EVENT_KIND,
  type ScenarioTriggerEventKind,
} from "@icecore/scenario-contracts";
import { parseWhatsAppSessionChoicePayload } from "@icecore/scenario-contracts";
import { parseWhatsAppTemplateButtonPayload } from "@icecore/scenario-contracts";
import { coerceNonEmptyString as normalizeOptionalString } from "@icecore/shared/lib/value-utils";

export type ScenarioStructuredReplyAnchor =
  | {
      kind: "whatsapp_template_button";
      actionNodeId: string;
      buttonId: number;
      quickReplyPayload: string;
    }
  | {
      kind: "whatsapp_session_choice";
      actionNodeId: string;
      choiceId: string;
      quickReplyPayload: string;
    }
  | {
      kind: "whatsapp_flow";
      actionNodeId: null;
      whatsAppFlowResponseJson: string;
    };

export function resolveScenarioStructuredReplyAnchor(params: {
  triggerEventKind?: ScenarioTriggerEventKind | string | null;
  quickReplyPayload?: string | null;
  whatsAppFlowResponseJson?: string | null;
}): ScenarioStructuredReplyAnchor | null {
  if (
    params.triggerEventKind === SCENARIO_TRIGGER_EVENT_KIND.whatsAppButtonReply
  ) {
    const quickReplyPayload = normalizeOptionalString(params.quickReplyPayload);
    if (!quickReplyPayload) return null;

    const templateButton =
      parseWhatsAppTemplateButtonPayload(quickReplyPayload);
    if (templateButton) {
      return {
        kind: "whatsapp_template_button",
        actionNodeId: templateButton.actionNodeId,
        buttonId: templateButton.buttonId,
        quickReplyPayload,
      };
    }

    const sessionChoice = parseWhatsAppSessionChoicePayload(quickReplyPayload);
    if (sessionChoice) {
      return {
        kind: "whatsapp_session_choice",
        actionNodeId: sessionChoice.actionNodeId,
        choiceId: sessionChoice.choiceId,
        quickReplyPayload,
      };
    }
  }

  if (
    params.triggerEventKind === SCENARIO_TRIGGER_EVENT_KIND.whatsAppFlowReply
  ) {
    const whatsAppFlowResponseJson = normalizeOptionalString(
      params.whatsAppFlowResponseJson
    );
    if (whatsAppFlowResponseJson) {
      return {
        kind: "whatsapp_flow",
        actionNodeId: null,
        whatsAppFlowResponseJson,
      };
    }
  }

  return null;
}

export function resolveScenarioStructuredReplyActionNodeId(params: {
  triggerEventKind?: ScenarioTriggerEventKind | string | null;
  quickReplyPayload?: string | null;
  whatsAppFlowResponseJson?: string | null;
}): string | null {
  const anchor = resolveScenarioStructuredReplyAnchor(params);
  return anchor?.actionNodeId || null;
}
