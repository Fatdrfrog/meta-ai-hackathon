import assert from "node:assert/strict";
import test from "node:test";

import { isScenarioAutomationPausedByHandoff } from "./scenario-handoff-policy";

test("handoff pause is the boolean conversation flag, nothing else", () => {
  assert.equal(isScenarioAutomationPausedByHandoff(true), true);
  assert.equal(isScenarioAutomationPausedByHandoff(false), false);
  assert.equal(isScenarioAutomationPausedByHandoff(null), false);
  assert.equal(isScenarioAutomationPausedByHandoff(undefined), false);
});
