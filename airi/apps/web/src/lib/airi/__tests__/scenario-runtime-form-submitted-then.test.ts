import {
  evaluateScenarioFlow,
  resolvePreferredContinuationActionNodeId,
  shouldPinLockedScenarioForEvent,
} from "@/lib/airi/scenario/scenario-interactive-replies";
import { resolveScenarioDispatchTransition } from "@/lib/airi/scenario/scenario-post-action-routing";
import { resolveScenarioActionDefaultRouteBlocker } from "@/lib/scenarios/branch-handle-predicates";
import {
  compileScenarioGraph,
  type ScenarioRuntimeNode,
} from "@icecore/airi-runtime/scenario-graph";
import { medalTemplateStep } from "@/lib/scenarios/__tests__/scenario-form-fixtures";
import { makeClientMessageTriggerNode } from "@/lib/scenarios/__tests__/scenario-trigger-fixtures";
import {
  ACTION_WHATSAPP_TEMPLATE_FORM_SUBMITTED_HANDLE_ID,
  buildScenarioActionOutcomeHandleId,
  buildWhatsAppSessionChoiceSourceHandleId,
  getPostActionConditionHandleId,
  getScenarioActionOutcomeVirtualNodeId,
} from "@icecore/scenario-contracts";

// The template send helpers load the Mongo client; CI runs without MONGODB_URI.
jest.mock("@/lib/mongoose", () => ({
  __esModule: true,
  default: jest.fn().mockRejectedValue(new Error("Unexpected database access")),
}));
jest.mock("@icecore/airi-runtime/mongoose", () => {
  const connectDB = jest
    .fn()
    .mockRejectedValue(new Error("Unexpected database access"));
  return { __esModule: true, default: connectDB, connectDB };
});
jest.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: {} }));

type Edge = { source: string; target: string; sourceHandle?: string };

const conversation = { _id: "conv-then-form" } as never;
const channel = "whatsapp" as const;
const then = "right-source";
const formSubmitted = ACTION_WHATSAPP_TEMPLATE_FORM_SUBMITTED_HANDLE_ID;
const noReply = buildScenarioActionOutcomeHandleId("no_reply");
const conditionTimeout = getPostActionConditionHandleId("no_reply_timeout");
const outcomeWaitId = getScenarioActionOutcomeVirtualNodeId("medal");
const noReplyOutcome = {
  version: 1,
  noReply: { enabled: true, timeoutMinutes: 30 },
};

const createNode = (
  id: string,
  data: Record<string, unknown>
): ScenarioRuntimeNode => ({ id, data: data as ScenarioRuntimeNode["data"] });
const reply = (id: string, data: Record<string, unknown> = {}) =>
  createNode(id, {
    kind: "action",
    actionType: "reply",
    actionReplyMode: "fixed",
    actionReplyText: id,
    ...data,
  });
const quietPeriod = (data: Record<string, unknown> = {}) =>
  createNode("quiet", {
    kind: "logic",
    logicType: "post_action_condition",
    conditionBranches: [
      { id: "timeout", type: "no_reply_timeout", timeoutMinutes: 30 },
    ],
    ...data,
  });

/**
 * DemoShop's medal_pick_1 (a FLOW-only template) --Form submitted--> carousel
 * --choice--> AI. `thenTarget` is where its default "Then" route leads.
 */
function scenario({
  thenTarget,
  outcomes = true,
  nodes = [],
  edges = [],
}: {
  thenTarget: string;
  outcomes?: boolean;
  nodes?: ScenarioRuntimeNode[];
  edges?: Edge[];
}) {
  return {
    entryPolicy: "repeatable" as const,
    nodes: [
      createNode("trigger-1", makeClientMessageTriggerNode()),
      createNode(
        "medal",
        medalTemplateStep({
          actionWhatsAppTemplateName: "medal_pick_1",
          ...(outcomes ? { actionOutcomes: noReplyOutcome } : {}),
        })
      ),
      reply("then"),
      reply("carousel", {
        actionWhatsAppServiceMessage: {
          version: 1,
          message: {
            kind: "reply_buttons",
            body: { mode: "fixed", text: "Pick a frame" },
            options: [{ id: "wsc:carousel:gold", label: "Gold" }],
          },
        },
      }),
      reply("ai"),
      reply("reminder", { actionOutcomes: noReplyOutcome }),
      reply("reminder-2"),
      ...nodes,
    ],
    edges: [
      { source: "trigger-1", target: "medal" },
      { source: "medal", sourceHandle: then, target: thenTarget },
      { source: "medal", sourceHandle: formSubmitted, target: "carousel" },
      {
        source: "carousel",
        sourceHandle:
          buildWhatsAppSessionChoiceSourceHandleId("wsc:carousel:gold"),
        target: "ai",
      },
      ...(outcomes
        ? [
            { source: "medal", sourceHandle: noReply, target: "reminder" },
            {
              source: "reminder",
              sourceHandle: noReply,
              target: "reminder-2",
            },
          ]
        : []),
      ...edges,
    ] as Edge[],
  };
}
type ScenarioShape = ReturnType<typeof scenario>;

