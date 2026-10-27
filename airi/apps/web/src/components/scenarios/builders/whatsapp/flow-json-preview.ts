import {
  evaluateWhatsAppFlowPayload,
  isWhatsAppFlowTextType,
  parseWhatsAppFlowDataSchema,
  parseWhatsAppFlowScreenAction,
  type WhatsAppFlowConfig,
  type WhatsAppFlowFieldConfig,
  type WhatsAppFlowLayoutContentItem,
  type WhatsAppFlowNavigationItem,
  type WhatsAppFlowScreenConfig,
} from "@icecore/scenario-contracts";
import { asNullableRecord } from "@icecore/shared/lib/value-utils";

export type FlowPreviewComponent =
  | WhatsAppFlowLayoutContentItem
  | { kind: "unsupported"; component: string };

export type FlowJsonPreview = {
  config: WhatsAppFlowConfig;
  componentsByScreen: Record<string, FlowPreviewComponent[]>;
  usesExampleData: boolean;
  totalScreens: number;
};

/** The preview's defaults; the form answer catalog reads more of the Flow. */
export type FlowJsonPreviewLimits = {
  /** Options kept per choice field. */
  maxOptions?: number;
  /**
   * Keep a field shown under a `${...}` condition, as optional, instead of
   * marking it unsupported: the customer can still answer it.
   */
  keepDynamicallyVisibleFields?: boolean;
};

const DEFAULT_MAX_OPTIONS = 20;
const MAX_SCREENS = 20;
const MAX_COMPONENTS = 40;
const MAX_PREVIEW_CHARS = 256 * 1024;
const FIELD_TYPES = new Set([
  "TextInput",
  "TextArea",
  "Dropdown",
  "DatePicker",
  "RadioButtonsGroup",
  "CheckboxGroup",
]);

function text(value: unknown, limit = 1024): string {
  return typeof value === "string"
    ? value.length > limit
      ? `${value.slice(0, limit)}…`
      : value
    : "";
}

function identity(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= 160
    ? value
    : null;
}

function isShown(value: unknown, keepDynamic: boolean): boolean {
  return (
    value === undefined ||
    value === true ||
    (keepDynamic && typeof value === "string" && value.includes("${"))
  );
}

/**
 * Editing requires the lossless importer. Displaying partial saved content does
 * not: this bounded projection reuses the canonical action/schema decoders and
 * records unsupported components in place, without retaining source assets.
 */
