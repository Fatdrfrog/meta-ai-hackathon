import {
  resolveGenerativeAIOutcomeTransitions,
  resolvePostActionConditionNodeFromAction,
  resolvePostActionConditionSourceHandleTarget,
  resolvePromptInputsMetTransition,
  resolvePromptInputsUnmetTransition,
  resolveScenarioDispatchTransition,
  whatsappTemplateAwaitingFlowReply,
  whatsappTemplateUsesMultipleBranchHandles,
} from "@/lib/airi/scenario/scenario-post-action-routing";
import {
  ACTION_NO_REPLY_OUTCOME_HANDLE_ID,
  ACTION_WHATSAPP_TEMPLATE_FORM_SUBMITTED_HANDLE_ID,
  GENERATIVE_AI_FAILURE_HANDLE,
  GENERATIVE_AI_SUCCESS_HANDLE,
  PROMPT_INPUTS_UNMET_HANDLE,
  buildWhatsAppSessionChoiceSourceHandleId,
  buildWhatsAppTemplateButtonSourceHandleId,
  getScenarioActionBranchDelayVirtualNodeId,
  getScenarioActionOutcomeVirtualNodeId,
  type ScenarioNodeData,
} from "@icecore/scenario-contracts";
import {
  compileScenarioGraph,
  type ScenarioRuntimeNode,
} from "@icecore/airi-runtime/scenario-graph";
import { getPostActionAnswerMatchHandleId } from "@icecore/scenario-contracts";
import { medalTemplateStep } from "@/lib/scenarios/__tests__/scenario-form-fixtures";
import type { Channel, ConversationDocument } from "@/types/models";

function node(id: string, data: ScenarioNodeData): ScenarioRuntimeNode {
  return { id, data };
}

it("keeps a managed-only template Flow waiting for its reply", () => {
  expect(
    whatsappTemplateAwaitingFlowReply({
      kind: "action",
      actionType: "whatsapp_template",
      actionReplyCtaType: "flow",
      actionFlowConfig: {
        templateId: "local-flow",
        screens: [],
        ctaText: "Open flow",
        managedProvisioning: {
          operationId: "operation-1",
          sourceId: "source-1",
          wabaId: "waba-1",
          contentRevision: 2,
          contentDigest: "digest-2",
          flowId: "managed-flow-id",
          providerStatus: "PUBLISHED",
        },
      },
    })
  ).toBe(true);
});

it("never waits for a Flow reply or radio routes from a template's saved form", () => {
  const data: ScenarioNodeData = {
    kind: "action",
    actionType: "whatsapp_template",
    actionWhatsAppTemplateComponents: [
      {
        type: "BUTTONS",
        buttons: [{ type: "FLOW", text: "Choose", flow_id: 2244981489363579 }],
      },
    ],
    actionWhatsAppTemplateForm: {
      version: 1,
      flowId: "2244981489363579",
      flowName: "demoshop_ai_case",
      answersKey: "demoshop_ai_case",
      digest: null,
      coverage: "complete",
      endpoint: false,
      readAt: "",
      fields: [
        {
          responseKey: "____133f36",
          label: "Design",
          description: "",
          fieldType: "RadioButtonsGroup",
          required: true,
          screenIndex: 1,
          options: [{ id: "1_Классикалық", title: "Classic" }],
        },
      ],
    },
  };

  expect(whatsappTemplateAwaitingFlowReply(data)).toBe(false);
  expect(whatsappTemplateUsesMultipleBranchHandles(data)).toBe(false);
});

