import {
  resolveScenarioFormKeys,
  type ScenarioFormAnswerSource,
  type ScenarioNodeData,
  type WhatsAppFlowConfig,
} from "@icecore/scenario-contracts";
import {
  buildScenarioFormAnswersKeysByNodeId,
  buildScenarioFormAnswersKeyStamps,
  buildScenarioFormAnswerTokensByFormKey,
  buildSentScenarioFormAnswerSourcesByNodeId,
  buildWhatsAppOnlyScenarioFormSourcesByNodeId,
  findScenarioFormAnswerMetaForm,
  listDuplicateScenarioFormAnswersKeyNodeIds,
  listScenarioFormAnswersKeyStampsReadBy,
  listUnavailableScenarioFormAnswerTokens,
  listUnavailableScenarioFormAnswerTokensByNodeId,
  readScenarioFormAnswerPrompt,
  stampScenarioFormAnswersKey,
} from "./scenario-form-answer-checks";

function formConfig(
  overrides: Partial<WhatsAppFlowConfig> = {}
): WhatsAppFlowConfig {
  return {
    templateId: "lead_generation",
    ctaText: "Open",
    screens: [
      {
        id: "DETAILS",
        title: "Details",
        fields: [{ id: "size", label: "Size", fieldType: "TextInput" }],
      },
    ],
    ...overrides,
  };
}

function templateForm(id: string, config: WhatsAppFlowConfig) {
  return {
    id,
    data: {
      kind: "action",
      actionType: "whatsapp_template",
      actionFlowConfig: config,
    } as ScenarioNodeData,
  };
}

const EMPTY_FORM: WhatsAppFlowConfig = {
  templateId: "",
  screens: [],
  ctaText: "",
};

type FormNode = { id: string; data: ScenarioNodeData };

/** The builder commits `config` on `nodeId`, stamped as the Flow builder does. */
function commitForm(
  nodes: FormNode[],
  nodeId: string,
  config: WhatsAppFlowConfig
): FormNode[] {
  const stamped = stampScenarioFormAnswersKey(config, {
    nodeId,
    formKeysByNodeId: buildScenarioFormAnswersKeysByNodeId(nodes),
  });
  return nodes.map(node =>
    node.id === nodeId ? templateForm(nodeId, stamped) : node
  );
}

function templateStep(
  id: string,
  components: unknown[] | undefined,
  config?: WhatsAppFlowConfig
): FormNode {
  return {
    id,
    data: {
      kind: "action",
      actionType: "whatsapp_template",
      actionWhatsAppTemplateName: "promo",
      ...(components ? { actionWhatsAppTemplateComponents: components } : {}),
      ...(config ? { actionFlowConfig: config } : {}),
    } as ScenarioNodeData,
  };
}

const FLOW_BUTTONS = [
  { type: "BODY", text: "Hi" },
  { type: "BUTTONS", buttons: [{ type: "FLOW", text: "Open", flow_id: "1" }] },
];
const QUICK_REPLY_BUTTONS = [
  { type: "BODY", text: "Hi" },
  { type: "BUTTONS", buttons: [{ type: "QUICK_REPLY", text: "Yes" }] },
];

const aiStep: FormNode = {
  id: "ai",
  data: {
    kind: "action",
    actionType: "reply",
    actionReplyMode: "ai",
    actionReplyInstruction: "Thank them",
  } as ScenarioNodeData,
};

const orderSource: ScenarioFormAnswerSource = {
  nodeId: "order",
  formKey: "order",
  formLabel: "Order",
  availability: "always",
  schema: "known",
  fields: [
    {
      key: "size",
      responseKey: "size",
      label: "Size",
      description: "",
      fieldType: "TextInput",
      required: true,
      screenIndex: 0,
      options: [],
      mayBeEmpty: false,
    },
  ],
};

