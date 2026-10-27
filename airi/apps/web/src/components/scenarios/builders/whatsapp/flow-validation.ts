import type {
  WhatsAppFlowConfig,
  WhatsAppFlowFieldType,
} from "@/components/scenarios/types";
import {
  WHATSAPP_FLOW_ENDPOINT_MAX_ROUTING_EDGES,
  WhatsAppFlowEndpointTopologyError,
  validateWhatsAppFlowStaticGraph,
  type WhatsAppFlowStaticGraphIssueCode,
} from "@icecore/scenario-contracts";
import { isNonEmptyString } from "@icecore/shared/lib/value-utils";
import { countFlowRoutingEdges, generateFlowJson } from "./flow-json-generator";

export type FlowValidationIssueCode =
  | WhatsAppFlowStaticGraphIssueCode
  | "flow_version_required"
  | "screens_required"
  | "screens_max_exceeded"
  | "screen_id_required"
  | "screen_id_max_length"
  | "screen_id_reserved"
  | "screen_title_max_length"
  | "screen_layout_type_invalid"
  | "screen_layout_children_required"
  | "screen_max_components_exceeded"
  | "form_name_required"
  | "form_children_required"
  | "component_type_required"
  | "component_label_required"
  | "component_label_max_length"
  | "component_name_required"
  | "component_data_source_required"
  | "data_source_option_id_required"
  | "data_source_option_title_required"
  | "data_source_option_title_max_length"
  | "data_source_max_options_exceeded"
  | "footer_label_max_length"
  | "footer_action_required"
  | "footer_action_name_invalid"
  | "meta_flow_id_required"
  | "flow_field_id_duplicate_across_screens"
  | "flow_endpoint_screens_required"
  | "flow_endpoint_invalid"
  | "flow_routing_edges_exceeded";

export type FlowValidationIssue = {
  code: FlowValidationIssueCode;
  path: string;
};

export type FlowValidationOptions = {
  requireMetaFlowId?: boolean;
};

export type FlowValidationResult = {
  isValid: boolean;
  issues: FlowValidationIssue[];
};

type FlowJsonDataSourceItem = {
  id?: string;
  title?: string;
};

type FlowJsonAction = {
  name?: string;
};

type FlowJsonComponent = {
  type?: string;
  name?: string;
  label?: string;
  "data-source"?: FlowJsonDataSourceItem[];
  "on-click-action"?: FlowJsonAction;
  children?: FlowJsonComponent[];
};

type FlowJsonScreen = {
  id?: string;
  layout?: {
    type?: string;
    children?: FlowJsonComponent[];
  };
};

type FlowJson = {
  version?: string;
  screens?: FlowJsonScreen[];
};

const OPTION_FIELD_TYPES = new Set<WhatsAppFlowFieldType>([
  "Dropdown",
  "CheckboxGroup",
  "RadioButtonsGroup",
]);

/**
 * Character and count limits from the official WhatsApp Flows reference:
 * https://developers.facebook.com/docs/whatsapp/flows/reference/flowjson
 */
const SCREEN_ID_MAX = 50;
const SCREEN_TITLE_MAX = 80;
/** WhatsApp Flow JSON: max screens per flow (Meta Flow JSON). */
export const MAX_FLOW_SCREENS = 20;
const MAX_SCREENS = MAX_FLOW_SCREENS;
const MAX_COMPONENTS_PER_SCREEN = 50;
const LABEL_MAX: Record<string, number> = {
  TextInput: 20,
  TextArea: 20,
  Dropdown: 20,
  DatePicker: 40,
  RadioButtonsGroup: 30,
  CheckboxGroup: 30,
};
const FOOTER_LABEL_MAX = 35;
const OPTION_TITLE_MAX = 30;
const MAX_OPTIONS: Record<string, number> = {
  Dropdown: 200,
  RadioButtonsGroup: 20,
  CheckboxGroup: 20,
};
/** Meta's per-type limits, shared with code that repairs generated Flows. */
export {
  LABEL_MAX as FLOW_FIELD_LABEL_MAX,
  MAX_OPTIONS as FLOW_FIELD_MAX_OPTIONS,
  OPTION_TITLE_MAX as FLOW_OPTION_TITLE_MAX,
};
const VALID_ACTION_NAMES = new Set([
  "navigate",
  "complete",
  "data_exchange",
  "update_data",
  "open_url",
]);

function hasNonEmptyArray<T>(value: T[] | null | undefined): value is T[] {
  return Array.isArray(value) && value.length > 0;
}

