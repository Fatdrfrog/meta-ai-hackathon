import fs from "node:fs";
import path from "node:path";

const LOCALES = ["en", "ru", "kz"] as const;
const PANEL_NAMESPACES = [
  "DashboardPage",
  "DashboardClientPage",
  "SectionCards",
] as const;
const ANALYTICS_NAMESPACES = ["LlmAnalytics"] as const;
const PERFORMANCE_NAMESPACES = ["PerformancePage"] as const;
const BULK_NAMESPACES = ["BulkAnalytics"] as const;
const WIDGET_NAMESPACES = ["WidgetAnalytics"] as const;

type JsonObject = Record<string, unknown>;

const REQUIRED_PANEL_PATHS = [
  "DashboardPage.header.title",
  "DashboardPage.header.description",
  "DashboardPage.filters.allChannels",
  "DashboardPage.filters.allCategories",
  "DashboardPage.filters.allLabels",
  "DashboardPage.filters.allManagers",
  "DashboardPage.filters.label",
  "DashboardPage.filters.channelCount",
  "DashboardPage.filters.categoryCount",
  "DashboardPage.filters.labelCount",
  "DashboardPage.filters.managerCount",
  "DashboardPage.filters.channels",
  "DashboardPage.filters.noChannels",
  "DashboardPage.filters.categories",
  "DashboardPage.filters.noCategories",
  "DashboardPage.filters.internalLabels",
  "DashboardPage.filters.noInternalLabels",
  "DashboardPage.filters.managers",
  "DashboardPage.filters.noManagers",
  "DashboardPage.filters.sheetTitle",
  "DashboardPage.filters.sheetDescription",
  "DashboardPage.filters.apply",
  "DashboardPage.filters.clearSelection",
  "DashboardPage.presets.label",
  "DashboardPage.presets.empty",
  "DashboardPage.presets.delete",
  "DashboardPage.presets.save",
  "DashboardPage.presets.saveTitle",
  "DashboardPage.presets.saveDescription",
  "DashboardPage.presets.nameLabel",
  "DashboardPage.presets.namePlaceholder",
  "DashboardPage.presets.cancel",
  "DashboardPage.presets.confirmSave",
  "DashboardPage.presets.apply",
  "DashboardPage.presets.deleteAria",
  "DashboardPage.presets.deleteTitle",
  "DashboardPage.presets.deleteDescription",
  "DashboardPage.presets.deleteCancel",
  "DashboardPage.presets.deleteConfirm",
  "DashboardPage.actions.export",
  "DashboardPage.export.all",
  "DashboardPage.export.filters",
  "DashboardPage.export.comparisonPeriods",
  "DashboardPage.export.categoryComparisons",
  "DashboardPage.export.dailyCountsOverall",
  "DashboardPage.export.messageActivityByHour",
  "DashboardPage.export.topCategoriesVisible",
  "DashboardPage.export.categoriesByChannelVisible",
  "DashboardPage.export.statsOverall",
  "DashboardPage.export.advertisement",
  "DashboardPage.export.metaAdsManagerDaily",
  "DashboardPage.export.metaAdsManagerTopAds",
  "DashboardPage.export.advertisementSources",
  "DashboardPage.export.internalLabels",
  "DashboardPage.export.managers",
  "DashboardPage.export.internalLabelBreakdown",
  "DateRangeControl.last7Days",
  "DateRangeControl.last30Days",
  "DateRangeControl.last90Days",
  "DateRangeControl.thisWeek",
  "DateRangeControl.last12Months",
  "DateRangeControl.select",
  "DateRangeControl.customRange",
  "DashboardClientPage.topInsight",
  "DashboardClientPage.viewMore",
  "DashboardClientPage.complaintInsight",
  "DashboardClientPage.noComplaintTrends",
  "DashboardClientPage.insufficientDataForPeak",
  "DashboardClientPage.peakTimeInsight",
  "DashboardClientPage.uncategorized",
  "DashboardClientPage.unknown",
  "DashboardClientPage.missingValue",
  "DashboardClientPage.retry",
  "DashboardClientPage.tabs.label",
  "DashboardClientPage.tabs.overview",
  "DashboardClientPage.tabs.categories",
  "DashboardClientPage.tabs.team",
  "DashboardClientPage.tabs.sources",
  "DashboardClientPage.comparison.label",
  "DashboardClientPage.comparison.enabled",
  "DashboardClientPage.comparison.disabled",
  "DashboardClientPage.comparison.unavailable",
  "DashboardClientPage.comparison.currentPeriod",
  "DashboardClientPage.comparison.previousPeriod",
  "DashboardClientPage.activeFilters.label",
  "DashboardClientPage.activeFilters.count",
  "DashboardClientPage.activeFilters.clearAll",
  "DashboardClientPage.activeFilters.remove",
  "DashboardClientPage.categoryComparison.title",
  "DashboardClientPage.categoryComparison.description",
  "DashboardClientPage.categoryComparison.currentOnlyDescription",
  "DashboardClientPage.categoryComparison.caption",
  "DashboardClientPage.categoryComparison.currentOnlyCaption",
  "DashboardClientPage.categoryComparison.views.all",
  "DashboardClientPage.categoryComparison.views.increased",
  "DashboardClientPage.categoryComparison.views.decreased",
  "DashboardClientPage.categoryComparison.views.new",
  "DashboardClientPage.categoryComparison.views.noLongerActive",
  "DashboardClientPage.categoryComparison.table.category",
  "DashboardClientPage.categoryComparison.table.current",
  "DashboardClientPage.categoryComparison.table.previous",
  "DashboardClientPage.categoryComparison.table.difference",
  "DashboardClientPage.categoryComparison.table.change",
  "DashboardClientPage.categoryComparison.mobile.current",
  "DashboardClientPage.categoryComparison.mobile.previous",
  "DashboardClientPage.categoryComparison.mobile.difference",
  "DashboardClientPage.categoryComparison.mobile.rate",
  "DashboardClientPage.categoryComparison.changeKinds.increase",
  "DashboardClientPage.categoryComparison.changeKinds.decrease",
  "DashboardClientPage.categoryComparison.changeKinds.unchanged",
  "DashboardClientPage.categoryComparison.changeKinds.new",
  "DashboardClientPage.categoryComparison.changeKinds.noLongerActive",
  "DashboardClientPage.categoryComparison.viewAll",
  "DashboardClientPage.categoryComparison.empty",
  "DashboardClientPage.notableChanges.title",
  "DashboardClientPage.notableChanges.description",
  "DashboardClientPage.notableChanges.increase",
  "DashboardClientPage.notableChanges.decrease",
  "DashboardClientPage.notableChanges.new",
  "DashboardClientPage.notableChanges.noLongerActive",
  "DashboardClientPage.notableChanges.unchanged",
  "DashboardClientPage.moreMetrics",
  "DashboardClientPage.showInactiveManagers",
  "DashboardClientPage.empty.dashboard",
  "DashboardClientPage.empty.chart",
  "DashboardClientPage.accessibility.comparisonControl",
  "DashboardClientPage.accessibility.categoryViews",
  "DashboardClientPage.accessibility.currentValue",
  "DashboardClientPage.accessibility.previousValue",
  "DashboardClientPage.accessibility.differenceValue",
  "DashboardClientPage.accessibility.changeRate",
  "SectionCards.metrics.total",
  "SectionCards.metrics.new",
  "SectionCards.metrics.inProgress",
  "SectionCards.metrics.resolved",
  "SectionCards.metrics.slaBreached",
  "SectionCards.metrics.repeatRequests",
  "SectionCards.metrics.avgCsat",
  "SectionCards.metrics.medianFirstManagerResponseTime",
  "SectionCards.metrics.avgResolutionTime",
  "SectionCards.duration.missing",
  "SectionCards.duration.lessThanMinute",
  "SectionCards.duration.minutes",
  "SectionCards.duration.hours",
  "SectionCards.duration.days",
  "SectionCards.duration.noChange",
  "SectionCards.firstManagerResponseInsight",
  "SectionCards.help.ariaLabel",
  "SectionCards.help.firstResponse",
  "SectionCards.help.sla",
  "SectionCards.help.repeat",
  "SectionCards.help.csat",
  "SectionCards.help.ttr",
  "SectionCards.view",
  "DashboardPage.managerResponse.help.ariaLabel",
  "DashboardPage.managerResponse.help.medianFirstResponse",
  "DashboardPage.managerResponse.help.p90",
] as const;

