import {
  FLOW_BRANCH_TRANSITION,
  GENERATIVE_AI_OUTPUT_TRANSITION,
  getPostActionConditionBranchTransitionByHandle,
  getScenarioActionOutputTransitionForSourceHandle,
  postActionConditionBranchHandleMatchesEvent,
  PROMPT_INPUTS_UNMET_OUTPUT_TRANSITION,
  getScenarioActionBranchTransitionsForNode,
  SCENARIO_ACTION_BRANCH_TRANSITIONS,
  WHATSAPP_SERVICE_MESSAGE_BRANCH_TRANSITION,
  WHATSAPP_TEMPLATE_BUTTON_BRANCH_TRANSITION,
  whatsAppTemplateButtonReplyMatchesSourceHandle,
} from "@/lib/scenarios/transition-registry";
import {
  buildPostActionLocationRouteHandleId,
  buildScenarioActionOutcomeHandleId,
  buildWhatsAppSessionChoicePayload,
  buildWhatsAppSessionChoiceSourceHandleId,
  GENERATIVE_AI_FAILURE_HANDLE,
  GENERATIVE_AI_SUCCESS_HANDLE,
  getPostActionAnswerMatchHandleId,
  getPostActionConditionHandleId,
  POST_ACTION_LOCATION_ANY_OFFICE_HANDLE_ID,
  POST_ACTION_LOCATION_OUTSIDE_HANDLE_ID,
  PROMPT_INPUTS_UNMET_HANDLE,
  type ScenarioNodeData,
} from "@icecore/scenario-contracts";

function action(patch: Partial<ScenarioNodeData>): ScenarioNodeData {
  return { kind: "action", actionType: "reply", ...patch };
}

describe("Generative AI fixed output transition", () => {
  const generative = action({
    actionType: "generative_ai",
    actionGenerativeAIConfig: {
      version: 1,
      mode: "text_to_video",
      prompt: "Create a product launch video",
    },
  });

  it("registers exactly the fixed Success and Failure handles", () => {
    expect(
      GENERATIVE_AI_OUTPUT_TRANSITION.getSourceHandleIds(generative)
    ).toEqual([GENERATIVE_AI_SUCCESS_HANDLE, GENERATIVE_AI_FAILURE_HANDLE]);
    expect(
      getScenarioActionOutputTransitionForSourceHandle(
        generative,
        GENERATIVE_AI_SUCCESS_HANDLE
      )
    ).toBe(GENERATIVE_AI_OUTPUT_TRANSITION);
    expect(
      getScenarioActionOutputTransitionForSourceHandle(
        generative,
        "right-source-generative-ai::completed"
      )
    ).toBeNull();
  });

  it("does not claim ordinary reply action handles", () => {
    expect(
      GENERATIVE_AI_OUTPUT_TRANSITION.getSourceHandleIds(
        action({ actionType: "reply" })
      )
    ).toEqual([]);
  });
});

describe("prompt input unmet transition", () => {
  const ask = action({
    actionWhatsAppServiceMessage: {
      version: 1,
      message: {
        kind: "text",
        body: { mode: "fixed", text: "Tell me your name." },
        previewUrl: false,
      },
      promptInputs: [{ key: "name", label: "Name", prompt: "customer name" }],
    },
  });

  it("limits the unmet handle to one target without replacing the default edge", () => {
    expect(
      getScenarioActionOutputTransitionForSourceHandle(
        ask,
        PROMPT_INPUTS_UNMET_HANDLE
      )
    ).toBe(PROMPT_INPUTS_UNMET_OUTPUT_TRANSITION);
    expect(
      getScenarioActionOutputTransitionForSourceHandle(ask, "right-source")
    ).toBeNull();
  });
});

