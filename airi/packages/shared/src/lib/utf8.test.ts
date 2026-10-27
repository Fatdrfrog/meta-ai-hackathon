import assert from "node:assert/strict";
import test from "node:test";

import { truncateUtf8, utf8ByteLength } from "./utf8";

test("utf8ByteLength counts UTF-8 bytes", () => {
  assert.equal(utf8ByteLength("abc"), 3);
  assert.equal(utf8ByteLength("я"), 2);
  assert.equal(utf8ByteLength("€"), 3);
  assert.equal(utf8ByteLength("😀"), 4);
});

test("truncateUtf8 keeps whole characters within the byte budget", () => {
  assert.equal(truncateUtf8("abc", 3), "abc");
  assert.equal(truncateUtf8("abcdef", 4), "abcd");
  assert.equal(truncateUtf8("яяя", 5), "яя");
  assert.equal(
    truncateUtf8(`${"a".repeat(996)}😀b`, 1000),
    `${"a".repeat(996)}😀`,
  );
  assert.equal(truncateUtf8(`${"a".repeat(997)}😀`, 1000), "a".repeat(997));
  assert.equal(truncateUtf8("anything", 0), "");
});

test("truncateUtf8 never exceeds the budget it was given", () => {
  const sample = "Сәлем 🌍 — 你好 hello";
  for (let budget = 0; budget <= utf8ByteLength(sample); budget += 1) {
    const result = truncateUtf8(sample, budget);
    assert.ok(utf8ByteLength(result) <= budget);
    assert.ok(sample.startsWith(result));
  }
});

test("utf8ByteLength matches Node's UTF-8 encoder, lone surrogates included", () => {
  for (const value of [
    "",
    "abc",
    "Сәлем 🌍 — 你好",
    "\ud800",
    "a\udc00b",
    "😀😀",
  ]) {
    assert.equal(utf8ByteLength(value), Buffer.byteLength(value, "utf8"));
  }
});
