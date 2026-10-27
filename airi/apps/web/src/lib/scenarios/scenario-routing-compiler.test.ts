import {
  ACTION_ANY_REPLY_OUTCOME_HANDLE_ID,
  ACTION_NO_REPLY_OUTCOME_HANDLE_ID,
  ACTION_OUTCOME_HANDLE_PREFIX,
  ACTION_PAYMENT_OUTCOME_HANDLE_ID,
  ACTION_WHATSAPP_TEMPLATE_BUTTON_BRANCH_OUTPUT_HANDLE_ID,
  GENERATIVE_AI_FAILURE_HANDLE,
  GENERATIVE_AI_SUCCESS_HANDLE,
  buildScenarioActionAnswerOutcomeHandleId,
  buildWhatsAppSessionChoiceSourceHandleId,
  buildWhatsAppTemplateButtonSourceHandleId,
  getScenarioActionBranchDelayVirtualNodeId,
  getScenarioActionOutcomeVirtualNodeId,
  lowerScenarioRoutingGraph,
} from "@icecore/scenario-contracts";

function action(id: string, data: Record<string, unknown> = {}) {
  return {
    id,
    type: "scenario",
    position: { x: 20, y: 40 },
    data: { kind: "action", actionType: "reply", ...data },
  };
}

function node(id: string, data: Record<string, unknown> = {}) {
  return {
    id,
    type: "scenario",
    position: { x: 0, y: 0 },
    data: { kind: "logic", logicType: "audience_filter", ...data },
  };
}

function edge(source: string, target: string, sourceHandle?: string | null) {
  return {
    id: `${source}:${sourceHandle ?? "default"}:${target}`,
    source,
    target,
    sourceHandle,
    targetHandle: "left-target",
    markerEnd: { type: "arrowclosed" },
  };
}

const firstButton = buildWhatsAppTemplateButtonSourceHandleId(0);
const secondButton = buildWhatsAppTemplateButtonSourceHandleId(1);
const helpChoice = buildWhatsAppSessionChoiceSourceHandleId("wsc:menu:help");

function templateMenu(branchDelays: unknown[], extra = {}) {
  return action("menu", {
    actionType: "whatsapp_template",
    actionWhatsAppTemplateName: "pick_lang",
    actionWhatsAppTemplateComponents: [
      {
        type: "BUTTONS",
        buttons: [
          { type: "QUICK_REPLY", text: "Kazakh" },
          { type: "QUICK_REPLY", text: "Russian" },
          { type: "URL", text: "Site", url: "https://example.com" },
        ],
      },
    ],
    actionOutcomes: { version: 1, branchDelays },
    ...extra,
  });
}

function replyButtonsMenu(
  branchDelays: unknown[],
  otherOutcomes: Record<string, unknown> = {}
) {
  return action("menu", {
    actionWhatsAppServiceMessage: {
      version: 1,
      message: {
        kind: "reply_buttons",
        body: { mode: "fixed", text: "Choose" },
        options: [
          { id: "wsc:menu:help", label: "Help" },
          { id: "wsc:menu:pricing", label: "Pricing" },
        ],
      },
    },
    actionOutcomes: { version: 1, ...otherOutcomes, branchDelays },
  });
}

