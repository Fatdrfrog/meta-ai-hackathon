import { normalizeMetaAdAccountId } from "@/lib/meta-ads/meta-ad-account-id";

export type CampaignLabelStatus = "present" | "absent" | "unavailable" | "none";

export type CampaignProductFacts = Readonly<{
  adAccountId: string;
  campaignId: string;
  campaignName: string;
  labelIds: readonly string[];
  labelStatus: CampaignLabelStatus;
}>;

export type CampaignProductLabel = Readonly<{
  id: string;
  name: string;
}>;

export type CampaignProductRoute = Readonly<{
  adAccountId: string;
  labels: readonly CampaignProductLabel[];
  nameFallbacks: readonly string[];
}>;

export type CampaignProductOutcome =
  | "matched_label"
  | "matched_name_fallback"
  | "suppressed_label_precedence"
  | "suppressed_label_conflict"
  | "suppressed_name_ambiguous"
  | "suppressed_labels_unavailable"
  | "product_no_match";

export type CampaignProductLog = Readonly<{
  allow: boolean;
  outcome: CampaignProductOutcome;
  campaignName: string;
  adAccountId: string;
  labelIds: readonly string[];
  labelNames: readonly string[];
  nameFallbacks: readonly string[];
}>;

export type CampaignProductCandidate = Readonly<{
  key: string;
  route: CampaignProductRoute;
  facts: CampaignProductFacts;
}>;