const REQUIRED_LLM_PATHS = [
  "LlmAnalytics.common.unknownValue",
  "LlmAnalytics.common.notAvailable",
  "LlmAnalytics.common.technicalDetail",
  "LlmAnalytics.units.calls",
  "LlmAnalytics.units.tokens",
  "LlmAnalytics.units.sampledEvaluations",
  "LlmAnalytics.units.observedCalls",
  "LlmAnalytics.units.openFindings",
  "LlmAnalytics.units.turns",
  "LlmAnalytics.units.milliseconds",
  "LlmAnalytics.units.seconds",
  "LlmAnalytics.units.perSecond",
  "LlmAnalytics.units.scoreOutOf100",
  "LlmAnalytics.units.shareOfSpend",
  "LlmAnalytics.operations.items.airiChatReply",
  "LlmAnalytics.operations.items.genericChatCompletion",
  "LlmAnalytics.operations.details.airiChat",
  "LlmAnalytics.operations.details.unknown",
  "LlmAnalytics.judge.explanationPrompt",
  "LlmAnalytics.judge.scorePrompt",
  "LlmAnalytics.judge.dimensions.relevance",
  "LlmAnalytics.quality.title",
  "LlmAnalytics.quality.cards.generationQuality.title",
  "LlmAnalytics.systemPerformance.title",
  "LlmAnalytics.costEfficiency.title",
  "LlmAnalytics.health.daily.title",
  "LlmAnalytics.health.daily.empty",
  "LlmAnalytics.health.warnings.empty",
  "LlmAnalytics.reviewQueue.title",
  "LlmAnalytics.reviewQueue.columns.finding",
  "LlmAnalytics.reviewQueue.actions.resolve",
  "LlmAnalytics.reviewQueue.actions.ignore",
  "LlmAnalytics.prompts.resolveWithRegression",
  "LlmAnalytics.toasts.resolved",
  "LlmAnalytics.toasts.updateFailed",
  "LlmAnalytics.enums.fallbackAction.groundedRecovery",
  "LlmAnalytics.enums.resultType.aiReply",
  "LlmAnalytics.enums.retrievalPath.knowledgeBase",
  "LlmAnalytics.enums.issueType.knowledgeGap",
  "LlmAnalytics.enums.severity.high",
] as const;

