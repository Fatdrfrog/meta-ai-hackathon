import type {
  WhatsAppFlowConfig,
  WhatsAppFlowFieldConfig,
} from "@icecore/scenario-contracts";
import { listScenarioFormFields } from "@icecore/scenario-contracts";

export type FlowBranchOption = {
  fieldId: string;
  fieldLabel: string;
  optionId: string;
  optionTitle: string;
};

export function extractFlowBranchOptions(
  config: WhatsAppFlowConfig | null | undefined
): FlowBranchOption[] {
  if (!config?.screens?.length) return [];

  const options: FlowBranchOption[] = [];

  for (const field of collectRadioFields(config)) {
    if (field.fieldType !== "RadioButtonsGroup") continue;
    if (!field.options?.length) continue;

    for (const option of field.options) {
      options.push({
        fieldId: field.id,
        fieldLabel: field.label,
        optionId: option.id,
        optionTitle: option.title,
      });
    }
  }

  return options;
}

export function collectRadioFields(
  config: WhatsAppFlowConfig | null | undefined
): WhatsAppFlowFieldConfig[] {
  if (!config?.screens?.length) return [];

  if (config.flowNavigationMode === "static_graph") {
    return listScenarioFormFields(config)
      .filter(
        field =>
          field.fieldType === "RadioButtonsGroup" && field.options.length > 0
      )
      .map(field => ({
        id: field.responseKey,
        label: field.label,
        fieldType: "RadioButtonsGroup",
        required: field.required,
        options: field.options,
      }));
  }

  return config.screens.flatMap(screen =>
    screen.fields.filter(
      field =>
        field.fieldType === "RadioButtonsGroup" &&
        Array.isArray(field.options) &&
        field.options.length > 0
    )
  );
}
