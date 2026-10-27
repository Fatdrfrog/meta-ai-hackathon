import {
  SUPPORTED_WIDGET_LANGUAGE_CODES,
  type WidgetLanguageCode,
  type WidgetQuickRepliesTranslations,
} from "../types/widget-config";

export const MAX_WIDGET_QUICK_REPLIES = 8;
export const MAX_WIDGET_QUICK_REPLY_LENGTH = 80;
export const DEFAULT_WIDGET_LANGUAGE_CODE: WidgetLanguageCode = "ru";
export const LEGACY_DEFAULT_WIDGET_QUICK_REPLIES = [
  "How can I get support?",
  "What are your business hours?",
  "How do I track my order?",
  "Do you offer refunds?",
] as const;

const WIDGET_LANGUAGE_ALIASES: Record<string, WidgetLanguageCode> = {
  kk: "kz",
};

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }

  return Math.max(min, Math.min(max, value));
}

export function normalizeWidgetQuickReply(value: string): string {
  return value
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, MAX_WIDGET_QUICK_REPLY_LENGTH);
}

export function normalizeWidgetQuickReplies(
  quickReplies: unknown,
  maxReplies: number = MAX_WIDGET_QUICK_REPLIES,
): string[] {
  if (!Array.isArray(quickReplies)) {
    return [];
  }

  const max = clamp(maxReplies, 1, MAX_WIDGET_QUICK_REPLIES);
  const normalized: string[] = [];
  const seen = new Set<string>();

  for (const item of quickReplies) {
    if (typeof item !== "string") {
      continue;
    }

    const value = normalizeWidgetQuickReply(item);
    if (!value) {
      continue;
    }

    const key = value.toLowerCase();
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    normalized.push(value);

    if (normalized.length >= max) {
      break;
    }
  }

  return normalized;
}

export function isLegacyDefaultWidgetQuickReplies(
  quickReplies: unknown,
): boolean {
  if (!Array.isArray(quickReplies)) {
    return false;
  }

  const normalized = normalizeWidgetQuickReplies(
    quickReplies,
    LEGACY_DEFAULT_WIDGET_QUICK_REPLIES.length,
  );
  if (normalized.length !== LEGACY_DEFAULT_WIDGET_QUICK_REPLIES.length) {
    return false;
  }

  return normalized.every((reply, index) => {
    const legacy = LEGACY_DEFAULT_WIDGET_QUICK_REPLIES[index];
    if (legacy === undefined) {
      return false;
    }
    return (
      reply.toLowerCase() === normalizeWidgetQuickReply(legacy).toLowerCase()
    );
  });
}

export function normalizeWidgetLanguageCode(
  value: unknown,
): WidgetLanguageCode | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim().toLowerCase().replace(/_/g, "-");
  if (!normalized) {
    return null;
  }

  const directMatch = WIDGET_LANGUAGE_ALIASES[normalized];
  if (directMatch) {
    return directMatch;
  }

  if (
    SUPPORTED_WIDGET_LANGUAGE_CODES.includes(normalized as WidgetLanguageCode)
  ) {
    return normalized as WidgetLanguageCode;
  }

  const [base] = normalized.split("-");
  if (!base) {
    return null;
  }

  const baseMatch = WIDGET_LANGUAGE_ALIASES[base];
  if (baseMatch) {
    return baseMatch;
  }

  if (SUPPORTED_WIDGET_LANGUAGE_CODES.includes(base as WidgetLanguageCode)) {
    return base as WidgetLanguageCode;
  }

  return null;
}

export function parseWidgetAcceptLanguageHeader(value: unknown): string[] {
  if (typeof value !== "string") {
    return [];
  }

  return value
    .split(",")
    .map((part) => part.trim().split(";")[0]?.trim() || "")
    .filter(Boolean);
}

export function pickSupportedWidgetLanguage(
  candidates: Array<unknown>,
  fallback: WidgetLanguageCode = DEFAULT_WIDGET_LANGUAGE_CODE,
): WidgetLanguageCode {
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      for (const nestedCandidate of candidate) {
        const nested = normalizeWidgetLanguageCode(nestedCandidate);
        if (nested) {
          return nested;
        }
      }
      continue;
    }

    const normalized = normalizeWidgetLanguageCode(candidate);
    if (normalized) {
      return normalized;
    }
  }

  return normalizeWidgetLanguageCode(fallback) || DEFAULT_WIDGET_LANGUAGE_CODE;
}

export function normalizeWidgetQuickRepliesTranslations(
  value: unknown,
): WidgetQuickRepliesTranslations {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const source = value as Record<string, unknown>;
  const normalized: WidgetQuickRepliesTranslations = {};

  for (const locale of SUPPORTED_WIDGET_LANGUAGE_CODES) {
    const replies = normalizeWidgetQuickReplies(source[locale]);
    if (replies.length > 0) {
      normalized[locale] = replies;
    }
  }

  const kazakhAliasReplies = normalizeWidgetQuickReplies(source.kk);
  if (kazakhAliasReplies.length > 0 && !normalized.kz?.length) {
    normalized.kz = kazakhAliasReplies;
  }

  return normalized;
}

type ResolveLocalizedWidgetQuickRepliesParams = {
  defaultQuickReplies?: unknown;
  localizedQuickReplies?: unknown;
  preferredLocaleCandidates?: Array<unknown>;
  defaultLocale?: unknown;
  fallbackQuickReplies?: unknown;
};

export function resolveLocalizedWidgetQuickReplies(
  params: ResolveLocalizedWidgetQuickRepliesParams,
): {
  locale: WidgetLanguageCode;
  quickReplies: string[];
} {
  const requestedLocale = pickSupportedWidgetLanguage(
    params.preferredLocaleCandidates || [],
    DEFAULT_WIDGET_LANGUAGE_CODE,
  );
  const defaultLocale =
    normalizeWidgetLanguageCode(params.defaultLocale) ||
    DEFAULT_WIDGET_LANGUAGE_CODE;
  const localizedReplies = normalizeWidgetQuickRepliesTranslations(
    params.localizedQuickReplies,
  );
  const requestedReplies = localizedReplies[requestedLocale];

  if (requestedReplies?.length) {
    return {
      locale: requestedLocale,
      quickReplies: requestedReplies,
    };
  }

  const defaultReplies = normalizeWidgetQuickReplies(
    params.defaultQuickReplies,
  );
  if (defaultReplies.length > 0) {
    return {
      locale: defaultLocale,
      quickReplies: defaultReplies,
    };
  }

  const fallbackReplies = normalizeWidgetQuickReplies(
    params.fallbackQuickReplies,
  );

  return {
    locale: requestedLocale,
    quickReplies: fallbackReplies,
  };
}
