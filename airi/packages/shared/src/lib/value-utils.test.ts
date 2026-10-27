import assert from "node:assert/strict";
import test from "node:test";

import {
  cleanString,
  firstOrSelf,
  hasExactKeys,
  isNonEmptyString,
  isNonNegativeSafeInteger,
  isPlainRecord,
  isRecord,
  isValidDate,
  readArray,
  readDate,
  readFiniteNumber,
  readIdString,
  readNonEmptyString,
  readNonNegativeCount,
  readStringOrEmpty,
  readTrimmedString,
  readUniqueStringArray,
  requireNonEmptyString,
  toArray,
  unwrapSettled,
} from "./value-utils";

test("isPlainRecord accepts plain and null-prototype objects only", () => {
  class Example {}
  const throwingPrototype = new Proxy(
    {},
    {
      getPrototypeOf() {
        throw new Error("trap");
      },
    },
  );
  const { proxy: revoked, revoke } = Proxy.revocable({}, {});
  revoke();

  assert.equal(isPlainRecord({ a: 1 }), true);
  assert.equal(isPlainRecord(Object.create(null)), true);
  assert.equal(isPlainRecord([]), false);
  assert.equal(isPlainRecord(null), false);
  assert.equal(isPlainRecord("text"), false);
  assert.equal(isPlainRecord(new Example()), false);
  assert.equal(isPlainRecord(new Date()), false);
  assert.equal(isPlainRecord(new Map()), false);
  assert.equal(isPlainRecord(throwingPrototype), false);
  // Array.isArray throws on a revoked Proxy before the prototype is read.
  assert.throws(() => isPlainRecord(revoked), TypeError);
  // isRecord stays the looser guard
  assert.equal(isRecord(new Example()), true);
});

test("hasExactKeys compares own enumerable keys regardless of order", () => {
  assert.equal(hasExactKeys({ a: 1, b: 2 }, ["b", "a"]), true);
  assert.equal(hasExactKeys({}, []), true);
  assert.equal(hasExactKeys({ a: 1 }, ["a", "b"]), false);
  assert.equal(hasExactKeys({ a: 1, c: 3 }, ["a", "b"]), false);
  assert.equal(hasExactKeys({ a: 1, b: 2, c: 3 }, ["a", "b"]), false);
});

test("readTrimmedString and cleanString trim strings and reject other types", () => {
  assert.equal(readTrimmedString("  hi  "), "hi");
  assert.equal(readTrimmedString("   "), "");
  assert.equal(readTrimmedString(""), "");
  assert.equal(readTrimmedString(42), "");
  assert.equal(readTrimmedString(null), "");
  assert.equal(cleanString("  abcdef  ", 3), "abc");
  assert.equal(cleanString("  ab  ", 10), "ab");
  assert.equal(cleanString("   ", 3), "");
  assert.equal(cleanString(undefined, 3), "");
});

test("the maxLength read option applies after normalization", () => {
  assert.equal(readStringOrEmpty("  a   b  c ", { maxLength: 4 }), "  a ");
  assert.equal(
    readStringOrEmpty("  a   b  c ", {
      normalizeWhitespace: true,
      maxLength: 4,
    }),
    "a b ",
  );
  assert.equal(
    readNonEmptyString("  abc ", { trim: true, maxLength: 2 }),
    "ab",
  );
  assert.equal(readNonEmptyString("   ", { trim: true, maxLength: 2 }), null);
});

test("isNonEmptyString needs non-whitespace text", () => {
  assert.equal(isNonEmptyString(" a "), true);
  assert.equal(isNonEmptyString(""), false);
  assert.equal(isNonEmptyString(" \n\t "), false);
  assert.equal(isNonEmptyString(1), false);
  assert.equal(isNonEmptyString(null), false);
});

test("requireNonEmptyString returns trimmed text or throws `${label} is required`", () => {
  assert.equal(requireNonEmptyString("  id  ", "workspaceId"), "id");
  assert.throws(() => requireNonEmptyString("", "workspaceId"), {
    name: "Error",
    message: "workspaceId is required",
  });
  assert.throws(() => requireNonEmptyString("   ", "workspaceId"), {
    message: "workspaceId is required",
  });
  assert.throws(() => requireNonEmptyString(7, "workspaceId"), {
    message: "workspaceId is required",
  });

  class InputError extends Error {}
  assert.throws(
    () =>
      requireNonEmptyString(null, "name", (message) => new InputError(message)),
    (error: unknown) =>
      error instanceof InputError && error.message === "name is required",
  );
});

