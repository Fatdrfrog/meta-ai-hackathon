import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";

import { buildCacheKey } from "@icecore/shared/lib/cache";
import {
  configureCacheRuntimePolicy,
  getRuntimeCachePlacement,
} from "@icecore/shared/lib/cache-runtime-policy";

import { GCP_RUNTIME_CACHE_POLICY } from "./cache-runtime-policy.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function source(path: string): string {
  return readFileSync(resolve(repoRoot, path), "utf8");
}

afterEach(() => {
  configureCacheRuntimePolicy(null);
});

/**
 * Each placed key family: where the call site builds it, the literal it
 * builds it from, and a key built the same way.
 */
const PLACED_KEYS = [
  {
    placement: "local",
    file: "apps/web/src/lib/airi/rag/query/query-cleaner.ts",
    literal: 'const RAG_PREP_CACHE_PREFIX = "ai:rag-query-prep:v2";',
    key: buildCacheKey("ai:rag-query-prep:v2", ["hash"]),
  },
  {
    placement: "local",
    file: "apps/web/src/lib/airi/rag/pipeline/hyde.ts",
    literal: 'buildCacheKey("ai:hyde", [hash])',
    key: buildCacheKey("ai:hyde", ["hash"]),
  },
  {
    placement: "local",
    file: "apps/web/src/lib/airi/rag/query/query-translator.ts",
    literal: "buildCacheKey(`ai:${purpose}-translation`, [",
    key: buildCacheKey("ai:query-translation", ["hash", "ru"]),
  },
  {
    placement: "local",
    file: "apps/web/src/lib/airi/rag/query/query-translator.ts",
    literal: 'purpose: "query" | "answer";',
    key: buildCacheKey("ai:answer-translation", ["hash", "kk"]),
  },
  {
    placement: "local",
    file: "apps/web/src/lib/airi/reply/generation/reply-language.ts",
    literal: 'buildCacheKey("airi:reply-translation:v1", [',
    key: buildCacheKey("airi:reply-translation:v1", ["hash", "ru"]),
  },
  {
    placement: "local",
    file: "apps/web/src/lib/ai/embeddings.ts",
    literal: "buildCacheKey(`ai:embedding:${EMBEDDING_CACHE_VERSION}`, [",
    key: buildCacheKey("ai:embedding:v2", ["model", "hash"]),
  },
  {
    placement: "local",
    file: "apps/web/src/lib/airi/rag/kb/kb-retrieval.ts",
    literal: 'buildCacheKey("kb:workspace-company:v1", [',
    key: buildCacheKey("kb:workspace-company:v1", ["workspace-1"]),
  },
  {
    placement: "local",
    file: "packages/shared/src/lib/company-runtime-capacity.ts",
    literal: "const key = `company-runtime:workspace:${workspaceId}`;",
    key: "company-runtime:workspace:workspace-1",
  },
  {
    placement: "bypass",
    file: "apps/web/src/lib/airi/workspace-bot-default.ts",
    literal:
      'buildCacheKey("airi:workspace-bot-runtime-settings", [workspaceId])',
    key: buildCacheKey("airi:workspace-bot-runtime-settings", ["workspace-1"]),
  },
  {
    placement: "bypass",
    file: "apps/web/src/lib/limits/company-usage-snapshots.ts",
    literal: 'buildCacheKey("company-usage-snapshot", [companyId])',
    key: buildCacheKey("company-usage-snapshot", ["company-1"]),
  },
] as const;

test("each placed prefix matches a key family its call site still builds", () => {
  configureCacheRuntimePolicy(GCP_RUNTIME_CACHE_POLICY);
  for (const entry of PLACED_KEYS) {
    assert.ok(
      source(entry.file).includes(entry.literal),
      `${entry.file} no longer builds its key from ${entry.literal}`,
    );
    assert.equal(
      getRuntimeCachePlacement(entry.key),
      entry.placement,
      entry.key,
    );
  }
});

test("every configured prefix is exercised by a known key family", () => {
  const prefixes = [
    ...(GCP_RUNTIME_CACHE_POLICY.localPrefixes ?? []),
    ...(GCP_RUNTIME_CACHE_POLICY.bypassPrefixes ?? []),
  ];
  for (const prefix of prefixes) {
    assert.ok(
      PLACED_KEYS.some((entry) => entry.key.startsWith(prefix)),
      `no known key family starts with ${prefix}`,
    );
  }
});

test("caches other runtimes invalidate, and every lock or limit, stay on Upstash", () => {
  configureCacheRuntimePolicy(GCP_RUNTIME_CACHE_POLICY);
  assert.ok(
    source("apps/web/src/lib/airi/rag/kb/kb-cache.ts").includes(
      "buildCacheKey(`kb:retrieval:${KB_RETRIEVAL_CACHE_VERSION}`, parts)",
    ),
  );
  for (const key of [
    buildCacheKey("kb:retrieval:v3", ["workspace-1", "query"]),
    buildCacheKey("kb:search:v1", ["workspace-1", "query"]),
    buildCacheKey("airi:greeted", ["conversation-1", "2026-10-22"]),
    buildCacheKey("company_conversation_visibility_gate", ["workspace-1"]),
    "company-runtime:conversation:company-1:0",
    "company-runtime:history:company-1:0",
    "company-runtime:ingress:company-1",
  ]) {
    assert.equal(getRuntimeCachePlacement(key), null, key);
  }
});
