import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyMetaMessageFailureScope,
  isMetaProviderRestrictionCode,
} from "./message-failure-scope";

test("classifies Meta message errors by retry ownership", () => {
  for (const code of [
    130472, 130497, 131021, 131026, 131047, 131049, 131050, 131056,
  ]) {
    assert.equal(classifyMetaMessageFailureScope(code), "recipient");
  }

  for (const code of [
    3, 4, 10, 190, 200, 368, 80007, 130429, 131005, 131016, 131031, 131037,
    131042, 131048, 131057,
  ]) {
    assert.equal(classifyMetaMessageFailureScope(String(code)), "provider");
  }

  assert.equal(classifyMetaMessageFailureScope(999999), "unknown");
  assert.equal(classifyMetaMessageFailureScope(null), "unknown");
});

test("classifies marketing routing and template enforcement as sender failures", () => {
  for (const code of [131063, 131064, "131063", " 131064 "]) {
    assert.equal(classifyMetaMessageFailureScope(code), "provider");
  }
});

test("treats every provider failure except throughput as a restriction", () => {
  for (const code of [131048, "131042", " 131063 ", 368]) {
    assert.equal(isMetaProviderRestrictionCode(code), true);
  }
  for (const code of [130429, "130429", " 130429 ", 131026, 999999, null]) {
    assert.equal(isMetaProviderRestrictionCode(code), false);
  }
});
