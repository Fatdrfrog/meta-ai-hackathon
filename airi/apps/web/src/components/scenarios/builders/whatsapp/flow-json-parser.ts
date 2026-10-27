import type {
  WhatsAppFlowConfig,
  WhatsAppFlowFieldConfig,
  WhatsAppFlowFieldType,
  WhatsAppFlowScreenConfig,
} from "@/components/scenarios/types";
import {
  WHATSAPP_FLOW_ENDPOINT_MAX_ROUTING_EDGES,
  parseWhatsAppFlowDataSchema,
  parseWhatsAppFlowScreenAction,
  type WhatsAppFlowDataSchema,
  isWhatsAppFlowTextType,
  type WhatsAppFlowLayoutContentItem,
} from "@icecore/scenario-contracts";
import { serializeCanonicalJson } from "@icecore/shared/lib/canonical-json";
import { DEFAULT_FLOW_CTA_TEXT } from "@/lib/scenarios/normalization";
import { inferFlowUiLocaleFromSubmitLabel } from "@/lib/scenarios/whatsapp-flow-ui-locale";
import {
  asNullableRecord,
  readNonEmptyString as asNonEmptyText,
} from "@icecore/shared/lib/value-utils";
import { generateFlowJson } from "./flow-json-generator";
import { validateWhatsAppFlowConfig } from "./flow-validation";

type ParseFlowJsonParams = {
  flowJson: unknown;
  flowId: string;
  flowName?: string | null;
  flowStatus?: string | null;
  previousConfig?: WhatsAppFlowConfig | null;
};

type JsonObject = Record<string, unknown>;

type ParsedFlowScreen = {
  config: WhatsAppFlowScreenConfig;
  footerLabel: string;
};

const MAX_IMPORTED_SCREENS = 20;
const MAX_IMPORTED_FIELDS_PER_SCREEN = 50;

const ROOT_KEYS = new Set([
  "version",
  "data_api_version",
  "routing_model",
  "screens",
]);
const SCREEN_KEYS = new Set([
  "id",
  "title",
  "terminal",
  "success",
  "data",
  "layout",
]);
const TEXT_KEYS = new Set(["type", "text"]);
const LAYOUT_KEYS = new Set(["type", "children"]);
const FORM_KEYS = new Set(["type", "name", "children"]);
const FOOTER_KEYS = new Set(["type", "label", "on-click-action"]);
const ACTION_KEYS = new Set(["name", "payload", "next"]);
const NEXT_KEYS = new Set(["type", "name"]);
const OPTION_KEYS = new Set(["id", "title", "description"]);
const NAVIGATION_ITEM_KEYS = new Set(["id", "main-content", "on-click-action"]);
const NAVIGATION_CONTENT_KEYS = new Set(["title", "description"]);

const FIELD_TYPE_BY_COMPONENT_TYPE: Partial<
  Record<string, WhatsAppFlowFieldType>
> = {
  TextInput: "TextInput",
  TextArea: "TextArea",
  Dropdown: "Dropdown",
  DatePicker: "DatePicker",
  RadioButtonsGroup: "RadioButtonsGroup",
  CheckboxGroup: "CheckboxGroup",
  NavigationList: "NavigationList",
};

const FIELD_KEYS_BY_TYPE: Record<WhatsAppFlowFieldType, ReadonlySet<string>> = {
  TextInput: new Set([
    "type",
    "name",
    "label",
    "required",
    "helper-text",
    "input-type",
  ]),
  TextArea: new Set(["type", "name", "label", "required", "helper-text"]),
  Dropdown: new Set(["type", "name", "label", "required", "data-source"]),
  DatePicker: new Set(["type", "name", "label", "required"]),
  RadioButtonsGroup: new Set([
    "type",
    "name",
    "label",
    "required",
    "data-source",
  ]),
  CheckboxGroup: new Set(["type", "name", "label", "required", "data-source"]),
  NavigationList: new Set(["type", "name", "list-items"]),
};

const OPTION_FIELD_TYPES = new Set<WhatsAppFlowFieldType>([
  "Dropdown",
  "RadioButtonsGroup",
  "CheckboxGroup",
]);

function hasOnlyKeys(
  value: JsonObject,
  supportedKeys: ReadonlySet<string>
): boolean {
  return Object.keys(value).every(key => supportedKeys.has(key));
}

