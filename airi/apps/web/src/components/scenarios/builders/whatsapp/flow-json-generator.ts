import type {
  WhatsAppFlowConfig,
  WhatsAppFlowFieldConfig,
  WhatsAppFlowNavigationMode,
  WhatsAppFlowScreenConfig,
  WhatsAppFlowScreenAction,
} from "@/components/scenarios/types";
import {
  buildWhatsAppFlowEndpointTopology,
  parseWhatsAppFlowScreenAction,
  parseWhatsAppFlowDataSchema,
  type WhatsAppFlowDataSchema,
  resolveWhatsAppFlowLayoutContent,
} from "@icecore/scenario-contracts";
import { sanitizeWhatsAppFlowConfig } from "@/lib/scenarios/whatsapp-flow-config";
import { resolveFlowSubmitButtonLabel } from "@/lib/scenarios/whatsapp-flow-ui-locale";

export type FlowJsonComponent = {
  type: string;
  name?: string;
  label?: string;
  text?: string;
  required?: boolean;
  "helper-text"?: string;
  "input-type"?: string;
  "data-source"?: Array<{ id: string; title: string; description?: string }>;
  "list-items"?: Array<{
    id: string;
    "main-content": { title: string; description?: string };
    "on-click-action": NonNullable<FlowJsonComponent["on-click-action"]>;
  }>;
  "min-date"?: string;
  "max-date"?: string;
  "on-click-action"?: {
    name: string;
    payload?: Record<string, unknown>;
    next?: { type: string; name: string };
  };
  children?: FlowJsonComponent[];
};

export type FlowJsonScreen = {
  id: string;
  terminal?: boolean;
  success?: boolean;
  title: string;
  data?: Record<string, WhatsAppFlowDataSchema>;
  layout: {
    type: "SingleColumnLayout";
    children: FlowJsonComponent[];
  };
};

export type FlowJson = {
  version: string;
  data_api_version?: string;
  routing_model?: Readonly<Record<string, readonly string[]>>;
  screens: FlowJsonScreen[];
};

function fieldToComponent(field: WhatsAppFlowFieldConfig): FlowJsonComponent {
  switch (field.fieldType) {
    case "NavigationList":
      return {
        type: "NavigationList",
        name: field.id,
        "list-items": (field.navigationItems ?? []).map(item => ({
          id: item.id,
          "main-content": {
            title: item.title,
            ...(item.description !== undefined
              ? { description: item.description }
              : {}),
          },
          "on-click-action": screenActionToJson(item.action),
        })),
      };
    case "TextInput":
      return {
        type: "TextInput",
        name: field.id,
        label: field.label,
        required: field.required,
        ...(field.helperText ? { "helper-text": field.helperText } : {}),
        "input-type": "text",
      };
    case "TextArea":
      return {
        type: "TextArea",
        name: field.id,
        label: field.label,
        required: field.required,
        ...(field.helperText ? { "helper-text": field.helperText } : {}),
      };
    case "Dropdown":
      return {
        type: "Dropdown",
        name: field.id,
        label: field.label,
        required: field.required,
        "data-source": field.options ?? [],
      };
    case "DatePicker":
      return {
        type: "DatePicker",
        name: field.id,
        label: field.label,
        required: field.required,
      };
    case "RadioButtonsGroup":
      return {
        type: "RadioButtonsGroup",
        name: field.id,
        label: field.label,
        required: field.required,
        "data-source": field.options ?? [],
      };
    case "CheckboxGroup":
      return {
        type: "CheckboxGroup",
        name: field.id,
        label: field.label,
        required: field.required,
        "data-source": field.options ?? [],
      };
    default:
      return {
        type: "TextInput",
        name: field.id,
        label: field.label,
        required: field.required,
        "input-type": "text",
      };
  }
}

function screenActionToJson(
  action: WhatsAppFlowScreenAction
): NonNullable<FlowJsonComponent["on-click-action"]> {
  return {
    name: action.name,
    ...(action.payload !== undefined ? { payload: action.payload } : {}),
    ...(action.name === "navigate"
      ? { next: { type: "screen", name: action.nextScreenId } }
      : {}),
  };
}

