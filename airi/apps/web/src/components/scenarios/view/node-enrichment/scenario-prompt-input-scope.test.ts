import assert from "node:assert/strict";
import { PROMPT_INPUTS_UNMET_HANDLE } from "@icecore/scenario-contracts";
import { buildPromptInputsByNodeId } from "./scenario-prompt-input-scope";

type ScopeNode = Parameters<typeof buildPromptInputsByNodeId>[0]["nodes"][number];
type ScopeEdge = Parameters<typeof buildPromptInputsByNodeId>[0]["edges"][number];
const node = (id: string, kind = "action"): ScopeNode => ({ id, data: { kind } });
const text = (id: string): ScopeNode => ({
  id, data: { kind: "action", actionWhatsAppServiceMessage: {
    version: 1, message: { kind: "text", body: { mode: "fixed", text: "Details?" } },
    promptInputs: [{ key: "name", label: "Name", prompt: "customer name" }],
  } },
});
const flow = (id: string): ScopeNode => ({
  id, data: { kind: "action", actionWhatsAppServiceMessage: {
    message: { kind: "flow", flowConfig: { screens: [{ fields: [
      { id: "name", label: "Name", fieldType: "TextInput" },
    ] }] } },
  } },
});
const edge = (source: string, target: string, sourceHandle?: string): ScopeEdge => ({ source, target, sourceHandle });
function keys(nodes: ScopeNode[], edges: ScopeEdge[], id: string): string[] {
  return (buildPromptInputsByNodeId({ nodes, edges }).get(id) ?? []).map(field => field.key);
}

describe("prompt input predecessor scope", () => {
  it("does not offer answers on the collecting node", () => {
    assert.deepEqual(keys([text("ask"), node("next")], [edge("ask", "next")], "ask"), []);
  });
  it("does not offer text answers on unrelated nodes", () => {
    assert.deepEqual(keys([text("ask"), node("other")], [], "other"), []);
  });
  it("offers answers on the connected next action", () => {
    assert.deepEqual(keys([text("ask"), node("next")], [edge("ask", "next")], "next"), ["name"]);
  });
  it("omits answers when another path bypasses the collector", () => {
    assert.deepEqual(keys([node("root", "trigger"), text("ask"), node("next")], [edge("root", "ask"), edge("root", "next"), edge("ask", "next")], "next"), []);
  });
  it("does not leak one trigger's variables into another trigger path", () => {
    assert.deepEqual(keys([node("r1", "trigger"), node("r2", "trigger"), text("ask"), node("next")], [edge("r1", "ask"), edge("r2", "next"), edge("ask", "next")], "next"), []);
  });
  it("does not promise missing answers on the unmet branch", () => {
    assert.deepEqual(keys([text("ask"), node("followup"), node("next")], [edge("ask", "followup", PROMPT_INPUTS_UNMET_HANDLE), edge("ask", "next")], "followup"), []);
  });
  it("keeps joins reachable from the unmet branch conservative", () => {
    assert.deepEqual(keys([text("ask"), node("followup"), node("next")], [edge("ask", "followup", PROMPT_INPUTS_UNMET_HANDLE), edge("ask", "next"), edge("followup", "next")], "next"), []);
  });
  it("offers Flow fields downstream but not before submission", () => {
    const nodes = [flow("flow"), node("next")];
    const edges = [edge("flow", "next")];
    assert.deepEqual(keys(nodes, edges, "next"), ["name"]);
    assert.deepEqual(keys(nodes, edges, "flow"), []);
  });
  it("offers the text fields of a template's Flow downstream", () => {
    const template: ScopeNode = {
      id: "template",
      data: {
        kind: "action",
        actionType: "whatsapp_template",
        actionFlowConfig: {
          screens: [
            { fields: [{ id: "name", label: "Name", fieldType: "TextInput" }] },
          ],
        },
      } as ScopeNode["data"],
    };
    const nodes = [template, node("next")];
    const edges = [edge("template", "next")];
    assert.deepEqual(keys(nodes, edges, "next"), ["name"]);
    assert.deepEqual(keys(nodes, edges, "template"), []);
  });
  it("terminates on cycles and keeps the collecting node empty", () => {
    const nodes = [node("root", "trigger"), text("ask"), node("next")];
    const edges = [edge("root", "ask"), edge("ask", "next"), edge("next", "ask")];
    assert.deepEqual(keys(nodes, edges, "next"), ["name"]);
    assert.deepEqual(keys(nodes, edges, "ask"), []);
  });
});
