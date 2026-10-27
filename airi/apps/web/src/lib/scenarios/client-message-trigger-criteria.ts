import {
  normalizeClientMessageTriggerConfig,
  type ScenarioTriggerConfig,
} from "@icecore/scenario-contracts";

type ClientMessageLiteralMatcher = Readonly<{
  kind: "literal";
  source: string;
  candidates: readonly string[];
}>;

type ClientMessageRegexMatcher = Readonly<{
  kind: "regex";
  source: string;
}>;

export type ClientMessageTextCriteria =
  | Readonly<{ mode: "any"; status: "valid" }>
  | Readonly<{
      mode: "exact";
      status: "valid";
      pattern: string;
    }>
  | Readonly<{
      mode: "exact";
      status: "missing-pattern";
      pattern: null;
    }>
  | Readonly<{
      mode: "contains";
      status: "valid" | "empty-literal-pattern";
      matcher: ClientMessageLiteralMatcher;
    }>
  | Readonly<{
      mode: "contains";
      status: "valid" | "invalid-regex";
      matcher: ClientMessageRegexMatcher;
    }>
  | Readonly<{
      mode: "contains";
      status: "missing-pattern";
      matcher: null;
    }>;

export type ClientMessageTriggerCriteria = Readonly<{
  enabled: boolean;
  channelFilter: readonly string[];
  onlyNewCustomers: boolean;
  whatsappReferralSourceTypes: readonly string[];
  whatsappReferralSourcePlatforms: readonly string[];
  metaReferralSourceIds: readonly string[];
  metaReferralCampaignIds: readonly string[];
  metaReferralAdSetIds: readonly string[];
  metaCampaignAdAccountId: string;
  metaCampaignLabels: readonly { id: string; name: string }[];
  metaCampaignNameFallbacks: readonly string[];
  text: ClientMessageTextCriteria;
}>;

export type ClientMessageSpecificity = Readonly<{
  mode: ClientMessageTextCriteria["mode"];
  base: 100 | 300 | 400;
  boost: 0 | 25;
  score: number;
}>;

const EMPTY_FILTER = Object.freeze([]) as readonly string[];
const EMPTY_LABELS = Object.freeze([]) as readonly {
  id: string;
  name: string;
}[];
const compiledRegexByMatcher = new WeakMap<ClientMessageRegexMatcher, RegExp>();

function freezeFilter(values: string[] | undefined): readonly string[] {
  return values ? Object.freeze([...values]) : EMPTY_FILTER;
}

function parseLiteralCandidates(source: string): readonly string[] {
  return Object.freeze(
    Array.from(
      new Set(
        source
          .split(/[,\r\n;]+/)
          .map(candidate => candidate.trim())
          .filter(Boolean)
      )
    )
  );
}

function compileRegexSource(source: string): RegExp | null {
  try {
    return new RegExp(source, "i");
  } catch {
    return null;
  }
}

export function getCompiledClientMessageRegex(
  matcher: ClientMessageRegexMatcher
): RegExp | null {
  const cached = compiledRegexByMatcher.get(matcher);
  if (cached) return cached;

  const compiled = compileRegexSource(matcher.source);
  if (compiled) compiledRegexByMatcher.set(matcher, compiled);
  return compiled;
}

function projectTextCriteria(
  config: ScenarioTriggerConfig
): ClientMessageTextCriteria {
  if (config.messageMatchMode === "exact") {
    return config.keywordPattern
      ? Object.freeze({
          mode: "exact" as const,
          status: "valid" as const,
          pattern: config.keywordPattern,
        })
      : Object.freeze({
          mode: "exact" as const,
          status: "missing-pattern" as const,
          pattern: null,
        });
  }

  if (config.messageMatchMode === "contains") {
    const source = config.keywordPattern;
    if (!source) {
      return Object.freeze({
        mode: "contains" as const,
        status: "missing-pattern" as const,
        matcher: null,
      });
    }

    if (config.keywordMatchMode === "regex") {
      const matcher = Object.freeze({
        kind: "regex" as const,
        source,
      });
      const compiled = compileRegexSource(source);
      if (compiled) compiledRegexByMatcher.set(matcher, compiled);
      return Object.freeze({
        mode: "contains" as const,
        status: compiled ? ("valid" as const) : ("invalid-regex" as const),
        matcher,
      });
    }

    const candidates = parseLiteralCandidates(source);
    return Object.freeze({
      mode: "contains" as const,
      status:
        candidates.length > 0
          ? ("valid" as const)
          : ("empty-literal-pattern" as const),
      matcher: Object.freeze({
        kind: "literal" as const,
        source,
        candidates,
      }),
    });
  }

  return Object.freeze({ mode: "any" as const, status: "valid" as const });
}

