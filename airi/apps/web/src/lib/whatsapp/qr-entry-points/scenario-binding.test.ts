import type { ScenarioNodeData } from "@icecore/scenario-contracts";

import type { ScenarioFlowNode } from "@/components/scenarios/types";

import {
  assertOrdinaryScenarioWritePreservesWhatsAppQrBindings,
  clearWhatsAppQrGraphBinding,
  collectWhatsAppQrGraphBindings,
  setWhatsAppQrGraphBinding,
} from "./scenario-binding";

function flowNode(id: string, data: ScenarioNodeData): ScenarioFlowNode {
  return {
    id,
    type: "scenario",
    position: { x: 0, y: 0 },
    data,
  };
}

function qrNode(id: string, entryPointId?: string): ScenarioFlowNode {
  return flowNode(id, {
    kind: "trigger",
    triggerConfig: {
      entryPointType: "whatsapp_qr",
      ...(entryPointId !== undefined ? { entryPointId } : {}),
    },
  });
}

describe("WhatsApp QR Scenario graph binding", () => {
  test("collects only QR triggers and normalizes their selected entry point", () => {
    const nodes = [
      qrNode("qr-selected", " entry-1 "),
      qrNode("qr-empty"),
      flowNode("message-trigger", {
        kind: "trigger",
        triggerConfig: {
          entryPointType: "message",
          entryPointId: "must-not-leak",
        },
      }),
      flowNode("action", { kind: "action" }),
    ];

    expect(collectWhatsAppQrGraphBindings(nodes)).toEqual([
      { nodeId: "qr-selected", entryPointId: "entry-1" },
      { nodeId: "qr-empty", entryPointId: null },
    ]);
  });

  test("sets only the requested QR node without mutating the input graph", () => {
    const target = flowNode("target", {
      kind: "trigger",
      triggerConfig: {
        entryPointType: "whatsapp_qr",
        enabled: false,
        messageMatchMode: "contains",
        keywordPattern: "hello",
      },
    });
    const untouched = qrNode("untouched", "entry-2");
    const nodes = [target, untouched] as const;

    const updated = setWhatsAppQrGraphBinding(nodes, "target", " entry-1 ");

    expect(updated).not.toBe(nodes);
    expect(updated[0]).not.toBe(target);
    expect(updated[0].data).not.toBe(target.data);
    expect(updated[0].data.triggerConfig).not.toBe(target.data.triggerConfig);
    expect(updated[1]).toBe(untouched);
    expect(updated[0].data.triggerConfig).toEqual({
      entryPointType: "whatsapp_qr",
      entryPointId: "entry-1",
      enabled: false,
      messageMatchMode: "contains",
      keywordMatchMode: "contains",
      keywordPattern: "hello",
    });
    expect(target.data.triggerConfig?.entryPointId).toBeUndefined();
  });

  test("rejects a missing node, a non-QR node, an invalid id, and a duplicate binding", () => {
    const action = flowNode("action", { kind: "action" });
    const nodes = [qrNode("first", "entry-1"), qrNode("second"), action];

    expect(() =>
      setWhatsAppQrGraphBinding(nodes, "missing", "entry-2")
    ).toThrow("WhatsApp QR trigger node not found");
    expect(() =>
      setWhatsAppQrGraphBinding(nodes, "action", "entry-2")
    ).toThrow("Node is not a WhatsApp QR trigger");
    expect(() => setWhatsAppQrGraphBinding(nodes, "second", "  ")).toThrow(
      "Entry point id is invalid"
    );
    expect(() =>
      setWhatsAppQrGraphBinding(nodes, "second", "entry-1")
    ).toThrow("Entry point is already bound in this Scenario");
  });

  test("clears only the requested QR node and canonicalizes its trigger config", () => {
    const target = qrNode("target", " entry-1 ");
    const untouched = qrNode("untouched", "entry-2");

    const updated = clearWhatsAppQrGraphBinding(
      [target, untouched],
      "target"
    );

    expect(updated[0]).not.toBe(target);
    expect(updated[1]).toBe(untouched);
    expect(updated[0].data.triggerConfig).toEqual({
      entryPointType: "whatsapp_qr",
      enabled: true,
      messageMatchMode: "any",
      keywordMatchMode: "contains",
    });
    expect(target.data.triggerConfig?.entryPointId).toBe(" entry-1 ");
  });

  test("accepts unchanged bindings", () => {
    const previous = [qrNode("first", "entry-1"), qrNode("second")];
    const next = previous.map(node => ({
      ...node,
      data: {
        ...node.data,
        triggerConfig: { ...node.data.triggerConfig },
      },
    }));

    expect(
      assertOrdinaryScenarioWritePreservesWhatsAppQrBindings({
        previousNodes: previous,
        nextNodes: next,
      })
    ).toEqual({ ok: true, removedNodeIds: [] });
  });

  test.each([
    {
      name: "add",
      previous: [qrNode("target")],
      next: [qrNode("target", "entry-1")],
      change: "added",
    },
    {
      name: "change",
      previous: [qrNode("target", "entry-1")],
      next: [qrNode("target", "entry-2")],
      change: "changed",
    },
    {
      name: "clear",
      previous: [qrNode("target", "entry-1")],
      next: [qrNode("target")],
      change: "cleared",
    },
  ])("rejects an ordinary pointer $name", ({ previous, next, change }) => {
    expect(
      assertOrdinaryScenarioWritePreservesWhatsAppQrBindings({
        previousNodes: previous,
        nextNodes: next,
      })
    ).toEqual({
      ok: false,
      code: "whatsapp_qr_binding_conflict",
      nodeId: "target",
      change,
    });
  });

  test("allows complete QR-node removal and type change while reporting cleanup ids", () => {
    const previous = [
      qrNode("removed", "entry-1"),
      qrNode("changed-kind", "entry-2"),
      qrNode("kept", "entry-3"),
    ];
    const next = [
      flowNode("changed-kind", { kind: "action" }),
      qrNode("kept", "entry-3"),
    ];

    expect(
      assertOrdinaryScenarioWritePreservesWhatsAppQrBindings({
        previousNodes: previous,
        nextNodes: next,
      })
    ).toEqual({
      ok: true,
      removedNodeIds: ["removed", "changed-kind"],
    });
  });

  test("rejects duplicate selected entry points in the next graph", () => {
    const previous = [qrNode("first"), qrNode("second")];
    const next = [
      qrNode("first", "entry-1"),
      qrNode("second", "entry-1"),
    ];

    expect(
      assertOrdinaryScenarioWritePreservesWhatsAppQrBindings({
        previousNodes: previous,
        nextNodes: next,
      })
    ).toEqual({
      ok: false,
      code: "whatsapp_qr_binding_conflict",
      nodeId: "second",
      change: "duplicate",
    });
  });
});
