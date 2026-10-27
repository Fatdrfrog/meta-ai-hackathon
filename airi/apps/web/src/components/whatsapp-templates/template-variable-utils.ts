import { extractTemplateVariables } from "@icecore/shared/types/whatsapp";

type TemplateButton = {
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
  flow_action?: "navigate" | "data_exchange";
  navigate_screen?: string;
  otp_type?: "COPY_CODE" | "ONE_TAP" | "ZERO_TAP";
};

const PLACEHOLDER_REGEX = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;
/** Meta's named-variable alphabet; digits alone keep a variable numbered. */
const VARIABLE_NAME_REGEX = /^[a-z0-9_]+$/;

function sortVariableKeys(keys: Iterable<string>): string[] {
  const unique = Array.from(new Set(keys));
  const numeric = unique
    .filter(value => /^\d+$/.test(value))
    .sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10));
  const named = unique
    .filter(value => !/^\d+$/.test(value))
    .sort((a, b) => a.localeCompare(b));
  return [...numeric, ...named];
}

export function isValidVariableName(value: string): boolean {
  return VARIABLE_NAME_REGEX.test(value);
}

/** Meta lets a button link carry one variable, only at its very end. */
export function hasValidTemplateUrlVariablePlacement(url: string): boolean {
  const placeholders = url.match(PLACEHOLDER_REGEX) ?? [];
  if (placeholders.length === 0) return true;
  return (
    placeholders.length === 1 && /\{\{\s*[A-Za-z0-9_]+\s*\}\}\s*$/.test(url)
  );
}

export function collectTemplateVariableKeys(input: {
  headerText?: string;
  bodyText?: string;
  telegramText?: string;
  buttons?: TemplateButton[];
  carouselCards?: Array<{
    bodyText?: string;
    buttons?: Array<{ type?: string; url?: string }>;
  }>;
}): string[] {
  const set = new Set<string>();

  const addFromText = (text?: string) => {
    extractTemplateVariables(text || "").forEach(variable => set.add(variable));
  };

  addFromText(input.headerText);
  addFromText(input.bodyText);
  addFromText(input.telegramText);

  (input.buttons || []).forEach(button => {
    if (button.type === "URL") {
      addFromText(button.url);
    }
  });

  (input.carouselCards || []).forEach(card => {
    addFromText(card.bodyText);
    (card.buttons || []).forEach(button => {
      if (button.type === "URL") {
        addFromText(button.url);
      }
    });
  });

  return sortVariableKeys(set);
}

export function renameTemplateVariableInText(
  text: string,
  from: string,
  to: string
): string {
  if (!text || !from || !to || from === to) return text;
  return text.replace(PLACEHOLDER_REGEX, (_whole, key: string) =>
    key === from ? `{{${to}}}` : `{{${key}}}`
  );
}