// (a) DemoShop after linking the route and before deleting Then.
const thenToCarousel = () => scenario({ thenTarget: "carousel" });
// (b) Then still leads to the step the template used to continue on.
const thenToOtherStep = () => scenario({ thenTarget: "then" });
// (c) Then leads into the template's legacy follow-up wait.
const thenToFollowUp = (condition = quietPeriod()) =>
  scenario({
    thenTarget: "quiet",
    outcomes: false,
    nodes: [condition],
    edges: [
      { source: "quiet", sourceHandle: conditionTimeout, target: "reminder" },
    ],
  });

const graphOf = (record: ScenarioShape) =>
  compileScenarioGraph(record.nodes, record.edges);
const waitingOnMedal = {
  currentActionNodeId: "medal",
  currentPathNodeIds: ["trigger-1", "medal"],
};
const flowReply = {
  triggerEventKind: "whatsapp_flow_reply" as const,
  whatsAppFlowResponseJson: JSON.stringify({
    __9ba1c9: "1_Таэквондо_/_Каратэ_/_Күрес",
    flow_token: "flow_1",
  }),
};

/** A timer or reply claim on the template's wait, forced to one step. */
function continueFromMedal(
  record: ScenarioShape,
  requiredActionNodeId: string,
  triggerEventKind:
    | "no_human_reply_timeout"
    | "post_action_user_reply" = "no_human_reply_timeout"
) {
  const match = evaluateScenarioFlow({
    graph: graphOf(record),
    conversation,
    channel,
    continuationSourceActionNodeId: "medal",
    triggerEventKind,
    requiredActionNodeId,
  });
  return match?.pathNodeIds ?? null;
}

