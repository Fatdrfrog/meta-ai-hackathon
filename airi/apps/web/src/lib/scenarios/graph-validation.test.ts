import {
  ACTION_ANY_REPLY_OUTCOME_HANDLE_ID,
  ACTION_FLOW_BRANCH_OUTPUT_HANDLE_ID,
  ACTION_INTERACTIVE_NO_REPLY_OUTPUT_HANDLE_ID,
  ACTION_NO_REPLY_OUTCOME_HANDLE_ID,
  ACTION_OUTCOME_HANDLE_PREFIX,
  ACTION_TELEGRAM_BRANCH_OUTPUT_HANDLE_ID,
  ACTION_WHATSAPP_SESSION_CHOICE_BRANCH_OUTPUT_HANDLE_ID,
  ACTION_WHATSAPP_TEMPLATE_FORM_SUBMITTED_HANDLE_ID,
  GENERATIVE_AI_SUCCESS_HANDLE,
  PROMPT_INPUTS_UNMET_HANDLE,
  buildTelegramBranchSourceHandleId,
  buildWhatsAppSessionChoicePayload,
  buildWhatsAppSessionChoiceSourceHandleId,
  type ScenarioRoutingCompilerDiagnosticCode,
} from "@icecore/scenario-contracts";
import type { ScenarioNodeData } from "@icecore/scenario-contracts";
import {
  type CompletedWhatsAppFlowProvisioningOperationEvidence,
  resolveScenarioGraphBlockingNodeIds,
  validateScenarioGraph,
} from "@/lib/scenarios/graph-validation";
import { createWhatsAppFlowEditableContentDigest } from "@/lib/scenarios/whatsapp-flow-projection";

function createNode(id: string, data: ScenarioNodeData) {
  return { id, data };
}

function canonicalFlowAction(): ScenarioNodeData {
  return {
    kind: "action",
    actionType: "reply",
    actionReplyChannel: "whatsapp",
    actionWhatsAppServiceMessage: {
      version: 1,
      message: {
        kind: "flow",
        body: { mode: "fixed", text: "Choose one" },
        flowConfig: {
          templateId: "template-1",
          ctaText: "Open",
          screens: [
            {
              id: "screen-1",
              title: "Screen",
              fields: [
                {
                  id: "radio-1",
                  label: "Choose one",
                  fieldType: "RadioButtonsGroup",
                  options: [
                    { id: "one", title: "One" },
                    { id: "two", title: "Two" },
                  ],
                },
              ],
            },
          ],
        },
      },
    },
  };
}

function canonicalReplyButtonsAction(): ScenarioNodeData {
  return {
    kind: "action",
    actionType: "reply",
    actionReplyChannel: "whatsapp",
    actionWhatsAppServiceMessage: {
      version: 1,
      message: {
        kind: "reply_buttons",
        body: { mode: "fixed", text: "Choose" },
        options: [
          { id: "pricing", label: "Pricing" },
          { id: "support", label: "Support" },
        ],
      },
    },
  };
}

function managedFlowAction() {
  const editableFlow = {
    templateId: "managed-flow-1",
    ctaText: "Open",
    flowNavigationMode: "data_endpoint" as const,
    screens: [
      { id: "DETAILS", title: "Details", fields: [] },
      { id: "CONFIRM", title: "Confirm", fields: [] },
    ],
    screenRoutes: { DETAILS: ["CONFIRM"], CONFIRM: [] },
  };
  const contentDigest = createWhatsAppFlowEditableContentDigest(editableFlow);
  return {
    contentDigest,
    projection: {
      operationId: "operation-1",
      sourceId: "source-1",
      wabaId: "waba-1",
      contentRevision: 1,
      contentDigest,
      flowId: "provider-flow-1",
      providerStatus: "PUBLISHED" as const,
    },
    data: {
      kind: "action",
      actionType: "whatsapp_template",
      actionWhatsAppTemplateName: "managed_flow_template",
      actionWhatsAppTemplateComponents: [
        {
          type: "BUTTONS",
          buttons: [
            {
              type: "FLOW",
              text: "Open",
              flow_id: "provider-flow-1",
            },
          ],
        },
      ],
      actionFlowConfig: {
        ...editableFlow,
        managedProvisioning: {
          operationId: "operation-1",
          sourceId: "source-1",
          wabaId: "waba-1",
          contentRevision: 1,
          contentDigest,
          flowId: "provider-flow-1",
          providerStatus: "PUBLISHED" as const,
        },
      },
    } satisfies ScenarioNodeData,
  };
}

function managedServiceMessageFlowAction() {
  const managed = managedFlowAction();
  return {
    ...managed,
    data: {
      kind: "action",
      actionType: "reply",
      actionReplyChannel: "whatsapp",
      actionWhatsAppServiceMessage: {
        version: 1,
        message: {
          kind: "flow",
          body: { mode: "fixed", text: "Open the Flow" },
          flowConfig: managed.data.actionFlowConfig!,
        },
      },
    } satisfies ScenarioNodeData,
  };
}

function providerReferencedServiceMessageFlowAction(
  providerStatus: "DRAFT" | "PUBLISHED" | "BLOCKED" = "PUBLISHED"
): ScenarioNodeData {
  return {
    kind: "action",
    actionType: "reply",
    actionReplyChannel: "whatsapp",
    actionWhatsAppServiceMessage: {
      version: 1,
      message: {
        kind: "flow",
        body: { mode: "fixed", text: "Open the Flow" },
        flowConfig: {
          templateId: "provider-reference",
          ctaText: "Open",
          screens: [{ id: "START", title: "Start", fields: [] }],
          providerReference: {
            flowId: "provider-flow-1",
            sourceId: "source-1",
            wabaId: "waba-1",
            providerStatus,
            jsonVersion: "7.3",
            dataApiVersion: "3.0",
          },
        },
      },
    },
  };
}

const ROUTING_COMPILER_ERROR_CODE_SET = {
  reserved_persisted_node_id: true,
  unsupported_action_run_conditions_version: true,
  unsupported_action_outcomes_version: true,
  mixed_action_outcome_ownership: true,
  duplicate_action_answer_rule_id: true,
  duplicate_action_exact_answer: true,
  multiple_action_outcome_targets: true,
  malformed_action_outcome_handle: true,
  invalid_generative_ai_output_handle: true,
  multiple_generative_ai_output_targets: true,
  terminal_action_has_outgoing_edges: true,
  terminal_action_has_outcomes: true,
  unsupported_action_branch_delay_handle: true,
  multiple_action_branch_delay_targets: true,
  duplicate_action_location_route_id: true,
} satisfies Record<ScenarioRoutingCompilerDiagnosticCode, true>;

const ROUTING_COMPILER_ERROR_CODES = Object.keys(
  ROUTING_COMPILER_ERROR_CODE_SET
) as ScenarioRoutingCompilerDiagnosticCode[];

type CompilerDiagnosticGraphFixture = {
  nodes: Array<{ id: string; data: ScenarioNodeData }>;
  edges: Array<{
    source?: string | null;
    target?: string | null;
    sourceHandle?: string | null;
  }>;
};

function buildCompilerDiagnosticGraphFixture(
  code: ScenarioRoutingCompilerDiagnosticCode
): CompilerDiagnosticGraphFixture {
  if (
    code === "terminal_action_has_outgoing_edges" ||
    code === "terminal_action_has_outcomes"
  ) {
    return {
      nodes: [
        createNode("end", {
          kind: "action",
          actionType: "end_scenario",
          ...(code === "terminal_action_has_outcomes"
            ? { actionOutcomes: { version: 1 } }
            : {}),
        }),
      ],
      edges:
        code === "terminal_action_has_outgoing_edges"
          ? [{ source: "end", target: "end" }]
          : [],
    };
  }
  const trigger = createNode("trigger-1", {
    kind: "trigger",
    triggerType: "incoming_customer_message",
  } as ScenarioNodeData);
  const action = createNode("action-1", {
    kind: "action",
    actionType: "reply",
  } as ScenarioNodeData);
  const baseEdges = [{ source: "trigger-1", target: "action-1" }];

  if (code === "reserved_persisted_node_id") {
    return {
      nodes: [{ ...trigger, id: " __system:trigger" }, action],
      edges: [{ source: " __system:trigger", target: "action-1" }],
    };
  }
  if (code === "unsupported_action_run_conditions_version") {
    return {
      nodes: [
        trigger,
        createNode("action-1", {
          kind: "action",
          actionType: "reply",
          actionRunConditions: { version: 99 },
        } as unknown as ScenarioNodeData),
      ],
      edges: baseEdges,
    };
  }
  if (code === "unsupported_action_outcomes_version") {
    return {
      nodes: [
        trigger,
        createNode("action-1", {
          kind: "action",
          actionType: "reply",
          actionOutcomes: { version: 99 },
        } as unknown as ScenarioNodeData),
      ],
      edges: baseEdges,
    };
  }
  if (code === "mixed_action_outcome_ownership") {
    return {
      nodes: [
        trigger,
        action,
        createNode("logic-1", {
          kind: "logic",
          logicType: "audience_filter",
          actionOutcomes: { version: 1 },
        } as unknown as ScenarioNodeData),
      ],
      edges: [...baseEdges, { source: "action-1", target: "logic-1" }],
    };
  }
  if (code === "duplicate_action_answer_rule_id") {
    return {
      nodes: [
        trigger,
        createNode("action-1", {
          kind: "action",
          actionType: "reply",
          actionOutcomes: {
            version: 1,
            answerMatches: [
              { id: "same", mode: "exact", text: "yes" },
              { id: "same", mode: "intent", text: "affirmative" },
            ],
          },
        } as ScenarioNodeData),
      ],
      edges: baseEdges,
    };
  }
  if (code === "duplicate_action_exact_answer") {
    return {
      nodes: [
        trigger,
        createNode("action-1", {
          kind: "action",
          actionType: "reply",
          actionOutcomes: {
            version: 1,
            answerMatches: [
              { id: "first", mode: "exact", text: "same answer" },
              { id: "second", mode: "exact", text: "same answer" },
            ],
          },
        } as ScenarioNodeData),
      ],
      edges: baseEdges,
    };
  }
  if (code === "multiple_action_outcome_targets") {
    return {
      nodes: [
        trigger,
        createNode("action-1", {
          kind: "action",
          actionType: "reply",
          actionOutcomes: {
            version: 1,
            noReply: { enabled: true, timeoutMinutes: 30 },
          },
        } as ScenarioNodeData),
        createNode("first-target", {
          kind: "action",
          actionType: "reply",
        } as ScenarioNodeData),
        createNode("second-target", {
          kind: "action",
          actionType: "reply",
        } as ScenarioNodeData),
      ],
      edges: [
        ...baseEdges,
        {
          source: "action-1",
          target: "first-target",
          sourceHandle: ACTION_NO_REPLY_OUTCOME_HANDLE_ID,
        },
        {
          source: "action-1",
          target: "second-target",
          sourceHandle: ACTION_NO_REPLY_OUTCOME_HANDLE_ID,
        },
      ],
    };
  }
  if (
    code === "unsupported_action_branch_delay_handle" ||
    code === "multiple_action_branch_delay_targets"
  ) {
    const delayedHandle =
      code === "unsupported_action_branch_delay_handle"
        ? buildWhatsAppSessionChoiceSourceHandleId("wsc:action-1:gone")
        : buildWhatsAppSessionChoiceSourceHandleId("wsc:action-1:help");
    return {
      nodes: [
        trigger,
        createNode("action-1", {
          kind: "action",
          actionType: "reply",
          actionWhatsAppServiceMessage: {
            version: 1,
            message: {
              kind: "reply_buttons",
              body: { mode: "fixed", text: "Choose" },
              options: [{ id: "wsc:action-1:help", label: "Help" }],
            },
          },
          actionOutcomes: {
            version: 1,
            branchDelays: [{ sourceHandle: delayedHandle, delayMinutes: 5 }],
          },
        } as ScenarioNodeData),
        createNode("first-target", {
          kind: "action",
          actionType: "reply",
        } as ScenarioNodeData),
        createNode("second-target", {
          kind: "action",
          actionType: "reply",
        } as ScenarioNodeData),
      ],
      edges: [
        ...baseEdges,
        {
          source: "action-1",
          target: "first-target",
          sourceHandle: delayedHandle,
        },
        ...(code === "multiple_action_branch_delay_targets"
          ? [
              {
                source: "action-1",
                target: "second-target",
                sourceHandle: delayedHandle,
              },
            ]
          : []),
      ],
    };
  }
  if (
    code === "invalid_generative_ai_output_handle" ||
    code === "multiple_generative_ai_output_targets"
  ) {
    const generativeAction = createNode("action-1", {
      kind: "action",
      actionType: "generative_ai",
      actionGenerativeAIConfig: {
        version: 1,
        mode: "text_to_video",
        prompt: "Create a launch video",
      },
    } as ScenarioNodeData);
    const firstTarget = createNode("first-target", {
      kind: "action",
      actionType: "reply",
    } as ScenarioNodeData);
    const secondTarget = createNode("second-target", {
      kind: "action",
      actionType: "reply",
    } as ScenarioNodeData);

    return {
      nodes: [trigger, generativeAction, firstTarget, secondTarget],
      edges: [
        ...baseEdges,
        {
          source: "action-1",
          target: "first-target",
          sourceHandle:
            code === "invalid_generative_ai_output_handle"
              ? "right-source"
              : GENERATIVE_AI_SUCCESS_HANDLE,
        },
        ...(code === "multiple_generative_ai_output_targets"
          ? [
              {
                source: "action-1",
                target: "second-target",
                sourceHandle: GENERATIVE_AI_SUCCESS_HANDLE,
              },
            ]
          : []),
      ],
    };
  }

  if (code === "duplicate_action_location_route_id") {
    return {
      nodes: [
        trigger,
        createNode("action-1", {
          kind: "action",
          actionType: "reply",
          actionOutcomes: {
            version: 2,
            locationRoutes: {
              routes: [
                { id: "same", match: { by: "country", values: ["KZ"] } },
                { id: "same", match: { by: "country", values: ["UZ"] } },
              ],
            },
          },
        } as ScenarioNodeData),
      ],
      edges: baseEdges,
    };
  }

  return {
    nodes: [trigger, action],
    edges: [
      ...baseEdges,
      {
        sourceHandle: `${ACTION_OUTCOME_HANDLE_PREFIX}::answer::%E0%A4%A`,
      },
    ],
  };
}

