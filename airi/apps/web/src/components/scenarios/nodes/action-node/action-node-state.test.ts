import {
  ACTION_ANY_REPLY_OUTCOME_HANDLE_ID,
  ACTION_FLOW_BRANCH_OUTPUT_HANDLE_ID,
  ACTION_INTERACTIVE_NO_REPLY_OUTPUT_HANDLE_ID,
  ACTION_NO_REPLY_OUTCOME_HANDLE_ID,
  ACTION_PAYMENT_OUTCOME_HANDLE_ID,
  ACTION_TELEGRAM_BRANCH_OUTPUT_HANDLE_ID,
  ACTION_WHATSAPP_SESSION_CHOICE_BRANCH_OUTPUT_HANDLE_ID,
  ACTION_WHATSAPP_TEMPLATE_BUTTON_BRANCH_OUTPUT_HANDLE_ID,
  ACTION_WHATSAPP_TEMPLATE_FORM_SUBMITTED_HANDLE_ID,
  GENERATIVE_AI_FAILURE_HANDLE,
  GENERATIVE_AI_SUCCESS_HANDLE,
  buildScenarioActionAnswerOutcomeHandleId,
  buildFlowBranchSourceHandleId,
  buildWhatsAppSessionChoiceSourceHandleId,
  buildWhatsAppTemplateButtonSourceHandleId,
} from "@icecore/scenario-contracts";
import {
  createActionEditorTestData as toEditorActionNodeData,
  type ActionNodeTestData,
} from "./action-node-test-utils";
import {
  resolveActionNodeBranchState,
  resolveActionNodeCardTitle,
  resolveActionNodeContinueRoute,
  resolveActionNodeFormSubmittedRoute,
  resolveActionNodeModeState as resolveActionNodeModeStateForEditor,
  type ActionNodeFormSubmittedRoute,
} from "./action-node-state";

const t = (key: string) => key;

function resolveActionNodeModeState(nodeData: ActionNodeTestData) {
  return resolveActionNodeModeStateForEditor(toEditorActionNodeData(nodeData));
}

function resolveBranchState(
  nodeData: ActionNodeTestData,
  renderMode: "compact" | "expanded" = "expanded"
) {
  const editorNodeData = toEditorActionNodeData(nodeData);
  const mode = resolveActionNodeModeStateForEditor(editorNodeData);
  return {
    mode,
    branchState: resolveActionNodeBranchState({
      id: "action-1",
      mode,
      nodeData: editorNodeData,
      renderMode,
      t,
    }),
  };
}