function buildInvalidFixture(code: string) {
  const outcomes = {
    version: 1,
    noReply: { enabled: true, timeoutMinutes: 30 },
  };

  if (code === "unsupported_action_branch_delay_handle") {
    return lowerScenarioRoutingGraph({
      nodes: [
        templateMenu([{ sourceHandle: "right-source", delayMinutes: 5 }]),
        action("follow-up"),
      ],
      edges: [edge("menu", "follow-up", "right-source")],
    });
  }
  if (code === "multiple_action_branch_delay_targets") {
    return lowerScenarioRoutingGraph({
      nodes: [
        templateMenu([{ sourceHandle: firstButton, delayMinutes: 5 }]),
        action("one"),
        action("two"),
      ],
      edges: [
        edge("menu", "one", firstButton),
        edge("menu", "two", firstButton),
      ],
    });
  }

  if (code === "reserved_persisted_node_id") {
    return lowerScenarioRoutingGraph({
      nodes: [action(" __system:foo ")],
      edges: [],
    });
  }
  if (code === "unsupported_action_run_conditions_version") {
    return lowerScenarioRoutingGraph({
      nodes: [action("send", { actionRunConditions: { version: 2 } })],
      edges: [],
    });
  }
  if (code === "unsupported_action_outcomes_version") {
    return lowerScenarioRoutingGraph({
      // Version 2 carries location routes; 3 is still unknown.
      nodes: [action("send", { actionOutcomes: { version: 3 } })],
      edges: [],
    });
  }
  if (code === "mixed_action_outcome_ownership") {
    return lowerScenarioRoutingGraph({
      nodes: [node("not-an-action"), node("follow-up")],
      edges: [
        edge("not-an-action", "follow-up", ACTION_NO_REPLY_OUTCOME_HANDLE_ID),
      ],
    });
  }
  if (code === "duplicate_action_answer_rule_id") {
    return lowerScenarioRoutingGraph({
      nodes: [
        action("send", {
          actionOutcomes: {
            ...outcomes,
            answerMatches: [
              { id: "same", mode: "exact", text: "first" },
              { id: "same", mode: "intent", text: "second" },
            ],
          },
        }),
      ],
      edges: [],
    });
  }
  if (code === "duplicate_action_exact_answer") {
    return lowerScenarioRoutingGraph({
      nodes: [
        action("send", {
          actionOutcomes: {
            ...outcomes,
            answerMatches: [
              { id: "first", mode: "exact", text: "same answer" },
              { id: "second", mode: "exact", text: "same answer" },
            ],
          },
        }),
      ],
      edges: [],
    });
  }
  if (code === "multiple_action_outcome_targets") {
    return lowerScenarioRoutingGraph({
      nodes: [
        action("send", { actionOutcomes: outcomes }),
        node("one"),
        node("two"),
      ],
      edges: [
        edge("send", "one", ACTION_NO_REPLY_OUTCOME_HANDLE_ID),
        edge("send", "two", ACTION_NO_REPLY_OUTCOME_HANDLE_ID),
      ],
    });
  }
  if (code === "malformed_action_outcome_handle") {
    return lowerScenarioRoutingGraph({
      nodes: [action("send", { actionOutcomes: outcomes }), node("follow-up")],
      edges: [
        edge(
          "send",
          "follow-up",
          `${ACTION_OUTCOME_HANDLE_PREFIX}::answer::%E0%A4%A`
        ),
      ],
    });
  }

  throw new Error(`Missing fixture for ${code}`);
}

