import type {
  WhatsAppFlowLayoutContentItem,
  WhatsAppFlowScreenConfig,
  WhatsAppFlowTextType,
} from "./scenario-channel-configs";

/** Literal component limits from Meta's Flow components guide, #text. */
export const WHATSAPP_FLOW_TEXT_MAX_LENGTH: Readonly<
  Record<WhatsAppFlowTextType, number>
> = {
  TextHeading: 80,
  TextSubheading: 80,
  TextBody: 4096,
  TextCaption: 409,
};

export function isWhatsAppFlowTextType(
  value: unknown,
): value is WhatsAppFlowTextType {
  return (
    typeof value === "string" &&
    Object.hasOwn(WHATSAPP_FLOW_TEXT_MAX_LENGTH, value)
  );
}

/** Resolve order only; invalid references remain visible to canonical validation. */
export function resolveWhatsAppFlowLayoutContent(
  screen: Pick<WhatsAppFlowScreenConfig, "fields" | "layoutContent">,
): WhatsAppFlowLayoutContentItem[] {
  return screen.layoutContent === undefined
    ? screen.fields.map((field) => ({ kind: "field", fieldId: field.id }))
    : Array.isArray(screen.layoutContent)
      ? screen.layoutContent.slice()
      : [];
}

/** Synchronize an explicit order after an intentional field edit, leaving literal blocks in place. */
export function syncWhatsAppFlowLayoutContent(
  screen: WhatsAppFlowScreenConfig,
  fieldIdRename?: { from: string; to: string },
): WhatsAppFlowScreenConfig {
  if (screen.layoutContent === undefined) return screen;
  const fieldIds = new Set(screen.fields.map((field) => field.id));
  const represented = new Set<string>();
  const layoutContent = resolveWhatsAppFlowLayoutContent(
    screen,
  ).flatMap<WhatsAppFlowLayoutContentItem>((item) => {
    if (item.kind !== "field") return [item];
    const fieldId =
      fieldIdRename && item.fieldId === fieldIdRename.from
        ? fieldIdRename.to
        : item.fieldId;
    if (!fieldIds.has(fieldId)) return [];
    represented.add(fieldId);
    return [{ kind: "field" as const, fieldId }];
  });
  for (const field of screen.fields) {
    if (represented.has(field.id)) continue;
    layoutContent.push({ kind: "field", fieldId: field.id });
    represented.add(field.id);
  }
  return { ...screen, layoutContent };
}

export type WhatsAppFlowLayoutIssueCode =
  | "flow_layout_content_invalid"
  | "flow_text_invalid"
  | "flow_text_max_length"
  | "flow_screen_success_invalid"
  | "flow_graph_bounds_exceeded";

export function validateWhatsAppFlowScreenLayout(
  screen: WhatsAppFlowScreenConfig,
  path: string,
): Array<{ code: WhatsAppFlowLayoutIssueCode; path: string }> {
  const issues: Array<{ code: WhatsAppFlowLayoutIssueCode; path: string }> = [];
  const issue = (code: WhatsAppFlowLayoutIssueCode, issuePath: string) =>
    issues.push({ code, path: issuePath });
  if (
    screen.success !== undefined &&
    (typeof screen.success !== "boolean" || screen.terminal !== true)
  )
    issue("flow_screen_success_invalid", `${path}.success`);
  if (screen.layoutContent === undefined) return issues;
  if (!Array.isArray(screen.layoutContent)) {
    issue("flow_layout_content_invalid", `${path}.layoutContent`);
    return issues;
  }
  if (screen.layoutContent.length + Number(Boolean(screen.footer)) > 50) {
    issue("flow_graph_bounds_exceeded", `${path}.layoutContent`);
    return issues;
  }
  const fields = new Set(screen.fields.map((field) => field.id));
  const represented = new Set<string>();
  const textIds = new Set<string>();
  screen.layoutContent.forEach((item, index) => {
    const itemPath = `${path}.layoutContent[${index}]`;
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      issue("flow_layout_content_invalid", itemPath);
      return;
    }
    if (item.kind === "field") {
      if (
        Object.keys(item).some((key) => !["kind", "fieldId"].includes(key)) ||
        !fields.has(item.fieldId) ||
        represented.has(item.fieldId)
      )
        issue("flow_layout_content_invalid", itemPath);
      represented.add(item.fieldId);
      return;
    }
    if (
      item.kind !== "text" ||
      Object.keys(item).some(
        (key) => !["kind", "id", "type", "text"].includes(key),
      )
    ) {
      issue("flow_layout_content_invalid", itemPath);
      return;
    }
    if (
      typeof item.id !== "string" ||
      !item.id.trim() ||
      item.id.length > 160 ||
      textIds.has(item.id)
    )
      issue("flow_layout_content_invalid", `${itemPath}.id`);
    textIds.add(item.id);
    if (
      !isWhatsAppFlowTextType(item.type) ||
      typeof item.text !== "string" ||
      !item.text.trim() ||
      item.text.includes("${")
    ) {
      issue("flow_text_invalid", `${itemPath}.text`);
      return;
    }
    const limit = WHATSAPP_FLOW_TEXT_MAX_LENGTH[item.type];
    if (item.text.length > limit * 2 || [...item.text].length > limit)
      issue("flow_text_max_length", `${itemPath}.text`);
  });
  if ([...fields].some((id) => !represented.has(id)))
    issue("flow_layout_content_invalid", `${path}.layoutContent`);
  return issues;
}