function canRoundTripFlowJsonLosslessly(
  source: unknown,
  parsedConfig: WhatsAppFlowConfig
): boolean {
  try {
    return (
      serializeCanonicalJson(source) ===
      serializeCanonicalJson(generateFlowJson(parsedConfig))
    );
  } catch {
    return false;
  }
}

function parseOptions(
  value: unknown
): Array<{ id: string; title: string; description?: string }> | null {
  if (!Array.isArray(value)) return null;

  const options: Array<{ id: string; title: string; description?: string }> =
    [];
  for (const option of value) {
    const raw = asNullableRecord(option);
    if (!raw || !hasOnlyKeys(raw, OPTION_KEYS)) return null;
    const id = asNonEmptyText(raw.id);
    const title = asNonEmptyText(raw.title);
    if (!id || !title) return null;
    const description = Object.hasOwn(raw, "description")
      ? asNonEmptyText(raw.description)
      : undefined;
    if (description === null) return null;
    options.push({
      id,
      title,
      ...(description !== undefined ? { description } : {}),
    });
  }
  return options;
}

function toFieldConfig(component: unknown): WhatsAppFlowFieldConfig | null {
  const raw = asNullableRecord(component);
  if (!raw) return null;
  const componentType = asNonEmptyText(raw.type);
  if (!componentType) return null;
  const fieldType = FIELD_TYPE_BY_COMPONENT_TYPE[componentType];
  if (!fieldType) return null;
  if (!hasOnlyKeys(raw, FIELD_KEYS_BY_TYPE[fieldType])) return null;

  const fieldId = asNonEmptyText(raw.name);
  if (fieldType === "NavigationList") {
    const items = raw["list-items"];
    if (
      !fieldId ||
      !Array.isArray(items) ||
      items.length < 1 ||
      items.length > 20
    )
      return null;
    const navigationItems: NonNullable<
      WhatsAppFlowFieldConfig["navigationItems"]
    > = [];
    for (const value of items) {
      const item = asNullableRecord(value);
      if (!item || !hasOnlyKeys(item, NAVIGATION_ITEM_KEYS)) return null;
      const content = asNullableRecord(item["main-content"]);
      if (!content || !hasOnlyKeys(content, NAVIGATION_CONTENT_KEYS))
        return null;
      const id = asNonEmptyText(item.id);
      const title = asNonEmptyText(content.title);
      const description = Object.hasOwn(content, "description")
        ? asNonEmptyText(content.description)
        : undefined;
      const action = parseWhatsAppFlowScreenAction(item["on-click-action"]);
      if (
        !id ||
        !title ||
        description === null ||
        !action ||
        action.name !== "navigate"
      )
        return null;
      navigationItems.push({
        id,
        title,
        ...(description !== undefined ? { description } : {}),
        action,
      });
    }
    return { id: fieldId, label: "", fieldType, navigationItems };
  }
  const fieldLabel = asNonEmptyText(raw.label);
  if (!fieldId || !fieldLabel || typeof raw.required !== "boolean") return null;

  if (fieldType === "TextInput" && raw["input-type"] !== "text") return null;

  const hasHelperText = Object.hasOwn(raw, "helper-text");
  const helperText = hasHelperText ? asNonEmptyText(raw["helper-text"]) : null;
  if (hasHelperText && !helperText) return null;

  const options = OPTION_FIELD_TYPES.has(fieldType)
    ? parseOptions(raw["data-source"])
    : undefined;
  if (options === null) return null;

  return {
    id: fieldId,
    label: fieldLabel,
    fieldType,
    required: raw.required,
    ...(helperText ? { helperText } : {}),
    ...(options ? { options } : {}),
  } satisfies WhatsAppFlowFieldConfig;
}

