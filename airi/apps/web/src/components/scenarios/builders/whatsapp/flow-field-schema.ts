import type {
  WhatsAppFlowConfig,
  WhatsAppFlowFieldType,
} from "@/components/scenarios/types";
import { z } from "zod";
import {
  validateWhatsAppFlowStaticGraph,
  type WhatsAppFlowStaticGraphIssueCode,
} from "@icecore/scenario-contracts";

/**
 * Limits derived from the official WhatsApp Flows reference:
 * https://developers.facebook.com/docs/whatsapp/flows/reference/flowjson
 */

const OPTION_FIELD_TYPES = new Set<WhatsAppFlowFieldType>([
  "Dropdown",
  "RadioButtonsGroup",
  "CheckboxGroup",
]);

/** Per-component label character limits from the spec */
const LABEL_MAX_LENGTH: Record<string, number> = {
  TextInput: 20,
  TextArea: 20,
  Dropdown: 20,
  DatePicker: 40,
  RadioButtonsGroup: 30,
  CheckboxGroup: 30,
};

/** Per-component max number of options from the spec */
const MAX_OPTIONS: Record<string, number> = {
  Dropdown: 200,
  RadioButtonsGroup: 20,
  CheckboxGroup: 20,
};

const OPTION_TITLE_MAX = 30;
const SCREEN_ID_MAX = 50;
const SCREEN_TITLE_MAX = 80;
const MAX_SCREENS = 20;
const MAX_COMPONENTS_PER_SCREEN = 50;
const FOOTER_LABEL_MAX = 35;

const flowOptionSchema = z.object({
  id: z.string().min(1, "Option ID is required"),
  title: z
    .string()
    .min(1, "Option title is required")
    .max(
      OPTION_TITLE_MAX,
      `Option title must be at most ${OPTION_TITLE_MAX} characters`
    ),
});

const flowFieldSchema = z
  .object({
    label: z.string(),
    fieldType: z.string(),
    options: z.array(flowOptionSchema).optional(),
  })
  .superRefine((field, ctx) => {
    const ft = field.fieldType as WhatsAppFlowFieldType;
    if (ft !== "NavigationList" && !field.label.trim())
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Label is required",
        path: ["label"],
      });
    const maxLabel = LABEL_MAX_LENGTH[ft];
    if (maxLabel && field.label.length > maxLabel) {
      ctx.addIssue({
        code: z.ZodIssueCode.too_big,
        maximum: maxLabel,
        type: "string",
        inclusive: true,
        message: `Label must be at most ${maxLabel} characters`,
        path: ["label"],
      });
    }

    if (OPTION_FIELD_TYPES.has(ft)) {
      if (!field.options || field.options.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "At least one option is required",
          path: ["options"],
        });
      }
      const maxOpts = MAX_OPTIONS[ft];
      if (maxOpts && field.options && field.options.length > maxOpts) {
        ctx.addIssue({
          code: z.ZodIssueCode.too_big,
          maximum: maxOpts,
          type: "array",
          inclusive: true,
          message: `At most ${maxOpts} options allowed`,
          path: ["options"],
        });
      }
    }
  });

const flowScreenSchema = z.object({
  id: z
    .string()
    .min(1, "Screen ID is required")
    .max(SCREEN_ID_MAX, `Screen ID must be at most ${SCREEN_ID_MAX} characters`)
    .refine(v => v !== "SUCCESS", {
      message: "SUCCESS is a reserved screen ID",
    }),
  title: z
    .string()
    .max(
      SCREEN_TITLE_MAX,
      `Screen title must be at most ${SCREEN_TITLE_MAX} characters`
    ),
  fields: z
    .array(flowFieldSchema)
    .min(1, "At least one field is required")
    .max(
      MAX_COMPONENTS_PER_SCREEN,
      `At most ${MAX_COMPONENTS_PER_SCREEN} fields per screen`
    ),
});

const flowConfigSchema = z.object({
  screens: z
    .array(flowScreenSchema)
    .min(1, "At least one screen is required")
    .max(MAX_SCREENS, `At most ${MAX_SCREENS} screens allowed`),
  ctaText: z
    .string()
    .max(
      FOOTER_LABEL_MAX,
      `CTA text must be at most ${FOOTER_LABEL_MAX} characters`
    ),
});

export type FlowFieldErrors = Record<string, string | undefined>;

const GRAPH_MESSAGES: Record<WhatsAppFlowStaticGraphIssueCode, string> = {
  flow_layout_content_invalid:
    "Keep every field in the layout once and use unique text block IDs",
  flow_text_invalid: "Use non-blank literal text without dynamic expressions",
  flow_text_max_length: "Text exceeds the limit for this component",
  flow_screen_success_invalid:
    "Set a success outcome only on a terminal screen",
  flow_graph_screen_duplicate: "Screen IDs must be unique",
  flow_field_id_duplicate_within_screen:
    "Field IDs must be unique within this screen",
  flow_graph_action_invalid: "Choose an action compatible with this screen",
  flow_graph_target_invalid: "Choose another existing screen",
  flow_graph_screen_unreachable: "Connect this screen to the start screen",
  flow_graph_cycle: "Screen navigation cannot contain a cycle",
  flow_graph_terminal_required:
    "Use a completion action on a terminal screen or navigate to another screen",
  flow_graph_payload_invalid:
    "Use declared form/data references and match the destination data schema",
  flow_graph_data_invalid:
    "Use a supported data schema with an example of the declared type",
  flow_navigation_items_invalid: "Use 1–20 navigation items with unique IDs",
  flow_navigation_composition_invalid:
    "Use at most two NavigationLists alone on a non-terminal screen, without a Footer",
  flow_navigation_item_text_invalid:
    "Use a title of up to 30 characters and a description of up to 20 characters",
  flow_option_description_max_length:
    "Option descriptions must be at most 300 characters",
  flow_graph_bounds_exceeded: "Use at most 20 screens and 50 fields per screen",
};

export function computeFieldErrors(
  config: WhatsAppFlowConfig
): FlowFieldErrors {
  const result = flowConfigSchema.safeParse(config);
  const errors: FlowFieldErrors = {};
  for (const issue of result.success ? [] : result.error.issues) {
    const key = issue.path.join(".");
    if (!errors[key]) {
      errors[key] = issue.message;
    }
  }
  for (const issue of validateWhatsAppFlowStaticGraph(config)) {
    const key = issue.path.replace(/\[(\d+)\]/g, ".$1");
    if (!errors[key]) errors[key] = GRAPH_MESSAGES[issue.code];
  }
  return errors;
}
