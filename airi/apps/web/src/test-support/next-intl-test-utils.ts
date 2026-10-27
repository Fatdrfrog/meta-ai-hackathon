import * as React from "react";

// A next-intl mock that resolves real messages from NextIntlClientProvider,
// for suites that render translated text. Use it inside the jest.mock
// factory (jest.mock factories cannot close over imports):
//
//   jest.mock("next-intl", () =>
//     jest
//       .requireActual("@/test-support/next-intl-test-utils")
//       .createMessagesNextIntlMock()
//   );
//
// Suites that only need message keys use the global jest.mocks/next-intl.js.

type Messages = Record<string, unknown>;
type Values = Record<string, string | number>;

export type MessageFormatContext = {
  /** The namespaced key, "Namespace.key". */
  key: string;
  locale: string;
};

/**
 * Turns the resolved message (undefined when it is missing or not a string)
 * into the returned text.
 */
export type MessageFormatter = (
  message: string | undefined,
  values: Values | undefined,
  context: MessageFormatContext
) => string;

export function resolveMessage(messages: Messages, dottedPath: string) {
  return dottedPath
    .split(".")
    .reduce<unknown>(
      (current, part) =>
        current && typeof current === "object"
          ? (current as Record<string, unknown>)[part]
          : undefined,
      messages
    );
}

/** The message as written, or the namespaced key when it is missing. */
export const messageOrKey: MessageFormatter = (message, _values, { key }) =>
  message ?? key;

/** Fills every {name} placeholder, with "" for values that were not passed. */
export const fillPlaceholders: MessageFormatter = (message, values, { key }) =>
  message === undefined
    ? key
    : message.replace(/\{(\w+)\}/g, (_, name: string) =>
        String(values?.[name] ?? "")
      );

/** Replaces the first {name} for each passed value; others stay as written. */
export function replacePassedValues(message: string, values?: Values) {
  return Object.entries(values ?? {}).reduce(
    (result, [name, replacement]) =>
      result.replace(`{${name}}`, String(replacement)),
    message
  );
}

export const fillPassedValues: MessageFormatter = (message, values, { key }) =>
  message === undefined ? key : replacePassedValues(message, values);

function intlLocaleFor(locale: string) {
  return locale === "kz" ? "kk-KZ" : locale;
}

// Built once per locale; plural messages format on every render.
const pluralRulesByLocale = new Map<string, Intl.PluralRules>();
const numberFormatByLocale = new Map<string, Intl.NumberFormat>();

function pluralRulesFor(locale: string) {
  let rules = pluralRulesByLocale.get(locale);
  if (!rules) {
    rules = new Intl.PluralRules(intlLocaleFor(locale));
    pluralRulesByLocale.set(locale, rules);
  }
  return rules;
}

function numberFormatFor(locale: string) {
  let format = numberFormatByLocale.get(locale);
  if (!format) {
    format = new Intl.NumberFormat(intlLocaleFor(locale));
    numberFormatByLocale.set(locale, format);
  }
  return format;
}

function closingBraceIndex(text: string, openIndex: number) {
  let depth = 0;
  for (let index = openIndex; index < text.length; index += 1) {
    if (text[index] === "{") depth += 1;
    if (text[index] === "}") depth -= 1;
    if (depth === 0) return index;
  }
  throw new Error(`Unbalanced braces in message: ${text}`);
}

function parseIcuOptions(text: string) {
  const options: Record<string, string> = {};
  let index = 0;
  while (index < text.length) {
    const open = text.indexOf("{", index);
    if (open === -1) break;
    const selector = text.slice(index, open).trim();
    const close = closingBraceIndex(text, open);
    options[selector] = text.slice(open + 1, close);
    index = close + 1;
  }
  return options;
}

/**
 * Formats the ICU subset the catalogs use: {name}, plural (=n, CLDR
 * categories, #) and select. Missing values stay as written.
 */
