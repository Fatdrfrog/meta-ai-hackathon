import { resolvePendingConditionEventDisposition } from "@/lib/airi/interactive-no-reply";
import { evaluateScenarioFlow } from "@/lib/airi/scenario/scenario-interactive-replies";
import {
  resolveFirstReachableActionFromNode,
  resolvePostActionConditionBranchTarget,
  resolvePostActionConditionNodeFromAction,
  resolvePostActionConditionSourceHandleTarget,
  resolveScenarioDispatchTransition,
} from "@/lib/airi/scenario/scenario-post-action-routing";
import {
  compileScenarioGraph,
  type ScenarioRuntimeNode,
} from "@icecore/airi-runtime/scenario-graph";
import {
  getPostActionAnswerMatchHandleId,
  getPostActionConditionHandleId,
  getScenarioActionOutcomeVirtualNodeId,
  buildFlowBranchSourceHandleId,
  buildWhatsAppSessionChoiceSourceHandleId,
} from "@icecore/scenario-contracts";
import {
  buildScenarioActionOutcomeHandleId,
  SCENARIO_TRIGGER_EVENT_KIND,
  type ScenarioRuntimeEventKind,
} from "@icecore/scenario-contracts";

function node(id: string, data: Record<string, unknown>): ScenarioRuntimeNode {
  return { id, data: data as ScenarioRuntimeNode["data"] };
}

function createActionOwnedOutcomeFixture() {
  const nodes = [
    node("trigger", {
      kind: "trigger",
      triggerConfig: { enabled: true },
    }),
    node("source", {
      kind: "action",
      actionType: "reply",
      actionReplyMode: "fixed",
      actionReplyText: "Choose a route",
      actionWhatsAppServiceMessage: {
        version: 1,
        message: {
          kind: "flow",
          body: { mode: "fixed", text: "Choose" },
          flowConfig: {
            templateId: "flow-1",
            ctaText: "Open",
            screens: [
              {
                id: "screen-1",
                title: "Choose",
                fields: [
                  {
                    id: "plan",
                    label: "Plan",
                    fieldType: "RadioButtonsGroup",
                    options: [{ id: "one", title: "One" }],
                  },
                ],
              },
            ],
          },
        },
      },
      actionOutcomes: {
        version: 1,
        anyReply: { enabled: true },
        noReply: { enabled: true, timeoutMinutes: 15 },
        answerMatches: [
          { id: "exact", mode: "exact", text: "yes" },
          { id: "intent", mode: "intent", text: "asks about pricing" },
        ],
        paymentDetected: { enabled: true },
      },
    }),
    node("exact-target", { kind: "action", actionType: "reply" }),
    node("intent-target", { kind: "action", actionType: "reply" }),
    node("payment-target", { kind: "action", actionType: "reply" }),
    node("reply-target", { kind: "action", actionType: "reply" }),
    node("timeout-target", { kind: "action", actionType: "reply" }),
  ];
  const graph = compileScenarioGraph(nodes, [
    { source: "trigger", target: "source" },
    {
      source: "source",
      sourceHandle: buildScenarioActionOutcomeHandleId({
        type: "answer",
        ruleId: "exact",
      }),
      target: "exact-target",
    },
    {
      source: "source",
      sourceHandle: buildScenarioActionOutcomeHandleId({
        type: "answer",
        ruleId: "intent",
      }),
      target: "intent-target",
    },
    {
      source: "source",
      sourceHandle: buildScenarioActionOutcomeHandleId("payment_detected"),
      target: "payment-target",
    },
    {
      source: "source",
      sourceHandle: buildScenarioActionOutcomeHandleId("any_reply"),
      target: "reply-target",
    },
    {
      source: "source",
      sourceHandle: buildScenarioActionOutcomeHandleId("no_reply"),
      target: "timeout-target",
    },
  ]);

  return { graph, source: nodes[1] };
}

