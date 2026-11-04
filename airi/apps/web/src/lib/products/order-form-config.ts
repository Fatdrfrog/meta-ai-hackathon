import { generateFlowJsonString } from "@/components/scenarios/builders/whatsapp/flow-json-generator";
import {
  validateWhatsAppFlowConfig,
  type FlowValidationIssue,
  type FlowValidationIssueCode,
} from "@/components/scenarios/builders/whatsapp/flow-validation";
import {
  ORDER_FORM_MAX_PRODUCTS,
  orderFormOption,
} from "@/lib/products/kit-text";
import { shopWords } from "@/lib/products/shop-words";
import {
  sanitizeWhatsAppFlowConfig,
  toEditableWhatsAppFlowConfig,
} from "@/lib/scenarios/whatsapp-flow-config";
import type {
  WhatsAppFlowConfig,
  WhatsAppFlowScreenAction,
} from "@icecore/scenario-contracts";

// A kit's order form as a WhatsApp Flow config: the one the shelf makes, and
// the checks an owner's edit of it must pass before it is published. Client
// safe: "Edit questions" builds and checks it in the page, and the kit routes
// check it again on the server.

/** A product as the form lists it: its name and price. */
export type OrderFormProduct = {
  id: string;
  name: string;
  price: number | null;
  currency: string | null;
  priceIsFrom: boolean;
};

/** The products question's field id: buyers' ticks come back under it. */
export const ORDER_FORM_PRODUCTS_FIELD_ID = "products";
/** The most screens and questions an edited form may have. */
export const ORDER_FORM_MAX_SCREENS = 10;
export const ORDER_FORM_MAX_FIELDS = 50;
/** The biggest Flow JSON a form may make, in bytes. */
export const ORDER_FORM_MAX_JSON_BYTES = 64 * 1024;

/**
 * The order form, one screen: the products to tick (by product id), the
 * buyer's name, where to deliver, and a comment. WhatsApp already gives the
 * buyer's number.
 */
export function buildOrderFormFlowConfig(
  products: readonly OrderFormProduct[],
  language: string | null
): WhatsAppFlowConfig {
  const words = shopWords(language);
  return {
    templateId: "products_order_form",
    ctaText: words.form.cta,
    flowSubmitLabel: words.form.submit,
    flowNavigationMode: "linear",
    flowJsonVersion: "6.3",
    categories: ["OTHER"],
    screens: [
      {
        id: "ORDER",
        title: words.form.title,
        fields: [
          {
            id: ORDER_FORM_PRODUCTS_FIELD_ID,
            label: words.form.products,
            fieldType: "CheckboxGroup",
            required: true,
            options: products.slice(0, ORDER_FORM_MAX_PRODUCTS).map(product => {
              const { title, description } = orderFormOption(product, words);
              return {
                id: product.id,
                title,
                ...(description ? { description } : {}),
              };
            }),
          },
          {
            id: "name",
            label: words.form.name,
            fieldType: "TextInput",
            required: true,
          },
          {
            id: "address",
            label: words.form.address,
            fieldType: "TextArea",
            required: false,
          },
          {
            id: "comment",
            label: words.form.comment,
            fieldType: "TextArea",
            required: false,
          },
        ],
      },
    ],
  };
}

/** The Flow editor's checks, in words an owner can act on. */
const VALIDATION_WORDS: Partial<Record<FlowValidationIssueCode, string>> = {
  screens_required: "The form needs at least one screen.",
  screens_max_exceeded: "The form has too many screens.",
  screen_id_required: "A screen has no id.",
  screen_id_max_length: "A screen id is longer than 50 characters.",
  screen_id_reserved: "SUCCESS can't be a screen id.",
  screen_title_max_length: "A screen title is longer than 80 characters.",
  screen_max_components_exceeded: "A screen has more than 50 parts.",
  component_label_required: "A question has no text.",
  component_label_max_length: "A question's text is too long for WhatsApp.",
  component_data_source_required: "A question needs at least one option.",
  data_source_option_id_required: "An option has no id.",
  data_source_option_title_required: "An option has no text.",
  data_source_option_title_max_length:
    "An option's text is longer than 30 characters.",
  data_source_max_options_exceeded: "A question has too many options.",
  flow_option_description_max_length:
    "An option's description is longer than 300 characters.",
  footer_label_max_length: "A button's text is longer than 35 characters.",
  flow_field_id_duplicate_across_screens:
    "Two questions share an id: each needs its own.",
  flow_field_id_duplicate_within_screen:
    "Two questions on one screen share an id: each needs its own.",
  flow_graph_screen_unreachable: "A screen can't be reached from the first.",
  flow_graph_cycle: "The screens go round in a loop.",
  flow_graph_terminal_required:
    "Every path must end on a screen that sends the form.",
  flow_text_max_length: "A text is too long for its style.",
  flow_text_invalid: "A text block is empty.",
};

const SCREEN_AT = /^screens\[(\d+)\]/;

/** One of the Flow checks' issues as a line the owner reads. */
function validationWords(issue: FlowValidationIssue): string {
  const words =
    VALIDATION_WORDS[issue.code] ??
    `WhatsApp wouldn't take this form as it is (${issue.code}).`;
  const screen = SCREEN_AT.exec(issue.path);
  return screen ? `Screen ${Number(screen[1]) + 1}: ${words}` : words;
}

