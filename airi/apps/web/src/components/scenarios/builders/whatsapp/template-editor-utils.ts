import type {
  WhatsAppButtonType,
  WhatsAppComponent,
  WhatsAppFlowActionType,
} from "@icecore/shared/types/whatsapp";
import { pickWhatsAppTemplateFlowIdentifier } from "@icecore/shared/types/whatsapp-flows";
import { WHATSAPP_TEMPLATE_LIMITS } from "@icecore/shared/constants/whatsapp-templates";
import {
  normalizeWhatsAppTemplateButtonText,
  rekeyStoredWhatsAppTemplateButtonIds,
  resolveWhatsAppTemplateButtons,
  type ScenarioWhatsAppTemplateButtonIds,
} from "@icecore/scenario-contracts";
import { isValidWhatsAppTemplateUrl } from "@/lib/whatsapp/templates/component-schemas";
import {
  isTemplateHeaderMediaFormat,
  type TemplateHeaderMediaFormat,
} from "@/lib/whatsapp/templates/header-media-utils";
import type {
  ScenarioNodeData,
  TranslateFn,
} from "@/components/scenarios/types";
import { z } from "zod";

export type EditableWhatsAppTemplateButtonType =
  | "quick_reply"
  | "url"
  | "phone"
  | "flow"
  | "copy_code"
  | "request_contact_info";

export type EditableWhatsAppTemplateButton = {
  index: number;
  /**
   * The saved step's id for this button's route. Form-only: it is never sent
   * to Meta, and a new button has none until the template is saved.
   */
  routeId?: number;
  label: string;
  type: EditableWhatsAppTemplateButtonType;
  value?: string;
  flowId?: string;
  flowName?: string;
  flowJson?: string;
  flowAction?: WhatsAppFlowActionType;
  navigateScreen?: string;
  example?: string[];
};

/** What a form button does when it names no action: open its first screen. */
export const DEFAULT_FLOW_ACTION: WhatsAppFlowActionType = "navigate";
const TEMPLATE_COMPONENT_ORDER = [
  "HEADER",
  "BODY",
  "FOOTER",
  "BUTTONS",
  "CAROUSEL",
] as const satisfies ReadonlyArray<WhatsAppComponent["type"]>;

const TEMPLATE_TEXT_LIMITS = {
  header: WHATSAPP_TEMPLATE_LIMITS.HEADER_MAX_LENGTH,
  body: WHATSAPP_TEMPLATE_LIMITS.BODY_MAX_LENGTH,
  footer: WHATSAPP_TEMPLATE_LIMITS.FOOTER_MAX_LENGTH,
  button: WHATSAPP_TEMPLATE_LIMITS.BUTTON_TEXT_MAX_LENGTH,
  url: WHATSAPP_TEMPLATE_LIMITS.BUTTON_URL_MAX_LENGTH,
} as const;

/** WhatsApp caps per template; types without an entry share only the total. */
export const EDITABLE_WHATSAPP_TEMPLATE_BUTTON_LIMITS = {
  total: 3,
  flow: 1,
  phone: 1,
  url: 2,
} as const;
const TEMPLATE_BUTTON_LIMITS = EDITABLE_WHATSAPP_TEMPLATE_BUTTON_LIMITS;

/**
 * Validation messages are Scenarios catalog keys; the tray and the save toast
 * translate them.
 */
export const WHATSAPP_TEMPLATE_EDITOR_ERROR_KEYS = [
  "whatsappTemplateErrorButtonText",
  "whatsappTemplateErrorButtonTextTooLong",
  "whatsappTemplateErrorLinkInvalid",
  "whatsappTemplateErrorLinkRequired",
  "whatsappTemplateErrorPhoneRequired",
  "whatsappTemplateErrorFormRequired",
  "whatsappTemplateErrorFormStartScreen",
  "whatsappTemplateErrorMaxButtons",
  "whatsappTemplateErrorMaxForm",
  "whatsappTemplateErrorMaxPhone",
  "whatsappTemplateErrorMaxLinks",
  "whatsappTemplateErrorBodyRequired",
  "whatsappTemplateErrorHeaderTooLong",
  "whatsappTemplateErrorFooterTooLong",
  "whatsappTemplateErrorBodyTooLong",
] as const;

export type WhatsAppTemplateEditorErrorKey =
  (typeof WHATSAPP_TEMPLATE_EDITOR_ERROR_KEYS)[number];

const TEMPLATE_EDITOR_ERROR_KEY_SET = new Set<string>(
  WHATSAPP_TEMPLATE_EDITOR_ERROR_KEYS
);