function normalizeLabelId(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeName(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

export function hasCampaignProductRoute(route: CampaignProductRoute): boolean {
  return route.labels.length > 0 || route.nameFallbacks.length > 0;
}

function labelHits(
  route: CampaignProductRoute,
  facts: CampaignProductFacts
): CampaignProductLabel[] {
  if (facts.labelStatus !== "present") return [];
  const accountId = normalizeMetaAdAccountId(route.adAccountId);
  if (!accountId || accountId !== normalizeMetaAdAccountId(facts.adAccountId)) {
    return [];
  }
  const present = new Set(facts.labelIds.map(normalizeLabelId).filter(Boolean));
  return route.labels.filter(label => present.has(normalizeLabelId(label.id)));
}

function nameHits(
  route: CampaignProductRoute,
  facts: CampaignProductFacts
): string[] {
  const haystack = normalizeName(facts.campaignName);
  if (!haystack) return [];
  const seen = new Set<string>();
  const hits: string[] = [];
  for (const fallback of route.nameFallbacks) {
    const needle = normalizeName(fallback);
    if (!needle || seen.has(needle) || !haystack.includes(needle)) continue;
    seen.add(needle);
    hits.push(fallback.trim());
  }
  return hits;
}

function setsAreDisjoint(groups: ReadonlyArray<ReadonlySet<string>>): boolean {
  for (let left = 0; left < groups.length; left += 1) {
    const leftGroup = groups[left];
    if (!leftGroup) continue;
    for (let right = left + 1; right < groups.length; right += 1) {
      const rightGroup = groups[right];
      if (!rightGroup) continue;
      let overlaps = false;
      for (const value of leftGroup) {
        if (rightGroup.has(value)) {
          overlaps = true;
          break;
        }
      }
      if (!overlaps) return true;
    }
  }
  return false;
}

function logFor(
  facts: CampaignProductFacts,
  outcome: CampaignProductOutcome,
  allow: boolean,
  labels: readonly CampaignProductLabel[] = [],
  nameFallbacks: readonly string[] = []
): CampaignProductLog {
  return Object.freeze({
    allow,
    outcome,
    campaignName: facts.campaignName,
    adAccountId: normalizeMetaAdAccountId(facts.adAccountId),
    labelIds: Object.freeze(labels.map(label => label.id)),
    labelNames: Object.freeze(
      labels.map(label => label.name.trim() || label.id)
    ),
    nameFallbacks: Object.freeze([...nameFallbacks]),
  });
}

function denyAll(
  routes: readonly CampaignProductCandidate[],
  outcome: CampaignProductOutcome
): Map<string, CampaignProductLog> {
  const decisions = new Map<string, CampaignProductLog>();
  for (const route of routes) {
    decisions.set(route.key, logFor(route.facts, outcome, false));
  }
  return decisions;
}

function resolveGroup(
  routes: readonly CampaignProductCandidate[]
): Map<string, CampaignProductLog> {
  const facts = routes[0]?.facts;
  if (!facts) return new Map();

  if (facts.labelStatus === "unavailable" || facts.labelStatus === "none") {
    return denyAll(
      routes,
      facts.labelStatus === "unavailable"
        ? "suppressed_labels_unavailable"
        : "product_no_match"
    );
  }

  const labeled = routes.flatMap(route => {
    const hits = labelHits(route.route, route.facts);
    return hits.length > 0 ? [{ route, hits }] : [];
  });

  if (labeled.length > 0) {
    const disjoint = setsAreDisjoint(
      labeled.map(
        item => new Set(item.hits.map(label => normalizeLabelId(label.id)))
      )
    );
    if (disjoint) return denyAll(routes, "suppressed_label_conflict");

    const labeledByKey = new Map(labeled.map(item => [item.route.key, item]));
    const decisions = new Map<string, CampaignProductLog>();
    for (const route of routes) {
      const match = labeledByKey.get(route.key);
      decisions.set(
        route.key,
        match
          ? logFor(route.facts, "matched_label", true, match.hits)
          : logFor(route.facts, "suppressed_label_precedence", false)
      );
    }
    return decisions;
  }

  const named = routes.flatMap(route => {
    const hits = nameHits(route.route, route.facts);
    return hits.length > 0 ? [{ route, hits }] : [];
  });
  if (named.length === 0) return denyAll(routes, "product_no_match");

  if (
    setsAreDisjoint(
      named.map(item => new Set(item.hits.map(name => normalizeName(name))))
    )
  ) {
    return denyAll(routes, "suppressed_name_ambiguous");
  }

  const namedByKey = new Map(named.map(item => [item.route.key, item]));
  const decisions = new Map<string, CampaignProductLog>();
  for (const route of routes) {
    const match = namedByKey.get(route.key);
    decisions.set(
      route.key,
      match
        ? logFor(route.facts, "matched_name_fallback", true, [], match.hits)
        : logFor(route.facts, "product_no_match", false)
    );
  }
  return decisions;
}

function campaignGroupKey(facts: CampaignProductFacts): string {
  return [
    normalizeMetaAdAccountId(facts.adAccountId),
    facts.campaignId.trim().toLowerCase(),
    normalizeName(facts.campaignName),
    facts.labelStatus,
    facts.labelIds.map(normalizeLabelId).filter(Boolean).sort().join(","),
  ].join("|");
}

export function resolveCampaignProductDecisions(
  candidates: readonly CampaignProductCandidate[]
): ReadonlyMap<string, CampaignProductLog> {
  const decisions = new Map<string, CampaignProductLog>();
  const groups = new Map<string, CampaignProductCandidate[]>();
  for (const candidate of candidates) {
    if (!hasCampaignProductRoute(candidate.route)) continue;
    // Exclude incompatible accounts before checking conflicts, not just before
    // accepting a match. Otherwise an unrelated account can veto a valid route.
    // Name-only routes with no account remain intentionally unscoped.
    const accountId = normalizeMetaAdAccountId(candidate.route.adAccountId);
    const requiresAccount =
      candidate.route.labels.length > 0 ||
      Boolean(candidate.route.adAccountId.trim());
    if (
      requiresAccount &&
      (!accountId ||
        accountId !== normalizeMetaAdAccountId(candidate.facts.adAccountId))
    ) {
      decisions.set(
        candidate.key,
        logFor(candidate.facts, "product_no_match", false)
      );
      continue;
    }
    const key = campaignGroupKey(candidate.facts);
    const group = groups.get(key);
    if (group) group.push(candidate);
    else groups.set(key, [candidate]);
  }
  for (const group of groups.values()) {
    for (const [key, decision] of resolveGroup(group)) {
      decisions.set(key, decision);
    }
  }
  return decisions;
}