describe("form answer tokens in AI prompts", () => {
  it("lists only form answers no earlier form provides", () => {
    const linked: ScenarioFormAnswerSource = {
      ...orderSource,
      nodeId: "linked",
      formKey: "survey",
      schema: "unknown",
      fields: [],
    };
    expect(
      listUnavailableScenarioFormAnswerTokens(
        "Use {{form.order.size}}, {{form.order.colour}}, {{form.survey.score}}, {{form.gone.x}}, {{input.name}} and {{first_name}}.",
        [orderSource, linked]
      )
    ).toEqual(["form.order.colour", "form.survey.score", "form.gone.x"]);
    expect(
      listUnavailableScenarioFormAnswerTokens("{{form.order.size}}", undefined)
    ).toEqual(["form.order.size"]);
  });

  it("reads the text AI gets: a generative prompt or AI writes instructions", () => {
    expect(
      readScenarioFormAnswerPrompt({
        kind: "action",
        actionType: "generative_ai",
        actionGenerativeAIConfig: {
          version: 1,
          mode: "text_to_video",
          prompt: "A {{form.order.size}} cup",
        },
      } as ScenarioNodeData)
    ).toBe("A {{form.order.size}} cup");
    expect(
      readScenarioFormAnswerPrompt({
        kind: "action",
        actionType: "reply",
        actionReplyMode: "ai",
        actionReplyInstruction: "Confirm {{form.order.size}}",
      } as ScenarioNodeData)
    ).toBe("Confirm {{form.order.size}}");
    expect(
      readScenarioFormAnswerPrompt({
        kind: "action",
        actionType: "reply",
        actionWhatsAppServiceMessage: {
          version: 1,
          message: {
            kind: "text",
            body: { mode: "ai", instruction: "Thank for {{form.order.size}}" },
            previewUrl: false,
          },
        },
      } as ScenarioNodeData)
    ).toBe("Thank for {{form.order.size}}");
  });

  it("ignores fixed text, left-over instructions and other steps", () => {
    for (const data of [
      {
        kind: "action",
        actionType: "reply",
        actionReplyMode: "fixed",
        actionReplyText: "{{form.order.size}}",
        actionReplyInstruction: "Old {{form.order.size}}",
      },
      {
        kind: "action",
        actionType: "reply",
        actionWhatsAppServiceMessage: {
          version: 1,
          message: {
            kind: "text",
            body: { mode: "fixed", text: "{{form.order.size}}" },
            previewUrl: false,
          },
        },
      },
      {
        kind: "action",
        actionType: "assign_human",
        actionInstruction: "{{form.order.size}}",
      },
      { kind: "trigger" },
    ]) {
      expect(readScenarioFormAnswerPrompt(data as ScenarioNodeData)).toBe("");
    }
  });

  it("lists the tokens AI prompts read, each once, by the form key they name", () => {
    const writes = (instruction: string) => ({
      data: {
        kind: "action",
        actionType: "reply",
        actionReplyMode: "ai",
        actionReplyInstruction: instruction,
      } as ScenarioNodeData,
    });
    const fixed = {
      data: {
        kind: "action",
        actionType: "reply",
        actionReplyMode: "fixed",
        actionReplyText: "{{form.order.note}}",
      } as ScenarioNodeData,
    };
    expect(
      Object.fromEntries(
        buildScenarioFormAnswerTokensByFormKey([
          writes("Confirm {{form.order.size}} for {{input.name}}"),
          fixed,
          writes("{{form.survey.score}}, {{form.order.colour}}"),
          writes("Again {{form.order.size}}"),
        ])
      )
    ).toEqual({
      order: ["form.order.size", "form.order.colour"],
      survey: ["form.survey.score"],
    });
  });
});