export function isWhatsAppTemplateEditorErrorKey(
  message: string | null | undefined
): message is WhatsAppTemplateEditorErrorKey {
  return (
    typeof message === "string" && TEMPLATE_EDITOR_ERROR_KEY_SET.has(message)
  );
}

/** Translates a template editor validation message; other text passes through. */
export function translateWhatsAppTemplateEditorError(
  message: string | null | undefined,
  t: (key: WhatsAppTemplateEditorErrorKey) => string
): string | undefined {
  if (!message) return undefined;
  return isWhatsAppTemplateEditorErrorKey(message) ? t(message) : message;
}

type TemplateButtonFieldError = { message?: string } | undefined;

export type TemplateButtonFieldErrors = {
  label?: string;
  value?: string;
  flowId?: string;
  navigateScreen?: string;
  /** The one message the row shows. */
  message?: string;
};

/**
 * One tray row's validation messages. The form and first screen messages
 * wait for a save attempt.
 */
export function getTemplateButtonFieldErrors(
  errors:
    | Partial<
        Record<
          "label" | "value" | "flowId" | "navigateScreen",
          TemplateButtonFieldError
        >
      >
    | undefined,
  showFormErrors: boolean
): TemplateButtonFieldErrors {
  const label = errors?.label?.message;
  const value = errors?.value?.message;
  const flowId = showFormErrors ? errors?.flowId?.message : undefined;
  const navigateScreen = showFormErrors
    ? errors?.navigateScreen?.message
    : undefined;
  return {
    label,
    value,
    flowId,
    navigateScreen,
    message: label || value || flowId || navigateScreen,
  };
}

const ENGLISH_TEMPLATE_EDITOR_ERRORS: Record<
  WhatsAppTemplateEditorErrorKey,
  string
> = {
  whatsappTemplateErrorButtonText: "Add button text",
  whatsappTemplateErrorButtonTextTooLong: "Button text: up to 25 characters",
  whatsappTemplateErrorLinkInvalid: "Enter a valid link",
  whatsappTemplateErrorLinkRequired: "Add a link",
  whatsappTemplateErrorPhoneRequired: "Add a phone number",
  whatsappTemplateErrorFormRequired: "Choose a form",
  whatsappTemplateErrorFormStartScreen: "Set the form's first screen",
  whatsappTemplateErrorMaxButtons: "Up to 3 buttons",
  whatsappTemplateErrorMaxForm: "Only 1 form button",
  whatsappTemplateErrorMaxPhone: "Only 1 call button",
  whatsappTemplateErrorMaxLinks: "Only 2 link buttons",
  whatsappTemplateErrorBodyRequired: "Add message text",
  whatsappTemplateErrorHeaderTooLong: "Header: up to 60 characters",
  whatsappTemplateErrorFooterTooLong: "Footer: up to 60 characters",
  whatsappTemplateErrorBodyTooLong: "Message: up to 1024 characters",
};

/**
 * English text for a validation key, for template editors outside the
 * localized scenario builder.
 */
export function getEnglishWhatsAppTemplateEditorError(message: string): string {
  return isWhatsAppTemplateEditorErrorKey(message)
    ? ENGLISH_TEMPLATE_EDITOR_ERRORS[message]
    : message;
}

/** The name a template button shows in the tray and in delete labels. */
export function getTemplateButtonDisplayLabel(
  button: Pick<EditableWhatsAppTemplateButton, "label" | "type">,
  t: TranslateFn
): string {
  const label = (button.label || "").trim();
  if (label) return label;
  if (button.type === "request_contact_info") return t("buttonContactInfo");
  if (button.type === "copy_code") return t("whatsappTemplateCopyCode");
  return t("untitledButton");
}

/**
 * Reply-button texts used more than once, ignoring case and spacing, as each
 * group's first label. Routes can't follow such buttons by text.
 */
export function listDuplicateEditableQuickReplyLabels(
  buttons: readonly Pick<EditableWhatsAppTemplateButton, "label" | "type">[]
): string[] {
  const groups = new Map<string, string[]>();
  for (const button of buttons) {
    const label = normalizeTemplateText(button.label);
    if (button.type !== "quick_reply" || !label) continue;
    const key = normalizeWhatsAppTemplateButtonText(label);
    groups.set(key, [...(groups.get(key) ?? []), label]);
  }
  return Array.from(groups.values()).flatMap(labels =>
    labels.length > 1 ? [labels[0]] : []
  );
}

type ButtonsComponent = Extract<WhatsAppComponent, { type: "BUTTONS" }>;
type TemplateButton = ButtonsComponent["buttons"][number];
type TemplateComponentType = WhatsAppComponent["type"];