function pushIssue(
  issues: FlowValidationIssue[],
  code: FlowValidationIssueCode,
  path: string
): void {
  issues.push({ code, path });
}

function pushEndpointTopologyIssue(
  issues: FlowValidationIssue[],
  error: unknown
): void {
  if (
    error instanceof WhatsAppFlowEndpointTopologyError &&
    error.code === "routing_edge_limit_exceeded"
  ) {
    pushIssue(issues, "flow_routing_edges_exceeded", "screenRoutes");
    return;
  }
  pushIssue(issues, "flow_endpoint_invalid", "flowNavigationMode");
}

function validateConfigBasics(
  config: WhatsAppFlowConfig | null | undefined,
  options: FlowValidationOptions
): FlowValidationIssue[] {
  const issues: FlowValidationIssue[] = [];

  if (!config || !hasNonEmptyArray(config.screens)) {
    pushIssue(issues, "screens_required", "screens");
    return issues;
  }

  if (config.screens.length > MAX_SCREENS) {
    pushIssue(issues, "screens_max_exceeded", "screens");
  }

  config.screens.forEach((screen, screenIndex) => {
    if (!isNonEmptyString(screen.id)) {
      pushIssue(issues, "screen_id_required", `screens[${screenIndex}].id`);
    } else {
      if (screen.id.trim() === "SUCCESS") {
        pushIssue(issues, "screen_id_reserved", `screens[${screenIndex}].id`);
      }
      if (screen.id.trim().length > SCREEN_ID_MAX) {
        pushIssue(issues, "screen_id_max_length", `screens[${screenIndex}].id`);
      }
    }

    if (screen.title && screen.title.length > SCREEN_TITLE_MAX) {
      pushIssue(
        issues,
        "screen_title_max_length",
        `screens[${screenIndex}].title`
      );
    }

    if (screen.fields.length > MAX_COMPONENTS_PER_SCREEN) {
      pushIssue(
        issues,
        "screen_max_components_exceeded",
        `screens[${screenIndex}].fields`
      );
    }

    screen.fields.forEach((field, fieldIndex) => {
      const fieldPath = `screens[${screenIndex}].fields[${fieldIndex}]`;

      if (!isNonEmptyString(field.id))
        pushIssue(issues, "component_name_required", `${fieldPath}.id`);
      if (field.fieldType === "NavigationList") return;
      if (!isNonEmptyString(field.label)) {
        pushIssue(issues, "component_label_required", `${fieldPath}.label`);
      } else {
        const maxLabel = LABEL_MAX[field.fieldType];
        if (maxLabel && field.label.trim().length > maxLabel) {
          pushIssue(issues, "component_label_max_length", `${fieldPath}.label`);
        }
      }

      if (OPTION_FIELD_TYPES.has(field.fieldType)) {
        if (!hasNonEmptyArray(field.options)) {
          pushIssue(
            issues,
            "component_data_source_required",
            `${fieldPath}.options`
          );
          return;
        }

        const maxOpts = MAX_OPTIONS[field.fieldType];
        if (maxOpts && field.options.length > maxOpts) {
          pushIssue(
            issues,
            "data_source_max_options_exceeded",
            `${fieldPath}.options`
          );
        }

        field.options.forEach((option, optionIndex) => {
          if (!isNonEmptyString(option.id)) {
            pushIssue(
              issues,
              "data_source_option_id_required",
              `${fieldPath}.options[${optionIndex}].id`
            );
          }
          if (!isNonEmptyString(option.title)) {
            pushIssue(
              issues,
              "data_source_option_title_required",
              `${fieldPath}.options[${optionIndex}].title`
            );
          } else if (option.title.trim().length > OPTION_TITLE_MAX) {
            pushIssue(
              issues,
              "data_source_option_title_max_length",
              `${fieldPath}.options[${optionIndex}].title`
            );
          }
        });
      }
    });
  });

  if (options.requireMetaFlowId && !isNonEmptyString(config.metaFlowId)) {
    pushIssue(issues, "meta_flow_id_required", "metaFlowId");
  }

  if (
    config.flowNavigationMode === "data_endpoint" &&
    config.screens.length < 2
  ) {
    pushIssue(issues, "flow_endpoint_screens_required", "screens");
  }

  return issues;
}