describe("lowerScenarioRoutingGraph", () => {
  it("preserves fixed Generative AI outcome edges without lowering them", () => {
    const input = {
      nodes: [
        action("generate", {
          actionType: "generative_ai",
          actionGenerativeAIConfig: {
            version: 1,
            mode: "text_to_video",
            prompt: "Create a launch video",
          },
        }),
        node("success"),
        node("failure"),
      ],
      edges: [
        edge("generate", "success", GENERATIVE_AI_SUCCESS_HANDLE),
        edge("generate", "failure", GENERATIVE_AI_FAILURE_HANDLE),
      ],
    };

    expect(lowerScenarioRoutingGraph(input)).toEqual({
      nodes: input.nodes,
      edges: input.edges,
      diagnostics: [],
    });
  });

  it.each([
    "right-source",
    ACTION_NO_REPLY_OUTCOME_HANDLE_ID,
    ACTION_WHATSAPP_TEMPLATE_BUTTON_BRANCH_OUTPUT_HANDLE_ID,
    "right-source-generative-ai::completed",
  ])("rejects unavailable Generative AI source handle %s", sourceHandle => {
    const result = lowerScenarioRoutingGraph({
      nodes: [
        action("generate", { actionType: "generative_ai" }),
        node("target"),
      ],
      edges: [edge("generate", "target", sourceHandle)],
    });

    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "invalid_generative_ai_output_handle",
        nodeId: "generate",
        sourceHandle,
      })
    );
  });

  it("rejects more than one target for each fixed Generative AI outcome", () => {
    const result = lowerScenarioRoutingGraph({
      nodes: [
        action("generate", { actionType: "generative_ai" }),
        node("first"),
        node("second"),
        node("failure"),
      ],
      edges: [
        edge("generate", "first", GENERATIVE_AI_SUCCESS_HANDLE),
        edge("generate", "second", GENERATIVE_AI_SUCCESS_HANDLE),
        edge("generate", "failure", GENERATIVE_AI_FAILURE_HANDLE),
      ],
    });

    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "multiple_generative_ai_output_targets",
        nodeId: "generate",
        sourceHandle: GENERATIVE_AI_SUCCESS_HANDLE,
      })
    );
    expect(result.edges).toEqual([
      edge("generate", "failure", GENERATIVE_AI_FAILURE_HANDLE),
    ]);
  });

  it("rejects and removes whitespace aliases for fixed Generative AI outcomes", () => {
    const whitespaceAlias = `  ${GENERATIVE_AI_SUCCESS_HANDLE}  `;
    const result = lowerScenarioRoutingGraph({
      nodes: [
        action("generate", { actionType: "generative_ai" }),
        node("success"),
        node("failure"),
      ],
      edges: [
        edge("generate", "success", whitespaceAlias),
        edge("generate", "failure", GENERATIVE_AI_FAILURE_HANDLE),
      ],
    });

    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "invalid_generative_ai_output_handle",
        nodeId: "generate",
        sourceHandle: whitespaceAlias,
      })
    );
    expect(result.edges).toEqual([
      edge("generate", "failure", GENERATIVE_AI_FAILURE_HANDLE),
    ]);
  });

  it("lowers action outcomes to the legacy condition shape", () => {
    const outcomes = {
      version: 1,
      anyReply: { enabled: true, linkedConditionId: "reply-condition" },
      noReply: {
        enabled: true,
        timeoutMinutes: 45,
        cancelIfPhrases: ["agent replied"],
        linkedConditionId: "timeout-condition",
      },
      answerMatches: [
        { id: "yes", mode: "exact", text: "yes" },
        { id: "help", mode: "intent", text: "need help" },
      ],
      paymentDetected: { enabled: true },
    };
    const result = lowerScenarioRoutingGraph({
      nodes: [action("send", { actionOutcomes: outcomes })],
      edges: [
        edge("send", "replied", ACTION_ANY_REPLY_OUTCOME_HANDLE_ID),
        edge("send", "follow-up", ACTION_NO_REPLY_OUTCOME_HANDLE_ID),
        edge(
          "send",
          "matched",
          buildScenarioActionAnswerOutcomeHandleId("yes")
        ),
        edge("send", "paid", ACTION_PAYMENT_OUTCOME_HANDLE_ID),
      ],
    });
    const virtualId = getScenarioActionOutcomeVirtualNodeId("send");

    expect(result.diagnostics).toEqual([]);
    expect(
      result.nodes.find(item => item.id === virtualId)?.data
    ).toMatchObject({
      kind: "logic",
      logicType: "post_action_condition",
      conditionBranches: [
        {
          id: "user_replied",
          type: "user_replied",
          linkedConditionId: "reply-condition",
        },
        {
          id: "no_reply_timeout",
          type: "no_reply_timeout",
          timeoutMinutes: 45,
          missingTextPhrases: ["agent replied"],
          answerMatchRules: outcomes.answerMatches,
          linkedConditionId: "timeout-condition",
        },
        { id: "payment_detected", type: "payment_detected" },
      ],
    });
    expect(result.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: "send", target: virtualId }),
        expect.objectContaining({
          source: virtualId,
          target: "replied",
          sourceHandle: "right-source-condition-user_replied",
        }),
        expect.objectContaining({
          source: virtualId,
          target: "follow-up",
          sourceHandle: "right-source-condition-no_reply_timeout",
        }),
        expect.objectContaining({
          source: virtualId,
          target: "matched",
          sourceHandle: "right-source-condition-answer-yes",
        }),
        expect.objectContaining({
          source: virtualId,
          target: "paid",
          sourceHandle: "right-source-condition-payment_detected",
        }),
      ])
    );
    expect(result.edges).toHaveLength(5);
  });

  it.each([
    "reserved_persisted_node_id",
    "unsupported_action_run_conditions_version",
    "unsupported_action_outcomes_version",
    "mixed_action_outcome_ownership",
    "duplicate_action_answer_rule_id",
    "duplicate_action_exact_answer",
    "multiple_action_outcome_targets",
    "malformed_action_outcome_handle",
    "unsupported_action_branch_delay_handle",
    "multiple_action_branch_delay_targets",
  ])("emits stable diagnostic %s", expectedCode => {
    expect(buildInvalidFixture(expectedCode).diagnostics).toContainEqual(
      expect.objectContaining({ code: expectedCode })
    );
  });

  it("reserves every persisted canonical __system: node id", () => {
    const result = lowerScenarioRoutingGraph({
      nodes: [action(" __system:foo ")],
      edges: [],
    });

    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "reserved_persisted_node_id",
        nodeId: "__system:foo",
      })
    );
  });

  it.each([
    ACTION_OUTCOME_HANDLE_PREFIX,
    `${ACTION_OUTCOME_HANDLE_PREFIX}::answer::%E0%A4%A`,
  ])(
    "diagnoses and removes malformed action outcome handle %s",
    sourceHandle => {
      const result = lowerScenarioRoutingGraph({
        nodes: [action("send"), node("follow-up")],
        edges: [edge("send", "follow-up", sourceHandle)],
      });

      expect(result.diagnostics).toContainEqual(
        expect.objectContaining({ code: "malformed_action_outcome_handle" })
      );
      expect(result.edges).toEqual([]);
    }
  );

  it("preserves legacy nodes and edges exactly", () => {
    const legacyGraph = {
      nodes: [
        action("send"),
        node("condition", {
          logicType: "post_action_condition",
          conditionBranches: [
            {
              id: "no_reply_timeout",
              type: "no_reply_timeout",
              timeoutMinutes: 30,
            },
          ],
        }),
      ],
      edges: [
        edge("send", "condition"),
        edge(
          "condition",
          "follow-up",
          "right-source-condition-no_reply_timeout"
        ),
      ],
    };

    expect(lowerScenarioRoutingGraph(legacyGraph)).toMatchObject({
      nodes: legacyGraph.nodes,
      edges: legacyGraph.edges,
    });
  });

  it("preserves generic right-source continuation edges exactly", () => {
    const genericContinuation = {
      nodes: [
        action("send", {
          actionOutcomes: {
            version: 1,
            noReply: { enabled: true, timeoutMinutes: 30 },
          },
        }),
      ],
      edges: [edge("send", "follow-up", "right-source")],
    };

    expect(lowerScenarioRoutingGraph(genericContinuation).edges).toEqual(
      genericContinuation.edges
    );
  });

  it("does not mutate the persisted input graph", () => {
    const input = {
      nodes: [
        action("send", {
          actionOutcomes: {
            version: 1,
            noReply: {
              enabled: true,
              timeoutMinutes: 30,
              cancelIfPhrases: ["already handled"],
            },
            answerMatches: [{ id: "yes", mode: "exact", text: "yes" }],
          },
        }),
      ],
      edges: [edge("send", "follow-up", ACTION_NO_REPLY_OUTCOME_HANDLE_ID)],
    };
    const persistedSnapshot = JSON.parse(JSON.stringify(input));

    lowerScenarioRoutingGraph(input);

    expect(input).toEqual(persistedSnapshot);
  });

  it("retains multi-edge legacy and generic ordering before virtual edges", () => {
    const input = {
      nodes: [
        action("send", {
          actionOutcomes: {
            version: 1,
            noReply: { enabled: true, timeoutMinutes: 30 },
          },
        }),
        node("legacy-condition", { logicType: "post_action_condition" }),
      ],
      edges: [
        edge("start", "send", "right-source"),
        edge("send", "first-generic", "right-source"),
        edge("send", "follow-up", ACTION_NO_REPLY_OUTCOME_HANDLE_ID),
        edge("send", "second-generic", "right-source"),
        edge(
          "legacy-condition",
          "legacy-follow-up",
          "right-source-condition-no_reply_timeout"
        ),
      ],
    };
    const result = lowerScenarioRoutingGraph(input);

    expect(result.edges.slice(0, 4)).toEqual([
      input.edges[0],
      input.edges[1],
      input.edges[3],
      input.edges[4],
    ]);
  });
});

