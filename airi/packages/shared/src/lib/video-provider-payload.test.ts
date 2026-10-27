import assert from "node:assert/strict";
import { test } from "node:test";

import { sanitizeVideoProviderPayload } from "./video-provider-payload.js";

test("scrubs secrets, signed queries, inline media, and oversized bodies", () => {
  const result = sanitizeVideoProviderPayload({
    authorization: "Bearer secret",
    nested: {
      api_key: "secret",
      url: "https://cdn.example/video.mp4?X-Goog-Signature=secret#fragment",
    },
    videoBytes: "A".repeat(100_000),
    diagnostic: "B".repeat(100_000),
  });
  const json = JSON.stringify(result);

  assert.doesNotMatch(json, /secret|X-Goog-Signature|fragment/);
  assert.ok(Buffer.byteLength(json, "utf8") <= 32 * 1024);
  assert.equal((result as { truncated?: boolean }).truncated, true);
});

test("bounds recursion, entry counts, keys, strings, and unicode bytes", () => {
  const entries = Object.fromEntries(
    Array.from({ length: 300 }, (_, index) => [
      `${"k".repeat(80)}-${index}`,
      `${"🙂".repeat(700)}-${index}`,
    ]),
  );
  const result = sanitizeVideoProviderPayload({
    deep: {
      a: { b: { c: { d: { e: { f: { g: { h: { hidden: "no" } } } } } } } },
    },
    entries,
  });
  const json = JSON.stringify(result);

  assert.ok(Buffer.byteLength(json, "utf8") <= 32 * 1024);
  assert.doesNotMatch(json, /hidden/);
  assert.ok(Object.keys((result as { entries: object }).entries).length <= 256);
});

test("sanitizes URL-looking strings without altering ordinary diagnostics", () => {
  assert.deepEqual(
    sanitizeVideoProviderPayload({
      message: "provider queued normally",
      callback: "https://provider.example/jobs/123?token=secret#status",
    }),
    {
      message: "provider queued normally",
      callback: "https://provider.example/jobs/123",
    },
  );
  assert.deepEqual(
    sanitizeVideoProviderPayload({
      callback: "  https://provider.example/jobs/1?api_key=secret#done  ",
    }),
    { callback: "https://provider.example/jobs/1" },
  );
  assert.deepEqual(
    sanitizeVideoProviderPayload({
      message:
        "download failed at https://cdn.example/video.mp4?token=secret#fragment after one request",
    }),
    {
      message:
        "download failed at https://cdn.example/video.mp4 after one request",
    },
  );
});

test("marks truncation when the oversized value is the root scalar or array", () => {
  const scalar = sanitizeVideoProviderPayload("🙂".repeat(100_000));
  const array = sanitizeVideoProviderPayload(
    Array.from({ length: 300 }, (_, index) => index),
  );

  assert.equal((scalar as { truncated?: boolean }).truncated, true);
  assert.equal((array as { truncated?: boolean }).truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(scalar), "utf8") <= 32 * 1024);
  assert.ok(Buffer.byteLength(JSON.stringify(array), "utf8") <= 32 * 1024);
});

test("redacts the original key before bounding it", () => {
  const unsafeKey = `${"x".repeat(80)}authorization`;
  const result = sanitizeVideoProviderPayload({
    [unsafeKey]: "Bearer leaked-secret",
  });

  assert.doesNotMatch(JSON.stringify(result), /leaked-secret|Bearer/);
});

test("counts redacted object entries toward the global inspection budget", () => {
  const redacted = Object.fromEntries(
    Array.from({ length: 256 }, (_, index) => [`token_${index}`, "secret"]),
  );
  const result = sanitizeVideoProviderPayload({
    ...redacted,
    safeAfterBudget: "must-not-be-inspected",
  });
  const json = JSON.stringify(result);

  assert.doesNotMatch(json, /secret|must-not-be-inspected|safeAfterBudget/);
  assert.equal((result as { truncated?: boolean }).truncated, true);
});
