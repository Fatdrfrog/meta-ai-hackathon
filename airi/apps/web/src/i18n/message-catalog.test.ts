import fs from "fs";
import path from "path";
import { execFileSync } from "node:child_process";
import {
  loadAnalyticsClientMessages,
  loadConversationsClientMessages,
  loadPanelClientMessages,
  loadRootClientMessages,
  loadScenariosClientMessages,
  loadSettingsClientMessages,
  loadWhatsAppTemplatesClientMessages,
  loadWhatsAppWelcomeSequencesClientMessages,
} from "./message-loader";

const LOCALES = ["en", "kz", "ru"] as const;
type Locale = (typeof LOCALES)[number];
type JsonObject = Record<string, unknown>;

const SETUP_PRODUCT_REQUIRED_KEYS = [
  "websiteInputLabel",
  "removeWebsiteLabel",
  "trainingOptional",
  "trainingLoading",
  "trainingLoadError",
  "trainingLimitError",
  "tryAgain",
  "trainingBackgroundTitle",
  "trainingBackgroundDescription",
  "checkAgain",
  "statusFailedNoContent",
  "statusFailedTimeout",
  "statusFailedGeneric",
  "retrySource",
] as const;

const SETUP_INTEGRATIONS_CTA: Record<Locale, string> = {
  en: "Continue to integrations",
  kz: "Интеграцияларға өту",
  ru: "Перейти к интеграциям",
};

const SETUP_TRAINING_LIMIT_ERROR: Record<Locale, string> = {
  en: "You've reached the website and Instagram source limit. Remove a source in Integrations, then try again.",
  kz: "Сайт пен Instagram дереккөздерінің шегіне жеттіңіз. Интеграциялардан бір дереккөзді жойып, қайталап көріңіз.",
  ru: "Достигнут лимит источников сайтов и Instagram. Удалите источник в Интеграциях и повторите попытку.",
};

const SETUP_SOURCE_GUIDANCE: Record<
  Locale,
  { trainingNeedsSource: string; testChatLockedHelp: string }
> = {
  en: {
    trainingNeedsSource:
      "Add a website or select a connected channel. Training is optional, and you can connect sources later in Integrations.",
    testChatLockedHelp:
      "Add a website, then click Start training before testing.",
  },
  kz: {
    trainingNeedsSource:
      "Сайт қосыңыз немесе қосылған арнаны таңдаңыз. Оқыту міндетті емес, дереккөздерді кейін Интеграцияларда қоса аласыз.",
    testChatLockedHelp:
      "Airi-ді тексермес бұрын дереккөз қосып, оқытуды бастаңыз.",
  },
  ru: {
    trainingNeedsSource:
      "Добавьте сайт или выберите подключённый канал. Обучение можно пропустить и подключить источники позже в Интеграциях.",
    testChatLockedHelp:
      "Добавьте источник и начните обучение, прежде чем проверять Airi.",
  },
};

const MESSAGES_ROOT = path.resolve(__dirname, "../../messages");
const SRC_ROOT = path.resolve(__dirname, "..");

const AI_AGENT_SETTINGS_REQUIRED_STRING_KEYS = [
  "loading",
  "agentSectionIdentity",
  "agentSectionIdentityDesc",
  "agentDisplayName",
  "agentDisplayNamePlaceholder",
  "agentTone",
  "agentTonePlaceholder",
  "agentTopicRestrictions",
  "agentTopicRestrictionsPlaceholder",
  "agentTopicRestrictionsHint",
  "agentSectionInstructions",
  "agentSectionInstructionsDesc",
  "agentCustomInstructions",
  "agentCustomInstructionsPlaceholder",
  "agentCustomInstructionsCount",
  "elevenlabsAgentIdLabel",
  "elevenlabsAgentIdPlaceholder",
  "elevenlabsAgentIdHint",
  "agentSectionBehavior",
  "agentSectionBehaviorDesc",
  "agentGreetingBehavior",
  "agentGreetingAuto",
  "agentGreetingAutoDesc",
  "agentGreetingBriefOnly",
  "agentGreetingBriefOnlyDesc",
  "agentGreetingDisabled",
  "agentGreetingDisabledDesc",
  "agentEscalationBehavior",
  "agentEscalationSuggestHuman",
  "agentEscalationSuggestHumanDesc",
  "agentEscalationAutoHandoff",
  "agentEscalationAutoHandoffDesc",
  "agentEscalationNever",
  "agentEscalationNeverDesc",
  "agentResponseStyle",
  "agentResponseConcise",
  "agentResponseConciseDesc",
  "agentResponseBalanced",
  "agentResponseBalancedDesc",
  "agentResponseDetailed",
  "agentResponseDetailedDesc",
  "agentSectionRetrieval",
  "agentSectionRetrievalDesc",
  "agentRetrievalQueryMode",
  "agentRetrievalAdaptive",
  "agentRetrievalLastMessageOnly",
  "agentIncludeConversation",
  "agentSendKbLinks",
  "agentLanguageBias",
  "agentLanguageBiasNone",
  "agentLanguageBiasKazakh",
  "agentLanguageBiasRussian",
  "agentLanguageBiasUzbek",
  "agentSectionChannel",
  "agentSectionChannelDesc",
  "agentChannelWhatsApp",
  "agentChannelTelegram",
  "agentChannelInstagram",
  "agentChannelWebWidget",
  "agentChannelPlaceholder",
  "agentSectionActions",
  "agentSectionActionsDesc",
  "agentActionName",
  "agentActionNamePlaceholder",
  "agentActionWhen",
  "agentActionWhenPlaceholder",
  "agentAddAction",
  "agentRemoveAction",
  "agentSave",
  "agentSaving",
  "agentSaveSuccess",
  "agentSaveFailed",
] as const;

const SCENARIO_SHELL_REQUIRED_STRING_KEYS = [
  "loading",
  "scenarioOnboardingDemoName",
  "scenarioEmptyTitle",
  "scenarioEmptyDescription",
  "scenarioOnboardingCreatingTitle",
  "scenarioOnboardingCreatingDescription",
  "scenarioOnboardingFailedTitle",
  "scenarioOnboardingFailedDescription",
  "scenarioOnboardingCreateDemo",
  "scenarioOnboardingConnectSource",
  "scenarioOnboardingCalloutTriggerTitle",
  "scenarioOnboardingCalloutTriggerBody",
  "scenarioOnboardingCalloutContextTitle",
  "scenarioOnboardingCalloutContextBody",
  "scenarioOnboardingCalloutActionTitle",
  "scenarioOnboardingCalloutActionBody",
] as const;

const SCENARIO_SETTINGS_REQUIRED_STRING_KEYS = [
  "scenarioSettingsFor",
  "scenarioSettingsHint",
  "scenarioEntryPolicy",
  "scenarioEntryOncePerConversation",
  "scenarioEntryRepeatable",
  "scenarioEntryPolicyHint",
] as const;

const SCENARIO_TRIGGER_EDITOR_REQUIRED_STRING_KEYS = [
  "triggerChannelWebChat",
  "triggerMetaReferralLabel",
  "triggerMetaAnyInstagramAd",
  "triggerMetaCampaignsGroup",
  "triggerMetaAdSetsGroup",
  "triggerMetaAdsGroup",
  "triggerMetaConnectMarketingApi",
  "triggerMetaNoCampaigns",
  "triggerMetaNoAdSets",
  "triggerMetaNoInstagramAds",
  "triggerMetaFallbackCampaign",
  "triggerMetaFallbackAdSet",
  "triggerMetaFallbackAd",
  "triggerMetaConversationCount",
  "triggerMetaAdCount",
  "triggerMetaLastSeen",
  "triggerMetaCampaignMetadata",
  "triggerMetaAdSetMetadata",
  "triggerMetaSourceIdMetadata",
  "triggerLinkedEntryTitle",
  "triggerLinkedEntryDescription",
] as const;