describe("delayed CTA follow-up lowering", () => {
  it("rewrites a delayed template button edge in place through its own wait", () => {
    const input = {
      nodes: [
        node("trigger", { kind: "trigger" }),
        templateMenu([
          {
            sourceHandle: firstButton,
            delayMinutes: 90,
            cancelIfPhrases: ["Order accepted"],
          },
        ]),
        action("kazakh"),
        action("russian"),
      ],
      edges: [
        edge("trigger", "menu"),
        edge("menu", "kazakh", firstButton),
        edge("menu", "russian", secondButton),
      ],
    };
    const virtualId = getScenarioActionBranchDelayVirtualNodeId(
      "menu",
      firstButton
    );

    const result = lowerScenarioRoutingGraph(input);

    expect(result.diagnostics).toEqual([]);
    expect(result.nodes.map(item => item.id)).toEqual([
      "trigger",
      "menu",
      "kazakh",
      "russian",
      virtualId,
    ]);
    expect(result.nodes.at(-1)?.data).toEqual({
      kind: "logic",
      logicType: "post_action_condition",
      conditionBranches: [
        {
          id: "no_reply_timeout",
          type: "no_reply_timeout",
          timeoutMinutes: 90,
          missingTextPhrases: ["Order accepted"],
        },
      ],
    });
    expect(result.edges).toEqual([
      input.edges[0],
      {
        id: `__system:action-branch-delay-edge:menu:${encodeURIComponent(
          firstButton
        )}:entry`,
        source: "menu",
        sourceHandle: firstButton,
        target: virtualId,
      },
      {
        ...input.edges[1],
        id: `__system:action-branch-delay-edge:menu:${encodeURIComponent(
          firstButton
        )}:follow-up`,
        source: virtualId,
        sourceHandle: "right-source-condition-no_reply_timeout",
      },
      input.edges[2],
    ]);
  });

  it("lowers a delayed session choice beside the action's own outcome wait", () => {
    const menu = replyButtonsMenu(
      [{ sourceHandle: helpChoice, delayMinutes: 5 }],
      { noReply: { enabled: true, timeoutMinutes: 30 } }
    );
    const result = lowerScenarioRoutingGraph({
      nodes: [menu, action("help"), action("later")],
      edges: [
        edge("menu", "help", helpChoice),
        edge("menu", "later", ACTION_NO_REPLY_OUTCOME_HANDLE_ID),
      ],
    });
    const outcomeWaitId = getScenarioActionOutcomeVirtualNodeId("menu");
    const delayWaitId = getScenarioActionBranchDelayVirtualNodeId(
      "menu",
      helpChoice
    );

    expect(result.diagnostics).toEqual([]);
    expect(
      result.nodes.find(item => item.id === outcomeWaitId)?.data
    ).toMatchObject({
      conditionBranches: [
        {
          id: "no_reply_timeout",
          type: "no_reply_timeout",
          timeoutMinutes: 30,
        },
      ],
    });
    expect(result.nodes.find(item => item.id === delayWaitId)?.data).toEqual(
      expect.objectContaining({
        conditionBranches: [
          {
            id: "no_reply_timeout",
            type: "no_reply_timeout",
            timeoutMinutes: 5,
          },
        ],
      })
    );
    expect(result.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "menu",
          sourceHandle: helpChoice,
          target: delayWaitId,
        }),
        expect.objectContaining({
          source: delayWaitId,
          sourceHandle: "right-source-condition-no_reply_timeout",
          target: "help",
        }),
        expect.objectContaining({ source: "menu", target: outcomeWaitId }),
        expect.objectContaining({ source: outcomeWaitId, target: "later" }),
      ])
    );
    expect(result.edges).not.toContainEqual(
      expect.objectContaining({ source: "menu", target: "help" })
    );
  });

  it("ignores a delay whose CTA is not connected yet", () => {
    const input = {
      nodes: [
        templateMenu([
          { sourceHandle: secondButton, delayMinutes: 5 },
          { sourceHandle: "right-source-unknown::9", delayMinutes: 5 },
        ]),
        action("kazakh"),
      ],
      edges: [edge("menu", "kazakh", firstButton)],
    };

    expect(lowerScenarioRoutingGraph(input)).toEqual({
      nodes: input.nodes,
      edges: input.edges,
      diagnostics: [],
    });
  });

  it.each([
    ["a generic continuation", "right-source"],
    [
      "a button the template does not offer",
      buildWhatsAppTemplateButtonSourceHandleId(2),
    ],
    ["a session choice on a template", helpChoice],
    [
      "the generic template output",
      ACTION_WHATSAPP_TEMPLATE_BUTTON_BRANCH_OUTPUT_HANDLE_ID,
    ],
  ])("rejects a delay on %s", (_, sourceHandle) => {
    const result = lowerScenarioRoutingGraph({
      nodes: [
        templateMenu([{ sourceHandle, delayMinutes: 5 }]),
        action("follow-up"),
      ],
      edges: [edge("menu", "follow-up", sourceHandle)],
    });

    expect(result.diagnostics).toEqual([
      {
        code: "unsupported_action_branch_delay_handle",
        severity: "error",
        nodeId: "menu",
        edgeId: `menu:${sourceHandle}:follow-up`,
        sourceHandle,
      },
    ]);
    expect(result.nodes).toHaveLength(2);
  });

  it("rejects a delay on a choice the service message does not offer", () => {
    const missingChoice =
      buildWhatsAppSessionChoiceSourceHandleId("wsc:menu:gone");
    const result = lowerScenarioRoutingGraph({
      nodes: [
        replyButtonsMenu([{ sourceHandle: missingChoice, delayMinutes: 5 }]),
        action("follow-up"),
      ],
      edges: [edge("menu", "follow-up", missingChoice)],
    });

    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "unsupported_action_branch_delay_handle",
        sourceHandle: missingChoice,
      })
    );
  });

  it("rejects one delayed CTA with several targets", () => {
    const result = buildInvalidFixture("multiple_action_branch_delay_targets");

    expect(result.diagnostics).toEqual([
      {
        code: "multiple_action_branch_delay_targets",
        severity: "error",
        nodeId: "menu",
        edgeId: `menu:${firstButton}:two`,
        sourceHandle: firstButton,
      },
    ]);
  });

  it("does not lower delays on terminal or Generative AI actions", () => {
    const branchDelays = [{ sourceHandle: firstButton, delayMinutes: 5 }];
    const terminal = lowerScenarioRoutingGraph({
      nodes: [
        action("end", {
          actionType: "end_scenario",
          actionOutcomes: { version: 1, branchDelays },
        }),
      ],
      edges: [],
    });
    const generative = lowerScenarioRoutingGraph({
      nodes: [
        action("generate", {
          actionType: "generative_ai",
          actionOutcomes: { version: 1, branchDelays },
        }),
        node("success"),
      ],
      edges: [edge("generate", "success", GENERATIVE_AI_SUCCESS_HANDLE)],
    });

    expect(terminal.diagnostics).toEqual([
      expect.objectContaining({ code: "terminal_action_has_outcomes" }),
    ]);
    expect(terminal.nodes).toHaveLength(1);
    expect(generative.diagnostics).toEqual([]);
    expect(generative.nodes).toHaveLength(2);
  });

  it("does not mutate the persisted graph", () => {
    const input = {
      nodes: [
        templateMenu([
          {
            sourceHandle: firstButton,
            delayMinutes: 5,
            cancelIfPhrases: ["stop"],
          },
        ]),
        action("kazakh"),
      ],
      edges: [edge("menu", "kazakh", firstButton)],
    };
    const snapshot = JSON.parse(JSON.stringify(input));

    lowerScenarioRoutingGraph(input);

    expect(input).toEqual(snapshot);
  });
});