describe("validateScenarioGraph", () => {
  it.each([
    { actionHandoffNotifyEmail: "name@" },
    { actionHandoffNotifyWhatsapp: "+" },
  ])(
    "retains incomplete handoff notification targets only in drafts: %j",
    target => {
      const nodes = [
        createNode("trigger", { kind: "trigger" }),
        createNode("handoff", {
          kind: "action",
          actionType: "assign_human",
          ...target,
        }),
      ];
      const edges = [{ source: "trigger", target: "handoff" }];

      expect(validateScenarioGraph(nodes, edges, { mode: "draft" })).toBeNull();
      expect(validateScenarioGraph(nodes, edges, { mode: "runnable" })).toBe(
        "handoffNotificationInvalid"
      );
    }
  );

  it.each([
    {},
    { actionHandoffNotifyEmail: "", actionHandoffNotifyWhatsapp: "" },
    {
      actionHandoffNotifyEmail: "name@example.com",
      actionHandoffNotifyWhatsapp: "+7 (701) 123-45-67",
    },
  ])("allows optional or complete runnable handoff targets: %j", target => {
    expect(
      validateScenarioGraph(
        [
          createNode("trigger", { kind: "trigger" }),
          createNode("handoff", {
            kind: "action",
            actionType: "assign_human",
            ...target,
          }),
        ],
        [{ source: "trigger", target: "handoff" }],
        { mode: "runnable" }
      )
    ).toBeNull();
  });

  it.each([
    { messageMatchMode: "exact", keywordPattern: "" },
    { messageMatchMode: "contains", keywordPattern: "  " },
    { messageMatchMode: "contains", keywordPattern: ", ;\n" },
    {
      messageMatchMode: "contains",
      keywordMatchMode: "regex",
      keywordPattern: "[",
    },
  ] as const)(
    "retains unfinished trigger criteria in drafts: %j",
    triggerConfig => {
      const nodes = [
        createNode("trigger", { kind: "trigger", triggerConfig }),
        createNode("action", { kind: "action", actionType: "reply" }),
      ];
      const edges = [{ source: "trigger", target: "action" }];

      expect(validateScenarioGraph(nodes, edges, { mode: "draft" })).toBeNull();
      expect(validateScenarioGraph(nodes, edges, { mode: "runnable" })).toBe(
        "messageTriggerIncomplete"
      );
    }
  );

  it.each([
    { messageMatchMode: "any" },
    { messageMatchMode: "exact", keywordPattern: "Hello" },
    { messageMatchMode: "contains", keywordPattern: "hello; hi" },
    {
      messageMatchMode: "contains",
      keywordMatchMode: "regex",
      keywordPattern: "^hello",
    },
    { enabled: false, messageMatchMode: "exact", keywordPattern: "" },
  ] as const)(
    "accepts runnable or disabled trigger criteria: %j",
    triggerConfig => {
      expect(
        validateScenarioGraph(
          [
            createNode("trigger", { kind: "trigger", triggerConfig }),
            createNode("action", { kind: "action", actionType: "reply" }),
          ],
          [{ source: "trigger", target: "action" }],
          { mode: "runnable" }
        )
      ).toBeNull();
    }
  );

  it.each([undefined, "", "   "])(
    "keeps an unselected WhatsApp template as a draft: %p",
    actionWhatsAppTemplateName => {
      const nodes = [
        createNode("trigger", { kind: "trigger" }),
        createNode("action", {
          kind: "action",
          actionType: "whatsapp_template",
          actionWhatsAppTemplateName,
        }),
      ];
      const edges = [{ source: "trigger", target: "action" }];

      expect(validateScenarioGraph(nodes, edges, { mode: "draft" })).toBeNull();
      expect(validateScenarioGraph(nodes, edges, { mode: "runnable" })).toBe(
        "whatsappTemplateRequired"
      );
    }
  );

  it.each([undefined, "", "en", "kk_KZ"])(
    "preserves runtime template language resolution for %p",
    actionWhatsAppTemplateLanguage => {
      expect(
        validateScenarioGraph(
          [
            createNode("trigger", { kind: "trigger" }),
            createNode("action", {
              kind: "action",
              actionType: "whatsapp_template",
              actionWhatsAppTemplateName: "hello",
              actionWhatsAppTemplateLanguage,
            }),
          ],
          [{ source: "trigger", target: "action" }],
          { mode: "runnable" }
        )
      ).toBeNull();
    }
  );

  it("saves an incomplete template mapping as a draft but blocks activation and identifies the action", () => {
    const nodes = [
      createNode("trigger", { kind: "trigger" }),
      createNode("template", {
        kind: "action",
        actionType: "whatsapp_template",
        actionWhatsAppTemplateName: "order_update",
        actionWhatsAppTemplateComponents: [
          { type: "BODY", text: "Order {{1}}" },
        ],
        actionWhatsAppTemplateBindings: { version: 1, parameters: {} },
      }),
    ];
    const edges = [{ source: "trigger", target: "template" }];
    expect(validateScenarioGraph(nodes, edges, { mode: "draft" })).toBeNull();
    expect(validateScenarioGraph(nodes, edges, { mode: "runnable" })).toBe(
      "whatsappTemplateBindingsInvalid"
    );
    expect(
      resolveScenarioGraphBlockingNodeIds(
        nodes,
        edges,
        "whatsappTemplateBindingsInvalid"
      )
    ).toEqual(["template"]);
  });

  it("blocks mappings to collected answers that cannot reach the template action", () => {
    const nodes = [
      createNode("trigger", { kind: "trigger" }),
      createNode("template", {
        kind: "action",
        actionType: "whatsapp_template",
        actionWhatsAppTemplateName: "order_update",
        actionWhatsAppTemplateComponents: [
          { type: "BODY", text: "Order {{1}}" },
        ],
        actionWhatsAppTemplateBindings: {
          version: 1,
          parameters: {
            "body:1": { source: "prompt_input", key: "order_number" },
          },
        },
      }),
    ];
    expect(
      validateScenarioGraph(
        nodes,
        [{ source: "trigger", target: "template" }],
        { mode: "runnable" }
      )
    ).toBe("whatsappTemplateBindingsInvalid");
  });

  it("allows complete explicit mappings using literals and known runtime fields", () => {
    const nodes = [
      createNode("trigger", { kind: "trigger" }),
      createNode("template", {
        kind: "action",
        actionType: "whatsapp_template",
        actionWhatsAppTemplateName: "order_update",
        actionWhatsAppTemplateComponents: [
          { type: "BODY", text: "{{1}}, order {{2}} is ready" },
        ],
        actionWhatsAppTemplateBindings: {
          version: 1,
          parameters: {
            "body:1": { source: "context", key: "first_name" },
            "body:2": { source: "literal", value: "ORD-42" },
          },
        },
      }),
    ];
    expect(
      validateScenarioGraph(
        nodes,
        [{ source: "trigger", target: "template" }],
        { mode: "runnable" }
      )
    ).toBeNull();
  });

  it.each(["empty", "disconnected"])(
    "allows an unfinished %s graph only in draft mode",
    graphKind => {
      const nodes =
        graphKind === "empty"
          ? []
          : [
              createNode("trigger-1", { kind: "trigger" }),
              createNode("action-1", { kind: "action", actionType: "reply" }),
              createNode("unfinished", { kind: "action", actionType: "reply" }),
            ];
      const edges =
        graphKind === "empty"
          ? []
          : [{ source: "trigger-1", target: "action-1" }];
      const expectedError =
        graphKind === "empty" ? "oneTriggerRequired" : "singleFlowRequired";

      expect(validateScenarioGraph(nodes, edges, { mode: "draft" })).toBeNull();
      expect(validateScenarioGraph(nodes, edges)).toBe(expectedError);
      expect(validateScenarioGraph(nodes, edges, { mode: "graph" })).toBe(
        expectedError
      );
      expect(validateScenarioGraph(nodes, edges, { mode: "runnable" })).toBe(
        expectedError
      );
    }
  );

  it("names the disconnected blocks behind a connectivity failure", () => {
    const nodes = [
      createNode("trigger-1", { kind: "trigger" }),
      createNode("action-1", { kind: "action", actionType: "reply" }),
      createNode("stray-1", { kind: "action", actionType: "reply" }),
      createNode("stray-2", { kind: "action", actionType: "reply" }),
    ];
    const edges = [{ source: "trigger-1", target: "action-1" }];

    expect(validateScenarioGraph(nodes, edges)).toBe("singleFlowRequired");
    expect(
      resolveScenarioGraphBlockingNodeIds(nodes, edges, "singleFlowRequired")
    ).toEqual(["stray-1", "stray-2"]);
  });

  it("returns no blocking blocks when the code is not a connectivity one", () => {
    const nodes = [
      createNode("trigger-1", { kind: "trigger" }),
      createNode("action-1", { kind: "action", actionType: "reply" }),
    ];
    const edges = [{ source: "trigger-1", target: "action-1" }];

    expect(
      resolveScenarioGraphBlockingNodeIds(
        nodes,
        edges,
        "whatsappServiceMessageInvalid"
      )
    ).toEqual([]);
  });

  it.each(ROUTING_COMPILER_ERROR_CODES)(
    "returns compiler error %s",
    expected => {
      const fixture = buildCompilerDiagnosticGraphFixture(expected);

      expect(validateScenarioGraph(fixture.nodes, fixture.edges)).toBe(
        expected
      );
    }
  );

  it("accepts delayed CTA follow-ups, including a delay not yet connected", () => {
    const helpHandle =
      buildWhatsAppSessionChoiceSourceHandleId("wsc:menu:help");
    const pricingHandle =
      buildWhatsAppSessionChoiceSourceHandleId("wsc:menu:pricing");
    const nodes = [
      createNode("trigger-1", { kind: "trigger" }),
      createNode("menu", {
        kind: "action",
        actionType: "reply",
        actionWhatsAppServiceMessage: {
          version: 1,
          message: {
            kind: "reply_buttons",
            body: { mode: "fixed", text: "Choose" },
            options: [
              { id: "wsc:menu:help", label: "Help" },
              { id: "wsc:menu:pricing", label: "Pricing" },
              { id: "wsc:menu:later", label: "Later" },
            ],
          },
        },
        actionOutcomes: {
          version: 1,
          noReply: { enabled: true, timeoutMinutes: 30 },
          branchDelays: [
            {
              sourceHandle: helpHandle,
              delayMinutes: 60,
              cancelIfPhrases: ["Order accepted"],
            },
            {
              sourceHandle:
                buildWhatsAppSessionChoiceSourceHandleId("wsc:menu:later"),
              delayMinutes: 5,
            },
          ],
        },
      }),
      createNode("help", { kind: "action", actionType: "reply" }),
      createNode("pricing", { kind: "action", actionType: "reply" }),
      createNode("reminder", { kind: "action", actionType: "reply" }),
    ];
    const edges = [
      { source: "trigger-1", target: "menu" },
      { source: "menu", target: "help", sourceHandle: helpHandle },
      { source: "menu", target: "pricing", sourceHandle: pricingHandle },
      {
        source: "menu",
        target: "reminder",
        sourceHandle: ACTION_NO_REPLY_OUTCOME_HANDLE_ID,
      },
    ];

    expect(validateScenarioGraph(nodes, edges, { mode: "graph" })).toBeNull();
    expect(
      validateScenarioGraph(nodes, edges, { mode: "runnable" })
    ).toBeNull();
  });

  it("fails closed for a dangling malformed action-outcome edge", () => {
    const fixture = buildCompilerDiagnosticGraphFixture(
      "malformed_action_outcome_handle"
    );

    expect(
      validateScenarioGraph(fixture.nodes, fixture.edges.slice(0, 1))
    ).toBe(null);
    expect(validateScenarioGraph(fixture.nodes, fixture.edges)).toBe(
      "malformed_action_outcome_handle"
    );
  });

  it("retains unfinished routing drafts until graph validation is requested", () => {
    const fixture = buildCompilerDiagnosticGraphFixture(
      "duplicate_action_exact_answer"
    );

    expect(
      validateScenarioGraph(fixture.nodes, fixture.edges, { mode: "draft" })
    ).toBeNull();
    expect(
      validateScenarioGraph(fixture.nodes, fixture.edges, { mode: "graph" })
    ).toBe("duplicate_action_exact_answer");
  });

  it("uses persisted outcome endpoints for connectivity and lowered routing for structure", () => {
    const nodes = [
      createNode("trigger-1", {
        kind: "trigger",
      } as ScenarioNodeData),
      createNode("action-1", {
        kind: "action",
        actionType: "reply",
        actionOutcomes: {
          version: 1,
          anyReply: { enabled: true },
          noReply: { enabled: true, timeoutMinutes: 30 },
        },
      } as ScenarioNodeData),
      createNode("replied", {
        kind: "action",
        actionType: "reply",
      } as ScenarioNodeData),
      createNode("follow-up", {
        kind: "action",
        actionType: "reply",
      } as ScenarioNodeData),
    ];
    const edges = [
      { source: "trigger-1", target: "action-1" },
      {
        source: "action-1",
        target: "replied",
        sourceHandle: ACTION_ANY_REPLY_OUTCOME_HANDLE_ID,
      },
      {
        source: "action-1",
        target: "follow-up",
        sourceHandle: ACTION_NO_REPLY_OUTCOME_HANDLE_ID,
      },
    ];

    expect(validateScenarioGraph(nodes, edges)).toBeNull();
  });

  it.each([
    undefined,
    { version: 1, mode: "text_to_video", prompt: "   " },
    { version: 1, mode: "text_to_image", prompt: "Unsupported" },
    { version: 99, mode: "text_to_video", prompt: "Future" },
  ])("rejects invalid Generative AI action config on activation %#", config => {
    const nodes = [
      createNode("trigger-1", {
        kind: "trigger",
        triggerType: "incoming_customer_message",
      } as ScenarioNodeData),
      createNode("action-1", {
        kind: "action",
        actionType: "generative_ai",
        ...(config === undefined ? {} : { actionGenerativeAIConfig: config }),
      } as unknown as ScenarioNodeData),
    ];

    expect(
      validateScenarioGraph(
        nodes,
        [{ source: "trigger-1", target: "action-1" }],
        { mode: "runnable" }
      )
    ).toBe("generativeAIConfigInvalid");
  });

  it.each(["", "11111111-1111-4111-8111-111111111111"])(
    "validates a configured image source on activation: %s",
    sourceId => {
      const nodes = [
        createNode("trigger-1", {
          kind: "trigger",
          triggerType: "incoming_customer_message",
        } as ScenarioNodeData),
        createNode("action-1", {
          kind: "action",
          actionType: "generative_ai",
          actionGenerativeAIConfig: {
            version: 1,
            mode: "text_to_image",
            prompt: "Create a medal preview",
            image: {
              provider: "google",
              sourceId,
              modelId: "gemini-3.1-flash-image",
              aspectRatio: "21:9",
              referenceImages: [],
              includeInboundText: true,
            },
          },
        }),
      ];
      const edges = [{ source: "trigger-1", target: "action-1" }];
      expect(validateScenarioGraph(nodes, edges, { mode: "draft" })).toBeNull();
      expect(validateScenarioGraph(nodes, edges, { mode: "runnable" })).toBe(
        sourceId ? null : "generativeAIConfigInvalid"
      );
    }
  );

  it("saves an image draft whose model left the catalog but blocks activation", () => {
    const nodes = [
      createNode("trigger-1", {
        kind: "trigger",
        triggerType: "incoming_customer_message",
      } as ScenarioNodeData),
      createNode("action-1", {
        kind: "action",
        actionType: "generative_ai",
        actionGenerativeAIConfig: {
          version: 1,
          mode: "text_to_image",
          prompt: "Create a medal preview",
          image: {
            provider: "google",
            sourceId: "11111111-1111-4111-8111-111111111111",
            modelId: "gemini-retired-image",
            aspectRatio: "21:9",
            referenceImages: [],
            includeInboundText: true,
          },
        },
      } as unknown as ScenarioNodeData),
    ];
    const edges = [{ source: "trigger-1", target: "action-1" }];

    expect(validateScenarioGraph(nodes, edges, { mode: "draft" })).toBeNull();
    expect(validateScenarioGraph(nodes, edges, { mode: "runnable" })).toBe(
      "generativeAIConfigInvalid"
    );
  });

  describe("collected answers in Generative AI prompts", () => {
    const trigger = createNode("trigger", {
      kind: "trigger",
      triggerType: "incoming_customer_message",
    } as ScenarioNodeData);
    const ask = createNode("ask", {
      kind: "action",
      actionType: "reply",
      actionWhatsAppServiceMessage: {
        version: 1,
        message: {
          kind: "text",
          body: { mode: "fixed", text: "Send the name and sport." },
          previewUrl: false,
        },
        promptInputs: [
          { key: "name", label: "Name", prompt: "Name on the holder" },
          { key: "sport", label: "Sport", prompt: "Sport to illustrate" },
        ],
      },
    } as unknown as ScenarioNodeData);
    const repeat = createNode("repeat", {
      kind: "action",
      actionType: "reply",
      actionReplyMode: "fixed",
      actionReplyText: "Please send both details.",
    } as ScenarioNodeData);
    const generate = (prompt: string) =>
      createNode("generate", {
        kind: "action",
        actionType: "generative_ai",
        actionGenerativeAIConfig: { version: 1, mode: "text_to_video", prompt },
      } as ScenarioNodeData);

    it("accepts answers collected on every path to the action", () => {
      expect(
        validateScenarioGraph(
          [trigger, ask, generate("Film {{input.name}} ({input.sport})")],
          [
            { source: "trigger", target: "ask" },
            { source: "ask", target: "generate" },
          ],
          { mode: "runnable" }
        )
      ).toBeNull();
    });

    it("saves a draft but blocks activation for an answer nothing collects", () => {
      const nodes = [trigger, ask, generate("Film {{input.city}}")];
      const edges = [
        { source: "trigger", target: "ask" },
        { source: "ask", target: "generate" },
      ];

      expect(validateScenarioGraph(nodes, edges, { mode: "draft" })).toBeNull();
      expect(validateScenarioGraph(nodes, edges, { mode: "runnable" })).toBe(
        "generativeAIPromptInputUnavailable"
      );
      expect(
        resolveScenarioGraphBlockingNodeIds(
          nodes,
          edges,
          "generativeAIPromptInputUnavailable"
        )
      ).toEqual(["generate"]);
    });

    it("blocks an answer that the unmet route can bypass", () => {
      expect(
        validateScenarioGraph(
          [trigger, ask, repeat, generate("Film {{input.name}}")],
          [
            { source: "trigger", target: "ask" },
            { source: "ask", target: "generate" },
            {
              source: "ask",
              target: "repeat",
              sourceHandle: PROMPT_INPUTS_UNMET_HANDLE,
            },
            { source: "repeat", target: "generate" },
          ],
          { mode: "runnable" }
        )
      ).toBe("generativeAIPromptInputUnavailable");
    });
  });

  describe("form answers in AI prompts", () => {
    const trigger = createNode("trigger", {
      kind: "trigger",
      triggerType: "incoming_customer_message",
    } as ScenarioNodeData);
    const form = (id: string, answersKey: string) =>
      createNode(id, {
        kind: "action",
        actionType: "reply",
        actionReplyChannel: "whatsapp",
        actionWhatsAppServiceMessage: {
          version: 1,
          message: {
            kind: "flow",
            body: { mode: "fixed", text: "Fill in your order" },
            flowConfig: {
              templateId: "lead_generation",
              ctaText: "Open",
              metaFlowId: `legacy-${id}`,
              answersKey,
              screens: [
                {
                  id: "DETAILS",
                  title: "Details",
                  fields: [
                    {
                      id: "size",
                      label: "Size",
                      fieldType: "TextInput",
                      required: true,
                    },
                  ],
                },
              ],
            },
          },
        },
      } as ScenarioNodeData);
    // A template's form, so two forms can follow each other.
    const templateForm = (id: string, answersKey: string) =>
      createNode(id, {
        kind: "action",
        actionType: "whatsapp_template",
        actionWhatsAppTemplateName: `${id}_template`,
        actionWhatsAppTemplateLanguage: "en",
        actionFlowConfig: {
          templateId: "lead_generation",
          ctaText: "Open",
          metaFlowId: `legacy-${id}`,
          answersKey,
          screens: [
            {
              id: "DETAILS",
              title: "Details",
              fields: [{ id: "size", label: "Size", fieldType: "TextInput" }],
            },
          ],
        },
      } as ScenarioNodeData);
    const generate = (prompt: string) =>
      createNode("generate", {
        kind: "action",
        actionType: "generative_ai",
        actionGenerativeAIConfig: { version: 1, mode: "text_to_video", prompt },
      } as ScenarioNodeData);
    const aiReply = (instruction: string) =>
      createNode("reply", {
        kind: "action",
        actionType: "reply",
        actionReplyMode: "ai",
        actionReplyInstruction: instruction,
      } as ScenarioNodeData);
    const chain = (...ids: string[]) =>
      ids.slice(1).map((target, index) => ({ source: ids[index], target }));

    it("accepts answers of a form before the step, on some paths or all", () => {
      expect(
        validateScenarioGraph(
          [
            trigger,
            form("order", "order"),
            generate("A {{form.order.size}} cup"),
          ],
          chain("trigger", "order", "generate"),
          { mode: "runnable" }
        )
      ).toBeNull();
      const other = createNode("other", {
        kind: "action",
        actionType: "reply",
        actionReplyMode: "fixed",
        actionReplyText: "Hello",
      } as ScenarioNodeData);
      // The customer can reach the reply without the form: it may be empty.
      expect(
        validateScenarioGraph(
          [
            trigger,
            form("order", "order"),
            other,
            aiReply("Confirm {{form.order.size}} and {{input.name}}"),
          ],
          [
            ...chain("trigger", "order", "reply"),
            { source: "trigger", target: "other" },
            { source: "other", target: "reply" },
          ],
          { mode: "runnable" }
        )
      ).toBeNull();
    });

    it("saves a draft but blocks activation for an answer no earlier form has", () => {
      const nodes = [
        trigger,
        form("order", "order"),
        generate("A {{form.order.colour}} cup"),
      ];
      const edges = chain("trigger", "order", "generate");
      expect(validateScenarioGraph(nodes, edges, { mode: "draft" })).toBeNull();
      expect(validateScenarioGraph(nodes, edges, { mode: "runnable" })).toBe(
        "formAnswerUnavailable"
      );
      expect(
        resolveScenarioGraphBlockingNodeIds(
          nodes,
          edges,
          "formAnswerUnavailable"
        )
      ).toEqual(["generate"]);
    });

    it("blocks AI writes instructions that read a form after the step", () => {
      const nodes = [
        trigger,
        aiReply("Confirm {{form.order.size}}"),
        form("order", "order"),
      ];
      const edges = chain("trigger", "reply", "order");
      expect(validateScenarioGraph(nodes, edges, { mode: "runnable" })).toBe(
        "formAnswerUnavailable"
      );
      expect(
        resolveScenarioGraphBlockingNodeIds(
          nodes,
          edges,
          "formAnswerUnavailable"
        )
      ).toEqual(["reply"]);
    });

    it("blocks two forms that store the same variable name, naming the later", () => {
      const nodes = [
        trigger,
        form("first", "order"),
        templateForm("second", "order"),
      ];
      const edges = chain("trigger", "first", "second");
      expect(validateScenarioGraph(nodes, edges, { mode: "draft" })).toBeNull();
      expect(validateScenarioGraph(nodes, edges, { mode: "runnable" })).toBe(
        "formAnswersKeyDuplicate"
      );
      expect(
        resolveScenarioGraphBlockingNodeIds(
          nodes,
          edges,
          "formAnswersKeyDuplicate"
        )
      ).toEqual(["second"]);
    });

    it("blocks answers of a template's left-over form its buttons never open", () => {
      const withButtons = (buttons: Array<Record<string, string>>) =>
        createNode("order", {
          ...templateForm("order", "order").data,
          actionWhatsAppTemplateComponents: [
            { type: "BODY", text: "Your order" },
            { type: "BUTTONS", buttons },
          ],
        } as ScenarioNodeData);
      const edges = chain("trigger", "order", "generate");
      const prompt = generate("A {{form.order.size}} cup");
      expect(
        validateScenarioGraph(
          [
            trigger,
            withButtons([
              { type: "FLOW", text: "Open", flow_id: "legacy-order" },
            ]),
            prompt,
          ],
          edges,
          { mode: "runnable" }
        )
      ).toBeNull();
      const nodes = [
        trigger,
        withButtons([{ type: "QUICK_REPLY", text: "Yes" }]),
        prompt,
      ];
      expect(validateScenarioGraph(nodes, edges, { mode: "runnable" })).toBe(
        "formAnswerUnavailable"
      );
      expect(
        resolveScenarioGraphBlockingNodeIds(
          nodes,
          edges,
          "formAnswerUnavailable"
        )
      ).toEqual(["generate"]);
    });

    it("blocks answers of a form linked from Meta in place of a built one", () => {
      // Linking keeps the step's key, so the prompt still names the form.
      const linked = providerReferencedServiceMessageFlowAction();
      const message = linked.actionWhatsAppServiceMessage as {
        message: { flowConfig: Record<string, unknown> };
      };
      message.message.flowConfig.answersKey = "order";
      const nodes = [
        trigger,
        createNode("order", linked),
        generate("A {{form.order.size}} cup"),
      ];
      const edges = chain("trigger", "order", "generate");
      expect(
        validateScenarioGraph(nodes, edges, {
          mode: "runnable",
          currentWhatsAppSourceWabaBindings: { "source-1": "waba-1" },
        })
      ).toBe("formAnswerUnavailable");
      expect(
        resolveScenarioGraphBlockingNodeIds(
          nodes,
          edges,
          "formAnswerUnavailable"
        )
      ).toEqual(["generate"]);
    });
  });

  describe("a template's Form submitted route", () => {
    const FORM_SUBMITTED = ACTION_WHATSAPP_TEMPLATE_FORM_SUBMITTED_HANDLE_ID;
    type Node = ReturnType<typeof createNode>;
    type Edge = { source: string; target: string; sourceHandle?: string };
    const trigger = createNode("trigger", {
      kind: "trigger",
      triggerType: "incoming_customer_message",
    } as ScenarioNodeData);
    const formButton = {
      type: "FLOW",
      text: "Open form",
      flow_id: 1571793974235171,
    };
    const template = (
      buttons: Array<Record<string, unknown>> = [formButton],
      extra: Record<string, unknown> = {}
    ) =>
      createNode("template", {
        kind: "action",
        actionType: "whatsapp_template",
        actionWhatsAppTemplateName: "demoshop_test",
        actionWhatsAppTemplateLanguage: "ru",
        actionWhatsAppTemplateComponents: [
          { type: "BODY", text: "Tell us about the athlete" },
          { type: "BUTTONS", buttons },
        ],
        ...extra,
      } as unknown as ScenarioNodeData);
    const thanks = createNode("thanks", {
      kind: "action",
      actionType: "reply",
      actionReplyMode: "fixed",
      actionReplyText: "Thanks",
    } as ScenarioNodeData);
    const sendTemplate = { source: "trigger", target: "template" };
    const formRoute = (target: string): Edge => ({
      source: "template",
      target,
      sourceHandle: FORM_SUBMITTED,
    });
    const expectBlockedOnceChecked = (
      nodes: Node[],
      edges: Edge[],
      code: string
    ) => {
      expect(validateScenarioGraph(nodes, edges, { mode: "draft" })).toBeNull();
      expect(validateScenarioGraph(nodes, edges, { mode: "graph" })).toBe(code);
      expect(validateScenarioGraph(nodes, edges, { mode: "runnable" })).toBe(
        code
      );
    };

    it.each([
      ["quick replies only", [{ type: "QUICK_REPLY", text: "Call me" }]],
      [
        "two form buttons",
        [formButton, { ...formButton, text: "Other form", flow_id: 2 }],
      ],
    ])("blocks the route on a template with %s", (_name, buttons) => {
      const nodes = [trigger, template(buttons), thanks];
      const edges = [sendTemplate, formRoute("thanks")];
      expectBlockedOnceChecked(
        nodes,
        edges,
        "whatsappTemplateFormRouteUnavailable"
      );
      expect(
        resolveScenarioGraphBlockingNodeIds(
          nodes,
          edges,
          "whatsappTemplateFormRouteUnavailable"
        )
      ).toEqual(["template"]);
    });

    it("blocks the route into a Reply or no reply block, not Then", () => {
      const wait = createNode("wait", {
        kind: "logic",
        logicType: "post_action_condition",
      } as ScenarioNodeData);
      const nodes = [trigger, template(), wait];
      const edges = [sendTemplate, formRoute("wait")];
      expectBlockedOnceChecked(
        nodes,
        edges,
        "whatsappTemplateFormRouteConditionTarget"
      );
      expect(
        resolveScenarioGraphBlockingNodeIds(
          nodes,
          edges,
          "whatsappTemplateFormRouteConditionTarget"
        )
      ).toEqual(["template"]);
      expect(
        resolveScenarioGraphBlockingNodeIds(
          nodes,
          edges,
          "whatsappTemplateFormRouteUnavailable"
        )
      ).toEqual([]);
      expect(
        validateScenarioGraph(
          nodes,
          [sendTemplate, { source: "template", target: "wait" }],
          { mode: "graph" }
        )
      ).toBeNull();
    });

    it("blocks the route on a bulk send", () => {
      const bulk = createNode("bulk", {
        kind: "bulk",
        bulkRootConfig: {
          workflowKind: "bulk_campaign",
          sendMode: "immediate",
          channels: ["whatsapp"],
          campaignName: "Medal day",
          recipientSourceSummary: "12 selected recipients",
          generationStatus: "complete",
        },
      } as unknown as ScenarioNodeData);
      expectBlockedOnceChecked(
        [bulk, template(), thanks],
        [{ source: "bulk", target: "template" }, formRoute("thanks")],
        "whatsappTemplateFormRouteInBulk"
      );
    });

    it("runs DemoShop's form, carousel and AI image, once the form's fields are loaded", () => {
      const savedForm = {
        version: 1,
        flowId: "1571793974235171",
        flowName: "demoshop_ai_case",
        answersKey: "demoshop_ai_case",
        digest: null,
        coverage: "complete",
        endpoint: false,
        readAt: "2026-10-05T09:00:00.000Z",
        fields: [
          {
            responseKey: "f_68d224",
            label: "Athlete's name",
            description: "",
            fieldType: "TextInput",
            required: true,
            screenIndex: 0,
            options: [],
          },
        ],
      };
      const carousel = createNode("carousel", {
        kind: "action",
        actionType: "reply",
        actionWhatsAppServiceMessage: {
          version: 1,
          message: {
            kind: "media_carousel",
            body: { mode: "fixed", text: "Pick a medal" },
            cards: ["gold", "silver"].map(id => ({
              id: `card-${id}`,
              media: {
                url: `gcs://media/workspaces/ws/creative-assets/image/${id}.jpg`,
                mediaType: "image",
                mimeType: "image/jpeg",
                fileSize: 2048,
                bucket: "media",
                path: `workspaces/ws/creative-assets/image/${id}.jpg`,
              },
              bodyText: `${id} medal`,
              interaction: {
                kind: "quick_replies",
                options: [{ id: `wsc:carousel:${id}`, label: "Pick" }],
              },
            })),
          },
        },
      } as unknown as ScenarioNodeData);
      const generate = createNode("generate", {
        kind: "action",
        actionType: "generative_ai",
        actionGenerativeAIConfig: {
          version: 1,
          mode: "text_to_image",
          prompt: "{{form.demoshop_ai_case.f_68d224}} holds the {{picked.text}}",
          image: {
            provider: "google",
            sourceId: "11111111-1111-4111-8111-111111111111",
            modelId: "gemini-3.1-flash-image",
            aspectRatio: "1:1",
            referenceImages: [],
            includeInboundText: false,
          },
          pickedOption: {
            sourceActionNodeId: "carousel",
            includeCardImage: false,
          },
        },
      } as unknown as ScenarioNodeData);
      const edges = [
        sendTemplate,
        formRoute("carousel"),
        ...["gold", "silver"].map(id => ({
          source: "carousel",
          target: "generate",
          sourceHandle: buildWhatsAppSessionChoiceSourceHandleId(
            `wsc:carousel:${id}`
          ),
        })),
      ];
      expect(
        validateScenarioGraph(
          [
            trigger,
            template(undefined, { actionWhatsAppTemplateForm: savedForm }),
            carousel,
            generate,
          ],
          edges,
          { mode: "runnable" }
        )
      ).toBeNull();
      const nodes = [trigger, template(), carousel, generate];
      expect(validateScenarioGraph(nodes, edges, { mode: "runnable" })).toBe(
        "formAnswerUnavailable"
      );
      expect(
        resolveScenarioGraphBlockingNodeIds(
          nodes,
          edges,
          "formAnswerUnavailable"
        )
      ).toEqual(["generate"]);
    });
  });

  describe("picked options in Generative AI", () => {
    const trigger = createNode("trigger", {
      kind: "trigger",
      triggerType: "incoming_customer_message",
    } as ScenarioNodeData);
    const cardImage = (name: string, mimeType = "image/jpeg") => ({
      url: `gcs://media/workspaces/ws/creative-assets/image/${name}`,
      mediaType: "image",
      mimeType,
      fileSize: 2048,
      bucket: "media",
      path: `workspaces/ws/creative-assets/image/${name}`,
    });
    const carousel = (secondMimeType?: string) =>
      createNode("carousel", {
        kind: "action",
        actionType: "reply",
        actionWhatsAppServiceMessage: {
          version: 1,
          message: {
            kind: "media_carousel",
            body: { mode: "fixed", text: "Pick a frame" },
            cards: [
              ["a", cardImage("a.jpg")],
              ["b", cardImage("b.jpg", secondMimeType)],
            ].map(([id, media]) => ({
              id: `card-${id}`,
              media,
              bodyText: `Frame ${id}`,
              interaction: {
                kind: "quick_replies",
                options: [{ id: `wsc:carousel:${id}`, label: "Buy" }],
              },
            })),
          },
        },
      } as unknown as ScenarioNodeData);
    const generate = (
      includeCardImage: boolean,
      sourceActionNodeId = "carousel"
    ) =>
      createNode("generate", {
        kind: "action",
        actionType: "generative_ai",
        actionGenerativeAIConfig: {
          version: 1,
          mode: "text_to_image",
          prompt: "A holder in {{picked.text}}",
          image: {
            provider: "google",
            sourceId: "11111111-1111-4111-8111-111111111111",
            modelId: "gemini-3.1-flash-image",
            aspectRatio: "1:1",
            referenceImages: [],
            includeInboundText: false,
          },
          pickedOption: { sourceActionNodeId, includeCardImage },
        },
      } as unknown as ScenarioNodeData);
    const choiceEdges = ["a", "b"].map(id => ({
      source: "carousel",
      target: "generate",
      sourceHandle: buildWhatsAppSessionChoiceSourceHandleId(
        `wsc:carousel:${id}`
      ),
    }));
    const edges = [{ source: "trigger", target: "carousel" }, ...choiceEdges];

    it("accepts a carousel every path passes, with its card images", () => {
      expect(
        validateScenarioGraph([trigger, carousel(), generate(true)], edges, {
          mode: "runnable",
        })
      ).toBeNull();
    });

    it("blocks a message that is not before the step on every path", () => {
      const secondTrigger = createNode("second-trigger", {
        kind: "trigger",
        triggerType: "incoming_customer_message",
      } as ScenarioNodeData);
      for (const [nodes, graphEdges] of [
        [[trigger, carousel(), generate(false, "missing")], edges],
        [
          [trigger, secondTrigger, carousel(), generate(false)],
          [...edges, { source: "second-trigger", target: "generate" }],
        ],
      ] as const) {
        expect(
          validateScenarioGraph([...nodes], [...graphEdges], {
            mode: "runnable",
          })
        ).toBe("generativeAIPickedOptionUnavailable");
        expect(
          resolveScenarioGraphBlockingNodeIds(
            [...nodes],
            [...graphEdges],
            "generativeAIPickedOptionUnavailable"
          )
        ).toEqual(["generate"]);
      }
      expect(
        validateScenarioGraph(
          [trigger, carousel(), generate(false, "missing")],
          edges,
          { mode: "draft" }
        )
      ).toBeNull();
    });

    it("blocks the card image only when a card cannot be a reference", () => {
      const nodes = [trigger, carousel("image/webp"), generate(true)];
      expect(validateScenarioGraph(nodes, edges, { mode: "runnable" })).toBe(
        "generativeAIPickedCardImageInvalid"
      );
      expect(
        resolveScenarioGraphBlockingNodeIds(
          nodes,
          edges,
          "generativeAIPickedCardImageInvalid"
        )
      ).toEqual(["generate"]);
      expect(
        resolveScenarioGraphBlockingNodeIds(
          nodes,
          edges,
          "generativeAIPickedOptionUnavailable"
        )
      ).toEqual([]);
      expect(
        validateScenarioGraph(
          [trigger, carousel("image/webp"), generate(false)],
          edges,
          { mode: "runnable" }
        )
      ).toBeNull();
    });

    it("reports a missing source before an unusable card image", () => {
      const nodes = [
        trigger,
        carousel("image/webp"),
        generate(true),
        createNode("generate-2", {
          ...generate(true, "missing").data,
        } as ScenarioNodeData),
      ];
      const graphEdges = [
        ...edges,
        {
          source: "generate",
          target: "generate-2",
          sourceHandle: GENERATIVE_AI_SUCCESS_HANDLE,
        },
      ];
      expect(
        validateScenarioGraph(nodes, graphEdges, { mode: "runnable" })
      ).toBe("generativeAIPickedOptionUnavailable");
      expect(
        resolveScenarioGraphBlockingNodeIds(
          nodes,
          graphEdges,
          "generativeAIPickedOptionUnavailable"
        )
      ).toEqual(["generate-2"]);
      expect(
        resolveScenarioGraphBlockingNodeIds(
          nodes,
          graphEdges,
          "generativeAIPickedCardImageInvalid"
        )
      ).toEqual(["generate"]);
    });
  });

  describe("details collected by an asking message", () => {
    const trigger = createNode("trigger", {
      kind: "trigger",
      triggerType: "incoming_customer_message",
    } as ScenarioNodeData);
    const ask = (extra: Record<string, unknown> = {}, promptInputs = true) =>
      createNode("ask", {
        kind: "action",
        actionType: "reply",
        actionWhatsAppServiceMessage: {
          version: 1,
          message: {
            kind: "reply_buttons",
            body: { mode: "fixed", text: "Pick a frame, then send the name." },
            options: [{ id: "wsc:ask:gold", label: "Gold" }],
          },
          ...(promptInputs
            ? {
                promptInputs: [
                  { key: "name", label: "Name", prompt: "Name to engrave" },
                ],
              }
            : {}),
        },
        ...extra,
      } as unknown as ScenarioNodeData);
    const reply = (id: string) =>
      createNode(id, {
        kind: "action",
        actionType: "reply",
        actionReplyMode: "fixed",
        actionReplyText: `Reply ${id}`,
      } as ScenarioNodeData);
    const choiceEdge = {
      source: "ask",
      target: "gold",
      sourceHandle: buildWhatsAppSessionChoiceSourceHandleId("wsc:ask:gold"),
    };
    const noReply = {
      actionOutcomes: {
        version: 1,
        noReply: { enabled: true, timeoutMinutes: 30 },
      },
    };
    const noReplyEdge = {
      source: "ask",
      target: "reminder",
      sourceHandle: ACTION_NO_REPLY_OUTCOME_HANDLE_ID,
    };
    const anyAndNoReply = {
      actionOutcomes: {
        version: 1,
        anyReply: { enabled: true },
        noReply: { enabled: true, timeoutMinutes: 30 },
      },
    };
    const anyReplyEdge = {
      source: "ask",
      target: "replied",
      sourceHandle: ACTION_ANY_REPLY_OUTCOME_HANDLE_ID,
    };

    it("accepts a buttons message that asks for details on its own", () => {
      expect(
        validateScenarioGraph(
          [trigger, ask(), reply("gold")],
          [{ source: "trigger", target: "ask" }, choiceEdge],
          { mode: "runnable" }
        )
      ).toBeNull();
    });

    it("lets a No reply reminder wait beside the ask", () => {
      expect(
        validateScenarioGraph(
          [trigger, ask(noReply), reply("gold"), reply("reminder")],
          [{ source: "trigger", target: "ask" }, choiceEdge, noReplyEdge],
          { mode: "runnable" }
        )
      ).toBeNull();
    });

    it("blocks a wait that would take the tap or reply the ask waits for", () => {
      const nodes = [
        trigger,
        ask(anyAndNoReply),
        reply("gold"),
        reply("reminder"),
        reply("replied"),
      ];
      const edges = [
        { source: "trigger", target: "ask" },
        choiceEdge,
        noReplyEdge,
        anyReplyEdge,
      ];

      expect(validateScenarioGraph(nodes, edges, { mode: "draft" })).toBeNull();
      expect(validateScenarioGraph(nodes, edges, { mode: "runnable" })).toBe(
        "promptInputChoiceWaitUnsupported"
      );
      expect(
        resolveScenarioGraphBlockingNodeIds(
          nodes,
          edges,
          "promptInputChoiceWaitUnsupported"
        )
      ).toEqual(["ask"]);
    });

    it("applies the same rule to a text message that asks for details", () => {
      const textAsk = (extra: Record<string, unknown>) =>
        createNode("ask", {
          kind: "action",
          actionType: "reply",
          actionWhatsAppServiceMessage: {
            version: 1,
            message: {
              kind: "text",
              body: { mode: "fixed", text: "Send the name to engrave." },
              previewUrl: false,
            },
            promptInputs: [
              { key: "name", label: "Name", prompt: "Name to engrave" },
            ],
          },
          ...extra,
        } as unknown as ScenarioNodeData);
      const collectedEdge = {
        source: "ask",
        target: "gold",
        sourceHandle: "right-source",
      };

      expect(
        validateScenarioGraph(
          [trigger, textAsk(noReply), reply("gold"), reply("reminder")],
          [{ source: "trigger", target: "ask" }, collectedEdge, noReplyEdge],
          { mode: "runnable" }
        )
      ).toBeNull();
      expect(
        validateScenarioGraph(
          [
            trigger,
            textAsk(anyAndNoReply),
            reply("gold"),
            reply("reminder"),
            reply("replied"),
          ],
          [
            { source: "trigger", target: "ask" },
            collectedEdge,
            noReplyEdge,
            anyReplyEdge,
          ],
          { mode: "runnable" }
        )
      ).toBe("promptInputChoiceWaitUnsupported");
    });

    it("keeps waits on a buttons message that asks for nothing", () => {
      expect(
        validateScenarioGraph(
          [trigger, ask(noReply, false), reply("gold"), reply("reminder")],
          [{ source: "trigger", target: "ask" }, choiceEdge, noReplyEdge],
          { mode: "runnable" }
        )
      ).toBeNull();
    });
  });

  it("accepts a canonical Generative AI action config on activation", () => {
    const nodes = [
      createNode("trigger-1", {
        kind: "trigger",
        triggerType: "incoming_customer_message",
      } as ScenarioNodeData),
      createNode("action-1", {
        kind: "action",
        actionType: "generative_ai",
        actionGenerativeAIConfig: {
          version: 1,
          mode: "image_to_video",
          prompt: "Animate this product image",
        },
      } as ScenarioNodeData),
    ];

    expect(
      validateScenarioGraph(
        nodes,
        [{ source: "trigger-1", target: "action-1" }],
        { mode: "runnable" }
      )
    ).toBeNull();
  });

  it("accepts an immediate campaign audience connected to a message without a trigger", () => {
    const nodes = [
      createNode("bulk-1", {
        kind: "bulk",
        bulkRootConfig: {
          workflowKind: "bulk_campaign",
          sendMode: "immediate",
          channels: ["whatsapp", "email"],
          campaignName: "Spring launch",
          recipientSourceSummary: "12 selected recipients",
          generationStatus: "complete",
        },
      } as unknown as ScenarioNodeData),
      createNode("action-1", {
        kind: "action",
        actionType: "reply",
        actionReplyMode: "fixed",
        actionReplyText: "Generated launch message",
      } as ScenarioNodeData),
    ];

    const edges = [{ source: "bulk-1", target: "action-1" }];

    expect(validateScenarioGraph(nodes, edges)).toBeNull();
  });

  it("accepts a campaign audience followed by a message, wait condition, and follow-up message", () => {
    const nodes = [
      createNode("bulk-1", {
        kind: "bulk",
        bulkRootConfig: {
          workflowKind: "bulk_campaign",
          sendMode: "immediate",
          channels: ["whatsapp"],
          campaignName: "Spring launch",
          recipientSourceSummary: "12 selected recipients",
          generationStatus: "complete",
        },
      } as unknown as ScenarioNodeData),
      createNode("action-1", {
        kind: "action",
        actionType: "reply",
        actionReplyMode: "fixed",
        actionReplyText: "Launch message",
      } as ScenarioNodeData),
      createNode("wait-1", {
        kind: "logic",
        logicType: "post_action_condition",
      } as ScenarioNodeData),
      createNode("action-2", {
        kind: "action",
        actionType: "reply",
        actionReplyMode: "fixed",
        actionReplyText: "Follow-up message",
      } as ScenarioNodeData),
    ];

    const edges = [
      { source: "bulk-1", target: "action-1" },
      { source: "action-1", target: "wait-1" },
      { source: "wait-1", target: "action-2" },
    ];

    expect(validateScenarioGraph(nodes, edges)).toBeNull();
  });

  it("allows draft WhatsApp contact cards but rejects incomplete active contacts", () => {
    const nodes = [
      createNode("trigger-1", {
        kind: "trigger",
        triggerType: "incoming_customer_message",
      } as ScenarioNodeData),
      createNode("action-1", {
        kind: "action",
        actionType: "reply",
        actionReplyChannel: "whatsapp",
        actionWhatsAppServiceMessage: {
          version: 1,
          message: {
            kind: "contacts",
            contacts: [{ version: 1, phone: "+77012345678" }],
          },
        },
      } as ScenarioNodeData),
    ];
    const edges = [{ source: "trigger-1", target: "action-1" }];

    expect(validateScenarioGraph(nodes, edges)).toBeNull();
    expect(validateScenarioGraph(nodes, edges, { mode: "runnable" })).toBe(
      "whatsappServiceMessageInvalid"
    );
  });

  it("accepts runnable WhatsApp contact cards for active scenarios", () => {
    const nodes = [
      createNode("trigger-1", {
        kind: "trigger",
        triggerType: "incoming_customer_message",
      } as ScenarioNodeData),
      createNode("action-1", {
        kind: "action",
        actionType: "reply",
        actionReplyChannel: "whatsapp",
        actionWhatsAppServiceMessage: {
          version: 1,
          message: {
            kind: "contacts",
            contacts: [
              {
                version: 1,
                formattedName: "Admissions Team",
                phone: "+77012345678",
              },
            ],
          },
        },
      } as ScenarioNodeData),
    ];
    const edges = [{ source: "trigger-1", target: "action-1" }];

    expect(
      validateScenarioGraph(nodes, edges, { mode: "runnable" })
    ).toBeNull();
  });

  it("allows draft WhatsApp locations but rejects incomplete active locations", () => {
    const nodes = [
      createNode("trigger-1", {
        kind: "trigger",
        triggerType: "incoming_customer_message",
      } as ScenarioNodeData),
      createNode("action-1", {
        kind: "action",
        actionType: "reply",
        actionReplyChannel: "whatsapp",
        actionWhatsAppServiceMessage: {
          version: 1,
          message: {
            kind: "location",
            location: { version: 1, latitude: "43.238949" },
          },
        },
      } as ScenarioNodeData),
    ];
    const edges = [{ source: "trigger-1", target: "action-1" }];

    expect(validateScenarioGraph(nodes, edges)).toBeNull();
    expect(validateScenarioGraph(nodes, edges, { mode: "runnable" })).toBe(
      "whatsappServiceMessageInvalid"
    );
  });

  it("accepts runnable WhatsApp location cards for active scenarios", () => {
    const nodes = [
      createNode("trigger-1", {
        kind: "trigger",
        triggerType: "incoming_customer_message",
      } as ScenarioNodeData),
      createNode("action-1", {
        kind: "action",
        actionType: "reply",
        actionReplyChannel: "whatsapp",
        actionWhatsAppServiceMessage: {
          version: 1,
          message: {
            kind: "location",
            location: {
              version: 1,
              latitude: "43.238949",
              longitude: "76.889709",
              name: "EduDemo Campus",
            },
          },
        },
      } as ScenarioNodeData),
    ];
    const edges = [{ source: "trigger-1", target: "action-1" }];

    expect(
      validateScenarioGraph(nodes, edges, { mode: "runnable" })
    ).toBeNull();
  });

  it("allows canonical WhatsApp drafts but rejects them on activation", () => {
    const nodes = [
      createNode("trigger-1", {
        kind: "trigger",
        triggerType: "incoming_customer_message",
      } as ScenarioNodeData),
      createNode("action-1", {
        kind: "action",
        actionType: "reply",
        actionWhatsAppServiceMessage: {
          version: 1,
          message: {
            kind: "reply_buttons",
            body: { mode: "fixed", text: "Choose" },
            options: [],
          },
        },
      } as ScenarioNodeData),
    ];
    const edges = [{ source: "trigger-1", target: "action-1" }];

    expect(validateScenarioGraph(nodes, edges)).toBeNull();
    expect(validateScenarioGraph(nodes, edges, { mode: "runnable" })).toBe(
      "whatsappServiceMessageInvalid"
    );
  });

  it("accepts a valid canonical WhatsApp service message on activation", () => {
    const nodes = [
      createNode("trigger-1", {
        kind: "trigger",
        triggerType: "incoming_customer_message",
      } as ScenarioNodeData),
      createNode("action-1", {
        kind: "action",
        actionType: "reply",
        actionWhatsAppServiceMessage: {
          version: 1,
          message: {
            kind: "text",
            body: { mode: "fixed", text: "Hello" },
            previewUrl: true,
          },
        },
      } as ScenarioNodeData),
    ];
    const edges = [{ source: "trigger-1", target: "action-1" }];

    expect(
      validateScenarioGraph(nodes, edges, { mode: "runnable" })
    ).toBeNull();
  });

  it("allows managed Flow drafts without treating projected provider status as authority", () => {
    const managed = managedFlowAction();
    const nodes = [
      createNode("trigger-1", { kind: "trigger" }),
      createNode("action-1", managed.data),
    ];
    const edges = [{ source: "trigger-1", target: "action-1" }];

    expect(validateScenarioGraph(nodes, edges)).toBeNull();
    expect(validateScenarioGraph(nodes, edges, { mode: "runnable" })).toBe(
      "whatsappServiceMessageInvalid"
    );
  });

  it("rejects endpoint Flow activation after its managed projection is invalidated", () => {
    const managed = managedFlowAction();
    const nodes = [
      createNode("trigger-1", { kind: "trigger" }),
      createNode("action-1", {
        ...managed.data,
        actionFlowConfig: {
          ...managed.data.actionFlowConfig!,
          managedProvisioning: undefined,
        },
      }),
    ];

    expect(
      validateScenarioGraph(
        nodes,
        [{ source: "trigger-1", target: "action-1" }],
        { mode: "runnable" }
      )
    ).toBe("whatsappServiceMessageInvalid");
  });

  it("rejects nested endpoint Flow activation after its managed projection is invalidated", () => {
    const managed = managedServiceMessageFlowAction();
    const serviceMessage = managed.data.actionWhatsAppServiceMessage!;
    const flowMessage = serviceMessage.message;
    if (flowMessage.kind !== "flow") throw new Error("Expected Flow message");
    const nodes = [
      createNode("trigger-1", { kind: "trigger" }),
      createNode("action-1", {
        ...managed.data,
        actionWhatsAppServiceMessage: {
          ...serviceMessage,
          message: {
            ...flowMessage,
            flowConfig: {
              ...flowMessage.flowConfig,
              managedProvisioning: undefined,
            },
          },
        },
      }),
    ];

    expect(
      validateScenarioGraph(
        nodes,
        [{ source: "trigger-1", target: "action-1" }],
        { mode: "runnable" }
      )
    ).toBe("whatsappServiceMessageInvalid");
  });

  it("keeps a server-preserved legacy endpoint Flow eligible for compatibility", () => {
    const managed = managedFlowAction();
    const nodes = [
      createNode("trigger-1", { kind: "trigger" }),
      createNode("action-1", {
        ...managed.data,
        actionFlowConfig: {
          ...managed.data.actionFlowConfig!,
          managedProvisioning: undefined,
          metaFlowId: "legacy-provider-flow",
        },
      }),
    ];

    expect(
      validateScenarioGraph(
        nodes,
        [{ source: "trigger-1", target: "action-1" }],
        { mode: "runnable" }
      )
    ).toBeNull();
  });

  it("activates a managed Flow only from matching completed operation evidence", () => {
    const managed = managedFlowAction();
    const actionData = {
      ...managed.data,
      actionFlowConfig: managed.data.actionFlowConfig,
    };
    const nodes = [
      createNode("trigger-1", { kind: "trigger" }),
      createNode("action-1", actionData),
    ];
    const edges = [{ source: "trigger-1", target: "action-1" }];
    const evidence = {
      operationId: managed.projection.operationId,
      nodeId: "action-1",
      sourceId: managed.projection.sourceId,
      wabaId: managed.projection.wabaId,
      contentDigest: managed.contentDigest,
      providerFlowId: managed.projection.flowId,
      status: "COMPLETED" as const,
      stage: "COMPLETED" as const,
    };

    expect(
      validateScenarioGraph(nodes, edges, {
        mode: "runnable",
        completedWhatsAppFlowProvisioningOperations: [evidence],
        currentWhatsAppSourceWabaBindings: {
          [managed.projection.sourceId]: managed.projection.wabaId,
        },
      })
    ).toBeNull();
  });

  it("rejects a managed Flow when its live source now belongs to another WABA", () => {
    const managed = managedFlowAction();
    const evidence = {
      operationId: managed.projection.operationId,
      nodeId: "action-1",
      sourceId: managed.projection.sourceId,
      wabaId: managed.projection.wabaId,
      contentDigest: managed.contentDigest,
      providerFlowId: managed.projection.flowId,
      status: "COMPLETED" as const,
      stage: "COMPLETED" as const,
    };

    expect(
      validateScenarioGraph(
        [
          createNode("trigger-1", { kind: "trigger" }),
          createNode("action-1", managed.data),
        ],
        [{ source: "trigger-1", target: "action-1" }],
        {
          mode: "runnable",
          completedWhatsAppFlowProvisioningOperations: [evidence],
          currentWhatsAppSourceWabaBindings: {
            [managed.projection.sourceId]: "waba-reconnected",
          },
        }
      )
    ).toBe("whatsappServiceMessageInvalid");
  });

  it("accepts a managedProvisioning-only service-message Flow with matching evidence", () => {
    const managed = managedServiceMessageFlowAction();
    const nodes = [
      createNode("trigger-1", { kind: "trigger" }),
      createNode("action-1", managed.data),
    ];

    expect(
      validateScenarioGraph(
        nodes,
        [{ source: "trigger-1", target: "action-1" }],
        {
          mode: "runnable",
          completedWhatsAppFlowProvisioningOperations: [
            {
              operationId: managed.projection.operationId,
              nodeId: "action-1",
              sourceId: managed.projection.sourceId,
              wabaId: managed.projection.wabaId,
              contentDigest: managed.contentDigest,
              providerFlowId: managed.projection.flowId,
              status: "COMPLETED",
              stage: "COMPLETED",
            },
          ],
          currentWhatsAppSourceWabaBindings: {
            [managed.projection.sourceId]: managed.projection.wabaId,
          },
        }
      )
    ).toBeNull();
  });

  it("accepts a published provider-referenced Flow on its bound source", () => {
    expect(
      validateScenarioGraph(
        [
          createNode("trigger-1", { kind: "trigger" }),
          createNode("action-1", providerReferencedServiceMessageFlowAction()),
        ],
        [{ source: "trigger-1", target: "action-1" }],
        {
          mode: "runnable",
          currentWhatsAppSourceWabaBindings: { "source-1": "waba-1" },
        }
      )
    ).toBeNull();
  });

  it("rejects a provider-referenced Flow after source rebind or provider block", () => {
    const edges = [{ source: "trigger-1", target: "action-1" }];

    expect(
      validateScenarioGraph(
        [
          createNode("trigger-1", { kind: "trigger" }),
          createNode("action-1", providerReferencedServiceMessageFlowAction()),
        ],
        edges,
        {
          mode: "runnable",
          currentWhatsAppSourceWabaBindings: {
            "source-1": "waba-reconnected",
          },
        }
      )
    ).toBe("whatsappServiceMessageInvalid");
    expect(
      validateScenarioGraph(
        [
          createNode("trigger-1", { kind: "trigger" }),
          createNode(
            "action-1",
            providerReferencedServiceMessageFlowAction("BLOCKED")
          ),
        ],
        edges,
        {
          mode: "runnable",
          currentWhatsAppSourceWabaBindings: { "source-1": "waba-1" },
        }
      )
    ).toBe("whatsappServiceMessageInvalid");
  });

  it("accepts a server-managed linear Flow with matching completed operation evidence", () => {
    const managed = managedFlowAction();
    const linearFlow = {
      ...managed.data.actionFlowConfig!,
      flowNavigationMode: "linear" as const,
      managedProvisioning: undefined,
    };
    const contentDigest = createWhatsAppFlowEditableContentDigest(linearFlow);
    const projection = {
      ...managed.projection,
      contentDigest,
    };
    const nodes = [
      createNode("trigger-1", { kind: "trigger" }),
      createNode("action-1", {
        ...managed.data,
        actionFlowConfig: {
          ...linearFlow,
          managedProvisioning: projection,
        },
      }),
    ];

    expect(
      validateScenarioGraph(
        nodes,
        [{ source: "trigger-1", target: "action-1" }],
        {
          mode: "runnable",
          completedWhatsAppFlowProvisioningOperations: [
            {
              operationId: projection.operationId,
              nodeId: "action-1",
              sourceId: projection.sourceId,
              wabaId: projection.wabaId,
              contentDigest,
              providerFlowId: projection.flowId,
              status: "COMPLETED",
              stage: "COMPLETED",
            },
          ],
          currentWhatsAppSourceWabaBindings: {
            [projection.sourceId]: projection.wabaId,
          },
        }
      )
    ).toBeNull();
  });

  it("rejects a managed template Flow until its template button binds the published revision", () => {
    const managed = managedFlowAction();
    const nodes = [
      createNode("trigger-1", { kind: "trigger" }),
      createNode("action-1", {
        ...managed.data,
        actionWhatsAppTemplateComponents: [
          {
            type: "BUTTONS",
            buttons: [{ type: "FLOW", text: "Open", flow_id: "older-flow" }],
          },
        ],
      }),
    ];

    expect(
      validateScenarioGraph(
        nodes,
        [{ source: "trigger-1", target: "action-1" }],
        {
          mode: "runnable",
          completedWhatsAppFlowProvisioningOperations: [
            {
              operationId: managed.projection.operationId,
              nodeId: "action-1",
              sourceId: managed.projection.sourceId,
              wabaId: managed.projection.wabaId,
              contentDigest: managed.contentDigest,
              providerFlowId: managed.projection.flowId,
              status: "COMPLETED",
              stage: "COMPLETED",
            },
          ],
          currentWhatsAppSourceWabaBindings: {
            [managed.projection.sourceId]: managed.projection.wabaId,
          },
        }
      )
    ).toBe("whatsappServiceMessageInvalid");
  });

  it("rejects an active unprovisioned linear Flow", () => {
    const managed = managedFlowAction();
    const nodes = [
      createNode("trigger-1", { kind: "trigger" }),
      createNode("action-1", {
        ...managed.data,
        actionFlowConfig: {
          ...managed.data.actionFlowConfig!,
          flowNavigationMode: "linear",
          managedProvisioning: undefined,
          metaFlowId: undefined,
        },
      }),
    ];

    expect(
      validateScenarioGraph(
        nodes,
        [{ source: "trigger-1", target: "action-1" }],
        { mode: "runnable" }
      )
    ).toBe("whatsappServiceMessageInvalid");
  });

  it.each([
    ["operation ID", { operationId: "operation-other" }],
    ["node ID", { nodeId: "action-other" }],
    ["source ID", { sourceId: "source-other" }],
    ["WABA ID", { wabaId: "waba-other" }],
    ["content digest", { contentDigest: "f".repeat(64) }],
    ["provider Flow ID", { providerFlowId: "provider-flow-other" }],
    ["status", { status: "FAILED" }],
    ["stage", { stage: "READING_BACK" }],
  ])(
    "rejects managed Flow activation when authoritative %s evidence differs",
    (_label, evidencePatch) => {
      const managed = managedFlowAction();
      const nodes = [
        createNode("trigger-1", { kind: "trigger" }),
        createNode("action-1", managed.data),
      ];
      const evidence = {
        operationId: managed.projection.operationId,
        nodeId: "action-1",
        sourceId: managed.projection.sourceId,
        wabaId: managed.projection.wabaId,
        contentDigest: managed.contentDigest,
        providerFlowId: managed.projection.flowId,
        status: "COMPLETED",
        stage: "COMPLETED",
        ...evidencePatch,
      };

      expect(
        validateScenarioGraph(
          nodes,
          [{ source: "trigger-1", target: "action-1" }],
          {
            mode: "runnable",
            completedWhatsAppFlowProvisioningOperations: [
              evidence as CompletedWhatsAppFlowProvisioningOperationEvidence,
            ],
            currentWhatsAppSourceWabaBindings: {
              [managed.projection.sourceId]: managed.projection.wabaId,
            },
          }
        )
      ).toBe("whatsappServiceMessageInvalid");
    }
  );

  it("rejects activation when editable content no longer matches the projected digest", () => {
    const managed = managedFlowAction();
    const nodes = [
      createNode("trigger-1", { kind: "trigger" }),
      createNode("action-1", {
        ...managed.data,
        actionFlowConfig: {
          ...managed.data.actionFlowConfig!,
          ctaText: "Changed after provisioning",
        },
      }),
    ];

    expect(
      validateScenarioGraph(
        nodes,
        [{ source: "trigger-1", target: "action-1" }],
        {
          mode: "runnable",
          completedWhatsAppFlowProvisioningOperations: [
            {
              operationId: managed.projection.operationId,
              nodeId: "action-1",
              sourceId: managed.projection.sourceId,
              wabaId: managed.projection.wabaId,
              contentDigest: managed.contentDigest,
              providerFlowId: managed.projection.flowId,
              status: "COMPLETED",
              stage: "COMPLETED",
            },
          ],
          currentWhatsAppSourceWabaBindings: {
            [managed.projection.sourceId]: managed.projection.wabaId,
          },
        }
      )
    ).toBe("whatsappServiceMessageInvalid");
  });

  it("allows an incomplete draft action but rejects activation without a supported action type", () => {
    const nodes = [
      createNode("trigger-1", {
        kind: "trigger",
      }),
      createNode("action-1", {
        kind: "action",
      }),
    ];
    const edges = [{ source: "trigger-1", target: "action-1" }];

    expect(validateScenarioGraph(nodes, edges)).toBeNull();
    expect(validateScenarioGraph(nodes, edges, { mode: "runnable" })).toBe(
      "actionTypeInvalid"
    );
  });

  it("rejects oversized canonical commerce text on activation", () => {
    const nodes = [
      createNode("trigger-1", {
        kind: "trigger",
        triggerType: "incoming_customer_message",
      } as ScenarioNodeData),
      createNode("action-1", {
        kind: "action",
        actionType: "reply",
        actionWhatsAppServiceMessage: {
          version: 1,
          message: {
            kind: "commerce",
            commerce: {
              mode: "catalog",
              catalogId: "catalog-1",
              bodyText: "x".repeat(1025),
            },
          },
        },
      } as ScenarioNodeData),
    ];

    expect(
      validateScenarioGraph(
        nodes,
        [{ source: "trigger-1", target: "action-1" }],
        { mode: "runnable" }
      )
    ).toBe("whatsappServiceMessageInvalid");
  });

  it("rejects disconnected campaign audience and message islands", () => {
    const nodes = [
      createNode("bulk-1", {
        kind: "bulk",
        bulkRootConfig: {
          workflowKind: "bulk_campaign",
          sendMode: "immediate",
          channels: ["whatsapp"],
          campaignName: "Spring launch",
          recipientSourceSummary: "12 selected recipients",
          generationStatus: "complete",
        },
      } as unknown as ScenarioNodeData),
      createNode("action-1", {
        kind: "action",
        actionType: "reply",
        actionReplyMode: "fixed",
        actionReplyText: "Generated launch message",
      } as ScenarioNodeData),
    ];

    expect(validateScenarioGraph(nodes, [])).toBe("singleFlowRequired");
  });

  it("accepts multiple trigger starts when each belongs to one connected graph", () => {
    const nodes = [
      createNode("trigger-1", {
        kind: "trigger",
        triggerType: "incoming_customer_message",
      } as ScenarioNodeData),
      createNode("trigger-2", {
        kind: "trigger",
        triggerType: "incoming_customer_message",
      } as ScenarioNodeData),
      createNode("bulk-1", {
        kind: "bulk",
        bulkRootConfig: {
          workflowKind: "bulk_campaign",
          sendMode: "immediate",
          channels: ["whatsapp"],
          campaignName: "Spring launch",
          recipientSourceSummary: "12 selected recipients",
          generationStatus: "complete",
        },
      } as unknown as ScenarioNodeData),
      createNode("action-1", {
        kind: "action",
        actionType: "reply",
        actionReplyMode: "fixed",
        actionReplyText: "Generated launch message",
      } as ScenarioNodeData),
    ];

    const edges = [
      { source: "trigger-1", target: "bulk-1" },
      { source: "trigger-2", target: "bulk-1" },
      { source: "bulk-1", target: "action-1" },
    ];

    expect(validateScenarioGraph(nodes, edges)).toBeNull();
  });

  it("accepts a trigger node connected to a bulk campaign node", () => {
    const nodes = [
      createNode("trigger-1", {
        kind: "trigger",
        triggerType: "incoming_customer_message",
      } as ScenarioNodeData),
      createNode("bulk-1", {
        kind: "bulk",
        bulkRootConfig: {
          workflowKind: "bulk_campaign",
          sendMode: "immediate",
          channels: ["whatsapp"],
          campaignName: "Duplicate root",
          recipientSourceSummary: "CSV upload",
          generationStatus: "complete",
        },
      } as unknown as ScenarioNodeData),
      createNode("action-1", {
        kind: "action",
        actionType: "whatsapp_template",
        actionWhatsAppTemplateName: "vip_offer",
        actionWhatsAppTemplateLanguage: "en",
        actionWhatsAppTemplateComponents: [
          { type: "BODY", text: "Hi {{name}}" },
        ],
      } as ScenarioNodeData),
    ];

    const edges = [
      { source: "trigger-1", target: "bulk-1" },
      { source: "bulk-1", target: "action-1" },
    ];

    expect(validateScenarioGraph(nodes, edges)).toBeNull();
  });

  it("accepts multiple right-side bulk campaign actions", () => {
    const nodes = [
      createNode("bulk-1", {
        kind: "bulk",
        bulkRootConfig: {
          workflowKind: "bulk_campaign",
          sendMode: "immediate",
          channels: ["whatsapp"],
          campaignName: "VIP offer",
          recipientSourceSummary: "CSV upload",
          generationStatus: "idle",
        },
      } as ScenarioNodeData),
      createNode("action-1", {
        kind: "action",
        actionType: "whatsapp_template",
      } as ScenarioNodeData),
      createNode("action-2", {
        kind: "action",
        actionType: "whatsapp_template",
      } as ScenarioNodeData),
    ];

    expect(
      validateScenarioGraph(nodes, [
        {
          source: "bulk-1",
          sourceHandle: "right-source",
          target: "action-1",
        },
        {
          source: "bulk-1",
          sourceHandle: "right-source",
          target: "action-2",
        },
      ])
    ).toBeNull();
  });

  it("accepts right-side bulk campaign links to non-action nodes", () => {
    const nodes = [
      createNode("bulk-1", {
        kind: "bulk",
        bulkRootConfig: {
          workflowKind: "bulk_campaign",
          sendMode: "immediate",
          channels: ["whatsapp"],
          campaignName: "VIP offer",
          recipientSourceSummary: "CSV upload",
          generationStatus: "idle",
        },
      } as ScenarioNodeData),
      createNode("logic-1", {
        kind: "logic",
        logicType: "audience_filter",
      } as ScenarioNodeData),
    ];

    expect(
      validateScenarioGraph(nodes, [
        {
          source: "bulk-1",
          sourceHandle: "right-source",
          target: "logic-1",
        },
      ])
    ).toBeNull();
  });

  it("accepts incomplete WhatsApp flow branches", () => {
    const nodes = [
      createNode("trigger-1", {
        kind: "trigger",
        triggerType: "incoming_customer_message",
      } as ScenarioNodeData),
      createNode("action-1", canonicalFlowAction()),
      createNode("branch-1", {
        kind: "action",
        actionType: "reply",
        flowBranchSourceFieldId: "radio-1",
        flowBranchOptionId: "one",
        flowBranchOptionLabel: "One",
      } as ScenarioNodeData),
    ];

    const edges = [
      { source: "trigger-1", target: "action-1" },
      {
        source: "action-1",
        target: "branch-1",
        sourceHandle: ACTION_FLOW_BRANCH_OUTPUT_HANDLE_ID,
      },
    ];

    expect(validateScenarioGraph(nodes, edges)).toBeNull();
  });

  it("accepts a generic WhatsApp flow fallback path when not every radio option has its own branch", () => {
    const nodes = [
      createNode("trigger-1", {
        kind: "trigger",
        triggerType: "incoming_customer_message",
      } as ScenarioNodeData),
      createNode("action-1", canonicalFlowAction()),
      createNode("generic-path", {
        kind: "logic",
        logicType: "post_action_condition",
      } as ScenarioNodeData),
      createNode("branch-1", {
        kind: "action",
        actionType: "reply",
        flowBranchSourceFieldId: "radio-1",
        flowBranchOptionId: "one",
        flowBranchOptionLabel: "One",
      } as ScenarioNodeData),
    ];

    const edges = [
      { source: "trigger-1", target: "action-1" },
      {
        source: "action-1",
        target: "generic-path",
        sourceHandle: ACTION_FLOW_BRANCH_OUTPUT_HANDLE_ID,
      },
      {
        source: "action-1",
        target: "branch-1",
        sourceHandle: ACTION_FLOW_BRANCH_OUTPUT_HANDLE_ID,
      },
    ];

    expect(validateScenarioGraph(nodes, edges)).toBeNull();
  });

  it("accepts a mixed WhatsApp template flow fallback path when the template buttons share one linked flow id", () => {
    const nodes = [
      createNode("trigger-1", {
        kind: "trigger",
        triggerType: "incoming_customer_message",
      } as ScenarioNodeData),
      createNode("action-1", {
        kind: "action",
        actionType: "whatsapp_template",
        actionWhatsAppTemplateComponents: [
          {
            type: "BUTTONS",
            buttons: [
              { type: "QUICK_REPLY", text: "Talk to agent" },
              { type: "FLOW", text: "Open", flow_id: "flow-123" },
            ],
          },
        ],
        actionFlowConfig: {
          templateId: "template-1",
          screens: [
            {
              id: "screen-1",
              title: "Screen",
              fields: [
                {
                  id: "radio-1",
                  label: "Choose one",
                  fieldType: "RadioButtonsGroup",
                  options: [
                    { id: "one", title: "One" },
                    { id: "two", title: "Two" },
                  ],
                },
              ],
            },
          ],
        },
      } as ScenarioNodeData),
      createNode("generic-path", {
        kind: "logic",
        logicType: "post_action_condition",
      } as ScenarioNodeData),
      createNode("branch-1", {
        kind: "action",
        actionType: "reply",
        flowBranchSourceFieldId: "radio-1",
        flowBranchOptionId: "one",
        flowBranchOptionLabel: "One",
      } as ScenarioNodeData),
    ];

    const edges = [
      { source: "trigger-1", target: "action-1" },
      {
        source: "action-1",
        target: "generic-path",
        sourceHandle: ACTION_FLOW_BRANCH_OUTPUT_HANDLE_ID,
      },
      {
        source: "action-1",
        target: "branch-1",
        sourceHandle: ACTION_FLOW_BRANCH_OUTPUT_HANDLE_ID,
      },
    ];

    expect(validateScenarioGraph(nodes, edges)).toBeNull();
  });

  it("retains incomplete Telegram quick-reply branches only in draft mode", () => {
    const nodes = [
      createNode("trigger-1", {
        kind: "trigger",
        triggerType: "incoming_customer_message",
      } as ScenarioNodeData),
      createNode("action-1", {
        kind: "action",
        actionType: "reply",
        actionTelegramQuickReplies: [
          { text: "Yes", payload: "yes" },
          { text: "No", payload: "no" },
        ],
      } as ScenarioNodeData),
      createNode("branch-yes", {
        kind: "action",
        actionType: "reply",
        telegramBranchPayload: "yes",
        telegramBranchLabel: "Yes",
      } as ScenarioNodeData),
    ];

    const edges = [
      { source: "trigger-1", target: "action-1" },
      {
        source: "action-1",
        target: "branch-yes",
        sourceHandle: ACTION_TELEGRAM_BRANCH_OUTPUT_HANDLE_ID,
      },
    ];

    expect(validateScenarioGraph(nodes, edges)).toBe(
      "telegramBranchIncomplete"
    );
    expect(validateScenarioGraph(nodes, edges, { mode: "draft" })).toBeNull();
    expect(validateScenarioGraph(nodes, edges, { mode: "runnable" })).toBe(
      "telegramBranchIncomplete"
    );
  });

  it("ignores stale Telegram quick replies on another explicit reply channel", () => {
    const nodes = [
      createNode("trigger-1", {
        kind: "trigger",
        triggerType: "incoming_customer_message",
      } as ScenarioNodeData),
      createNode("action-1", {
        kind: "action",
        actionType: "reply",
        actionReplyChannel: "instagram",
        actionTelegramQuickReplies: [
          { text: "Yes", payload: "yes" },
          { text: "No", payload: "no" },
        ],
      } as ScenarioNodeData),
    ];

    expect(
      validateScenarioGraph(nodes, [
        { source: "trigger-1", target: "action-1" },
      ])
    ).toBeNull();
  });

  it("accepts complete Telegram quick-reply branches from dedicated button handles", () => {
    const nodes = [
      createNode("trigger-1", {
        kind: "trigger",
        triggerType: "incoming_customer_message",
      } as ScenarioNodeData),
      createNode("action-1", {
        kind: "action",
        actionType: "reply",
        actionTelegramQuickReplies: [
          { text: "Yes", payload: "yes" },
          { text: "No", payload: "no" },
        ],
      } as ScenarioNodeData),
      createNode("branch-yes", {
        kind: "action",
        actionType: "reply",
      } as ScenarioNodeData),
      createNode("branch-no", {
        kind: "action",
        actionType: "reply",
      } as ScenarioNodeData),
    ];

    const edges = [
      { source: "trigger-1", target: "action-1" },
      {
        source: "action-1",
        target: "branch-yes",
        sourceHandle: buildTelegramBranchSourceHandleId("yes"),
      },
      {
        source: "action-1",
        target: "branch-no",
        sourceHandle: buildTelegramBranchSourceHandleId("no"),
      },
    ];

    expect(validateScenarioGraph(nodes, edges)).toBeNull();
  });

  it("accepts canonical WhatsApp reply buttons without branch targets", () => {
    const nodes = [
      createNode("trigger-1", {
        kind: "trigger",
        triggerType: "incoming_customer_message",
      } as ScenarioNodeData),
      createNode("action-1", canonicalReplyButtonsAction()),
    ];

    const edges = [{ source: "trigger-1", target: "action-1" }];

    expect(validateScenarioGraph(nodes, edges)).toBeNull();
  });

  it("accepts partially connected canonical WhatsApp button branches", () => {
    const nodes = [
      createNode("trigger-1", {
        kind: "trigger",
        triggerType: "incoming_customer_message",
      } as ScenarioNodeData),
      createNode("action-1", canonicalReplyButtonsAction()),
      createNode("branch-pricing", {
        kind: "action",
        actionType: "reply",
        whatsAppSessionChoicePayload: buildWhatsAppSessionChoicePayload({
          actionNodeId: "action-1",
          choiceId: "pricing",
        }),
        whatsAppSessionChoiceLabel: "Pricing",
      } as ScenarioNodeData),
    ];

    const edges = [
      { source: "trigger-1", target: "action-1" },
      {
        source: "action-1",
        target: "branch-pricing",
        sourceHandle: ACTION_WHATSAPP_SESSION_CHOICE_BRANCH_OUTPUT_HANDLE_ID,
      },
    ];

    expect(validateScenarioGraph(nodes, edges)).toBeNull();
  });

  it("accepts complete canonical WhatsApp button branches from dedicated handles", () => {
    const nodes = [
      createNode("trigger-1", {
        kind: "trigger",
        triggerType: "incoming_customer_message",
      } as ScenarioNodeData),
      createNode("action-1", canonicalReplyButtonsAction()),
      createNode("branch-pricing", {
        kind: "action",
        actionType: "reply",
      } as ScenarioNodeData),
      createNode("branch-support", {
        kind: "action",
        actionType: "reply",
      } as ScenarioNodeData),
    ];

    const edges = [
      { source: "trigger-1", target: "action-1" },
      {
        source: "action-1",
        target: "branch-pricing",
        sourceHandle: buildWhatsAppSessionChoiceSourceHandleId(
          buildWhatsAppSessionChoicePayload({
            actionNodeId: "action-1",
            choiceId: "pricing",
          })
        ),
      },
      {
        source: "action-1",
        target: "branch-support",
        sourceHandle: buildWhatsAppSessionChoiceSourceHandleId(
          buildWhatsAppSessionChoicePayload({
            actionNodeId: "action-1",
            choiceId: "support",
          })
        ),
      },
    ];

    expect(validateScenarioGraph(nodes, edges)).toBeNull();
  });

  it("accepts complete WhatsApp flow branches", () => {
    const nodes = [
      createNode("trigger-1", {
        kind: "trigger",
        triggerType: "incoming_customer_message",
      } as ScenarioNodeData),
      createNode("action-1", canonicalFlowAction()),
      createNode("branch-1", {
        kind: "action",
        actionType: "reply",
        flowBranchSourceFieldId: "radio-1",
        flowBranchOptionId: "one",
        flowBranchOptionLabel: "One",
      } as ScenarioNodeData),
      createNode("branch-2", {
        kind: "action",
        actionType: "reply",
        flowBranchSourceFieldId: "radio-1",
        flowBranchOptionId: "two",
        flowBranchOptionLabel: "Two",
      } as ScenarioNodeData),
    ];

    const edges = [
      { source: "trigger-1", target: "action-1" },
      {
        source: "action-1",
        target: "branch-1",
        sourceHandle: ACTION_FLOW_BRANCH_OUTPUT_HANDLE_ID,
      },
      {
        source: "action-1",
        target: "branch-2",
        sourceHandle: ACTION_FLOW_BRANCH_OUTPUT_HANDLE_ID,
      },
    ];

    expect(validateScenarioGraph(nodes, edges)).toBeNull();
  });

  it("does not require no-reply edges to cover every WhatsApp flow option", () => {
    const nodes = [
      createNode("trigger-1", {
        kind: "trigger",
        triggerType: "incoming_customer_message",
      } as ScenarioNodeData),
      createNode("action-1", canonicalFlowAction()),
      createNode("branch-1", {
        kind: "action",
        actionType: "reply",
        flowBranchSourceFieldId: "radio-1",
        flowBranchOptionId: "one",
        flowBranchOptionLabel: "One",
      } as ScenarioNodeData),
      createNode("no-reply", {
        kind: "logic",
        logicType: "post_action_condition",
        postActionConditionVariant: "interactive_no_reply",
        interactiveNoReplySurface: "whatsapp_flow",
      } as ScenarioNodeData),
    ];

    const edges = [
      { source: "trigger-1", target: "action-1" },
      {
        source: "action-1",
        target: "branch-1",
        sourceHandle: ACTION_FLOW_BRANCH_OUTPUT_HANDLE_ID,
      },
      {
        source: "action-1",
        target: "no-reply",
        sourceHandle: ACTION_INTERACTIVE_NO_REPLY_OUTPUT_HANDLE_ID,
      },
    ];

    expect(validateScenarioGraph(nodes, edges)).toBeNull();
  });

  it("blocks activation when a WhatsApp QR trigger lacks usable readiness evidence", () => {
    const entryPointId = "11111111-1111-4111-8111-111111111111";
    const nodes = [
      createNode("trigger-1", {
        kind: "trigger",
        triggerType: "incoming_customer_message",
        triggerConfig: { entryPointType: "whatsapp_qr", entryPointId },
      } as ScenarioNodeData),
      createNode("action-1", {
        kind: "action",
        actionType: "reply",
      } as ScenarioNodeData),
    ];
    const edges = [{ source: "trigger-1", target: "action-1" }];

    expect(validateScenarioGraph(nodes, edges)).toBeNull();
    expect(validateScenarioGraph(nodes, edges, { mode: "runnable" })).toBe(
      "whatsappQrEntryPointIncomplete"
    );
    expect(
      validateScenarioGraph(nodes, edges, {
        mode: "runnable",
        whatsappQrEntryPointReadiness: {
          "trigger-1": { entryPointId, ready: false },
        },
      })
    ).toBe("whatsappQrEntryPointIncomplete");
    expect(
      validateScenarioGraph(nodes, edges, {
        mode: "runnable",
        whatsappQrEntryPointReadiness: {
          "trigger-1": { entryPointId, ready: true },
        },
      })
    ).toBeNull();
  });

  it("ignores ordinary message triggers for WhatsApp QR readiness", () => {
    const nodes = [
      createNode("trigger-1", {
        kind: "trigger",
        triggerType: "incoming_customer_message",
        triggerConfig: { entryPointType: "message" },
      } as ScenarioNodeData),
      createNode("action-1", {
        kind: "action",
        actionType: "reply",
      } as ScenarioNodeData),
    ];
    const edges = [{ source: "trigger-1", target: "action-1" }];

    expect(
      validateScenarioGraph(nodes, edges, { mode: "runnable" })
    ).toBeNull();
  });
});

