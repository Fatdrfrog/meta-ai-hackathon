/**
 * Regression (fix/template-button-routes): a customer's tap on a WhatsApp
 * template reply button must run the follow-up of the button they tapped.
 *
 * Today the tap payload is `stb:<action>:<position>` and the runtime matches
 * that position against the route handle `…template-button-branch::<position>`
 * (transition-registry.ts whatsAppTemplateButtonReplyMatchesSourceHandle).
 * Once the template's buttons move (a button removed in the builder, or the
 * approved template reordered in Meta), the same position belongs to another
 * button, so taps run the wrong follow-up or none at all.
 *
 * The graph is built and edited through the builder's own code
 * (components/scenarios/view/graph/template-button-route-test-utils.ts), the
 * tap payload comes from the scenario send path (buildScenarioTemplateComponents),
 * and the tap is resolved with the runtime's compile and routing helpers.
 */
import { createGraphTestNode } from "@/components/scenarios/view/graph/test-utils";
import {
  buildTemplateRouteGraph,
  quickReply,
  removeTemplateButtonAndSave,
  TEMPLATE_ACTION_ID,
  templateButtonHandle,
  templateComponents,
  type TemplateRouteGraph,
  type TemplateTestButton,
} from "@/components/scenarios/view/graph/template-button-route-test-utils";
import { buildScenarioTemplateComponents } from "@/lib/airi/reply/runtime/auto-reply-template-utils";
import {
  evaluateScenarioFlow,
  resolveInteractiveReplyConditionTarget,
} from "@/lib/airi/scenario/scenario-interactive-replies";
import { makeClientMessageTriggerNode } from "@/lib/scenarios/__tests__/scenario-trigger-fixtures";
import { resolveScenarioStructuredReplyActionNodeId } from "@/lib/scenarios/structured-replies";
import {
  compileScenarioGraph,
  type CompiledScenarioGraph,
} from "@icecore/airi-runtime/scenario-graph";
import {
  resolveWhatsAppInteractiveReplyTriggerEventKind,
  withScenarioActionBranchDelay,
  type ScenarioNodeData,
  type WhatsAppComponent,
} from "@icecore/scenario-contracts";

// The template send helpers load the Mongo client; CI runs without MONGODB_URI.
jest.mock("@/lib/mongoose", () => ({
  __esModule: true,
  default: jest.fn().mockRejectedValue(new Error("Unexpected database access")),
}));

const TRIGGER_ID = "trigger-1";
const BASIC_AND_PREMIUM = [quickReply("Basic"), quickReply("Premium")];

function planMenu(): TemplateRouteGraph {
  return buildTemplateRouteGraph({
    triggerNode: createGraphTestNode(
      TRIGGER_ID,
      makeClientMessageTriggerNode()
    ),
    buttons: BASIC_AND_PREMIUM,
    routes: [
      ["Basic", "basic-follow-up"],
      ["Premium", "premium-follow-up"],
    ],
  });
}

function compile(graph: TemplateRouteGraph): CompiledScenarioGraph {
  return compileScenarioGraph(graph.nodes, graph.edges);
}

function savedTemplateComponents(
  graph: TemplateRouteGraph
): WhatsAppComponent[] {
  const action = graph.nodes.find(node => node.id === TEMPLATE_ACTION_ID);
  return (action?.data as ScenarioNodeData).actionWhatsAppTemplateComponents!;
}

type SentButtonComponent = {
  type?: string;
  index?: string | number;
  parameters?: Array<{ type?: string; payload?: string }>;
};

type TemplateStepGraph = {
  nodes: ReadonlyArray<{ id: string; data: ScenarioNodeData }>;
};

/**
 * Sends the template as the scenario runtime does, with the step's saved copy
 * and button ids (auto-reply.ts), and returns the payload WhatsApp hands back
 * when the customer taps the button with this label.
 */
function tapPayloadFromSentTemplate(
  step: TemplateStepGraph,
  sentComponents: WhatsAppComponent[],
  label: string
): string {
  const stepData = step.nodes.find(
    node => node.id === TEMPLATE_ACTION_ID
  )?.data;
  const sent = (buildScenarioTemplateComponents({
    templateComponents: sentComponents,
    values: {},
    actionNodeId: TEMPLATE_ACTION_ID,
    nodeTemplateComponents: stepData?.actionWhatsAppTemplateComponents,
    templateButtonIds: stepData?.actionWhatsAppTemplateButtonIds,
  }) ?? []) as SentButtonComponent[];
  const buttons =
    (
      sentComponents.find(component => component.type === "BUTTONS") as
        | { buttons?: TemplateTestButton[] }
        | undefined
    )?.buttons ?? [];
  const metaIndex = buttons.findIndex(button => button.text === label);
  const payload = sent
    .find(
      component =>
        component.type === "button" &&
        String(component.index) === String(metaIndex)
    )
    ?.parameters?.find(parameter => parameter.type === "payload")?.payload;
  if (!payload) throw new Error(`no tap payload was sent for "${label}"`);
  return payload;
}