export function projectActiveClientMessageFilters(
  config: ScenarioTriggerConfig | null | undefined
): ClientMessageTriggerCriteria {
  const normalized = normalizeClientMessageTriggerConfig(config);

  return Object.freeze({
    enabled:
      normalized.enabled !== false &&
      normalized.entryPointType !== "customer_behavior" &&
      normalized.entryPointType !== "business_event",
    channelFilter: freezeFilter(normalized.channelFilter),
    onlyNewCustomers: normalized.onlyNewCustomers === true,
    whatsappReferralSourceTypes: freezeFilter(
      normalized.whatsappReferralSourceTypes
    ),
    whatsappReferralSourcePlatforms: freezeFilter(
      normalized.whatsappReferralSourcePlatforms
    ),
    metaReferralSourceIds: freezeFilter(normalized.metaReferralSourceIds),
    metaReferralCampaignIds: freezeFilter(normalized.metaReferralCampaignIds),
    metaReferralAdSetIds: freezeFilter(normalized.metaReferralAdSetIds),
    metaCampaignAdAccountId: normalized.metaCampaignAdAccountId ?? "",
    metaCampaignLabels: normalized.metaCampaignLabels
      ? Object.freeze(
          normalized.metaCampaignLabels.map(label =>
            Object.freeze({
              id: label.id,
              name: label.name?.trim() || label.id,
            })
          )
        )
      : EMPTY_LABELS,
    metaCampaignNameFallbacks: freezeFilter(
      normalized.metaCampaignNameFallbacks
    ),
    text: projectTextCriteria(normalized),
  });
}

export function isClientMessageCriteriaMatchable(
  criteria: ClientMessageTriggerCriteria
): boolean {
  if (!criteria.enabled) return false;
  return criteria.text.status === "valid";
}

/** WhatsApp referral and Meta ad/campaign filters (e.g. click-to-WhatsApp). */
export function hasClientMessageReferralFilters(
  criteria: ClientMessageTriggerCriteria
): boolean {
  return (
    criteria.whatsappReferralSourceTypes.length > 0 ||
    criteria.whatsappReferralSourcePlatforms.length > 0 ||
    criteria.metaReferralSourceIds.length > 0 ||
    criteria.metaReferralCampaignIds.length > 0 ||
    criteria.metaReferralAdSetIds.length > 0 ||
    criteria.metaCampaignLabels.length > 0 ||
    criteria.metaCampaignNameFallbacks.length > 0
  );
}

export function hasActiveClientMessageNarrowingFilters(
  criteria: ClientMessageTriggerCriteria
): boolean {
  const hasGlobalFilter =
    criteria.channelFilter.length > 0 ||
    hasClientMessageReferralFilters(criteria) ||
    criteria.onlyNewCustomers;

  return (
    hasGlobalFilter ||
    (criteria.text.mode !== "any" && criteria.text.status === "valid")
  );
}

export function isClientMessageCatchAll(
  criteria: ClientMessageTriggerCriteria
): boolean {
  return (
    criteria.enabled &&
    criteria.text.mode === "any" &&
    !hasActiveClientMessageNarrowingFilters(criteria)
  );
}

export function getClientMessageSpecificity(
  criteria: ClientMessageTriggerCriteria
): ClientMessageSpecificity {
  const base =
    criteria.text.mode === "exact"
      ? 400
      : criteria.text.mode === "contains"
        ? 300
        : 100;
  const boost = hasActiveClientMessageNarrowingFilters(criteria) ? 25 : 0;

  return Object.freeze({
    mode: criteria.text.mode,
    base,
    boost,
    score: isClientMessageCriteriaMatchable(criteria) ? base + boost : 0,
  });
}