function normalizeTemplateText(value: string | null | undefined): string {
  return (value ?? "").trim();
}

function hasText(value: string | null | undefined): boolean {
  return normalizeTemplateText(value).length > 0;
}

function templateEditorError(key: WhatsAppTemplateEditorErrorKey): string {
  return key;
}

export const editableWhatsAppTemplateButtonSchema = z
  .object({
    index: z.number().int().nonnegative(),
    routeId: z.number().int().nonnegative().optional(),
    label: z
      .string()
      .trim()
      .max(
        TEMPLATE_TEXT_LIMITS.button,
        templateEditorError("whatsappTemplateErrorButtonTextTooLong")
      ),
    type: z.enum([
      "quick_reply",
      "url",
      "phone",
      "flow",
      "copy_code",
      "request_contact_info",
    ]),
    value: z
      .string()
      .trim()
      .max(
        TEMPLATE_TEXT_LIMITS.url,
        templateEditorError("whatsappTemplateErrorLinkInvalid")
      )
      .optional(),
    flowId: z.string().trim().optional(),
    flowName: z.string().trim().optional(),
    flowJson: z.string().trim().optional(),
    flowAction: z.enum(["navigate", "data_exchange"]).optional(),
    navigateScreen: z.string().trim().optional(),
    example: z.array(z.string()).optional(),
  })
  .superRefine((button, ctx) => {
    if (button.type === "request_contact_info") {
      return;
    }

    if (!hasText(button.label)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["label"],
        message: templateEditorError("whatsappTemplateErrorButtonText"),
      });
      return;
    }

    if (
      button.type === "url" &&
      !isValidWhatsAppTemplateUrl(button.value ?? "")
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["value"],
        message: templateEditorError(
          hasText(button.value)
            ? "whatsappTemplateErrorLinkInvalid"
            : "whatsappTemplateErrorLinkRequired"
        ),
      });
      return;
    }

    if (button.type === "phone" && !hasText(button.value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["value"],
        message: templateEditorError("whatsappTemplateErrorPhoneRequired"),
      });
      return;
    }

    if (
      button.type === "flow" &&
      !pickWhatsAppTemplateFlowIdentifier({
        flow_id: button.flowId,
        flow_name: button.flowName,
        flow_json: button.flowJson,
      })
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["flowId"],
        message: templateEditorError("whatsappTemplateErrorFormRequired"),
      });
      return;
    }

    if (
      button.type === "flow" &&
      (button.flowAction || DEFAULT_FLOW_ACTION) === "navigate" &&
      !hasText(button.navigateScreen)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["navigateScreen"],
        message: templateEditorError("whatsappTemplateErrorFormStartScreen"),
      });
    }
  });

export const editableWhatsAppTemplateButtonsSchema = z
  .array(editableWhatsAppTemplateButtonSchema)
  .max(
    TEMPLATE_BUTTON_LIMITS.total,
    templateEditorError("whatsappTemplateErrorMaxButtons")
  )
  .superRefine((buttons, ctx) => {
    const flowButtonCount = buttons.filter(
      button => button.type === "flow"
    ).length;
    const phoneButtonCount = buttons.filter(
      button => button.type === "phone"
    ).length;
    const urlButtonCount = buttons.filter(
      button => button.type === "url"
    ).length;

    if (flowButtonCount > TEMPLATE_BUTTON_LIMITS.flow) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [],
        message: templateEditorError("whatsappTemplateErrorMaxForm"),
      });
    }

    if (phoneButtonCount > TEMPLATE_BUTTON_LIMITS.phone) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [],
        message: templateEditorError("whatsappTemplateErrorMaxPhone"),
      });
    }

    if (urlButtonCount > TEMPLATE_BUTTON_LIMITS.url) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [],
        message: templateEditorError("whatsappTemplateErrorMaxLinks"),
      });
    }
  });

export const editableWhatsAppTemplateEditorFormSchema = z.object({
  headerText: z
    .string()
    .trim()
    .max(
      TEMPLATE_TEXT_LIMITS.header,
      templateEditorError("whatsappTemplateErrorHeaderTooLong")
    ),
  bodyText: z
    .string()
    .trim()
    .min(1, templateEditorError("whatsappTemplateErrorBodyRequired"))
    .max(
      TEMPLATE_TEXT_LIMITS.body,
      templateEditorError("whatsappTemplateErrorBodyTooLong")
    ),
  footerText: z
    .string()
    .trim()
    .max(
      TEMPLATE_TEXT_LIMITS.footer,
      templateEditorError("whatsappTemplateErrorFooterTooLong")
    ),
  buttons: editableWhatsAppTemplateButtonsSchema,
});