function parseFooter(
  value: unknown,
  isTerminal: boolean,
  isEndpoint: boolean
): string | null {
  const footer = asNullableRecord(value);
  if (
    !footer ||
    !hasOnlyKeys(footer, FOOTER_KEYS) ||
    footer.type !== "Footer"
  ) {
    return null;
  }

  const label = asNonEmptyText(footer.label);
  const action = asNullableRecord(footer["on-click-action"]);
  if (!label || !action || !hasOnlyKeys(action, ACTION_KEYS)) return null;
  const expectedAction = isTerminal
    ? "complete"
    : isEndpoint
      ? "data_exchange"
      : "navigate";
  if (action.name !== expectedAction) return null;
  if (!asNullableRecord(action.payload)) return null;

  if (isTerminal) {
    if (Object.hasOwn(action, "next")) return null;
  } else if (!isEndpoint) {
    const next = asNullableRecord(action.next);
    if (
      !next ||
      !hasOnlyKeys(next, NEXT_KEYS) ||
      next.type !== "screen" ||
      !asNonEmptyText(next.name)
    ) {
      return null;
    }
  }

  return label;
}

function toScreenConfig(
  value: unknown,
  isTerminal: boolean,
  isEndpoint: boolean
): ParsedFlowScreen | null {
  const screen = asNullableRecord(value);
  if (!screen || !hasOnlyKeys(screen, SCREEN_KEYS)) return null;

  const id = asNonEmptyText(screen.id);
  const title = asNonEmptyText(screen.title);
  if (!id || !title) return null;
  if (
    isTerminal ? screen.terminal !== true : Object.hasOwn(screen, "terminal")
  ) {
    return null;
  }
  if (Object.hasOwn(screen, "data") && !asNullableRecord(screen.data))
    return null;

  const layout = asNullableRecord(screen.layout);
  if (
    !layout ||
    !hasOnlyKeys(layout, LAYOUT_KEYS) ||
    layout.type !== "SingleColumnLayout" ||
    !Array.isArray(layout.children) ||
    layout.children.length !== 1
  ) {
    return null;
  }

  const form = asNullableRecord(layout.children[0]);
  if (
    !form ||
    !hasOnlyKeys(form, FORM_KEYS) ||
    form.type !== "Form" ||
    !asNonEmptyText(form.name) ||
    !Array.isArray(form.children)
  ) {
    return null;
  }

  const fieldComponents = form.children.slice(0, -1);
  if (
    fieldComponents.length === 0 ||
    fieldComponents.length > MAX_IMPORTED_FIELDS_PER_SCREEN
  ) {
    return null;
  }

  const fields: WhatsAppFlowFieldConfig[] = [];
  for (const component of fieldComponents) {
    const field = toFieldConfig(component);
    if (!field) return null;
    fields.push(field);
  }

  const footerLabel = parseFooter(form.children.at(-1), isTerminal, isEndpoint);
  if (!footerLabel) return null;

  return {
    config: { id, title, fields },
    footerLabel,
  };
}

function parseEndpointRoutes(
  value: unknown,
  screenIds: string[]
): Record<string, string[]> | null {
  const raw = asNullableRecord(value);
  if (!raw) return null;
  const screenIdSet = new Set(screenIds);
  const routes: Record<string, string[]> = {};
  if (Object.keys(raw).length !== screenIds.length) return null;
  let edgeCount = 0;

  for (const screenId of screenIds) {
    const targets = raw[screenId];
    if (!Array.isArray(targets)) return null;
    edgeCount += targets.length;
    if (edgeCount > WHATSAPP_FLOW_ENDPOINT_MAX_ROUTING_EDGES) return null;
    const normalizedTargets = targets.filter(
      (target): target is string =>
        typeof target === "string" && target.trim().length > 0
    );
    if (normalizedTargets.length !== targets.length) return null;
    if (new Set(normalizedTargets).size !== normalizedTargets.length)
      return null;
    if (
      normalizedTargets.some(
        target => !screenIdSet.has(target) || target === screenId
      )
    ) {
      return null;
    }
    if (screenId !== screenIds.at(-1) && normalizedTargets.length === 0) {
      return null;
    }
    routes[screenId] = normalizedTargets;
  }

  return routes;
}