function staticGraphScreenToJson(
  screen: WhatsAppFlowScreenConfig
): FlowJsonScreen {
  const fields = new Map(screen.fields.map(field => [field.id, field]));
  const children = resolveWhatsAppFlowLayoutContent(screen).map(item => {
    if (item.kind === "text") return { type: item.type, text: item.text };
    const field = fields.get(item.fieldId);
    if (!field)
      throw new Error("Flow layout references an unknown answer field");
    return fieldToComponent(field);
  });
  if (screen.footer)
    children.push({
      type: "Footer",
      label: screen.footer.label,
      "on-click-action": screenActionToJson(screen.footer.action),
    });
  return {
    id: screen.id,
    title: screen.title,
    ...(screen.terminal !== undefined ? { terminal: screen.terminal } : {}),
    ...(screen.success !== undefined ? { success: screen.success } : {}),
    ...(screen.data !== undefined ? { data: screen.data } : {}),
    layout: {
      type: "SingleColumnLayout",
      children: screen.layoutForm
        ? [{ type: "Form", name: screen.layoutForm.name, children }]
        : children,
    },
  };
}

/** Fields from screens [0, endExclusive), retaining their answer types. */
function collectFieldsUpTo(
  screens: WhatsAppFlowScreenConfig[],
  endExclusive: number
): WhatsAppFlowFieldConfig[] {
  const fields: WhatsAppFlowFieldConfig[] = [];
  for (let i = 0; i < endExclusive; i++) {
    const s = screens[i];
    if (!s) continue;
    for (const f of s.fields) {
      fields.push(f);
    }
  }
  return fields;
}

function buildScreenDataSchema(
  fields: WhatsAppFlowFieldConfig[]
): Record<string, WhatsAppFlowDataSchema> | undefined {
  if (fields.length === 0) return undefined;
  const data: Record<string, WhatsAppFlowDataSchema> = {};
  for (const field of fields) {
    data[field.id] =
      field.fieldType === "CheckboxGroup"
        ? { type: "array", items: { type: "string" }, __example__: [] }
        : { type: "string", __example__: " " };
  }
  return data;
}

function buildFooterPayload(
  previousScreenFieldIds: string[],
  currentScreenFields: WhatsAppFlowFieldConfig[]
): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  for (const id of previousScreenFieldIds) {
    payload[id] = `\${data.${id}}`;
  }
  for (const f of currentScreenFields) {
    payload[f.id] = `\${form.${f.id}}`;
  }
  return payload;
}

function defaultNextScreenId(
  screens: WhatsAppFlowScreenConfig[],
  screenIndex: number
): string | null {
  if (screenIndex >= screens.length - 1) return null;
  return screens[screenIndex + 1]!.id;
}

function screenToFlowScreen(
  screen: WhatsAppFlowScreenConfig,
  ctx: {
    screenIndex: number;
    allScreens: WhatsAppFlowScreenConfig[];
    isTerminal: boolean;
    submitButtonLabel: string;
    navigationMode: WhatsAppFlowNavigationMode | undefined;
    nextScreenId: string | null;
  }
): FlowJsonScreen {
  const previousFields = collectFieldsUpTo(ctx.allScreens, ctx.screenIndex);
  const payload = buildFooterPayload(
    previousFields.map(field => field.id),
    screen.fields
  );
  const dataSchema = buildScreenDataSchema(previousFields);

  const mode = ctx.navigationMode ?? "linear";
  const isEndpointMode = mode === "data_endpoint" && ctx.allScreens.length > 1;

  let footerActionName: string;
  if (ctx.isTerminal) {
    footerActionName = "complete";
  } else if (isEndpointMode) {
    footerActionName = "data_exchange";
  } else {
    footerActionName = "navigate";
  }

  const footerAction: NonNullable<FlowJsonComponent["on-click-action"]> = {
    name: footerActionName,
    payload,
  };

  if (!ctx.isTerminal && footerActionName === "navigate" && ctx.nextScreenId) {
    footerAction.next = { type: "screen", name: ctx.nextScreenId };
  }

  const fieldComponents = screen.fields.map(fieldToComponent);

  const footer: FlowJsonComponent = {
    type: "Footer",
    label: ctx.submitButtonLabel,
    "on-click-action": footerAction,
  };

  return {
    id: screen.id,
    title: screen.title,
    ...(ctx.isTerminal ? { terminal: true } : {}),
    ...(dataSchema ? { data: dataSchema } : {}),
    layout: {
      type: "SingleColumnLayout",
      children: [
        {
          type: "Form",
          name: `${screen.id}_form`,
          children: [...fieldComponents, footer],
        },
      ],
    },
  };
}