describe("a template's Form submitted route at send time", () => {
  const conversation = {} as ConversationDocument;
  const channel = "whatsapp" as Channel;
  const formRoute = {
    source: "medal",
    sourceHandle: ACTION_WHATSAPP_TEMPLATE_FORM_SUBMITTED_HANDLE_ID,
    target: "carousel",
  };
  const dispatch = (
    data: Record<string, unknown>,
    edges: Array<{ source: string; sourceHandle: string; target: string }>
  ) => {
    const medal = node("medal", medalTemplateStep(data) as ScenarioNodeData);
    return resolveScenarioDispatchTransition({
      graph: compileScenarioGraph(
        [
          medal,
          node("carousel", { kind: "action", actionType: "reply" }),
          node("reminder", { kind: "action", actionType: "reply" }),
        ],
        edges
      ),
      selectedAction: medal,
      selectedActionType: "whatsapp_template",
      conversation,
      channel,
    });
  };

  it("waits on the template for its form instead of walking the route", () => {
    expect(dispatch({}, [formRoute])).toEqual({
      nextActionNodeId: "medal",
      completesScenario: false,
      pendingConditionNodeId: null,
      pendingSourceActionNodeId: null,
      pendingLinkedConditionId: null,
    });
  });

  it("goes on to the nearest step when the route is not connected", () => {
    expect(
      dispatch({}, [{ ...formRoute, sourceHandle: "right-source" }])
    ).toEqual({ nextActionNodeId: "carousel", completesScenario: false });
  });

  it("arms the template's own No reply wait beside the route", () => {
    expect(
      dispatch(
        {
          actionOutcomes: {
            version: 1,
            noReply: { enabled: true, timeoutMinutes: 30 },
          },
        },
        [
          formRoute,
          {
            source: "medal",
            sourceHandle: ACTION_NO_REPLY_OUTCOME_HANDLE_ID,
            target: "reminder",
          },
        ]
      )
    ).toMatchObject({
      nextActionNodeId: "medal",
      completesScenario: false,
      pendingConditionNodeId: getScenarioActionOutcomeVirtualNodeId("medal"),
      pendingSourceActionNodeId: "medal",
    });
  });
});

describe("resolvePostActionConditionSourceHandleTarget", () => {
  it("routes dynamic answer match handles to their target branch", () => {
    const graph = compileScenarioGraph(
      [
        node("condition", {
          kind: "logic",
          logicType: "post_action_condition",
          conditionBranches: [
            { id: "user_replied", type: "user_replied" },
            {
              id: "no_reply_timeout",
              type: "no_reply_timeout",
              answerMatchRules: [{ id: "yes", mode: "exact", text: "yes" }],
            },
          ],
        }),
        node("yes-action", { kind: "action", actionType: "reply" }),
      ],
      [
        {
          source: "condition",
          target: "yes-action",
          sourceHandle: getPostActionAnswerMatchHandleId("yes"),
        },
      ]
    );

    expect(
      resolvePostActionConditionSourceHandleTarget({
        graph,
        conditionNodeId: "condition",
        sourceHandle: getPostActionAnswerMatchHandleId("yes"),
        conversation: {} as ConversationDocument,
        channel: "whatsapp" as Channel,
      })?.id
    ).toBe("yes-action");
  });
});

describe("generative AI post-action routing", () => {
  const conversation = {} as ConversationDocument;
  const channel = "whatsapp" as Channel;
  const generate = node("generate", {
    kind: "action",
    actionType: "generative_ai",
    actionGenerativeAIConfig: {
      version: 1,
      mode: "text_to_video",
      prompt: "Animate this product",
    },
  });
  const success = node("success", {
    kind: "action",
    actionType: "reply",
  });
  const failure = node("failure", {
    kind: "action",
    actionType: "assign_human",
  });
  const graph = compileScenarioGraph(
    [generate, success, failure],
    [
      {
        source: "generate",
        sourceHandle: GENERATIVE_AI_FAILURE_HANDLE,
        target: "failure",
      },
      {
        source: "generate",
        sourceHandle: GENERATIVE_AI_SUCCESS_HANDLE,
        target: "success",
      },
    ]
  );

  it("keeps the generative action anchored instead of following generic adjacency", () => {
    expect(
      resolveScenarioDispatchTransition({
        graph,
        selectedAction: generate,
        selectedActionType: "generative_ai",
        conversation,
        channel,
      })
    ).toEqual({
      nextActionNodeId: "generate",
      completesScenario: false,
    });
  });

  it("freezes Success and Failure from their exact fixed handles", () => {
    expect(
      resolveGenerativeAIOutcomeTransitions({
        graph,
        selectedAction: generate,
        conversation,
        channel,
      })
    ).toEqual({
      successTransition: {
        nextActionNodeId: "success",
        completesScenario: false,
      },
      failureTransition: {
        nextActionNodeId: "failure",
        completesScenario: false,
      },
    });
  });
});