describe("a template's Then next to its linked Form submitted route", () => {
  it.each([
    ["(a) Then to the route's step", thenToCarousel],
    ["(b) Then to another step", thenToOtherStep],
  ])("the builder says Then can't run: %s", (_, build) => {
    const record = build();
    const medal = record.nodes.find(item => item.id === "medal")!;
    expect(
      resolveScenarioActionDefaultRouteBlocker({
        nodeId: "medal",
        nodeData: medal.data,
        sourceHandleIds: record.edges
          .filter(edge => edge.source === "medal")
          .map(edge => edge.sourceHandle),
      })
    ).toBe("form_submitted");
    expect(graphOf(record).diagnostics).toEqual([]);
  });

  it.each([
    ["(a)", thenToCarousel, outcomeWaitId],
    ["(b)", thenToOtherStep, outcomeWaitId],
    ["(c)", () => thenToFollowUp(), "quiet"],
  ])(
    "%s holds the template after the send, on its follow-up wait",
    (_, build, pendingConditionNodeId) => {
      const graph = graphOf(build());
      expect(
        resolveScenarioDispatchTransition({
          graph,
          selectedAction: graph.nodesById.get("medal")!,
          selectedActionType: "whatsapp_template",
          conversation,
          channel,
        })
      ).toMatchObject({
        nextActionNodeId: "medal",
        completesScenario: false,
        pendingConditionNodeId,
      });
    }
  );

  it.each([
    ["(a)", thenToCarousel],
    ["(b)", thenToOtherStep],
    ["(c)", () => thenToFollowUp()],
  ])("%s keeps typed text off Then", (_, build) => {
    const record = build();
    const typed = {
      scenario: record,
      ...waitingOnMedal,
      eventKind: "inbound_message" as const,
    };
    expect(resolvePreferredContinuationActionNodeId(typed)).toBeUndefined();
    expect(shouldPinLockedScenarioForEvent(typed)).toBe(false);
    // Unpinned, the text can only enter the scenario again at its start.
    expect(
      evaluateScenarioFlow({
        graph: graphOf(record),
        conversation,
        channel,
        triggerEventKind: "inbound_message",
      })?.pathNodeIds
    ).toEqual(["trigger-1", "medal"]);
  });

  describe("(a) Then and Form submitted both lead to the carousel", () => {
    it.each(["no_human_reply_timeout", "post_action_user_reply"] as const)(
      "a %s continuation never reaches the carousel or what follows it",
      eventKind => {
        const record = thenToCarousel();
        expect(continueFromMedal(record, "carousel", eventKind)).toBeNull();
        expect(continueFromMedal(record, "ai", eventKind)).toBeNull();
        // Without Then, the same: only the form's reply takes the route.
        const withoutThen = {
          ...record,
          edges: record.edges.filter(edge => edge.sourceHandle !== then),
        };
        expect(
          continueFromMedal(withoutThen, "carousel", eventKind)
        ).toBeNull();
      }
    );

    it("keeps the No reply follow-ups running", () => {
      const record = thenToCarousel();
      expect(continueFromMedal(record, "reminder")).toEqual([
        "trigger-1",
        "medal",
        outcomeWaitId,
        "reminder",
      ]);
      // The next reminder in the chain, from the first reminder's wait.
      expect(
        evaluateScenarioFlow({
          graph: graphOf(record),
          conversation,
          channel,
          continuationSourceActionNodeId: "reminder",
          triggerEventKind: "no_human_reply_timeout",
          requiredActionNodeId: "reminder-2",
        })?.selectedAction.id
      ).toBe("reminder-2");
    });

    it("sends the carousel through the wait when No reply leads there too", () => {
      const record = thenToCarousel();
      const noReplyToCarousel = {
        ...record,
        edges: record.edges.map(edge =>
          edge.source === "medal" && edge.sourceHandle === noReply
            ? { ...edge, target: "carousel" }
            : edge
        ),
      };
      expect(continueFromMedal(noReplyToCarousel, "carousel")).toEqual([
        "trigger-1",
        "medal",
        outcomeWaitId,
        "carousel",
      ]);
    });
  });

  describe("(b) Then leads to another step", () => {
    it.each(["no_human_reply_timeout", "post_action_user_reply"] as const)(
      "a %s continuation never sends Then's step",
      eventKind => {
        const record = thenToOtherStep();
        expect(continueFromMedal(record, "then", eventKind)).toBeNull();
        expect(continueFromMedal(record, "carousel", eventKind)).toBeNull();
      }
    );

    it("keeps the No reply follow-ups running, through the wait", () => {
      const record = thenToOtherStep();
      expect(continueFromMedal(record, "reminder")).toEqual([
        "trigger-1",
        "medal",
        outcomeWaitId,
        "reminder",
      ]);
      const noReplyToThen = {
        ...record,
        edges: record.edges.map(edge =>
          edge.source === "medal" && edge.sourceHandle === noReply
            ? { ...edge, target: "then" }
            : edge
        ),
      };
      expect(continueFromMedal(noReplyToThen, "then")).toEqual([
        "trigger-1",
        "medal",
        outcomeWaitId,
        "then",
      ]);
    });
  });

  describe("(c) Then leads into the template's follow-up wait", () => {
    it.each([
      ["a quiet period", quietPeriod()],
      [
        "an interactive No reply",
        quietPeriod({
          postActionConditionVariant: "interactive_no_reply",
          interactiveNoReplySurface: "whatsapp_flow",
        }),
      ],
    ])("%s still sends its follow-up", (_, condition) => {
      const record = thenToFollowUp(condition);
      const graph = graphOf(record);
      expect(
        resolveScenarioDispatchTransition({
          graph,
          selectedAction: graph.nodesById.get("medal")!,
          selectedActionType: "whatsapp_template",
          conversation,
          channel,
        })
      ).toMatchObject({
        nextActionNodeId: "medal",
        pendingConditionNodeId: "quiet",
        pendingSourceActionNodeId: "medal",
      });
      expect(continueFromMedal(record, "reminder")).toEqual([
        "trigger-1",
        "medal",
        "quiet",
        "reminder",
      ]);
      expect(continueFromMedal(record, "carousel")).toBeNull();
    });
  });

  describe("(d) the form's reply", () => {
    it.each([
      ["(a)", thenToCarousel],
      ["(b)", thenToOtherStep],
      ["(c)", () => thenToFollowUp()],
    ])("%s takes Form submitted to the carousel", (_, build) => {
      const record = build();
      const continuation = {
        scenario: record,
        ...waitingOnMedal,
        eventKind: flowReply.triggerEventKind,
        flowReplySourceActionNodeId: "medal",
      };
      expect(resolvePreferredContinuationActionNodeId(continuation)).toBe(
        "medal"
      );
      expect(shouldPinLockedScenarioForEvent(continuation)).toBe(true);
      expect(
        evaluateScenarioFlow({
          graph: graphOf(record),
          conversation,
          channel,
          preferredActionNodeId: "medal",
          flowReplySourceActionNodeId: "medal",
          ...flowReply,
        })?.pathNodeIds
      ).toEqual(["trigger-1", "medal", "carousel"]);
      // A reply to a form this step is not known to have sent goes nowhere.
      expect(
        evaluateScenarioFlow({
          graph: graphOf(record),
          conversation,
          channel,
          preferredActionNodeId: "medal",
          ...flowReply,
        })
      ).toBeNull();
    });
  });
});