export function formatIcuMessage(
  message: string,
  values: Values = {},
  locale = "en"
): string {
  const format = (text: string, pound?: string): string => {
    let output = "";
    let index = 0;
    while (index < text.length) {
      const char = text[index];
      if (char === "#" && pound !== undefined) {
        output += pound;
        index += 1;
        continue;
      }
      if (char !== "{") {
        output += char;
        index += 1;
        continue;
      }
      const close = closingBraceIndex(text, index);
      const body = text.slice(index + 1, close);
      index = close + 1;
      const [name, kind] = body.split(",", 2).map(part => part.trim());
      const value = values[name];
      if (!kind) {
        output += value === undefined ? `{${body}}` : String(value);
        continue;
      }
      const options = parseIcuOptions(
        body.slice(body.indexOf(",", body.indexOf(",") + 1) + 1)
      );
      if (kind === "plural") {
        const count = Number(value);
        const category = pluralRulesFor(locale).select(count);
        const branch =
          options[`=${count}`] ?? options[category] ?? options.other ?? "";
        output += format(branch, numberFormatFor(locale).format(count));
      } else {
        output += format(options[String(value)] ?? options.other ?? "", pound);
      }
    }
    return output;
  };
  return format(message);
}

/**
 * next-intl stand-in that formats real catalog messages (ICU included)
 * without a provider. Missing keys return the namespaced key.
 *
 *   jest.mock("next-intl", () =>
 *     jest
 *       .requireActual("@/test-support/next-intl-test-utils")
 *       .createCatalogNextIntlMock(jest.requireActual("../messages/en.json"))
 *   );
 */
export function createCatalogNextIntlMock(messages: Messages, locale = "en") {
  // Stable per namespace, like next-intl, so hook dependencies stay stable.
  const translators = new Map<string, ReturnType<typeof buildTranslator>>();
  const buildTranslator = (namespace?: string) => {
    const fullKey = (key: string) => (namespace ? `${namespace}.${key}` : key);
    const lookup = (key: string) => {
      const value = resolveMessage(messages, fullKey(key));
      return typeof value === "string" ? value : undefined;
    };
    const translate = (key: string, values?: Values) => {
      const message = lookup(key);
      return message === undefined
        ? fullKey(key)
        : formatIcuMessage(message, values, locale);
    };
    return Object.assign(translate, {
      has: (key: string) => lookup(key) !== undefined,
      raw: (key: string) => resolveMessage(messages, fullKey(key)),
      rich: (
        key: string,
        values: Record<
          string,
          string | number | ((chunks: string) => React.ReactNode)
        > = {}
      ) => {
        const plainValues = Object.fromEntries(
          Object.entries(values).filter(
            (entry): entry is [string, string | number] =>
              typeof entry[1] !== "function"
          )
        );
        const text = translate(key, plainValues);
        const parts: React.ReactNode[] = [];
        let lastIndex = 0;
        for (const match of text.matchAll(/<(\w+)>(.*?)<\/\1>/g)) {
          const render = values[match[1]];
          parts.push(text.slice(lastIndex, match.index));
          parts.push(
            typeof render === "function"
              ? React.createElement(
                  React.Fragment,
                  { key: match.index },
                  render(match[2])
                )
              : match[2]
          );
          lastIndex = (match.index ?? 0) + match[0].length;
        }
        parts.push(text.slice(lastIndex));
        return parts;
      },
    });
  };
  const useTranslations = (namespace?: string) => {
    const cacheKey = namespace ?? "";
    let translator = translators.get(cacheKey);
    if (!translator) {
      translator = buildTranslator(namespace);
      translators.set(cacheKey, translator);
    }
    return translator;
  };
  return {
    useLocale: () => locale,
    useTranslations,
  };
}

export function createMessagesNextIntlMock({
  format = messageOrKey,
  raw = false,
}: {
  format?: MessageFormatter;
  /** Adds t.raw(key), which returns the resolved value as is. */
  raw?: boolean;
} = {}) {
  const IntlContext = React.createContext<{
    locale: string;
    messages: Messages;
  }>({ locale: "en", messages: {} });

  return {
    NextIntlClientProvider: ({
      children,
      locale,
      messages,
    }: {
      children: React.ReactNode;
      locale: string;
      messages: Messages;
    }) =>
      React.createElement(
        IntlContext.Provider,
        { value: { locale, messages } },
        children
      ),
    useLocale: () => React.useContext(IntlContext).locale,
    useTranslations: (namespace: string) => {
      const { locale, messages } = React.useContext(IntlContext);
      const translate = (key: string, values?: Values) => {
        const fullKey = `${namespace}.${key}`;
        const value = resolveMessage(messages, fullKey);
        return format(typeof value === "string" ? value : undefined, values, {
          key: fullKey,
          locale,
        });
      };
      if (!raw) return translate;
      return Object.assign(translate, {
        raw: (key: string) => resolveMessage(messages, `${namespace}.${key}`),
      });
    },
  };
}
