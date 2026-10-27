import assert from "node:assert/strict";
import test from "node:test";

import { shouldProcessEvenIfDuplicate } from "./webhookMessageDedupe";

test("allows mutable WhatsApp webhook events to process even when their message id exists", () => {
  assert.equal(shouldProcessEvenIfDuplicate("edit"), true);
  assert.equal(shouldProcessEvenIfDuplicate("revoke"), true);
  assert.equal(shouldProcessEvenIfDuplicate("reaction"), true);
});

test("blocks normal duplicate WhatsApp messages before processing", () => {
  assert.equal(shouldProcessEvenIfDuplicate("text"), false);
  assert.equal(shouldProcessEvenIfDuplicate("image"), false);
  assert.equal(shouldProcessEvenIfDuplicate(undefined), false);
});