test("readIdString handles strings, numbers and toString objects", () => {
  const objectId = { toString: () => "65f0c0ffee" };
  assert.equal(readIdString("  abc "), "abc");
  assert.equal(readIdString("   "), null);
  assert.equal(readIdString(12), "12");
  assert.equal(readIdString(objectId), "65f0c0ffee");
  assert.equal(readIdString({ id: "x" }), null);
  assert.equal(readIdString(true), null);
  assert.equal(readIdString(null), null);
});

test("readUniqueStringArray trims, drops empties and keeps first-seen order", () => {
  assert.deepEqual(readUniqueStringArray([" b ", "a", "b", "", "  ", 3, "a"]), [
    "b",
    "a",
  ]);
  assert.deepEqual(readUniqueStringArray("a"), []);
  assert.deepEqual(readUniqueStringArray(null), []);
});

test("readDate accepts valid Dates and date strings only", () => {
  const date = new Date("2026-10-01T00:00:00.000Z");
  assert.equal(readDate(date), date);
  assert.equal(readDate(new Date("nope")), null);
  assert.equal(
    readDate("2026-10-01T00:00:00.000Z")?.toISOString(),
    "2026-10-01T00:00:00.000Z",
  );
  assert.equal(readDate(""), null);
  assert.equal(readDate("   "), null);
  assert.equal(readDate("not a date"), null);
  assert.equal(readDate(1_700_000_000_000), null);
  assert.equal(readDate(null), null);
  assert.equal(isValidDate(date), true);
  assert.equal(isValidDate(new Date(Number.NaN)), false);
  assert.equal(isValidDate("2026-10-01"), false);
});

test("number guards", () => {
  assert.equal(readFiniteNumber(1.5), 1.5);
  assert.equal(readFiniteNumber(Number.NaN), null);
  assert.equal(readFiniteNumber(Number.POSITIVE_INFINITY), null);
  assert.equal(readFiniteNumber("1"), null);

  assert.equal(isNonNegativeSafeInteger(0), true);
  assert.equal(isNonNegativeSafeInteger(3), true);
  assert.equal(isNonNegativeSafeInteger(-1), false);
  assert.equal(isNonNegativeSafeInteger(1.5), false);
  assert.equal(isNonNegativeSafeInteger(Number.MAX_SAFE_INTEGER + 1), false);
  assert.equal(isNonNegativeSafeInteger("3"), false);

  assert.equal(readNonNegativeCount(3.9), 3);
  assert.equal(readNonNegativeCount("12abc"), 12);
  assert.equal(readNonNegativeCount("-4"), 0);
  assert.equal(readNonNegativeCount(-1), 0);
  assert.equal(readNonNegativeCount(Number.NaN), 0);
  assert.equal(readNonNegativeCount(null), 0);
  assert.equal(readNonNegativeCount(""), 0);
});

test("array helpers", () => {
  const list = [1, 2];
  assert.equal(readArray(list), list);
  assert.deepEqual(readArray({ length: 1 }), []);
  assert.deepEqual(readArray(null), []);

  assert.equal(toArray(list), list);
  assert.deepEqual(toArray(3), [3]);
  assert.deepEqual(toArray(0), [0]);
  assert.deepEqual(toArray(null), []);
  assert.deepEqual(toArray(undefined), []);

  assert.equal(firstOrSelf([{ id: 1 }, { id: 2 }])?.id, 1);
  assert.equal(firstOrSelf([]), null);
  assert.deepEqual(firstOrSelf({ id: 3 }), { id: 3 });
  assert.equal(firstOrSelf(null), null);
  assert.equal(firstOrSelf(undefined), null);
});

test("unwrapSettled returns fulfilled values and rethrows the original rejection", async () => {
  const failure = new Error("read failed");
  const [ok, failed] = await Promise.allSettled([
    Promise.resolve(7),
    Promise.reject(failure),
  ]);
  assert.equal(unwrapSettled(ok), 7);
  assert.throws(
    () => unwrapSettled(failed),
    (error) => error === failure,
  );
});