function createButtonsAfterTimeoutFixture(
  futureTimeout = false,
  returnToSender = false
) {
  const payload = "wsc:followup:other";
  const graph = compileScenarioGraph(
    [
      node("trigger", {
        kind: "trigger",
        triggerConfig: { enabled: true },
      }),
      node("prompt", {
        kind: "action",
        actionType: "reply",
        actionOutcomes: {
          version: 1,
          noReply: { enabled: true, timeoutMinutes: 1 },
        },
      }),
      node("followup", {
        kind: "action",
        actionType: "reply",
        actionWhatsAppServiceMessage: {
          version: 1,
          message: {
            kind: "reply_buttons",
            body: { mode: "fixed", text: "See another option?" },
            options: [{ id: payload, label: "Another option" }],
          },
        },
        actionOutcomes: { version: 1 },
      }),
      node("target", {
        kind: "action",
        actionType: "reply",
        whatsAppSessionChoicePayload: payload,
      }),
      ...(futureTimeout
        ? [
            node("future-wait", {
              kind: "logic",
              logicType: "post_action_condition",
              conditionBranches: [
                {
                  id: "no_reply_timeout",
                  type: "no_reply_timeout",
                  timeoutMinutes: 1,
                },
              ],
            }),
          ]
        : []),
    ],
    [
      { source: "trigger", target: "prompt" },
      {
        source: "prompt",
        sourceHandle: buildScenarioActionOutcomeHandleId("no_reply"),
        target: "followup",
      },
      {
        source: "followup",
        sourceHandle: buildWhatsAppSessionChoiceSourceHandleId(payload),
        target: futureTimeout ? "future-wait" : "target",
      },
      ...(futureTimeout
        ? [
            {
              source: "future-wait",
              sourceHandle: getPostActionConditionHandleId("no_reply_timeout"),
              target: returnToSender ? "followup" : "target",
            },
          ]
        : []),
    ]
  );
  return { graph, payload };
}

