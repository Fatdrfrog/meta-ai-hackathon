import {
  ACTION_WHATSAPP_TEMPLATE_FORM_SUBMITTED_HANDLE_ID,
  buildWhatsAppTemplateButtonSourceHandleId,
  SCENARIO_WHATSAPP_TEMPLATE_FORM_VERSION,
  type ScenarioWhatsAppTemplateButtonIds,
  type ScenarioWhatsAppTemplateForm,
  type WhatsAppComponent,
} from "@icecore/scenario-contracts";
import {
  extractWhatsAppTemplateQuickReplyBranchOptions,
  hasWhatsAppTemplateQuickReplyButtons,
  listWhatsAppTemplateButtonDrift,
} from "./whatsapp-template-button-branches";

type TestButton =
  | { type: "QUICK_REPLY"; text: string }
  | { type: "URL"; text: string; url: string }
  | { type: "FLOW"; text: string; flow_id: string | number };

function template(...buttons: TestButton[]): WhatsAppComponent[] {
  return [
    { type: "BODY", text: "Which plan do you want?" },
    { type: "BUTTONS", buttons },
  ] as WhatsAppComponent[];
}

const reply = (text: string): TestButton => ({ type: "QUICK_REPLY", text });
const link = (text: string): TestButton => ({
  type: "URL",
  text,
  url: "https://shop.test/plans",
});

/** The step's saved Basic and Premium, both routed unless told otherwise. */
function drift(
  liveComponents: unknown,
  options: {
    step?: WhatsAppComponent[];
    buttonIds?: ScenarioWhatsAppTemplateButtonIds;
    routedIds?: number[];
  } = {}
) {
  return listWhatsAppTemplateButtonDrift({
    nodeData: {
      actionWhatsAppTemplateComponents:
        options.step ?? template(reply("Basic"), reply("Premium")),
      actionWhatsAppTemplateButtonIds: options.buttonIds,
    },
    liveComponents,
    routedSourceHandleIds: (options.routedIds ?? [0, 1]).map(id =>
      buildWhatsAppTemplateButtonSourceHandleId(id)
    ),
  });
}

describe("listWhatsAppTemplateButtonDrift", () => {
  it("finds nothing when the approved template matches the step", () => {
    expect(drift(template(reply("basic "), reply("Premium")))).toEqual([]);
  });

  it("finds nothing without a saved copy, a known approved template or a route", () => {
    expect(drift(template(reply("Basic")), { step: [] })).toEqual([]);
    expect(drift(undefined)).toEqual([]);
    expect(drift(template(reply("Gold")), { routedIds: [] })).toEqual([]);
  });

  it("names a removed routed button and an approved button with no route", () => {
    expect(
      drift(template(reply("Premium"), reply("Gold"), reply("VIP")))
    ).toEqual([
      { kind: "removed", label: "Basic" },
      { kind: "added", label: "Gold" },
      { kind: "added", label: "VIP" },
    ]);
  });

  it("skips a changed button that has no route", () => {
    expect(
      drift(template(reply("Starter"), reply("Premium")), { routedIds: [1] })
    ).toEqual([]);
  });

  it("pairs a renamed button by position, as sends do", () => {
    expect(drift(template(reply("Starter"), reply("Premium")))).toEqual([
      { kind: "renamed", label: "Basic", liveLabel: "Starter" },
    ]);
  });

  it("keeps routes on buttons that only moved", () => {
    expect(drift(template(reply("Premium"), reply("Basic")))).toEqual([]);
    expect(
      drift(template(reply("Basic")), {
        step: template(link("See plans"), reply("Basic")),
        routedIds: [1],
      })
    ).toEqual([]);
  });

  it("finds routed buttons by the step's stored ids", () => {
    expect(
      drift(template(reply("Gold")), {
        step: template(reply("Premium")),
        buttonIds: {
          version: 1,
          nextId: 10,
          buttons: [{ id: 1, index: 0, text: "Premium" }],
        },
        routedIds: [1],
      })
    ).toEqual([{ kind: "renamed", label: "Premium", liveLabel: "Gold" }]);
  });
});

