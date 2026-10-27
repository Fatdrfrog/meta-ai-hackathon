import type {
  WhatsAppFlowConfig,
  WhatsAppFlowDataSchema,
  WhatsAppFlowPayloadValue,
  WhatsAppFlowScreenAction,
} from "./scenario-channel-configs";
import {
  validateWhatsAppFlowScreenLayout,
  type WhatsAppFlowLayoutIssueCode,
} from "./whatsapp-flow-layout";
import { asNullableRecord, isNonEmptyString } from "./value-guards";

const REFERENCE = /^\$\{(form|data)\.([A-Za-z_][A-Za-z0-9_]*)\}$/;
const MAX_VALUE_DEPTH = 12;
const MAX_VALUE_NODES = 2000;
export const WHATSAPP_FLOW_NAVIGATION_MAX_ITEMS = 20;

export function parseWhatsAppFlowPayloadReference(
  value: unknown,
): { scope: "form" | "data"; fieldId: string } | null {
  const match = typeof value === "string" ? REFERENCE.exec(value) : null;
  return match
    ? { scope: match[1] as "form" | "data", fieldId: match[2]! }
    : null;
}

/** Bounded JSON values; static expression support is deliberately narrower than Meta's full language. */
function isBoundedJsonValue(
  value: unknown,
  expressions: boolean,
): value is WhatsAppFlowPayloadValue {
  let nodes = 0;
  const visit = (current: unknown, depth: number): boolean => {
    if (++nodes > MAX_VALUE_NODES || depth > MAX_VALUE_DEPTH) return false;
    if (current === null || typeof current === "boolean") return true;
    if (typeof current === "number") return Number.isFinite(current);
    if (typeof current === "string")
      return (
        current.length <= 10000 &&
        (!expressions || !current.includes("${") || REFERENCE.test(current))
      );
    if (Array.isArray(current))
      return (
        current.length <= MAX_VALUE_NODES &&
        current.every((item) => visit(item, depth + 1))
      );
    const record = asNullableRecord(current);
    if (record && Object.keys(record).length > MAX_VALUE_NODES - nodes)
      return false;
    return Boolean(
      record &&
        Object.entries(record).every(
          ([key, item]) =>
            key.length > 0 && key.length <= 100 && visit(item, depth + 1),
        ),
    );
  };
  return visit(value, 0);
}

export function isWhatsAppFlowPayloadValue(
  value: unknown,
): value is WhatsAppFlowPayloadValue {
  return isBoundedJsonValue(value, true);
}

function cloneValue<T extends WhatsAppFlowPayloadValue>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function parseWhatsAppFlowScreenAction(
  value: unknown,
): WhatsAppFlowScreenAction | null {
  const raw = asNullableRecord(value);
  if (
    !raw ||
    Object.keys(raw).some((key) => !["name", "payload", "next"].includes(key))
  )
    return null;
  if (
    Object.hasOwn(raw, "payload") &&
    (!asNullableRecord(raw.payload) || !isWhatsAppFlowPayloadValue(raw.payload))
  )
    return null;
  const payload = Object.hasOwn(raw, "payload")
    ? {
        payload: cloneValue(
          raw.payload as Record<string, WhatsAppFlowPayloadValue>,
        ),
      }
    : {};
  if (raw.name === "complete" || raw.name === "data_exchange") {
    return Object.hasOwn(raw, "next") ? null : { name: raw.name, ...payload };
  }
  const next = asNullableRecord(raw.next);
  if (
    raw.name !== "navigate" ||
    !next ||
    Object.keys(next).some((key) => !["type", "name"].includes(key)) ||
    next.type !== "screen" ||
    typeof next.name !== "string" ||
    !next.name.trim()
  )
    return null;
  return { name: "navigate", nextScreenId: next.name, ...payload };
}