export type EditableWhatsAppTemplateEditorFormValues = z.output<
  typeof editableWhatsAppTemplateEditorFormSchema
>;

function cloneWhatsAppTemplateComponents(
  components: WhatsAppComponent[] | null | undefined
): WhatsAppComponent[] {
  if (!Array.isArray(components)) return [];
  return components.map(component => {
    if (component.type === "BUTTONS") {
      return {
        ...component,
        buttons: (component.buttons || []).map(button => ({
          ...button,
          ...("example" in button && Array.isArray(button.example)
            ? { example: [...button.example] }
            : {}),
        })),
      };
    }
    return { ...component };
  });
}

function isComponentType<T extends TemplateComponentType>(
  component: WhatsAppComponent,
  type: T
): component is Extract<WhatsAppComponent, { type: T }> {
  return component.type === type;
}

function findComponent<T extends TemplateComponentType>(
  components: WhatsAppComponent[],
  type: T
): Extract<WhatsAppComponent, { type: T }> | undefined {
  return components.find(component => isComponentType(component, type));
}

function compactTemplateComponents(
  components: WhatsAppComponent[]
): WhatsAppComponent[] {
  const compacted: WhatsAppComponent[] = [];
  for (const type of TEMPLATE_COMPONENT_ORDER) {
    const component = findComponent(components, type);
    if (component) {
      compacted.push(component);
    }
  }
  return compacted;
}

function replaceComponent(
  components: WhatsAppComponent[],
  component: WhatsAppComponent
): WhatsAppComponent[] {
  return compactTemplateComponents([
    ...components.filter(existing => existing.type !== component.type),
    component,
  ]);
}

function removeComponent(
  components: WhatsAppComponent[],
  type: TemplateComponentType
): WhatsAppComponent[] {
  return compactTemplateComponents(
    components.filter(component => component.type !== type)
  );
}

function createTemplateButton(
  type: EditableWhatsAppTemplateButtonType,
  label = ""
): TemplateButton {
  const text = normalizeTemplateText(label);
  switch (type) {
    case "url":
      return {
        type: "URL",
        text,
        url: "",
      };
    case "phone":
      return {
        type: "PHONE_NUMBER",
        text,
        phone_number: "",
      };
    case "flow":
      return {
        type: "FLOW",
        text,
        flow_id: "",
        flow_action: DEFAULT_FLOW_ACTION,
      };
    case "copy_code":
      return {
        type: "OTP",
        otp_type: "COPY_CODE",
        text: text || "Copy code",
      };
    case "request_contact_info":
      return {
        type: "REQUEST_CONTACT_INFO",
      };
    case "quick_reply":
    default:
      return {
        type: "QUICK_REPLY",
        text,
      };
  }
}

function mapButtonTypeToEditable(
  type: WhatsAppButtonType
): EditableWhatsAppTemplateButtonType {
  switch (type) {
    case "URL":
      return "url";
    case "PHONE_NUMBER":
      return "phone";
    case "FLOW":
      return "flow";
    case "OTP":
      return "copy_code";
    case "REQUEST_CONTACT_INFO":
      return "request_contact_info";
    case "QUICK_REPLY":
    default:
      return "quick_reply";
  }
}

export function ensureWhatsAppTemplateBodyComponent(
  components: WhatsAppComponent[] | null | undefined
): WhatsAppComponent[] {
  const next = cloneWhatsAppTemplateComponents(components);
  if (findComponent(next, "BODY")) {
    return compactTemplateComponents(next);
  }
  return replaceComponent(next, { type: "BODY", text: "" });
}

export function getWhatsAppTemplateHeaderText(
  components: WhatsAppComponent[] | null | undefined
): string {
  const header = findComponent(
    cloneWhatsAppTemplateComponents(components),
    "HEADER"
  );
  if (!header || header.type !== "HEADER" || header.format !== "TEXT") {
    return "";
  }
  return header.text || "";
}

export function getWhatsAppTemplateHeaderMediaFormat(
  components: WhatsAppComponent[] | null | undefined
): TemplateHeaderMediaFormat | undefined {
  const header = findComponent(
    cloneWhatsAppTemplateComponents(components),
    "HEADER"
  );
  if (
    !header ||
    header.type !== "HEADER" ||
    !isTemplateHeaderMediaFormat(header.format)
  ) {
    return undefined;
  }
  return header.format;
}

export function getWhatsAppTemplateBodyText(
  components: WhatsAppComponent[] | null | undefined
): string {
  const body = findComponent(
    cloneWhatsAppTemplateComponents(components),
    "BODY"
  );
  if (!body || body.type !== "BODY") {
    return "";
  }
  return body.text || "";
}