const REQUIRED_PERFORMANCE_PATHS = [
  "PerformancePage.dateRanges.last7Days",
  "PerformancePage.dateRanges.last30Days",
  "PerformancePage.dateRanges.last90Days",
  "PerformancePage.errors.loadFailed",
  "PerformancePage.errors.retry",
  "PerformancePage.chart.title",
  "PerformancePage.chart.collectMoreData",
  "PerformancePage.dimensions.empathy",
  "PerformancePage.dimensions.clarity",
  "PerformancePage.dimensions.scriptAdherence",
  "PerformancePage.dimensions.resolution",
  "PerformancePage.duration.missing",
  "PerformancePage.duration.seconds",
  "PerformancePage.duration.minutes",
  "PerformancePage.duration.hours",
  "PerformancePage.units.scoreOutOfTen",
  "PerformancePage.units.scoreOutOfFive",
  "PerformancePage.units.percent",
  "PerformancePage.insights.noTrendYet",
  "PerformancePage.insights.summary.teamQaScore",
  "PerformancePage.insights.summary.noPreviousPeriod",
  "PerformancePage.insights.summary.vsPreviousPeriod",
  "PerformancePage.insights.summary.qaCoverage",
  "PerformancePage.insights.summary.scoredOfHandled",
  "PerformancePage.insights.summary.managersNeedingSupport",
  "PerformancePage.insights.summary.managerTrends",
  "PerformancePage.insights.summary.averageResponseTime",
  "PerformancePage.insights.summary.responseTimeDescription",
  "PerformancePage.insights.summary.averageCsat",
  "PerformancePage.insights.summary.csatDescription",
  "PerformancePage.insights.summary.activeManagers",
  "PerformancePage.insights.summary.lastDays",
  "PerformancePage.insights.dimensions.title",
  "PerformancePage.insights.dimensions.description",
  "PerformancePage.insights.dimensions.empty",
  "PerformancePage.insights.dimensions.best",
  "PerformancePage.insights.dimensions.needsCoaching",
  "PerformancePage.insights.coaching.title",
  "PerformancePage.insights.coaching.description",
  "PerformancePage.insights.coaching.empty",
  "PerformancePage.insights.coaching.focus",
  "PerformancePage.insights.coaching.summary",
  "PerformancePage.insights.coaching.risk",
  "PerformancePage.leaderboard.title",
  "PerformancePage.leaderboard.agent",
  "PerformancePage.leaderboard.dialogsProcessed",
  "PerformancePage.leaderboard.qaCoverage",
  "PerformancePage.leaderboard.avgResponse",
  "PerformancePage.leaderboard.avgQaScore",
  "PerformancePage.leaderboard.emptyTitle",
  "PerformancePage.leaderboard.emptyDescription",
  "PerformancePage.leaderboard.scoreBreakdown",
  "PerformancePage.leaderboard.csat",
  "PerformancePage.leaderboard.lowQaConversations",
  "PerformancePage.leaderboard.previousPeriodComparison",
  "PerformancePage.performanceChart.title",
  "PerformancePage.performanceChart.singleAgentTitle",
  "PerformancePage.performanceChart.singleAgentDescription",
  "PerformancePage.performanceChart.description",
  "PerformancePage.performanceChart.qaScore",
  "PerformancePage.performanceChart.scoredConversations",
  "PerformancePage.performanceChart.conversationsShort",
  "PerformancePage.performanceChart.teamAverage",
  "PerformancePage.performanceChart.target",
] as const;

