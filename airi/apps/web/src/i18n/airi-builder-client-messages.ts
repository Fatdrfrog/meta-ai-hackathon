import { DEFAULT_LOCALE, isLocale, type Locale } from "./locales";

type MessageMap = Record<string, unknown>;
type MessageLoader = (locale: Locale) => Promise<{ default: MessageMap }>;

// Client-side twins of the server catalog loaders in message-loader.ts (that
// module reads cookies, so the browser cannot import it). Template paths give
// one chunk per locale, downloaded only when a builder needs it.
const loadScenariosCatalog: MessageLoader = locale =>
  import(`../../messages/scenarios/${locale}/page.json`);

const loadTemplatesCatalog: MessageLoader = locale =>
  import(`../../messages/templates/${locale}/page.json`);

/** The namespaces the WhatsApp template and Flow builders translate with. */
export const AIRI_BUILDER_MESSAGE_NAMESPACES = ["Scenarios", "templates"];

const loadedMessages = new Map<Locale, MessageMap>();
const pendingMessages = new Map<Locale, Promise<MessageMap>>();

export function resolveAiriBuilderMessagesLocale(locale: string): Locale {
  return isLocale(locale) ? locale : DEFAULT_LOCALE;
}

/** Catalogs already downloaded for this locale, so a render need not wait. */
export function getLoadedAiriBuilderClientMessages(
  locale: Locale
): MessageMap | null {
  return loadedMessages.get(locale) ?? null;
}

/**
 * The Scenarios and templates catalogs, as loadScenariosClientMessages gives
 * the /airi page, for builders rendered where the page catalogs are absent
 * (the Airi drawer). A failed download is forgotten so a retry downloads it
 * again.
 */
export function loadAiriBuilderClientMessages(
  locale: Locale
): Promise<MessageMap> {
  const pending = pendingMessages.get(locale);
  if (pending) return pending;
  const request = Promise.all([
    loadScenariosCatalog(locale),
    loadTemplatesCatalog(locale),
  ]).then(([scenarios, templates]) => {
    const messages: MessageMap = {
      Scenarios: scenarios.default.Scenarios,
      templates: templates.default.templates,
    };
    loadedMessages.set(locale, messages);
    return messages;
  });
  pendingMessages.set(locale, request);
  void request.catch(() => {
    if (pendingMessages.get(locale) === request) pendingMessages.delete(locale);
  });
  return request;
}