function validateCrossScreenFieldIds(
  config: WhatsAppFlowConfig
): FlowValidationIssue[] {
  const issues: FlowValidationIssue[] = [];
  const firstScreenByFieldId = new Map<string, string>();

  config.screens.forEach((screen, screenIndex) => {
    const withinScreen = new Set<string>();
    screen.fields.forEach((field, fieldIndex) => {
      if (!isNonEmptyString(field.id)) {
        return;
      }

      const normalizedFieldId = field.id.trim();
      if (withinScreen.has(normalizedFieldId)) {
        pushIssue(
          issues,
          "flow_field_id_duplicate_within_screen",
          `screens[${screenIndex}].fields[${fieldIndex}].id`
        );
      }
      withinScreen.add(normalizedFieldId);
      if (config.flowNavigationMode === "static_graph") return;
      const normalizedScreenId = isNonEmptyString(screen.id)
        ? screen.id.trim()
        : `screen-${screenIndex}`;
      const existingScreenId = firstScreenByFieldId.get(normalizedFieldId);
      if (existingScreenId && existingScreenId !== normalizedScreenId) {
        pushIssue(
          issues,
          "flow_field_id_duplicate_across_screens",
          `screens[${screenIndex}].fields[${fieldIndex}].id`
        );
        return;
      }

      firstScreenByFieldId.set(normalizedFieldId, normalizedScreenId);
    });
  });

  return issues;
}

function validateGeneratedComponent(
  component: FlowJsonComponent,
  componentPath: string,
  issues: FlowValidationIssue[]
): void {
  if (!isNonEmptyString(component.type)) {
    pushIssue(issues, "component_type_required", `${componentPath}.type`);
    return;
  }

  const componentType = component.type;

  if (componentType === "Form") {
    if (!isNonEmptyString(component.name)) {
      pushIssue(issues, "form_name_required", `${componentPath}.name`);
    }
    if (!hasNonEmptyArray(component.children)) {
      pushIssue(issues, "form_children_required", `${componentPath}.children`);
      return;
    }
    component.children.forEach((child, childIndex) =>
      validateGeneratedComponent(
        child,
        `${componentPath}.children[${childIndex}]`,
        issues
      )
    );
    return;
  }

  if (componentType === "Footer") {
    if (!isNonEmptyString(component.label)) {
      pushIssue(issues, "component_label_required", `${componentPath}.label`);
    } else if (component.label!.trim().length > FOOTER_LABEL_MAX) {
      pushIssue(issues, "footer_label_max_length", `${componentPath}.label`);
    }
    if (!component["on-click-action"]?.name) {
      pushIssue(
        issues,
        "footer_action_required",
        `${componentPath}.on-click-action`
      );
    } else if (!VALID_ACTION_NAMES.has(component["on-click-action"].name)) {
      pushIssue(
        issues,
        "footer_action_name_invalid",
        `${componentPath}.on-click-action.name`
      );
    }
    return;
  }

  const labeledComponents = new Set([
    "TextInput",
    "TextArea",
    "Dropdown",
    "CheckboxGroup",
    "RadioButtonsGroup",
    "DatePicker",
  ]);
  if (
    labeledComponents.has(componentType) &&
    !isNonEmptyString(component.label)
  ) {
    pushIssue(issues, "component_label_required", `${componentPath}.label`);
  } else if (
    labeledComponents.has(componentType) &&
    isNonEmptyString(component.label)
  ) {
    const maxLabel = LABEL_MAX[componentType];
    if (maxLabel && component.label!.trim().length > maxLabel) {
      pushIssue(issues, "component_label_max_length", `${componentPath}.label`);
    }
  }

  const namedComponents = new Set([
    "TextInput",
    "TextArea",
    "Dropdown",
    "CheckboxGroup",
    "RadioButtonsGroup",
    "DatePicker",
  ]);
  if (namedComponents.has(componentType) && !isNonEmptyString(component.name)) {
    pushIssue(issues, "component_name_required", `${componentPath}.name`);
  }

  const dataSourceComponents = new Set([
    "Dropdown",
    "CheckboxGroup",
    "RadioButtonsGroup",
  ]);
  if (dataSourceComponents.has(componentType)) {
    const dataSource = component["data-source"];
    if (!hasNonEmptyArray(dataSource)) {
      pushIssue(
        issues,
        "component_data_source_required",
        `${componentPath}.data-source`
      );
      return;
    }

    const maxOpts = MAX_OPTIONS[componentType];
    if (maxOpts && dataSource.length > maxOpts) {
      pushIssue(
        issues,
        "data_source_max_options_exceeded",
        `${componentPath}.data-source`
      );
    }

    dataSource.forEach((item, optionIndex) => {
      if (!isNonEmptyString(item.id)) {
        pushIssue(
          issues,
          "data_source_option_id_required",
          `${componentPath}.data-source[${optionIndex}].id`
        );
      }
      if (!isNonEmptyString(item.title)) {
        pushIssue(
          issues,
          "data_source_option_title_required",
          `${componentPath}.data-source[${optionIndex}].title`
        );
      } else if (item.title!.trim().length > OPTION_TITLE_MAX) {
        pushIssue(
          issues,
          "data_source_option_title_max_length",
          `${componentPath}.data-source[${optionIndex}].title`
        );
      }
    });
  }
}