describe("runnable birthday campaign validation", () => {
  const scheduleConfig = {
    version: 2,
    mode: "recurring",
    timezone: "Asia/Qyzylorda",
    recurrence: { kind: "daily", time: "09:30" },
  };
  const telegramMessage = {
    kind: "action",
    actionType: "reply",
    actionReplyChannel: "telegram",
    actionReplyMode: "fixed",
    actionReplyText: "Happy birthday {{name}}",
  };
  const whatsappMessage = {
    kind: "action",
    actionType: "whatsapp_template",
    actionWhatsAppTemplateName: "birthday_greeting",
    actionWhatsAppTemplateLanguage: "en",
  };
  const edges = [
    {
      source: "birthday-root",
      sourceHandle: "right-source",
      target: "message",
    },
  ];

  function birthdayNodes(
    config: Record<string, unknown> = {},
    message: Record<string, unknown> = telegramMessage
  ) {
    return [
      createNode("birthday-root", {
        kind: "bulk",
        bulkRootConfig: {
          workflowKind: "bulk_campaign",
          channels: ["telegram"],
          recipientAudienceSource: "customer_birthdays",
          telegramSubscriberSourceId: "telegram-source-1",
          uploadedRecipients: [{ chatId: "123", birthday: "01-01" }],
          scheduleConfig,
          ...config,
        },
      } as unknown as ScenarioNodeData),
      createNode("message", message as ScenarioNodeData),
    ];
  }

  it("accepts a daily Telegram birthday root with its bot and fixed message", () => {
    expect(
      validateScenarioGraph(birthdayNodes(), edges, { mode: "runnable" })
    ).toBeNull();
  });

  it("accepts a daily WhatsApp birthday root with its template", () => {
    expect(
      validateScenarioGraph(
        birthdayNodes({ channels: ["whatsapp"] }, whatsappMessage),
        edges,
        { mode: "runnable" }
      )
    ).toBeNull();
  });

  it("requires a saved selected birthday audience before activation", () => {
    const nodes = birthdayNodes({ uploadedRecipients: [] });
    expect(validateScenarioGraph(nodes, edges, { mode: "runnable" })).toBe(
      "birthdayRecipientsRequired"
    );
    expect(
      resolveScenarioGraphBlockingNodeIds(
        nodes,
        edges,
        "birthdayRecipientsRequired"
      )
    ).toEqual(["birthday-root"]);
    expect(validateScenarioGraph(nodes, edges, { mode: "draft" })).toBeNull();
    expect(
      validateScenarioGraph(nodes, edges, {
        mode: "runnable",
        scenarioMode: "bulk_campaign",
      })
    ).toBeNull();
  });

  it.each([
    [
      "missing bot",
      { telegramSubscriberSourceId: undefined },
      telegramMessage,
      "birthdayTelegramSourceRequired",
    ],
    [
      "email audience",
      { channels: ["email"] },
      { ...telegramMessage, actionReplyChannel: "email" },
      "birthdayChannelUnsupported",
    ],
    [
      "mixed channels",
      { channels: ["telegram", "whatsapp"] },
      telegramMessage,
      "birthdayChannelUnsupported",
    ],
    [
      "AI reply",
      {},
      { ...telegramMessage, actionReplyMode: "ai" },
      "birthdayActionRequired",
    ],
    [
      "empty Telegram text",
      {},
      { ...telegramMessage, actionReplyText: " " },
      "birthdayActionRequired",
    ],
    [
      "channel mismatch",
      { channels: ["whatsapp"] },
      telegramMessage,
      "birthdayActionRequired",
    ],
    [
      "missing schedule",
      { scheduleConfig: undefined },
      telegramMessage,
      "birthdayScheduleInvalid",
    ],
    [
      "weekly schedule",
      {
        scheduleConfig: {
          ...scheduleConfig,
          recurrence: { kind: "weekly", weekdays: ["monday"], time: "09:30" },
        },
      },
      telegramMessage,
      "birthdayScheduleInvalid",
    ],
    [
      "invalid time",
      {
        scheduleConfig: {
          ...scheduleConfig,
          recurrence: { kind: "daily", time: "25:00" },
        },
      },
      telegramMessage,
      "birthdayScheduleInvalid",
    ],
    [
      "invalid timezone",
      { scheduleConfig: { ...scheduleConfig, timezone: "unknown/timezone" } },
      telegramMessage,
      "birthdayScheduleInvalid",
    ],
    [
      "missing timezone",
      { scheduleConfig: { ...scheduleConfig, timezone: undefined } },
      telegramMessage,
      "birthdayScheduleInvalid",
    ],
    [
      "invalid mode",
      { scheduleConfig: { ...scheduleConfig, mode: "repeating" } },
      telegramMessage,
      "birthdayScheduleInvalid",
    ],
    [
      "invalid date bound",
      { scheduleConfig: { ...scheduleConfig, startAt: "not-a-date" } },
      telegramMessage,
      "birthdayScheduleInvalid",
    ],
    [
      "reversed date bounds",
      {
        scheduleConfig: {
          ...scheduleConfig,
          startAt: "2026-10-03T00:00:00.000Z",
          endAt: "2026-10-02T00:00:00.000Z",
        },
      },
      telegramMessage,
      "birthdayScheduleInvalid",
    ],
  ])(
    "rejects %s on activation and keeps it editable as a draft",
    (_label, config, message, error) => {
      const nodes = birthdayNodes(config as Record<string, unknown>, message);
      expect(validateScenarioGraph(nodes, edges, { mode: "runnable" })).toBe(
        error
      );
      expect(
        resolveScenarioGraphBlockingNodeIds(
          nodes,
          edges,
          error as Parameters<typeof resolveScenarioGraphBlockingNodeIds>[2]
        )
      ).toEqual(["birthday-root"]);
      expect(validateScenarioGraph(nodes, edges, { mode: "draft" })).toBeNull();
    }
  );
});
