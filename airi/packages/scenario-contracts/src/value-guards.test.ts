import assert from "node:assert/strict";
import test from "node:test";

import {
  asNullableRecord,
  cleanString,
  isNonEmptyString,
  isNonNegativeSafeInteger,
  isRecord,
  readNonEmptyString,
  readNonEmptyStringOrUndefined,
  readTrimmedString,
} from "./value-guards";

test("record guards accept non-array objects only", () => {
  const record = { a: 1 };
  assert.equal(isRecord(record), true);
  assert.equal(isRecord(Object.create(null)), true);
  assert.equal(isRecord([]), false);
  assert.equal(isRecord(null), false);
  assert.equal(isRecord("x"), false);
  assert.equal(asNullableRecord(record), record);
  assert.equal(asNullableRecord([1]), null);
  assert.equal(asNullableRecord(undefined), null);
});

test("string readers trim and reject non-strings", () => {
  assert.equal(readTrimmedString("  a b  "), "a b");
  assert.equal(readTrimmedString(1), "");
  assert.equal(cleanString("  abcdef ", 3), "abc");
  assert.equal(cleanString(null, 3), "");
  assert.equal(readNonEmptyString("  x "), "x");
  assert.equal(readNonEmptyString("   "), null);
  assert.equal(readNonEmptyString(undefined), null);
  assert.equal(readNonEmptyStringOrUndefined(" y"), "y");
  assert.equal(readNonEmptyStringOrUndefined(""), undefined);
  assert.equal(readNonEmptyStringOrUndefined(7), undefined);
  assert.equal(isNonEmptyString(" z "), true);
  assert.equal(isNonEmptyString(" \t"), false);
  assert.equal(isNonEmptyString(0), false);
});

test("isNonNegativeSafeInteger", () => {
  assert.equal(isNonNegativeSafeInteger(0), true);
  assert.equal(isNonNegativeSafeInteger(12), true);
  assert.equal(isNonNegativeSafeInteger(-1), false);
  assert.equal(isNonNegativeSafeInteger(1.5), false);
  assert.equal(isNonNegativeSafeInteger("1"), false);
});