const SCENARIO_ADJACENT_ROOT_NAMESPACES = ["CsvUpload"] as const;

const SCENARIO_BULK_DISPATCH_REQUIRED_KEYS = [
  "bulkNodePauseCampaign",
  "bulkNodePausingCampaign",
  "bulkNodeResumeCampaign",
  "bulkNodeResumingCampaign",
  "bulkNodePausedCampaign",
  "bulkNodePauseFailed",
  "overflowQueue.title",
  "overflowQueue.description",
  "overflowQueue.confirm",
  "overflowQueue.cancel",
] as const;

const CAMPAIGN_HISTORY_PAUSE_REQUIRED_KEYS = [
  "operations.status.paused",
  "operations.pause.action",
  "operations.pause.pending",
  "operations.pause.success",
  "operations.pause.error",
  "operations.pause.resume",
  "operations.pause.resuming",
  "operations.pause.resumeSuccess",
  "operations.pause.resumeError",
  "operations.remaining",
] as const;

const CAMPAIGN_BUILDER_PAUSE_REQUIRED_KEYS = [
  "pauseDispatch",
  "pausingDispatch",
  "resumeDispatch",
  "resumingDispatch",
  "pausedDispatch",
  "dispatchPauseFailed",
  "overflowQueue.title",
  "overflowQueue.description",
  "overflowQueue.confirm",
  "overflowQueue.cancel",
] as const;

type MessageBundle = {
  id: string;
  files: Partial<Record<Locale, string>>;
};

function readJson(file: string): JsonObject {
  return JSON.parse(fs.readFileSync(file, "utf8")) as JsonObject;
}

function collectLeafPaths(value: unknown, prefix: string[] = []): string[] {
  if (typeof value === "string") {
    return [prefix.join(".")];
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }

  return Object.entries(value as JsonObject).flatMap(([key, child]) =>
    collectLeafPaths(child, [...prefix, key])
  );
}

function flattenLeaves(
  value: unknown,
  prefix: string[] = []
): Array<[string, string]> {
  if (typeof value === "string") {
    return [[prefix.join("."), value]];
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }

  return Object.entries(value as JsonObject).flatMap(([key, child]) =>
    flattenLeaves(child, [...prefix, key])
  );
}

function listFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      return listFiles(fullPath);
    }

    return fullPath;
  });
}

