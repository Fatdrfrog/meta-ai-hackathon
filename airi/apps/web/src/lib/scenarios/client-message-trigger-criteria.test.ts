import type { ScenarioTriggerConfig } from "@icecore/scenario-contracts";
import {
  getClientMessageSpecificity,
  hasActiveClientMessageNarrowingFilters,
  hasClientMessageReferralFilters,
  isClientMessageCatchAll,
  isClientMessageCriteriaMatchable,
  projectActiveClientMessageFilters,
  type ClientMessageTextCriteria,
} from "./client-message-trigger-criteria";

type CriteriaCase = {
  name: string;
  config: ScenarioTriggerConfig | null | undefined;
  text: ClientMessageTextCriteria;
  matchable: boolean;
  narrowing: boolean;
  catchAll: boolean;
  specificity: {
    mode: "any" | "exact" | "contains";
    base: 100 | 300 | 400;
    boost: 0 | 25;
    score: number;
  };
  filters?: Partial<{
    channelFilter: readonly string[];
    onlyNewCustomers: boolean;
    whatsappReferralSourceTypes: readonly string[];
    whatsappReferralSourcePlatforms: readonly string[];
    metaReferralSourceIds: readonly string[];
    metaReferralCampaignIds: readonly string[];
    metaReferralAdSetIds: readonly string[];
  }>;
};

const cases: CriteriaCase[] = [
  {
    name: "Any ignores a dormant pattern and regex mode",
    config: {
      enabled: true,
      messageMatchMode: "any",
      keywordPattern: "refund",
      keywordMatchMode: "regex",
    },
    text: { mode: "any", status: "valid" },
    matchable: true,
    narrowing: false,
    catchAll: true,
    specificity: { mode: "any", base: 100, boost: 0, score: 100 },
  },
  {
    name: "Any activates channel, referral, and new-customer filters",
    config: {
      messageMatchMode: "any",
      channelFilter: [" whatsapp ", "whatsapp"],
      whatsappReferralSourceTypes: [" ad "],
      whatsappReferralSourcePlatforms: [" instagram "],
      metaReferralSourceIds: ["source-1"],
      metaReferralCampaignIds: ["campaign-1"],
      metaReferralAdSetIds: ["ad-set-1"],
      onlyNewCustomers: true,
    },
    text: { mode: "any", status: "valid" },
    matchable: true,
    narrowing: true,
    catchAll: false,
    specificity: { mode: "any", base: 100, boost: 25, score: 125 },
    filters: {
      channelFilter: ["whatsapp"],
      onlyNewCustomers: true,
      whatsappReferralSourceTypes: ["ad"],
      whatsappReferralSourcePlatforms: ["instagram"],
      metaReferralSourceIds: ["source-1"],
      metaReferralCampaignIds: ["campaign-1"],
      metaReferralAdSetIds: ["ad-set-1"],
    },
  },
  {
    name: "Exact preserves its pattern and ignores a dormant regex mode",
    config: {
      messageMatchMode: "exact",
      keywordPattern: "refund request",
      keywordMatchMode: "regex",
    },
    text: {
      mode: "exact",
      status: "valid",
      pattern: "refund request",
    },
    matchable: true,
    narrowing: true,
    catchAll: false,
    specificity: { mode: "exact", base: 400, boost: 25, score: 425 },
  },
  {
    name: "Exact without a pattern fails closed",
    config: { messageMatchMode: "exact", keywordPattern: " \n " },
    text: { mode: "exact", status: "missing-pattern", pattern: null },
    matchable: false,
    narrowing: false,
    catchAll: false,
    specificity: { mode: "exact", base: 400, boost: 0, score: 0 },
  },
  {
    name: "literal Contains projects alternative candidates",
    config: {
      messageMatchMode: "contains",
      keywordPattern: "refund, cancel",
      keywordMatchMode: "contains",
    },
    text: {
      mode: "contains",
      status: "valid",
      matcher: {
        kind: "literal",
        source: "refund, cancel",
        candidates: ["refund", "cancel"],
      },
    },
    matchable: true,
    narrowing: true,
    catchAll: false,
    specificity: { mode: "contains", base: 300, boost: 25, score: 325 },
  },
  {
    name: "delimiter-only literal Contains fails closed",
    config: {
      messageMatchMode: "contains",
      keywordPattern: ", ;\r\n",
      keywordMatchMode: "contains",
    },
    text: {
      mode: "contains",
      status: "empty-literal-pattern",
      matcher: {
        kind: "literal",
        source: ", ;\r\n",
        candidates: [],
      },
    },
    matchable: false,
    narrowing: false,
    catchAll: false,
    specificity: { mode: "contains", base: 300, boost: 0, score: 0 },
  },
  {
    name: "valid regex Contains retains its diagnostic source",
    config: {
      messageMatchMode: "contains",
      keywordPattern: "refund\\s+request",
      keywordMatchMode: "regex",
    },
    text: {
      mode: "contains",
      status: "valid",
      matcher: { kind: "regex", source: "refund\\s+request" },
    },
    matchable: true,
    narrowing: true,
    catchAll: false,
    specificity: { mode: "contains", base: 300, boost: 25, score: 325 },
  },
  {
    name: "invalid regex Contains fails closed but retains diagnostics",
    config: {
      messageMatchMode: "contains",
      keywordPattern: "[",
      keywordMatchMode: "regex",
    },
    text: {
      mode: "contains",
      status: "invalid-regex",
      matcher: { kind: "regex", source: "[" },
    },
    matchable: false,
    narrowing: false,
    catchAll: false,
    specificity: { mode: "contains", base: 300, boost: 0, score: 0 },
  },
  {
    name: "a disabled trigger cannot match or win",
    config: {
      enabled: false,
      messageMatchMode: "exact",
      keywordPattern: "refund",
    },
    text: { mode: "exact", status: "valid", pattern: "refund" },
    matchable: false,
    narrowing: true,
    catchAll: false,
    specificity: { mode: "exact", base: 400, boost: 25, score: 0 },
  },
  {
    name: "Exact preserves significant surrounding whitespace and case",
    config: {
      messageMatchMode: "exact",
      keywordPattern: "  Refund  ",
    },
    text: {
      mode: "exact",
      status: "valid",
      pattern: "  Refund  ",
    },
    matchable: true,
    narrowing: true,
    catchAll: false,
    specificity: { mode: "exact", base: 400, boost: 25, score: 425 },
  },
  {
    name: "onlyNewCustomers false stays inactive",
    config: {
      messageMatchMode: "any",
      onlyNewCustomers: false,
    },
    text: { mode: "any", status: "valid" },
    matchable: true,
    narrowing: false,
    catchAll: true,
    specificity: { mode: "any", base: 100, boost: 0, score: 100 },
    filters: { onlyNewCustomers: false },
  },
];

