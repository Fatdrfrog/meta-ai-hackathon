import {
  ACTION_ANY_REPLY_OUTCOME_HANDLE_ID,
  ACTION_NO_REPLY_OUTCOME_HANDLE_ID,
  ACTION_PAYMENT_OUTCOME_HANDLE_ID,
  ACTION_WHATSAPP_TEMPLATE_FORM_SUBMITTED_HANDLE_ID,
  buildScenarioActionAnswerOutcomeHandleId,
  type ScenarioNodeData,
} from "@icecore/scenario-contracts";
import { whatsappTemplateOffersFormSubmittedRoute } from "../transition-registry";
import {
  resolveScenarioActionDefaultRouteBlocker,
  scenarioActionDefaultRouteCannotRun,
  scenarioActionUsesInstagramBranchHandles,
  scenarioActionUsesInteractiveBranchHandles,
  scenarioActionUsesTelegramBranchHandles,
  scenarioActionUsesWhatsAppFlowBranchHandles,
  scenarioActionUsesWhatsAppServiceMessageBranchHandles,
  scenarioActionUsesWhatsAppTemplateButtonBranchHandles,
} from "../branch-handle-predicates";

describe("branch handle predicates", () => {
  const baseAction = {
    kind: "action",
  } satisfies Partial<ScenarioNodeData>;

  it("detects telegram branch handles", () => {
    expect(
      scenarioActionUsesTelegramBranchHandles({
        ...baseAction,
        actionType: "reply",
        actionReplyChannel: "telegram",
        actionTelegramQuickReplies: [[{ text: "Yes", payload: "yes" }]],
      } as ScenarioNodeData)
    ).toBe(true);
  });

  it("detects instagram branch handles", () => {
    expect(
      scenarioActionUsesInstagramBranchHandles({
        ...baseAction,
        actionType: "reply",
        actionReplyChannel: "instagram",
        actionInstagramConfig: {
          kind: "quick_replies",
          quickReplies: [{ title: "Help", payload: "help" }],
        },
      } as ScenarioNodeData)
    ).toBe(true);
  });

  it("detects canonical WhatsApp reply-button branch handles", () => {
    expect(
      scenarioActionUsesWhatsAppServiceMessageBranchHandles({
        ...baseAction,
        actionType: "reply",
        actionReplyChannel: "whatsapp",
        actionWhatsAppServiceMessage: {
          version: 1,
          message: {
            kind: "reply_buttons",
            body: { mode: "fixed", text: "Choose" },
            options: [{ id: "one", label: "One" }],
          },
        },
      } as ScenarioNodeData)
    ).toBe(true);
  });

  it("returns false for reply actions without branch options", () => {
    expect(
      scenarioActionUsesTelegramBranchHandles({
        ...baseAction,
        actionType: "reply",
        actionReplyChannel: "telegram",
      } as ScenarioNodeData)
    ).toBe(false);

    expect(
      scenarioActionUsesWhatsAppTemplateButtonBranchHandles({
        ...baseAction,
        actionType: "whatsapp_template",
      } as ScenarioNodeData)
    ).toBe(false);
  });

  it.each([
    [
      "Telegram quick replies",
      true,
      {
        actionType: "reply",
        actionReplyChannel: "telegram",
        actionTelegramQuickReplies: [[{ text: "Yes", payload: "yes" }]],
      },
    ],
    [
      "Instagram quick replies",
      true,
      {
        actionType: "reply",
        actionReplyChannel: "instagram",
        actionInstagramConfig: {
          kind: "quick_replies",
          quickReplies: [{ title: "Help", payload: "help" }],
        },
      },
    ],
    [
      "WhatsApp reply buttons",
      true,
      {
        actionType: "reply",
        actionWhatsAppServiceMessage: {
          version: 1,
          message: {
            kind: "reply_buttons",
            body: { mode: "fixed", text: "Choose" },
            options: [{ id: "one", label: "One" }],
          },
        },
      },
    ],
    [
      "WhatsApp template quick-reply buttons",
      true,
      {
        actionType: "whatsapp_template",
        actionWhatsAppTemplateComponents: [
          { type: "BUTTONS", buttons: [{ type: "QUICK_REPLY", text: "Yes" }] },
        ],
      },
    ],
    [
      "a WhatsApp template with only a website button",
      false,
      {
        actionType: "whatsapp_template",
        actionWhatsAppTemplateComponents: [
          {
            type: "BUTTONS",
            buttons: [
              { type: "URL", text: "Website", url: "https://example.com" },
            ],
          },
        ],
      },
    ],
    [
      "a WhatsApp Flow without choice fields",
      false,
      {
        actionType: "reply",
        actionWhatsAppServiceMessage: {
          version: 1,
          message: {
            kind: "flow",
            body: { mode: "fixed", text: "Open" },
            flowConfig: {
              templateId: "flow-1",
              ctaText: "Open",
              screens: [
                {
                  id: "SCREEN_A",
                  title: "Screen",
                  fields: [
                    { id: "name", label: "Name", fieldType: "TextInput" },
                  ],
                },
              ],
            },
          },
        },
      },
    ],
    ["a plain reply", false, { actionType: "reply", actionReplyText: "Hi" }],
  ])("treats %s as interactive: %s", (_, expected, nodeData) => {
    expect(
      scenarioActionUsesInteractiveBranchHandles({
        ...baseAction,
        ...nodeData,
      } as ScenarioNodeData)
    ).toBe(expected);
  });

  it("detects whatsapp flow branch handles", () => {
    expect(
      scenarioActionUsesWhatsAppFlowBranchHandles({
        ...baseAction,
        actionType: "reply",
        actionReplyChannel: "whatsapp",
        actionWhatsAppServiceMessage: {
          version: 1,
          message: {
            kind: "flow",
            body: { mode: "fixed", text: "Open" },
            flowConfig: {
              templateId: "flow-1",
              ctaText: "Open",
              screens: [
                {
                  id: "SCREEN_A",
                  title: "Screen",
                  fields: [
                    {
                      id: "field-1",
                      label: "Choose",
                      fieldType: "RadioButtonsGroup",
                      options: [{ id: "opt-1", title: "One" }],
                    },
                  ],
                },
              ],
            },
          },
        },
      })
    ).toBe(true);
  });
});