export function getWhatsAppTemplateEditorBodyText({
  replyText,
  components,
}: {
  replyText?: string | null;
  components: WhatsAppComponent[] | null | undefined;
}): string {
  const savedReplyText = replyText || "";
  if (savedReplyText.trim().length > 0) {
    return savedReplyText;
  }
  return getWhatsAppTemplateBodyText(components);
}

export function getWhatsAppTemplateFooterText(
  components: WhatsAppComponent[] | null | undefined
): string {
  const footer = findComponent(
    cloneWhatsAppTemplateComponents(components),
    "FOOTER"
  );
  if (!footer || footer.type !== "FOOTER") {
    return "";
  }
  return footer.text || "";
}

export function getEditableWhatsAppTemplateButtons(
  components: WhatsAppComponent[] | null | undefined
): EditableWhatsAppTemplateButton[] {
  const buttonComponent = findComponent(
    cloneWhatsAppTemplateComponents(components),
    "BUTTONS"
  );
  if (!buttonComponent || buttonComponent.type !== "BUTTONS") {
    return [];
  }

  return (buttonComponent.buttons || []).map((button, index) => {
    if (button.type === "URL") {
      return {
        index,
        label: button.text || "",
        type: "url",
        value: button.url || "",
        example: Array.isArray(button.example)
          ? [...button.example]
          : undefined,
      };
    }
    if (button.type === "PHONE_NUMBER") {
      return {
        index,
        label: button.text || "",
        type: "phone",
        value: button.phone_number || "",
      };
    }
    if (button.type === "FLOW") {
      const identifier = pickWhatsAppTemplateFlowIdentifier(button);
      return {
        index,
        label: button.text || "",
        type: "flow",
        ...(identifier?.kind === "flow_id"
          ? { flowId: identifier.flow_id }
          : {}),
        ...(identifier?.kind === "flow_name"
          ? { flowName: identifier.flow_name }
          : {}),
        ...(identifier?.kind === "flow_json"
          ? { flowJson: identifier.flow_json }
          : {}),
        flowAction: button.flow_action ?? DEFAULT_FLOW_ACTION,
        navigateScreen: button.navigate_screen || undefined,
      };
    }
    if (button.type === "OTP") {
      return {
        index,
        label: button.text || "Copy code",
        type: "copy_code",
      };
    }
    if (button.type === "REQUEST_CONTACT_INFO") {
      return {
        index,
        label: button.text || "",
        type: "request_contact_info",
      };
    }
    return {
      index,
      label: button.text || "",
      type: "quick_reply",
      example: Array.isArray(button.example) ? [...button.example] : undefined,
    };
  });
}

/**
 * Gives each saved quick reply of the message the id of its route. Carousel
 * cards keep their buttons' routes; the editor has no rows for them.
 */
function withTemplateButtonRouteIds(
  buttons: EditableWhatsAppTemplateButton[],
  components: WhatsAppComponent[] | null | undefined,
  buttonIds: unknown
): EditableWhatsAppTemplateButton[] {
  const routeIdsByIndex = new Map(
    resolveWhatsAppTemplateButtons(components, buttonIds).flatMap(button =>
      button.cardIndex === undefined ? [[button.index, button.id] as const] : []
    )
  );
  return buttons.map(button => {
    const routeId = routeIdsByIndex.get(button.index);
    return typeof routeId === "number" ? { ...button, routeId } : button;
  });
}

export function getEditableWhatsAppTemplateEditorFormValues({
  replyText,
  components,
  buttonIds,
}: {
  replyText?: string | null;
  components: WhatsAppComponent[] | null | undefined;
  /** The step's stored button ids; without them ids are positions. */
  buttonIds?: unknown;
}): EditableWhatsAppTemplateEditorFormValues {
  return {
    headerText: getWhatsAppTemplateHeaderText(components),
    bodyText: getWhatsAppTemplateEditorBodyText({ replyText, components }),
    footerText: getWhatsAppTemplateFooterText(components),
    buttons: withTemplateButtonRouteIds(
      getEditableWhatsAppTemplateButtons(components),
      components,
      buttonIds
    ),
  };
}

export function updateWhatsAppTemplateHeaderText(
  components: WhatsAppComponent[] | null | undefined,
  text: string
): WhatsAppComponent[] {
  const next = cloneWhatsAppTemplateComponents(components);
  const existing = findComponent(next, "HEADER");
  if (existing && existing.format !== "TEXT") {
    return compactTemplateComponents(next);
  }

  const normalizedText = normalizeTemplateText(text);
  if (!normalizedText) {
    return removeComponent(next, "HEADER");
  }

  return replaceComponent(next, {
    ...(existing ?? {}),
    type: "HEADER",
    format: "TEXT",
    text: normalizedText,
  });
}