describe("projectActiveClientMessageFilters", () => {
  it.each(cases)(
    "$name",
    ({
      config,
      text,
      matchable,
      narrowing,
      catchAll,
      specificity,
      filters,
    }) => {
      const criteria = projectActiveClientMessageFilters(config);

      expect(criteria.text).toEqual(text);
      expect(criteria).toMatchObject({
        channelFilter: [],
        onlyNewCustomers: false,
        whatsappReferralSourceTypes: [],
        whatsappReferralSourcePlatforms: [],
        metaReferralSourceIds: [],
        metaReferralCampaignIds: [],
        metaReferralAdSetIds: [],
        ...filters,
      });
      expect(criteria).not.toHaveProperty("keywordPattern");
      expect(criteria).not.toHaveProperty("keywordMatchMode");
      expect(isClientMessageCriteriaMatchable(criteria)).toBe(matchable);
      expect(hasActiveClientMessageNarrowingFilters(criteria)).toBe(narrowing);
      expect(isClientMessageCatchAll(criteria)).toBe(catchAll);
      expect(getClientMessageSpecificity(criteria)).toEqual(specificity);
    }
  );

  it("normalizes missing production configuration to an enabled Any catch-all", () => {
    const criteria = projectActiveClientMessageFilters(undefined);

    expect(criteria).toEqual({
      enabled: true,
      channelFilter: [],
      onlyNewCustomers: false,
      whatsappReferralSourceTypes: [],
      whatsappReferralSourcePlatforms: [],
      metaReferralSourceIds: [],
      metaReferralCampaignIds: [],
      metaReferralAdSetIds: [],
      metaCampaignAdAccountId: "",
      metaCampaignLabels: [],
      metaCampaignNameFallbacks: [],
      text: { mode: "any", status: "valid" },
    });
    expect(isClientMessageCatchAll(criteria)).toBe(true);
  });

  it("does not mutate a deeply frozen persisted configuration", () => {
    const config: ScenarioTriggerConfig = {
      messageMatchMode: "contains",
      keywordMatchMode: "contains",
      keywordPattern: " refund, cancel ",
      channelFilter: [" whatsapp ", "whatsapp"],
      metaReferralSourceIds: [" source-1 "],
      onlyNewCustomers: true,
    };
    Object.freeze(config.channelFilter);
    Object.freeze(config.metaReferralSourceIds);
    Object.freeze(config);
    const before = {
      messageMatchMode: "contains",
      keywordMatchMode: "contains",
      keywordPattern: " refund, cancel ",
      channelFilter: [" whatsapp ", "whatsapp"],
      metaReferralSourceIds: [" source-1 "],
      onlyNewCustomers: true,
    };

    const criteria = projectActiveClientMessageFilters(config);

    expect(config).toEqual(before);
    expect(criteria.channelFilter).toEqual(["whatsapp"]);
    expect(criteria.metaReferralSourceIds).toEqual(["source-1"]);
    expect(criteria.text).toEqual({
      mode: "contains",
      status: "valid",
      matcher: {
        kind: "literal",
        source: " refund, cancel ",
        candidates: ["refund", "cancel"],
      },
    });
  });

  it("owns literal splitting, trimming, case-preserving deduplication, and immutability", () => {
    const criteria = projectActiveClientMessageFilters({
      messageMatchMode: "contains",
      keywordMatchMode: "contains",
      keywordPattern: " Refund ; cancel\r\nrefund, Refund ",
      channelFilter: ["whatsapp"],
    });

    expect(criteria.text).toEqual({
      mode: "contains",
      status: "valid",
      matcher: {
        kind: "literal",
        source: " Refund ; cancel\r\nrefund, Refund ",
        candidates: ["Refund", "cancel", "refund"],
      },
    });
    expect(Object.isFrozen(criteria)).toBe(true);
    expect(Object.isFrozen(criteria.channelFilter)).toBe(true);
    expect(Object.isFrozen(criteria.text)).toBe(true);
    if (criteria.text.mode === "contains" && criteria.text.matcher) {
      expect(Object.isFrozen(criteria.text.matcher)).toBe(true);
      if (criteria.text.matcher.kind === "literal") {
        expect(Object.isFrozen(criteria.text.matcher.candidates)).toBe(true);
      }
    }
  });
});

