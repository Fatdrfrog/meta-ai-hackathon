import {
  WHATSAPP_FLOW_UI_LOCALE_IDS,
  type WhatsAppFlowUiLocaleId,
} from "@icecore/scenario-contracts";

export { WHATSAPP_FLOW_UI_LOCALE_IDS } from "@icecore/scenario-contracts";
export type { WhatsAppFlowUiLocaleId } from "@icecore/scenario-contracts";

/** Max length for Flow `Footer` `label` per WhatsApp Flow validation. */
export const WHATSAPP_FLOW_SUBMIT_MAX_LENGTH = 35;

const DEFAULT_SUBMIT_BY_LOCALE: Record<WhatsAppFlowUiLocaleId, string> = {
  en: "Submit",
  ru: "Отправить",
  kk: "Жіберу",
  es: "Enviar",
  pt: "Enviar",
  uz: "Yuborish",
  tr: "Gönder",
  de: "Senden",
  fr: "Envoyer",
  ar: "إرسال",
};

export function isWhatsAppFlowUiLocaleId(
  value: string
): value is WhatsAppFlowUiLocaleId {
  return (WHATSAPP_FLOW_UI_LOCALE_IDS as readonly string[]).includes(value);
}

export function normalizeWhatsAppFlowUiLocale(
  value: unknown
): WhatsAppFlowUiLocaleId {
  return typeof value === "string" && isWhatsAppFlowUiLocaleId(value)
    ? value
    : "en";
}

export function defaultSubmitLabelForFlowLocale(
  locale: WhatsAppFlowUiLocaleId
): string {
  return DEFAULT_SUBMIT_BY_LOCALE[locale];
}

export function resolveFlowSubmitButtonLabel(params: {
  flowUiLocale?: WhatsAppFlowUiLocaleId;
  flowSubmitLabel?: string | null | undefined;
}): string {
  const custom = params.flowSubmitLabel?.trim();
  if (custom) {
    return custom.length > WHATSAPP_FLOW_SUBMIT_MAX_LENGTH
      ? custom.slice(0, WHATSAPP_FLOW_SUBMIT_MAX_LENGTH)
      : custom;
  }
  return defaultSubmitLabelForFlowLocale(params.flowUiLocale ?? "en");
}

/** If the Footer label matches a built-in translation, return that locale id. */
export function inferFlowUiLocaleFromSubmitLabel(
  label: string | undefined | null
): WhatsAppFlowUiLocaleId | undefined {
  const t = typeof label === "string" ? label.trim() : "";
  if (!t) return undefined;
  for (const id of WHATSAPP_FLOW_UI_LOCALE_IDS) {
    if (DEFAULT_SUBMIT_BY_LOCALE[id] === t) return id;
  }
  return undefined;
}

/**
 * Map WhatsApp Cloud API template `language` (e.g. `kk`, `en_US`) to a supported
 * Flow form UI locale. Unknown codes fall back to `en`.
 */
export function mapWhatsAppTemplateLanguageToFlowUiLocale(
  raw: string | null | undefined
): WhatsAppFlowUiLocaleId {
  if (typeof raw !== "string") return "en";
  const trimmed = raw.trim();
  if (!trimmed) return "en";
  const primary = trimmed.split(/[-_]/)[0]?.toLowerCase() ?? "";
  if (!primary) return "en";
  if (isWhatsAppFlowUiLocaleId(primary)) return primary;
  if (primary === "kz") return "kk";
  return "en";
}