describe("forms before a step", () => {
  const trigger: FormNode = {
    id: "trigger",
    data: { kind: "trigger" } as ScenarioNodeData,
  };
  const edges = [
    { source: "trigger", target: "template" },
    { source: "template", target: "ai" },
  ];

  it("leaves out a template's left-over form its buttons never open", () => {
    const sourcesFor = (components: unknown[] | undefined) =>
      buildSentScenarioFormAnswerSourcesByNodeId({
        nodes: [
          trigger,
          templateStep(
            "template",
            components,
            formConfig({ answersKey: "order" })
          ),
          aiStep,
        ],
        edges,
      })
        .get("ai")
        ?.map(source => source.formKey);
    expect(sourcesFor(QUICK_REPLY_BUTTONS)).toEqual([]);
    expect(sourcesFor(FLOW_BUTTONS)).toEqual(["order"]);
    // Buttons that were never saved can't tell, so the form stays.
    expect(sourcesFor(undefined)).toEqual(["order"]);
  });

  it("lists forms built only in WhatsApp, with no key and no fields", () => {
    const legacyReply: FormNode = {
      id: "legacy",
      data: {
        kind: "action",
        actionType: "reply",
        actionReplyMode: "fixed",
        actionReplyText: "Fill this in",
        actionReplyCtaType: "flow",
        actionReplyCtaFlowId: "123",
      } as ScenarioNodeData,
    };
    const sources = buildWhatsAppOnlyScenarioFormSourcesByNodeId({
      nodes: [
        trigger,
        templateStep("template", FLOW_BUTTONS),
        legacyReply,
        aiStep,
      ],
      edges: [
        ...edges,
        { source: "trigger", target: "legacy" },
        { source: "legacy", target: "ai" },
      ],
    }).get("ai");
    expect(
      sources?.map(({ nodeId, formKey, schema, fields }) => ({
        nodeId,
        formKey,
        schema,
        fields,
      }))
    ).toEqual([
      { nodeId: "template", formKey: "", schema: "unknown", fields: [] },
      { nodeId: "legacy", formKey: "", schema: "unknown", fields: [] },
    ]);
    // A template whose form is built here, or with no Flow button, is not one.
    expect(
      buildWhatsAppOnlyScenarioFormSourcesByNodeId({
        nodes: [
          trigger,
          templateStep("template", FLOW_BUTTONS, formConfig()),
          aiStep,
        ],
        edges,
      }).size
    ).toBe(0);
    expect(
      buildWhatsAppOnlyScenarioFormSourcesByNodeId({
        nodes: [trigger, templateStep("template", QUICK_REPLY_BUTTONS), aiStep],
        edges,
      }).size
    ).toBe(0);
  });

  it("finds the Meta form a token names", () => {
    const linked: ScenarioFormAnswerSource = {
      ...orderSource,
      nodeId: "linked",
      formKey: "medal_pick_1",
      schema: "unknown",
      fields: [],
    };
    expect(
      findScenarioFormAnswerMetaForm([orderSource, linked], {
        formKey: "medal_pick_1",
      })
    ).toBe(linked);
    expect(
      findScenarioFormAnswerMetaForm([orderSource, linked], {
        formKey: "order",
      })
    ).toBeNull();
  });

  it("lists, by step, the answers AI prompts read that no form before them gives", () => {
    const writes = (id: string, instruction: string): FormNode => ({
      id,
      data: { ...aiStep.data, actionReplyInstruction: instruction },
    });
    const nodes = [
      trigger,
      writes("early", "Ask about {{form.order.size}}"),
      templateStep(
        "template",
        FLOW_BUTTONS,
        formConfig({ answersKey: "order" })
      ),
      writes("ai", "Confirm {{form.order.size}} in {{form.order.colour}}"),
      writes("thanks", "Thank them for {{form.order.size}}"),
      writes("plain", "Thank them"),
    ];
    expect(
      Object.fromEntries(
        listUnavailableScenarioFormAnswerTokensByNodeId({
          nodes,
          edges: [
            { source: "trigger", target: "early" },
            { source: "early", target: "template" },
            { source: "template", target: "ai" },
            { source: "ai", target: "thanks" },
            { source: "thanks", target: "plain" },
          ],
        })
      )
    ).toEqual({
      early: ["form.order.size"],
      ai: ["form.order.colour"],
    });
  });
});

