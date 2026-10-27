import { WHATSAPP_MARKETING_MESSAGES_BID_STRATEGY } from "@/lib/whatsapp/marketing/message-pricing";
import {
  isTemplateHeaderMediaFormat,
  type TemplateHeaderMediaFormat,
} from "@/lib/whatsapp/templates/header-media-utils";
import {
  buildWhatsAppTemplateTextExample,
  getTemplateVariableFormatIssues,
} from "@/lib/whatsapp/templates/parameter-format";
import { WHATSAPP_TEMPLATE_LIMITS } from "@icecore/shared/constants/whatsapp-templates";
import type { TemplateChannel } from "@icecore/shared/types/templates";
import type {
  WhatsAppCarouselCard,
  WhatsAppCarouselCardButton,
  WhatsAppComponent,
  WhatsAppHeaderFormat,
  WhatsAppMarketingMessagesOptimizationSpec,
} from "@icecore/shared/types/whatsapp";
import { extractTemplateVariables } from "@icecore/shared/types/whatsapp";
import type { TemplateCarouselCardFormValue } from "./template-carousel-model";
import { getWhatsAppTemplateCarouselComponent } from "./template-carousel-model";

const TEMPLATE_VARIABLE_PATTERN = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;
const BODY_VARIABLE_EXAMPLES = [
  "John",
  "12345",
  "https://example.com",
  "Product Name",
  "Company",
];

export type TemplateFormValues = {
  name: string;
  targetPlatform: TemplateChannel;
  language?: string;
  category?: "MARKETING" | "UTILITY" | "AUTHENTICATION";
  marketingMaxPriceEnabled?: boolean;
  marketingMaxPriceBidAmount?: number | string;
  hasHeader?: boolean;
  headerFormat?: WhatsAppHeaderFormat;
  headerText?: string;
  headerMediaExample?: string;
  bodyText?: string;
  authSecurityRecommendation?: boolean;
  authCodeExpirationMinutes?: number | "";
  /** Samples Meta holds for named variables, by name, so an edit sends them back. */
  variableExamples?: Record<string, string>;
  hasFooter?: boolean;
  footerText?: string;
  hasButtons?: boolean;
  buttons?: Array<{
    clientId?: string;
    type:
      | "QUICK_REPLY"
      | "URL"
      | "PHONE_NUMBER"
      | "FLOW"
      | "OTP"
      | "REQUEST_CONTACT_INFO";
    text?: string;
    url?: string;
    phone_number?: string;
    flow_id?: string;
    flow_name?: string;
    flow_json?: string;
    flow_action?: "navigate" | "data_exchange";
    navigate_screen?: string;
    otp_type?: "COPY_CODE" | "ONE_TAP" | "ZERO_TAP";
    autofill_text?: string;
    package_name?: string;
    signature_hash?: string;
    zero_tap_terms_accepted?: boolean;
  }>;
  hasCarousel?: boolean;
  carouselHeaderFormat?: "IMAGE" | "VIDEO";
  carouselCards?: TemplateCarouselCardFormValue[];
  telegramText?: string;
  telegramParseMode?: "None" | "Markdown" | "HTML";
  hasTelegramButtons?: boolean;
  telegramButtons?: Array<{
    clientId?: string;
    text: string;
    url?: string;
    callbackData?: string;
  }>;
};

function toTemplateString(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  return String(value);
}

function toTrimmedTemplateString(value: unknown): string {
  return toTemplateString(value).trim();
}

function sampleHeaderOrCardVariable(variable: string): string {
  return `Sample ${variable}`;
}

function sampleBodyVariable(variable: string, index: number): string {
  return (
    BODY_VARIABLE_EXAMPLES[index % BODY_VARIABLE_EXAMPLES.length] || variable
  );
}

/** Which WhatsApp sections the form submits: carousels replace header, footer, and buttons. */
function getTemplateFormSections(values: TemplateFormValues) {
  const isAuthenticationTemplate = values.category === "AUTHENTICATION";
  return {
    isAuthenticationTemplate,
    hasCarousel:
      !isAuthenticationTemplate &&
      values.category === "MARKETING" &&
      Boolean(values.hasCarousel),
  };
}

/**
 * Whether the submitted template has a text header. A removed header, a media
 * header, or one hidden by the carousel shape keeps its text but sends none.
 */
export function isTemplateFormTextHeaderActive(
  values: TemplateFormValues
): boolean {
  const { isAuthenticationTemplate, hasCarousel } =
    getTemplateFormSections(values);
  return (
    !hasCarousel &&
    !isAuthenticationTemplate &&
    Boolean(values.hasHeader) &&
    !isWhatsAppTemplateMediaHeaderFormat(values.headerFormat) &&
    values.headerFormat !== "LOCATION"
  );
}