function collectMessageBundles(): MessageBundle[] {
  const bundles = new Map<string, MessageBundle>();
  bundles.set("root", {
    id: "root",
    files: Object.fromEntries(
      LOCALES.map(locale => [
        locale,
        path.join(MESSAGES_ROOT, `${locale}.json`),
      ])
    ),
  });

  for (const file of listFiles(MESSAGES_ROOT)) {
    const relativePath = path.relative(MESSAGES_ROOT, file).replace(/\\/g, "/");
    const match = relativePath.match(/^(.*)\/(en|kz|ru)\/page\.json$/);

    if (!match) {
      continue;
    }

    const [, id, locale] = match as [string, string, Locale];
    const bundle = bundles.get(id) ?? { id, files: {} };
    bundle.files[locale] = file;
    bundles.set(id, bundle);
  }

  return [...bundles.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function getValue(messages: JsonObject, leafPath: string): unknown {
  return leafPath
    .split(".")
    .reduce<unknown>(
      (value, key) =>
        value && typeof value === "object"
          ? (value as JsonObject)[key]
          : undefined,
      messages
    );
}

const TRANSLATION_ALLOWLIST_VALUES = new Set([
  "",
  "Airi",
  "API",
  "Audio",
  "Bot",
  "CNAME",
  "CSAT",
  "Dashboard",
  "Email",
  "Facebook",
  "Facebook Business Login",
  "Facebook Business Manager",
  "Format",
  "Instagram",
  "LLM",
  "Meta",
  "Meta Tech Provider",
  "Onboarding",
  "RAG",
  "Telegram",
  "TXT",
  "URL",
  "WhatsApp",
  "WhatsApp Business",
  "Flow",
  "WhatsApp Flow",
]);

const TECHNICAL_KEY_PATTERN =
  /(^|\.)(href|url|uri|path|id|slug|code|currency|variant|type|icon|logo|route|mode)$/i;
const ENGLISH_TEXT_PATTERN =
  /\b(the|and|or|to|from|with|without|your|you|this|that|these|those|when|where|what|which|before|after|during|failed|missing|create|copy|paste|select|choose|show|open|sync|review|queue|business|campaign|message|conversation|customer|workspace|template|record|tokens|calls|items|settings|required|enabled|disabled|success|error|warning|manual|approval|recovery|confidence|fallback|integration|guide|attach|upload|release|unavailable|finish|verification|provider|domain|period|tracked|latency|total|rate|issues|follow|projection|taxonomy|remove|add|screen|flow|button)\b/i;
const MOJIBAKE_TEXT_PATTERN =
  /(?:\u0432\u0402|\u0440\u045f|\u0432[\u045a\u00ad]|\u0422\u0459|\u0413\u2014|\uFFFD)/;
const CORRUPTED_TRANSLATION_PATTERN = /(?:\?{3,}|\uFFFD)/;

function isTechnicalValue(value: string): boolean {
  const trimmed = value.trim();

  if (/^[{[]/.test(trimmed)) {
    try {
      JSON.parse(trimmed);
      return true;
    } catch {
      // Fall through to the lighter technical-value checks below.
    }
  }

  return (
    /^https?:\/\//i.test(trimmed) ||
    /^mailto:/i.test(trimmed) ||
    /^tel:/i.test(trimmed) ||
    /^[/#]/.test(trimmed) ||
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed) ||
    /^(?:\{[A-Za-z0-9_]+\}|[\s/.,:;()_-])+$/.test(trimmed) ||
    /^[{}[\]":,_\d\s/.-]+$/.test(trimmed) ||
    /^[A-Z0-9_./:-]+$/.test(trimmed)
  );
}

function isLikelyUntranslatedCopy(key: string, value: string): boolean {
  if (
    TRANSLATION_ALLOWLIST_VALUES.has(value.trim()) ||
    TECHNICAL_KEY_PATTERN.test(key) ||
    isTechnicalValue(value)
  ) {
    return false;
  }

  return ENGLISH_TEXT_PATTERN.test(value);
}

function hasMojibake(value: string): boolean {
  return MOJIBAKE_TEXT_PATTERN.test(value);
}

function listSourceFiles(): string[] {
  return listFiles(SRC_ROOT).filter(file => /\.(ts|tsx)$/.test(file));
}

function hasRuntimeNamespaceReference(
  namespace: string,
  sources: string[]
): boolean {
  const escaped = namespace.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const nextIntlReference = new RegExp(
    `(useTranslations|getTranslations|createTranslator)\\(\\s*(?:\\{\\s*namespace:\\s*)?["']${escaped}(?:[."']|$)`
  );
  const directMessageReference = new RegExp(`\\.${escaped}\\b`);

  return sources.some(source => {
    const text = fs.readFileSync(source, "utf8");
    return nextIntlReference.test(text) || directMessageReference.test(text);
  });
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function collectEnhancedMarkdownEditorKeyUsages(
  sources: string[]
): Array<{ key: string; source: string }> {
  const usages: Array<{ key: string; source: string }> = [];
  const translationHookPattern =
    /\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*useTranslations\(\s*["']EnhancedMarkdownEditor["']\s*\)/g;

  for (const source of sources) {
    const text = fs.readFileSync(source, "utf8");
    let hookMatch: RegExpExecArray | null;

    while ((hookMatch = translationHookPattern.exec(text))) {
      const identifier = hookMatch[1];
      const textAfterHook = text.slice(hookMatch.index);
      const keyPattern = new RegExp(
        `\\b${escapeRegex(identifier)}(?:\\?\\.)?\\(\\s*["']([A-Za-z0-9_.-]+)["']`,
        "g"
      );
      let keyMatch: RegExpExecArray | null;

      while ((keyMatch = keyPattern.exec(textAfterHook))) {
        usages.push({
          key: keyMatch[1],
          source: path.relative(SRC_ROOT, source).replace(/\\/g, "/"),
        });
      }
    }

    if (
      !source.includes(".test.") &&
      /[\\/]src[\\/]((components[\\/]kb)|(lib[\\/]kb))[\\/]/.test(source)
    ) {
      const labelKeyPattern = /\blabelKey:\s*["']([A-Za-z0-9_.-]+)["']/g;
      let labelKeyMatch: RegExpExecArray | null;

      while ((labelKeyMatch = labelKeyPattern.exec(text))) {
        usages.push({
          key: labelKeyMatch[1],
          source: path.relative(SRC_ROOT, source).replace(/\\/g, "/"),
        });
      }
    }
  }

  return usages;
}

describe("message catalog", () => {
  it("ships catalogs only for supported locales", () => {
    const catalogLocales = new Set(
      listFiles(MESSAGES_ROOT).map(
        file =>
          path
            .relative(MESSAGES_ROOT, file)
            .replace(/\\/g, "/")
            .match(/(?:^|\/)([a-z]{2})(?:\/page)?\.json$/)?.[1]
      )
    );

    expect([...catalogLocales].sort()).toEqual([...LOCALES].sort());
  });

  it("keeps every message bundle aligned across supported locales", () => {
    const failures: string[] = [];

    for (const bundle of collectMessageBundles()) {
      const englishFile = bundle.files.en;
      expect(englishFile).toBeDefined();

      const expectedPaths = collectLeafPaths(readJson(englishFile!)).sort();

      for (const locale of LOCALES) {
        const localeFile = bundle.files[locale];

        if (!localeFile) {
          failures.push(`${bundle.id}:${locale} is missing page.json`);
          continue;
        }

        const localePaths = collectLeafPaths(readJson(localeFile)).sort();
        const missing = expectedPaths.filter(
          path => !localePaths.includes(path)
        );
        const extra = localePaths.filter(path => !expectedPaths.includes(path));

        if (missing.length > 0 || extra.length > 0) {
          failures.push(
            `${bundle.id}:${locale} missing=[${missing.join(", ")}] extra=[${extra.join(", ")}]`
          );
        }
      }
    }

    expect(failures).toEqual([]);
  });

  it("does not leave obvious English copies in non-English locales", () => {
    const untranslatedCopies: string[] = [];

    for (const bundle of collectMessageBundles()) {
      const englishFile = bundle.files.en;
      expect(englishFile).toBeDefined();

      const englishMessages = readJson(englishFile!);
      const englishLeaves = flattenLeaves(englishMessages);

      for (const locale of LOCALES.filter(locale => locale !== "en")) {
        const localeFile = bundle.files[locale];
        expect(localeFile).toBeDefined();

        const localeMessages = readJson(localeFile!);

        for (const [leafPath, englishValue] of englishLeaves) {
          const localeValue = getValue(localeMessages, leafPath);

          if (
            localeValue === englishValue &&
            isLikelyUntranslatedCopy(leafPath, englishValue)
          ) {
            untranslatedCopies.push(`${bundle.id}:${locale}:${leafPath}`);
          }
        }
      }
    }

    expect(untranslatedCopies).toEqual([]);
  });

  it("does not keep mojibake in message values", () => {
    const failures: string[] = [];

    for (const bundle of collectMessageBundles()) {
      for (const locale of LOCALES) {
        const localeFile = bundle.files[locale];
        expect(localeFile).toBeDefined();

        for (const [leafPath, value] of flattenLeaves(readJson(localeFile!))) {
          if (hasMojibake(value)) {
            failures.push(`${bundle.id}:${locale}:${leafPath}=${value}`);
          }
        }
      }
    }

    expect(failures).toEqual([]);
  });

  it("keeps setup product copy complete, localized, and free of placeholder corruption", () => {
    for (const locale of LOCALES) {
      const messages = readJson(path.join(MESSAGES_ROOT, `${locale}.json`));
      const company = messages.AddCompanyForm as JsonObject;
      const product = messages.OnboardingProductStep as JsonObject;

      expect(company.continueToIntegrations).toBe(
        SETUP_INTEGRATIONS_CTA[locale]
      );
      expect(company).not.toHaveProperty("skipOptionalStep");
      expect(company).not.toHaveProperty("finishSetupButton");

      for (const key of SETUP_PRODUCT_REQUIRED_KEYS) {
        expect(product[key]).toEqual(expect.any(String));
        expect((product[key] as string).trim()).not.toBe("");
      }

      expect(product.trainingNeedsSource).toBe(
        SETUP_SOURCE_GUIDANCE[locale].trainingNeedsSource
      );
      expect(product.testChatLockedHelp).toBe(
        SETUP_SOURCE_GUIDANCE[locale].testChatLockedHelp
      );
      expect(product.trainingLimitError).toBe(
        SETUP_TRAINING_LIMIT_ERROR[locale]
      );
      expect(JSON.stringify(company)).not.toMatch(/\?{3,}/);
      expect(JSON.stringify(product)).not.toMatch(/\?{3,}/);
    }
  });

  it("does not keep mojibake in TypeScript source", () => {
    const failures = listSourceFiles().filter(file =>
      hasMojibake(fs.readFileSync(file, "utf8"))
    );

    expect(
      failures.map(file => path.relative(SRC_ROOT, file).replace(/\\/g, "/"))
    ).toEqual([]);
  });

  it("keeps campaign builder personalization helper messages ICU-safe", () => {
    const failures: string[] = [];
    const bundles = [
      {
        id: "analytics",
        files: Object.fromEntries(
          LOCALES.map(locale => [
            locale,
            path.join(MESSAGES_ROOT, "analytics", locale, "page.json"),
          ])
        ) as Record<Locale, string>,
      },
    ];

    for (const bundle of bundles) {
      for (const locale of LOCALES) {
        const messages = readJson(bundle.files[locale]);
        const builderMessages = messages.MultiChannelCampaignBuilder;

        if (!builderMessages || typeof builderMessages !== "object") {
          failures.push(`${bundle.id}:${locale}:missing builder namespace`);
          continue;
        }

        const placeholder = (builderMessages as JsonObject)
          .messageTextPlaceholder;
        const characterLimit = (builderMessages as JsonObject).charactersLimit;

        if (
          typeof placeholder !== "string" ||
          placeholder.includes("{{") ||
          !placeholder.includes("{exampleName}") ||
          !placeholder.includes("{exampleCompany}")
        ) {
          failures.push(
            `${bundle.id}:${locale}:messageTextPlaceholder=${placeholder}`
          );
        }

        if (
          typeof characterLimit !== "string" ||
          characterLimit.includes("{{") ||
          !characterLimit.includes("{count}") ||
          !characterLimit.includes("{exampleVariable}")
        ) {
          failures.push(
            `${bundle.id}:${locale}:charactersLimit=${characterLimit}`
          );
        }
      }
    }

    expect(failures).toEqual([]);
  });

  it.each([
    [1, "Free: остался 1 получатель из 10"],
    [2, "Free: осталось 2 получателя из 10"],
    [5, "Free: осталось 5 получателей из 10"],
  ])(
    "formats Russian remaining bulk recipient quota for %i",
    async (remaining, expected) => {
      const catalogs = [
        [
          await loadAnalyticsClientMessages("ru"),
          "MultiChannelCampaignBuilder",
        ],
        [await loadScenariosClientMessages("ru"), "Scenarios"],
      ] as const;

      for (const [messages, namespace] of catalogs) {
        const quota = getValue(
          messages,
          `${namespace}.bulkLimit.freeRemaining`
        );
        expect(typeof quota).toBe("string");
        // next-intl is ESM-only; exercise its real formatter outside Jest's CJS loader.
        const formatted = execFileSync(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            `
        import { readFileSync } from "node:fs";
        import { createTranslator } from "next-intl";
        const { quota, remaining, limit } = JSON.parse(readFileSync(0, "utf8"));
        const translate = createTranslator({ locale: "ru", messages: { quota } });
        process.stdout.write(translate("quota", { remaining, limit }));
      `,
          ],
          {
            cwd: path.resolve(__dirname, "../.."),
            input: JSON.stringify({ quota, remaining, limit: 10 }),
            encoding: "utf8",
            windowsHide: true,
          }
        );
        expect(formatted).toBe(expected);
      }
    }
  );

  it("keeps bulk campaign quota and failure messages in client catalogs", async () => {
    const failures: string[] = [];
    const requiredBulkLimitKeys = [
      "freeRemaining",
      "freeTrimmed",
      "freeExhausted",
      "proUnlimited",
    ] as const;
    const requiredFailureSummaryKeys = [
      "allFailed",
      "someFailed",
      "errorCode",
    ] as const;

    for (const locale of LOCALES) {
      const analyticsMessages = await loadAnalyticsClientMessages(locale);
      const analyticsBuilder = analyticsMessages.MultiChannelCampaignBuilder;
      const analyticsHistory = analyticsMessages.CampaignHistory;

      if (!analyticsBuilder || typeof analyticsBuilder !== "object") {
        failures.push(
          `${locale}:MultiChannelCampaignBuilder namespace missing`
        );
      } else {
        const bulkLimit = (analyticsBuilder as JsonObject).bulkLimit;
        if (!bulkLimit || typeof bulkLimit !== "object") {
          failures.push(
            `${locale}:MultiChannelCampaignBuilder.bulkLimit missing`
          );
        } else {
          for (const key of requiredBulkLimitKeys) {
            const value = (bulkLimit as JsonObject)[key];
            if (typeof value !== "string" || !value.trim()) {
              failures.push(
                `${locale}:MultiChannelCampaignBuilder.bulkLimit.${key} missing`
              );
            }
          }
        }
      }

      if (!analyticsHistory || typeof analyticsHistory !== "object") {
        failures.push(`${locale}:CampaignHistory namespace missing`);
      } else {
        const failureSummary = (analyticsHistory as JsonObject).failureSummary;
        if (!failureSummary || typeof failureSummary !== "object") {
          failures.push(`${locale}:CampaignHistory.failureSummary missing`);
        } else {
          for (const key of requiredFailureSummaryKeys) {
            const value = (failureSummary as JsonObject)[key];
            if (typeof value !== "string" || !value.trim()) {
              failures.push(
                `${locale}:CampaignHistory.failureSummary.${key} missing`
              );
            }
          }
        }
      }

      const scenarioMessages = await loadScenariosClientMessages(locale);
      const scenarios = scenarioMessages.Scenarios;
      const scenarioHistory = scenarioMessages.CampaignHistory;

      if (!scenarios || typeof scenarios !== "object") {
        failures.push(`${locale}:Scenarios namespace missing`);
      } else {
        const bulkLimit = (scenarios as JsonObject).bulkLimit;
        if (!bulkLimit || typeof bulkLimit !== "object") {
          failures.push(`${locale}:Scenarios.bulkLimit missing`);
        } else {
          for (const key of requiredBulkLimitKeys) {
            const value = (bulkLimit as JsonObject)[key];
            if (typeof value !== "string" || !value.trim()) {
              failures.push(`${locale}:Scenarios.bulkLimit.${key} missing`);
            }
          }
        }
      }

      // Campaign history renders only on the bulk campaigns page, whose
      // analytics catalog carries it (checked above).
      if (scenarioHistory !== undefined) {
        failures.push(
          `${locale}:Scenarios client ships the unused CampaignHistory`
        );
      }
    }

    expect(failures).toEqual([]);
  });

  it("keeps widget analytics translations in the analytics client catalog", async () => {
    const failures: string[] = [];
    const requiredLeafKeys = [
      "title",
      "subtitle",
      "refresh",
      "privateAnalytics",
      "websiteUnavailable.title",
      "websiteUnavailable.description",
      "websiteUnavailable.metric",
      "stats.pageviews",
      "stats.sessions",
      "stats.conversations",
      "stats.chatStartRate",
      "charts.pageviewsTitle",
      "charts.noTimeSeriesData",
      "source.title",
      "source.installed",
      "source.position",
      "source.airiEnabled",
      "source.helpEnabled",
      "source.autoOpen",
      "source.domains",
      "pages.title",
      "privacyBanner.title",
    ] as const;

    for (const locale of LOCALES) {
      const analyticsMessages = await loadAnalyticsClientMessages(locale);
      const widgetAnalytics = analyticsMessages.WidgetAnalytics;

      if (!widgetAnalytics || typeof widgetAnalytics !== "object") {
        failures.push(`${locale}:WidgetAnalytics namespace missing`);
        continue;
      }

      for (const key of requiredLeafKeys) {
        const value = getValue(widgetAnalytics as JsonObject, key);
        if (typeof value !== "string" || !value.trim()) {
          failures.push(`${locale}:WidgetAnalytics.${key} missing`);
        }
      }
    }

    expect(failures).toEqual([]);
  });

  it("does not keep root namespaces without runtime translation references", () => {
    const rootMessages = readJson(path.join(MESSAGES_ROOT, "en.json"));
    const sources = listSourceFiles();
    const unreferencedNamespaces = Object.keys(rootMessages).filter(
      namespace => !hasRuntimeNamespaceReference(namespace, sources)
    );

    expect(unreferencedNamespaces).toEqual([]);
  });

  it("covers direct EnhancedMarkdownEditor translation calls", () => {
    const keyUsages = collectEnhancedMarkdownEditorKeyUsages(listSourceFiles());
    const keys = [...new Set(keyUsages.map(usage => usage.key))].sort();
    const failures: string[] = [];

    expect(keys).toContain("uploadingImage");

    for (const locale of LOCALES) {
      const messages = readJson(path.join(MESSAGES_ROOT, `${locale}.json`));
      const namespace = messages.EnhancedMarkdownEditor;

      if (!namespace || typeof namespace !== "object") {
        failures.push(`${locale}:EnhancedMarkdownEditor namespace is missing`);
        continue;
      }

      for (const key of keys) {
        const value = (namespace as JsonObject)[key];

        if (typeof value !== "string" || !value.trim()) {
          const sources = keyUsages
            .filter(usage => usage.key === key)
            .map(usage => usage.source)
            .filter((source, index, all) => all.indexOf(source) === index)
            .join(",");
          failures.push(`${locale}:EnhancedMarkdownEditor.${key}:${sources}`);
        }
      }
    }

    expect(failures).toEqual([]);
  });

  it("keeps AI agent settings translations in the settings client catalog", async () => {
    const failures: string[] = [];

    for (const locale of LOCALES) {
      const messages = await loadSettingsClientMessages(locale);
      const agentSettings = messages.AgentSettings;

      if (!agentSettings || typeof agentSettings !== "object") {
        failures.push(`${locale}:AgentSettings namespace is missing`);
        continue;
      }

      for (const key of AI_AGENT_SETTINGS_REQUIRED_STRING_KEYS) {
        const value = (agentSettings as JsonObject)[key];

        if (typeof value !== "string" || !value.trim()) {
          failures.push(`${locale}:AgentSettings.${key} is missing`);
        }
      }
    }

    expect(failures).toEqual([]);
  });

  it("keeps shared sidebar translations in the root client catalog", async () => {
    const failures: string[] = [];

    for (const locale of LOCALES) {
      const messages = await loadRootClientMessages(locale);
      const sidebar = messages.Sidebar;

      if (!sidebar || typeof sidebar !== "object") {
        failures.push(`${locale}:Sidebar namespace is missing`);
        continue;
      }

      for (const key of [
        "mobileSidebarTitle",
        "mobileSidebarDescription",
        "toggleSidebar",
      ]) {
        const value = (sidebar as JsonObject)[key];

        if (typeof value !== "string" || !value.trim()) {
          failures.push(`${locale}:Sidebar.${key} is missing`);
        }
      }
    }

    expect(failures).toEqual([]);
  });

  it("keeps text select scrolling available in root and scoped panel catalogs", async () => {
    for (const locale of LOCALES) {
      for (const messages of await Promise.all([
        loadRootClientMessages(locale),
        loadPanelClientMessages(locale),
      ])) {
        expect(messages.Select).toEqual({
          scrollUp: expect.stringMatching(/\S/),
          scrollDown: expect.stringMatching(/\S/),
        });
      }
    }
  });

  it("keeps landing integration preview translations in the root client catalog", async () => {
    const failures: string[] = [];

    for (const locale of LOCALES) {
      const messages = await loadRootClientMessages(locale);

      for (const namespace of [
        "IntegrationDetails",
        "IntegrationRegistry",
        "WhatsAppIntegration",
      ]) {
        const value = messages[namespace];

        if (!value || typeof value !== "object") {
          failures.push(`${locale}:${namespace} namespace is missing`);
        }
      }
    }

    expect(failures).toEqual([]);
  });

  it("keeps setup wizard AI context suggestions in the root client catalog", async () => {
    const failures: string[] = [];

    for (const locale of LOCALES) {
      const messages = await loadRootClientMessages(locale);
      const aiContext = messages.AiContextManager;

      if (!aiContext || typeof aiContext !== "object") {
        failures.push(`${locale}:AiContextManager namespace is missing`);
        continue;
      }

      for (const key of [
        "salesGrowth",
        "customerRetention",
        "competitorAnalysis",
        "productFeedback",
        "serviceQuality",
      ]) {
        const value = (aiContext as JsonObject)[key];

        if (typeof value !== "string" || !value.trim()) {
          failures.push(`${locale}:AiContextManager.${key} is missing`);
        }
      }
    }

    expect(failures).toEqual([]);
  });

  it("keeps conversation detail static translations in the conversations catalog", async () => {
    const failures: string[] = [];
    const conversationDetailKeys = Array.from(
      new Set(
        listSourceFiles()
          .filter(file =>
            fs
              .readFileSync(file, "utf8")
              .includes('useTranslations("ConversationDetailView")')
          )
          .flatMap(file =>
            Array.from(
              fs
                .readFileSync(file, "utf8")
                .matchAll(/\bt\(\s*["']([^"']+)["']/g)
            ).map(match => match[1])
          )
      )
    ).sort();

    for (const locale of LOCALES) {
      const messages = await loadConversationsClientMessages(locale);
      const conversationDetail = messages.ConversationDetailView;

      if (!conversationDetail || typeof conversationDetail !== "object") {
        failures.push(`${locale}:ConversationDetailView namespace is missing`);
        continue;
      }

      for (const key of conversationDetailKeys) {
        const value = getValue(conversationDetail as JsonObject, key);

        if (typeof value !== "string" || !value.trim()) {
          failures.push(`${locale}:ConversationDetailView.${key} is missing`);
        }
      }
    }

    expect(failures).toEqual([]);
  });

  it("keeps scenario shell and onboarding translations in the scenarios catalog", () => {
    const failures: string[] = [];

    for (const locale of LOCALES) {
      const scenarioFile = path.join(
        MESSAGES_ROOT,
        "scenarios",
        locale,
        "page.json"
      );
      const messages = readJson(scenarioFile);
      const scenarios = messages.Scenarios;

      if (!scenarios || typeof scenarios !== "object") {
        failures.push(`${locale}:Scenarios namespace is missing`);
        continue;
      }

      for (const key of SCENARIO_SHELL_REQUIRED_STRING_KEYS) {
        const value = (scenarios as JsonObject)[key];

        if (typeof value !== "string" || !value.trim()) {
          failures.push(`${locale}:Scenarios.${key} is missing`);
        }
      }
    }

    expect(failures).toEqual([]);
  });

  it("keeps scenario settings complete and aligned with localized trigger labels", async () => {
    const failures: string[] = [];

    for (const locale of LOCALES) {
      const messages = await loadScenariosClientMessages(locale);
      const scenarios = messages.Scenarios;

      if (!scenarios || typeof scenarios !== "object") {
        failures.push(`${locale}:Scenarios namespace is missing`);
        continue;
      }

      for (const key of SCENARIO_SETTINGS_REQUIRED_STRING_KEYS) {
        const value = (scenarios as JsonObject)[key];

        if (typeof value !== "string" || !value.trim()) {
          failures.push(`${locale}:Scenarios.${key} is missing`);
        }
      }

      const scenarioMessages = scenarios as JsonObject;
      const settingsTitle = scenarioMessages.scenarioSettingsFor;
      const catchAllHint = scenarioMessages.triggerCatchAllOneShotHint;
      const exactLabel = scenarioMessages.triggerMatchExact;
      const containsLabel = scenarioMessages.triggerMatchContains;

      if (
        typeof settingsTitle !== "string" ||
        !settingsTitle.includes("{name}")
      ) {
        failures.push(`${locale}:scenarioSettingsFor dropped the {name} token`);
      }
      if (
        typeof catchAllHint !== "string" ||
        typeof exactLabel !== "string" ||
        !catchAllHint.includes(exactLabel)
      ) {
        failures.push(`${locale}:catch-all hint omits ${exactLabel}`);
      }
      if (
        typeof catchAllHint !== "string" ||
        typeof containsLabel !== "string" ||
        !catchAllHint.includes(containsLabel)
      ) {
        failures.push(`${locale}:catch-all hint omits ${containsLabel}`);
      }
    }

    expect(failures).toEqual([]);
  });

  it("keeps bulk campaign pause and overflow translations in client catalogs", async () => {
    const failures: string[] = [];

    for (const locale of LOCALES) {
      const [scenarioMessages, analyticsMessages] = await Promise.all([
        loadScenariosClientMessages(locale),
        loadAnalyticsClientMessages(locale),
      ]);

      const scenarios = scenarioMessages.Scenarios;
      if (!scenarios || typeof scenarios !== "object") {
        failures.push(`${locale}:Scenarios namespace is missing`);
      } else {
        for (const key of SCENARIO_BULK_DISPATCH_REQUIRED_KEYS) {
          const value = getValue(scenarios as JsonObject, key);
          if (typeof value !== "string" || !value.trim()) {
            failures.push(`${locale}:Scenarios.${key} is missing`);
          }
        }
      }

      const campaignHistory = analyticsMessages.CampaignHistory;
      if (!campaignHistory || typeof campaignHistory !== "object") {
        failures.push(`${locale}:CampaignHistory namespace is missing`);
      } else {
        for (const key of CAMPAIGN_HISTORY_PAUSE_REQUIRED_KEYS) {
          const value = getValue(campaignHistory as JsonObject, key);
          if (typeof value !== "string" || !value.trim()) {
            failures.push(`${locale}:CampaignHistory.${key} is missing`);
          }
        }
      }

      const builder = analyticsMessages.MultiChannelCampaignBuilder;
      if (!builder || typeof builder !== "object") {
        failures.push(
          `${locale}:MultiChannelCampaignBuilder namespace is missing`
        );
      } else {
        for (const key of CAMPAIGN_BUILDER_PAUSE_REQUIRED_KEYS) {
          const value = getValue(builder as JsonObject, key);
          if (typeof value !== "string" || !value.trim()) {
            failures.push(
              `${locale}:MultiChannelCampaignBuilder.${key} is missing`
            );
          }
        }
      }

      const picker = analyticsMessages.CampaignRecipientPicker;
      const overflowHint = getValue(
        (picker && typeof picker === "object" ? picker : {}) as JsonObject,
        "recipient.overflowQueueHint"
      );
      if (typeof overflowHint !== "string" || !overflowHint.trim()) {
        failures.push(
          `${locale}:CampaignRecipientPicker.recipient.overflowQueueHint is missing`
        );
      }
    }

    expect(failures).toEqual([]);
  });

  it("keeps trigger editor presentation localized with intact metadata tokens", async () => {
    const failures: string[] = [];
    const requiredTokens = {
      triggerMetaFallbackCampaign: ["{id}"],
      triggerMetaFallbackAdSet: ["{id}"],
      triggerMetaFallbackAd: ["{id}"],
      triggerMetaConversationCount: ["{count}"],
      triggerMetaAdCount: ["{count}"],
      triggerMetaLastSeen: ["{date}"],
      triggerMetaCampaignMetadata: ["{name}"],
      triggerMetaAdSetMetadata: ["{name}"],
      triggerMetaSourceIdMetadata: ["{id}"],
    } as const;

    for (const locale of LOCALES) {
      const messages = await loadScenariosClientMessages(locale);
      const scenarios = messages.Scenarios;

      if (!scenarios || typeof scenarios !== "object") {
        failures.push(`${locale}:Scenarios namespace is missing`);
        continue;
      }

      const scenarioMessages = scenarios as JsonObject;

      for (const key of SCENARIO_TRIGGER_EDITOR_REQUIRED_STRING_KEYS) {
        const value = scenarioMessages[key];

        if (typeof value !== "string" || !value.trim()) {
          failures.push(`${locale}:Scenarios.${key} is missing`);
        }
      }

      for (const [key, tokens] of Object.entries(requiredTokens)) {
        const value = scenarioMessages[key];

        if (typeof value !== "string") {
          continue;
        }

        for (const token of tokens) {
          if (!value.includes(token)) {
            failures.push(`${locale}:Scenarios.${key} dropped ${token}`);
          }
        }
      }
    }

    expect(failures).toEqual([]);
  });

  it("includes shared campaign readiness and contact-policy messages in Scenario run-now for every locale", async () => {
    for (const locale of LOCALES) {
      const [scenarios, analytics] = await Promise.all([
        loadScenariosClientMessages(locale),
        loadAnalyticsClientMessages(locale),
      ]);
      const plan = scenarios.CampaignDispatchPlanCard as JsonObject;
      expect(plan).toBeDefined();
      expect(plan).toEqual(analytics.CampaignDispatchPlanCard);
      const readiness = plan.readiness as JsonObject;
      for (const key of [
        "ready",
        "blocked",
        "unavailable",
        "checking",
        "refresh",
        "details",
        "cooldownUntil",
        "remainingUnknown",
      ]) {
        expect(typeof readiness[key]).toBe("string");
      }
      const reasons = readiness.reasons as JsonObject;
      // Plain `{count}` or an ICU plural over it.
      expect(reasons.contact_frequency_limit).toEqual(
        expect.stringMatching(/\{count[},]/)
      );
      expect(plan.queuedSummary).toEqual(expect.stringContaining("{count}"));
      for (const namespace of [
        analytics.MultiChannelCampaignBuilder,
        scenarios.Scenarios,
      ]) {
        for (const key of ["recipientFilters", "recipientFiltersActive"]) {
          expect((namespace as JsonObject)[key]).toEqual(expect.any(String));
        }
      }
      expect((analytics.CsvUpload as JsonObject).replaceFile).toEqual(
        expect.any(String)
      );
      // One CsvUpload catalog serves both pages.
      expect(scenarios.CsvUpload).toEqual(analytics.CsvUpload);
      expect(
        ((analytics.BulkAnalytics as JsonObject).details as JsonObject).toggle
      ).toEqual(expect.any(String));
    }
  });

  it("shares localized campaign plan restrictions without contradictory send promises", async () => {
    const requiredKeys = [
      "planRestriction.title",
      "planRestriction.trial_expired",
      "planRestriction.campaign_limit",
      "planRestriction.conversation_limit",
      "planRestriction.details",
      "planRestriction.recipientUsage",
      "planRestriction.conversationUsage",
      "planRestriction.upgrade",
      "planRestriction.checksPending",
      "sendUnavailable",
      "viewSendingStatus",
      "selectedRecipients",
      "otherChecks",
      "connectionDetails",
      "inboundActivityTitle",
      "inboundActivityDescription",
      "readiness.unavailable",
      "readiness.unavailableDescription",
      "readiness.refresh",
      "readiness.recheck",
      "readiness.errors.template_lookup_unavailable",
    ];

    for (const locale of LOCALES) {
      const [analytics, scenarios] = await Promise.all([
        loadAnalyticsClientMessages(locale),
        loadScenariosClientMessages(locale),
      ]);
      const plan = analytics.CampaignDispatchPlanCard as JsonObject;
      expect(scenarios.CampaignDispatchPlanCard).toEqual(plan);
      for (const key of requiredKeys) {
        const value = getValue(plan, key);
        expect(typeof value).toBe("string");
        expect((value as string).trim()).not.toBe("");
      }
      for (const key of ["recipientUsage", "conversationUsage"]) {
        const usage = getValue(plan, `planRestriction.${key}`);
        expect(usage).toEqual(expect.stringContaining("{used}"));
        expect(usage).toEqual(expect.stringContaining("{limit}"));
        expect(usage).not.toEqual(expect.stringContaining("{used}/{limit}"));
      }
      expect(plan.selectedRecipients).toEqual(
        expect.stringMatching(/\{count, plural,/)
      );
      expect(getValue(plan, "planRestriction.checksPending")).not.toEqual(
        expect.stringContaining("WhatsApp")
      );
      for (const [catalog, namespace] of [
        [analytics, "MultiChannelCampaignBuilder"],
        [scenarios, "Scenarios"],
      ] as const) {
        const exhausted = getValue(
          catalog,
          `${namespace}.bulkLimit.freeExhausted`
        );
        expect(exhausted).toEqual(expect.stringContaining("Free"));
        expect(exhausted).not.toEqual(
          expect.stringContaining("{used}/{limit}")
        );
      }
      const healthWarning = getValue(
        analytics,
        "MultiChannelCampaignBuilder.whatsappAccountHealthWarnOnly"
      );
      expect(healthWarning).not.toMatch(
        /will not block|не блокирует|бұғаттамайды/i
      );
    }
  });

  it.each([
    [
      "en",
      [
        "1 recipient selected",
        "2 recipients selected",
        "5 recipients selected",
      ],
    ],
    [
      "ru",
      ["Выбран 1 получатель", "Выбрано 2 получателя", "Выбрано 5 получателей"],
    ],
    ["kz", ["1 алушы таңдалды", "2 алушы таңдалды", "5 алушы таңдалды"]],
  ] as const)(
    "formats campaign recipient selection in %s",
    async (locale, expected) => {
      const messages = await loadAnalyticsClientMessages(locale);
      const selectedRecipients = getValue(
        messages,
        "CampaignDispatchPlanCard.selectedRecipients"
      );
      const formatted = execFileSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `
        import { readFileSync } from "node:fs";
        import { createTranslator } from "next-intl";
        const { locale, selectedRecipients } = JSON.parse(readFileSync(0, "utf8"));
        const translate = createTranslator({ locale, messages: { selectedRecipients } });
        process.stdout.write(JSON.stringify([1, 2, 5].map(count => translate("selectedRecipients", { count }))));
      `,
        ],
        {
          cwd: path.resolve(__dirname, "../.."),
          input: JSON.stringify({ locale, selectedRecipients }),
          encoding: "utf8",
          windowsHide: true,
        }
      );
      expect(JSON.parse(formatted)).toEqual(expected);
    }
  );

  it("keeps shared template drawer translations in the scenarios client catalog", async () => {
    const failures: string[] = [];

    for (const locale of LOCALES) {
      const messages = await loadScenariosClientMessages(locale);
      const templates = messages.templates;

      if (!templates || typeof templates !== "object") {
        failures.push(`${locale}:templates namespace is missing`);
        continue;
      }

      const formMessages = (templates as JsonObject).form;
      if (!formMessages || typeof formMessages !== "object") {
        failures.push(`${locale}:templates.form namespace is missing`);
        continue;
      }

      for (const key of [
        "createTemplate",
        "attachMedia",
        "mediaDropzoneDescription",
        "templateVideoRequirement",
        "draftRestored",
        "draftDiscard",
        "staleVersion",
        "staleVersionReload",
      ]) {
        const value = (formMessages as JsonObject)[key];

        if (typeof value !== "string" || !value.trim()) {
          failures.push(`${locale}:templates.form.${key} is missing`);
        }
      }
    }

    expect(failures).toEqual([]);
  });

  it("keeps WhatsApp template manager scenario preview translations in its client catalog", async () => {
    const failures: string[] = [];

    for (const locale of LOCALES) {
      const messages = await loadWhatsAppTemplatesClientMessages(locale);
      const templates = messages.templates;
      const scenarios = messages.Scenarios;

      if (!templates || typeof templates !== "object") {
        failures.push(`${locale}:templates namespace is missing`);
      } else {
        const formMessages = (templates as JsonObject).form;
        const createTemplate =
          formMessages &&
          typeof formMessages === "object" &&
          (formMessages as JsonObject).createTemplate;

        if (typeof createTemplate !== "string" || !createTemplate.trim()) {
          failures.push(`${locale}:templates.form.createTemplate is missing`);
        }

        const flow =
          formMessages &&
          typeof formMessages === "object" &&
          (formMessages as JsonObject).flow;
        if (typeof flow !== "string" || !flow.trim() || flow.includes("?")) {
          failures.push(`${locale}:templates.form.flow is invalid`);
        }

        const bodyPlaceholder =
          formMessages &&
          typeof formMessages === "object" &&
          (formMessages as JsonObject).bodyPlaceholder;
        if (
          typeof bodyPlaceholder !== "string" ||
          !bodyPlaceholder.includes("{v1}") ||
          !bodyPlaceholder.includes("{v2}")
        ) {
          failures.push(
            `${locale}:templates.form.bodyPlaceholder must interpolate {{1}} via {v1}/{v2}`
          );
        }

        const categories = (templates as JsonObject).categories;
        const utility =
          categories &&
          typeof categories === "object" &&
          (categories as JsonObject).UTILITY;
        if (locale !== "en" && utility === "Utility") {
          failures.push(`${locale}:templates.categories.UTILITY still English`);
        }
      }

      if (!scenarios || typeof scenarios !== "object") {
        failures.push(`${locale}:Scenarios namespace is missing`);
        continue;
      }

      for (const key of [
        "whatsappTemplateAddButton",
        "whatsappTemplateButtonEditType",
        "flowAddScreenTitle",
      ]) {
        const value = (scenarios as JsonObject)[key];

        if (typeof value !== "string" || !value.trim()) {
          failures.push(`${locale}:Scenarios.${key} is missing`);
        }
      }
    }

    expect(failures).toEqual([]);
  });

  it("keeps WhatsApp welcome sequence preview translations in its client catalog", async () => {
    const failures: string[] = [];

    for (const locale of LOCALES) {
      const messages = await loadWhatsAppWelcomeSequencesClientMessages(locale);
      const welcomeSequences = messages.WhatsAppWelcomeSequences;
      const scenarios = messages.Scenarios;

      if (!welcomeSequences || typeof welcomeSequences !== "object") {
        failures.push(
          `${locale}:WhatsAppWelcomeSequences namespace is missing`
        );
      } else {
        for (const key of [
          "form.iceBreakerPlaceholder",
          "preview.emptyText",
          "dialog.createTitle",
        ]) {
          const value = getValue(welcomeSequences as JsonObject, key);

          if (typeof value !== "string" || !value.trim()) {
            failures.push(
              `${locale}:WhatsAppWelcomeSequences.${key} is missing`
            );
          }
        }
      }

      if (!scenarios || typeof scenarios !== "object") {
        failures.push(`${locale}:Scenarios namespace is missing`);
        continue;
      }

      for (const key of [
        "whatsappTemplateButtonLabelPlaceholder",
        "actionCtaFlowPlaceholder",
      ]) {
        const value = (scenarios as JsonObject)[key];

        if (typeof value !== "string" || !value.trim()) {
          failures.push(`${locale}:Scenarios.${key} is missing`);
        }
      }
    }

    expect(failures).toEqual([]);
  });

  it("keeps scenario-adjacent Kazakh and Russian translations readable", () => {
    const failures: string[] = [];

    for (const locale of ["kz", "ru"] as const) {
      // The Scenarios page loads these from the analytics catalog.
      const messages = readJson(
        path.join(MESSAGES_ROOT, "analytics", locale, "page.json")
      );

      for (const namespace of SCENARIO_ADJACENT_ROOT_NAMESPACES) {
        const namespaceMessages = messages[namespace];

        if (!namespaceMessages || typeof namespaceMessages !== "object") {
          failures.push(`${locale}:${namespace} namespace is missing`);
          continue;
        }

        for (const [leafPath, value] of flattenLeaves(namespaceMessages)) {
          if (CORRUPTED_TRANSLATION_PATTERN.test(value)) {
            failures.push(`${locale}:${namespace}.${leafPath}=${value}`);
          }
        }
      }
    }

    expect(failures).toEqual([]);
  });

  it("keeps Kazakh and Russian landing header translations readable", () => {
    const failures: string[] = [];

    for (const locale of ["kz", "ru"] as const) {
      const messages = readJson(path.join(MESSAGES_ROOT, `${locale}.json`));
      const landingPage = messages.LandingPage;

      if (!landingPage || typeof landingPage !== "object") {
        failures.push(`${locale}:LandingPage namespace is missing`);
        continue;
      }

      for (const [leafPath, value] of flattenLeaves(landingPage)) {
        if (CORRUPTED_TRANSLATION_PATTERN.test(value)) {
          failures.push(`${locale}:LandingPage.${leafPath}=${value}`);
        }
      }
    }

    expect(failures).toEqual([]);
  });

  it("keeps Kazakh WhatsApp scenario controls localized", () => {
    const messages = readJson(
      path.join(MESSAGES_ROOT, "scenarios", "kz", "page.json")
    );
    const scenarios = messages.Scenarios;

    expect(scenarios).toBeDefined();
    expect(typeof scenarios).toBe("object");
    const scenarioMessages = scenarios as JsonObject;
    const editType = scenarioMessages.whatsappTemplateButtonEditType;
    const addScreenTitle = scenarioMessages.flowAddScreenTitle;

    expect(editType).not.toBe("Edit type");
    expect(editType).not.toMatch(CORRUPTED_TRANSLATION_PATTERN);
    expect(addScreenTitle).not.toMatch(/^Add another page/);
    expect(addScreenTitle).not.toMatch(CORRUPTED_TRANSLATION_PATTERN);
  });

  it.each(LOCALES)(
    "loads complete Airi chat progress translations in the %s panel",
    async locale => {
      const messages = await loadPanelClientMessages(locale);
      const progress = messages.AiriChatProgress as JsonObject | undefined;
      const localized = readJson(
        path.join(MESSAGES_ROOT, `${locale}.json`)
      ).AiriChatProgress;
      const english = readJson(path.join(MESSAGES_ROOT, "en.json"))
        .AiriChatProgress as JsonObject;
      expect(progress).toEqual(localized);
      expect(progress).toBeDefined();
      expect(Object.keys(progress ?? {}).sort()).toEqual(
        Object.keys(english).sort()
      );
      const failures: string[] = [];
      for (const [leafPath, value] of flattenLeaves(progress)) {
        if (!value.trim() || CORRUPTED_TRANSLATION_PATTERN.test(value)) {
          failures.push(`${locale}:AiriChatProgress.${leafPath}=${value}`);
        }
      }
      expect(failures).toEqual([]);
    }
  );

  it.each(LOCALES)(
    "loads complete Airi chat translations in the %s panel",
    async locale => {
      const messages = await loadPanelClientMessages(locale);
      const chat = messages.AiriChat as JsonObject | undefined;
      const localized = readJson(
        path.join(MESSAGES_ROOT, `${locale}.json`)
      ).AiriChat;
      const english = readJson(path.join(MESSAGES_ROOT, "en.json"))
        .AiriChat as JsonObject;
      expect(chat).toBeDefined();
      expect(chat).toEqual(localized);
      expect(Object.keys(chat ?? {}).sort()).toEqual(
        Object.keys(english).sort()
      );
      const failures: string[] = [];
      for (const [leafPath, value] of flattenLeaves(chat)) {
        if (!value.trim() || CORRUPTED_TRANSLATION_PATTERN.test(value)) {
          failures.push(`${locale}:AiriChat.${leafPath}=${value}`);
        }
      }
      expect(failures).toEqual([]);
    }
  );

  it.each(LOCALES)(
    "loads Meta Ads review and connection recovery messages in the %s panel",
    async locale => {
      const messages = await loadPanelClientMessages(locale);
      const base = readJson(path.join(MESSAGES_ROOT, `${locale}.json`));
      const integration = readJson(
        path.join(MESSAGES_ROOT, `settings/integrations/${locale}/page.json`)
      );
      expect(messages.AiriMetaAds).toEqual(base.AiriMetaAds);
      expect(messages.AiriMetaAds).toHaveProperty(
        "review.moneyUnits",
        expect.any(String)
      );
      expect(messages.MetaAdsIntegration).toEqual(
        integration.MetaAdsIntegration
      );
    }
  );

  it.each(LOCALES)(
    "loads WhatsApp signup failure messages in the %s panel",
    async locale => {
      const messages = await loadPanelClientMessages(locale);
      const integration = readJson(
        path.join(MESSAGES_ROOT, `settings/integrations/${locale}/page.json`)
      );
      expect(messages.EmbeddedSignupButton).toEqual(
        integration.EmbeddedSignupButton
      );
      expect(messages.EmbeddedSignupButton).toHaveProperty(
        "failure.closedDescription",
        expect.any(String)
      );
    }
  );

  it("keeps workspace switcher translations in the panel client catalog", async () => {
    const failures: string[] = [];

    for (const locale of LOCALES) {
      const messages = await loadPanelClientMessages(locale);
      const workspaces = messages.Workspaces;

      if (!workspaces || typeof workspaces !== "object") {
        failures.push(`${locale}:Workspaces namespace is missing`);
        continue;
      }

      for (const key of ["selectWorkspace", "workspaces", "manageWorkspaces"]) {
        const value = (workspaces as JsonObject)[key];

        if (typeof value !== "string" || !value.trim()) {
          failures.push(`${locale}:Workspaces.${key} is missing`);
        }
      }
    }

    expect(failures).toEqual([]);
  });

  it("keeps unscoped workspace feature translations in the panel client catalog", async () => {
    const failures: string[] = [];
    const requiredNamespaces = [
      {
        namespace: "WhatsAppFlows",
        keys: ["title", "description", "alerts.connectWhatsApp"],
      },
      {
        namespace: "IndexedUrlsManager",
        keys: ["title", "description", "urlPlaceholder"],
      },
    ] as const;

    for (const locale of LOCALES) {
      const messages = await loadPanelClientMessages(locale);

      for (const { namespace, keys } of requiredNamespaces) {
        const namespaceMessages = messages[namespace];

        if (!namespaceMessages || typeof namespaceMessages !== "object") {
          failures.push(`${locale}:${namespace} namespace is missing`);
          continue;
        }

        for (const key of keys) {
          const value = getValue(namespaceMessages as JsonObject, key);

          if (typeof value !== "string" || !value.trim()) {
            failures.push(`${locale}:${namespace}.${key} is missing`);
          }
        }
      }
    }

    expect(failures).toEqual([]);
  });

  it("keeps Airi language translations in the settings client catalog", async () => {
    const failures: string[] = [];

    for (const locale of LOCALES) {
      const messages = await loadSettingsClientMessages(locale);
      const settings = messages.AiriLanguageSettings;

      if (!settings || typeof settings !== "object") {
        failures.push(`${locale}:AiriLanguageSettings namespace is missing`);
        continue;
      }

      for (const key of [
        "title",
        "description",
        "languages.en.name",
        "languages.ru.nativeName",
        "saveChanges",
        "saveFailed",
      ]) {
        const value = getValue(settings as JsonObject, key);

        if (typeof value !== "string" || !value.trim()) {
          failures.push(`${locale}:AiriLanguageSettings.${key} is missing`);
        }
      }
    }

    expect(failures).toEqual([]);
  });

  it("keeps messengers section translations in the panel client catalog", async () => {
    const failures: string[] = [];

    for (const locale of LOCALES) {
      const messages = await loadPanelClientMessages(locale);
      const messengersSection = messages.MessengersSection;

      if (!messengersSection || typeof messengersSection !== "object") {
        failures.push(`${locale}:MessengersSection namespace is missing`);
        continue;
      }

      for (const key of [
        "title",
        "templates",
        "flows",
        "welcomeSequences",
        "catalog",
        "officialBadge",
      ]) {
        const value = (messengersSection as JsonObject)[key];

        if (typeof value !== "string" || !value.trim()) {
          failures.push(`${locale}:MessengersSection.${key} is missing`);
        }
      }
    }

    expect(failures).toEqual([]);
  });

  it("keeps public knowledge base client translations in the root client catalog", async () => {
    const failures: string[] = [];

    for (const locale of LOCALES) {
      const messages = await loadRootClientMessages(locale);
      const knowledgeBase = messages.KnowledgeBase;

      if (!knowledgeBase || typeof knowledgeBase !== "object") {
        failures.push(`${locale}:KnowledgeBase namespace is missing`);
        continue;
      }

      for (const namespace of ["feedback", "breadcrumbs"] as const) {
        const section = (knowledgeBase as JsonObject)[namespace];

        if (!section || typeof section !== "object") {
          failures.push(`${locale}:KnowledgeBase.${namespace} is missing`);
        }
      }

      const feedback = (knowledgeBase as JsonObject).feedback as JsonObject;

      for (const key of ["wasHelpful", "yes", "no", "thanks"]) {
        const value = feedback?.[key];

        if (typeof value !== "string" || !value.trim()) {
          failures.push(`${locale}:KnowledgeBase.feedback.${key} is missing`);
        }
      }
    }

    expect(failures).toEqual([]);
  });

  it("keeps set-webhook translations in the root client catalog", async () => {
    const failures: string[] = [];

    for (const locale of LOCALES) {
      const messages = await loadRootClientMessages(locale);
      const setWebhookPage = messages.SetWebhookPage;

      if (!setWebhookPage || typeof setWebhookPage !== "object") {
        failures.push(`${locale}:SetWebhookPage namespace is missing`);
        continue;
      }

      for (const key of ["title", "description", "setWebhook"]) {
        const value = (setWebhookPage as JsonObject)[key];

        if (typeof value !== "string" || !value.trim()) {
          failures.push(`${locale}:SetWebhookPage.${key} is missing`);
        }
      }
    }

    expect(failures).toEqual([]);
  });
});
