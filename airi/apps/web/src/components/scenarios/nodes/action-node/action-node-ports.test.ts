import {
  ACTION_ANY_REPLY_OUTCOME_HANDLE_ID,
  ACTION_FLOW_BRANCH_OUTPUT_HANDLE_ID,
  ACTION_INSTAGRAM_BRANCH_OUTPUT_HANDLE_ID,
  ACTION_NO_REPLY_OUTCOME_HANDLE_ID,
  ACTION_PAYMENT_OUTCOME_HANDLE_ID,
  ACTION_TELEGRAM_BRANCH_OUTPUT_HANDLE_ID,
  ACTION_WHATSAPP_SESSION_CHOICE_BRANCH_OUTPUT_HANDLE_ID,
  ACTION_WHATSAPP_TEMPLATE_BUTTON_BRANCH_OUTPUT_HANDLE_ID,
  ACTION_WHATSAPP_TEMPLATE_FORM_SUBMITTED_HANDLE_ID,
  GENERATIVE_AI_FAILURE_HANDLE,
  GENERATIVE_AI_SUCCESS_HANDLE,
  PROMPT_INPUTS_UNMET_HANDLE,
  buildFlowBranchOptionKey,
  buildFlowBranchSourceHandleId,
  buildScenarioActionAnswerOutcomeHandleId,
  buildTelegramBranchSourceHandleId,
  buildWhatsAppSessionChoiceSourceHandleId,
  buildWhatsAppTemplateButtonPayload,
  buildWhatsAppTemplateButtonSourceHandleId,
  type ScenarioActionOutcomes,
} from "@icecore/scenario-contracts";
import {
  ACTION_NODE_CARD_MAX_PORT_ROWS,
  isActionNodeOutcomePort,
  resolveActionNodePorts,
  splitActionNodeCardRows,
  type ActionNodePort,
  type ActionNodePorts,
} from "./action-node-ports";
import {
  availableSourceHandlesFor,
  createActionEditorTestData,
  testCarouselCards,
  testChoiceHandle,
  testChoiceId,
  testFlowConfig,
  type ActionNodeTestData,
} from "./action-node-test-utils";

const t = (key: string, values?: Record<string, string | number | Date>) =>
  values ? `${key}:${JSON.stringify(values)}` : key;
const quietPeriod = (unit: "minutes" | "hours" | "days", count: number) =>
  t("noReplyDuration", { unit, count });
const quoted = (key: string, label: string) => t(key, { label });

const ACTION_ID = "action-1";
const YES_HANDLE = buildScenarioActionAnswerOutcomeHandleId("yes");
const PRICE_HANDLE = buildScenarioActionAnswerOutcomeHandleId("price");
const OUTCOMES: ScenarioActionOutcomes = {
  version: 1,
  anyReply: { enabled: true },
  noReply: { enabled: true, timeoutMinutes: 45 },
  answerMatches: [
    { id: "yes", text: "Yes", mode: "exact" },
    { id: "price", text: "", mode: "intent" },
  ],
  paymentDetected: { enabled: true },
};

function portsFor(data: ActionNodeTestData) {
  return resolveActionNodePorts({
    id: ACTION_ID,
    nodeData: createActionEditorTestData(data),
    t,
  });
}

const sorted = (values: readonly string[]) => [...values].sort();

/** Rows and hidden anchors together cover every handle connections accept. */
function expectEveryAcceptedHandle(data: ActionNodeTestData) {
  const ports = portsFor(data);
  expect(
    sorted([
      ...ports.ports.map(port => port.handleId),
      ...ports.hiddenAnchorIds,
    ])
  ).toEqual(sorted(availableSourceHandlesFor(data)));
  const ids = ports.ports.map(port => port.handleId);
  expect(new Set(ids).size).toBe(ids.length);
  return ports;
}

const cardLabel = (index: number, label: string) =>
  `whatsappTemplateBindingCard:${JSON.stringify({ index })} · ${label}`;
const serviceButton = (label: string) =>
  quoted("sourceHandleWhatsAppButton", label);
const rowSummary = (ports: ActionNodePorts) =>
  ports.ports.map(port => [
    port.handleId,
    port.kind,
    port.label,
    port.connected,
  ]);