/**
 * Meta: "Do not use Markdown special characters" in a text header; WhatsApp
 * already shows it in bold. Underscores inside {{variable_names}} don't count.
 */
export function hasTemplateHeaderFormattingMarkers(text: string): boolean {
  return /[*_~`]/.test(text.replace(TEMPLATE_VARIABLE_PATTERN, ""));
}

/**
 * Template names as WhatsApp Manager types them: lowercase, with "_" for each
 * space. One character for one keeps the caret where the author is typing.
 */
export function normalizeTemplateNameInput(value: string): string {
  return value.replace(/\s/g, "_").toLowerCase();
}

function firstHeaderMediaExample(
  component: WhatsAppComponent | undefined
): string {
  if (!component || component.type !== "HEADER") return "";
  return toTemplateString(component.example?.header_handle?.[0]);
}

export function isWhatsAppTemplateMediaHeaderFormat(
  value: unknown
): value is TemplateHeaderMediaFormat {
  return isTemplateHeaderMediaFormat(value);
}

export function getWhatsAppTemplateHeaderMediaExample(
  components: WhatsAppComponent[] | null | undefined
): string {
  if (!Array.isArray(components)) return "";
  return firstHeaderMediaExample(
    components.find(component => component.type === "HEADER")
  );
}

export { getWhatsAppTemplateCarouselComponent };

function buildCarouselCardFromFormValue(
  card: TemplateCarouselCardFormValue,
  options?: {
    allowIncomplete?: boolean;
    namedExamples?: Record<string, string>;
  }
): WhatsAppCarouselCard | null {
  const allowIncomplete = Boolean(options?.allowIncomplete);
  const headerHandle = toTrimmedTemplateString(card.headerMediaExample);
  if (!headerHandle && !allowIncomplete) return null;

  const header: Extract<
    WhatsAppCarouselCard["components"][number],
    { type: "HEADER" }
  > = {
    type: "HEADER",
    format: card.headerFormat === "VIDEO" ? "VIDEO" : "IMAGE",
  };
  if (headerHandle) {
    header.example = {
      header_handle: [headerHandle],
    };
  }

  const components: WhatsAppCarouselCard["components"] = [header];

  const bodyText = toTemplateString(card.bodyText).slice(
    0,
    WHATSAPP_TEMPLATE_LIMITS.CAROUSEL_CARD_BODY_MAX_LENGTH
  );
  if (bodyText.trim() || allowIncomplete) {
    const bodyExample = buildWhatsAppTemplateTextExample({
      text: bodyText,
      kind: "body",
      sample: sampleHeaderOrCardVariable,
      namedExamples: options?.namedExamples,
    });
    const bodyComponent: Extract<
      WhatsAppCarouselCard["components"][number],
      { type: "BODY" }
    > = {
      type: "BODY",
      text: bodyText,
    };
    if (bodyExample) {
      bodyComponent.example = bodyExample;
    }
    components.push(bodyComponent);
  }

  const buttons = (card.buttons || [])
    .slice(0, WHATSAPP_TEMPLATE_LIMITS.CAROUSEL_CARD_BUTTONS_MAX_COUNT)
    .map((button): WhatsAppCarouselCardButton | null => {
      const text = allowIncomplete
        ? toTemplateString(button.text)
        : toTrimmedTemplateString(button.text);
      if (!text && !allowIncomplete) return null;
      if (button.type === "URL") {
        const url = toTemplateString(button.url);
        const urlExample = buildUrlButtonExamples(url);
        const urlButton: Extract<WhatsAppCarouselCardButton, { type: "URL" }> =
          {
            type: "URL",
            text,
            url,
          };
        if (urlExample) urlButton.example = urlExample;
        return urlButton;
      }
      if (button.type === "PHONE_NUMBER") {
        return {
          type: "PHONE_NUMBER",
          text,
          phone_number: toTemplateString(button.phone_number),
        };
      }
      return { type: "QUICK_REPLY", text };
    })
    .filter((button): button is WhatsAppCarouselCardButton => Boolean(button));

  if (buttons.length === 0 && !allowIncomplete) return null;
  if (buttons.length > 0) {
    components.push({ type: "BUTTONS", buttons });
  }
  return { components };
}

function buildHeaderComponent(
  values: TemplateFormValues
): WhatsAppComponent | null {
  if (!values.hasHeader) return null;

  const format = values.headerFormat || "TEXT";
  if (format === "LOCATION") return { type: "HEADER", format };
  if (isWhatsAppTemplateMediaHeaderFormat(format)) {
    const headerHandle = toTrimmedTemplateString(values.headerMediaExample);
    if (!headerHandle) return null;
    return {
      type: "HEADER",
      format,
      example: {
        header_handle: [headerHandle],
      },
    };
  }

  if (!values.headerText) return null;

  const headerExample = buildWhatsAppTemplateTextExample({
    text: values.headerText,
    kind: "header",
    sample: sampleHeaderOrCardVariable,
    namedExamples: values.variableExamples,
  });
  const headerComponent: WhatsAppComponent = {
    type: "HEADER",
    format: "TEXT",
    text: values.headerText,
  };
  if (headerExample) {
    headerComponent.example = headerExample;
  }
  return headerComponent;
}

function buildUrlButtonExamples(url: string): string[] | undefined {
  if (!extractTemplateVariables(url).length) return undefined;
  return [
    url.replace(TEMPLATE_VARIABLE_PATTERN, (_, variable: string) => {
      return `${variable}_example`;
    }),
  ];
}

export function buildWhatsAppTemplateComponentsFromFormValues(
  values: TemplateFormValues,
  options?: { includeIncompleteCarousel?: boolean; forPreview?: boolean }
): WhatsAppComponent[] {
  const components: WhatsAppComponent[] = [];
  const { isAuthenticationTemplate, hasCarousel } =
    getTemplateFormSections(values);

  if (isAuthenticationTemplate) {
    const security = values.authSecurityRecommendation !== false;
    const expiry = values.authCodeExpirationMinutes;
    const body: WhatsAppComponent = {
      type: "BODY",
      add_security_recommendation: security,
    };
    const copyCodeButton = values.buttons?.find(
      button => button.type === "OTP" && button.otp_type === "COPY_CODE"
    );
    const button: Extract<
      WhatsAppComponent,
      { type: "BUTTONS" }
    >["buttons"][number] = { type: "OTP", otp_type: "COPY_CODE" };
    const label = toTrimmedTemplateString(copyCodeButton?.text);
    if (label) button.text = label;
    if (options?.forPreview) {
      // Preview only: Meta generates the actual authentication message in the selected language.
      const preview =
        values.language === "ru"
          ? {
              body: "{{1}} — ваш код подтверждения.",
              security: "Не сообщайте этот код другим людям.",
              expiry: `Срок действия кода — ${expiry} мин.`,
              button: "Копировать код",
            }
          : values.language === "kk" || values.language === "kz"
            ? {
                body: "{{1}} — растау кодыңыз.",
                security: "Бұл кодты ешкімге бермеңіз.",
                expiry: `Код ${expiry} минуттан кейін жарамсыз болады.`,
                button: "Кодты көшіру",
              }
            : {
                body: "{{1}} is your verification code.",
                security: "For your security, do not share this code.",
                expiry: `This code expires in ${expiry} minutes.`,
                button: "Copy code",
              };
      body.text = `${preview.body}${security ? ` ${preview.security}` : ""}`;
      components.push(body);
      if (typeof expiry === "number")
        components.push({ type: "FOOTER", text: preview.expiry });
      button.text ||= preview.button;
    } else {
      components.push(body);
      if (typeof expiry === "number")
        components.push({ type: "FOOTER", code_expiration_minutes: expiry });
    }
    components.push({ type: "BUTTONS", buttons: [button] });
    return components;
  }

  if (!hasCarousel) {
    const headerComponent = isAuthenticationTemplate
      ? null
      : buildHeaderComponent(values);
    if (headerComponent) {
      components.push(headerComponent);
    }
  }

  const bodyExample = buildWhatsAppTemplateTextExample({
    text: values.bodyText || "",
    kind: "body",
    sample: sampleBodyVariable,
    namedExamples: values.variableExamples,
  });
  const bodyComponent: WhatsAppComponent = {
    type: "BODY",
    text: values.bodyText || "",
  };
  if (bodyExample) {
    bodyComponent.example = bodyExample;
  }
  components.push(bodyComponent);

  if (
    !hasCarousel &&
    !isAuthenticationTemplate &&
    values.hasFooter &&
    values.footerText
  ) {
    components.push({
      type: "FOOTER",
      text: values.footerText,
    });
  }

  if (hasCarousel) {
    const cards = (values.carouselCards || [])
      .map(card =>
        buildCarouselCardFromFormValue(
          {
            ...card,
            headerFormat:
              values.carouselHeaderFormat || card.headerFormat || "IMAGE",
          },
          {
            allowIncomplete: options?.includeIncompleteCarousel,
            namedExamples: values.variableExamples,
          }
        )
      )
      .filter((card): card is WhatsAppCarouselCard => Boolean(card));
    if (cards.length > 0) {
      components.push({
        type: "CAROUSEL",
        cards,
      });
    }
    return components;
  }

  if (values.hasButtons && values.buttons && values.buttons.length > 0) {
    components.push({
      type: "BUTTONS",
      buttons: values.buttons.map(button => {
        if (button.type === "URL") {
          const url = toTemplateString(button.url);
          const urlExample = buildUrlButtonExamples(url);
          const urlButton: {
            type: "URL";
            text: string;
            url: string;
            example?: string[];
          } = {
            type: "URL",
            text: toTemplateString(button.text),
            url,
          };
          if (urlExample) {
            urlButton.example = urlExample;
          }
          return urlButton;
        }
        if (button.type === "PHONE_NUMBER") {
          return {
            type: "PHONE_NUMBER",
            text: toTemplateString(button.text),
            phone_number: toTemplateString(button.phone_number),
          };
        }
        if (button.type === "FLOW") {
          const flowAction = button.flow_action || "navigate";
          const flowId = toTrimmedTemplateString(button.flow_id);
          const flowName = toTrimmedTemplateString(button.flow_name);
          const flowJson = toTrimmedTemplateString(button.flow_json);
          const flowButton: {
            type: "FLOW";
            text: string;
            flow_id?: string;
            flow_name?: string;
            flow_json?: string;
            flow_action: "navigate" | "data_exchange";
            navigate_screen?: string;
          } = {
            type: "FLOW",
            text: toTemplateString(button.text),
            flow_action: flowAction,
          };
          if (flowId) flowButton.flow_id = flowId;
          else if (flowName) flowButton.flow_name = flowName;
          else if (flowJson) flowButton.flow_json = flowJson;
          const navigateScreen = toTrimmedTemplateString(
            button.navigate_screen
          );
          return flowAction === "navigate" && navigateScreen
            ? {
                ...flowButton,
                navigate_screen: navigateScreen,
              }
            : flowButton;
        }
        if (button.type === "OTP") {
          return {
            type: "OTP",
            otp_type: button.otp_type || "COPY_CODE",
            text: toTrimmedTemplateString(button.text) || "Copy code",
          };
        }
        if (button.type === "REQUEST_CONTACT_INFO") {
          return { type: "REQUEST_CONTACT_INFO" };
        }
        return { type: "QUICK_REPLY", text: toTemplateString(button.text) };
      }),
    });
  }

  return components;
}

/**
 * The submitted header, body, and card body fields whose variables break the
 * template's format: numbers next to names, or names Meta rejects.
 */
export function getTemplateFormVariableFormatIssues(
  values: TemplateFormValues
) {
  const { isAuthenticationTemplate, hasCarousel } =
    getTemplateFormSections(values);
  const texts: Array<{ path: Array<string | number>; text: string }> = [];

  if (isTemplateFormTextHeaderActive(values)) {
    texts.push({ path: ["headerText"], text: values.headerText || "" });
  }
  if (!isAuthenticationTemplate)
    texts.push({ path: ["bodyText"], text: values.bodyText || "" });
  if (hasCarousel) {
    (values.carouselCards || []).forEach((card, index) => {
      texts.push({
        path: ["carouselCards", index, "bodyText"],
        text: card?.bodyText || "",
      });
    });
  }

  return getTemplateVariableFormatIssues(texts);
}

export function buildWhatsAppMarketingMessagesOptimizationSpecFromFormValues(
  values: TemplateFormValues
): WhatsAppMarketingMessagesOptimizationSpec | undefined {
  if (values.category !== "MARKETING" || !values.marketingMaxPriceEnabled) {
    return undefined;
  }

  const bidAmount = Number(values.marketingMaxPriceBidAmount);
  if (!Number.isSafeInteger(bidAmount) || bidAmount <= 0) {
    return undefined;
  }

  return {
    bid_amount: bidAmount,
    bid_strategy: WHATSAPP_MARKETING_MESSAGES_BID_STRATEGY,
  };
}

export function getFirstTemplateFormErrorMessage(
  error: unknown
): string | null {
  if (!error || typeof error !== "object") return null;

  const record = error as Record<string, unknown>;
  if (typeof record.message === "string" && record.message.trim()) {
    return record.message.trim();
  }

  for (const value of Object.values(record)) {
    const message = getFirstTemplateFormErrorMessage(value);
    if (message) return message;
  }

  return null;
}