const PERFORMANCE_ICU_COUNT_PATHS = [
  { path: "PerformancePage.duration.seconds", selectors: ["count"] },
  { path: "PerformancePage.duration.minutes", selectors: ["count"] },
  { path: "PerformancePage.duration.hours", selectors: ["count"] },
  {
    path: "PerformancePage.insights.summary.scoredOfHandled",
    selectors: ["count"],
  },
  {
    path: "PerformancePage.insights.summary.managerTrends",
    selectors: ["improving", "declining"],
  },
  { path: "PerformancePage.insights.summary.lastDays", selectors: ["count"] },
  { path: "PerformancePage.insights.coaching.summary", selectors: ["count"] },
  {
    path: "PerformancePage.performanceChart.conversationsShort",
    selectors: ["count"],
  },
] as const;

const REQUIRED_BULK_PATHS = [
  "BulkAnalytics.errors.loadFailed",
  "BulkAnalytics.period.lastDays",
  "BulkAnalytics.accessibility.periodPreset",
  "BulkAnalytics.accessibility.addMessagePhrase",
  "BulkAnalytics.accessibility.removeMessagePhrase",
  "BulkAnalytics.units.lessThanMinute",
  "BulkAnalytics.units.minutes",
  "BulkAnalytics.units.hours",
  "BulkAnalytics.units.percentagePoints",
  "BulkAnalytics.units.notAvailable",
  "BulkAnalytics.empty.recentCampaignHints",
] as const;

const BULK_ICU_COUNT_PATHS = [
  "BulkAnalytics.units.minutes",
  "BulkAnalytics.units.hours",
] as const;

const REQUIRED_WIDGET_PATHS = [
  "WidgetAnalytics.unknown",
  "WidgetAnalytics.errors.loadFailed",
  "WidgetAnalytics.units.seconds",
  "WidgetAnalytics.units.minutes",
  "WidgetAnalytics.units.hours",
  "WidgetAnalytics.source.positions.bottomLeft",
  "WidgetAnalytics.source.positions.bottomRight",
  "WidgetAnalytics.charts.valueLabel",
  "WidgetAnalytics.charts.noData",
] as const;

