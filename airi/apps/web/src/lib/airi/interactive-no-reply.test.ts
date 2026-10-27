import { resolvePendingConditionEventDisposition } from "@/lib/airi/interactive-no-reply";
import { compileScenarioGraph } from "@icecore/airi-runtime/scenario-graph";
import {
  buildScenarioActionOutcomeHandleId,
  buildWhatsAppTemplateButtonSourceHandleId,
  getScenarioActionBranchDelayVirtualNodeId,
  getScenarioActionOutcomeVirtualNodeId,
} from "@icecore/scenario-contracts";

/** The wait the compiler arms for the action's Outcomes, as the runtime gets it. */
const outcomeWait = (sourceAction: Record<string, unknown>) => {
  const outcomes = sourceAction.actionOutcomes as {
    noReply?: { enabled?: boolean };
  };
  const graph = compileScenarioGraph(
    [
      { id: "menu", data: sourceAction as never },
      {
        id: "later",
        data: {
          kind: "action",
          actionType: "reply",
          actionReplyMode: "fixed",
          actionReplyText: "Later",
        },
      },
    ],
    [
      {
        source: "menu",
        target: "later",
        sourceHandle: buildScenarioActionOutcomeHandleId(
          outcomes.noReply?.enabled ? "no_reply" : "payment_detected"
        ),
      },
    ]
  );
  const conditionNodeId = getScenarioActionOutcomeVirtualNodeId("menu");
  return {
    conditionNodeId,
    conditionNodeData: graph.nodesById.get(conditionNodeId)?.data,
    pendingSourceActionData: sourceAction,
  };
};