describe("scenario runtime action-owned outcomes", () => {
  it.each(["followup", undefined])(
    "routes a button after an already-traversed timeout (stored sender: %s)",
    preferredActionNodeId => {
      const { graph, payload } = createButtonsAfterTimeoutFixture();

      expect(graph.diagnostics).toEqual([]);
      expect(
        evaluateScenarioFlow({
          graph,
          conversation: { _id: "conversation-1" } as never,
          channel: "whatsapp",
          preferredActionNodeId,
          triggerEventKind: SCENARIO_TRIGGER_EVENT_KIND.whatsAppButtonReply,
          quickReplyPayload: payload,
        })
      ).toHaveProperty("selectedAction.id", "target");
    }
  );

  it("keeps a timeout after the button sender gated", () => {
    const { graph, payload } = createButtonsAfterTimeoutFixture(true);

    expect(graph.diagnostics).toEqual([]);
    expect(
      evaluateScenarioFlow({
        graph,
        conversation: { _id: "conversation-1" } as never,
        channel: "whatsapp",
        preferredActionNodeId: "followup",
        triggerEventKind: SCENARIO_TRIGGER_EVENT_KIND.whatsAppButtonReply,
        quickReplyPayload: payload,
      })
    ).toBeNull();
  });

  it("does not enter a timeout path on an ordinary inbound message", () => {
    const { graph } = createButtonsAfterTimeoutFixture();

    expect(
      evaluateScenarioFlow({
        graph,
        conversation: { _id: "conversation-1" } as never,
        channel: "whatsapp",
        requiredActionNodeId: "target",
        triggerEventKind: SCENARIO_TRIGGER_EVENT_KIND.inboundMessage,
      })
    ).toBeNull();
  });

  it("keeps a future timeout gated when its branch returns to the sender", () => {
    const { graph, payload } = createButtonsAfterTimeoutFixture(true, true);

    expect(graph.diagnostics).toEqual([]);
    expect(
      evaluateScenarioFlow({
        graph,
        conversation: { _id: "conversation-1" } as never,
        channel: "whatsapp",
        preferredActionNodeId: "followup",
        triggerEventKind: SCENARIO_TRIGGER_EVENT_KIND.whatsAppButtonReply,
        quickReplyPayload: payload,
      })
    ).toBeNull();
  });

  it("rejects a mismatched button after an already-traversed timeout", () => {
    const { graph } = createButtonsAfterTimeoutFixture();

    expect(
      evaluateScenarioFlow({
        graph,
        conversation: { _id: "conversation-1" } as never,
        channel: "whatsapp",
        preferredActionNodeId: "followup",
        triggerEventKind: SCENARIO_TRIGGER_EVENT_KIND.whatsAppButtonReply,
        quickReplyPayload: "wsc:followup:unknown",
      })
    ).toBeNull();
  });

  it.each([false, true])(
    "arms the action-owned wait alongside product-specific waits (timeout connected: %s)",
    connectTimeout => {
      const { source } = createActionOwnedOutcomeFixture();
      const graph = compileScenarioGraph(
        [
          source,
          ...["medal-wait", "elite-wait"].map(id =>
            node(id, {
              kind: "logic",
              logicType: "post_action_condition",
              conditionBranches: [
                {
                  id: "no_reply_timeout",
                  type: "no_reply_timeout",
                  timeoutMinutes: 1440,
                },
              ],
            })
          ),
          node("orteke", { kind: "action", actionType: "reply" }),
          node("medal", { kind: "action", actionType: "reply" }),
          node("elite", { kind: "action", actionType: "reply" }),
        ],
        [
          {
            source: source.id,
            sourceHandle: buildFlowBranchSourceHandleId("plan", "one"),
            target: "medal-wait",
          },
          {
            source: source.id,
            sourceHandle: buildFlowBranchSourceHandleId("plan", "two"),
            target: "elite-wait",
          },
          {
            source: "medal-wait",
            sourceHandle: getPostActionConditionHandleId("no_reply_timeout"),
            target: "medal",
          },
          {
            source: "elite-wait",
            sourceHandle: getPostActionConditionHandleId("no_reply_timeout"),
            target: "elite",
          },
          {
            source: source.id,
            sourceHandle: buildScenarioActionOutcomeHandleId({
              type: "answer",
              ruleId: "exact",
            }),
            target: "orteke",
          },
          ...(connectTimeout
            ? [
                {
                  source: source.id,
                  sourceHandle: buildScenarioActionOutcomeHandleId("no_reply"),
                  target: "orteke",
                },
              ]
            : []),
        ]
      );
      expect(
        resolveScenarioDispatchTransition({
          graph,
          selectedAction: source,
          selectedActionType: "reply",
          conversation: { _id: "conversation-1" } as never,
          channel: "whatsapp",
        })
      ).toMatchObject({
        pendingConditionNodeId: getScenarioActionOutcomeVirtualNodeId(
          source.id
        ),
        pendingSourceActionNodeId: source.id,
      });
    }
  );

  it.each([
    [getPostActionAnswerMatchHandleId("exact"), "exact-target"],
    [getPostActionAnswerMatchHandleId("intent"), "intent-target"],
    [getPostActionConditionHandleId("payment_detected"), "payment-target"],
    [getPostActionConditionHandleId("user_replied"), "reply-target"],
    [getPostActionConditionHandleId("no_reply_timeout"), "timeout-target"],
  ])("resolves compiled outcome handle %s to %s", (sourceHandle, target) => {
    const { graph, source } = createActionOwnedOutcomeFixture();
    const conversation = { _id: "conversation-1" } as never;
    const transition = resolveScenarioDispatchTransition({
      graph,
      selectedAction: source,
      selectedActionType: "reply",
      conversation,
      channel: "whatsapp",
    });

    expect(graph.diagnostics).toEqual([]);
    expect(transition.pendingConditionNodeId).toBeDefined();
    expect(
      resolvePostActionConditionSourceHandleTarget({
        graph,
        conditionNodeId: transition.pendingConditionNodeId!,
        sourceHandle,
        conversation,
        channel: "whatsapp",
      })
    ).toHaveProperty("id", target);
  });

  it("classifies a verified payment event before the ordinary-reply fallback", () => {
    expect(
      resolvePendingConditionEventDisposition({
        triggerEventKind: "payment_detected",
        confirmedPayment: true,
      })
    ).toBe("payment_detected");
  });

  it("does nothing for an unconnected action-owned outcome", () => {
    const source = node("source", {
      kind: "action",
      actionType: "reply",
      actionOutcomes: {
        version: 1,
        anyReply: { enabled: true },
      },
    });
    const graph = compileScenarioGraph([source], []);

    expect(graph.diagnostics).toEqual([]);
    expect(
      resolveScenarioDispatchTransition({
        graph,
        selectedAction: source,
        selectedActionType: "reply",
        conversation: { _id: "conversation-1" } as never,
        channel: "whatsapp",
      })
    ).toMatchObject({ nextActionNodeId: null, completesScenario: true });
  });

  it("fails closed when the compiled graph has error diagnostics", () => {
    const graph = compileScenarioGraph(
      [
        node("trigger", {
          kind: "trigger",
          triggerConfig: { enabled: true },
        }),
        node("source", {
          kind: "action",
          actionType: "reply",
          actionOutcomes: { version: 99 },
        }),
      ],
      [{ source: "trigger", target: "source" }]
    );

    expect(graph.diagnostics).toHaveLength(1);
    expect(
      evaluateScenarioFlow({
        graph,
        conversation: { _id: "conversation-1" } as never,
        channel: "whatsapp",
        matchedTriggerNodeId: "trigger",
        triggerEventKind: SCENARIO_TRIGGER_EVENT_KIND.inboundMessage,
      })
    ).toBeNull();
  });

  it.each([
    ["Telegram quick reply", { telegramBranchPayload: "stale-telegram" }],
    ["Instagram quick reply", { instagramBranchPayload: "stale-instagram" }],
    [
      "WhatsApp Flow",
      {
        flowBranchSourceFieldId: "stale-field",
        flowBranchOptionId: "stale-option",
      },
    ],
  ] as const)(
    "keeps a required action eligible despite %s branch metadata",
    (_, branchMetadata) => {
      const graph = compileScenarioGraph(
        [
          node("trigger", {
            kind: "trigger",
            triggerConfig: { enabled: true },
          }),
          node("required-target", {
            kind: "action",
            actionType: "reply",
            ...branchMetadata,
          }),
        ],
        [{ source: "trigger", target: "required-target" }]
      );

      expect(graph.diagnostics).toEqual([]);
      expect(
        evaluateScenarioFlow({
          graph,
          conversation: { _id: "conversation-1" } as never,
          channel: "whatsapp",
          requiredActionNodeId: "required-target",
          matchedTriggerNodeId: "trigger",
          triggerEventKind: SCENARIO_TRIGGER_EVENT_KIND.noHumanReplyTimeout,
        })
      ).toHaveProperty("selectedAction.id", "required-target");
    }
  );

  it("fails every public post-action continuation boundary closed for an errored graph", () => {
    const source = node("source", {
      kind: "action",
      actionType: "reply",
    });
    const condition = node("condition", {
      kind: "logic",
      logicType: "post_action_condition",
      conditionBranches: [{ id: "user_replied", type: "user_replied" }],
    });
    const target = node("target", {
      kind: "action",
      actionType: "reply",
    });
    const invalid = node("invalid", {
      kind: "action",
      actionType: "reply",
      actionOutcomes: { version: 99 },
    });
    const graph = compileScenarioGraph(
      [source, condition, target, invalid],
      [
        { source: "source", target: "condition" },
        {
          source: "condition",
          sourceHandle: getPostActionConditionHandleId("user_replied"),
          target: "target",
        },
      ]
    );
    const conversation = { _id: "conversation-1" } as never;

    expect(graph.diagnostics).toHaveLength(1);
    expect(
      resolveScenarioDispatchTransition({
        graph,
        selectedAction: source,
        selectedActionType: "reply",
        conversation,
        channel: "whatsapp",
      })
    ).toEqual({ nextActionNodeId: null, completesScenario: false });
    expect(
      resolvePostActionConditionNodeFromAction({
        graph,
        actionNodeId: source.id,
        conversation,
        channel: "whatsapp",
      })
    ).toBeNull();
    expect(
      resolvePostActionConditionBranchTarget({
        graph,
        conditionNodeId: condition.id,
        branchType: "user_replied",
        conversation,
        channel: "whatsapp",
      })
    ).toBeNull();
    expect(
      resolvePostActionConditionSourceHandleTarget({
        graph,
        conditionNodeId: condition.id,
        sourceHandle: getPostActionConditionHandleId("user_replied"),
        conversation,
        channel: "whatsapp",
      })
    ).toBeNull();
    expect(
      resolveFirstReachableActionFromNode({
        graph,
        startNodeId: condition.id,
        conversation,
        channel: "whatsapp",
      })
    ).toBeNull();
  });

  it("treats canonical WhatsApp service message buttons as interactive replies while waiting", () => {
    const disposition = resolvePendingConditionEventDisposition({
      triggerEventKind: SCENARIO_TRIGGER_EVENT_KIND.whatsAppButtonReply,
      conditionNodeData: {
        kind: "logic",
        logicType: "post_action_condition",
        postActionConditionVariant: "interactive_no_reply",
        interactiveNoReplySurface: "whatsapp_session_choices",
      },
      pendingSourceActionData: {
        kind: "action",
        actionType: "reply",
        actionReplyChannel: "whatsapp",
        actionWhatsAppServiceMessage: {
          version: 1,
          message: {
            kind: "reply_buttons",
            body: { mode: "fixed", text: "Choose" },
            options: [
              { id: "wsc:service-1:one", label: "One" },
              { id: "wsc:service-1:two", label: "Two" },
            ],
          },
        },
      },
    });

    expect(disposition).toBe("interactive_reply");
  });
});