export function parseWhatsAppFlowDataSchema(
  value: unknown,
): WhatsAppFlowDataSchema | null {
  let nodes = 0;
  const visit = (
    current: unknown,
    depth: number,
  ): WhatsAppFlowDataSchema | null => {
    if (++nodes > MAX_VALUE_NODES || depth > MAX_VALUE_DEPTH) return null;
    const raw = asNullableRecord(current);
    if (
      !raw ||
      Object.keys(raw).some(
        (key) => !["type", "__example__", "items", "properties"].includes(key),
      )
    )
      return null;
    if (
      typeof raw.type !== "string" ||
      !["string", "number", "boolean", "array", "object"].includes(raw.type)
    )
      return null;
    if (
      Object.hasOwn(raw, "__example__") &&
      !isBoundedJsonValue(raw.__example__, false)
    )
      return null;
    const schema: WhatsAppFlowDataSchema = {
      type: raw.type as WhatsAppFlowDataSchema["type"],
    };
    if (Object.hasOwn(raw, "__example__"))
      schema.__example__ = cloneValue(
        raw.__example__ as WhatsAppFlowPayloadValue,
      );
    if (raw.type === "array") {
      const items = visit(raw.items, depth + 1);
      if (!items || Object.hasOwn(raw, "properties")) return null;
      schema.items = items;
    } else if (Object.hasOwn(raw, "items")) return null;
    if (Object.hasOwn(raw, "properties")) {
      const properties = asNullableRecord(raw.properties);
      if (raw.type !== "object" || !properties) return null;
      const parsed: Record<string, WhatsAppFlowDataSchema> = {};
      for (const [key, entry] of Object.entries(properties)) {
        const child = visit(entry, depth + 1);
        if (!child) return null;
        Object.defineProperty(parsed, key, {
          value: child,
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
      schema.properties = parsed;
    }
    if (
      Object.hasOwn(schema, "__example__") &&
      !literalMatchesSchema(schema.__example__!, schema)
    )
      return null;
    return schema;
  };
  return visit(value, 0);
}

export function evaluateWhatsAppFlowPayload(
  payload: Record<string, WhatsAppFlowPayloadValue> | undefined,
  context: { form: Record<string, unknown>; data: Record<string, unknown> },
): { ok: true; value: Record<string, unknown> } | { ok: false } {
  const source = payload ?? {};
  if (!asNullableRecord(source) || !isWhatsAppFlowPayloadValue(source))
    return { ok: false };
  let valid = true;
  const visit = (value: WhatsAppFlowPayloadValue): unknown => {
    if (typeof value === "string") {
      const reference = REFERENCE.exec(value);
      if (!reference) return value;
      const scope = reference[1] === "form" ? context.form : context.data;
      const key = reference[2]!;
      if (
        !Object.hasOwn(scope, key) ||
        !isBoundedJsonValue(scope[key], false)
      ) {
        valid = false;
        return null;
      }
      return cloneValue(scope[key]);
    }
    if (Array.isArray(value)) return value.map(visit);
    if (value !== null && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([key, child]) => [key, visit(child)]),
      );
    return value;
  };
  const value = visit(source) as Record<string, unknown>;
  return valid ? { ok: true, value } : { ok: false };
}

export type WhatsAppFlowStaticGraphIssueCode =
  | WhatsAppFlowLayoutIssueCode
  | "flow_graph_screen_duplicate"
  | "flow_field_id_duplicate_within_screen"
  | "flow_graph_action_invalid"
  | "flow_graph_target_invalid"
  | "flow_graph_screen_unreachable"
  | "flow_graph_cycle"
  | "flow_graph_terminal_required"
  | "flow_graph_payload_invalid"
  | "flow_graph_data_invalid"
  | "flow_navigation_items_invalid"
  | "flow_navigation_composition_invalid"
  | "flow_navigation_item_text_invalid"
  | "flow_option_description_max_length"
  | "flow_graph_bounds_exceeded";
export type WhatsAppFlowStaticGraphIssue = {
  code: WhatsAppFlowStaticGraphIssueCode;
  path: string;
};

function literalMatchesSchema(
  value: WhatsAppFlowPayloadValue,
  schema: WhatsAppFlowDataSchema,
): boolean {
  if (schema.type === "array")
    return (
      Array.isArray(value) &&
      Boolean(schema.items) &&
      value.every((child) => literalMatchesSchema(child, schema.items!))
    );
  if (schema.type === "object") {
    const record = asNullableRecord(value);
    return Boolean(
      record &&
        Object.entries(schema.properties ?? {}).every(
          ([key, child]) =>
            Object.hasOwn(record, key) &&
            literalMatchesSchema(
              record[key] as WhatsAppFlowPayloadValue,
              child,
            ),
        ),
    );
  }
  return typeof value === schema.type;
}

function schemaMatchesSchema(
  source: WhatsAppFlowDataSchema,
  target: WhatsAppFlowDataSchema,
): boolean {
  if (source.type !== target.type) return false;
  if (target.type === "array")
    return Boolean(
      source.items &&
        target.items &&
        schemaMatchesSchema(source.items, target.items),
    );
  if (target.type === "object")
    return Object.entries(target.properties ?? {}).every(([key, child]) =>
      Boolean(
        source.properties?.[key] &&
          schemaMatchesSchema(source.properties[key]!, child),
      ),
    );
  return true;
}

function payloadMatchesSchema(
  value: WhatsAppFlowPayloadValue,
  schema: WhatsAppFlowDataSchema,
  screen: WhatsAppFlowConfig["screens"][number],
): boolean {
  if (typeof value === "string") {
    const ref = REFERENCE.exec(value);
    if (ref) {
      const field = screen.fields.find((candidate) => candidate.id === ref[2]);
      const sourceSchema: WhatsAppFlowDataSchema | undefined =
        ref[1] === "data"
          ? screen.data?.[ref[2]!]
          : field
            ? field.fieldType === "CheckboxGroup"
              ? { type: "array", items: { type: "string" } }
              : { type: "string" }
            : undefined;
      return Boolean(sourceSchema && schemaMatchesSchema(sourceSchema, schema));
    }
  }
  if (schema.type === "array")
    return (
      Array.isArray(value) &&
      Boolean(schema.items) &&
      value.every((child) => payloadMatchesSchema(child, schema.items!, screen))
    );
  if (schema.type === "object") {
    const record = asNullableRecord(value);
    return Boolean(
      record &&
        Object.entries(schema.properties ?? {}).every(
          ([key, child]) =>
            Object.hasOwn(record, key) &&
            payloadMatchesSchema(
              record[key] as WhatsAppFlowPayloadValue,
              child,
              screen,
            ),
        ),
    );
  }
  return typeof value === schema.type;
}

export function validateWhatsAppFlowStaticGraph(
  config: WhatsAppFlowConfig,
): WhatsAppFlowStaticGraphIssue[] {
  if (config.flowNavigationMode !== "static_graph") {
    const issues: WhatsAppFlowStaticGraphIssue[] = config.screens.flatMap(
      (screen, index) =>
        screen.layoutContent !== undefined || screen.success !== undefined
          ? [
              {
                code: "flow_layout_content_invalid" as const,
                path: `screens[${index}]`,
              },
            ]
          : [],
    );
    if (
      config.screens.some((screen) =>
        screen.fields.some((field) => field.fieldType === "NavigationList"),
      )
    )
      issues.push({
        code: "flow_graph_action_invalid",
        path: "flowNavigationMode",
      });
    return issues;
  }
  if (config.screens.length === 0 || config.screens.length > 20)
    return [{ code: "flow_graph_bounds_exceeded", path: "screens" }];
  const issues: WhatsAppFlowStaticGraphIssue[] = [];
  const issue = (code: WhatsAppFlowStaticGraphIssueCode, path: string) =>
    issues.push({ code, path });
  const screens = new Map(config.screens.map((screen) => [screen.id, screen]));
  const edges = new Map<string, string[]>();
  const visitPayload = (
    value: WhatsAppFlowPayloadValue,
    screen: WhatsAppFlowConfig["screens"][number],
    path: string,
  ) => {
    if (typeof value === "string") {
      const ref = REFERENCE.exec(value);
      if (
        ref &&
        !(ref[1] === "form"
          ? screen.fields.some(
              (field) =>
                field.id === ref[2] && field.fieldType !== "NavigationList",
            )
          : Object.hasOwn(screen.data ?? {}, ref[2]!))
      )
        issue("flow_graph_payload_invalid", path);
    } else if (Array.isArray(value))
      value.forEach((child, index) =>
        visitPayload(child, screen, `${path}[${index}]`),
      );
    else if (value && typeof value === "object")
      Object.entries(value).forEach(([key, child]) =>
        visitPayload(child, screen, `${path}.${key}`),
      );
  };
  config.screens.forEach((screen, index) => {
    const path = `screens[${index}]`;
    if (
      screen.fields.length > 50 ||
      Object.keys(screen.data ?? {}).length > 50
    ) {
      issue("flow_graph_bounds_exceeded", path);
      return;
    }
    if (
      config.screens.findIndex((candidate) => candidate.id === screen.id) !==
      index
    )
      issue("flow_graph_screen_duplicate", `${path}.id`);
    issues.push(...validateWhatsAppFlowScreenLayout(screen, path));
    const navigationCount = screen.fields.filter(
      (field) => field.fieldType === "NavigationList",
    ).length;
    if (
      navigationCount > 0 &&
      (navigationCount > 2 ||
        navigationCount !== screen.fields.length ||
        (Array.isArray(screen.layoutContent) &&
          screen.layoutContent.some((item) => item?.kind === "text")) ||
        screen.footer ||
        screen.terminal === true)
    )
      issue("flow_navigation_composition_invalid", `${path}.fields`);
    const outgoing: string[] = [];
    edges.set(screen.id, outgoing);
    if (screen.data)
      for (const [key, schema] of Object.entries(screen.data))
        if (!parseWhatsAppFlowDataSchema(schema))
          issue("flow_graph_data_invalid", `${path}.data.${key}`);
    const action = (
      entry: WhatsAppFlowScreenAction,
      actionPath: string,
      navigationItem = false,
    ) => {
      if (
        !entry ||
        !["navigate", "complete"].includes(entry.name) ||
        (navigationItem && entry.name !== "navigate") ||
        (entry.name === "complete" && screen.terminal !== true) ||
        (entry.name === "navigate" && screen.terminal === true)
      ) {
        issue("flow_graph_action_invalid", actionPath);
        return;
      }
      if (entry.payload !== undefined) {
        if (
          !asNullableRecord(entry.payload) ||
          !isWhatsAppFlowPayloadValue(entry.payload)
        ) {
          issue("flow_graph_payload_invalid", `${actionPath}.payload`);
          return;
        }
        visitPayload(entry.payload, screen, `${actionPath}.payload`);
      }
      if (entry.name === "navigate") {
        const target = screens.get(entry.nextScreenId);
        if (!target || target.id === screen.id)
          issue("flow_graph_target_invalid", `${actionPath}.nextScreenId`);
        else {
          outgoing.push(target.id);
          const keys = Object.keys(target.data ?? {});
          if (
            keys.some((key) => !Object.hasOwn(entry.payload ?? {}, key)) ||
            Object.keys(entry.payload ?? {}).some(
              (key) => !Object.hasOwn(target.data ?? {}, key),
            )
          )
            issue("flow_graph_payload_invalid", `${actionPath}.payload`);
          for (const key of keys) {
            const value = entry.payload?.[key];
            if (
              value !== undefined &&
              !payloadMatchesSchema(value, target.data![key]!, screen)
            )
              issue(
                "flow_graph_payload_invalid",
                `${actionPath}.payload.${key}`,
              );
          }
        }
      }
    };
    const names = new Set<string>();
    screen.fields.forEach((field, fieldIndex) => {
      const fieldPath = `${path}.fields[${fieldIndex}]`;
      if (names.has(field.id))
        issue("flow_field_id_duplicate_within_screen", `${fieldPath}.id`);
      names.add(field.id);
      field.options?.forEach((option, optionIndex) => {
        if (option.description && [...option.description].length > 300)
          issue(
            "flow_option_description_max_length",
            `${fieldPath}.options[${optionIndex}].description`,
          );
      });
      if (field.fieldType !== "NavigationList") return;
      const items = field.navigationItems;
      if (!items?.length || items.length > WHATSAPP_FLOW_NAVIGATION_MAX_ITEMS) {
        issue("flow_navigation_items_invalid", `${fieldPath}.navigationItems`);
        return;
      }
      const itemIds = new Set<string>();
      items.forEach((item, itemIndex) => {
        const itemPath = `${fieldPath}.navigationItems[${itemIndex}]`;
        if (!isNonEmptyString(item.id) || itemIds.has(item.id))
          issue("flow_navigation_items_invalid", `${itemPath}.id`);
        itemIds.add(item.id);
        if (!isNonEmptyString(item.title) || [...item.title].length > 30)
          issue("flow_navigation_item_text_invalid", `${itemPath}.title`);
        if (
          item.description !== undefined &&
          (!isNonEmptyString(item.description) ||
            [...item.description].length > 20)
        )
          issue("flow_navigation_item_text_invalid", `${itemPath}.description`);
        action(item.action, `${itemPath}.action`, true);
      });
    });
    if (screen.footer) action(screen.footer.action, `${path}.footer.action`);
    if (
      screen.terminal === true
        ? screen.footer?.action.name !== "complete"
        : outgoing.length === 0
    )
      issue("flow_graph_terminal_required", path);
  });
  if (!config.screens.some((screen) => screen.terminal === true))
    issue("flow_graph_terminal_required", "screens");
  const visited = new Set<string>();
  const active = new Set<string>();
  const visit = (id: string) => {
    if (active.has(id)) {
      issue("flow_graph_cycle", "screens");
      return;
    }
    if (visited.has(id)) return;
    visited.add(id);
    active.add(id);
    for (const target of edges.get(id) ?? []) visit(target);
    active.delete(id);
  };
  if (config.screens[0]) visit(config.screens[0].id);
  config.screens.forEach((screen, index) => {
    if (!visited.has(screen.id))
      issue("flow_graph_screen_unreachable", `screens[${index}].id`);
  });
  return issues;
}