describe("resolvePendingConditionEventDisposition", () => {
  it("recognizes radio branches on a managed-only template Flow", () => {
    expect(
      resolvePendingConditionEventDisposition({
        triggerEventKind: "whatsapp_flow_reply",
        conditionNodeData: {
          kind: "logic",
          logicType: "post_action_condition",
        },
        pendingSourceActionData: {
          kind: "action",
          actionType: "whatsapp_template",
          actionReplyCtaType: "flow",
          actionFlowConfig: {
            templateId: "local-flow",
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
            screens: [
              {
                id: "s1",
                title: "Choose",
                fields: [
                  {
                    id: "f1",
                    label: "Pick",
                    fieldType: "RadioButtonsGroup",
                    options: [{ id: "o1", title: "One" }],
                  },
                ],
              },
            ],
          },
        },
      })
    ).toBe("interactive_reply");
  });

  it("recognizes branching canonical service Flows", () => {
    expect(
      resolvePendingConditionEventDisposition({
        triggerEventKind: "whatsapp_flow_reply",
        conditionNodeData: {
          kind: "logic",
          logicType: "post_action_condition",
        },
        pendingSourceActionData: {
          kind: "action",
          actionType: "reply",
          actionWhatsAppServiceMessage: {
            version: 1,
            message: {
              kind: "flow",
              body: { mode: "fixed", text: "Choose" },
              flowConfig: {
                templateId: "flow-template",
                ctaText: "Open",
                screens: [
                  {
                    id: "s1",
                    title: "T",
                    fields: [
                      {
                        id: "f1",
                        label: "Pick",
                        fieldType: "RadioButtonsGroup",
                        options: [{ id: "o1", title: "A" }],
                      },
                    ],
                  },
                ],
              },
            },
          },
        },
      })
    ).toBe("interactive_reply");
  });

  it("treats Telegram quick replies as interactive_reply when the pending source has inline buttons", () => {
    expect(
      resolvePendingConditionEventDisposition({
        triggerEventKind: "telegram_quick_reply",
        conditionNodeData: {
          kind: "logic",
          logicType: "post_action_condition",
        },
        pendingSourceActionData: {
          kind: "action",
          actionType: "reply",
          actionTelegramQuickReplies: [[{ text: "Yes", payload: "yes" }]],
        },
      })
    ).toBe("interactive_reply");
  });

  it("pins canonical WhatsApp service button replies without a legacy channel field", () => {
    expect(
      resolvePendingConditionEventDisposition({
        triggerEventKind: "whatsapp_button_reply",
        conditionNodeData: {
          kind: "logic",
          logicType: "post_action_condition",
        },
        pendingSourceActionData: {
          kind: "action",
          actionType: "reply",
          actionWhatsAppServiceMessage: {
            version: 1,
            message: {
              kind: "reply_buttons",
              body: { mode: "fixed", text: "Choose" },
              options: [{ id: "pricing", label: "Pricing" }],
            },
          },
        },
      })
    ).toBe("interactive_reply");
  });

  it("does not treat plain WhatsApp text as a canonical button reply", () => {
    expect(
      resolvePendingConditionEventDisposition({
        triggerEventKind: "inbound_message",
        conditionNodeData: {
          kind: "logic",
          logicType: "post_action_condition",
          postActionConditionVariant: "interactive_no_reply",
          interactiveNoReplySurface: "whatsapp_session_choices",
        },
        pendingSourceActionData: {
          kind: "action",
          actionType: "reply",
          actionWhatsAppServiceMessage: {
            version: 1,
            message: {
              kind: "reply_buttons",
              body: { mode: "fixed", text: "Choose" },
              options: [{ id: "pricing", label: "Pricing" }],
            },
          },
        },
      })
    ).toBe("ignore");
  });

  it("does not clear an action-owned interactive wait from unrelated inbound text without an any-reply outcome", () => {
    const interactiveFlowActionWithoutAnyReply = {
      kind: "action" as const,
      actionType: "reply" as const,
      actionWhatsAppServiceMessage: {
        version: 1 as const,
        message: {
          kind: "flow" as const,
          body: { mode: "fixed" as const, text: "Choose" },
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
                    fieldType: "RadioButtonsGroup" as const,
                    options: [{ id: "one", title: "One" }],
                  },
                ],
              },
            ],
          },
        },
      },
      actionOutcomes: {
        version: 1 as const,
        noReply: { enabled: true, timeoutMinutes: 30 },
      },
    };
    const interactiveFlowActionWithAnyReply = {
      ...interactiveFlowActionWithoutAnyReply,
      actionOutcomes: {
        ...interactiveFlowActionWithoutAnyReply.actionOutcomes,
        anyReply: { enabled: true },
      },
    };

    expect(
      resolvePendingConditionEventDisposition({
        triggerEventKind: "inbound_message",
        ...outcomeWait(interactiveFlowActionWithoutAnyReply),
      })
    ).toBe("ignore");
    expect(
      resolvePendingConditionEventDisposition({
        triggerEventKind: "inbound_message",
        ...outcomeWait(interactiveFlowActionWithAnyReply),
      })
    ).toBe("user_replied");
  });

  it("keeps WhatsApp Flow replies interactive for an action-owned wait", () => {
    expect(
      resolvePendingConditionEventDisposition({
        triggerEventKind: "whatsapp_flow_reply",
        conditionNodeData: {
          kind: "logic",
          logicType: "post_action_condition",
        },
        pendingSourceActionData: {
          kind: "action",
          actionType: "reply",
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
            noReply: { enabled: true, timeoutMinutes: 30 },
          },
        },
      })
    ).toBe("interactive_reply");
  });

  it("keeps interactive replies higher priority than payment detection", () => {
    expect(
      resolvePendingConditionEventDisposition({
        triggerEventKind: "telegram_quick_reply",
        confirmedPayment: true,
        conditionNodeData: {
          kind: "logic",
          logicType: "post_action_condition",
          postActionConditionVariant: "interactive_no_reply",
          interactiveNoReplySurface: "telegram_builder",
        },
        pendingSourceActionData: {
          kind: "action",
          actionType: "reply",
          actionTelegramQuickReplies: [[{ text: "Yes", payload: "yes" }]],
        },
      })
    ).toBe("interactive_reply");
  });

  it("routes a verified payment event before generic text handling", () => {
    expect(
      resolvePendingConditionEventDisposition({
        triggerEventKind: "payment_detected",
        confirmedPayment: true,
        conditionNodeData: {
          kind: "logic",
          logicType: "post_action_condition",
        },
        pendingSourceActionData: {
          kind: "action",
          actionType: "reply",
        },
      })
    ).toBe("payment_detected");
  });

  it("ignores an unverified payment event", () => {
    expect(
      resolvePendingConditionEventDisposition({
        triggerEventKind: "payment_detected",
      })
    ).toBe("ignore");
  });

  it("does not turn an inbound receipt into a confirmed payment", () => {
    expect(
      resolvePendingConditionEventDisposition({
        triggerEventKind: "inbound_message",
        confirmedPayment: true,
      })
    ).toBe("user_replied");
  });

  it("still routes normal text waits through user_replied for standard condition nodes", () => {
    expect(
      resolvePendingConditionEventDisposition({
        triggerEventKind: "inbound_message",
        conditionNodeData: {
          kind: "logic",
          logicType: "post_action_condition",
        },
        pendingSourceActionData: {
          kind: "action",
          actionType: "reply",
        },
      })
    ).toBe("user_replied");
  });

  describe("replies during an action-owned wait", () => {
    const actionWait = {
      kind: "logic" as const,
      logicType: "post_action_condition" as const,
    };
    const noReplyOutcome = {
      version: 1 as const,
      noReply: { enabled: true, timeoutMinutes: 30 },
    };
    const withAnyReply = <T extends object>(action: T) => ({
      ...action,
      actionOutcomes: { ...noReplyOutcome, anyReply: { enabled: true } },
    });
    const instagramQuickReplies = {
      kind: "action" as const,
      actionType: "reply" as const,
      actionReplyChannel: "instagram" as const,
      actionInstagramConfig: {
        kind: "quick_replies" as const,
        quickReplies: [{ title: "Pricing", payload: "pricing" }],
      },
      actionOutcomes: noReplyOutcome,
    };
    const templateQuickReplies = {
      kind: "action" as const,
      actionType: "whatsapp_template" as const,
      actionWhatsAppTemplateName: "pick_lang",
      actionWhatsAppTemplateComponents: [
        {
          type: "BUTTONS" as const,
          buttons: [
            { type: "QUICK_REPLY" as const, text: "Kazakh" },
            { type: "QUICK_REPLY" as const, text: "Russian" },
          ],
        },
      ],
      actionOutcomes: noReplyOutcome,
    };
    const serviceReplyButtons = {
      kind: "action" as const,
      actionType: "reply" as const,
      actionWhatsAppServiceMessage: {
        version: 1 as const,
        message: {
          kind: "reply_buttons" as const,
          body: { mode: "fixed" as const, text: "Choose" },
          options: [{ id: "wsc:menu:help", label: "Help" }],
        },
      },
      actionOutcomes: noReplyOutcome,
    };
    const flowWithoutChoices = {
      kind: "action" as const,
      actionType: "reply" as const,
      actionWhatsAppServiceMessage: {
        version: 1 as const,
        message: {
          kind: "flow" as const,
          body: { mode: "fixed" as const, text: "Tell us about you" },
          flowConfig: {
            templateId: "flow-1",
            ctaText: "Open",
            screens: [
              {
                id: "screen-1",
                title: "About you",
                fields: [
                  {
                    id: "name",
                    label: "Name",
                    fieldType: "TextInput" as const,
                  },
                ],
              },
            ],
          },
        },
      },
      actionOutcomes: noReplyOutcome,
    };
    const plainReminder = {
      kind: "action" as const,
      actionType: "reply" as const,
      actionWhatsAppServiceMessage: {
        version: 1 as const,
        message: {
          kind: "text" as const,
          body: { mode: "fixed" as const, text: "Still there?" },
        },
      },
      actionOutcomes: noReplyOutcome,
    };

    it("routes an Instagram quick reply to the action that sent it", () => {
      expect(
        resolvePendingConditionEventDisposition({
          triggerEventKind: "instagram_quick_reply",
          conditionNodeData: actionWait,
          pendingSourceActionData: instagramQuickReplies,
        })
      ).toBe("interactive_reply");
      expect(
        resolvePendingConditionEventDisposition({
          triggerEventKind: "instagram_quick_reply",
          conditionNodeData: {
            ...actionWait,
            postActionConditionVariant: "interactive_no_reply",
            interactiveNoReplySurface: "instagram_reply",
          },
          pendingSourceActionData: instagramQuickReplies,
        })
      ).toBe("interactive_reply");
    });

    it.each([
      [
        "a Flow submission without choice fields",
        "whatsapp_flow_reply",
        flowWithoutChoices,
      ],
      [
        "an older message's button after a reminder took over the wait",
        "whatsapp_button_reply",
        plainReminder,
      ],
      [
        "an Instagram quick reply to an action without quick replies",
        "instagram_quick_reply",
        plainReminder,
      ],
      [
        "a Telegram quick reply to an action without inline buttons",
        "telegram_quick_reply",
        plainReminder,
      ],
    ] as const)(
      "leaves %s to normal routing, even with Any reply on",
      (_, triggerEventKind, sourceAction) => {
        for (const pendingSourceActionData of [
          sourceAction,
          withAnyReply(sourceAction),
        ]) {
          expect(
            resolvePendingConditionEventDisposition({
              triggerEventKind,
              conditionNodeData: actionWait,
              pendingSourceActionData,
            })
          ).toBe("unowned_interactive_reply");
        }
      }
    );

    it("leaves a structured reply outside a legacy interactive wait to normal routing", () => {
      expect(
        resolvePendingConditionEventDisposition({
          triggerEventKind: "whatsapp_button_reply",
          conditionNodeData: {
            ...actionWait,
            postActionConditionVariant: "interactive_no_reply",
            interactiveNoReplySurface: "whatsapp_flow",
          },
          pendingSourceActionData: flowWithoutChoices,
        })
      ).toBe("unowned_interactive_reply");
    });

    it.each([
      ["WhatsApp template quick-reply buttons", templateQuickReplies],
      ["WhatsApp service-message reply buttons", serviceReplyButtons],
      ["Instagram quick replies", instagramQuickReplies],
    ] as const)(
      "keeps a wait on %s when the customer types instead of tapping",
      (_, sourceAction) => {
        expect(
          resolvePendingConditionEventDisposition({
            triggerEventKind: "inbound_message",
            ...outcomeWait(sourceAction),
          })
        ).toBe("ignore");
        expect(
          resolvePendingConditionEventDisposition({
            triggerEventKind: "inbound_message",
            ...outcomeWait(withAnyReply(sourceAction)),
          })
        ).toBe("user_replied");
      }
    );

    // DemoShop's medal_pick_1: a template whose only button opens a form.
    const flowButtonTemplate = {
      kind: "action" as const,
      actionType: "whatsapp_template" as const,
      actionWhatsAppTemplateName: "medal_pick_1",
      actionWhatsAppTemplateComponents: [
        {
          type: "BUTTONS" as const,
          buttons: [
            {
              type: "FLOW" as const,
              text: "Choose",
              flow_id: "2244981489363579",
              flow_action: "navigate" as const,
              navigate_screen: "QUESTION_ONE",
            },
          ],
        },
      ],
      actionOutcomes: noReplyOutcome,
    };
    const urlButtonTemplate = {
      kind: "action" as const,
      actionType: "whatsapp_template" as const,
      actionWhatsAppTemplateName: "dozhim_3",
      actionWhatsAppTemplateComponents: [
        {
          type: "BUTTONS" as const,
          buttons: [
            {
              type: "URL" as const,
              text: "Catalog",
              url: "https://example.com",
            },
          ],
        },
      ],
      actionOutcomes: noReplyOutcome,
    };
    const paymentOnly = {
      ...plainReminder,
      actionOutcomes: {
        version: 1 as const,
        paymentDetected: { enabled: true },
      },
    };

    it.each([
      ["a plain text message", plainReminder],
      ["a template whose only button opens a form", flowButtonTemplate],
      ["a template with only a link button", urlButtonTemplate],
      ["a Flow without choice fields", flowWithoutChoices],
      ["a step waiting only for payment", paymentOnly],
    ] as const)(
      "keeps a wait on %s when the customer types, unless Any reply is on",
      (_, sourceAction) => {
        for (const triggerEventKind of [
          "inbound_message",
          undefined,
        ] as const) {
          expect(
            resolvePendingConditionEventDisposition({
              triggerEventKind,
              ...outcomeWait(sourceAction),
            })
          ).toBe("ignore");
          expect(
            resolvePendingConditionEventDisposition({
              triggerEventKind,
              ...outcomeWait(withAnyReply(sourceAction)),
            })
          ).toBe("user_replied");
        }
      }
    );

    it("leaves a submission of a template's own form to normal routing", () => {
      // Routing takes the step's Form submitted route only for a reply to the
      // form that step sent; the wait never answers the form by itself.
      for (const triggerEventKind of [
        "whatsapp_flow_reply",
        "whatsapp_button_reply",
      ] as const) {
        expect(
          resolvePendingConditionEventDisposition({
            triggerEventKind,
            ...outcomeWait(flowButtonTemplate),
          })
        ).toBe("unowned_interactive_reply");
      }
    });

    it("keeps a legacy condition's own reply branch under an action with Outcomes", () => {
      // No outcome edge, so no Outcomes wait: the legacy condition waits.
      expect(
        resolvePendingConditionEventDisposition({
          triggerEventKind: "inbound_message",
          conditionNodeId: "legacy-condition",
          conditionNodeData: actionWait,
          pendingSourceActionData: {
            ...plainReminder,
            actionOutcomes: { version: 1 },
          },
        })
      ).toBe("user_replied");
    });

    describe("while a delayed CTA follow-up waits", () => {
      const delayedHandle = buildWhatsAppTemplateButtonSourceHandleId(0);
      const delayWaitId = getScenarioActionBranchDelayVirtualNodeId(
        "menu",
        delayedHandle
      );
      const delayWait = (cancelIfPhrases?: string[]) => ({
        ...actionWait,
        conditionBranches: [
          {
            id: "no_reply_timeout",
            type: "no_reply_timeout" as const,
            timeoutMinutes: 30,
            ...(cancelIfPhrases ? { missingTextPhrases: cancelIfPhrases } : {}),
          },
        ],
      });
      const sources = [
        templateQuickReplies,
        withAnyReply(templateQuickReplies),
        serviceReplyButtons,
        withAnyReply(serviceReplyButtons),
      ];

      it.each([
        ["typed text", "inbound_message"],
        ["media or text without an event kind", undefined],
      ] as const)(
        "keeps the wait on %s, even when the action's Any reply is on",
        (_, triggerEventKind) => {
          for (const pendingSourceActionData of sources) {
            for (const conditionNodeData of [
              delayWait(),
              delayWait(["Order accepted"]),
            ]) {
              expect(
                resolvePendingConditionEventDisposition({
                  triggerEventKind,
                  conditionNodeId: delayWaitId,
                  conditionNodeData,
                  pendingSourceActionData,
                })
              ).toBe("ignore");
            }
          }
          // The action's own outcome wait still honours Any reply.
          expect(
            resolvePendingConditionEventDisposition({
              triggerEventKind,
              ...outcomeWait(withAnyReply(templateQuickReplies)),
            })
          ).toBe("user_replied");
        }
      );

      it("lets the waiting action's buttons and the timer through", () => {
        for (const pendingSourceActionData of sources) {
          expect(
            resolvePendingConditionEventDisposition({
              triggerEventKind: "whatsapp_button_reply",
              conditionNodeId: delayWaitId,
              conditionNodeData: delayWait(),
              pendingSourceActionData,
            })
          ).toBe("interactive_reply");
          expect(
            resolvePendingConditionEventDisposition({
              triggerEventKind: "no_human_reply_timeout",
              conditionNodeId: delayWaitId,
              conditionNodeData: delayWait(),
              pendingSourceActionData,
            })
          ).toBe("no_reply_timeout");
        }
      });
    });
  });
});
