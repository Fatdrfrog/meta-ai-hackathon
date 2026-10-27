import type { Channel } from "@/types/models";
import { PRICING_AMOUNT_LINE_RE } from "@/lib/airi/grounding/pricing-amount-pattern";
import { RAG_CONFIG } from "@/lib/airi/rag/config";
import type { KBArticleResult } from "@/lib/airi/rag/kb/kb-types";
import type { ContextDecision, RetrievedAnswer } from "@/lib/airi/rag/types";

export type FactualIntent =
  | "business_hours"
  | "pricing"
  | "policy"
  | "integration_request"
  | null;
export type MissingKnowledgeIntent = Exclude<FactualIntent, null>;

type IntentRule = {
  intent: Exclude<FactualIntent, null>;
  patterns: RegExp[];
  anchors: string[];
};

const INTEGRATION_TOPIC_ALIASES = [
  { topic: "trello", aliases: ["trello"] },
  { topic: "jira", aliases: ["jira", "atlassian jira"] },
  { topic: "slack", aliases: ["slack"] },
  { topic: "asana", aliases: ["asana"] },
  { topic: "notion", aliases: ["notion"] },
  { topic: "monday", aliases: ["monday", "monday.com", "mondaycom"] },
  { topic: "clickup", aliases: ["clickup", "click up"] },
  { topic: "hubspot", aliases: ["hubspot", "hub spot"] },
  { topic: "salesforce", aliases: ["salesforce", "sales force"] },
  { topic: "zapier", aliases: ["zapier"] },
  { topic: "shopify", aliases: ["shopify"] },
] as const;