describe("a template's saved form", () => {
  const trigger: FormNode = {
    id: "trigger",
    data: { kind: "trigger" } as ScenarioNodeData,
  };
  const edges = [
    { source: "trigger", target: "template" },
    { source: "template", target: "ai" },
  ];
  const savedForm = {
    version: 1,
    flowId: "1",
    flowName: "demoshop_ai_case",
    answersKey: "demoshop_ai_case",
    digest: null,
    coverage: "complete",
    endpoint: false,
    readAt: "",
    fields: [
      {
        responseKey: "size",
        label: "Size",
        description: "",
        fieldType: "TextInput",
        required: true,
        screenIndex: 0,
        options: [],
      },
    ],
  };
  const savedFormStep = (id: string, form: object = savedForm): FormNode => ({
    id,
    data: {
      ...templateStep(id, FLOW_BUTTONS).data,
      actionWhatsAppTemplateForm: form,
    } as ScenarioNodeData,
  });

  it("reads a saved form as a form built here, not one built only in WhatsApp", () => {
    const nodes = [trigger, savedFormStep("template"), aiStep];
    expect(
      buildWhatsAppOnlyScenarioFormSourcesByNodeId({ nodes, edges }).size
    ).toBe(0);
    expect(
      buildSentScenarioFormAnswerSourcesByNodeId({ nodes, edges })
        .get("ai")
        ?.map(source => [
          source.formKey,
          source.schema,
          source.fields.map(field => field.key),
        ])
    ).toEqual([["demoshop_ai_case", "known", ["size"]]]);
    // A form saved for another Flow is not read: the step stays WhatsApp-only.
    expect(
      buildWhatsAppOnlyScenarioFormSourcesByNodeId({
        nodes: [
          trigger,
          savedFormStep("template", { ...savedForm, flowId: "2" }),
          aiStep,
        ],
        edges,
      })
        .get("ai")
        ?.map(source => source.nodeId)
    ).toEqual(["template"]);
  });

  it("checks a saved form's key as any form's, and stamps no Flow config for it", () => {
    expect(
      listDuplicateScenarioFormAnswersKeyNodeIds([
        templateForm("first", formConfig({ answersKey: "demoshop_ai_case" })),
        savedFormStep("saved"),
      ])
    ).toEqual(["saved"]);
    expect(
      Object.fromEntries(
        buildScenarioFormAnswersKeysByNodeId([savedFormStep("saved")])
      )
    ).toEqual({ saved: "demoshop_ai_case" });
    expect(
      buildScenarioFormAnswersKeyStamps([savedFormStep("saved")]).size
    ).toBe(0);
  });
});