/** Where the runtime sends a template button tap: a delay wait, then a follow-up. */
function resolveTap(graph: CompiledScenarioGraph, quickReplyPayload: string) {
  const triggerEventKind = resolveWhatsAppInteractiveReplyTriggerEventKind({
    isWhatsAppFlowReply: false,
    messageType: "button",
    quickReplyPayload,
  });
  const tap = {
    graph,
    conversation: { _id: "conv-1" } as never,
    channel: "whatsapp" as const,
    preferredActionNodeId:
      resolveScenarioStructuredReplyActionNodeId({
        triggerEventKind,
        quickReplyPayload,
      }) ?? undefined,
    matchedTriggerNodeId: TRIGGER_ID,
    triggerEventKind,
    quickReplyPayload,
  };
  const wait = resolveInteractiveReplyConditionTarget(tap)?.conditionNode.id;
  return {
    delayWait: wait ?? null,
    followUp: wait
      ? (graph.edges.find(edge => edge.source === wait)?.target ?? null)
      : (evaluateScenarioFlow(tap)?.selectedAction.id ?? null),
  };
}

function withBranchDelayOn(
  graph: TemplateRouteGraph,
  label: string,
  delayMinutes: number
): TemplateRouteGraph {
  const handle = templateButtonHandle(graph, label);
  if (!handle) throw new Error(`the template has no button "${label}"`);
  return {
    ...graph,
    nodes: graph.nodes.map(node =>
      node.id === TEMPLATE_ACTION_ID
        ? {
            ...node,
            data: {
              ...node.data,
              actionOutcomes: withScenarioActionBranchDelay(
                node.data.actionOutcomes ?? { version: 1 },
                handle,
                { delayMinutes }
              ),
            },
          }
        : node
    ),
  };
}

describe("template reply-button taps run the tapped button's follow-up, not its position's (regression)", () => {
  it("a tap sent before the first button was removed still runs the tapped button's follow-up", () => {
    const before = planMenu();
    // Already in customers' chats: the exact payload production sends today
    // for the second button (whatsapp-interactive-replies.ts), and the one the
    // current send path produces for "Premium" before the edit.
    const legacyPremiumTap = "stb:menu:1";
    const legacyBasicTap = "stb:menu:0";
    const premiumTapSentBeforeEdit = tapPayloadFromSentTemplate(
      before,
      templateComponents(BASIC_AND_PREMIUM),
      "Premium"
    );
    expect(resolveTap(compile(before), premiumTapSentBeforeEdit)).toEqual({
      delayWait: null,
      followUp: "premium-follow-up",
    });

    const after = compile(removeTemplateButtonAndSave(before, "Basic"));

    expect(after.diagnostics).toEqual([]);
    // The removed button's old tap must not run the remaining button's route.
    expect(resolveTap(after, legacyBasicTap).followUp).not.toBe(
      "premium-follow-up"
    );
    expect(resolveTap(after, legacyPremiumTap)).toEqual({
      delayWait: null,
      followUp: "premium-follow-up",
    });
    expect(resolveTap(after, premiumTapSentBeforeEdit)).toEqual({
      delayWait: null,
      followUp: "premium-follow-up",
    });
  });

  it("after the first button is removed, tapping the remaining button runs its own follow-up, not the removed button's", () => {
    const saved = removeTemplateButtonAndSave(planMenu(), "Basic");
    const premiumTap = tapPayloadFromSentTemplate(
      saved,
      savedTemplateComponents(saved),
      "Premium"
    );

    expect(resolveTap(compile(saved), premiumTap)).toEqual({
      delayWait: null,
      followUp: "premium-follow-up",
    });
  });

  it("a tap on the approved template after its buttons were reordered in Meta runs the tapped button's follow-up", () => {
    // The builder keeps its saved copy (Basic, Premium); the runtime sends the
    // live approved variant (auto-reply-template-utils.ts
    // resolveScenarioTemplateLanguage), which Meta now orders Premium, Basic.
    const graph = compile(planMenu());
    const liveApprovedTemplate = templateComponents([
      quickReply("Premium"),
      quickReply("Basic"),
    ]);

    expect(
      resolveTap(
        graph,
        tapPayloadFromSentTemplate(graph, liveApprovedTemplate, "Premium")
      ).followUp
    ).toBe("premium-follow-up");
    expect(
      resolveTap(
        graph,
        tapPayloadFromSentTemplate(graph, liveApprovedTemplate, "Basic")
      ).followUp
    ).toBe("basic-follow-up");
  });

  it("a delay on the removed first button does not move onto the remaining button", () => {
    const before = withBranchDelayOn(planMenu(), "Basic", 30);
    const saved = removeTemplateButtonAndSave(before, "Basic");
    const after = compile(saved);
    const premiumTap = tapPayloadFromSentTemplate(
      saved,
      savedTemplateComponents(saved),
      "Premium"
    );

    expect(after.diagnostics).toEqual([]);
    expect(resolveTap(after, premiumTap)).toEqual({
      delayWait: null,
      followUp: "premium-follow-up",
    });
  });

  it("a delay on the remaining button still delays its own follow-up after the first button is removed", () => {
    const before = withBranchDelayOn(planMenu(), "Premium", 30);
    const beforeTap = resolveTap(
      compile(before),
      tapPayloadFromSentTemplate(
        before,
        templateComponents(BASIC_AND_PREMIUM),
        "Premium"
      )
    );
    expect(beforeTap.delayWait).not.toBeNull();
    expect(beforeTap.followUp).toBe("premium-follow-up");

    const saved = removeTemplateButtonAndSave(before, "Basic");
    const after = compile(saved);
    const premiumTap = resolveTap(
      after,
      tapPayloadFromSentTemplate(
        saved,
        savedTemplateComponents(saved),
        "Premium"
      )
    );

    expect(after.diagnostics).toEqual([]);
    expect(premiumTap.delayWait).not.toBeNull();
    expect(premiumTap.followUp).toBe("premium-follow-up");
  });
});