describe("delayed CTA follow-ups at send time", () => {
  const conversation = {} as ConversationDocument;
  const channel = "whatsapp" as Channel;
  const kazakh = buildWhatsAppTemplateButtonSourceHandleId(0);
  const russian = buildWhatsAppTemplateButtonSourceHandleId(1);
  const templateMenu = node("menu", {
    kind: "action",
    actionType: "whatsapp_template",
    actionWhatsAppTemplateName: "pick_lang",
    actionWhatsAppTemplateComponents: [
      {
        type: "BUTTONS",
        buttons: [
          { type: "QUICK_REPLY", text: "Kazakh" },
          { type: "QUICK_REPLY", text: "Russian" },
        ],
      },
    ],
    actionOutcomes: {
      version: 1,
      branchDelays: [{ sourceHandle: kazakh, delayMinutes: 30 }],
    },
  });

  it("sends the action without arming the delayed CTA's wait", () => {
    const graph = compileScenarioGraph(
      [
        templateMenu,
        node("kazakh", { kind: "action", actionType: "reply" }),
        node("russian", { kind: "action", actionType: "reply" }),
      ],
      [
        { source: "menu", sourceHandle: kazakh, target: "kazakh" },
        { source: "menu", sourceHandle: russian, target: "russian" },
      ]
    );

    expect(
      graph.nodesById.has(
        getScenarioActionBranchDelayVirtualNodeId("menu", kazakh)
      )
    ).toBe(true);
    expect(
      resolveScenarioDispatchTransition({
        graph,
        selectedAction: templateMenu,
        selectedActionType: "whatsapp_template",
        conversation,
        channel,
      })
    ).toEqual({
      nextActionNodeId: "menu",
      completesScenario: false,
      pendingConditionNodeId: null,
      pendingSourceActionNodeId: null,
      pendingLinkedConditionId: null,
    });
    expect(
      resolvePostActionConditionNodeFromAction({
        graph,
        actionNodeId: "menu",
        conversation,
        channel,
      })
    ).toBeNull();
  });

  it("keeps the action's own no-reply wait beside a delayed choice", () => {
    const help = buildWhatsAppSessionChoiceSourceHandleId("wsc:menu:help");
    const menu = node("menu", {
      kind: "action",
      actionType: "reply",
      actionWhatsAppServiceMessage: {
        version: 1,
        message: {
          kind: "reply_buttons",
          body: { mode: "fixed", text: "Choose" },
          options: [{ id: "wsc:menu:help", label: "Help" }],
        },
      },
      actionOutcomes: {
        version: 1,
        noReply: { enabled: true, timeoutMinutes: 60 },
        branchDelays: [{ sourceHandle: help, delayMinutes: 5 }],
      },
    });
    const graph = compileScenarioGraph(
      [
        menu,
        node("help", { kind: "action", actionType: "reply" }),
        node("reminder", { kind: "action", actionType: "reply" }),
      ],
      [
        { source: "menu", sourceHandle: help, target: "help" },
        {
          source: "menu",
          sourceHandle: ACTION_NO_REPLY_OUTCOME_HANDLE_ID,
          target: "reminder",
        },
      ]
    );

    expect(
      resolveScenarioDispatchTransition({
        graph,
        selectedAction: menu,
        selectedActionType: "reply",
        conversation,
        channel,
      })
    ).toMatchObject({
      pendingConditionNodeId: getScenarioActionOutcomeVirtualNodeId("menu"),
      pendingSourceActionNodeId: "menu",
    });
  });
});