describe("form answer keys", () => {
  it("finds forms that store a key an earlier form already stores", () => {
    expect(
      listDuplicateScenarioFormAnswersKeyNodeIds([
        templateForm("first", formConfig({ answersKey: "order" })),
        templateForm("unstamped", formConfig({ metaFlowName: "Order" })),
        templateForm("second", formConfig({ answersKey: "order" })),
        templateForm("other", formConfig({ answersKey: "contact" })),
        templateForm("invalid", formConfig({ answersKey: "Order!" })),
      ])
    ).toEqual(["second"]);
  });

  it("lets an empty new form name itself only when no other form's key follows it", () => {
    // Every other form stores its key: the empty one is left out and names itself.
    expect(
      Object.fromEntries(
        buildScenarioFormAnswersKeysByNodeId([
          templateForm("order", formConfig({ answersKey: "order" })),
          templateForm("empty", EMPTY_FORM),
        ])
      )
    ).toEqual({ order: "order" });
    // A form after it has no key of its own and would move, so both keep theirs.
    expect(
      Object.fromEntries(
        buildScenarioFormAnswersKeysByNodeId([
          templateForm("empty", EMPTY_FORM),
          templateForm("legacy", formConfig({ templateId: "" })),
        ])
      )
    ).toEqual({ empty: "form", legacy: "form_2" });
  });

  it("keeps a reset form's key, so the next form from the same ready form gets its own", () => {
    let nodes: FormNode[] = [
      templateForm("e", formConfig({ answersKey: "lead_generation" })),
      templateStep("f", undefined),
    ];
    // "Change form" empties E; F then picks the same ready form, then is edited.
    nodes = commitForm(nodes, "e", EMPTY_FORM);
    nodes = commitForm(nodes, "f", formConfig());
    nodes = commitForm(nodes, "f", formConfig({ ctaText: "Go" }));
    expect(nodes.map(node => node.data.actionFlowConfig?.answersKey)).toEqual([
      "lead_generation",
      "lead_generation_2",
    ]);
    expect(listDuplicateScenarioFormAnswersKeyNodeIds(nodes)).toEqual([]);
    // What the field hint shows is what the runtime reads.
    expect(Object.fromEntries(resolveScenarioFormKeys(nodes))).toEqual({
      e: "lead_generation",
      f: "lead_generation_2",
    });
  });

  it("moves no other form's key when an earlier form is reset, re-picked or first filled", () => {
    const unstamped = (id: string, config = formConfig({ templateId: "" })) =>
      templateForm(id, config);
    let nodes: FormNode[] = [unstamped("e"), unstamped("f"), unstamped("g")];
    const before = Object.fromEntries(resolveScenarioFormKeys(nodes));
    expect(before).toEqual({ e: "form", f: "form_2", g: "form_3" });
    nodes = commitForm(nodes, "e", EMPTY_FORM);
    nodes = commitForm(nodes, "e", formConfig());
    expect(Object.fromEntries(resolveScenarioFormKeys(nodes))).toEqual(before);

    // An earlier form still empty from before gets its first questions.
    let legacy: FormNode[] = [unstamped("e", EMPTY_FORM), unstamped("f")];
    const legacyBefore = Object.fromEntries(resolveScenarioFormKeys(legacy));
    legacy = commitForm(legacy, "e", formConfig());
    expect(Object.fromEntries(resolveScenarioFormKeys(legacy))).toEqual(
      legacyBefore
    );
  });

  it("stores a form's key once a prompt reads it, so deleting an earlier form moves nothing", () => {
    const unstamped = (id: string) =>
      templateForm(id, formConfig({ templateId: "" }));
    const nodes: FormNode[] = [unstamped("e"), unstamped("f"), unstamped("g")];
    const stamps = buildScenarioFormAnswersKeyStamps(nodes);
    expect(Array.from(stamps.keys())).toEqual(["form", "form_2", "form_3"]);
    const reading = listScenarioFormAnswersKeyStampsReadBy(
      {
        kind: "action",
        actionType: "generative_ai",
        actionGenerativeAIConfig: {
          version: 1,
          mode: "text_to_video",
          prompt: "A {{form.form_2.size}} cup, {{form.form_2.size}} again",
        },
      } as ScenarioNodeData,
      stamps
    );
    expect(reading.map(stamp => stamp.nodeId)).toEqual(["f"]);
    const stamped = nodes.map(node =>
      node.id === "f"
        ? { ...node, data: { ...node.data, ...reading[0]?.patch } }
        : node
    );
    expect(buildScenarioFormAnswersKeyStamps(stamped).has("form_2")).toBe(
      false
    );
    const afterDelete = stamped.filter(node => node.id !== "e");
    expect(resolveScenarioFormKeys(afterDelete).get("f")).toBe("form_2");
    // A prompt with no form answers stores nothing.
    expect(listScenarioFormAnswersKeyStampsReadBy(aiStep.data, stamps)).toEqual(
      []
    );
  });

  it("keeps a key no other form has and returns the same form", () => {
    const config = formConfig({ answersKey: "order" });
    expect(
      stampScenarioFormAnswersKey(config, {
        nodeId: "node",
        formKeysByNodeId: new Map([["other", "contact"]]),
      })
    ).toBe(config);
  });

  it("keeps the key the step's form already has, so its variables keep working", () => {
    const stamped = stampScenarioFormAnswersKey(
      formConfig({ templateId: "customer_survey" }),
      {
        nodeId: "node",
        formKeysByNodeId: new Map([
          ["node", "form_2"],
          ["other", "form"],
        ]),
      }
    );
    expect(stamped.answersKey).toBe("form_2");
  });

  it("names a new form from its Flow name, else its ready form, unique in the scenario", () => {
    const scope = {
      nodeId: "new",
      formKeysByNodeId: new Map([["other", "lead_generation"]]),
    };
    expect(stampScenarioFormAnswersKey(formConfig(), scope).answersKey).toBe(
      "lead_generation_2"
    );
    expect(
      stampScenarioFormAnswersKey(
        formConfig({ metaFlowName: "Order details" }),
        scope
      ).answersKey
    ).toBe("order_details");
    expect(
      stampScenarioFormAnswersKey(formConfig({ templateId: "" }), scope)
        .answersKey
    ).toBe("form");
  });

  it("renames the later of two forms that store the same key to the key it resolves to", () => {
    const stamped = stampScenarioFormAnswersKey(
      formConfig({ answersKey: "order" }),
      {
        nodeId: "second",
        formKeysByNodeId: new Map([
          ["first", "order"],
          ["second", "order_2"],
        ]),
      }
    );
    expect(stamped.answersKey).toBe("order_2");
  });
});