const LLM_ICU_COUNT_PATHS = [
  "LlmAnalytics.units.calls",
  "LlmAnalytics.units.tokens",
  "LlmAnalytics.units.sampledEvaluations",
  "LlmAnalytics.units.observedCalls",
  "LlmAnalytics.units.openFindings",
  "LlmAnalytics.units.turns",
] as const;

const ICU_HASH_PLURAL_CONTRACTS = [
  {
    area: "panel",
    path: "DashboardPage.filters.channelCount",
    selectors: ["count"],
  },
  {
    area: "panel",
    path: "DashboardPage.filters.categoryCount",
    selectors: ["count"],
  },
  {
    area: "panel",
    path: "DashboardPage.filters.labelCount",
    selectors: ["count"],
  },
  {
    area: "panel",
    path: "DashboardPage.filters.managerCount",
    selectors: ["count"],
  },
  {
    area: "panel",
    path: "DashboardPage.advertisement.uniqueSources",
    selectors: ["count"],
  },
  {
    area: "panel",
    path: "DashboardPage.advertisement.dayCount",
    selectors: ["count"],
  },
  ...LLM_ICU_COUNT_PATHS.map(path => ({
    area: "analytics" as const,
    path,
    selectors: ["count"] as const,
  })),
  ...BULK_ICU_COUNT_PATHS.map(path => ({
    area: "analytics" as const,
    path,
    selectors: ["count"] as const,
  })),
  {
    area: "analytics",
    path: "BulkAnalytics.period.lastDays",
    selectors: ["count"],
  },
  {
    area: "analytics",
    path: "PerformancePage.insights.summary.managerTrends",
    selectors: ["improving", "declining"],
  },
] as const;

const REQUIRED_PLURAL_CATEGORIES = {
  ru: ["one", "few", "many", "other"],
  kz: ["one", "other"],
} as const;

const LLM_SPEND_COPY_PATHS = [
  "LlmAnalytics.warehouse.description",
  "LlmAnalytics.warehouse.descriptionWithRefresh",
  "LlmAnalytics.warehouse.cards.totalTokens.subtitle",
  "LlmAnalytics.warehouse.spend.description",
  "LlmAnalytics.warehouse.spend.cards.totalSpend.subtitle",
  "LlmAnalytics.warehouse.spend.cards.totalTokens.subtitle",
  "LlmAnalytics.warehouse.spend.cards.companyTotal.subtitle",
] as const;

function readCatalog(area: "panel" | "analytics", locale: string): JsonObject {
  return JSON.parse(
    fs.readFileSync(
      path.join(process.cwd(), "messages", area, locale, "page.json"),
      "utf8"
    )
  ) as JsonObject;
}

function readRootCatalog(locale: string): JsonObject {
  return JSON.parse(
    fs.readFileSync(
      path.join(process.cwd(), "messages", `${locale}.json`),
      "utf8"
    )
  ) as JsonObject;
}

function getPath(value: unknown, dottedPath: string): unknown {
  return dottedPath
    .split(".")
    .reduce<unknown>(
      (current, key) =>
        current && typeof current === "object"
          ? (current as JsonObject)[key]
          : undefined,
      value
    );
}

function valueType(value: unknown): string {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return typeof value;
}

function interpolationTokens(message: string): string[] {
  return Array.from(
    new Set(
      Array.from(message.matchAll(/\{([A-Za-z][\w]*)\s*(?:,|\})/g)).map(
        match => match[1]
      )
    )
  ).sort();
}

function extractPluralBlock(message: string, selector: string): string {
  const marker = `{${selector}, plural,`;
  const start = message.indexOf(marker);
  if (start < 0) {
    throw new Error(`Missing ICU plural selector: ${selector}`);
  }

  let depth = 0;
  for (let index = start; index < message.length; index += 1) {
    if (message[index] === "{") depth += 1;
    if (message[index] === "}") {
      depth -= 1;
      if (depth === 0) return message.slice(start, index + 1);
    }
  }

  throw new Error(`Unclosed ICU plural selector: ${selector}`);
}

