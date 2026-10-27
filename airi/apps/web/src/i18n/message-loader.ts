import { cookies } from "next/headers";
import { DEFAULT_LOCALE, isLocale, type Locale } from "./locales";

type MessageMap = Record<string, unknown>;
type MessageLoader = (locale: Locale) => Promise<{ default: MessageMap }>;

// Template paths, like the feature catalogs below, keep tsc from building
// object types for these large catalogs; callers only read them as MessageMap.
const loadBaseCatalog: MessageLoader = locale =>
  import(`../../messages/${locale}.json`);

const loadScenariosCatalog: MessageLoader = locale =>
  import(`../../messages/scenarios/${locale}/page.json`);

const loadAnalyticsCatalog: MessageLoader = locale =>
  import(`../../messages/analytics/${locale}/page.json`);

const LANDING_PATHS = ["messages/knowledge-base/", "messages/panel/"] as const;

const SETTINGS_PAGES = [
  "layout",
  "team",
  "integrations",
  "api",
  "workspaces",
  "taxonomy",
  "ai-context",
  "ai-agent",
  "airi-language",
  "limits",
  "billing",
  "business-locations",
] as const;

const ROOT_CLIENT_BASE_NAMESPACES = [
  "AddCompanyForm",
  "Auth",
  "AiContextManager",
  "Command",
  "Dialog",
  "EnhancedMarkdownEditor",
  "FinishProfilePage",
  "ForgotPasswordDialog",
  "LandingDemo",
  "LandingPage",
  "LanguageSwitcher",
  "LoginPage",
  "Onboarding",
  "OnboardingProductStep",
  "WhatsAppHistorySync",
  "Pagination",
  "Select",
  "SetWebhookPage",
  "Sheet",
  "Sidebar",
  "TagInput",
] as const;

const PANEL_SHELL_NAMESPACES = [
  "AiriChat",
  "AiriChatProgress",
  "AiriMetaAds",
  "AppSidebar",
  "AppUpdateBanner",
  "PanelError",
  "SiteHeader",
  "NavMain",
  "NavUser",
  ...ROOT_CLIENT_BASE_NAMESPACES,
] as const;

const PANEL_UNSCOPED_SETTINGS_NAMESPACES = {
  // The upgrade route renders the WhatsApp signup button outside settings.
  integrations: ["WhatsAppFlows", "MetaAdsIntegration", "EmbeddedSignupButton"],
  taxonomy: ["IndexedUrlsManager"],
} as const;

const ROOT_CLIENT_BASE_NAMESPACE_KEYS: Partial<
  Record<(typeof ROOT_CLIENT_BASE_NAMESPACES)[number], readonly string[]>
> = {
  AiContextManager: [
    "salesGrowth",
    "customerRetention",
    "competitorAnalysis",
    "productFeedback",
    "serviceQuality",
  ],
};

const ROOT_CLIENT_KNOWLEDGE_BASE_KEYS = ["breadcrumbs", "feedback"] as const;

export async function getLocaleFromCookie(): Promise<Locale> {
  const cookieLocale = (await cookies()).get("NEXT_LOCALE")?.value;
  return cookieLocale && isLocale(cookieLocale) ? cookieLocale : DEFAULT_LOCALE;
}

function isModuleNotFound(error: unknown): boolean {
  const code =
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string"
      ? (error as { code: string }).code
      : "";

  if (code === "MODULE_NOT_FOUND" || code === "ERR_MODULE_NOT_FOUND") {
    return true;
  }

  const msg =
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof (error as { message?: unknown }).message === "string"
      ? (error as { message: string }).message
      : "";

  return (
    LANDING_PATHS.some(p => msg.includes(p)) ||
    msg.includes("messages/analytics/") ||
    msg.includes("messages/scenarios/") ||
    msg.includes("messages/settings/") ||
    msg.includes("messages/conversations/") ||
    msg.includes("messages/templates/") ||
    msg.includes("messages/customers/") ||
    msg.includes("messages/legal/") ||
    msg.includes("messages/marketing/")
  );
}

function pickMessages(
  messages: MessageMap,
  namespaces: readonly string[]
): MessageMap {
  const picked: MessageMap = {};

  for (const namespace of namespaces) {
    if (namespace in messages) {
      const selectedKeys =
        ROOT_CLIENT_BASE_NAMESPACE_KEYS[
          namespace as (typeof ROOT_CLIENT_BASE_NAMESPACES)[number]
        ];
      const namespaceMessages = messages[namespace];

      if (
        selectedKeys &&
        namespaceMessages &&
        typeof namespaceMessages === "object" &&
        !Array.isArray(namespaceMessages)
      ) {
        picked[namespace] = Object.fromEntries(
          selectedKeys.flatMap(key =>
            key in namespaceMessages
              ? [[key, (namespaceMessages as MessageMap)[key]]]
              : []
          )
        );
      } else {
        picked[namespace] = namespaceMessages;
      }
    }
  }

  return picked;
}