describe("action node state", () => {
  it("resolves forced reply modes for interactive action selectors", () => {
    expect(
      resolveActionNodeModeState({
        kind: "action",
        actionType: "reply",
        actionReplyChannel: "telegram",
      }).replyMode
    ).toBe("fixed");
    expect(
      resolveActionNodeModeState({
        kind: "action",
        actionType: "reply",
        actionWhatsAppServiceMessage: {
          version: 1,
          message: { kind: "contacts", contacts: [] },
        },
      }).replyMode
    ).toBe("fixed");
  });

  it("resolves the common WhatsApp service mode and its canonical body source", () => {
    const mode = resolveActionNodeModeState({
      kind: "action",
      actionType: "reply",
      actionWhatsAppServiceMessage: {
        version: 1,
        message: {
          kind: "text",
          body: { mode: "ai", instruction: "Answer briefly" },
        },
      },
    });

    expect(mode.isWhatsAppServiceMessage).toBe(true);
    expect(mode.actionType).toBe("reply");
    expect(mode.replyMode).toBe("ai");
  });

  it("keeps dynamic template branch handles hidden only in compact nodes", () => {
    const nodeData: ActionNodeTestData = {
      kind: "action",
      actionType: "whatsapp_template",
      actionWhatsAppTemplateComponents: [
        { type: "BODY", text: "Choose one" },
        {
          type: "BUTTONS",
          buttons: [{ type: "QUICK_REPLY", text: "Yes" }],
        },
      ],
    };

    const expanded = resolveBranchState(nodeData, "expanded").branchState;
    const compact = resolveBranchState(nodeData, "compact").branchState;

    expect(expanded.hiddenActionSourceHandles).toContain(
      ACTION_WHATSAPP_TEMPLATE_BUTTON_BRANCH_OUTPUT_HANDLE_ID
    );
    expect(expanded.hiddenActionSourceHandles).not.toContain(
      ACTION_INTERACTIVE_NO_REPLY_OUTPUT_HANDLE_ID
    );
    expect(expanded.hiddenActionSourceHandles).not.toContain(
      buildWhatsAppTemplateButtonSourceHandleId(0)
    );
    expect(compact.hiddenActionSourceHandles).toContain(
      buildWhatsAppTemplateButtonSourceHandleId(0)
    );
    expect(compact.branchCount).toBe(1);
  });

  it("resolves canonical WhatsApp Flow branches", () => {
    const nodeData: ActionNodeTestData = {
      kind: "action",
      actionType: "reply",
      actionWhatsAppServiceMessage: {
        version: 1,
        message: {
          kind: "flow",
          body: { mode: "fixed", text: "Open the form" },
          flowConfig: {
            templateId: "flow-template-1",
            ctaText: "Open",
            screens: [
              {
                id: "screen_1",
                title: "Question",
                fields: [
                  {
                    id: "field_1",
                    label: "Pick one",
                    fieldType: "RadioButtonsGroup",
                    options: [
                      { id: "yes", title: "Yes" },
                      { id: "no", title: "No" },
                    ],
                  },
                ],
              },
            ],
          },
        },
      },
    };

    const expanded = resolveBranchState(nodeData, "expanded").branchState;
    const compact = resolveBranchState(nodeData, "compact").branchState;

    expect(expanded.hiddenActionSourceHandles).toContain(
      ACTION_FLOW_BRANCH_OUTPUT_HANDLE_ID
    );
    expect(compact.actionSourceHandles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: ACTION_FLOW_BRANCH_OUTPUT_HANDLE_ID,
          title: "sourceHandleNextBranch",
        }),
      ])
    );
    expect(expanded.flowBranchOptions).toHaveLength(2);
    expect(expanded.suppressDefaultActionOutputHandle).toBe(true);
    expect(expanded.actionSourceHandles).toBeUndefined();
    expect(expanded.outputHandleOverride).toBeNull();
    expect(expanded.hiddenActionSourceHandles).not.toContain(
      ACTION_INTERACTIVE_NO_REPLY_OUTPUT_HANDLE_ID
    );
    expect(compact.hiddenActionSourceHandles).toContain(
      buildFlowBranchSourceHandleId("field_1", "yes")
    );
    expect(compact.actionSourceHandles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: ACTION_FLOW_BRANCH_OUTPUT_HANDLE_ID,
          title: "sourceHandleNextBranch",
        }),
      ])
    );
  });

  it("does not render Flow branches from an unsupported canonical owner", () => {
    const branchState = resolveBranchState({
      kind: "action",
      actionType: "reply",
      actionWhatsAppServiceMessage: {
        version: 99,
        message: { kind: "future" },
      } as never,
      actionFlowConfig: {
        templateId: "stale-flow",
        ctaText: "Open",
        screens: [
          {
            id: "screen-1",
            title: "Pick",
            fields: [
              {
                id: "plan",
                label: "Plan",
                fieldType: "RadioButtonsGroup",
                options: [{ id: "pro", title: "Pro" }],
              },
            ],
          },
        ],
      },
    }).branchState;

    expect(branchState.flowBranchOptions).toEqual([]);
  });

  it("resolves Telegram and canonical WhatsApp branch handle state", () => {
    const telegramNodeData: ActionNodeTestData = {
      kind: "action",
      actionType: "reply",
      actionReplyChannel: "telegram",
      actionTelegramQuickReplies: [[{ text: "Yes", payload: "yes" }]],
    };
    const telegram = resolveBranchState(telegramNodeData).branchState;
    const compactTelegram = resolveBranchState(
      telegramNodeData,
      "compact"
    ).branchState;
    const session = resolveBranchState({
      kind: "action",
      actionType: "reply",
      actionWhatsAppServiceMessage: {
        version: 1,
        message: {
          kind: "reply_buttons",
          body: { mode: "fixed", text: "Choose" },
          options: [{ id: "payload-1", label: "Pricing" }],
        },
      },
    }).branchState;

    expect(telegram.hasTelegramBranches).toBe(true);
    expect(telegram.hiddenActionSourceHandles).toContain(
      ACTION_TELEGRAM_BRANCH_OUTPUT_HANDLE_ID
    );
    expect(telegram.hiddenActionSourceHandles).not.toContain(
      ACTION_INTERACTIVE_NO_REPLY_OUTPUT_HANDLE_ID
    );
    expect(compactTelegram.actionSourceHandles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: ACTION_TELEGRAM_BRANCH_OUTPUT_HANDLE_ID,
          title: "sourceHandleNextBranch",
        }),
      ])
    );
    expect(session.hasWhatsAppServiceMessageBranches).toBe(true);
    expect(session.actionSourceHandles).toBeUndefined();
    expect(session.outputHandleOverride).toBeNull();
    expect(session.hiddenActionSourceHandles).not.toContain(
      ACTION_INTERACTIVE_NO_REPLY_OUTPUT_HANDLE_ID
    );
    expect(
      resolveBranchState(
        {
          kind: "action",
          actionType: "reply",
          actionWhatsAppServiceMessage: {
            version: 1,
            message: {
              kind: "reply_buttons",
              body: { mode: "fixed", text: "Choose" },
              options: [{ id: "payload-1", label: "Pricing" }],
            },
          },
        },
        "compact"
      ).branchState.hiddenActionSourceHandles
    ).toContain(buildWhatsAppSessionChoiceSourceHandleId("payload-1"));
  });

  it("keeps the legacy interactive handle hidden even when an existing edge is connected", () => {
    const generative = resolveBranchState({
      kind: "action",
      actionType: "generative_ai",
      actionGenerativeAIConfig: {
        version: 1,
        mode: "text_to_video",
        prompt: "Create a clip",
      },
      uiConnections: { sourceHandleIds: [GENERATIVE_AI_SUCCESS_HANDLE] },
    } as ActionNodeTestData).branchState;
    const interactive = resolveBranchState({
      kind: "action",
      actionType: "reply",
      actionWhatsAppServiceMessage: {
        version: 1,
        message: {
          kind: "reply_buttons",
          body: { mode: "fixed", text: "Choose" },
          options: [{ id: "payload-1", label: "Pricing" }],
        },
      },
      uiConnections: {
        sourceHandleIds: [ACTION_INTERACTIVE_NO_REPLY_OUTPUT_HANDLE_ID],
      },
    } as ActionNodeTestData).branchState;

    expect(generative.actionSourceHandles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: GENERATIVE_AI_SUCCESS_HANDLE,
          connected: true,
        }),
        expect.objectContaining({
          id: GENERATIVE_AI_FAILURE_HANDLE,
          connected: false,
        }),
      ])
    );
    expect(interactive.actionSourceHandles).toBeUndefined();
    expect(interactive.hiddenActionSourceHandles).toContain(
      ACTION_INTERACTIVE_NO_REPLY_OUTPUT_HANDLE_ID
    );
  });

  describe("a template's Form submitted route", () => {
    const FORM_SUBMITTED = ACTION_WHATSAPP_TEMPLATE_FORM_SUBMITTED_HANDLE_ID;
    const template = (
      buttonType: "FLOW" | "QUICK_REPLY",
      extra: Partial<ActionNodeTestData> = {}
    ): ActionNodeTestData => ({
      kind: "action",
      actionType: "whatsapp_template",
      actionWhatsAppTemplateComponents: [
        {
          type: "BUTTONS",
          buttons: [
            buttonType === "FLOW"
              ? { type: "FLOW", text: "Open form", flow_id: 1571793974235171 }
              : { type: "QUICK_REPLY", text: "Yes" },
          ],
        },
      ],
      ...extra,
    });
    const linked = {
      uiConnections: { sourceHandleIds: [FORM_SUBMITTED] },
    } satisfies Partial<ActionNodeTestData>;

    it.each<[string, ActionNodeTestData, ActionNodeFormSubmittedRoute]>([
      [
        "a row on a template whose one button opens a form",
        template("FLOW"),
        { placement: "row", connected: false },
      ],
      [
        "an anchor on a bulk send's template",
        template("FLOW", { uiBulkPrimaryWhatsAppTemplate: true }),
        { placement: "anchor", connected: false },
      ],
      [
        "an anchor, with activation's reason, on a bulk send's linked template",
        template("FLOW", { ...linked, uiBulkPrimaryWhatsAppTemplate: true }),
        {
          placement: "anchor",
          connected: true,
          error: "whatsappTemplateFormRouteInBulk",
        },
      ],
      [
        "an anchor, with activation's reason, for a route the template no longer offers",
        template("QUICK_REPLY", {
          uiConnections: {
            destinationsBySourceHandle: new Map([
              [FORM_SUBMITTED, { nodeId: "next", label: "Next" }],
            ]),
          },
        }),
        {
          placement: "anchor",
          connected: true,
          error: "whatsappTemplateFormRouteUnavailable",
        },
      ],
      [
        "nothing on a template without a form",
        template("QUICK_REPLY"),
        { placement: "none", connected: false },
      ],
    ])("is %s", (_label, data, expected) => {
      expect(
        resolveActionNodeFormSubmittedRoute(toEditorActionNodeData(data))
      ).toEqual(expected);
    });

    // The template section draws the route on its FLOW row; the node keeps
    // an anchor only where no row is drawn.
    it.each<[string, boolean, ActionNodeTestData]>([
      ["a linked route its FLOW row draws", false, template("FLOW", linked)],
      ["an unlinked route", false, template("FLOW")],
      [
        "a bulk send's route",
        true,
        template("FLOW", { ...linked, uiBulkPrimaryWhatsAppTemplate: true }),
      ],
      [
        "a route the template no longer offers",
        true,
        template("QUICK_REPLY", linked),
      ],
    ])("anchors %s in the inline editor: %s", (_label, anchored, data) => {
      const { branchState } = resolveBranchState(data);
      expect(
        branchState.hiddenActionSourceHandles.includes(FORM_SUBMITTED)
      ).toBe(anchored);
      // On the top right corner, as on the card: mid right edge it could sit
      // on a quick reply's dot and pass for that button's route.
      expect(branchState.cornerActionSourceHandles).toEqual(
        anchored ? [FORM_SUBMITTED] : []
      );
    });

    it("refreshes the node's handles when a form template is picked or linked", () => {
      const signature = (data: ActionNodeTestData) =>
        resolveBranchState(data).branchState.nodeHandleLayoutSignature;
      const textOnly: ActionNodeTestData = {
        kind: "action",
        actionType: "whatsapp_template",
        actionWhatsAppTemplateComponents: [{ type: "BODY", text: "Hi" }],
      };
      // Only the FLOW row's dot tells these apart: neither hides a handle.
      expect(signature(template("FLOW"))).not.toBe(signature(textOnly));
      expect(signature(template("FLOW", linked))).not.toBe(
        signature(template("FLOW"))
      );
    });

    it("keeps Then, which can't run beside it, as in the card", () => {
      const unlinkedThen = resolveBranchState(template("FLOW", linked));
      expect(unlinkedThen.branchState.suppressDefaultActionOutputHandle).toBe(
        true
      );
      expect(unlinkedThen.branchState.hiddenActionSourceHandles).toContain(
        "right-source"
      );
      // A linked one keeps its dot, named as the step's notice names it.
      const linkedThen = resolveBranchState(
        template("FLOW", {
          uiConnections: { sourceHandleIds: [FORM_SUBMITTED, "right-source"] },
        })
      );
      expect(linkedThen.branchState.suppressDefaultActionOutputHandle).toBe(
        false
      );
      expect(linkedThen.branchState.hiddenActionSourceHandles).not.toContain(
        "right-source"
      );
      expect(linkedThen.branchState.defaultActionSourceHandleCopy?.label).toBe(
        "actionPortNextStep"
      );
    });
  });

  it("keeps normal session-choice branch creation without exposing a no-reply control", () => {
    const nodeData: ActionNodeTestData = {
      kind: "action",
      actionType: "reply",
      actionWhatsAppServiceMessage: {
        version: 1,
        message: {
          kind: "reply_buttons",
          body: { mode: "fixed", text: "Choose" },
          options: [{ id: "payload-1", label: "Pricing" }],
        },
      },
    };

    const expanded = resolveBranchState(nodeData, "expanded").branchState;
    const compact = resolveBranchState(nodeData, "compact").branchState;

    expect(expanded.actionSourceHandles).toBeUndefined();
    expect(compact.actionSourceHandles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: ACTION_WHATSAPP_SESSION_CHOICE_BRANCH_OUTPUT_HANDLE_ID,
          title: "sourceHandleNextBranch",
        }),
      ])
    );
    expect(compact.hiddenActionSourceHandles).not.toContain(
      ACTION_INTERACTIVE_NO_REPLY_OUTPUT_HANDLE_ID
    );

    expect(
      resolveBranchState(
        {
          ...nodeData,
          uiConnections: { whatsAppChoicePayloads: ["payload-1"] },
        },
        "compact"
      ).branchState.actionSourceHandles
    ).toBeUndefined();
  });

  it("resolves canonical WhatsApp service branches from the shared transition", () => {
    const service = resolveBranchState({
      kind: "action",
      actionType: "reply",
      actionWhatsAppServiceMessage: {
        version: 1,
        message: {
          kind: "list",
          body: { mode: "fixed", text: "Choose" },
          buttonLabel: "View",
          sections: [
            {
              id: "plans",
              rows: [{ id: "wsc:action-1:pro", title: "Pro" }],
            },
          ],
        },
      },
    }).branchState;
    const payload = "wsc:action-1:pro";

    expect(service.hasWhatsAppServiceMessageBranches).toBe(true);
    expect(service.whatsAppServiceMessageBranchOptions).toEqual([
      expect.objectContaining({ id: payload, label: "Pro" }),
    ]);
    expect(service.actionSourceHandles).toBeUndefined();
    expect(service.outputHandleOverride).toBeNull();
    expect(service.hiddenActionSourceHandles).not.toContain(
      ACTION_INTERACTIVE_NO_REPLY_OUTPUT_HANDLE_ID
    );
  });

  it("counts provider branches with action outcomes and exposes stable rows", () => {
    const answerHandleId =
      buildScenarioActionAnswerOutcomeHandleId("answer_interested");
    const branchState = resolveBranchState({
      kind: "action",
      actionType: "whatsapp_template",
      actionWhatsAppTemplateComponents: [
        { type: "BODY", text: "Choose one" },
        {
          type: "BUTTONS",
          buttons: [{ type: "QUICK_REPLY", text: "Details" }],
        },
      ],
      actionRunConditions: {
        version: 1,
        match: "all",
        conditions: [
          { id: "gate-1", type: "has_purchase_history" },
          { id: "gate-2", type: "last_seen_days", minimumDays: 30 },
        ],
      },
      actionOutcomes: {
        version: 1,
        anyReply: { enabled: true },
        noReply: { enabled: true, timeoutMinutes: 120 },
        answerMatches: [
          {
            id: "answer_interested",
            mode: "intent",
            text: "Interested",
          },
        ],
        paymentDetected: { enabled: true },
      },
      uiConnections: {
        sourceHandleIds: [ACTION_NO_REPLY_OUTCOME_HANDLE_ID, answerHandleId],
      },
    }).branchState;

    expect(branchState.runConditionCount).toBe(2);
    expect(branchState.branchCount).toBe(5);
    expect(branchState.actionOutcomeRows).toEqual([
      expect.objectContaining({
        handleId: ACTION_ANY_REPLY_OUTCOME_HANDLE_ID,
        // The template's quick replies take their taps first.
        label: "actionOutcomeOtherReply",
        connected: false,
      }),
      expect.objectContaining({
        handleId: ACTION_NO_REPLY_OUTCOME_HANDLE_ID,
        label: "actionOutcomeNoReply",
        detail: "noReplyDuration",
        timeoutMinutes: 120,
        connected: true,
      }),
      expect.objectContaining({
        handleId: answerHandleId,
        label: "Interested",
        mode: "intent",
        answerText: "Interested",
        connected: true,
      }),
      expect.objectContaining({
        handleId: ACTION_PAYMENT_OUTCOME_HANDLE_ID,
        label: "actionOutcomePayment",
        connected: false,
      }),
    ]);
  });

  it("keeps the action outcome handle signature stable across answer edits", () => {
    const before = resolveBranchState({
      kind: "action",
      actionType: "reply",
      actionOutcomes: {
        version: 1,
        answerMatches: [{ id: "answer-1", mode: "exact", text: "Yes" }],
      },
    }).branchState;
    const after = resolveBranchState({
      kind: "action",
      actionType: "reply",
      actionOutcomes: {
        version: 1,
        answerMatches: [{ id: "answer-1", mode: "intent", text: "Absolutely" }],
      },
    }).branchState;

    expect(before.actionOutcomeHandleSignature).toBe(
      buildScenarioActionAnswerOutcomeHandleId("answer-1")
    );
    expect(after.actionOutcomeHandleSignature).toBe(
      before.actionOutcomeHandleSignature
    );
  });

  it("uses only fixed Success and Failure handles for Generative AI actions", () => {
    const { mode, branchState } = resolveBranchState({
      kind: "action",
      actionType: "generative_ai",
      actionGenerativeAIConfig: {
        version: 1,
        mode: "text_to_video",
        prompt: "Create a launch clip",
      },
      actionOutcomes: {
        version: 1,
        anyReply: { enabled: true },
        noReply: { enabled: true, timeoutMinutes: 15 },
      },
    });

    expect(mode.isGenerativeAI).toBe(true);
    expect(branchState.suppressDefaultActionOutputHandle).toBe(true);
    expect(branchState.actionSourceHandles).toEqual([
      expect.objectContaining({
        id: GENERATIVE_AI_SUCCESS_HANDLE,
        title: "generativeAISuccess",
      }),
      expect.objectContaining({
        id: GENERATIVE_AI_FAILURE_HANDLE,
        title: "generativeAIFailure",
      }),
    ]);
    expect(branchState.actionOutcomeRows).toEqual([]);
    expect(branchState.branchCount).toBe(2);
  });

  it("names an untitled answer rule instead of showing its placeholder", () => {
    const { branchState } = resolveBranchState({
      kind: "action",
      actionType: "reply",
      actionOutcomes: {
        version: 1,
        answerMatches: [{ id: "answer-1", mode: "exact", text: "  " }],
      },
    });
    expect(branchState.actionOutcomeRows).toEqual([
      expect.objectContaining({
        label: "sourceHandleConditionAnswerMatchAny",
        answerText: "",
      }),
    ]);
  });

  it("writes the quiet period through the localized duration", () => {
    const withValues = (key: string, values?: Record<string, unknown>) =>
      values ? `${key}:${JSON.stringify(values)}` : key;
    const editorNodeData = toEditorActionNodeData({
      kind: "action",
      actionType: "reply",
      actionOutcomes: {
        version: 1,
        noReply: { enabled: true, timeoutMinutes: 2880 },
      },
    });
    const branchState = resolveActionNodeBranchState({
      id: "action-1",
      mode: resolveActionNodeModeStateForEditor(editorNodeData),
      nodeData: editorNodeData,
      renderMode: "expanded",
      t: withValues,
    });
    expect(branchState.actionOutcomeRows[0]?.detail).toBe(
      'noReplyDuration:{"unit":"days","count":2}'
    );
  });

  it("names the next unlinked choice, and an unnamed one by its fallback", () => {
    const withLabel = (key: string, values?: Record<string, unknown>) =>
      values?.label ? `${key}:${String(values.label)}` : key;
    const editorNodeData = toEditorActionNodeData({
      kind: "action",
      actionType: "reply",
      actionWhatsAppServiceMessage: {
        version: 1,
        message: {
          kind: "reply_buttons",
          body: { mode: "fixed", text: "Choose" },
          options: [{ id: "wsc:action-1:draft", label: "" }],
        },
      },
    });
    const branchState = resolveActionNodeBranchState({
      id: "action-1",
      mode: resolveActionNodeModeStateForEditor(editorNodeData),
      nodeData: editorNodeData,
      renderMode: "compact",
      t: withLabel,
    });
    expect(branchState.actionSourceHandles).toEqual([
      expect.objectContaining({
        title: "sourceHandleNextBranch:untitledButton",
      }),
    ]);
  });

  describe("a default output that Any reply stands in for", () => {
    const template = (
      extra: Partial<ActionNodeTestData> = {}
    ): ActionNodeTestData => ({
      kind: "action",
      actionType: "whatsapp_template",
      actionWhatsAppTemplateComponents: [
        { type: "BODY", text: "Choose one" },
        { type: "BUTTONS", buttons: [{ type: "QUICK_REPLY", text: "Yes" }] },
      ],
      ...extra,
    });
    const serviceText = (
      extra: Partial<ActionNodeTestData> = {}
    ): ActionNodeTestData => ({
      kind: "action",
      actionType: "reply",
      actionWhatsAppServiceMessage: {
        version: 1,
        message: { kind: "text", body: { mode: "fixed", text: "Hello" } },
      },
      ...extra,
    });
    const anyReply = {
      actionOutcomes: { version: 1, anyReply: { enabled: true } },
    } satisfies Partial<ActionNodeTestData>;
    const linked = {
      uiConnections: { sourceHandleIds: ["right-source"] },
    } satisfies Partial<ActionNodeTestData>;

    it("names a template's default output Other reply while Any reply is off", () => {
      const { branchState } = resolveBranchState(template());
      expect(branchState.suppressDefaultActionOutputHandle).toBe(false);
      expect(branchState.hiddenActionSourceHandles).not.toContain(
        "right-source"
      );
      expect(branchState.defaultActionSourceHandleCopy).toEqual({
        label: "sourceHandleAnyUserReply",
        tooltip: "sourceHandleAnyUserReply",
      });
    });

    it("keeps only the anchor of an unlinked default output beside Any reply", () => {
      for (const data of [template(anyReply), serviceText(anyReply)]) {
        const { branchState } = resolveBranchState(data);
        expect(branchState.suppressDefaultActionOutputHandle).toBe(true);
        expect(branchState.hiddenActionSourceHandles).toContain("right-source");
        expect(branchState.outputHandleOverride).toBeNull();
        expect(branchState.defaultActionSourceHandleCopy).toBeNull();
      }
    });

    it("names a linked default output Then beside Other reply", () => {
      const { branchState } = resolveBranchState(
        template({ ...anyReply, ...linked })
      );
      expect(branchState.suppressDefaultActionOutputHandle).toBe(false);
      expect(branchState.hiddenActionSourceHandles).not.toContain(
        "right-source"
      );
      expect(branchState.defaultActionSourceHandleCopy).toEqual({
        label: "actionPortNextStep",
        tooltip: "actionPortNextStep",
      });
      expect(
        resolveBranchState(serviceText({ ...anyReply, ...linked })).branchState
          .suppressDefaultActionOutputHandle
      ).toBe(false);
    });

    it("keeps a plain step's default output beside Any reply", () => {
      const { branchState } = resolveBranchState({
        kind: "action",
        actionType: "reply",
        ...anyReply,
      });
      expect(branchState.suppressDefaultActionOutputHandle).toBe(false);
      expect(branchState.hiddenActionSourceHandles).not.toContain(
        "right-source"
      );
    });
  });

  describe("a default output that a linked outcome keeps from running", () => {
    const noReplyOn = {
      version: 1 as const,
      noReply: { enabled: true, timeoutMinutes: 30 },
    };
    const noReplyLinked = {
      actionOutcomes: noReplyOn,
      uiConnections: { sourceHandleIds: [ACTION_NO_REPLY_OUTCOME_HANDLE_ID] },
    } satisfies Partial<ActionNodeTestData>;
    const serviceText: ActionNodeTestData = {
      kind: "action",
      actionType: "reply",
      actionWhatsAppServiceMessage: {
        version: 1,
        message: { kind: "text", body: { mode: "fixed", text: "Hello" } },
      },
    };
    const formTemplate: ActionNodeTestData = {
      kind: "action",
      actionType: "whatsapp_template",
      actionWhatsAppTemplateName: "form",
      actionWhatsAppTemplateComponents: [
        { type: "BODY", text: "Fill" },
        {
          type: "BUTTONS",
          buttons: [{ type: "FLOW", text: "Open", flow_id: "flow-1" }],
        },
      ],
      actionReplyCtaType: "flow",
      actionReplyCtaFlowId: "flow-1",
    };
    const serviceForm: ActionNodeTestData = {
      kind: "action",
      actionType: "reply",
      actionWhatsAppServiceMessage: {
        version: 1,
        message: {
          kind: "flow",
          body: { mode: "fixed", text: "Open the form" },
          flowConfig: {
            templateId: "flow-1",
            metaFlowId: "flow-1",
            ctaText: "Open",
            screens: [],
          },
        },
      },
    };

    it.each<[string, ActionNodeTestData]>([
      ["Reply", serviceText],
      ["Then", { kind: "action", actionType: "reply", actionReplyText: "Hi" }],
    ])("keeps only the anchor of an unlinked %s", (_label, data) => {
      const { branchState } = resolveBranchState({ ...data, ...noReplyLinked });
      expect(branchState.suppressDefaultActionOutputHandle).toBe(true);
      expect(branchState.hiddenActionSourceHandles).toContain("right-source");
    });

    it.each<[string, ActionNodeTestData]>([
      ["Form submitted", serviceForm],
      ["a template's form button", formTemplate],
    ])("keeps the dot of an unlinked %s", (_label, data) => {
      const { branchState } = resolveBranchState({ ...data, ...noReplyLinked });
      expect(branchState.suppressDefaultActionOutputHandle).toBe(false);
      expect(branchState.hiddenActionSourceHandles).not.toContain(
        "right-source"
      );
    });

    it("keeps the dot of a linked Reply, so its edge can be deleted", () => {
      const { branchState } = resolveBranchState({
        ...serviceText,
        actionOutcomes: noReplyOn,
        uiConnections: {
          sourceHandleIds: [ACTION_NO_REPLY_OUTCOME_HANDLE_ID, "right-source"],
        },
      });
      expect(branchState.suppressDefaultActionOutputHandle).toBe(false);
      expect(branchState.hiddenActionSourceHandles).not.toContain(
        "right-source"
      );
      // The dot carries the name the step's notice uses.
      expect(branchState.defaultActionSourceHandleCopy).toEqual({
        label: t("serviceRouteNextMessage"),
        tooltip: t("serviceRouteNextMessage"),
      });
    });

    it("names a linked Then that can't run on a plain step", () => {
      const { branchState } = resolveBranchState({
        kind: "action",
        actionType: "reply",
        actionReplyText: "Hi",
        actionOutcomes: noReplyOn,
        uiConnections: {
          sourceHandleIds: [ACTION_NO_REPLY_OUTCOME_HANDLE_ID, "right-source"],
        },
      });
      expect(branchState.defaultActionSourceHandleCopy?.label).toBe(
        t("actionPortNextStep")
      );
    });

    it("says whether the default route shows, hides or can't run", () => {
      const continueRoute = (
        data: ActionNodeTestData,
        connected: boolean,
        hasAnyReply = false
      ) =>
        resolveActionNodeContinueRoute({
          id: "action-1",
          nodeData: toEditorActionNodeData(data),
          usesTemplateButtons: false,
          hasAnyReply,
          connected,
        });
      expect(continueRoute(serviceText, false)).toBe("shown");
      expect(continueRoute({ ...serviceText, ...noReplyLinked }, false)).toBe(
        "hidden"
      );
      expect(continueRoute({ ...serviceText, ...noReplyLinked }, true)).toBe(
        "cannot_run"
      );
      expect(continueRoute({ ...serviceForm, ...noReplyLinked }, true)).toBe(
        "shown"
      );
      // Any reply stands in for an unlinked Reply even before it is linked.
      expect(
        continueRoute(
          {
            ...serviceText,
            actionOutcomes: { version: 1, anyReply: { enabled: true } },
          },
          false,
          true
        )
      ).toBe("hidden");
    });
  });

  it.each([
    ["text_to_image", "generativeAITitleImage"],
    ["text_to_video", "generativeAITitleVideo"],
    ["image_to_video", "generativeAITitleVideoFromPhoto"],
    ["audio", "presetActionGenerativeAI"],
  ])("names a %s step by what it creates", (mode, key) => {
    expect(
      resolveActionNodeCardTitle(
        toEditorActionNodeData({
          kind: "action",
          actionType: "generative_ai",
          actionGenerativeAIConfig: {
            version: 1,
            mode,
            prompt: "Poster",
          } as never,
        }),
        t
      )
    ).toBe(key);
  });
});