describe("prompt input unmet routing", () => {
  const conversation = {} as ConversationDocument;
  const channel = "whatsapp" as Channel;
  const ask = node("ask", {
    kind: "action",
    actionType: "reply",
    actionWhatsAppServiceMessage: {
      version: 1,
      message: {
        kind: "text",
        body: { mode: "fixed", text: "Tell me your name and sport." },
        previewUrl: false,
      },
      promptInputs: [
        { key: "name", label: "Name", prompt: "customer name" },
        { key: "sport", label: "Sport", prompt: "sport they play" },
      ],
    },
  });
  const generate = node("generate", {
    kind: "action",
    actionType: "reply",
  });
  const repeat = node("repeat", {
    kind: "action",
    actionType: "reply",
  });
  const graph = compileScenarioGraph(
    [ask, repeat, generate],
    [
      {
        source: "ask",
        sourceHandle: PROMPT_INPUTS_UNMET_HANDLE,
        target: "repeat",
      },
      { source: "ask", sourceHandle: "right-source", target: "generate" },
    ]
  );

  it("keeps the unmet branch off the default continuation", () => {
    expect(graph.adjacency.get("ask")).toEqual(["generate"]);
    expect(
      resolveScenarioDispatchTransition({
        graph,
        selectedAction: ask,
        selectedActionType: "reply",
        conversation,
        channel,
      })
    ).toEqual({
      nextActionNodeId: "generate",
      completesScenario: false,
    });
    expect(
      resolvePromptInputsUnmetTransition({
        graph,
        selectedAction: ask,
        conversation,
        channel,
      })
    ).toEqual({
      nextActionNodeId: "repeat",
      completesScenario: false,
    });
  });

  describe("beside the ask's own No reply reminder", () => {
    const withReminder = node("ask", {
      ...ask.data,
      actionOutcomes: {
        version: 1,
        noReply: { enabled: true, timeoutMinutes: 30 },
      },
    });
    const reminder = node("reminder", { kind: "action", actionType: "reply" });
    const reminderEdge = {
      source: "ask",
      sourceHandle: ACTION_NO_REPLY_OUTCOME_HANDLE_ID,
      target: "reminder",
    };

    it("still finds the collected route while the wait holds the ask", () => {
      const waiting = compileScenarioGraph(
        [withReminder, generate, reminder],
        [
          { source: "ask", sourceHandle: "right-source", target: "generate" },
          reminderEdge,
        ]
      );
      expect(
        resolveScenarioDispatchTransition({
          graph: waiting,
          selectedAction: withReminder,
          selectedActionType: "reply",
          conversation,
          channel,
        })
      ).toMatchObject({
        nextActionNodeId: "ask",
        pendingConditionNodeId: getScenarioActionOutcomeVirtualNodeId("ask"),
      });
      expect(
        resolvePromptInputsMetTransition({
          graph: waiting,
          selectedAction: withReminder,
          conversation,
          channel,
        })
      ).toEqual({ nextActionNodeId: "generate", completesScenario: false });
    });

    it("ends the scenario after the details when the collected route is open", () => {
      expect(
        resolvePromptInputsMetTransition({
          graph: compileScenarioGraph([withReminder, reminder], [reminderEdge]),
          selectedAction: withReminder,
          conversation,
          channel,
        })
      ).toEqual({ nextActionNodeId: null, completesScenario: true });
    });
  });

  it("leaves the scenario waiting when the unmet edge is not connected", () => {
    const metOnly = compileScenarioGraph(
      [ask, generate],
      [{ source: "ask", sourceHandle: "right-source", target: "generate" }]
    );
    expect(
      resolvePromptInputsUnmetTransition({
        graph: metOnly,
        selectedAction: ask,
        conversation,
        channel,
      })
    ).toEqual({
      nextActionNodeId: null,
      completesScenario: false,
    });
  });
});