function pickNamespaceSubkeys(
  messages: MessageMap,
  namespace: string,
  keys: readonly string[]
): MessageMap {
  const namespaceMessages = messages[namespace];

  if (
    !namespaceMessages ||
    typeof namespaceMessages !== "object" ||
    Array.isArray(namespaceMessages)
  ) {
    return {};
  }

  const picked = Object.fromEntries(
    keys.flatMap(key =>
      key in namespaceMessages
        ? [[key, (namespaceMessages as MessageMap)[key]]]
        : []
    )
  );

  return Object.keys(picked).length > 0 ? { [namespace]: picked } : {};
}

function omitMessages(
  messages: MessageMap,
  namespaces: readonly string[]
): MessageMap {
  return Object.fromEntries(
    Object.entries(messages).filter(
      ([namespace]) => !namespaces.includes(namespace)
    )
  );
}

async function loadBaseMessages(locale: Locale): Promise<MessageMap> {
  return (await loadBaseCatalog(locale)).default;
}

async function loadFromLocaleLoader(
  loader: MessageLoader,
  locale: Locale,
  fallbackToEn = false
): Promise<MessageMap> {
  try {
    return (await loader(locale)).default;
  } catch (error) {
    if (!isModuleNotFound(error)) throw error;
    if (!fallbackToEn || locale === "en") return {};
    return (await loader("en")).default;
  }
}

async function loadFeaturePageMessages(
  feature: string,
  locale: Locale
): Promise<MessageMap> {
  try {
    return (await import(`../../messages/${feature}/${locale}/page.json`))
      .default;
  } catch (error) {
    if (!isModuleNotFound(error)) throw error;
    return {};
  }
}

async function loadSettingsPageMessages(
  page: string,
  locale: Locale
): Promise<MessageMap> {
  try {
    return (await import(`../../messages/settings/${page}/${locale}/page.json`))
      .default;
  } catch (error) {
    if (!isModuleNotFound(error)) throw error;

    if (locale === "en") return {};

    return (await import(`../../messages/settings/${page}/en/page.json`))
      .default;
  }
}

async function loadSettingsMessages(locale: Locale): Promise<MessageMap> {
  const results = await Promise.all(
    SETTINGS_PAGES.map(page => loadSettingsPageMessages(page, locale))
  );
  return Object.assign({}, ...results);
}

async function loadKnowledgeBaseMessages(locale: Locale): Promise<MessageMap> {
  return loadFeaturePageMessages("knowledge-base", locale);
}

async function loadPanelMessages(locale: Locale): Promise<MessageMap> {
  return loadFeaturePageMessages("panel", locale);
}

async function loadScenariosMessages(locale: Locale): Promise<MessageMap> {
  return loadFromLocaleLoader(loadScenariosCatalog, locale, true);
}

async function loadConversationsMessages(locale: Locale): Promise<MessageMap> {
  try {
    return (await import(`../../messages/conversations/${locale}/page.json`))
      .default;
  } catch (error) {
    if (!isModuleNotFound(error)) throw error;

    if (locale === "en") return {};

    return (await import("../../messages/conversations/en/page.json")).default;
  }
}

async function loadAnalyticsMessages(locale: Locale): Promise<MessageMap> {
  return loadFromLocaleLoader(loadAnalyticsCatalog, locale);
}

async function loadTemplatesMessages(locale: Locale): Promise<MessageMap> {
  return loadFeaturePageMessages("templates", locale);
}

async function loadCustomersMessages(locale: Locale): Promise<MessageMap> {
  try {
    return (await import(`../../messages/customers/${locale}/page.json`))
      .default;
  } catch (error) {
    if (!isModuleNotFound(error)) throw error;

    if (locale === "en") return {};

    return (await import("../../messages/customers/en/page.json")).default;
  }
}

/**
 * Public legal pages render on the server only, so their copy stays out of
 * the app-wide and root client catalogs.
 */
export async function loadRefundPolicyMessages(
  locale: Locale
): Promise<MessageMap> {
  try {
    return (await import(`../../messages/legal/refunds/${locale}/page.json`))
      .default;
  } catch (error) {
    if (!isModuleNotFound(error)) throw error;

    if (locale === "en") return {};

    return (await import("../../messages/legal/refunds/en/page.json")).default;
  }
}

/**
 * Public product pages (campaign delivery, Meta Ads MCP, Airi MCP) render on
 * the server only, so their copy stays out of the app-wide and root client
 * catalogs.
 */
export async function loadMarketingPageMessages(
  locale: Locale
): Promise<MessageMap> {
  try {
    return (await import(`../../messages/marketing/${locale}/page.json`))
      .default;
  } catch (error) {
    if (!isModuleNotFound(error)) throw error;

    if (locale === "en") return {};

    return (await import("../../messages/marketing/en/page.json")).default;
  }
}