describe("hasClientMessageReferralFilters", () => {
  it.each<[string, ScenarioTriggerConfig]>([
    ["WhatsApp referral types", { whatsappReferralSourceTypes: ["ad"] }],
    ["referral platforms", { whatsappReferralSourcePlatforms: ["instagram"] }],
    ["Meta ads", { metaReferralSourceIds: ["ad-1"] }],
    ["Meta campaigns", { metaReferralCampaignIds: ["campaign-1"] }],
    ["Meta ad sets", { metaReferralAdSetIds: ["ad-set-1"] }],
    ["campaign labels", { metaCampaignLabels: [{ id: "label-1" }] }],
    ["campaign name fallbacks", { metaCampaignNameFallbacks: ["Autumn"] }],
  ])("is true for %s", (_name, config) => {
    const criteria = projectActiveClientMessageFilters(config);
    expect(hasClientMessageReferralFilters(criteria)).toBe(true);
    expect(hasActiveClientMessageNarrowingFilters(criteria)).toBe(true);
  });

  it("ignores channel, new-customer and keyword filters", () => {
    const criteria = projectActiveClientMessageFilters({
      messageMatchMode: "contains",
      keywordPattern: "refund",
      channelFilter: ["whatsapp"],
      onlyNewCustomers: true,
    });
    expect(hasClientMessageReferralFilters(criteria)).toBe(false);
    expect(hasActiveClientMessageNarrowingFilters(criteria)).toBe(true);
  });
});