export function updateWhatsAppTemplateBodyText(
  components: WhatsAppComponent[] | null | undefined,
  text: string
): WhatsAppComponent[] {
  const next = ensureWhatsAppTemplateBodyComponent(components);
  const existing = findComponent(next, "BODY");
  return replaceComponent(next, {
    ...(existing ?? {}),
    type: "BODY",
    text: normalizeTemplateText(text),
  });
}

export function updateWhatsAppTemplateFooterText(
  components: WhatsAppComponent[] | null | undefined,
  text: string
): WhatsAppComponent[] {
  const next = cloneWhatsAppTemplateComponents(components);
  const normalizedText = normalizeTemplateText(text);
  if (!normalizedText) {
    return removeComponent(next, "FOOTER");
  }

  return replaceComponent(next, {
    ...(findComponent(next, "FOOTER") ?? {}),
    type: "FOOTER",
    text: normalizedText,
  });
}

function normalizeButtonExample(
  example: string[] | undefined
): string[] | undefined {
  if (!Array.isArray(example)) return undefined;
  const values = example.map(value => String(value)).filter(Boolean);
  return values.length > 0 ? values : undefined;
}

function getButtonExample(button: TemplateButton): string[] | undefined {
  return "example" in button
    ? normalizeButtonExample(button.example)
    : undefined;
}

function withButtonExample(
  button: TemplateButton,
  example: string[] | undefined
): TemplateButton {
  const normalizedExample = normalizeButtonExample(example);
  if (!normalizedExample) return button;
  if (button.type !== "QUICK_REPLY" && button.type !== "URL") return button;
  return { ...button, example: normalizedExample };
}

function normalizeEditableTemplateButton(
  button: EditableWhatsAppTemplateButton
): TemplateButton | null {
  if (button.type === "request_contact_info") {
    return { type: "REQUEST_CONTACT_INFO" };
  }

  const text = normalizeTemplateText(button.label);
  if (!text) return null;

  const templateButton = createTemplateButton(button.type, text);
  if (templateButton.type === "URL") {
    const url = normalizeTemplateText(button.value);
    if (!url) return null;
    return withButtonExample({ ...templateButton, url }, button.example);
  }

  if (templateButton.type === "PHONE_NUMBER") {
    const phoneNumber = normalizeTemplateText(button.value);
    if (!phoneNumber) return null;
    return { ...templateButton, phone_number: phoneNumber };
  }

  if (templateButton.type === "FLOW") {
    const identifier = pickWhatsAppTemplateFlowIdentifier({
      flow_id: button.flowId,
      flow_name: button.flowName,
      flow_json: button.flowJson,
    });
    if (!identifier) return null;
    const flowAction = button.flowAction || DEFAULT_FLOW_ACTION;
    const navigateScreen = normalizeTemplateText(button.navigateScreen);
    return {
      ...templateButton,
      ...(identifier.kind === "flow_id" ? { flow_id: identifier.flow_id } : {}),
      ...(identifier.kind === "flow_name"
        ? { flow_name: identifier.flow_name }
        : {}),
      ...(identifier.kind === "flow_json"
        ? { flow_json: identifier.flow_json }
        : {}),
      flow_action: flowAction,
      ...(flowAction === "navigate" && navigateScreen
        ? { navigate_screen: navigateScreen }
        : {}),
    };
  }

  if (templateButton.type === "OTP") {
    return {
      ...templateButton,
      text: text || "Copy code",
      otp_type: "COPY_CODE",
    };
  }

  return withButtonExample(templateButton, button.example);
}

function buildButtonsComponent(
  buttons: EditableWhatsAppTemplateButton[]
): ButtonsComponent | null {
  const templateButtons = buttons
    .map(normalizeEditableTemplateButton)
    .filter((button): button is TemplateButton => button !== null);

  if (templateButtons.length === 0) return null;
  return {
    type: "BUTTONS",
    buttons: templateButtons,
  };
}

export function addWhatsAppTemplateButton(
  components: WhatsAppComponent[] | null | undefined,
  type: EditableWhatsAppTemplateButtonType = "quick_reply"
): WhatsAppComponent[] {
  const next = cloneWhatsAppTemplateComponents(components);
  const existing = findComponent(next, "BUTTONS");
  return replaceComponent(next, {
    type: "BUTTONS",
    buttons: [...(existing?.buttons ?? []), createTemplateButton(type)],
  });
}