function normalizeText(value: string): string {
  return (value || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function topicAliases(topic: string): string[] {
  const normalizedTopic = normalizeText(topic);
  const match = INTEGRATION_TOPIC_ALIASES.find(
    candidate => candidate.topic === normalizedTopic
  );
  return match ? [...match.aliases] : [normalizedTopic];
}

export function detectIntegrationTopic(query: string): string | null {
  const normalizedQuery = normalizeText(query).replace(
    /[^\p{L}\p{N}\s.]/gu,
    " "
  );
  if (!normalizedQuery) return null;

  for (const candidate of INTEGRATION_TOPIC_ALIASES) {
    const hasAlias = candidate.aliases.some(alias =>
      normalizedQuery.includes(alias.toLowerCase())
    );
    if (hasAlias) return candidate.topic;
  }

  return null;
}

function hasIntegrationTopicEvidence(text: string, topic: string): boolean {
  const normalized = normalizeText(text);
  if (!normalized) return false;

  return topicAliases(topic).some(alias =>
    normalized.includes(alias.toLowerCase())
  );
}

const FACTUAL_INTENT_RULES: IntentRule[] = [
  {
    intent: "business_hours",
    patterns: [
      /\bbusiness hours\b/i,
      /\bworking hours\b/i,
      /\bopening hours?\b/i,
      /\bhours of operation\b/i,
      /\bwhat time .*open\b/i,
      /\bwhen .*open\b/i,
      /часы работы/i,
      /время работы/i,
      /режим работы/i,
      /жұмыс уақыты/i,
      /ish vaqti/i,
    ],
    anchors: [
      "hour",
      "hours",
      "open",
      "opening",
      "closing",
      "schedule",
      "monday",
      "tuesday",
      "wednesday",
      "thursday",
      "friday",
      "saturday",
      "sunday",
      "часы работы",
      "время работы",
      "режим работы",
      "жұмыс уақыты",
      "ish vaqti",
    ],
  },
  {
    intent: "pricing",
    patterns: [
      /\bprice\b/i,
      /\bpricing\b/i,
      /\bcost\b/i,
      /\bhow much\b/i,
      /\bfee\b/i,
      /\btariff\b/i,
      /сколько стоит/i,
      /цена/i,
      /стоимость/i,
      /тариф/i,
      /қанша тұрады/i,
      /баға/i,
      /\bnarx\b/i,
      /\bqancha\b/i,
    ],
    anchors: [
      "price",
      "pricing",
      "cost",
      "fee",
      "tariff",
      "$",
      "usd",
      "€",
      "eur",
      "доллар",
      "euro",
      "цена",
      "стоимость",
      "тариф",
      "баға",
      "narx",
      "тенге",
      "тг",
      "kzt",
      "₸",
      "руб",
      "₽",
    ],
  },
  {
    intent: "policy",
    patterns: [
      /\brefund\b/i,
      /\breturn policy\b/i,
      /\bprivacy policy\b/i,
      /\bterms\b/i,
      /\bconditions\b/i,
      /\bcancellation policy\b/i,
      /\bexchange policy\b/i,
      /политик/i,
      /услови/i,
      /возврат/i,
      /обмен/i,
      /қайтар/i,
      /саясат/i,
      /qaytar/i,
      /shart/i,
    ],
    anchors: [
      "policy",
      "refund",
      "return",
      "terms",
      "conditions",
      "cancellation",
      "exchange",
      "политик",
      "услови",
      "возврат",
      "обмен",
      "қайтар",
      "саясат",
      "qaytar",
      "shart",
    ],
  },
  {
    intent: "integration_request",
    patterns: [
      /\b(integrat(?:e|ion|ions|ed|ing)|connect(?:ion|ed|ing)?|sync(?:ed|ing)?|plugin|plug[- ]?in|api|webhook)\b.{0,40}\b(trello|jira|slack|asana|notion|monday(?:\.com)?|click ?up|hub ?spot|sales ?force|zapier|shopify)\b/i,
      /\b(trello|jira|slack|asana|notion|monday(?:\.com)?|click ?up|hub ?spot|sales ?force|zapier|shopify)\b.{0,40}\b(integrat(?:e|ion|ions|ed|ing)|connect(?:ion|ed|ing)?|sync(?:ed|ing)?|plugin|plug[- ]?in|api|webhook)\b/i,
      /\b(do you|can we|is there|need|want).{0,24}\b(trello|jira|slack|asana|notion|monday(?:\.com)?|click ?up|hub ?spot|sales ?force|zapier|shopify)\b.{0,24}\b(integrat(?:e|ion|ions)?|connect|sync|plugin|api|webhook)\b/i,
      /\bcrm integration\b/i,
    ],
    anchors: [
      "integration",
      "integrate",
      "connect",
      "sync",
      "plugin",
      "api",
      "webhook",
      "trello",
      "jira",
      "slack",
      "asana",
      "notion",
      "monday",
      "monday.com",
      "clickup",
      "click up",
      "hubspot",
      "hub spot",
      "salesforce",
      "sales force",
      "zapier",
      "shopify",
    ],
  },
];

type MatchedEvidence = {
  articleId: string;
  anchors: string[];
  text: string;
};

export interface FactualGroundingGuardResult {
  intent: FactualIntent;
  shouldBlock: boolean;
  reason: string;
  channel?: Channel;
  topic?: string | null;
  evidenceSource?: "snippet" | "kb";
  matchedAnchors?: string[];
  evidenceArticleIds?: string[];
}

export interface MissingKnowledgeSignal {
  intent: MissingKnowledgeIntent;
  reason: string;
  channel?: Channel;
  topic?: string | null;
}

function findRule(intent: Exclude<FactualIntent, null>): IntentRule {
  return FACTUAL_INTENT_RULES.find(rule => rule.intent === intent)!;
}

function findMatchingAnchors(text: string, anchors: string[]): string[] {
  const normalized = normalizeText(text);
  if (!normalized) return [];

  const matched = anchors.filter(anchor =>
    normalized.includes(anchor.toLowerCase())
  );
  return Array.from(new Set(matched));
}

function textHasPricingAmountLine(text: string): boolean {
  return PRICING_AMOUNT_LINE_RE.test(text);
}

function findKBEvidence(
  kbArticles: KBArticleResult[] | undefined,
  anchors: string[],
  maxArticles: number = 3,
  options?: { pricingIntent?: boolean }
): MatchedEvidence[] {
  if (!kbArticles || kbArticles.length === 0) return [];

  return kbArticles.slice(0, maxArticles).flatMap(article => {
    const text = `${article.title || ""}\n${article.fullContent || ""}`;
    const matched = findMatchingAnchors(text, anchors);
    const pricingNumeric =
      options?.pricingIntent &&
      matched.length === 0 &&
      textHasPricingAmountLine(text);
    if (matched.length === 0 && !pricingNumeric) return [];
    const anchorsOut = matched.length > 0 ? matched : ["pricing_amount_signal"];
    return [{ articleId: article.id, anchors: anchorsOut, text }];
  });
}

export function detectFactualIntent(query: string): FactualIntent {
  const input = (query || "").trim();
  if (!input) return null;

  for (const rule of FACTUAL_INTENT_RULES) {
    if (rule.patterns.some(pattern => pattern.test(input))) {
      return rule.intent;
    }
  }

  return null;
}

/**
 * Fact-sensitive intent for the guard: prefer the customer's last message over
 * `query`, which is often retrieval-expanded and can spuriously match policy/pricing
 * patterns (e.g. "условия" added by the planner).
 */
export function resolveFactualIntentForGrounding(params: {
  query: string;
  literalCustomerMessage?: string | null;
}): FactualIntent {
  const literal = (params.literalCustomerMessage ?? "").trim();
  if (literal.length > 0) {
    return detectFactualIntent(literal);
  }
  return detectFactualIntent(params.query);
}

export function evaluateFactualGroundingGuard(params: {
  query: string;
  /**
   * Verbatim last customer message. When set, fact-sensitive **intent** is derived
   * from this string instead of `query` (retrieval-expanded text).
   */
  literalCustomerMessage?: string | null;
  decision: ContextDecision;
  channel?: Channel;
  snippet?: RetrievedAnswer;
  kbArticles?: KBArticleResult[];
  /**
   * Full post-retrieval KB list (ordered by relevance). Used for policy when
   * `decision.useKB` is false but chunks were still returned (near-threshold).
   */
  retrievedKbCandidates?: KBArticleResult[];
}): FactualGroundingGuardResult {
  const intent = resolveFactualIntentForGrounding({
    query: params.query,
    literalCustomerMessage: params.literalCustomerMessage,
  });
  const integrationTopic =
    intent === "integration_request"
      ? detectIntegrationTopic(
          (params.literalCustomerMessage ?? "").trim() || params.query
        )
      : null;
  if (!intent) {
    return {
      intent,
      shouldBlock: false,
      reason: "query_not_in_fact_sensitive_scope",
      channel: params.channel,
    };
  }

  const rule = findRule(intent);

  const snippetText =
    params.decision.useSnippet && params.snippet
      ? `${params.snippet.question || ""}\n${params.snippet.answer || ""}`
      : "";

  const snippetAnchors =
    params.decision.useSnippet && params.snippet
      ? findMatchingAnchors(snippetText, rule.anchors)
      : [];

  const snippetPricingNumeric =
    intent === "pricing" &&
    snippetAnchors.length === 0 &&
    Boolean(snippetText && textHasPricingAmountLine(snippetText));

  const snippetHasTopicEvidence =
    intent !== "integration_request" ||
    !integrationTopic ||
    hasIntegrationTopicEvidence(
      `${params.snippet?.question || ""}\n${params.snippet?.answer || ""}`,
      integrationTopic
    );

  if (
    (snippetAnchors.length > 0 || snippetPricingNumeric) &&
    snippetHasTopicEvidence
  ) {
    return {
      intent,
      shouldBlock: false,
      reason: "snippet_contains_intent_evidence",
      channel: params.channel,
      evidenceSource: "snippet",
      matchedAnchors: snippetAnchors.length
        ? snippetAnchors
        : ["pricing_amount_signal"],
      topic: integrationTopic,
    };
  }

  const topKbScanLimit = RAG_CONFIG.limits.factualGuardRetrievedTopKbArticles;
  const retrievedFloor = RAG_CONFIG.thresholds.factualGuardRetrievedKbFloor;

  const rawKBEvidence = params.decision.useKB
    ? findKBEvidence(params.kbArticles, rule.anchors, topKbScanLimit, {
        pricingIntent: intent === "pricing",
      })
    : [];

  const shouldScanRetrievedWithoutUseKb =
    !params.decision.useKB &&
    (intent === "pricing" ||
      intent === "policy" ||
      (intent === "integration_request" && Boolean(integrationTopic)));

  const retrievedForPolicy =
    shouldScanRetrievedWithoutUseKb && params.retrievedKbCandidates?.length
      ? params.retrievedKbCandidates
          .filter(a => (a.similarity ?? 0) >= retrievedFloor)
          .slice(0, topKbScanLimit)
      : [];

  const nearMissKBEvidence =
    !params.decision.useKB && retrievedForPolicy.length > 0
      ? findKBEvidence(retrievedForPolicy, rule.anchors, topKbScanLimit, {
          pricingIntent: intent === "pricing",
        })
      : [];

  const mergedKBEvidence =
    rawKBEvidence.length > 0 ? rawKBEvidence : nearMissKBEvidence;

  const kbEvidence =
    intent === "integration_request" && integrationTopic
      ? mergedKBEvidence.filter(item =>
          hasIntegrationTopicEvidence(item.text, integrationTopic)
        )
      : mergedKBEvidence;
  if (kbEvidence.length > 0) {
    return {
      intent,
      shouldBlock: false,
      reason: "kb_contains_intent_evidence",
      channel: params.channel,
      evidenceSource: "kb",
      matchedAnchors: Array.from(
        new Set(kbEvidence.flatMap(item => item.anchors))
      ),
      evidenceArticleIds: kbEvidence.map(item => item.articleId),
      topic: integrationTopic,
    };
  }

  return {
    intent,
    shouldBlock: true,
    reason: "fact_sensitive_query_without_grounded_evidence",
    channel: params.channel,
    topic: integrationTopic,
  };
}

export function toMissingKnowledgeSignal(
  result: FactualGroundingGuardResult
): MissingKnowledgeSignal | null {
  if (!result.shouldBlock || !result.intent) return null;

  return {
    intent: result.intent,
    reason: result.reason,
    channel: result.channel,
    topic: result.topic || null,
  };
}
