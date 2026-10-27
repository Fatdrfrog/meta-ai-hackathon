import assert from "node:assert/strict";
import test from "node:test";

import { persistOrRecoverAndLink } from "./persist-recover-link";

test("links a pre-existing record before reporting a duplicate", async () => {
  const operations: string[] = [];
  const existing = { id: "message-1" };

  const result = await persistOrRecoverAndLink({
    findExisting: async () => {
      operations.push("find");
      return existing;
    },
    persist: async () => {
      operations.push("persist");
      return { id: "message-new" };
    },
    isDuplicateError: () => false,
    link: async (message) => {
      operations.push(`link:${message.id}`);
      return { appended: false };
    },
  });

  assert.deepEqual(operations, ["find", "link:message-1"]);
  assert.deepEqual(result, {
    record: existing,
    created: false,
    linkResult: { appended: false },
  });
});

test("recovers a concurrent duplicate and links the persisted record", async () => {
  const operations: string[] = [];
  const duplicateError = Object.assign(new Error("duplicate"), { code: 11000 });
  let findAttempt = 0;

  const result = await persistOrRecoverAndLink({
    findExisting: async () => {
      operations.push("find");
      findAttempt += 1;
      return findAttempt === 1 ? null : { id: "message-raced" };
    },
    persist: async () => {
      operations.push("persist");
      throw duplicateError;
    },
    isDuplicateError: (error) => error === duplicateError,
    link: async (message) => {
      operations.push(`link:${message.id}`);
      return { appended: true };
    },
  });

  assert.deepEqual(operations, [
    "find",
    "persist",
    "find",
    "link:message-raced",
  ]);
  assert.equal(result.created, false);
  assert.deepEqual(result.linkResult, { appended: true });
});

test("propagates link failures for both new and recovered records", async () => {
  const linkError = new Error("append failed");

  await assert.rejects(
    persistOrRecoverAndLink({
      findExisting: async () => ({ id: "message-existing" }),
      persist: async () => ({ id: "message-new" }),
      isDuplicateError: () => false,
      link: async () => {
        throw linkError;
      },
    }),
    linkError,
  );

  await assert.rejects(
    persistOrRecoverAndLink({
      findExisting: async () => null,
      persist: async () => ({ id: "message-new" }),
      isDuplicateError: () => false,
      link: async () => {
        throw linkError;
      },
    }),
    linkError,
  );
});

test("rethrows a duplicate insert when the winning record cannot be resolved", async () => {
  const duplicateError = Object.assign(new Error("duplicate"), { code: 11000 });

  await assert.rejects(
    persistOrRecoverAndLink({
      findExisting: async () => null,
      persist: async () => {
        throw duplicateError;
      },
      isDuplicateError: (error) => error === duplicateError,
      link: async () => undefined,
    }),
    duplicateError,
  );
});