describe("resolveActionNodePorts", () => {
  describe("matches the handles connections accept", () => {
    it.each<[string, ActionNodeTestData]>([
      [
        "an AI reply without outcomes",
        { kind: "action", actionType: "reply", actionReplyMode: "ai" },
      ],
      [
        "a fixed reply with every outcome",
        {
          kind: "action",
          actionType: "reply",
          actionReplyMode: "fixed",
          actionReplyText: "Hello",
          actionOutcomes: OUTCOMES,
        },
      ],
      [
        "a legacy WhatsApp reply with no reply and payment",
        {
          kind: "action",
          actionType: "reply",
          actionReplyChannel: "whatsapp",
          actionOutcomes: {
            version: 1,
            noReply: { enabled: true, timeoutMinutes: 30 },
            paymentDetected: { enabled: true },
          },
        },
      ],
      [
        "an email reply with an answer rule",
        {
          kind: "action",
          actionType: "reply",
          actionReplyChannel: "email",
          actionOutcomes: {
            version: 1,
            answerMatches: [{ id: "yes", text: "Yes", mode: "exact" }],
          },
        },
      ],
      [
        "a handoff",
        {
          kind: "action",
          actionType: "assign_human",
          actionInstruction: "Take over",
        },
      ],
      [
        "a handoff that kept outcomes from a reply",
        {
          kind: "action",
          actionType: "assign_human",
          actionOutcomes: OUTCOMES,
        },
      ],
      [
        "a Generative AI action",
        {
          kind: "action",
          actionType: "generative_ai",
          actionGenerativeAIConfig: {
            version: 1,
            mode: "text_to_video",
            prompt: "Launch clip",
          },
          // Generative AI routes only on Success and Failure.
          actionOutcomes: OUTCOMES,
        },
      ],
    ])("%s", (_label, data) => {
      const ports = portsFor(data);
      expect(ports.terminal).toBe(false);
      expect(sorted(ports.ports.map(port => port.handleId))).toEqual(
        sorted(availableSourceHandlesFor(data))
      );
      expect(ports.hiddenAnchorIds).toEqual([]);
    });

    it("gives End scenario no ports or anchors", () => {
      const data: ActionNodeTestData = {
        kind: "action",
        actionType: "end_scenario",
      };
      expect(portsFor(data)).toEqual({
        ports: [],
        hiddenAnchorIds: [],
        cornerAnchorIds: [],
        terminal: true,
        signature: "terminal",
      });
      // Connections still resolve the default output, but the compiler
      // rejects routes out of End scenario and its card has never rendered
      // an outgoing handle.
      expect(availableSourceHandlesFor(data)).toEqual(["right-source"]);
    });
  });

  it("lists the continuation, then outcomes, with labels and quiet periods", () => {
    const ports = portsFor({
      kind: "action",
      actionType: "reply",
      actionOutcomes: OUTCOMES,
    });
    expect(ports.ports).toEqual([
      {
        handleId: "right-source",
        kind: "continue",
        label: "actionPortNextStep",
        accessibleLabel: "actionPortNextStep",
        connected: false,
      },
      {
        handleId: ACTION_ANY_REPLY_OUTCOME_HANDLE_ID,
        kind: "any_reply",
        // Answer rules take their replies first.
        label: "actionOutcomeOtherReply",
        accessibleLabel: "actionOutcomeOtherReply",
        connected: false,
      },
      {
        handleId: ACTION_NO_REPLY_OUTCOME_HANDLE_ID,
        kind: "no_reply",
        label: "actionOutcomeNoReply",
        detail: quietPeriod("minutes", 45),
        accessibleLabel: `actionOutcomeNoReply · ${quietPeriod("minutes", 45)}`,
        connected: false,
      },
      {
        handleId: YES_HANDLE,
        kind: "answer",
        label: quoted("sourceHandleAnswerQuoted", "Yes"),
        accessibleLabel: quoted("sourceHandleConditionAnswerMatch", "Yes"),
        answerMode: "exact",
        connected: false,
      },
      {
        handleId: PRICE_HANDLE,
        kind: "answer",
        label: "sourceHandleConditionAnswerMatchAny",
        accessibleLabel: quoted(
          "sourceHandleConditionAnswerMeaning",
          "sourceHandleConditionAnswerMatchAny"
        ),
        answerMode: "intent",
        connected: false,
      },
      {
        handleId: ACTION_PAYMENT_OUTCOME_HANDLE_ID,
        kind: "payment_detected",
        label: "actionOutcomePayment",
        accessibleLabel: "actionOutcomePayment",
        connected: false,
      },
    ]);
  });

  it("writes the quiet period in the largest whole unit", () => {
    const detailFor = (timeoutMinutes: number) =>
      portsFor({
        kind: "action",
        actionType: "reply",
        actionOutcomes: {
          version: 1,
          noReply: { enabled: true, timeoutMinutes },
        },
      }).ports.find(port => port.kind === "no_reply")?.detail;
    expect(detailFor(120)).toBe(quietPeriod("hours", 2));
    expect(detailFor(2880)).toBe(quietPeriod("days", 2));
    expect(detailFor(90)).toBe(quietPeriod("minutes", 90));
  });

  it("marks linked ports and names their destination", () => {
    const ports = portsFor({
      kind: "action",
      actionType: "generative_ai",
      actionGenerativeAIConfig: {
        version: 1,
        mode: "text_to_image",
        prompt: "Poster",
      },
      uiConnections: {
        sourceHandleIds: [GENERATIVE_AI_SUCCESS_HANDLE],
        destinationsBySourceHandle: new Map([
          [GENERATIVE_AI_FAILURE_HANDLE, { nodeId: "sorry", label: "Sorry" }],
        ]),
      },
    });
    expect(ports.ports).toEqual([
      {
        handleId: GENERATIVE_AI_SUCCESS_HANDLE,
        kind: "success",
        label: "generativeAISuccess",
        accessibleLabel: "generativeAISuccess",
        connected: true,
      },
      {
        handleId: GENERATIVE_AI_FAILURE_HANDLE,
        kind: "failure",
        label: "generativeAIFailure",
        accessibleLabel: "generativeAIFailure",
        connected: true,
        destinationLabel: "Sorry",
      },
    ]);
  });

  it("changes the signature with the handles, not with labels", () => {
    const base: ActionNodeTestData = {
      kind: "action",
      actionType: "reply",
      actionOutcomes: {
        version: 1,
        answerMatches: [{ id: "yes", text: "Yes", mode: "exact" }],
      },
    };
    const renamed = portsFor({
      ...base,
      actionOutcomes: {
        version: 1,
        answerMatches: [{ id: "yes", text: "Sure", mode: "intent" }],
      },
    });
    const withPayment = portsFor({
      ...base,
      actionOutcomes: {
        ...base.actionOutcomes!,
        paymentDetected: { enabled: true },
      },
    });
    expect(renamed.signature).toBe(portsFor(base).signature);
    expect(withPayment.signature).not.toBe(portsFor(base).signature);
  });

  it("keeps every route when a card shows only its first rows", () => {
    const answerMatches = Array.from({ length: 8 }, (_, index) => ({
      id: `answer_${index}`,
      text: `Answer ${index}`,
      mode: "exact" as const,
    }));
    const ports = portsFor({
      kind: "action",
      actionType: "reply",
      actionOutcomes: { ...OUTCOMES, answerMatches },
    });
    // Continue, any reply, no reply, eight answers and payment.
    expect(ports.ports).toHaveLength(12);
    expect(ports.ports.length).toBeGreaterThan(ACTION_NODE_CARD_MAX_PORT_ROWS);
  });

  it("brings a route that can't run into view, so its notice can be acted on", () => {
    const buttons: ActionNodePort[] = Array.from(
      { length: ACTION_NODE_CARD_MAX_PORT_ROWS },
      (_, index) => ({
        handleId: `button-${index}`,
        kind: "branch",
        label: `Button ${index}`,
        accessibleLabel: `Button ${index}`,
        connected: true,
      })
    );
    const deadRoute: ActionNodePort = {
      handleId: "right-source",
      kind: "continue",
      label: "Other reply",
      accessibleLabel: "Other reply",
      connected: true,
      cannotRun: "outcomes",
    };

    const { rows, overflow } = splitActionNodeCardRows(
      [...buttons, deadRoute],
      false
    );

    expect(rows).toContain(deadRoute);
    expect(rows).toHaveLength(ACTION_NODE_CARD_MAX_PORT_ROWS);
    expect(overflow).toEqual([buttons[ACTION_NODE_CARD_MAX_PORT_ROWS - 1]]);
  });

  describe("builder actions", () => {
    it("gives each service-message choice a port and anchors the aggregate output", () => {
      const firstId = "wsc:action-1:one";
      const secondId = "wsc:action-1:two";
      const data: ActionNodeTestData = {
        kind: "action",
        actionType: "reply",
        actionWhatsAppServiceMessage: {
          version: 1,
          message: {
            kind: "reply_buttons",
            body: { mode: "fixed", text: "Choose" },
            options: [
              { id: firstId, label: "One" },
              { id: secondId, label: "Two" },
            ],
          },
        },
        actionOutcomes: {
          version: 1,
          anyReply: { enabled: true },
          noReply: { enabled: true, timeoutMinutes: 30 },
        },
        uiConnections: { whatsAppChoicePayloads: [secondId] },
      };
      const ports = expectEveryAcceptedHandle(data);
      expect(ports.ports).toEqual([
        {
          handleId: buildWhatsAppSessionChoiceSourceHandleId(firstId),
          kind: "branch",
          label: "One",
          accessibleLabel: serviceButton("One"),
          optionKind: "button",
          connected: false,
        },
        {
          handleId: buildWhatsAppSessionChoiceSourceHandleId(secondId),
          kind: "branch",
          label: "Two",
          accessibleLabel: serviceButton("Two"),
          optionKind: "button",
          connected: true,
        },
        {
          handleId: ACTION_ANY_REPLY_OUTCOME_HANDLE_ID,
          kind: "any_reply",
          label: "actionOutcomeOtherReply",
          accessibleLabel: "actionOutcomeOtherReply",
          connected: false,
        },
        {
          handleId: ACTION_NO_REPLY_OUTCOME_HANDLE_ID,
          kind: "no_reply",
          label: "actionOutcomeNoReply",
          detail: quietPeriod("minutes", 30),
          accessibleLabel: `actionOutcomeNoReply · ${quietPeriod("minutes", 30)}`,
          connected: false,
        },
      ]);
      expect(ports.hiddenAnchorIds).toEqual([
        ACTION_WHATSAPP_SESSION_CHOICE_BRANCH_OUTPUT_HANDLE_ID,
      ]);
    });

    it("routes a detail ask on collected and missing details", () => {
      const data: ActionNodeTestData = {
        kind: "action",
        actionType: "reply",
        actionWhatsAppServiceMessage: {
          version: 1,
          message: { kind: "text", body: { mode: "fixed", text: "Name?" } },
          promptInputs: [{ key: "name", label: "Name", prompt: "Your name" }],
        },
      };
      const ports = portsFor(data);
      expect(
        ports.ports.map(port => [port.handleId, port.kind, port.label])
      ).toEqual([
        ["right-source", "continue", "whatsappServicePromptInputsMet"],
        [
          PROMPT_INPUTS_UNMET_HANDLE,
          "inputs_unmet",
          "whatsappServicePromptInputsUnmet",
        ],
      ]);
      expect(sorted(ports.ports.map(port => port.handleId))).toEqual(
        sorted(availableSourceHandlesFor(data))
      );
    });

    it("anchors the Telegram aggregate output behind its button ports", () => {
      const data: ActionNodeTestData = {
        kind: "action",
        actionType: "reply",
        actionReplyChannel: "telegram",
        actionTelegramQuickReplies: [[{ text: "Yes", payload: "yes" }]],
        uiConnections: { telegramPayloads: ["yes"] },
      };
      const ports = expectEveryAcceptedHandle(data);
      expect(ports.ports).toEqual([
        {
          handleId: buildTelegramBranchSourceHandleId("yes"),
          kind: "branch",
          label: "Yes",
          accessibleLabel: quoted("sourceHandleTelegramButton", "Yes"),
          optionKind: "button",
          // Activation needs every Telegram button linked.
          required: true,
          connected: true,
        },
      ]);
      expect(ports.hiddenAnchorIds).toEqual([
        ACTION_TELEGRAM_BRANCH_OUTPUT_HANDLE_ID,
      ]);
    });

    it("names reply buttons by label and never by their id", () => {
      const ports = expectEveryAcceptedHandle({
        kind: "action",
        actionType: "reply",
        actionWhatsAppServiceMessage: {
          version: 1,
          message: {
            kind: "reply_buttons",
            body: { mode: "fixed", text: "Choose" },
            options: [
              { id: testChoiceId("one"), label: "One" },
              { id: testChoiceId("draft"), label: "" },
            ],
          },
        },
      });
      expect(ports.ports.map(port => [port.handleId, port.label])).toEqual([
        [testChoiceHandle("one"), "One"],
        [testChoiceHandle("draft"), "untitledButton"],
      ]);
    });

    it("gives every list row a port named by its title", () => {
      const ports = expectEveryAcceptedHandle({
        kind: "action",
        actionType: "reply",
        actionWhatsAppServiceMessage: {
          version: 1,
          message: {
            kind: "list",
            body: { mode: "fixed", text: "Pick a row" },
            buttonLabel: "Menu",
            sections: [
              {
                id: "main",
                title: "Main",
                rows: [
                  {
                    id: testChoiceId("r1"),
                    title: "Delivery",
                    description: "1d",
                  },
                  { id: testChoiceId("r2"), title: "Pickup" },
                ],
              },
              {
                id: "other",
                title: "Other",
                rows: [{ id: testChoiceId("r3"), title: "Support" }],
              },
            ],
          },
        },
        uiConnections: { whatsAppChoicePayloads: [testChoiceId("r2")] },
      });
      expect(rowSummary(ports)).toEqual([
        [testChoiceHandle("r1"), "branch", "Delivery", false],
        [testChoiceHandle("r2"), "branch", "Pickup", true],
        [testChoiceHandle("r3"), "branch", "Support", false],
      ]);
    });

    it("gives each carousel card's choices a port that names the card", () => {
      const ports = expectEveryAcceptedHandle({
        kind: "action",
        actionType: "reply",
        actionWhatsAppServiceMessage: {
          version: 1,
          message: {
            kind: "media_carousel",
            body: { mode: "fixed", text: "Pick a model" },
            cards: testCarouselCards(["c1", "c2"]),
          },
        },
        uiConnections: {
          whatsAppChoicePayloads: [testChoiceId("c2-buy")],
          destinationsBySourceHandle: new Map([
            [
              testChoiceHandle("c2-buy"),
              { nodeId: "checkout", label: "Checkout" },
            ],
          ]),
        },
      });
      expect(ports.ports).toEqual(
        [
          { handleId: testChoiceHandle("c1-buy"), label: cardLabel(1, "Buy") },
          {
            handleId: testChoiceHandle("c1-info"),
            label: cardLabel(1, "Info"),
          },
          {
            handleId: testChoiceHandle("c2-buy"),
            label: cardLabel(2, "Buy"),
            connected: true,
            destinationLabel: "Checkout",
          },
          {
            handleId: testChoiceHandle("c2-info"),
            label: cardLabel(2, "Info"),
          },
        ].map(port => ({
          kind: "branch",
          accessibleLabel: serviceButton(port.label),
          optionKind: "button",
          connected: false,
          ...port,
        }))
      );
      expect(ports.hiddenAnchorIds).toEqual([
        ACTION_WHATSAPP_SESSION_CHOICE_BRANCH_OUTPUT_HANDLE_ID,
      ]);
    });

    it("keeps a template's saved quick replies, its default output and outcomes", () => {
      const data: ActionNodeTestData = {
        kind: "action",
        actionType: "whatsapp_template",
        actionWhatsAppTemplateName: "order_update",
        actionWhatsAppTemplateComponents: [
          { type: "BODY", text: "Hello" },
          {
            type: "BUTTONS",
            buttons: [
              { type: "QUICK_REPLY", text: "Track" },
              { type: "URL", text: "Site", url: "https://shop.test" },
              { type: "QUICK_REPLY", text: "Cancel" },
              // Not saved with a label yet: it offers no route.
              { type: "QUICK_REPLY", text: " " },
            ],
          },
        ],
        actionOutcomes: { version: 1, anyReply: { enabled: true } },
        uiConnections: {
          templateButtonPayloads: [
            buildWhatsAppTemplateButtonPayload(ACTION_ID, 2),
          ],
        },
      };
      const ports = expectEveryAcceptedHandle(data);
      expect(rowSummary(ports)).toEqual([
        [
          buildWhatsAppTemplateButtonSourceHandleId(0),
          "branch",
          "Track",
          false,
        ],
        [
          buildWhatsAppTemplateButtonSourceHandleId(2),
          "branch",
          "Cancel",
          true,
        ],
        [
          ACTION_ANY_REPLY_OUTCOME_HANDLE_ID,
          "any_reply",
          "actionOutcomeOtherReply",
          false,
        ],
      ]);
      // Other reply stands in for the unlinked default output.
      expect(ports.hiddenAnchorIds).toEqual([
        ACTION_WHATSAPP_TEMPLATE_BUTTON_BRANCH_OUTPUT_HANDLE_ID,
        "right-source",
      ]);
    });

    describe("a template's Form submitted route", () => {
      const FORM_SUBMITTED = ACTION_WHATSAPP_TEMPLATE_FORM_SUBMITTED_HANDLE_ID;
      // Meta returns DemoShop's Flow id as a number.
      const formButton = {
        type: "FLOW" as const,
        text: "Open form",
        flow_id: 1571793974235171,
      };
      const quickReply = { type: "QUICK_REPLY" as const, text: "Yes" };
      const template = (
        buttons: Array<typeof formButton | typeof quickReply>,
        extra: Partial<ActionNodeTestData> = {}
      ): ActionNodeTestData => ({
        kind: "action",
        actionType: "whatsapp_template",
        actionWhatsAppTemplateName: "demoshop_test",
        actionWhatsAppTemplateComponents: [
          { type: "BODY", text: "Tell us about the athlete" },
          { type: "BUTTONS", buttons },
        ],
        ...extra,
      });
      const formRow = (connected = false) => [
        FORM_SUBMITTED,
        "form_submitted",
        "serviceRouteFlowSubmitted",
        connected,
      ];

      it("gives the form its own row after the quick replies and before Then", () => {
        expect(
          rowSummary(expectEveryAcceptedHandle(template([formButton])))
        ).toEqual([
          formRow(),
          ["right-source", "continue", "actionPortNextStep", false],
        ]);
        const mixed = expectEveryAcceptedHandle(
          template([quickReply, formButton])
        );
        expect(rowSummary(mixed)).toEqual([
          [
            buildWhatsAppTemplateButtonSourceHandleId(0),
            "branch",
            "Yes",
            false,
          ],
          formRow(),
          ["right-source", "continue", "sourceHandleAnyUserReply", false],
        ]);
        const port = mixed.ports.find(item => item.handleId === FORM_SUBMITTED);
        expect(port?.accessibleLabel).toBe("serviceRouteFlowSubmitted");
        // The step can be activated without it.
        expect(port?.required).toBeUndefined();
        expect(isActionNodeOutcomePort(port!)).toBe(false);
      });

      it("names the next step of a linked route", () => {
        const ports = portsFor(
          template([formButton], {
            uiConnections: {
              sourceHandleIds: [FORM_SUBMITTED],
              destinationsBySourceHandle: new Map([
                [FORM_SUBMITTED, { nodeId: "carousel", label: "Carousel" }],
              ]),
            },
          })
        );
        expect(ports.ports[0]).toMatchObject({
          handleId: FORM_SUBMITTED,
          connected: true,
          destinationLabel: "Carousel",
        });
      });

      it("keeps only an anchor on a bulk send's template", () => {
        const ports = expectEveryAcceptedHandle(
          template([formButton], { uiBulkPrimaryWhatsAppTemplate: true })
        );
        expect(ports.ports.map(port => port.handleId)).toEqual([
          "right-source",
        ]);
        expect(ports.hiddenAnchorIds).toEqual([FORM_SUBMITTED]);
      });

      it("anchors a saved route the template no longer offers, and nothing else", () => {
        const stale = portsFor(
          template([quickReply], {
            uiConnections: { sourceHandleIds: [FORM_SUBMITTED] },
          })
        );
        expect(stale.ports.map(port => port.handleId)).not.toContain(
          FORM_SUBMITTED
        );
        expect(stale.hiddenAnchorIds).toContain(FORM_SUBMITTED);

        // A form whose choices route on their own offers no such route.
        const flowChoices = portsFor(
          template([formButton], {
            actionReplyCtaType: "flow",
            actionFlowConfig: {
              ...testFlowConfig(),
              metaFlowId: "1571793974235171",
            },
          })
        );
        expect([
          ...flowChoices.ports.map(port => port.handleId),
          ...flowChoices.hiddenAnchorIds,
        ]).not.toContain(FORM_SUBMITTED);
      });

      // Mid right edge, the anchor of a stale route sat on the first quick
      // reply's dot, so its edge passed for that button's route.
      it("puts the anchor of a route with no row on the top right corner and says why it can't run", () => {
        const linked = { uiConnections: { sourceHandleIds: [FORM_SUBMITTED] } };
        // Connections no longer accept it; only its saved edge needs it.
        const stale = portsFor(
          template([quickReply, { type: "QUICK_REPLY", text: "No" }], linked)
        );
        expect(rowSummary(stale).map(([handleId]) => handleId)).toEqual([
          buildWhatsAppTemplateButtonSourceHandleId(0),
          buildWhatsAppTemplateButtonSourceHandleId(1),
          "right-source",
        ]);
        expect(stale.cornerAnchorIds).toEqual([FORM_SUBMITTED]);
        expect(stale.anchoredRouteError).toBe(
          "whatsappTemplateFormRouteUnavailable"
        );

        const bulk = expectEveryAcceptedHandle(
          template([quickReply, formButton], {
            ...linked,
            uiBulkPrimaryWhatsAppTemplate: true,
          })
        );
        expect(bulk.cornerAnchorIds).toEqual([FORM_SUBMITTED]);
        expect(bulk.anchoredRouteError).toBe("whatsappTemplateFormRouteInBulk");

        // An unlinked anchor sits there too and needs no warning.
        const unlinkedBulk = portsFor(
          template([formButton], { uiBulkPrimaryWhatsAppTemplate: true })
        );
        expect(unlinkedBulk.cornerAnchorIds).toEqual([FORM_SUBMITTED]);
        expect(unlinkedBulk.anchoredRouteError).toBeUndefined();
        // A route with a row leaves from its dot.
        const offered = portsFor(template([quickReply, formButton], linked));
        expect(offered.cornerAnchorIds).toEqual([]);
        expect(offered.anchoredRouteError).toBeUndefined();
      });

      describe("while it is linked, Then can't run", () => {
        const routed = (
          buttons: Array<typeof formButton | typeof quickReply>,
          sourceHandleIds: string[],
          extra: Partial<ActionNodeTestData> = {}
        ) =>
          template(buttons, {
            ...extra,
            uiConnections: {
              sourceHandleIds: [FORM_SUBMITTED, ...sourceHandleIds],
            },
          });
        const continuePort = (ports: ActionNodePorts) =>
          ports.ports.find(port => port.kind === "continue");

        it("keeps only the anchor of an unlinked Then", () => {
          const ports = expectEveryAcceptedHandle(routed([formButton], []));
          expect(rowSummary(ports)).toEqual([formRow(true)]);
          expect(ports.hiddenAnchorIds).toEqual(["right-source"]);
        });

        it("flags a linked Then with the form's reason, outcomes or not", () => {
          const noReplyOn = {
            version: 1 as const,
            noReply: { enabled: true, timeoutMinutes: 30 },
          };
          for (const data of [
            routed([formButton], ["right-source"]),
            routed(
              [formButton],
              ["right-source", ACTION_NO_REPLY_OUTCOME_HANDLE_ID],
              { actionOutcomes: noReplyOn }
            ),
            // Legacy routing leaves outcomes alone, not the form's hold.
            routed(
              [formButton],
              ["right-source", ACTION_NO_REPLY_OUTCOME_HANDLE_ID],
              {
                actionOutcomes: noReplyOn,
                uiLegacyActionRouting: {
                  actionOutcomesSource: {
                    sourceNodeId: "condition",
                    sourceKind: "post_action_condition",
                  },
                },
              }
            ),
          ]) {
            const ports = expectEveryAcceptedHandle(data);
            expect(continuePort(ports)).toEqual({
              handleId: "right-source",
              kind: "continue",
              label: "actionPortNextStep",
              accessibleLabel: "actionPortNextStep",
              connected: true,
              cannotRun: "form_submitted",
            });
            expect(ports.hiddenAnchorIds).toEqual([]);
          }
        });

        it("keeps a Then the runtime still walks: into the follow-up wait, or on a saved step without the form", () => {
          const linkedThen = (extra: Partial<ActionNodeTestData>) =>
            continuePort(
              expectEveryAcceptedHandle(
                template([formButton], {
                  ...extra,
                  uiConnections: {
                    sourceHandleIds: [FORM_SUBMITTED, "right-source"],
                    ...extra.uiConnections,
                  },
                })
              )
            );
          const intoFollowUpWait = linkedThen({
            uiConnections: {
              sourceHandleIds: [FORM_SUBMITTED, "right-source"],
              destinationsBySourceHandle: new Map([
                [
                  "right-source",
                  {
                    nodeId: "quiet",
                    label: "No reply",
                    postActionCondition: true,
                  },
                ],
              ]),
            },
          });
          expect(intoFollowUpWait).toMatchObject({ connected: true });
          expect(intoFollowUpWait?.cannotRun).toBeUndefined();

          const savedWithoutForm = linkedThen({
            uiSavedStepOffersFormSubmittedRoute: false,
          });
          expect(savedWithoutForm).toMatchObject({ connected: true });
          expect(savedWithoutForm?.cannotRun).toBeUndefined();

          // Into a step, Then stays flagged.
          expect(
            linkedThen({
              uiConnections: {
                sourceHandleIds: [FORM_SUBMITTED, "right-source"],
                destinationsBySourceHandle: new Map([
                  ["right-source", { nodeId: "carousel", label: "Carousel" }],
                ]),
              },
            })?.cannotRun
          ).toBe("form_submitted");
        });

        it("leaves Other reply to quick replies, which already hold the step", () => {
          const port = continuePort(
            expectEveryAcceptedHandle(
              routed([quickReply, formButton], ["right-source"])
            )
          );
          expect(port).toMatchObject({
            label: "sourceHandleAnyUserReply",
            connected: true,
          });
          expect(port?.cannotRun).toBeUndefined();
        });
      });
    });

    it("gives each Flow choice a port and no default output", () => {
      const ports = expectEveryAcceptedHandle({
        kind: "action",
        actionType: "reply",
        actionWhatsAppServiceMessage: {
          version: 1,
          message: {
            kind: "flow",
            body: { mode: "fixed", text: "Open the form" },
            flowConfig: testFlowConfig([
              { id: "opt_1", title: "Yes" },
              { id: "opt_2", title: "" },
            ]),
          },
        },
        uiConnections: {
          flowBranchIds: [buildFlowBranchOptionKey("field_1", "opt_1")],
        },
      });
      expect(rowSummary(ports)).toEqual([
        [
          buildFlowBranchSourceHandleId("field_1", "opt_1"),
          "branch",
          "Yes",
          true,
        ],
        [
          buildFlowBranchSourceHandleId("field_1", "opt_2"),
          "branch",
          "untitledOption",
          false,
        ],
      ]);
      expect(ports.hiddenAnchorIds).toEqual([
        ACTION_FLOW_BRANCH_OUTPUT_HANDLE_ID,
      ]);
    });

    it("keeps Instagram replies on one shared row", () => {
      const ports = expectEveryAcceptedHandle({
        kind: "action",
        actionType: "reply",
        actionReplyChannel: "instagram",
        actionReplyMode: "fixed",
        actionReplyText: "Hi",
        actionInstagramConfig: {
          kind: "quick_replies",
          quickReplies: [
            { title: "Pricing", payload: "pricing" },
            { title: "Support", payload: "support" },
          ],
        },
        actionOutcomes: {
          version: 1,
          noReply: { enabled: true, timeoutMinutes: 60 },
        },
        uiConnections: { instagramPayloads: ["support"] },
      });
      expect(ports.ports).toEqual([
        {
          handleId: ACTION_INSTAGRAM_BRANCH_OUTPUT_HANDLE_ID,
          kind: "branch",
          label: "Pricing, Support",
          accessibleLabel: quoted(
            "sourceHandleInstagramButton",
            "Pricing, Support"
          ),
          optionKind: "button",
          required: true,
          connected: true,
        },
        {
          handleId: ACTION_NO_REPLY_OUTCOME_HANDLE_ID,
          kind: "no_reply",
          label: "actionOutcomeNoReply",
          detail: quietPeriod("hours", 1),
          accessibleLabel: `actionOutcomeNoReply · ${quietPeriod("hours", 1)}`,
          connected: false,
        },
      ]);
      expect(ports.hiddenAnchorIds).toEqual([]);
    });

    it("routes a choice ask on its options and the unmet route, with no default output", () => {
      const ports = expectEveryAcceptedHandle({
        kind: "action",
        actionType: "reply",
        actionWhatsAppServiceMessage: {
          version: 1,
          message: {
            kind: "reply_buttons",
            body: { mode: "fixed", text: "Pick one and tell us your name" },
            options: [
              { id: testChoiceId("one"), label: "One" },
              { id: testChoiceId("two"), label: "Two" },
            ],
          },
          promptInputs: [{ key: "name", label: "Name", prompt: "Your name" }],
        },
        uiConnections: { sourceHandleIds: [PROMPT_INPUTS_UNMET_HANDLE] },
      });
      expect(
        ports.ports.map(port => [port.handleId, port.kind, port.connected])
      ).toEqual([
        [testChoiceHandle("one"), "branch", false],
        [testChoiceHandle("two"), "branch", false],
        [PROMPT_INPUTS_UNMET_HANDLE, "inputs_unmet", true],
      ]);
    });
  });

  describe("route names", () => {
    const serviceText = (
      extra: Partial<ActionNodeTestData> = {}
    ): ActionNodeTestData => ({
      kind: "action",
      actionType: "reply",
      actionReplyChannel: "whatsapp",
      actionWhatsAppServiceMessage: {
        version: 1,
        message: { kind: "text", body: { mode: "fixed", text: "Hello" } },
      },
      ...extra,
    });
    const quickReplyTemplate = (
      extra: Partial<ActionNodeTestData> = {}
    ): ActionNodeTestData => ({
      kind: "action",
      actionType: "whatsapp_template",
      actionWhatsAppTemplateName: "order_update",
      actionWhatsAppTemplateComponents: [
        { type: "BODY", text: "Hello" },
        { type: "BUTTONS", buttons: [{ type: "QUICK_REPLY", text: "Track" }] },
      ],
      ...extra,
    });
    const continueLabel = (ports: ActionNodePorts) =>
      ports.ports.find(port => port.kind === "continue")?.label;

    it("names the default output Then, Reply or Form submitted", () => {
      expect(
        continueLabel(portsFor({ kind: "action", actionType: "reply" }))
      ).toBe("actionPortNextStep");
      expect(continueLabel(portsFor(serviceText()))).toBe(
        "serviceRouteNextMessage"
      );
      expect(
        continueLabel(
          portsFor({
            kind: "action",
            actionType: "reply",
            actionWhatsAppServiceMessage: {
              version: 1,
              message: {
                kind: "flow",
                body: { mode: "fixed", text: "Open the form" },
                flowConfig: { ...testFlowConfig(), screens: [] },
              },
            },
          })
        )
      ).toBe("serviceRouteFlowSubmitted");
    });

    it("drops an unlinked Reply row that Any reply stands in for and keeps its anchor", () => {
      const data = serviceText({
        actionOutcomes: { version: 1, anyReply: { enabled: true } },
      });
      const ports = expectEveryAcceptedHandle(data);
      expect(ports.ports.map(port => [port.kind, port.label])).toEqual([
        ["any_reply", "actionOutcomeAnyReply"],
      ]);
      expect(ports.hiddenAnchorIds).toEqual(["right-source"]);
    });

    it("names a linked default output Then beside Any reply, so no two rows share a name", () => {
      const ports = expectEveryAcceptedHandle(
        serviceText({
          actionOutcomes: { version: 1, anyReply: { enabled: true } },
          uiConnections: { sourceHandleIds: ["right-source"] },
        })
      );
      expect(
        ports.ports.map(port => [port.kind, port.label, port.connected])
      ).toEqual([
        ["continue", "actionPortNextStep", true],
        ["any_reply", "actionOutcomeAnyReply", false],
      ]);
      expect(ports.hiddenAnchorIds).toEqual([]);
    });

    it("keeps a template's linked default output and Other reply as two named rows", () => {
      const ports = expectEveryAcceptedHandle(
        quickReplyTemplate({
          actionOutcomes: { version: 1, anyReply: { enabled: true } },
          uiConnections: {
            sourceHandleIds: [
              "right-source",
              ACTION_ANY_REPLY_OUTCOME_HANDLE_ID,
            ],
          },
        })
      );
      // Other reply takes every reply, so the linked default can't run.
      expect(
        ports.ports
          .filter(port => port.kind !== "branch")
          .map(port => [port.kind, port.label, port.connected, port.cannotRun])
      ).toEqual([
        ["continue", "actionPortNextStep", true, "outcomes"],
        ["any_reply", "actionOutcomeOtherReply", true, undefined],
      ]);
    });

    it("names a template's default output Other reply while Any reply is off", () => {
      expect(continueLabel(portsFor(quickReplyTemplate()))).toBe(
        "sourceHandleAnyUserReply"
      );
    });

    describe("a default output beside a linked outcome", () => {
      const noReplyOn = {
        version: 1 as const,
        noReply: { enabled: true, timeoutMinutes: 30 },
      };
      const noReplyLinked = {
        actionOutcomes: noReplyOn,
        uiConnections: { sourceHandleIds: [ACTION_NO_REPLY_OUTCOME_HANDLE_ID] },
      } satisfies Partial<ActionNodeTestData>;
      const continuePort = (ports: ActionNodePorts) =>
        ports.ports.find(port => port.kind === "continue");

      it("drops an unlinked Reply row that can't run and keeps its anchor", () => {
        const ports = expectEveryAcceptedHandle(serviceText(noReplyLinked));
        expect(ports.ports.map(port => port.kind)).toEqual(["no_reply"]);
        expect(ports.hiddenAnchorIds).toEqual(["right-source"]);
      });

      it("drops an unlinked Other reply row and keeps the quick replies", () => {
        const ports = expectEveryAcceptedHandle(
          quickReplyTemplate(noReplyLinked)
        );
        expect(rowSummary(ports)).toEqual([
          [
            buildWhatsAppTemplateButtonSourceHandleId(0),
            "branch",
            "Track",
            false,
          ],
          [
            ACTION_NO_REPLY_OUTCOME_HANDLE_ID,
            "no_reply",
            "actionOutcomeNoReply",
            true,
          ],
        ]);
        expect(ports.hiddenAnchorIds).toEqual([
          ACTION_WHATSAPP_TEMPLATE_BUTTON_BRANCH_OUTPUT_HANDLE_ID,
          "right-source",
        ]);
      });

      it.each<[string, ActionNodeTestData]>([
        [
          "a template without buttons",
          {
            kind: "action",
            actionType: "whatsapp_template",
            actionWhatsAppTemplateName: "hello",
            actionWhatsAppTemplateComponents: [{ type: "BODY", text: "Hi" }],
            ...noReplyLinked,
          },
        ],
        [
          "a Telegram reply",
          {
            kind: "action",
            actionType: "reply",
            actionReplyChannel: "telegram",
            actionReplyMode: "fixed",
            actionReplyText: "Hi",
            ...noReplyLinked,
          },
        ],
      ])("drops the unlinked Then row of %s", (_label, data) => {
        const ports = expectEveryAcceptedHandle(data);
        expect(continuePort(ports)).toBeUndefined();
        expect(ports.hiddenAnchorIds).toEqual(["right-source"]);
      });

      it.each<[string, ActionNodeTestData, string]>([
        [
          "Form submitted",
          {
            kind: "action",
            actionType: "reply",
            actionWhatsAppServiceMessage: {
              version: 1,
              message: {
                kind: "flow",
                body: { mode: "fixed", text: "Open the form" },
                flowConfig: { ...testFlowConfig(), screens: [] },
              },
            },
            ...noReplyLinked,
          },
          "serviceRouteFlowSubmitted",
        ],
        [
          "a template's form button",
          {
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
            actionFlowConfig: { ...testFlowConfig(), screens: [] },
            ...noReplyLinked,
          },
          "actionPortNextStep",
        ],
        [
          "Details collected",
          serviceText({
            actionWhatsAppServiceMessage: {
              version: 1,
              message: { kind: "text", body: { mode: "fixed", text: "Name?" } },
              promptInputs: [
                { key: "name", label: "Name", prompt: "Your name" },
              ],
            },
            ...noReplyLinked,
          }),
          "whatsappServicePromptInputsMet",
        ],
      ])("keeps %s, which continues past the wait", (_label, data, label) => {
        const port = continuePort(expectEveryAcceptedHandle(data));
        expect(port).toMatchObject({ label, connected: false });
        expect(port?.cannotRun).toBeUndefined();
      });

      it("keeps Reply while No reply is on but unlinked", () => {
        const port = continuePort(
          expectEveryAcceptedHandle(serviceText({ actionOutcomes: noReplyOn }))
        );
        expect(port).toMatchObject({
          label: "serviceRouteNextMessage",
          connected: false,
        });
        expect(port?.cannotRun).toBeUndefined();
      });

      it("keeps a linked Reply that can't run and flags it", () => {
        const ports = expectEveryAcceptedHandle(
          serviceText({
            actionOutcomes: noReplyOn,
            uiConnections: {
              sourceHandleIds: [
                ACTION_NO_REPLY_OUTCOME_HANDLE_ID,
                "right-source",
              ],
            },
          })
        );
        expect(continuePort(ports)).toEqual({
          handleId: "right-source",
          kind: "continue",
          label: "serviceRouteNextMessage",
          accessibleLabel: "serviceRouteNextMessage",
          connected: true,
          cannotRun: "outcomes",
        });
        expect(ports.hiddenAnchorIds).toEqual([]);
      });

      it("leaves a step whose outcomes come from legacy routing as it was", () => {
        const port = continuePort(
          portsFor(
            serviceText({
              ...noReplyLinked,
              uiLegacyActionRouting: {
                actionOutcomesSource: {
                  sourceNodeId: "condition",
                  sourceKind: "post_action_condition",
                },
              },
            })
          )
        );
        expect(port).toMatchObject({
          label: "serviceRouteNextMessage",
          connected: false,
        });
        expect(port?.cannotRun).toBeUndefined();
      });
    });

    it("calls the reply outcome Any reply unless buttons, choices or answer rules take replies first", () => {
      const anyReplyLabel = (data: ActionNodeTestData) =>
        portsFor(data).ports.find(port => port.kind === "any_reply")?.label;
      const anyReply = { version: 1 as const, anyReply: { enabled: true } };
      expect(
        anyReplyLabel({
          kind: "action",
          actionType: "reply",
          actionOutcomes: anyReply,
        })
      ).toBe("actionOutcomeAnyReply");
      expect(
        anyReplyLabel({
          kind: "action",
          actionType: "reply",
          actionReplyChannel: "telegram",
          actionTelegramQuickReplies: [[{ text: "Yes", payload: "yes" }]],
          actionOutcomes: anyReply,
        })
      ).toBe("actionOutcomeOtherReply");
      expect(
        anyReplyLabel({
          kind: "action",
          actionType: "reply",
          actionOutcomes: {
            ...anyReply,
            answerMatches: [{ id: "yes", text: "yes", mode: "exact" }],
          },
        })
      ).toBe("actionOutcomeOtherReply");
    });

    it("names unnamed list rows Untitled option and says the customer picks them", () => {
      const ports = expectEveryAcceptedHandle({
        kind: "action",
        actionType: "reply",
        actionWhatsAppServiceMessage: {
          version: 1,
          message: {
            kind: "list",
            body: { mode: "fixed", text: "Pick a row" },
            buttonLabel: "Menu",
            sections: [
              {
                id: "main",
                title: "Main",
                rows: [
                  { id: testChoiceId("r1"), title: "Delivery" },
                  { id: testChoiceId("r2"), title: "" },
                ],
              },
            ],
          },
        },
      });
      expect(
        ports.ports.map(port => [
          port.label,
          port.accessibleLabel,
          port.optionKind,
        ])
      ).toEqual([
        [
          "Delivery",
          quoted("sourceHandleWhatsAppChoice", "Delivery"),
          "option",
        ],
        [
          "untitledOption",
          quoted("sourceHandleWhatsAppChoice", "untitledOption"),
          "option",
        ],
      ]);
    });

    it("names the question of each form option when the form asks more than one", () => {
      const flowConfig = testFlowConfig([{ id: "opt_1", title: "Yes" }]);
      const ports = expectEveryAcceptedHandle({
        kind: "action",
        actionType: "reply",
        actionWhatsAppServiceMessage: {
          version: 1,
          message: {
            kind: "flow",
            body: { mode: "fixed", text: "Open the form" },
            flowConfig: {
              ...flowConfig,
              screens: [
                {
                  ...flowConfig.screens[0],
                  fields: [
                    ...flowConfig.screens[0].fields,
                    {
                      id: "field_2",
                      label: "Size",
                      fieldType: "RadioButtonsGroup",
                      options: [{ id: "large", title: "Large" }],
                    },
                  ],
                },
              ],
            },
          },
        },
      });
      expect(
        ports.ports.map(port => [port.label, port.accessibleLabel])
      ).toEqual([
        ["Pick one · Yes", quoted("sourceHandleFlowOption", "Pick one · Yes")],
        ["Size · Large", quoted("sourceHandleFlowOption", "Size · Large")],
      ]);
    });

    it("keeps legacy-owned outcomes from starting a drag and leaves other routes connectable", () => {
      const ports = portsFor({
        kind: "action",
        actionType: "reply",
        actionOutcomes: OUTCOMES,
        uiLegacyActionRouting: {
          actionOutcomesSource: {
            sourceNodeId: "condition",
            sourceKind: "post_action_condition",
          },
        },
      });
      expect(ports.ports.map(port => [port.kind, port.connectable])).toEqual([
        ["continue", undefined],
        ["any_reply", false],
        ["no_reply", false],
        ["answer", false],
        ["answer", false],
        ["payment_detected", false],
      ]);
    });
  });
});