export function removeWhatsAppTemplateButton(
  components: WhatsAppComponent[] | null | undefined,
  buttonIndex: number
): WhatsAppComponent[] {
  const next = cloneWhatsAppTemplateComponents(components);
  const buttonsComponent = findComponent(next, "BUTTONS");
  if (!buttonsComponent) return compactTemplateComponents(next);

  const buttons = (buttonsComponent.buttons || []).filter(
    (_button, index) => index !== buttonIndex
  );
  if (buttons.length === 0) return removeComponent(next, "BUTTONS");
  return replaceComponent(next, { type: "BUTTONS", buttons });
}

export function updateWhatsAppTemplateButton(
  components: WhatsAppComponent[] | null | undefined,
  buttonIndex: number,
  patch: Partial<EditableWhatsAppTemplateButton>
): WhatsAppComponent[] {
  const next = cloneWhatsAppTemplateComponents(components);
  const buttonsComponent = findComponent(next, "BUTTONS");
  if (!buttonsComponent) return compactTemplateComponents(next);
  const existingButtons = [...(buttonsComponent.buttons || [])];
  const existing = existingButtons[buttonIndex];
  if (!existing) return compactTemplateComponents(next);

  const nextType =
    patch.type ?? mapButtonTypeToEditable(existing.type as WhatsAppButtonType);
  const nextLabel = patch.label ?? existing.text ?? "";

  const rebuiltButton = createTemplateButton(nextType, nextLabel);
  let nextButton: TemplateButton = rebuiltButton;
  if (rebuiltButton.type === "URL") {
    rebuiltButton.url =
      patch.value ?? (existing.type === "URL" ? existing.url || "" : "");
    nextButton = withButtonExample(
      rebuiltButton,
      patch.example ?? getButtonExample(existing)
    );
  } else if (rebuiltButton.type === "PHONE_NUMBER") {
    rebuiltButton.phone_number =
      patch.value ??
      (existing.type === "PHONE_NUMBER" ? existing.phone_number || "" : "");
    nextButton = rebuiltButton;
  } else if (rebuiltButton.type === "FLOW") {
    const selectingId = patch.flowId !== undefined;
    const selectingName = patch.flowName !== undefined;
    const selectingJson = patch.flowJson !== undefined;
    const existingFlow = existing.type === "FLOW" ? existing : null;
    const identifier = pickWhatsAppTemplateFlowIdentifier({
      flow_id: selectingId
        ? patch.flowId
        : selectingName || selectingJson
          ? undefined
          : existingFlow?.flow_id,
      flow_name: selectingName
        ? patch.flowName
        : selectingId || selectingJson
          ? undefined
          : existingFlow?.flow_name,
      flow_json: selectingJson
        ? patch.flowJson
        : selectingId || selectingName
          ? undefined
          : existingFlow?.flow_json,
    });
    if (identifier?.kind === "flow_id") {
      rebuiltButton.flow_id = identifier.flow_id;
    } else if (identifier?.kind === "flow_name") {
      rebuiltButton.flow_name = identifier.flow_name;
      delete rebuiltButton.flow_id;
    } else if (identifier?.kind === "flow_json") {
      rebuiltButton.flow_json = identifier.flow_json;
      delete rebuiltButton.flow_id;
    } else {
      rebuiltButton.flow_id = "";
    }
    rebuiltButton.flow_action =
      patch.flowAction ??
      (existing.type === "FLOW"
        ? (existing.flow_action ?? DEFAULT_FLOW_ACTION)
        : DEFAULT_FLOW_ACTION);
    const navigateScreen = normalizeTemplateText(
      patch.navigateScreen ??
        (existing.type === "FLOW" ? existing.navigate_screen : "")
    );
    if (rebuiltButton.flow_action === "navigate" && navigateScreen) {
      rebuiltButton.navigate_screen = navigateScreen;
    }
    nextButton = rebuiltButton;
  } else {
    nextButton = withButtonExample(
      rebuiltButton,
      patch.example ?? getButtonExample(existing)
    );
  }

  existingButtons[buttonIndex] = nextButton;
  return replaceComponent(next, {
    type: "BUTTONS",
    buttons: existingButtons,
  });
}

export function setWhatsAppTemplateButtons(
  components: WhatsAppComponent[] | null | undefined,
  buttons: EditableWhatsAppTemplateButton[]
): WhatsAppComponent[] {
  const next = cloneWhatsAppTemplateComponents(components);
  const buttonsComponent = buildButtonsComponent(buttons);
  if (!buttonsComponent) return removeComponent(next, "BUTTONS");
  return replaceComponent(next, buttonsComponent);
}