function extractPluralCategoryBlock(
  pluralBlock: string,
  category: string
): string {
  const categoryPattern = new RegExp(`(?:[,\\s])${category}\\s*\\{`, "g");
  let match = categoryPattern.exec(pluralBlock);

  while (match) {
    let surroundingDepth = 0;
    for (let index = 0; index < match.index; index += 1) {
      if (pluralBlock[index] === "{") surroundingDepth += 1;
      if (pluralBlock[index] === "}") surroundingDepth -= 1;
    }

    if (surroundingDepth === 1) {
      const start = pluralBlock.indexOf("{", match.index);
      let branchDepth = 0;
      for (let index = start; index < pluralBlock.length; index += 1) {
        if (pluralBlock[index] === "{") branchDepth += 1;
        if (pluralBlock[index] === "}") {
          branchDepth -= 1;
          if (branchDepth === 0) {
            return pluralBlock.slice(start + 1, index);
          }
        }
      }
    }

    match = categoryPattern.exec(pluralBlock);
  }

  throw new Error(`Missing ICU plural category: ${category}`);
}

function assertSameShapeAndTokens(
  reference: unknown,
  candidate: unknown,
  currentPath: string
): void {
  expect(valueType(candidate)).toBe(valueType(reference));

  if (typeof reference === "string") {
    expect(interpolationTokens(candidate as string)).toEqual(
      interpolationTokens(reference)
    );
    return;
  }

  if (reference && typeof reference === "object" && !Array.isArray(reference)) {
    const referenceObject = reference as JsonObject;
    const candidateObject = candidate as JsonObject;
    expect(Object.keys(candidateObject).sort()).toEqual(
      Object.keys(referenceObject).sort()
    );
    for (const key of Object.keys(referenceObject)) {
      assertSameShapeAndTokens(
        referenceObject[key],
        candidateObject[key],
        currentPath ? `${currentPath}.${key}` : key
      );
    }
  }
}