export function generateFlowJson(config: WhatsAppFlowConfig): FlowJson {
  const sanitizedConfig = sanitizeWhatsAppFlowConfig(config) ?? config;
  const submitButtonLabel = resolveFlowSubmitButtonLabel({
    flowUiLocale: sanitizedConfig.flowUiLocale,
    flowSubmitLabel: sanitizedConfig.flowSubmitLabel,
  });
  const screens = sanitizedConfig.screens;
  const navMode = sanitizedConfig.flowNavigationMode;
  if (navMode === "static_graph") {
    return {
      version: sanitizedConfig.flowJsonVersion ?? "6.3",
      screens: screens.map(staticGraphScreenToJson),
    };
  }
  const endpointTopology =
    navMode === "data_endpoint"
      ? buildWhatsAppFlowEndpointTopology(sanitizedConfig)
      : null;
  const useEndpoint = endpointTopology !== null;

  const flowScreens = screens.map((screen, index) =>
    screenToFlowScreen(screen, {
      screenIndex: index,
      allScreens: screens,
      isTerminal: index === screens.length - 1,
      submitButtonLabel,
      navigationMode: navMode,
      nextScreenId: defaultNextScreenId(screens, index),
    })
  );

  const base: FlowJson = {
    version: sanitizedConfig.flowJsonVersion ?? (useEndpoint ? "7.3" : "6.3"),
    screens: flowScreens,
  };

  if (useEndpoint) {
    base.data_api_version = "4.0";
    base.routing_model = endpointTopology.routing;
  }

  return base;
}

export function generateFlowJsonString(config: WhatsAppFlowConfig): string {
  return JSON.stringify(generateFlowJson(config), null, 2);
}

/** Materialize the existing linear wire semantics before editing an explicit graph. */
export function convertWhatsAppFlowToStaticGraph(
  config: WhatsAppFlowConfig
): WhatsAppFlowConfig | null {
  if (config.flowNavigationMode === "data_endpoint") return null;
  if (config.flowNavigationMode === "static_graph") return config;
  const sanitized = sanitizeWhatsAppFlowConfig(config);
  if (!sanitized) return null;
  const json = generateFlowJson(sanitized);
  const screens: WhatsAppFlowScreenConfig[] = [];
  for (const [index, screen] of json.screens.entries()) {
    const form = screen.layout.children[0];
    const footer = form?.children?.at(-1);
    const action = parseWhatsAppFlowScreenAction(footer?.["on-click-action"]);
    if (!form?.name || !footer?.label || !action) return null;
    const data: Record<string, WhatsAppFlowDataSchema> = {};
    for (const [key, value] of Object.entries(screen.data ?? {})) {
      const schema = parseWhatsAppFlowDataSchema(value);
      if (!schema) return null;
      Object.defineProperty(data, key, {
        value: schema,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    screens.push({
      ...sanitized.screens[index]!,
      ...(screen.terminal !== undefined ? { terminal: screen.terminal } : {}),
      ...(screen.data ? { data } : {}),
      layoutForm: { name: form.name },
      footer: { label: footer.label, action },
    });
  }
  return {
    ...config,
    ...sanitized,
    flowNavigationMode: "static_graph",
    flowJsonVersion: json.version as "6.3" | "7.3",
    screens,
  };
}

/** Total directed edges in routing_model (Meta documents a low cap, e.g. 10). */
export function countFlowRoutingEdges(config: WhatsAppFlowConfig): number {
  const sanitized = sanitizeWhatsAppFlowConfig(config) ?? config;
  if (sanitized.flowNavigationMode !== "data_endpoint") {
    return 0;
  }
  return Object.values(
    buildWhatsAppFlowEndpointTopology(sanitized).routing
  ).reduce((sum, targets) => sum + targets.length, 0);
}