describe("scenarioActionDefaultRouteCannotRun", () => {
  const NO_REPLY = { noReply: { enabled: true, timeoutMinutes: 30 } };
  const ANY_REPLY = { anyReply: { enabled: true } };
  const textFlowConfig = {
    templateId: "flow-1",
    ctaText: "Open",
    screens: [
      {
        id: "SCREEN_A",
        title: "Form",
        fields: [{ id: "name", label: "Name", fieldType: "TextInput" }],
      },
    ],
  };
  const serviceMessage = (
    message: Record<string, unknown>,
    extra: Record<string, unknown> = {}
  ) => ({
    actionType: "reply",
    actionReplyChannel: "whatsapp",
    actionWhatsAppServiceMessage: { version: 1, message, ...extra },
  });
  const serviceText = (extra: Record<string, unknown> = {}) =>
    serviceMessage(
      { kind: "text", body: { mode: "fixed", text: "Write to us" } },
      extra
    );
  const flowTemplate = (
    quickReplies: boolean,
    extra: Record<string, unknown> = {}
  ) => ({
    actionType: "whatsapp_template",
    actionWhatsAppTemplateName: "form",
    actionWhatsAppTemplateComponents: [
      { type: "BODY", text: "Fill" },
      {
        type: "BUTTONS",
        buttons: [
          ...(quickReplies
            ? [
                { type: "QUICK_REPLY", text: "Yes" },
                { type: "QUICK_REPLY", text: "No" },
              ]
            : []),
          { type: "FLOW", text: "Open", flow_id: "meta-flow-1" },
        ],
      },
    ],
    actionReplyCtaType: "flow",
    ...extra,
  });

  function cannotRun(
    data: Record<string, unknown>,
    outcomes: Record<string, unknown> | undefined,
    sourceHandleIds: readonly (string | null | undefined)[]
  ): boolean {
    return scenarioActionDefaultRouteCannotRun({
      nodeId: "action-1",
      nodeData: {
        kind: "action",
        ...data,
        ...(outcomes ? { actionOutcomes: { version: 1, ...outcomes } } : {}),
      } as ScenarioNodeData,
      sourceHandleIds,
    });
  }

  it.each<[string, Record<string, unknown>]>([
    [
      "a plain reply (Then)",
      { actionType: "reply", actionReplyMode: "fixed", actionReplyText: "Hi" },
    ],
    [
      "a template without buttons (Then)",
      {
        actionType: "whatsapp_template",
        actionWhatsAppTemplateName: "hello",
        actionWhatsAppTemplateComponents: [{ type: "BODY", text: "Hi" }],
      },
    ],
    ["a WhatsApp chat message (Reply)", serviceText()],
    [
      "a template with quick replies (Other reply)",
      {
        actionType: "whatsapp_template",
        actionWhatsAppTemplateName: "pick",
        actionWhatsAppTemplateComponents: [
          { type: "BODY", text: "Pick" },
          {
            type: "BUTTONS",
            buttons: [
              { type: "QUICK_REPLY", text: "Yes" },
              { type: "QUICK_REPLY", text: "No" },
            ],
          },
        ],
      },
    ],
    [
      "a Telegram reply without quick replies (Then)",
      {
        actionType: "reply",
        actionReplyChannel: "telegram",
        actionReplyMode: "fixed",
        actionReplyText: "Hi",
      },
    ],
    [
      "an Instagram reply without quick replies (Then)",
      {
        actionType: "reply",
        actionReplyChannel: "instagram",
        actionReplyMode: "fixed",
        actionReplyText: "Hi",
      },
    ],
  ])("%s can't continue on its default route", (_label, data) => {
    expect(cannotRun(data, NO_REPLY, [ACTION_NO_REPLY_OUTCOME_HANDLE_ID])).toBe(
      true
    );
    expect(
      cannotRun(data, ANY_REPLY, [
        ACTION_ANY_REPLY_OUTCOME_HANDLE_ID,
        "right-source",
      ])
    ).toBe(true);
    expect(
      cannotRun(
        data,
        { answerMatches: [{ id: "yes", text: "Yes", mode: "exact" }] },
        [buildScenarioActionAnswerOutcomeHandleId("yes")]
      )
    ).toBe(true);
    expect(
      cannotRun(data, { paymentDetected: { enabled: true } }, [
        ACTION_PAYMENT_OUTCOME_HANDLE_ID,
      ])
    ).toBe(true);
  });

  it.each<[string, Record<string, unknown>]>([
    [
      "Form submitted on a chat-message Flow",
      serviceMessage({
        kind: "flow",
        body: { mode: "fixed", text: "Open the form" },
        flowConfig: textFlowConfig,
      }),
    ],
    [
      "a template whose button opens a Flow",
      flowTemplate(false, {
        actionReplyCtaFlowId: "meta-flow-1",
        actionFlowConfig: { ...textFlowConfig, metaFlowId: "meta-flow-1" },
      }),
    ],
    [
      "a template that keeps only a legacy Flow id",
      flowTemplate(false, { actionReplyCtaFlowId: "meta-flow-1" }),
    ],
    [
      "a template with quick replies and a Flow button",
      flowTemplate(true, {
        actionReplyCtaFlowId: "meta-flow-1",
        actionFlowConfig: { ...textFlowConfig, metaFlowId: "meta-flow-1" },
      }),
    ],
    [
      "Details collected on a text ask",
      serviceText({
        promptInputs: [{ key: "name", label: "Name", prompt: "Your name" }],
      }),
    ],
    [
      "a choice ask",
      serviceMessage(
        {
          kind: "reply_buttons",
          body: { mode: "fixed", text: "Pick one" },
          options: [
            { id: "wsc:action-1:one", label: "One" },
            { id: "wsc:action-1:two", label: "Two" },
          ],
        },
        { promptInputs: [{ key: "name", label: "Name", prompt: "Your name" }] }
      ),
    ],
  ])("%s keeps its default route past the wait", (_label, data) => {
    expect(cannotRun(data, NO_REPLY, [ACTION_NO_REPLY_OUTCOME_HANDLE_ID])).toBe(
      false
    );
  });

  it("arms only for a linked outcome, as the compiler does", () => {
    expect(cannotRun(serviceText(), NO_REPLY, [])).toBe(false);
    expect(
      cannotRun(serviceText(), NO_REPLY, ["right-source", null, "", undefined])
    ).toBe(false);
  });

  it("needs outcomes this version can read", () => {
    expect(
      cannotRun(serviceText(), undefined, [ACTION_NO_REPLY_OUTCOME_HANDLE_ID])
    ).toBe(false);
    expect(
      cannotRun(
        {
          ...serviceText(),
          // Version 2 carries location routes; 3 is still unreadable.
          actionOutcomes: { version: 3, ...NO_REPLY },
        },
        undefined,
        [ACTION_NO_REPLY_OUTCOME_HANDLE_ID]
      )
    ).toBe(false);
  });

  it.each<[string, Record<string, unknown>]>([
    [
      "Generative AI",
      {
        actionType: "generative_ai",
        actionGenerativeAIConfig: {
          version: 1,
          mode: "text_to_image",
          prompt: "Poster",
        },
      },
    ],
    ["End scenario", { actionType: "end_scenario" }],
    [
      "WhatsApp reply buttons",
      serviceMessage({
        kind: "reply_buttons",
        body: { mode: "fixed", text: "Pick" },
        options: [
          { id: "wsc:action-1:yes", label: "Yes" },
          { id: "wsc:action-1:no", label: "No" },
        ],
      }),
    ],
    [
      "Telegram quick replies",
      {
        actionType: "reply",
        actionReplyChannel: "telegram",
        actionReplyMode: "fixed",
        actionReplyText: "Pick",
        actionTelegramQuickReplies: [[{ text: "Yes", payload: "yes" }]],
      },
    ],
  ])("never flags %s", (_label, data) => {
    expect(cannotRun(data, NO_REPLY, [ACTION_NO_REPLY_OUTCOME_HANDLE_ID])).toBe(
      false
    );
  });

  describe("a template's linked Form submitted route", () => {
    const FORM_SUBMITTED = ACTION_WHATSAPP_TEMPLATE_FORM_SUBMITTED_HANDLE_ID;
    const NO_REPLY_HANDLE = ACTION_NO_REPLY_OUTCOME_HANDLE_ID;
    const linkedFlow = {
      actionReplyCtaFlowId: "meta-flow-1",
      actionFlowConfig: { ...textFlowConfig, metaFlowId: "meta-flow-1" },
    };
    const radioFlow = {
      actionReplyCtaFlowId: "meta-flow-1",
      actionFlowConfig: {
        ...textFlowConfig,
        metaFlowId: "meta-flow-1",
        screens: [
          {
            id: "SCREEN_A",
            title: "Form",
            fields: [
              {
                id: "pick",
                label: "Pick",
                fieldType: "RadioButtonsGroup",
                options: [{ id: "one", title: "One" }],
              },
            ],
          },
        ],
      },
    };

    function blocker(
      data: Record<string, unknown>,
      outcomes: Record<string, unknown> | undefined,
      sourceHandleIds: readonly string[]
    ) {
      return resolveScenarioActionDefaultRouteBlocker({
        nodeId: "action-1",
        nodeData: {
          kind: "action",
          ...data,
          ...(outcomes ? { actionOutcomes: { version: 1, ...outcomes } } : {}),
        } as ScenarioNodeData,
        sourceHandleIds,
      });
    }

    it.each<[string, Record<string, unknown>]>([
      ["a template whose one button opens a form", flowTemplate(false)],
      [
        "a template linked to its form's fields",
        flowTemplate(false, linkedFlow),
      ],
    ])("keeps Then of %s from running", (_label, data) => {
      expect(blocker(data, undefined, [FORM_SUBMITTED, "right-source"])).toBe(
        "form_submitted"
      );
      expect(blocker(data, undefined, [FORM_SUBMITTED])).toBe("form_submitted");
      // The route holds the step whether or not an outcome is linked.
      expect(blocker(data, NO_REPLY, [FORM_SUBMITTED, NO_REPLY_HANDLE])).toBe(
        "form_submitted"
      );
      expect(cannotRun(data, undefined, [FORM_SUBMITTED])).toBe(true);
    });

    it.each<[string, Record<string, unknown>, "outcomes" | null]>([
      ["a form-only template", flowTemplate(false), "outcomes"],
      ["a linked form-only template", flowTemplate(false, linkedFlow), null],
    ])(
      "leaves %s to the outcome rule while the route is unlinked",
      (_label, data, expected) => {
        expect(blocker(data, NO_REPLY, [NO_REPLY_HANDLE])).toBe(expected);
        expect(blocker(data, undefined, ["right-source"])).toBeNull();
      }
    );

    it.each<[string, Record<string, unknown>, "outcomes" | null]>([
      ["quick replies and a form button", flowTemplate(true), "outcomes"],
      [
        "quick replies and a linked form button",
        flowTemplate(true, linkedFlow),
        null,
      ],
      [
        "a form whose choices route on their own",
        flowTemplate(false, radioFlow),
        null,
      ],
    ])(
      "leaves a template with %s to the outcome rule",
      (_label, data, expected) => {
        for (const outcomes of [NO_REPLY, undefined]) {
          const withoutRoute = blocker(data, outcomes, [NO_REPLY_HANDLE]);
          expect(
            blocker(data, outcomes, [FORM_SUBMITTED, NO_REPLY_HANDLE])
          ).toBe(withoutRoute);
        }
        expect(blocker(data, NO_REPLY, [FORM_SUBMITTED, NO_REPLY_HANDLE])).toBe(
          expected
        );
      }
    );

    it("needs the template to offer the route", () => {
      expect(
        whatsappTemplateOffersFormSubmittedRoute({
          kind: "action",
          ...flowTemplate(false, radioFlow),
        } as ScenarioNodeData)
      ).toBe(false);
      expect(
        blocker(serviceText(), undefined, [FORM_SUBMITTED, "right-source"])
      ).toBeNull();
    });
  });
});
