import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ScenarioNodeData } from "@icecore/scenario-contracts";
import { resolveScenarioActionTypeFromNodeData } from "./scenario-action-semantics";
import { getCompiledScenarioGraph } from "./scenario-graph";

describe("resolveScenarioActionTypeFromNodeData", () => {
  for (const source of [7, {}, [], true]) {
    it(`compiles persisted actions with a malformed legacy source: ${JSON.stringify(source)}`, () => {
      assert.doesNotThrow(() =>
        getCompiledScenarioGraph({
          nodes: [{ id: "action", data: { kind: "action", source } }],
          edges: [],
        }),
      );
    });
  }

  for (const { label, actionWhatsAppServiceMessage } of [
    {
      label: "supported",
      actionWhatsAppServiceMessage: {
        version: 1,
        message: {
          kind: "text",
          body: { mode: "fixed", text: "Canonical" },
        },
      },
    },
    {
      label: "future",
      actionWhatsAppServiceMessage: {
        version: 99,
        message: { kind: "future" },
      },
    },
  ]) {
    it(`keeps a ${label} canonical service owner authoritative over stale action type`, () => {
      assert.equal(
        resolveScenarioActionTypeFromNodeData({
          kind: "action",
          actionType: "whatsapp_template",
          actionWhatsAppServiceMessage,
        } as unknown as ScenarioNodeData),
        "reply",
      );
    });
  }

  it("treats an undefined canonical clear marker as absent", () => {
    assert.equal(
      resolveScenarioActionTypeFromNodeData({
        kind: "action",
        actionType: "whatsapp_template",
        actionWhatsAppServiceMessage: undefined,
      }),
      "whatsapp_template",
    );
  });
});
