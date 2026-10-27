import {
  buildWhatsAppSessionChoicePayload,
  buildWhatsAppSessionChoiceSourceHandleId,
  buildWhatsAppTemplateButtonPayload,
  buildWhatsAppTemplateButtonSourceHandleId,
  createClientMessageTriggerData,
} from "@icecore/scenario-contracts";
import { compileScenarioGraph } from "@icecore/airi-runtime/scenario-graph";
import { resolveScenarioConnectionPlan } from "@/components/scenarios/view/graph/controller-utils";
import { createGraphTestNode } from "@/components/scenarios/view/graph/test-utils";
import type {
  ScenarioFlowEdge,
  ScenarioNodeData,
} from "@/components/scenarios/types";
import { normalizeScenarioGraphForPersistence } from "@/lib/scenarios/scenario-graph-persistence";
import { evaluateScenarioFlow } from "../scenario/scenario-interactive-replies";
import { resolveScenarioDispatchTransition } from "../scenario/scenario-post-action-routing";
import type { ConversationDocument } from "@/types/models";

const conversation = {
  _id: "loop-conversation",
} as unknown as ConversationDocument;

function createLoop(
  kind: "template" | "service",
  self = false,
  sibling = false
) {
  const payload = (id: string, buttonIndex = 0) =>
    kind === "template"
      ? buildWhatsAppTemplateButtonPayload(id, buttonIndex)
      : buildWhatsAppSessionChoicePayload({
          actionNodeId: id,
          choiceId: buttonIndex ? "help" : "choice",
        });
  const handle = (id: string, buttonIndex = 0) =>
    kind === "template"
      ? buildWhatsAppTemplateButtonSourceHandleId(buttonIndex)
      : buildWhatsAppSessionChoiceSourceHandleId(payload(id, buttonIndex));
  const labels = (id: string) =>
    id === "menu" ? (sibling ? ["Details", "Help"] : ["Details"]) : ["Back"];
  let nodes = [
    createGraphTestNode("trigger-start", createClientMessageTriggerData()),
    ...(sibling ? ["menu", "details", "help"] : ["menu", "details"]).map(id =>
      createGraphTestNode(id, {
        kind: "action",
        ...(kind === "template"
          ? {
              actionType: "whatsapp_template",
              actionWhatsAppTemplateName: id,
              actionWhatsAppTemplateLanguage: "en",
              actionWhatsAppTemplateComponents: [
                { type: "BODY", text: id },
                {
                  type: "BUTTONS",
                  buttons: labels(id).map(text => ({
                    type: "QUICK_REPLY",
                    text,
                  })),
                },
              ],
            }
          : {
              actionType: "reply",
              actionReplyChannel: "whatsapp",
              actionReplyMode: "fixed",
              actionWhatsAppServiceMessage: {
                version: 1,
                message: {
                  kind: "reply_buttons",
                  body: { mode: "fixed", text: id },
                  options: labels(id).map((label, index) => ({
                    id: payload(id, index),
                    label,
                  })),
                },
              },
            }),
      } as ScenarioNodeData)
    ),
  ];
  const edges: ScenarioFlowEdge[] = [
    {
      id: "entry",
      source: "trigger-start",
      target: "menu",
      sourceHandle: "right-source",
    },
  ];
  const connect = (source: string, target: string, buttonIndex = 0) => {
    const plan = resolveScenarioConnectionPlan({
      connection: { sourceHandle: handle(source, buttonIndex) },
      sourceNode: nodes.find(n => n.id === source)!,
      targetNode: nodes.find(n => n.id === target)!,
      nodes,
      edges,
    });
    if (plan?.kind !== "valid")
      throw new Error(`Rejected ${source} -> ${target}`);
    nodes = nodes.map(n =>
      n.id === target ? { ...n, data: { ...n.data, ...plan.targetPatch } } : n
    );
    edges.push({
      id: `${source}-${target}`,
      source,
      target,
      sourceHandle: plan.sourceHandleId,
      targetHandle: plan.targetHandleId,
    });
  };
  if (self) connect("menu", "menu");
  else {
    connect("menu", "details");
    connect("details", "menu");
    if (sibling) {
      connect("menu", "help", 1);
      connect("help", "menu");
    }
  }
  const saved = normalizeScenarioGraphForPersistence({ nodes, edges });
  const graph = compileScenarioGraph(
    saved.nodes as typeof nodes,
    saved.edges as typeof edges
  );
  const select = (source?: string, replyPayload?: string) =>
    evaluateScenarioFlow({
      graph,
      conversation,
      channel: "whatsapp",
      matchedTriggerNodeId: "trigger-start",
      ...(source
        ? {
            preferredActionNodeId: source,
            triggerEventKind: "whatsapp_button_reply" as const,
            quickReplyPayload: replyPayload ?? payload(source),
          }
        : { triggerEventKind: "inbound_message" as const }),
    });
  return { graph, select, payload };
}

describe.each(["template", "service"] as const)(
  "%s button loops saved by the editor",
  kind => {
    it("keeps the menu reachable for a new conversation after adding Back", () => {
      const { select } = createLoop(kind);
      expect(select()?.selectedAction.id).toBe("menu");
      expect(select()?.pathNodeIds).toEqual(["trigger-start", "menu"]);
    });

    it("returns from different branches sharing the same menu after the last binding changes", () => {
      const { select, payload } = createLoop(kind, false, true);
      expect(select()?.selectedAction.id).toBe("menu");
      for (let index = 0; index < 20; index++) {
        const branch = index % 2 ? "help" : "details";
        expect(
          select("menu", payload("menu", index % 2))?.selectedAction.id
        ).toBe(branch);
        expect(select(branch)?.selectedAction.id).toBe("menu");
      }
    });

    it("returns repeatedly without accumulating history or advancing without another reply", () => {
      const { select, graph } = createLoop(kind);
      let current = "menu";
      for (let index = 0; index < 100; index++) {
        const match = select(current)!;
        expect(match?.selectedAction.id).toBe(
          current === "menu" ? "details" : "menu"
        );
        expect(match.pathNodeIds.length).toBeLessThanOrEqual(4);
        const transition = resolveScenarioDispatchTransition({
          graph,
          conversation,
          channel: "whatsapp",
          selectedAction: match.selectedAction,
          selectedActionType: match.selectedActionType,
        });
        expect(transition).toMatchObject({
          nextActionNodeId: match.selectedAction.id,
          completesScenario: false,
        });
        current = match.selectedAction.id;
      }
      expect(select("details", "unrelated-payload")).toBeNull();
    });

    it("supports an explicit button that returns to its own menu", () => {
      const { select } = createLoop(kind, true);
      expect(select("menu")?.selectedAction.id).toBe("menu");
      expect(select("menu")?.pathNodeIds).toEqual([
        "trigger-start",
        "menu",
        "menu",
      ]);
    });

    it("does not bypass a button wait on an ordinary message in an active flow", () => {
      const { graph } = createLoop(kind);
      expect(
        evaluateScenarioFlow({
          graph,
          conversation,
          channel: "whatsapp",
          preferredActionNodeId: "details",
          matchedTriggerNodeId: "trigger-start",
          triggerEventKind: "inbound_message",
        })
      ).toBeNull();
    });
  }
);
