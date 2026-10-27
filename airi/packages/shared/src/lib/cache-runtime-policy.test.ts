import assert from "node:assert/strict";
import test from "node:test";

/**
 * A tiny Upstash REST stand-in: GET/SET/DEL/SCAN over a Map, single
 * commands and auto-pipelined batches, with every command recorded.
 */
const store = new Map<string, string>();
const commands: string[][] = [];

function run(command: unknown[]): unknown {
  const [rawName = "", ...args] = command.map(String);
  const name = rawName.toUpperCase();
  const key = args[0] ?? "";
  commands.push([name, ...args]);
  switch (name) {
    case "GET":
      return store.get(key) ?? null;
    case "SET":
      store.set(key, args[1] ?? "");
      return "OK";
    case "DEL": {
      let removed = 0;
      for (const key of args) removed += store.delete(key) ? 1 : 0;
      return removed;
    }
    case "SCAN": {
      const match = args[args.indexOf("MATCH") + 1] || "*";
      const prefix = match.endsWith("*") ? match.slice(0, -1) : match;
      return ["0", [...store.keys()].filter((key) => key.startsWith(prefix))];
    }
    default:
      return null;
  }
}

/** The client asks for base64 results and decodes every string it gets. */
function encode(value: unknown, base64: boolean): unknown {
  if (!base64) return value;
  if (typeof value === "string") return Buffer.from(value).toString("base64");
  if (Array.isArray(value)) return value.map((item) => encode(item, base64));
  return value;
}

process.env.NODE_ENV = "production";
process.env.UPSTASH_REDIS_REST_URL = "https://cache-policy.upstash.test";
process.env.UPSTASH_REDIS_REST_TOKEN = "test-token";
globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
  const url = String(input);
  const headers = new Headers(init?.headers);
  const base64 = headers.get("upstash-encoding") === "base64";
  const body = JSON.parse(String(init?.body ?? "[]")) as unknown[];
  const payload = /\/(pipeline|multi-exec)$/.test(url)
    ? (body as unknown[][]).map((command) => ({
        result: encode(run(command), base64),
      }))
    : { result: encode(run(body), base64) };
  return new Response(JSON.stringify(payload), {
    headers: { "content-type": "application/json" },
  });
}) as typeof fetch;

async function loadCache() {
  return import("./cache");
}

function reset() {
  store.clear();
  commands.length = 0;
}

test("local keys stay in this process and come back as copies", async () => {
  const { cache, configureCacheRuntimePolicy } = await loadCache();
  reset();
  configureCacheRuntimePolicy({ localPrefixes: ["icecore:ai:hyde:"] });
  try {
    const value = { answer: "Delivery takes two days", sources: ["kb-1"] };
    await cache.set("icecore:ai:hyde:abc", value, 60);
    const first = await cache.get<typeof value>("icecore:ai:hyde:abc");
    assert.deepEqual(first, value);
    first!.sources.push("mutated");
    assert.deepEqual(await cache.get("icecore:ai:hyde:abc"), value);
    assert.deepEqual(await cache.readWithStatus("icecore:ai:hyde:abc"), {
      status: "hit",
      value,
    });
    await cache.del("icecore:ai:hyde:abc");
    assert.equal(await cache.get("icecore:ai:hyde:abc"), null);
    assert.deepEqual(commands, [], "Upstash is never called for local keys");
  } finally {
    configureCacheRuntimePolicy(null);
  }
});

test("local keys expire with their TTL", async (t) => {
  const { cache, configureCacheRuntimePolicy } = await loadCache();
  reset();
  configureCacheRuntimePolicy({ localPrefixes: ["icecore:ai:hyde:"] });
  const realNow = Date.now;
  t.after(() => {
    Date.now = realNow;
    configureCacheRuntimePolicy(null);
  });
  let now = realNow();
  Date.now = () => now;
  await cache.set("icecore:ai:hyde:ttl", "answer", 30);
  now += 29_000;
  assert.equal(await cache.get("icecore:ai:hyde:ttl"), "answer");
  now += 2_000;
  assert.equal(await cache.get("icecore:ai:hyde:ttl"), null);
});

test("bypassed keys are never read or written, but deletes still reach Upstash", async () => {
  const { cache, configureCacheRuntimePolicy } = await loadCache();
  reset();
  store.set(
    "icecore:company-usage-snapshot:company-1",
    JSON.stringify({ conversation_count: 5 }),
  );
  configureCacheRuntimePolicy({
    bypassPrefixes: ["icecore:company-usage-snapshot:"],
  });
  try {
    assert.equal(
      await cache.get("icecore:company-usage-snapshot:company-1"),
      null,
    );
    assert.deepEqual(
      await cache.readWithStatus("icecore:company-usage-snapshot:company-1"),
      { status: "miss" },
    );
    await cache.set("icecore:company-usage-snapshot:company-1", { n: 1 }, 20);
    assert.deepEqual(commands, [], "no read or write reached Upstash");

    await cache.del("icecore:company-usage-snapshot:company-1");
    assert.deepEqual(commands, [
      ["DEL", "icecore:company-usage-snapshot:company-1"],
    ]);
  } finally {
    configureCacheRuntimePolicy(null);
  }
});

test("keys outside the policy keep using Upstash", async () => {
  const { cache, configureCacheRuntimePolicy } = await loadCache();
  reset();
  configureCacheRuntimePolicy({
    localPrefixes: ["icecore:ai:hyde:"],
    bypassPrefixes: ["icecore:company-usage-snapshot:"],
  });
  try {
    await cache.set("icecore:kb:retrieval:v3:workspace-1:q", ["kb-1"], 600);
    assert.deepEqual(
      await cache.get("icecore:kb:retrieval:v3:workspace-1:q"),
      ["kb-1"],
    );
    assert.deepEqual(
      commands.map(([name]) => name),
      ["SET", "GET"],
    );
  } finally {
    configureCacheRuntimePolicy(null);
  }
});

test("prefix invalidation also clears matching local keys", async () => {
  const { cache, configureCacheRuntimePolicy, invalidateCacheByPrefix } =
    await loadCache();
  reset();
  configureCacheRuntimePolicy({ localPrefixes: ["icecore:ai:hyde:"] });
  try {
    await cache.set("icecore:ai:hyde:one", "a", 60);
    await cache.set("icecore:ai:hyde:two", "b", 60);
    await invalidateCacheByPrefix("icecore:ai:hyde:");
    assert.equal(await cache.get("icecore:ai:hyde:one"), null);
    assert.equal(await cache.get("icecore:ai:hyde:two"), null);
  } finally {
    configureCacheRuntimePolicy(null);
  }
});

test("the policy is shared across copies of the module through globalThis", async () => {
  const { configureCacheRuntimePolicy } = await loadCache();
  configureCacheRuntimePolicy({ localPrefixes: ["icecore:ai:hyde:"] });
  try {
    const state = (globalThis as Record<symbol, unknown>)[
      Symbol.for("icecore.cache.runtimePolicy")
    ] as { localPrefixes: string[] } | undefined;
    assert.deepEqual(state?.localPrefixes, ["icecore:ai:hyde:"]);
  } finally {
    configureCacheRuntimePolicy(null);
  }
  assert.equal(
    (globalThis as Record<symbol, unknown>)[
      Symbol.for("icecore.cache.runtimePolicy")
    ],
    undefined,
  );
});