const isDataExchange = (action: WhatsAppFlowScreenAction | undefined) =>
  action?.name === "data_exchange";

/** Whether the form reaches out to a data endpoint anywhere: forms in kits never do. */
function usesEndpoint(
  raw: Partial<WhatsAppFlowConfig>,
  config: WhatsAppFlowConfig
): boolean {
  const hasEntries = (value: unknown) =>
    Boolean(value) &&
    typeof value === "object" &&
    Object.keys(value as object).length > 0;
  return (
    config.flowNavigationMode === "data_endpoint" ||
    (typeof raw.endpointUri === "string" && raw.endpointUri.trim() !== "") ||
    (typeof raw.applicationId === "string" &&
      raw.applicationId.trim() !== "") ||
    hasEntries(config.screenRoutes) ||
    hasEntries(config.flowBranchRules) ||
    config.screens.some(
      screen =>
        isDataExchange(screen.footer?.action) ||
        screen.fields.some(field =>
          (field.navigationItems ?? []).some(item =>
            isDataExchange(item.action)
          )
        )
    )
  );
}

/** The products question's own checks: it stays the shelf's. */
function productsIssues(
  config: WhatsAppFlowConfig,
  productIds: readonly string[]
): string[] {
  const where = config.screens.findIndex(screen =>
    screen.fields.some(field => field.id === ORDER_FORM_PRODUCTS_FIELD_ID)
  );
  if (where === -1)
    return ["The products question is missing: it lists your shelf products."];
  if (where !== 0)
    return ["The products question has to be on the first screen."];
  const field = config.screens[0]!.fields.find(
    entry => entry.id === ORDER_FORM_PRODUCTS_FIELD_ID
  )!;
  if (field.fieldType !== "CheckboxGroup")
    return ["The products question has to stay a list of tick boxes."];
  const ids = (field.options ?? []).map(option => option.id);
  if (ids.length < 1 || ids.length > ORDER_FORM_MAX_PRODUCTS)
    return [
      `The products question lists 1 to ${ORDER_FORM_MAX_PRODUCTS} products.`,
    ];
  const known = new Set(productIds.map(id => id.toLowerCase()));
  if (ids.some(id => !known.has(id.toLowerCase())))
    return [
      "An option in the products question isn't one of this kit's products.",
    ];
  if (new Set(ids.map(id => id.toLowerCase())).size !== ids.length)
    return ["A product is listed twice in the products question."];
  return [];
}

const jsonBytes = (text: string) => new TextEncoder().encode(text).length;

function readOrderFormConfig(
  value: unknown,
  productIds: readonly string[]
): { ok: true; config: WhatsAppFlowConfig } | { ok: false; issues: string[] } {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return { ok: false, issues: ["This isn't an order form."] };
  const sanitized = sanitizeWhatsAppFlowConfig(value);
  if (!sanitized) return { ok: false, issues: ["This isn't an order form."] };
  // As JSON: what is stored and sent, without the empty optional fields.
  const config = JSON.parse(
    JSON.stringify(toEditableWhatsAppFlowConfig(sanitized))
  ) as WhatsAppFlowConfig;
  const raw = value as Partial<WhatsAppFlowConfig>;
  if (usesEndpoint(raw, config))
    return {
      ok: false,
      issues: [
        "An order form can't use a data endpoint: it stays on WhatsApp.",
      ],
    };
  if (config.screens.length > ORDER_FORM_MAX_SCREENS)
    return {
      ok: false,
      issues: [`An order form has at most ${ORDER_FORM_MAX_SCREENS} screens.`],
    };
  const fields = config.screens.reduce(
    (count, screen) => count + screen.fields.length,
    0
  );
  if (fields > ORDER_FORM_MAX_FIELDS)
    return {
      ok: false,
      issues: [`An order form has at most ${ORDER_FORM_MAX_FIELDS} questions.`],
    };
  const products = productsIssues(config, productIds);
  if (products.length > 0) return { ok: false, issues: products };
  const { issues } = validateWhatsAppFlowConfig(config);
  if (issues.length > 0)
    return { ok: false, issues: [...new Set(issues.map(validationWords))] };
  if (jsonBytes(generateFlowJsonString(config)) > ORDER_FORM_MAX_JSON_BYTES)
    return {
      ok: false,
      issues: ["The order form is too big for WhatsApp: shorten it."],
    };
  return { ok: true, config };
}

/**
 * An edited order form, sanitized as the Flow editor saves it and without
 * any link to a Meta Flow (the kit keeps its own), or what's wrong with it:
 * the Flow editor's own checks, a form that stays on WhatsApp (no data
 * endpoint), the shelf's products question on the first screen listing only
 * `productIds`, each once, and a size WhatsApp takes.
 */
export function parseOrderFormConfig(
  value: unknown,
  productIds: readonly string[]
): { ok: true; config: WhatsAppFlowConfig } | { ok: false; issues: string[] } {
  try {
    return readOrderFormConfig(value, productIds);
  } catch {
    // A shape the Flow tools can't read at all.
    return { ok: false, issues: ["This isn't an order form."] };
  }
}

/** What's wrong with an edited order form; empty when it can be published. */
export function checkOrderFormConfig(
  config: WhatsAppFlowConfig,
  productIds: readonly string[]
): string[] {
  const parsed = parseOrderFormConfig(config, productIds);
  return parsed.ok ? [] : parsed.issues;
}