export function projectFlowJsonPreview(
  flowJson: unknown,
  limits: FlowJsonPreviewLimits = {}
): FlowJsonPreview | null {
  const maxOptions = limits.maxOptions ?? DEFAULT_MAX_OPTIONS;
  const raw = asNullableRecord(flowJson);
  if (!raw || !Array.isArray(raw.screens) || !raw.screens.length) return null;
  const config: WhatsAppFlowConfig = {
    templateId: "custom",
    ctaText: "Open",
    flowNavigationMode: "static_graph",
    screens: [],
    ...(raw.version === "6.3" || raw.version === "7.3"
      ? { flowJsonVersion: raw.version }
      : {}),
  };
  const preview: FlowJsonPreview = {
    config,
    componentsByScreen: Object.create(null),
    usesExampleData: false,
    totalScreens: raw.screens.length,
  };
  for (const candidate of raw.screens.slice(0, MAX_SCREENS)) {
    const source = asNullableRecord(candidate);
    const id = identity(source?.id);
    const layout = asNullableRecord(source?.layout);
    if (
      !source ||
      !id ||
      !Array.isArray(layout?.children) ||
      config.screens.some(screen => screen.id === id)
    )
      continue;
    const screen: WhatsAppFlowScreenConfig = {
      id,
      title: text(source.title, 160),
      fields: [],
      ...(source.terminal === true ? { terminal: true } : {}),
      ...(typeof source.success === "boolean"
        ? { success: source.success }
        : {}),
    };
    const components: FlowPreviewComponent[] = [];
    preview.componentsByScreen[id] = components;
    const schemas = asNullableRecord(source.data);
    const examples: Record<string, unknown> = Object.create(null);
    if (schemas) {
      for (const [key, value] of Object.entries(schemas).slice(0, 20)) {
        const schema = parseWhatsAppFlowDataSchema(value);
        if (!schema || JSON.stringify(schema).length > 8192) continue;
        screen.data ??= Object.create(null);
        screen.data![key] = JSON.parse(JSON.stringify(schema));
        if (Object.hasOwn(schema, "__example__"))
          examples[key] = schema.__example__;
      }
    }
    const displayText = (value: unknown): string | null => {
      if (typeof value !== "string") return null;
      if (!value.includes("${")) return text(value);
      const result = evaluateWhatsAppFlowPayload(
        { value },
        { form: {}, data: examples }
      );
      if (!result.ok || typeof result.value.value !== "string") return null;
      preview.usesExampleData = true;
      return text(result.value.value);
    };
    const unsupported = (component: string) =>
      components.push({ kind: "unsupported", component: text(component, 80) });
    let truncated = layout.children.length > MAX_COMPONENTS;
    const children = layout.children.slice(0, MAX_COMPONENTS).flatMap(child => {
      const component = asNullableRecord(child);
      if (
        component?.type === "Form" &&
        Array.isArray(component.children) &&
        component.children.length > MAX_COMPONENTS
      )
        truncated = true;
      return component?.type === "Form" && Array.isArray(component.children)
        ? component.children.slice(0, MAX_COMPONENTS)
        : [child];
    });
    if (children.length > MAX_COMPONENTS) truncated = true;
    for (const [componentIndex, child] of children
      .slice(0, MAX_COMPONENTS)
      .entries()) {
      const component = asNullableRecord(child);
      const type = text(component?.type, 80) || "Component";
      const keepDynamic =
        limits.keepDynamicallyVisibleFields === true && FIELD_TYPES.has(type);
      if (
        !component ||
        !isShown(component.visible, keepDynamic) ||
        !isShown(component.enabled, keepDynamic)
      ) {
        unsupported(type);
        continue;
      }
      if (isWhatsAppFlowTextType(type) || type === "RichText") {
        const content = displayText(component.text);
        if (content === null || !isWhatsAppFlowTextType(type))
          unsupported(type);
        else {
          components.push({
            kind: "text",
            id: `text_${componentIndex}`,
            type,
            text: content,
          });
          if (
            Object.keys(component).some(
              key => !["type", "text", "visible", "enabled"].includes(key)
            )
          )
            unsupported(`${type} settings`);
        }
        continue;
      }
      if (type === "Footer") {
        const action = parseWhatsAppFlowScreenAction(
          component["on-click-action"]
        );
        const label = displayText(component.label);
        if (!action || !label || JSON.stringify(action).length > 8192)
          unsupported(type);
        else
          screen.footer = { label, action: JSON.parse(JSON.stringify(action)) };
        continue;
      }
      const fieldId = identity(component.name);
      if (!fieldId || screen.fields.some(field => field.id === fieldId)) {
        unsupported(type);
        continue;
      }
      if (type === "NavigationList") {
        const items = component["list-items"];
        if (!Array.isArray(items)) {
          unsupported(type);
          continue;
        }
        const navigationItems: WhatsAppFlowNavigationItem[] = [];
        for (const itemValue of items.slice(0, 20)) {
          const item = asNullableRecord(itemValue);
          const content = asNullableRecord(item?.["main-content"]);
          const title = displayText(content?.title);
          const action = parseWhatsAppFlowScreenAction(
            item?.["on-click-action"] ?? component["on-click-action"]
          );
          const itemId = identity(item?.id);
          if (
            !itemId ||
            !title ||
            !action ||
            action.name === "complete" ||
            JSON.stringify(action).length > 8192
          ) {
            unsupported(type);
            continue;
          }
          navigationItems.push({
            id: itemId,
            title,
            ...(content?.description
              ? { description: displayText(content.description) ?? "" }
              : {}),
            action: JSON.parse(JSON.stringify(action)),
          });
        }
        if (!navigationItems.length) {
          unsupported(type);
          continue;
        }
        screen.fields.push({
          id: fieldId,
          label: displayText(component.label) ?? "",
          fieldType: "NavigationList",
          navigationItems,
        });
      } else if (FIELD_TYPES.has(type)) {
        const label = displayText(component.label);
        if (
          label === null ||
          (component.required !== undefined &&
            typeof component.required !== "boolean")
        ) {
          unsupported(type);
          continue;
        }
        // A field kept under a condition may never be shown, so never required.
        const conditional =
          !isShown(component.visible, false) ||
          !isShown(component.enabled, false);
        const field: WhatsAppFlowFieldConfig = {
          id: fieldId,
          label,
          fieldType: type as WhatsAppFlowFieldConfig["fieldType"],
          ...(component.required === true && !conditional
            ? { required: true }
            : {}),
        };
        if (component["helper-text"])
          field.helperText = displayText(component["helper-text"]) ?? "";
        if (["Dropdown", "RadioButtonsGroup", "CheckboxGroup"].includes(type)) {
          const options = component["data-source"];
          if (!Array.isArray(options)) {
            unsupported(type);
            continue;
          }
          field.options = options.slice(0, maxOptions).flatMap(option => {
            const value = asNullableRecord(option);
            const optionId = identity(value?.id);
            const title = displayText(value?.title);
            if (!optionId || title === null) return [];
            return [
              {
                id: optionId,
                title,
                ...(value?.description
                  ? { description: displayText(value.description) ?? "" }
                  : {}),
              },
            ];
          });
        }
        screen.fields.push(field);
      } else {
        unsupported(type);
        continue;
      }
      components.push({ kind: "field", fieldId });
      if (
        Object.keys(component).some(
          key =>
            ![
              "type",
              "name",
              "label",
              "required",
              "helper-text",
              "input-type",
              "data-source",
              "list-items",
              "on-click-action",
              "visible",
              "enabled",
            ].includes(key)
        ) ||
        (component["input-type"] !== undefined &&
          component["input-type"] !== "text")
      )
        unsupported(`${type} settings`);
    }
    if (truncated) unsupported("Additional content");
    screen.layoutContent = components.filter(
      (component): component is WhatsAppFlowLayoutContentItem =>
        component.kind !== "unsupported"
    );
    config.screens.push(screen);
    if (JSON.stringify(preview).length > MAX_PREVIEW_CHARS) {
      config.screens.pop();
      delete preview.componentsByScreen[id];
      break;
    }
  }
  return config.screens.length ? preview : null;
}