export async function loadAllMessages(locale: Locale): Promise<MessageMap> {
  const [
    baseMessages,
    knowledgeBaseMessages,
    scenariosMessages,
    settingsMessages,
    conversationsMessages,
    analyticsMessages,
    templatesMessages,
    panelMessages,
    customersMessages,
  ] = await Promise.all([
    loadBaseMessages(locale),
    loadKnowledgeBaseMessages(locale),
    loadScenariosMessages(locale),
    loadSettingsMessages(locale),
    loadConversationsMessages(locale),
    loadAnalyticsMessages(locale),
    loadTemplatesMessages(locale),
    loadPanelMessages(locale),
    loadCustomersMessages(locale),
  ]);

  return {
    ...baseMessages,
    ...knowledgeBaseMessages,
    ...scenariosMessages,
    ...settingsMessages,
    ...conversationsMessages,
    ...analyticsMessages,
    ...templatesMessages,
    ...panelMessages,
    ...customersMessages,
  };
}

export async function loadRootClientMessages(
  locale: Locale
): Promise<MessageMap> {
  const [baseMessages, settingsIntegrationsMessages, knowledgeBaseMessages] =
    await Promise.all([
      loadBaseMessages(locale),
      loadSettingsPageMessages("integrations", locale),
      loadKnowledgeBaseMessages(locale),
    ]);

  return {
    ...pickMessages(baseMessages, ROOT_CLIENT_BASE_NAMESPACES),
    ...settingsIntegrationsMessages,
    ...pickNamespaceSubkeys(
      knowledgeBaseMessages,
      "KnowledgeBase",
      ROOT_CLIENT_KNOWLEDGE_BASE_KEYS
    ),
  };
}

export async function loadPanelClientMessages(
  locale: Locale
): Promise<MessageMap> {
  const [
    baseMessages,
    workspaceMessages,
    settingsIntegrationsMessages,
    settingsTaxonomyMessages,
    panelMessages,
    knowledgeBaseMessages,
  ] = await Promise.all([
    loadBaseMessages(locale),
    loadSettingsPageMessages("workspaces", locale),
    loadSettingsPageMessages("integrations", locale),
    loadSettingsPageMessages("taxonomy", locale),
    loadPanelMessages(locale),
    loadKnowledgeBaseMessages(locale),
  ]);

  return {
    ...pickMessages(baseMessages, PANEL_SHELL_NAMESPACES),
    ...pickMessages(workspaceMessages, ["Workspaces"]),
    ...pickMessages(
      settingsIntegrationsMessages,
      PANEL_UNSCOPED_SETTINGS_NAMESPACES.integrations
    ),
    ...pickMessages(
      settingsTaxonomyMessages,
      PANEL_UNSCOPED_SETTINGS_NAMESPACES.taxonomy
    ),
    ...panelMessages,
    ...pickMessages(knowledgeBaseMessages, ["KnowledgeBase"]),
  };
}

export async function loadPanelFeatureMessages(
  locale: Locale
): Promise<MessageMap> {
  return loadPanelClientMessages(locale);
}

export async function loadScenariosClientMessages(
  locale: Locale
): Promise<MessageMap> {
  const [
    scenariosMessages,
    templatesMessages,
    analyticsMessages,
    baseMessages,
  ] = await Promise.all([
    loadScenariosMessages(locale),
    loadTemplatesMessages(locale),
    loadAnalyticsMessages(locale),
    loadFromLocaleLoader(loadBaseCatalog, locale),
  ]);

  return {
    // Only taxonomy settings reads InternalLabelsManager, and only the bulk
    // campaigns page (with its own catalog) reads CampaignHistory, so neither
    // rides along with every Scenarios render.
    ...omitMessages(scenariosMessages, ["InternalLabelsManager"]),
    ...pickMessages(baseMessages, ["CustomerBehavior"]),
    ...templatesMessages,
    ...pickMessages(analyticsMessages, [
      "CampaignRecipientPicker",
      "CampaignDispatchPlanCard",
      "CsvUpload",
    ]),
  };
}

export async function loadWhatsAppTemplatesClientMessages(
  locale: Locale
): Promise<MessageMap> {
  return loadScenariosClientMessages(locale);
}

export async function loadWhatsAppWelcomeSequencesClientMessages(
  locale: Locale
): Promise<MessageMap> {
  const [panelMessages, scenarioMessages] = await Promise.all([
    loadPanelMessages(locale),
    loadScenariosClientMessages(locale),
  ]);

  return {
    ...panelMessages,
    ...scenarioMessages,
  };
}

export async function loadAnalyticsClientMessages(
  locale: Locale
): Promise<MessageMap> {
  return loadAnalyticsMessages(locale);
}

export async function loadSettingsClientMessages(
  locale: Locale
): Promise<MessageMap> {
  return loadSettingsMessages(locale);
}

export async function loadConversationsClientMessages(
  locale: Locale
): Promise<MessageMap> {
  const [messages, baseMessages] = await Promise.all([
    loadConversationsMessages(locale),
    loadFromLocaleLoader(loadBaseCatalog, locale),
  ]);
  return { ...messages, ...pickMessages(baseMessages, ["CustomerBehavior"]) };
}

export async function loadCustomersClientMessages(
  locale: Locale
): Promise<MessageMap> {
  return loadCustomersMessages(locale);
}