function validateGeneratedFlowJsonStructure(
  flowJson: FlowJson,
  issues: FlowValidationIssue[]
): void {
  if (!isNonEmptyString(flowJson.version)) {
    pushIssue(issues, "flow_version_required", "version");
  }

  if (!hasNonEmptyArray(flowJson.screens)) {
    pushIssue(issues, "screens_required", "screens");
    return;
  }

  if (flowJson.screens.length > MAX_SCREENS) {
    pushIssue(issues, "screens_max_exceeded", "screens");
  }

  flowJson.screens.forEach((screen, screenIndex) => {
    const screenPath = `screens[${screenIndex}]`;
    if (!isNonEmptyString(screen.id)) {
      pushIssue(issues, "screen_id_required", `${screenPath}.id`);
    } else {
      if (screen.id!.trim() === "SUCCESS") {
        pushIssue(issues, "screen_id_reserved", `${screenPath}.id`);
      }
      if (screen.id!.trim().length > SCREEN_ID_MAX) {
        pushIssue(issues, "screen_id_max_length", `${screenPath}.id`);
      }
    }

    if (screen.layout?.type !== "SingleColumnLayout") {
      pushIssue(
        issues,
        "screen_layout_type_invalid",
        `${screenPath}.layout.type`
      );
    }
    if (!hasNonEmptyArray(screen.layout?.children)) {
      pushIssue(
        issues,
        "screen_layout_children_required",
        `${screenPath}.layout.children`
      );
      return;
    }

    screen.layout.children.forEach((component, childIndex) =>
      validateGeneratedComponent(
        component,
        `${screenPath}.layout.children[${childIndex}]`,
        issues
      )
    );
  });
}

export function validateWhatsAppFlowConfig(
  config: WhatsAppFlowConfig | null | undefined,
  options: FlowValidationOptions = {}
): FlowValidationResult {
  const issues = validateConfigBasics(config, options);
  if (!config || !hasNonEmptyArray(config.screens)) {
    return { isValid: issues.length === 0, issues };
  }

  issues.push(...validateCrossScreenFieldIds(config));
  issues.push(...validateWhatsAppFlowStaticGraph(config));
  if (
    config.flowNavigationMode === "data_endpoint" &&
    config.screens.length < 2
  ) {
    const uniqueIssueMap = new Map<string, FlowValidationIssue>();
    for (const issue of issues) {
      const key = `${issue.code}:${issue.path}`;
      if (!uniqueIssueMap.has(key)) uniqueIssueMap.set(key, issue);
    }
    return { isValid: false, issues: [...uniqueIssueMap.values()] };
  }

  try {
    if (
      countFlowRoutingEdges(config) > WHATSAPP_FLOW_ENDPOINT_MAX_ROUTING_EDGES
    ) {
      pushIssue(issues, "flow_routing_edges_exceeded", "screenRoutes");
    }
  } catch (error) {
    if (config.flowNavigationMode === "data_endpoint") {
      pushEndpointTopologyIssue(issues, error);
    }
  }

  try {
    const generated = generateFlowJson(config) as FlowJson;
    validateGeneratedFlowJsonStructure(generated, issues);
  } catch (error) {
    if (config.flowNavigationMode === "data_endpoint") {
      pushEndpointTopologyIssue(issues, error);
    }
  }

  const uniqueIssueMap = new Map<string, FlowValidationIssue>();
  for (const issue of issues) {
    const key = `${issue.code}:${issue.path}`;
    if (!uniqueIssueMap.has(key)) {
      uniqueIssueMap.set(key, issue);
    }
  }

  const normalizedIssues = Array.from(uniqueIssueMap.values());
  return {
    isValid: normalizedIssues.length === 0,
    issues: normalizedIssues,
  };
}