describe("WhatsApp service-message branch transition", () => {
  it("is the single registered transition for canonical service choices", () => {
    expect(SCENARIO_ACTION_BRANCH_TRANSITIONS).toContain(
      WHATSAPP_SERVICE_MESSAGE_BRANCH_TRANSITION
    );
    expect(
      SCENARIO_ACTION_BRANCH_TRANSITIONS.filter(
        descriptor => descriptor.kind === "whatsapp_service_message"
      )
    ).toHaveLength(1);
    expect(
      SCENARIO_ACTION_BRANCH_TRANSITIONS.some(
        descriptor => (descriptor.kind as string) === "whatsapp_session_choice"
      )
    ).toBe(false);

    const canonical = action({
      actionWhatsAppServiceMessage: {
        version: 1,
        message: {
          kind: "reply_buttons",
          body: { mode: "fixed", text: "Choose" },
          options: [{ id: "pricing", label: "Pricing" }],
        },
      },
    });
    expect(
      getScenarioActionBranchTransitionsForNode(canonical, "action-1")
    ).toEqual([WHATSAPP_SERVICE_MESSAGE_BRANCH_TRANSITION]);
  });

  it("extracts reply-button and list-row handles from stable option ids", () => {
    const pricingPayload = buildWhatsAppSessionChoicePayload({
      actionNodeId: "action-1",
      choiceId: "pricing",
    });
    const expected = {
      id: pricingPayload,
      label: "Pricing",
      sourceHandleId: buildWhatsAppSessionChoiceSourceHandleId(pricingPayload),
    };

    expect(
      WHATSAPP_SERVICE_MESSAGE_BRANCH_TRANSITION.extractOptions(
        action({
          actionWhatsAppServiceMessage: {
            version: 1,
            message: {
              kind: "reply_buttons",
              body: { mode: "fixed", text: "Choose" },
              options: [{ id: pricingPayload, label: "Pricing" }],
            },
          },
        }),
        "action-1"
      )
    ).toEqual([expected]);

    expect(
      WHATSAPP_SERVICE_MESSAGE_BRANCH_TRANSITION.extractOptions(
        action({
          actionWhatsAppServiceMessage: {
            version: 1,
            message: {
              kind: "list",
              body: { mode: "fixed", text: "Choose" },
              buttonLabel: "View",
              sections: [
                {
                  id: "plans",
                  rows: [{ id: pricingPayload, title: "Pricing" }],
                },
              ],
            },
          },
        }),
        "action-1"
      )
    ).toEqual([expected]);
  });

  it("extracts every carousel quick reply and ignores URL cards", () => {
    const node = action({
      actionWhatsAppServiceMessage: {
        version: 1,
        message: {
          kind: "media_carousel",
          body: { mode: "fixed", text: "Choose" },
          cards: [
            {
              id: "one",
              media: { url: "https://cdn.test/one.jpg", mediaType: "image" },
              interaction: {
                kind: "quick_replies",
                options: [
                  {
                    id: buildWhatsAppSessionChoicePayload({
                      actionNodeId: "action-1",
                      choiceId: "one-details",
                    }),
                    label: "Details",
                  },
                ],
              },
            },
            {
              id: "two",
              media: { url: "https://cdn.test/two.jpg", mediaType: "image" },
              interaction: {
                kind: "quick_replies",
                options: [
                  {
                    id: buildWhatsAppSessionChoicePayload({
                      actionNodeId: "action-1",
                      choiceId: "two-details",
                    }),
                    label: "Details",
                  },
                ],
              },
            },
          ],
        },
      },
    });

    expect(
      WHATSAPP_SERVICE_MESSAGE_BRANCH_TRANSITION.extractOptions(
        node,
        "action-1"
      ).map(option => option.id)
    ).toEqual([
      buildWhatsAppSessionChoicePayload({
        actionNodeId: "action-1",
        choiceId: "one-details",
      }),
      buildWhatsAppSessionChoicePayload({
        actionNodeId: "action-1",
        choiceId: "two-details",
      }),
    ]);
  });

  it("keeps canonical Flow and template buttons on their existing transitions", () => {
    const canonicalFlow = action({
      actionWhatsAppServiceMessage: {
        version: 1,
        message: {
          kind: "flow",
          body: { mode: "fixed", text: "Open" },
          flowConfig: {
            templateId: "flow-1",
            ctaText: "Open",
            metaFlowId: "flow-1",
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
        },
      },
    });
    const template: ScenarioNodeData = {
      kind: "action",
      actionType: "whatsapp_template",
      actionWhatsAppTemplateComponents: [
        { type: "BODY", text: "Choose" },
        {
          type: "BUTTONS",
          buttons: [{ type: "QUICK_REPLY", text: "Yes" }],
        },
      ],
    };

    expect(
      getScenarioActionBranchTransitionsForNode(canonicalFlow, "action-1")
    ).toEqual([FLOW_BRANCH_TRANSITION]);
    expect(
      getScenarioActionBranchTransitionsForNode(template, "action-1")
    ).toEqual([WHATSAPP_TEMPLATE_BUTTON_BRANCH_TRANSITION]);
  });
});

describe("post-action answer-match branches", () => {
  const answer = getPostActionAnswerMatchHandleId("yes");

  it("keep the No reply timer descriptor they belong to", () => {
    expect(getPostActionConditionBranchTransitionByHandle(answer)).toBe(
      getPostActionConditionBranchTransitionByHandle(
        getPostActionConditionHandleId("no_reply_timeout")
      )
    );
  });

  it("accept the claimed reply that matched them, not other replies", () => {
    expect(
      postActionConditionBranchHandleMatchesEvent(
        answer,
        "post_action_user_reply"
      )
    ).toBe(true);
    expect(
      postActionConditionBranchHandleMatchesEvent(
        answer,
        "no_human_reply_timeout"
      )
    ).toBe(true);
    for (const eventKind of [
      "inbound_message",
      "whatsapp_button_reply",
      "payment_detected",
    ]) {
      expect(
        postActionConditionBranchHandleMatchesEvent(answer, eventKind)
      ).toBe(false);
    }
    // The No reply branch itself still accepts only its timer.
    expect(
      postActionConditionBranchHandleMatchesEvent(
        getPostActionConditionHandleId("no_reply_timeout"),
        "post_action_user_reply"
      )
    ).toBe(false);
  });
});

describe("post-action location route branches", () => {
  const locationHandles = [
    buildPostActionLocationRouteHandleId("kz"),
    POST_ACTION_LOCATION_ANY_OFFICE_HANDLE_ID,
    POST_ACTION_LOCATION_OUTSIDE_HANDLE_ID,
  ];

  it.each(locationHandles)("%s keeps the No reply timer descriptor", handle => {
    expect(getPostActionConditionBranchTransitionByHandle(handle)).toBe(
      getPostActionConditionBranchTransitionByHandle(
        getPostActionConditionHandleId("no_reply_timeout")
      )
    );
  });

  it.each(locationHandles)(
    "%s accepts a claimed share and the timer, not typed text",
    handle => {
      expect(
        postActionConditionBranchHandleMatchesEvent(
          handle,
          "post_action_user_reply"
        )
      ).toBe(true);
      expect(
        postActionConditionBranchHandleMatchesEvent(
          handle,
          "no_human_reply_timeout"
        )
      ).toBe(true);
      for (const eventKind of [
        "inbound_message",
        "whatsapp_button_reply",
        "payment_detected",
      ]) {
        expect(
          postActionConditionBranchHandleMatchesEvent(handle, eventKind)
        ).toBe(false);
      }
    }
  );

  it("doesn't read a step's own location handle as a wait branch", () => {
    expect(
      getPostActionConditionBranchTransitionByHandle(
        buildScenarioActionOutcomeHandleId({
          type: "location_route",
          routeId: "kz",
        })
      )
    ).toBeNull();
  });
});

describe("WhatsApp template reply-button branch transition", () => {
  const TEMPLATE = WHATSAPP_TEMPLATE_BUTTON_BRANCH_TRANSITION;
  const handle = (id: number) =>
    `right-source-whatsapp-template-button-branch::${id}`;
  const quickReply = (text: string) => ({
    type: "QUICK_REPLY" as const,
    text,
  });
  const seePlans = {
    type: "URL" as const,
    text: "See plans",
    url: "https://shop.test/plans",
  };
  function templateStep(
    buttons: Array<ReturnType<typeof quickReply> | typeof seePlans>,
    buttonIds?: unknown
  ): ScenarioNodeData {
    return action({
      actionType: "whatsapp_template",
      actionWhatsAppTemplateComponents: [
        { type: "BODY", text: "Which plan do you want?" },
        { type: "BUTTONS", buttons },
      ],
      ...(buttonIds === undefined
        ? {}
        : {
            actionWhatsAppTemplateButtonIds:
              buttonIds as ScenarioNodeData["actionWhatsAppTemplateButtonIds"],
          }),
    });
  }
  const options = (nodeData: ScenarioNodeData) =>
    TEMPLATE.extractOptions(nodeData, "menu");

  it("keeps today's handles, payloads and stamps for a step without button ids", () => {
    const buttons = [seePlans, quickReply("Basic"), quickReply("Premium")];
    const unedited = options(templateStep(buttons));

    expect(unedited).toEqual([
      { id: "stb:menu:1", label: "Basic", sourceHandleId: handle(1) },
      { id: "stb:menu:2", label: "Premium", sourceHandleId: handle(2) },
    ]);
    expect(TEMPLATE.makeBranchNodeData(unedited[1])).toEqual({
      whatsAppTemplateButtonPayload: "stb:menu:2",
      whatsAppTemplateButtonLabel: "Premium",
    });
    // The first save that writes ids freezes the positions, so nothing moves.
    expect(
      options(
        templateStep(buttons, {
          version: 1,
          nextId: 10,
          buttons: [
            { id: 1, index: 1, text: "Basic" },
            { id: 2, index: 2, text: "Premium" },
          ],
        })
      )
    ).toEqual(unedited);
  });

  it("keys each route by the button's id once the step has ids", () => {
    // Basic was removed from [Basic, Premium] and Gold was added.
    const branchOptions = options(
      templateStep([quickReply("Premium"), quickReply("Gold")], {
        version: 1,
        nextId: 11,
        buttons: [
          { id: 1, index: 0, text: "Premium" },
          { id: 10, index: 1, text: "Gold" },
        ],
      })
    );

    expect(branchOptions).toEqual([
      { id: "stb:menu:1", label: "Premium", sourceHandleId: handle(1) },
      { id: "stb:menu:10", label: "Gold", sourceHandleId: handle(10) },
    ]);
    expect(
      TEMPLATE.resolveBranchIdFromSourceHandle(handle(1), branchOptions)
    ).toBe("stb:menu:1");
    expect(
      TEMPLATE.resolveBranchIdFromSourceHandle(handle(0), branchOptions)
    ).toBeNull();
    expect(TEMPLATE.matchesSourceHandle(handle(0), branchOptions)).toBe(false);
    expect(TEMPLATE.matchesSourceHandle(handle(10), branchOptions)).toBe(true);
  });

  it("offers no route for a step whose button ids cannot be read", () => {
    expect(
      options(templateStep([quickReply("Basic")], { version: 2, buttons: [] }))
    ).toEqual([]);
  });

  it("matches a tap to its route by button id, including taps sent before the step had ids", () => {
    const matches = (sourceHandleId: string, quickReplyPayload: string) =>
      whatsAppTemplateButtonReplyMatchesSourceHandle({
        sourceActionNodeId: "menu",
        sourceHandleId,
        quickReplyPayload,
      });

    expect(matches(handle(1), "stb:menu:1")).toBe(true);
    expect(matches(handle(10), "stb:menu:10")).toBe(true);
    expect(matches(handle(1), "stb:menu:0")).toBe(false);
    expect(matches(handle(1), "stb:other:1")).toBe(false);
  });
});
