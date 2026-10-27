import {
  FLOW_FIELD_LABEL_MAX,
  FLOW_FIELD_MAX_OPTIONS,
  FLOW_OPTION_TITLE_MAX,
} from "@/components/scenarios/builders/whatsapp/flow-validation";
import type {
  WhatsAppFlowConfig,
  WhatsAppFlowFieldType,
} from "@icecore/scenario-contracts";

type WhatsAppFlowField =
  WhatsAppFlowConfig["screens"][number]["fields"][number];

/**
 * Repairs the mistakes a model makes in a generated WhatsApp Flow that the
 * Airi artifact validator (airiBuilderFlowConfigSchema plus
 * validateWhatsAppFlowConfig) would otherwise reject, so a finished draft can
 * be saved: over-long text is shortened, a field id reused on another screen
 * gets a suffix, and choice fields without options or fields of a type the
 * Airi builder does not support are dropped. Run it on a sanitized config.
 * Anything it cannot safely repair is left for the validator to report.
 */

/** Field types the Airi builder schema accepts. */
const AIRI_FLOW_FIELD_TYPES = new Set<WhatsAppFlowFieldType>([
  "TextInput",
  "TextArea",
  "Dropdown",
  "DatePicker",
  "RadioButtonsGroup",
  "CheckboxGroup",
]);
const CHOICE_FIELD_TYPES = new Set<WhatsAppFlowFieldType>([
  "Dropdown",
  "RadioButtonsGroup",
  "CheckboxGroup",
]);

// Limits of airiBuilderFlowConfigSchema (lib/airi-chats/builder-state.ts).
const ID_MAX = 80;
const SCREEN_TITLE_MAX = 80;
const FIELD_LABEL_SCHEMA_MAX = 80;
const HELPER_TEXT_MAX = 120;
const CTA_TEXT_MAX = 35;
const HEADER_TEXT_MAX = 60;
const FOOTER_TEXT_MAX = 60;
const BODY_TEXT_MAX = 1024;
const TEMPLATE_ID_MAX = 80;

/** Shortens to `max` characters, at a word boundary when one is near. */
function clampText(value: string, max: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= max) return trimmed;
  const cut = trimmed.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  const midWord = trimmed[max] !== " ";
  return (
    midWord && lastSpace > max / 2 ? cut.slice(0, lastSpace) : cut
  ).trimEnd();
}

function clampOptional(
  value: string | undefined,
  max: number
): string | undefined {
  if (typeof value !== "string") return value;
  return clampText(value, max) || undefined;
}

/** "preferred_date" -> "Preferred date", a label for a field that has none. */
function labelFromId(id: string): string {
  const words = id
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  return words ? words[0].toUpperCase() + words.slice(1) : "Answer";
}

function uniqueId(base: string, used: Set<string>): string {
  const root = clampText(base, ID_MAX) || "field";
  if (!used.has(root)) return root;
  for (let index = 2; ; index += 1) {
    const suffix = `_${index}`;
    const candidate = `${root.slice(0, ID_MAX - suffix.length)}${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
}

export function repairAiriGeneratedFlowConfig(
  config: WhatsAppFlowConfig
): WhatsAppFlowConfig {
  // Ids only need to be unique across screens outside static_graph mode,
  // the same rule the validator applies.
  const crossScreenIds = config.flowNavigationMode !== "static_graph";
  const usedAcrossScreens = new Set<string>();
  // screen id -> original field id -> repaired field id, for branch rules.
  const renamedFields = new Map<string, Map<string, string>>();

  const screens = config.screens.map((screen, screenIndex) => {
    const usedInScreen = crossScreenIds ? usedAcrossScreens : new Set<string>();
    const renamed = new Map<string, string>();
    const fields = screen.fields.flatMap(field => {
      if (!AIRI_FLOW_FIELD_TYPES.has(field.fieldType)) return [];
      // Only choice fields carry options; a choice field without a usable
      // option cannot be shown, so it is dropped.
      let options: WhatsAppFlowField["options"];
      if (CHOICE_FIELD_TYPES.has(field.fieldType)) {
        const usedOptionIds = new Set<string>();
        options = (field.options ?? [])
          .flatMap(option => {
            const title = clampText(option.title, FLOW_OPTION_TITLE_MAX);
            if (!title) return [];
            const id = uniqueId(option.id, usedOptionIds);
            usedOptionIds.add(id);
            return [{ ...option, id, title }];
          })
          .slice(0, FLOW_FIELD_MAX_OPTIONS[field.fieldType]);
        if (options.length === 0) return [];
      }
      const id = uniqueId(field.id, usedInScreen);
      usedInScreen.add(id);
      if (id !== field.id) renamed.set(field.id, id);
      const labelMax = Math.min(
        FLOW_FIELD_LABEL_MAX[field.fieldType] ?? FIELD_LABEL_SCHEMA_MAX,
        FIELD_LABEL_SCHEMA_MAX
      );
      return [
        {
          ...field,
          id,
          label: clampText(field.label || labelFromId(id), labelMax),
          helperText: clampOptional(field.helperText, HELPER_TEXT_MAX),
          options,
        },
      ];
    });
    if (renamed.size > 0) renamedFields.set(screen.id, renamed);
    return {
      ...screen,
      title: clampText(
        screen.title || `Step ${screenIndex + 1}`,
        SCREEN_TITLE_MAX
      ),
      fields,
    };
  });

  const flowBranchRules = config.flowBranchRules
    ? Object.fromEntries(
        Object.entries(config.flowBranchRules).map(([screenId, fields]) => {
          const renamed = renamedFields.get(screenId);
          return [
            screenId,
            renamed
              ? Object.fromEntries(
                  Object.entries(fields).map(([fieldId, rule]) => [
                    renamed.get(fieldId) ?? fieldId,
                    rule,
                  ])
                )
              : fields,
          ];
        })
      )
    : undefined;

  return {
    ...config,
    ...(typeof config.templateId === "string"
      ? { templateId: clampText(config.templateId, TEMPLATE_ID_MAX) }
      : {}),
    screens,
    ctaText: clampText(config.ctaText || "", CTA_TEXT_MAX) || "Open",
    headerText: clampOptional(config.headerText, HEADER_TEXT_MAX),
    bodyText: clampOptional(config.bodyText, BODY_TEXT_MAX),
    footerText: clampOptional(config.footerText, FOOTER_TEXT_MAX),
    ...(flowBranchRules ? { flowBranchRules } : {}),
  };
}
