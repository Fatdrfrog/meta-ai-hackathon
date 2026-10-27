import assert from "node:assert/strict";
import { it } from "node:test";
import {
  DEFAULT_SCENARIO_ENTRY_POLICY,
  DEFAULT_SCENARIO_PRIORITY,
  normalizeScenarioEntryPolicy,
  normalizeScenarioPriority,
  normalizeScenarioTimezone,
  isScenarioViewport,
} from "./scenario-dto.ts";

it("falls back to UTC for missing and invalid timezone identifiers", () => {
  for (const timezone of [
    undefined,
    null,
    42,
    "",
    "  ",
    "Not/A_Timezone",
    "UTC+25",
  ]) {
    assert.equal(normalizeScenarioTimezone(timezone), "UTC");
  }
});

it("preserves supported timezone identifiers and trims surrounding whitespace", () => {
  for (const timezone of [
    "UTC",
    "Asia/Qyzylorda",
    "America/New_York",
    "US/Eastern",
  ]) {
    assert.equal(normalizeScenarioTimezone(` ${timezone} `), timezone);
  }
});

it("defaults invalid persisted priority and entry policy values", () => {
  assert.equal(normalizeScenarioPriority("highest"), DEFAULT_SCENARIO_PRIORITY);
  assert.equal(
    normalizeScenarioEntryPolicy("permanent"),
    DEFAULT_SCENARIO_ENTRY_POLICY,
  );
});

it("accepts only finite viewport coordinates and positive finite zoom", () => {
  assert.equal(isScenarioViewport({ x: -1, y: 2, zoom: 0.5 }), true);
  for (const viewport of [
    { x: NaN, y: 0, zoom: 1 },
    { x: 0, y: Infinity, zoom: 1 },
    { x: 0, y: 0, zoom: Infinity },
    { x: 0, y: 0, zoom: 0 },
    { x: 0, y: 0, zoom: -1 },
  ]) {
    assert.equal(isScenarioViewport(viewport), false);
  }
});