describe("listWhatsAppTemplateButtonDrift for the Form submitted route", () => {
  const MEDAL_FORM_ID = "1571793974235171";
  // The saved copy can hold the Flow id as a number (a BSON double).
  const openForm = (flowId: string | number = Number(MEDAL_FORM_ID)) =>
    ({ type: "FLOW", text: "Open form", flow_id: flowId }) as const;
  const formStep = template(openForm());

  /** The fields "Load form fields" saved from a form, which AI steps read. */
  const savedFields = (
    flowId = MEDAL_FORM_ID
  ): ScenarioWhatsAppTemplateForm => ({
    version: SCENARIO_WHATSAPP_TEMPLATE_FORM_VERSION,
    flowId,
    flowName: "medal_pick_1",
    answersKey: "medal_pick",
    digest: "digest-1",
    coverage: "complete",
    endpoint: false,
    readAt: "2026-10-05T06:49:00.000Z",
    fields: [
      {
        responseKey: "full_name",
        label: "Full name",
        description: "",
        fieldType: "TextInput",
        required: true,
        screenIndex: 0,
        options: [],
      },
    ],
  });

  /** The step's routes: Form submitted, plus the given reply buttons. */
  function formDrift(
    liveComponents: unknown,
    options: {
      step?: WhatsAppComponent[];
      routedIds?: number[];
      formRouted?: boolean;
      form?: ScenarioWhatsAppTemplateForm;
    } = {}
  ) {
    return listWhatsAppTemplateButtonDrift({
      nodeData: {
        actionWhatsAppTemplateComponents: options.step ?? formStep,
        actionWhatsAppTemplateForm: options.form,
      },
      liveComponents,
      routedSourceHandleIds: [
        ...(options.routedIds ?? []).map(id =>
          buildWhatsAppTemplateButtonSourceHandleId(id)
        ),
        ...(options.formRouted === false
          ? []
          : [ACTION_WHATSAPP_TEMPLATE_FORM_SUBMITTED_HANDLE_ID]),
      ],
    });
  }

  it("names the form button an approved template replaced with a reply button", () => {
    // demoshop_test after its 06:49 edit: Meta sends a quick reply, no form.
    const approved = [
      { type: "BODY", text: "Which plan do you want?" },
      { type: "FOOTER", text: "DemoShop" },
      { type: "BUTTONS", buttons: [reply("Таңдау")] },
    ];
    expect(formDrift(approved)).toEqual([
      { kind: "form_removed", label: "Open form" },
    ]);
  });

  it("names the form button whose approved copy opens another form", () => {
    expect(formDrift(template(openForm("5550100")))).toEqual([
      { kind: "form_changed", label: "Open form" },
    ]);
  });

  it("finds nothing while the approved form button opens the same form", () => {
    expect(formDrift(template(openForm(MEDAL_FORM_ID)))).toEqual([]);
  });

  it("finds nothing without a Form submitted route, saved fields or a saved form button", () => {
    expect(formDrift(template(reply("Таңдау")), { formRouted: false })).toEqual(
      []
    );
    // Fields saved for an earlier template's form are never read.
    expect(
      formDrift(template(openForm("5550100")), {
        formRouted: false,
        form: savedFields("5550199"),
      })
    ).toEqual([]);
    expect(
      formDrift(template(reply("Таңдау")), { step: template(reply("Basic")) })
    ).toEqual([]);
  });

  it("names the form button for saved fields AI steps read without a Form submitted route", () => {
    // AI steps after Then read the medal form; the approved template opens
    // another form, whose answers the saved fields don't describe.
    expect(
      formDrift(template(openForm("5550100")), {
        formRouted: false,
        form: savedFields(),
      })
    ).toEqual([{ kind: "form_changed", label: "Open form" }]);
    expect(
      formDrift(template(reply("Таңдау")), {
        formRouted: false,
        form: savedFields(),
      })
    ).toEqual([{ kind: "form_answers_removed", label: "Open form" }]);
    expect(
      formDrift(template(openForm(MEDAL_FORM_ID)), {
        formRouted: false,
        form: savedFields(),
      })
    ).toEqual([]);
  });

  it("names a linked route's lost form once, beside saved fields", () => {
    expect(
      formDrift(template(reply("Таңдау")), { form: savedFields() })
    ).toEqual([{ kind: "form_removed", label: "Open form" }]);
  });

  it("keeps reply-button drift as it is beside the form's", () => {
    const step = template(reply("Basic"), reply("Premium"), openForm());

    expect(
      formDrift(template(reply("Premium"), openForm(MEDAL_FORM_ID)), {
        step,
        routedIds: [0, 1],
      })
    ).toEqual([{ kind: "removed", label: "Basic" }]);
    expect(
      formDrift(template(reply("Premium"), openForm("5550100")), {
        step,
        routedIds: [0, 1],
      })
    ).toEqual([
      { kind: "removed", label: "Basic" },
      { kind: "form_changed", label: "Open form" },
    ]);
    expect(
      formDrift(template(reply("Premium"), openForm("5550100")), {
        step,
        routedIds: [0, 1],
        formRouted: false,
      })
    ).toEqual([{ kind: "removed", label: "Basic" }]);
  });
});

describe("carousel template routes", () => {
  function carousel(...cards: Array<{ text: string; buttons: TestButton[] }>) {
    return [
      { type: "BODY", text: "Fall 2026" },
      {
        type: "CAROUSEL",
        cards: cards.map(card => ({
          components: [
            { type: "HEADER", format: "IMAGE" },
            { type: "BODY", text: card.text },
            { type: "BUTTONS", buttons: card.buttons },
          ],
        })),
      },
    ] as WhatsAppComponent[];
  }
  const card = (text: string, ...buttons: TestButton[]) => ({
    text,
    buttons: buttons.length > 0 ? buttons : [reply("Interested"), link("Buy")],
  });
  const collection = carousel(card("Blazer"), card("Coat"));

  it("gives each card's quick reply its own route option", () => {
    expect(
      extractWhatsAppTemplateQuickReplyBranchOptions({
        actionNodeId: "menu",
        nodeData: { actionWhatsAppTemplateComponents: collection },
      })
    ).toEqual([
      {
        buttonId: 100,
        index: 0,
        cardIndex: 0,
        label: "Interested",
        payload: "stb:menu:100",
      },
      {
        buttonId: 110,
        index: 0,
        cardIndex: 1,
        label: "Interested",
        payload: "stb:menu:110",
      },
    ]);
  });

  it("counts a card's quick reply as a template quick reply", () => {
    expect(hasWhatsAppTemplateQuickReplyButtons(collection)).toBe(true);
    expect(
      hasWhatsAppTemplateQuickReplyButtons(
        carousel(card("Blazer", link("Buy")), card("Coat", link("Buy")))
      )
    ).toBe(false);
  });

  it("names the card of a routed button the approved template removed", () => {
    expect(
      drift(carousel(card("Blazer")), {
        step: collection,
        routedIds: [100, 110],
      })
    ).toEqual([{ kind: "removed", label: "Interested", cardIndex: 1 }]);
  });
});
