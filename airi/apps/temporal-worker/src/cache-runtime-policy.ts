import type { CacheRuntimePolicy } from "@icecore/shared/lib/cache-runtime-policy";

/**
 * Cache placement for the GCP runtimes in europe-west1. Upstash is a
 * cross-region round trip from here (about 170–205 ms per call), while
 * MongoDB is about a millisecond away. Keys not listed keep using Upstash,
 * including everything another runtime invalidates (knowledge-base
 * retrieval and search, templates, greetings) and every lock or limit.
 *
 * Prefixes are literal so `main.ts` can set the policy before the Upstash
 * client exists; the test checks them against the keys the call sites build.
 */
export const GCP_RUNTIME_CACHE_POLICY: CacheRuntimePolicy = {
  /**
   * Results of the same input, or lookups that never change in practice.
   * Nothing deletes them from another runtime, so a per-process copy with
   * the same TTL behaves like the shared one.
   */
  localPrefixes: [
    "icecore:ai:rag-query-prep:v2:",
    "icecore:ai:hyde:",
    "icecore:ai:query-translation:",
    "icecore:ai:answer-translation:",
    "icecore:airi:reply-translation:v1:",
    "icecore:ai:embedding:",
    "icecore:kb:workspace-company:v1:",
    // Built without `buildCacheKey` in company-runtime-capacity.
    "company-runtime:workspace:",
  ],
  /**
   * Data this runtime reads faster from its source than from Upstash: bot
   * settings live in MongoDB, and the usage snapshot is one Supabase read.
   * Skipping the cache also makes these reads fresh. Deletes still reach
   * Upstash, so Vercel's copies are invalidated as before.
   */
  bypassPrefixes: [
    "icecore:airi:workspace-bot-runtime-settings:",
    "icecore:company-usage-snapshot:",
  ],
};