describe("analytics localization catalogs", () => {
  const panelCatalogs = Object.fromEntries(
    LOCALES.map(locale => [locale, readCatalog("panel", locale)])
  );
  const analyticsCatalogs = Object.fromEntries(
    LOCALES.map(locale => [locale, readCatalog("analytics", locale)])
  );
  const rootCatalogs = Object.fromEntries(
    LOCALES.map(locale => [locale, readRootCatalog(locale)])
  );

  it.each(LOCALES)("provides the required dashboard contract in %s", locale => {
    for (const requiredPath of REQUIRED_PANEL_PATHS) {
      expect(typeof getPath(panelCatalogs[locale], requiredPath)).toBe(
        "string"
      );
    }

    expect(
      getPath(panelCatalogs[locale], "DashboardClientPage.missingValue")
    ).toBe("—");
  });

  it.each(LOCALES.filter(locale => locale !== "en"))(
    "matches dashboard path, type, and interpolation tokens in %s",
    locale => {
      for (const namespace of PANEL_NAMESPACES) {
        assertSameShapeAndTokens(
          panelCatalogs.en[namespace],
          panelCatalogs[locale][namespace],
          namespace
        );
      }
    }
  );

  it.each(LOCALES)(
    "removes the server-owned MetricsCalculator namespace from analytics/%s",
    locale => {
      expect(
        readCatalog("analytics", locale).MetricsCalculator
      ).toBeUndefined();
    }
  );

  it.each(LOCALES)("provides the required LLM contract in %s", locale => {
    for (const requiredPath of REQUIRED_LLM_PATHS) {
      expect(typeof getPath(analyticsCatalogs[locale], requiredPath)).toBe(
        "string"
      );
    }

    for (const countPath of LLM_ICU_COUNT_PATHS) {
      expect(getPath(analyticsCatalogs[locale], countPath)).toEqual(
        expect.stringContaining("{count, plural,")
      );
    }
  });

  it.each(LOCALES)(
    "provides the required performance contract in %s",
    locale => {
      for (const requiredPath of REQUIRED_PERFORMANCE_PATHS) {
        expect(typeof getPath(analyticsCatalogs[locale], requiredPath)).toBe(
          "string"
        );
      }

      for (const {
        path: countPath,
        selectors,
      } of PERFORMANCE_ICU_COUNT_PATHS) {
        for (const selector of selectors) {
          expect(getPath(analyticsCatalogs[locale], countPath)).toEqual(
            expect.stringContaining(`{${selector}, plural,`)
          );
        }
      }
    }
  );

  it.each(["ru", "kz"] as const)(
    "provides required ICU plural categories and count markers in %s",
    locale => {
      for (const contract of ICU_HASH_PLURAL_CONTRACTS) {
        const catalog =
          contract.area === "panel"
            ? panelCatalogs[locale]
            : analyticsCatalogs[locale];
        const message = getPath(catalog, contract.path);
        expect(typeof message).toBe("string");

        for (const selector of contract.selectors) {
          const pluralBlock = extractPluralBlock(message as string, selector);
          for (const category of REQUIRED_PLURAL_CATEGORIES[locale]) {
            expect(extractPluralCategoryBlock(pluralBlock, category)).toContain(
              "#"
            );
          }
        }
      }
    }
  );

  it.each(LOCALES.filter(locale => locale !== "en"))(
    "matches performance path, type, and interpolation tokens in %s",
    locale => {
      for (const namespace of PERFORMANCE_NAMESPACES) {
        assertSameShapeAndTokens(
          analyticsCatalogs.en[namespace],
          analyticsCatalogs[locale][namespace],
          namespace
        );
      }
    }
  );

  it.each(LOCALES)("provides the required Bulk contract in %s", locale => {
    for (const requiredPath of REQUIRED_BULK_PATHS) {
      expect(typeof getPath(analyticsCatalogs[locale], requiredPath)).toBe(
        "string"
      );
    }

    for (const countPath of BULK_ICU_COUNT_PATHS) {
      expect(getPath(analyticsCatalogs[locale], countPath)).toEqual(
        expect.stringContaining("{count, plural,")
      );
    }

    expect(
      getPath(
        analyticsCatalogs[locale],
        "BulkAnalytics.empty.recentCampaignsHint"
      )
    ).toBeUndefined();
    expect(
      typeof getPath(rootCatalogs[locale], "Pagination.previousAria")
    ).toBe("string");
    expect(typeof getPath(rootCatalogs[locale], "Pagination.nextAria")).toBe(
      "string"
    );
  });

  it.each(LOCALES.filter(locale => locale !== "en"))(
    "matches Bulk path, type, and interpolation tokens in %s",
    locale => {
      for (const namespace of BULK_NAMESPACES) {
        assertSameShapeAndTokens(
          analyticsCatalogs.en[namespace],
          analyticsCatalogs[locale][namespace],
          namespace
        );
      }
    }
  );

  it.each(LOCALES)("provides the required Widget contract in %s", locale => {
    for (const requiredPath of REQUIRED_WIDGET_PATHS) {
      expect(typeof getPath(analyticsCatalogs[locale], requiredPath)).toBe(
        "string"
      );
    }
  });

  it.each(LOCALES.filter(locale => locale !== "en"))(
    "matches Widget path, type, and interpolation tokens in %s",
    locale => {
      for (const namespace of WIDGET_NAMESPACES) {
        assertSameShapeAndTokens(
          analyticsCatalogs.en[namespace],
          analyticsCatalogs[locale][namespace],
          namespace
        );
      }
    }
  );

  it.each(LOCALES.filter(locale => locale !== "en"))(
    "matches LLM path, type, and interpolation tokens in %s",
    locale => {
      for (const namespace of ANALYTICS_NAMESPACES) {
        assertSameShapeAndTokens(
          analyticsCatalogs.en[namespace],
          analyticsCatalogs[locale][namespace],
          namespace
        );
      }
    }
  );

  it.each(LOCALES)(
    "keeps technical detail under the canonical common key in %s",
    locale => {
      expect(
        getPath(
          analyticsCatalogs[locale],
          "LlmAnalytics.systemPerformance.technicalDetail"
        )
      ).toBeUndefined();
    }
  );

  it.each(LOCALES.filter(locale => locale !== "en"))(
    "does not leak English workspace or completion copy in %s",
    locale => {
      for (const copyPath of LLM_SPEND_COPY_PATHS) {
        expect(getPath(analyticsCatalogs[locale], copyPath)).not.toMatch(
          /\b(?:workspace|completion)\b/i
        );
      }
    }
  );
});