describe("forced post-action continuations", () => {
  type Outcome = "any_reply" | "no_reply" | "payment_detected";
  const outcomeConfig = {
    any_reply: { anyReply: { enabled: true } },
    no_reply: { noReply: { enabled: true, timeoutMinutes: 30 } },
    payment_detected: { paymentDetected: { enabled: true } },
  } satisfies Record<Outcome, Record<string, unknown>>;
  const outcomeEvent = {
    any_reply: SCENARIO_TRIGGER_EVENT_KIND.postActionUserReply,
    no_reply: SCENARIO_TRIGGER_EVENT_KIND.noHumanReplyTimeout,
    payment_detected: SCENARIO_TRIGGER_EVENT_KIND.paymentDetected,
  } satisfies Record<Outcome, ScenarioRuntimeEventKind>;
  // trigger -> welcome --earlier--> menu --waiting--> target
  const behindEarlierOutcome = (earlier: Outcome, waiting: Outcome) =>
    compileScenarioGraph(
      [
        node("trigger", { kind: "trigger", triggerConfig: { enabled: true } }),
        node("welcome", {
          kind: "action",
          actionType: "reply",
          actionOutcomes: { version: 1, ...outcomeConfig[earlier] },
        }),
        node("menu", {
          kind: "action",
          actionType: "reply",
          actionOutcomes: { version: 1, ...outcomeConfig[waiting] },
        }),
        node("target", { kind: "action", actionType: "reply" }),
      ],
      [
        { source: "trigger", target: "welcome" },
        {
          source: "welcome",
          sourceHandle: buildScenarioActionOutcomeHandleId(earlier),
          target: "menu",
        },
        {
          source: "menu",
          sourceHandle: buildScenarioActionOutcomeHandleId(waiting),
          target: "target",
        },
      ]
    );
  const continueTo = (
    graph: ReturnType<typeof compileScenarioGraph>,
    triggerEventKind: ScenarioRuntimeEventKind,
    continuationSourceActionNodeId?: string
  ) =>
    evaluateScenarioFlow({
      graph,
      conversation: { _id: "conversation-1" } as never,
      channel: "whatsapp",
      preferredActionNodeId: "target",
      requiredActionNodeId: "target",
      continuationSourceActionNodeId,
      matchedTriggerNodeId: "trigger",
      triggerEventKind,
    });

  it.each([
    ["a timer", "any_reply", "no_reply"],
    ["a timer", "payment_detected", "no_reply"],
    ["an Any reply", "no_reply", "any_reply"],
    ["a payment", "any_reply", "payment_detected"],
  ] as const)(
    "continues %s after an earlier action's %s outcome",
    (_, earlier, waiting) => {
      const graph = behindEarlierOutcome(earlier, waiting);

      expect(graph.diagnostics).toEqual([]);
      expect(
        continueTo(graph, outcomeEvent[waiting], "menu")?.pathNodeIds
      ).toEqual([
        "trigger",
        "welcome",
        getScenarioActionOutcomeVirtualNodeId("welcome"),
        "menu",
        getScenarioActionOutcomeVirtualNodeId("menu"),
        "target",
      ]);
      // Without the waiting action every branch from the trigger is checked.
      expect(continueTo(graph, outcomeEvent[waiting])).toBeNull();
    }
  );

  it("continues a legacy condition's timer past an earlier legacy reply branch", () => {
    const condition = (id: string, type: "user_replied" | "no_reply_timeout") =>
      node(id, {
        kind: "logic",
        logicType: "post_action_condition",
        conditionBranches: [
          {
            id: type,
            type,
            ...(type === "no_reply_timeout" ? { timeoutMinutes: 30 } : {}),
          },
        ],
      });
    const graph = compileScenarioGraph(
      [
        node("trigger", { kind: "trigger", triggerConfig: { enabled: true } }),
        node("welcome", { kind: "action", actionType: "reply" }),
        condition("replied", "user_replied"),
        node("menu", { kind: "action", actionType: "reply" }),
        condition("quiet", "no_reply_timeout"),
        node("target", { kind: "action", actionType: "reply" }),
      ],
      [
        { source: "trigger", target: "welcome" },
        { source: "welcome", target: "replied" },
        {
          source: "replied",
          sourceHandle: getPostActionConditionHandleId("user_replied"),
          target: "menu",
        },
        { source: "menu", target: "quiet" },
        {
          source: "quiet",
          sourceHandle: getPostActionConditionHandleId("no_reply_timeout"),
          target: "target",
        },
      ]
    );

    expect(
      continueTo(graph, SCENARIO_TRIGGER_EVENT_KIND.noHumanReplyTimeout, "menu")
        ?.selectedAction.id
    ).toBe("target");
  });

  it("still requires the waiting action's own branch to accept the event", () => {
    const graph = behindEarlierOutcome("any_reply", "no_reply");

    expect(
      continueTo(graph, SCENARIO_TRIGGER_EVENT_KIND.postActionUserReply, "menu")
    ).toBeNull();
    expect(
      continueTo(graph, SCENARIO_TRIGGER_EVENT_KIND.paymentDetected, "menu")
    ).toBeNull();
  });

  it("ignores a continuation source outside post-action events", () => {
    const graph = behindEarlierOutcome("no_reply", "any_reply");

    expect(
      continueTo(graph, SCENARIO_TRIGGER_EVENT_KIND.postActionUserReply, "menu")
        ?.selectedAction.id
    ).toBe("target");
    expect(
      continueTo(graph, SCENARIO_TRIGGER_EVENT_KIND.inboundMessage, "menu")
    ).toBeNull();
  });
});

