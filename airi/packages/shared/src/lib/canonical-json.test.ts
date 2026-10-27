import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { runInNewContext } from "node:vm";
import {
  CanonicalJsonSerializationError,
  serializeCanonicalJson,
  sha256CanonicalJson,
} from "./canonical-json";

test("sha256CanonicalJson matches Node's SHA-256 of the canonical UTF-8 text", () => {
  for (const value of [
    null,
    { z: 1, a: ["é", "😀"] },
    { long: "x".repeat(200), nested: { b: true, a: 0 } },
  ]) {
    assert.equal(
      sha256CanonicalJson(value),
      createHash("sha256")
        .update(serializeCanonicalJson(value), "utf8")
        .digest("hex"),
    );
  }
});

test("serializeCanonicalJson orders object keys by Unicode code unit without changing arrays", () => {
  const value = {
    z: 1,
    "\u00e9": 2,
    a: ["last", "first"],
    "\ud83d\ude00": 3,
  };

  assert.equal(
    serializeCanonicalJson(value),
    '{"a":["last","first"],"z":1,"\u00e9":2,"\ud83d\ude00":3}',
  );
});

test("serializeCanonicalJson uses JSON primitives exactly", () => {
  assert.equal(serializeCanonicalJson(null), "null");
  assert.equal(serializeCanonicalJson(true), "true");
  assert.equal(serializeCanonicalJson("line\nfeed"), '"line\\nfeed"');
  assert.equal(serializeCanonicalJson(42), "42");
});

test("serializeCanonicalJson accepts plain JSON objects created in another realm", () => {
  const value = runInNewContext(
    'JSON.parse(\'{"nested":{"b":2,"a":1},"items":[{"ok":true}]}\')',
  );

  assert.equal(
    serializeCanonicalJson(value),
    '{"items":[{"ok":true}],"nested":{"a":1,"b":2}}',
  );
});

test("serializeCanonicalJson accepts plain JSON parsed from a Request body", async () => {
  const value = await new Request("https://example.com", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ nested: { b: 2, a: 1 } }),
  }).json();

  assert.equal(serializeCanonicalJson(value), '{"nested":{"a":1,"b":2}}');
});

test("serializeCanonicalJson rejects custom objects with a null-parent intermediate prototype", () => {
  const customPrototype = Object.create(null) as Record<string, unknown>;
  Object.defineProperty(customPrototype, "constructor", {
    configurable: true,
    value: class CustomPrototype {},
  });
  const value = Object.assign(Object.create(customPrototype), { safe: true });

  assert.throws(
    () => serializeCanonicalJson(value),
    CanonicalJsonSerializationError,
  );
});

test("serializeCanonicalJson rejects a custom prototype spoofing Object constructor", () => {
  const customPrototype = Object.create(null) as Record<string, unknown>;
  Object.defineProperty(customPrototype, "constructor", { value: Object });
  const value = Object.assign(Object.create(customPrototype), { safe: true });

  assert.throws(
    () => serializeCanonicalJson(value),
    CanonicalJsonSerializationError,
  );
});

test("serializeCanonicalJson rejects unsupported JSON values instead of omitting them", () => {
  const circular: { self?: unknown } = {};
  circular.self = circular;

  for (const value of [
    { missing: undefined },
    ["defined", , "sparse"],
    NaN,
    Infinity,
    1n,
    () => undefined,
    Symbol("value"),
    circular,
    new Date(),
    new Map(),
  ]) {
    assert.throws(
      () => serializeCanonicalJson(value),
      CanonicalJsonSerializationError,
    );
  }
});