export function normalizeWhatsAppTemplateComponentsForMeta(
  components: WhatsAppComponent[] | null | undefined
): WhatsAppComponent[] {
  const source = ensureWhatsAppTemplateBodyComponent(components);
  const normalized: WhatsAppComponent[] = [];

  const header = findComponent(source, "HEADER");
  if (header) {
    if (header.format === "TEXT") {
      const text = normalizeTemplateText(header.text);
      if (text) {
        normalized.push({ ...header, text });
      }
    } else {
      normalized.push(header);
    }
  }

  const body = findComponent(source, "BODY");
  normalized.push({
    ...(body ?? {}),
    type: "BODY",
    text: normalizeTemplateText(body?.text),
  });

  const footer = findComponent(source, "FOOTER");
  const footerText = normalizeTemplateText(footer?.text);
  if (footer && footerText) {
    normalized.push({ ...footer, text: footerText });
  }

  const buttonsComponent = findComponent(source, "BUTTONS");
  if (buttonsComponent) {
    const editableButtons = getEditableWhatsAppTemplateButtons([
      buttonsComponent,
    ]);
    const normalizedButtons = buildButtonsComponent(editableButtons);
    if (normalizedButtons) {
      normalized.push(normalizedButtons);
    }
  }

  // The editor never changes carousel cards, but Meta needs them on update.
  const carousel = findComponent(source, "CAROUSEL");
  if (carousel) {
    normalized.push(carousel);
  }

  return compactTemplateComponents(normalized);
}

/** A carousel template has no header, footer, or message buttons to edit. */
export function isWhatsAppTemplateCarousel(
  components: WhatsAppComponent[] | null | undefined
): boolean {
  return Boolean(components?.some(component => component.type === "CAROUSEL"));
}

export function applyWhatsAppTemplateEditorFormValues(
  components: WhatsAppComponent[] | null | undefined,
  values: EditableWhatsAppTemplateEditorFormValues
): WhatsAppComponent[] {
  let next = updateWhatsAppTemplateBodyText(components, values.bodyText || "");
  if (!getWhatsAppTemplateHeaderMediaFormat(next)) {
    next = updateWhatsAppTemplateHeaderText(next, values.headerText || "");
  }
  next = updateWhatsAppTemplateFooterText(next, values.footerText || "");
  next = setWhatsAppTemplateButtons(next, values.buttons || []);
  return normalizeWhatsAppTemplateComponentsForMeta(next);
}

export type WhatsAppTemplateEditorSave = {
  /** The template sent to Meta and saved on the step. */
  components: WhatsAppComponent[];
  /** The step's next button ids; absent when the stored ids stay as they are. */
  buttonIds?: ScenarioWhatsAppTemplateButtonIds;
  /** The form values of the saved template. */
  values: EditableWhatsAppTemplateEditorFormValues;
};

/**
 * What saving the inline template editor writes. Each saved quick reply keeps
 * the id its row started with, so its route stays on it; a new one gets a new
 * id. Rows are walked as buildButtonsComponent walks them, so ids line up
 * with the saved buttons.
 */
export function buildWhatsAppTemplateEditorSave(params: {
  /** The step's template as the editor shows it. */
  components: WhatsAppComponent[];
  buttonIds: unknown;
  values: EditableWhatsAppTemplateEditorFormValues;
}): WhatsAppTemplateEditorSave {
  const components = applyWhatsAppTemplateEditorFormValues(
    params.components,
    params.values
  );
  const origins = (params.values.buttons || []).flatMap(button =>
    normalizeEditableTemplateButton(button)?.type === "QUICK_REPLY"
      ? [button.routeId ?? null]
      : []
  );
  const buttonIds = rekeyStoredWhatsAppTemplateButtonIds({
    previous: { components: params.components, buttonIds: params.buttonIds },
    components,
    match: { origins },
  });
  return {
    components,
    ...(buttonIds ? { buttonIds } : {}),
    values: getEditableWhatsAppTemplateEditorFormValues({
      replyText: params.values.bodyText,
      components,
      buttonIds: buttonIds ?? params.buttonIds,
    }),
  };
}

/** The step patch the inline editor applies once Meta accepts the template. */
export function buildWhatsAppTemplateEditorSavePatch(
  saved: WhatsAppTemplateEditorSave,
  templateCategory: string | undefined
): Partial<ScenarioNodeData> {
  return {
    actionReplyText: saved.values.bodyText,
    actionWhatsAppTemplateCategory: templateCategory,
    actionWhatsAppTemplateComponents: saved.components,
    ...(saved.buttonIds
      ? { actionWhatsAppTemplateButtonIds: saved.buttonIds }
      : {}),
  };
}