function parseLegacyFlowJsonToWhatsAppFlowConfig(
  params: ParseFlowJsonParams
): WhatsAppFlowConfig | null {
  try {
    const root = asNullableRecord(params.flowJson);
    if (!root || !hasOnlyKeys(root, ROOT_KEYS)) return null;
    const version = root.version;
    if (
      (version !== "6.3" && version !== "7.3") ||
      !Array.isArray(root.screens) ||
      root.screens.length === 0 ||
      root.screens.length > MAX_IMPORTED_SCREENS
    ) {
      return null;
    }

    const isEndpoint =
      Object.hasOwn(root, "data_api_version") ||
      Object.hasOwn(root, "routing_model");
    if (isEndpoint && root.data_api_version !== "4.0") return null;
    const parsedScreens: ParsedFlowScreen[] = [];
    for (const [index, screen] of root.screens.entries()) {
      const parsed = toScreenConfig(
        screen,
        index === root.screens.length - 1,
        isEndpoint
      );
      if (!parsed) return null;
      parsedScreens.push(parsed);
    }

    const screenIds = parsedScreens.map(screen => screen.config.id);
    const endpointRoutes = isEndpoint
      ? parseEndpointRoutes(root.routing_model, screenIds)
      : null;
    if (isEndpoint && !endpointRoutes) return null;

    const footerSubmitLabel = parsedScreens.at(-1)?.footerLabel;
    if (!footerSubmitLabel) return null;
    const inferredLocale = inferFlowUiLocaleFromSubmitLabel(footerSubmitLabel);

    const parsedConfig: WhatsAppFlowConfig = {
      templateId: "existing_flow",
      flowJsonVersion: version,
      screens: parsedScreens.map(screen => screen.config),
      ctaText:
        (params.previousConfig?.ctaText || "").trim() || DEFAULT_FLOW_CTA_TEXT,
      headerText: params.previousConfig?.headerText,
      bodyText: params.previousConfig?.bodyText,
      footerText: params.previousConfig?.footerText,
      flowUiLocale:
        inferredLocale ?? params.previousConfig?.flowUiLocale ?? "en",
      ...(!inferredLocale ? { flowSubmitLabel: footerSubmitLabel } : {}),
      ...(isEndpoint
        ? {
            flowNavigationMode: "data_endpoint" as const,
            screenRoutes: Object.fromEntries(
              screenIds
                .slice(0, -1)
                .map(screenId => [screenId, endpointRoutes![screenId]])
            ),
          }
        : {}),
      metaFlowId: params.flowId,
      metaFlowName:
        params.flowName ?? params.previousConfig?.metaFlowName ?? null,
      metaFlowStatus:
        params.flowStatus ?? params.previousConfig?.metaFlowStatus ?? null,
    };

    // Structural parsing rejects unsupported input early. This final oracle
    // protects derived payloads, routing, data schemas, and future additions.
    return canRoundTripFlowJsonLosslessly(params.flowJson, parsedConfig)
      ? parsedConfig
      : null;
  } catch {
    return null;
  }
}

