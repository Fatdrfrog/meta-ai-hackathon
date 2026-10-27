import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isScenarioNodeDataKey,
  SCENARIO_NODE_DATA_KEYS,
  SCENARIO_NODE_DATA_NESTED_CONFIG_KEYS,
} from "./scenario-node-data.ts";

describe("frozen ScenarioNodeData key catalog", () => {
  it("keeps persisted keys unique and nested configs inside the catalog", () => {
    assert.equal(
      SCENARIO_NODE_DATA_KEYS.length,
      new Set(SCENARIO_NODE_DATA_KEYS).size,
    );
    for (const key of SCENARIO_NODE_DATA_NESTED_CONFIG_KEYS) {
      assert.equal(isScenarioNodeDataKey(key), true);
    }
    assert.equal(isScenarioNodeDataKey("actionOtpCode"), false);
    assert.equal(isScenarioNodeDataKey("uiOnPatch"), false);
  });

  it("persists template button ids as a nested config", () => {
    assert.equal(
      isScenarioNodeDataKey("actionWhatsAppTemplateButtonIds"),
      true,
    );
    assert.ok(
      (SCENARIO_NODE_DATA_NESTED_CONFIG_KEYS as readonly string[]).includes(
        "actionWhatsAppTemplateButtonIds",
      ),
    );
  });

  it("persists a template's saved form as a nested config", () => {
    assert.equal(isScenarioNodeDataKey("actionWhatsAppTemplateForm"), true);
    assert.ok(
      (SCENARIO_NODE_DATA_NESTED_CONFIG_KEYS as readonly string[]).includes(
        "actionWhatsAppTemplateForm",
      ),
    );
  });
});