test("serializeCanonicalJson rejects values that exceed recursive safety limits", () => {
  const deep: { child?: unknown } = {};
  let cursor = deep;
  for (let index = 0; index < 65; index += 1) {
    cursor.child = {};
    cursor = cursor.child as { child?: unknown };
  }

  assert.throws(
    () => serializeCanonicalJson(deep),
    CanonicalJsonSerializationError,
  );
  assert.throws(
    () =>
      serializeCanonicalJson(
        Object.fromEntries(
          Array.from({ length: 10_001 }, (_, index) => [String(index), index]),
        ),
      ),
    CanonicalJsonSerializationError,
  );
  assert.throws(
    () => serializeCanonicalJson({ payload: "x".repeat(1_000_001) }),
    CanonicalJsonSerializationError,
  );
});

test("serializeCanonicalJson applies its byte limit to final nested JSON once", () => {
  const justUnderLimit = { nested: { payload: "x".repeat(999_975) } };
  const output = serializeCanonicalJson(justUnderLimit);

  assert.equal(new TextEncoder().encode(output).byteLength, 1_000_000);
  assert.throws(
    () => serializeCanonicalJson({ nested: { payload: "x".repeat(999_976) } }),
    CanonicalJsonSerializationError,
  );
});

test("serializeCanonicalJson stops at the byte limit before reading later members", () => {
  const value: Record<string, unknown> = { first: "x".repeat(1_000_000) };
  Object.defineProperty(value, "later", {
    enumerable: true,
    get() {
      throw new Error("later member must not be read");
    },
  });

  assert.throws(
    () => serializeCanonicalJson(value),
    CanonicalJsonSerializationError,
  );
});

test("serializeCanonicalJson rejects an oversized UTF-8 string before stringifying it", () => {
  const oversized = "😀".repeat(250_000);
  const originalStringify = JSON.stringify;
  let oversizedStringifyCalls = 0;

  JSON.stringify = ((value: unknown) => {
    if (value === oversized) {
      oversizedStringifyCalls += 1;
      throw new Error("oversized string must not be stringified");
    }
    return originalStringify(value);
  }) as typeof JSON.stringify;

  try {
    assert.throws(
      () => serializeCanonicalJson(oversized),
      CanonicalJsonSerializationError,
    );
    assert.equal(oversizedStringifyCalls, 0);
  } finally {
    JSON.stringify = originalStringify;
  }
});

test("serializeCanonicalJson accepts an exact-limit multi-byte UTF-8 string", () => {
  const value = "é".repeat(499_999);
  const output = serializeCanonicalJson(value);

  assert.equal(new TextEncoder().encode(output).byteLength, 1_000_000);
  assert.equal(output, JSON.stringify(value));
});

test("serializeCanonicalJson permits an explicit larger byte budget without changing defaults", () => {
  const value = { payload: "x".repeat(1_000_000) };
  const output = serializeCanonicalJson(value, { maxBytes: 1_000_014 });

  assert.equal(new TextEncoder().encode(output).byteLength, 1_000_014);
  assert.throws(
    () => serializeCanonicalJson(value),
    CanonicalJsonSerializationError,
  );
  assert.throws(
    () => serializeCanonicalJson(value, { maxBytes: 1_000_013 }),
    CanonicalJsonSerializationError,
  );
});

test("serializeCanonicalJson permits an explicit larger member budget without changing defaults", () => {
  const value = Array.from({ length: 10_001 }, () => null);

  assert.equal(
    JSON.parse(serializeCanonicalJson(value, { maxMembers: 10_001 })).length,
    10_001,
  );
  assert.throws(
    () => serializeCanonicalJson(value),
    CanonicalJsonSerializationError,
  );
  assert.throws(
    () => serializeCanonicalJson(value, { maxMembers: 10_000 }),
    CanonicalJsonSerializationError,
  );
});

test("serializeCanonicalJson rejects unbounded or malformed explicit safety budgets", () => {
  for (const options of [
    { maxBytes: Infinity },
    { maxBytes: NaN },
    { maxMembers: 0 },
    { maxMembers: -1 },
    { maxDepth: 1.5 },
    { maxDepth: Number.MAX_SAFE_INTEGER + 1 },
  ]) {
    assert.throws(
      () => serializeCanonicalJson(null, options),
      CanonicalJsonSerializationError,
    );
  }
});