/** Adds explicit static graph shapes without relaxing the final lossless oracle. */
export function parseFlowJsonToWhatsAppFlowConfig(
  params: ParseFlowJsonParams
): WhatsAppFlowConfig | null {
  const legacy = parseLegacyFlowJsonToWhatsAppFlowConfig(params);
  if (legacy) return legacy;
  try {
    const root = asNullableRecord(params.flowJson);
    if (
      !root ||
      !hasOnlyKeys(root, ROOT_KEYS) ||
      (root.version !== "6.3" && root.version !== "7.3")
    )
      return null;
    if (
      Object.hasOwn(root, "data_api_version") ||
      Object.hasOwn(root, "routing_model")
    )
      return null;
    if (
      !Array.isArray(root.screens) ||
      !root.screens.length ||
      root.screens.length > MAX_IMPORTED_SCREENS
    )
      return null;
    const screens: WhatsAppFlowScreenConfig[] = [];
    for (const value of root.screens) {
      const raw = asNullableRecord(value);
      if (!raw || !hasOnlyKeys(raw, SCREEN_KEYS)) return null;
      const id = asNonEmptyText(raw.id);
      const title = asNonEmptyText(raw.title);
      if (
        !id ||
        !title ||
        (Object.hasOwn(raw, "terminal") && typeof raw.terminal !== "boolean") ||
        (Object.hasOwn(raw, "success") &&
          (typeof raw.success !== "boolean" || raw.terminal !== true))
      )
        return null;
      const layout = asNullableRecord(raw.layout);
      if (
        !layout ||
        !hasOnlyKeys(layout, LAYOUT_KEYS) ||
        layout.type !== "SingleColumnLayout" ||
        !Array.isArray(layout.children)
      )
        return null;
      let components = layout.children;
      let layoutForm: WhatsAppFlowScreenConfig["layoutForm"];
      if (
        components.length === 1 &&
        asNullableRecord(components[0])?.type === "Form"
      ) {
        const form = asNullableRecord(components[0])!;
        if (
          !hasOnlyKeys(form, FORM_KEYS) ||
          !asNonEmptyText(form.name) ||
          !Array.isArray(form.children)
        )
          return null;
        layoutForm = { name: form.name as string };
        components = form.children;
      }
      let footer: WhatsAppFlowScreenConfig["footer"];
      if (asNullableRecord(components.at(-1))?.type === "Footer") {
        const rawFooter = asNullableRecord(components.at(-1))!;
        if (!hasOnlyKeys(rawFooter, FOOTER_KEYS)) return null;
        const label = asNonEmptyText(rawFooter.label);
        const action = parseWhatsAppFlowScreenAction(
          rawFooter["on-click-action"]
        );
        if (!label || !action || action.name === "data_exchange") return null;
        footer = { label, action };
        components = components.slice(0, -1);
      }
      if (components.length > MAX_IMPORTED_FIELDS_PER_SCREEN) return null;
      const fields: WhatsAppFlowFieldConfig[] = [];
      const layoutContent: WhatsAppFlowLayoutContentItem[] = [];
      let hasTextContent = false;
      for (const [componentIndex, component] of components.entries()) {
        const rawComponent = asNullableRecord(component);
        if (rawComponent && isWhatsAppFlowTextType(rawComponent.type)) {
          if (
            !hasOnlyKeys(rawComponent, TEXT_KEYS) ||
            typeof rawComponent.text !== "string" ||
            !rawComponent.text.trim() ||
            rawComponent.text.includes("${")
          )
            return null;
          hasTextContent = true;
          layoutContent.push({
            kind: "text",
            id: `text_${componentIndex + 1}`,
            type: rawComponent.type,
            text: rawComponent.text,
          });
          continue;
        }
        const field = toFieldConfig(component);
        if (!field) return null;
        fields.push(field);
        layoutContent.push({ kind: "field", fieldId: field.id });
      }
      let data: Record<string, WhatsAppFlowDataSchema> | undefined;
      if (Object.hasOwn(raw, "data")) {
        const rawData = asNullableRecord(raw.data);
        if (!rawData || Object.keys(rawData).length > 50) return null;
        data = {};
        for (const [key, entry] of Object.entries(rawData)) {
          const schema = parseWhatsAppFlowDataSchema(entry);
          if (!schema) return null;
          Object.defineProperty(data, key, {
            value: schema,
            enumerable: true,
            configurable: true,
            writable: true,
          });
        }
      }
      screens.push({
        id,
        title,
        fields,
        ...(typeof raw.terminal === "boolean"
          ? { terminal: raw.terminal }
          : {}),
        ...(typeof raw.success === "boolean" ? { success: raw.success } : {}),
        ...(hasTextContent ? { layoutContent } : {}),
        ...(data !== undefined ? { data } : {}),
        ...(layoutForm ? { layoutForm } : {}),
        ...(footer ? { footer } : {}),
      });
    }
    const config: WhatsAppFlowConfig = {
      templateId: "existing_flow",
      ctaText: params.previousConfig?.ctaText || DEFAULT_FLOW_CTA_TEXT,
      flowNavigationMode: "static_graph",
      flowJsonVersion: root.version,
      screens,
      headerText: params.previousConfig?.headerText,
      bodyText: params.previousConfig?.bodyText,
      footerText: params.previousConfig?.footerText,
      flowUiLocale: params.previousConfig?.flowUiLocale ?? "en",
      metaFlowId: params.flowId,
      metaFlowName:
        params.flowName ?? params.previousConfig?.metaFlowName ?? null,
      metaFlowStatus:
        params.flowStatus ?? params.previousConfig?.metaFlowStatus ?? null,
    };
    return validateWhatsAppFlowConfig(config).isValid &&
      canRoundTripFlowJsonLosslessly(params.flowJson, config)
      ? config
      : null;
  } catch {
    return null;
  }
}
