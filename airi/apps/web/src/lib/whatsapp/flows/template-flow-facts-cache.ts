import { buildCacheKey, cache } from "@icecore/shared/lib/cache";
import {
  isTemplateFlowFacts,
  isTemplateFlowFactsDefinitive,
  type TemplateFlowFacts,
} from "./template-flow-health";

/**
 * Meta sends no webhook when a Flow's JSON changes, so cached facts expire on
 * their own; our own publish/deprecate/delete clears them right away.
 */
export const TEMPLATE_FLOW_FACTS_CACHE_TTL_SECONDS = 600;

type CachedTemplateFlowFacts = { wabaId: string; facts: TemplateFlowFacts };

// Keyed by Flow id alone so a Flow mutation can clear it without knowing the
// WABA. The stored WABA keeps one account from reading another's answer. v2
// facts carry the answer schema, so no v1 answer without one is served.
function templateFlowFactsCacheKey(flowId: string): string {
  return buildCacheKey("whatsapp:template-flow-facts:v2", [flowId]);
}

export async function readCachedTemplateFlowFacts(params: {
  flowId: string;
  wabaId: string;
  now?: () => Date;
}): Promise<TemplateFlowFacts | null> {
  try {
    const cached = await cache.get<Partial<CachedTemplateFlowFacts>>(
      templateFlowFactsCacheKey(params.flowId)
    );
    const facts = cached?.facts;
    if (
      !cached ||
      cached.wabaId !== params.wabaId ||
      !isTemplateFlowFacts(facts) ||
      facts.flowId !== params.flowId ||
      !isTemplateFlowFactsDefinitive(facts)
    ) {
      return null;
    }
    const nowMs = (params.now?.() ?? new Date()).getTime();
    const ageMs = nowMs - Date.parse(facts.checkedAt);
    return ageMs >= 0 && ageMs < TEMPLATE_FLOW_FACTS_CACHE_TTL_SECONDS * 1000
      ? facts
      : null;
  } catch {
    // A cache outage falls back to reading Meta.
    return null;
  }
}

export async function writeCachedTemplateFlowFacts(params: {
  wabaId: string;
  facts: TemplateFlowFacts;
}): Promise<void> {
  if (!isTemplateFlowFactsDefinitive(params.facts)) return;
  try {
    await cache.set<CachedTemplateFlowFacts>(
      templateFlowFactsCacheKey(params.facts.flowId),
      { wabaId: params.wabaId, facts: params.facts },
      TEMPLATE_FLOW_FACTS_CACHE_TTL_SECONDS
    );
  } catch {
    // The completed Meta read stays authoritative for this response.
  }
}

export async function invalidateTemplateFlowFacts(
  flowId: string
): Promise<void> {
  try {
    await cache.del(templateFlowFactsCacheKey(flowId));
  } catch {
    // Expiry still bounds how long a stale answer can live.
  }
}