describe("claimed answer-match continuations", () => {
  // trigger -> menu --answer "yes"--> confirmed, with a No reply reminder
  const legacyAnswerGraph = () =>
    compileScenarioGraph(
      [
        node("trigger", { kind: "trigger", triggerConfig: { enabled: true } }),
        node("menu", { kind: "action", actionType: "reply" }),
        node("wait", {
          kind: "logic",
          logicType: "post_action_condition",
          conditionBranches: [
            {
              id: "no_reply_timeout",
              type: "no_reply_timeout",
              timeoutMinutes: 30,
              answerMatchRules: [{ id: "yes", mode: "exact", text: "yes" }],
            },
          ],
        }),
        node("confirmed", { kind: "action", actionType: "reply" }),
        node("reminder", { kind: "action", actionType: "reply" }),
      ],
      [
        { source: "trigger", target: "menu" },
        { source: "menu", target: "wait" },
        {
          source: "wait",
          sourceHandle: getPostActionAnswerMatchHandleId("yes"),
          target: "confirmed",
        },
        {
          source: "wait",
          sourceHandle: getPostActionConditionHandleId("no_reply_timeout"),
          target: "reminder",
        },
      ]
    );
  const continueTo = (
    graph: ReturnType<typeof compileScenarioGraph>,
    target: string,
    triggerEventKind: ScenarioRuntimeEventKind,
    continuationSourceActionNodeId?: string
  ) =>
    evaluateScenarioFlow({
      graph,
      conversation: { _id: "conversation-1" } as never,
      channel: "whatsapp",
      preferredActionNodeId: target,
      requiredActionNodeId: target,
      continuationSourceActionNodeId,
      matchedTriggerNodeId: "trigger",
      triggerEventKind,
    });

  it.each([
    ["an action outcome", "source", "exact-target"],
    ["a legacy condition", "menu", "confirmed"],
  ] as const)(
    "continues %s's matched answer to its target",
    (_, waitingActionNodeId, target) => {
      const graph =
        target === "exact-target"
          ? createActionOwnedOutcomeFixture().graph
          : legacyAnswerGraph();

      expect(graph.diagnostics).toEqual([]);
      for (const continuationSource of [waitingActionNodeId, undefined]) {
        expect(
          continueTo(
            graph,
            target,
            SCENARIO_TRIGGER_EVENT_KIND.postActionUserReply,
            continuationSource
          )?.selectedAction.id
        ).toBe(target);
      }
    }
  );

  it("keeps an answer branch closed to other events", () => {
    const { graph } = createActionOwnedOutcomeFixture();

    for (const eventKind of [
      SCENARIO_TRIGGER_EVENT_KIND.inboundMessage,
      SCENARIO_TRIGGER_EVENT_KIND.paymentDetected,
      SCENARIO_TRIGGER_EVENT_KIND.whatsAppButtonReply,
    ]) {
      expect(continueTo(graph, "exact-target", eventKind, "source")).toBeNull();
    }
  });
});
