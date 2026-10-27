import assert from "node:assert/strict";
import { test } from "node:test";
import {
  issueCartSession,
  readCartSession,
} from "../src/lib/commerce/browser-session";

test("signed cart sessions preserve anonymous identity and reject forgery and cross-source reuse", async () => {
  const oldSecret = process.env.ENCRYPTION_SECRET;
  process.env.ENCRYPTION_SECRET =
    "cart-session-test-secret-never-for-production";
  try {
    const token = await issueCartSession("source-a");
    const identity = await readCartSession(token, "source-a");
    assert.match(identity!, /^[a-f0-9-]{36}$/);
    assert.equal(await readCartSession(token, "source-b"), null);
    assert.equal(
      await readCartSession(
        `forged.${token.split(".").slice(1).join(".")}`,
        "source-a"
      ),
      null
    );
    const renewed = await issueCartSession("source-a", token);
    assert.equal(await readCartSession(renewed, "source-a"), identity);
    const otherSource = await issueCartSession("source-b", token);
    assert.notEqual(await readCartSession(otherSource, "source-b"), identity);
    process.env.ENCRYPTION_SECRET = "rotated-test-secret";
    assert.equal(await readCartSession(token, "source-a"), null);
  } finally {
    if (oldSecret === undefined) delete process.env.ENCRYPTION_SECRET;
    else process.env.ENCRYPTION_SECRET = oldSecret;
  }
});
