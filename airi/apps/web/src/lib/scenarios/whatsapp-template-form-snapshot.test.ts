import type {
  ScenarioNodeData,
  ScenarioWhatsAppTemplateForm,
} from "@icecore/scenario-contracts";
import { DEMOSHOP_FLOW_JSON } from "@/components/scenarios/builders/whatsapp/flow-json-fixtures";
import type { ScenarioWhatsAppTemplate } from "@/components/scenarios/types";
import { buildActionWhatsAppTemplateSelectionPatch } from "@/components/scenarios/view/action/selector-utils";
import {
  buildTemplateFormAnswerSchema,
  type TemplateFormAnswerSchema,
} from "@/lib/whatsapp/flows/template-form-answer-schema";
import { getWhatsAppTemplateOptionValue } from "@/lib/whatsapp/templates/selection";
import { MEDAL_GRAPH_CONFIG } from "./__tests__/scenario-form-fixtures";
import { listUnavailableScenarioFormAnswerTokensByNodeId } from "./scenario-form-answer-checks";
import {
  buildWhatsAppTemplateFormSnapshotPatch,
  readLoadableWhatsAppTemplateFormFlowId,
} from "./whatsapp-template-form-snapshot";

const FLOW_ID = "1571793974235171";
const READ_AT = "2026-10-05T10:00:00.000Z";
const SCHEMA = buildTemplateFormAnswerSchema({
  flowJson: DEMOSHOP_FLOW_JSON,
  flowName: "demoshop_ai_case",
}) as TemplateFormAnswerSchema;

type GraphNode = { id: string; data: ScenarioNodeData };

/** DemoShop's template step: one FLOW button, its id a number as Meta saves it. */
function formStep(id: string, data: Record<string, unknown> = {}): GraphNode {
  return {
    id,
    data: {
      kind: "action",
      actionType: "whatsapp_template",
      actionWhatsAppTemplateName: "demoshop_test",
      actionWhatsAppTemplateComponents: [
        { type: "BODY", text: "Choose your medal" },
        {
          type: "BUTTONS",
          buttons: [
            { type: "FLOW", text: "Open form", flow_id: 1571793974235171 },
          ],
        },
      ],
      ...data,
    } as ScenarioNodeData,
  };
}

function savedForm(
  overrides: Partial<ScenarioWhatsAppTemplateForm> = {}
): ScenarioWhatsAppTemplateForm {
  return {
    version: 1,
    flowId: FLOW_ID,
    answersKey: "demoshop_ai_case",
    readAt: "2026-10-01T00:00:00.000Z",
    ...SCHEMA,
    ...overrides,
  };
}

const trigger: GraphNode = {
  id: "trigger",
  data: { kind: "trigger" } as ScenarioNodeData,
};

function portraitStep(prompt: string): GraphNode {
  return {
    id: "portrait",
    data: {
      kind: "action",
      actionType: "generative_ai",
      actionGenerativeAIConfig: { version: 1, mode: "text_to_video", prompt },
    } as ScenarioNodeData,
  };
}

const edges = [
  { source: "trigger", target: "template" },
  {
    source: "template",
    target: "portrait",
    sourceHandle: "right-source-whatsapp-template-form-submitted",
  },
];

function load(
  nodes: GraphNode[],
  options: { nodeId?: string; flowId?: string; schema?: unknown } = {}
) {
  return buildWhatsAppTemplateFormSnapshotPatch({
    nodes,
    edges,
    nodeId: options.nodeId ?? "template",
    flowId: options.flowId ?? FLOW_ID,
    schema: (options.schema ?? SCHEMA) as TemplateFormAnswerSchema,
    readAt: READ_AT,
  });
}

function loadedKey(result: ReturnType<typeof load>) {
  return result && "snapshot" in result ? result.snapshot.answersKey : result;
}

describe("buildWhatsAppTemplateFormSnapshotPatch", () => {
  it("saves a first form under a key from its Flow name, read when the Flow was", () => {
    const result = load([trigger, formStep("template")]);

    expect(result).toEqual({
      patch: { actionWhatsAppTemplateForm: savedForm({ readAt: READ_AT }) },
      snapshot: savedForm({ readAt: READ_AT }),
      newlyUnavailable: [],
    });
  });

  it("keeps the saved form's key across refreshes of the same Flow", () => {
    const saved = savedForm({ answersKey: "medal", digest: "older" });

    expect(
      loadedKey(
        load([
          trigger,
          formStep("template", { actionWhatsAppTemplateForm: saved }),
        ])
      )
    ).toBe("medal");
  });

  it("keeps the key a linked Flow config stores, as the readers read it", () => {
    const linked = formStep("template", {
      actionFlowConfig: {
        templateId: "",
        screens: [],
        ctaText: "",
        answersKey: "medal_order",
      },
      actionWhatsAppTemplateForm: savedForm(),
    });

    expect(loadedKey(load([trigger, linked]))).toBe("medal_order");
  });

  it("gives a copied step whose key another form has the key it resolves to", () => {
    const nodes = [
      trigger,
      formStep("template", { actionWhatsAppTemplateForm: savedForm() }),
      formStep("copy", { actionWhatsAppTemplateForm: savedForm() }),
    ];

    expect(loadedKey(load(nodes, { nodeId: "copy" }))).toBe(
      "demoshop_ai_case_2"
    );
    // The first step keeps its key, so it has nothing to save.
    expect(load(nodes)).toEqual({ unchanged: true });
  });

  it("keeps the step's key when its template's form moves to a renamed copy of the Flow", () => {
    // A published Flow can't be edited, so a changed form is a copy under
    // another name, and the approved template's button opens the copy.
    const COPY_FLOW_ID = "2244981489363579";
    const portrait = portraitStep(
      "A medal for {{form.demoshop_ai_case.f_68d224}}"
    );
    const step = formStep("template", {
      actionWhatsAppTemplateForm: savedForm(),
    });
    const approved: ScenarioWhatsAppTemplate = {
      id: "meta-1",
      name: "demoshop_test",
      language: "ru",
      category: "MARKETING",
      components: [
        { type: "BODY", text: "Choose your medal" },
        {
          type: "BUTTONS",
          buttons: [{ type: "FLOW", text: "Open form", flow_id: COPY_FLOW_ID }],
        },
      ],
    };
    // "Use approved template" picks it, as the template picker does.
    const picked = {
      ...step,
      data: {
        ...step.data,
        ...buildActionWhatsAppTemplateSelectionPatch({
          nodeData: step.data,
          templateValue: getWhatsAppTemplateOptionValue(approved),
          whatsAppTemplates: [approved],
        }),
      },
    };

    const result = load([trigger, picked, portrait], {
      flowId: COPY_FLOW_ID,
      schema: buildTemplateFormAnswerSchema({
        flowJson: DEMOSHOP_FLOW_JSON,
        flowName: "demoshop_ai_case_v2",
      }),
    });

    expect(result).toMatchObject({
      snapshot: {
        flowId: COPY_FLOW_ID,
        flowName: "demoshop_ai_case_v2",
        answersKey: "demoshop_ai_case",
      },
      newlyUnavailable: [],
    });
    const loaded = {
      ...picked,
      data: { ...picked.data, ...(result as { patch: object }).patch },
    };
    expect(
      listUnavailableScenarioFormAnswerTokensByNodeId({
        nodes: [trigger, loaded, portrait],
        edges,
      })
    ).toEqual(new Map());
  });

  it("is unchanged when only the read time would change", () => {
    expect(
      load([
        trigger,
        formStep("template", { actionWhatsAppTemplateForm: savedForm() }),
      ])
    ).toEqual({ unchanged: true });
  });

  it("names answers a prompt reads that a refresh removes, by their old labels", () => {
    const withoutName = {
      ...SCHEMA,
      digest: "without-name",
      fields: SCHEMA.fields.filter(field => field.responseKey !== "_68d224"),
    };
    const nodes = [
      trigger,
      formStep("template", { actionWhatsAppTemplateForm: savedForm() }),
      portraitStep(
        "A medal for {{form.demoshop_ai_case.f_68d224}} from {{form.demoshop_ai_case.ebfcfb}}"
      ),
    ];

    expect(load(nodes, { schema: withoutName })).toMatchObject({
      snapshot: { answersKey: "demoshop_ai_case", digest: "without-name" },
      newlyUnavailable: [
        { token: "form.demoshop_ai_case.f_68d224", label: "Athlete's name" },
      ],
    });
  });

  it("saves nothing for a step that no longer opens the Flow, a form built here, or fields it can't save", () => {
    const nodes = [trigger, formStep("template")];

    expect(load(nodes, { flowId: "2244981489363579" })).toBeNull();
    expect(
      load([
        trigger,
        formStep("template", { actionFlowConfig: MEDAL_GRAPH_CONFIG }),
      ])
    ).toBeNull();
    expect(load(nodes, { schema: { ...SCHEMA, fields: "broken" } })).toBeNull();
  });
});

describe("readLoadableWhatsAppTemplateFormFlowId", () => {
  it("reads the Flow a template's one FLOW button opens, unless a form is built here", () => {
    expect(readLoadableWhatsAppTemplateFormFlowId(formStep("t").data)).toBe(
      FLOW_ID
    );
    // A Flow linked from Meta lists no fields here, so its fields can load.
    expect(
      readLoadableWhatsAppTemplateFormFlowId(
        formStep("t", {
          actionFlowConfig: { templateId: "", screens: [], ctaText: "" },
        }).data
      )
    ).toBe(FLOW_ID);
    expect(
      readLoadableWhatsAppTemplateFormFlowId(
        formStep("t", { actionFlowConfig: MEDAL_GRAPH_CONFIG }).data
      )
    ).toBeNull();
    expect(
      readLoadableWhatsAppTemplateFormFlowId(
        formStep("t", {
          actionWhatsAppTemplateComponents: [
            {
              type: "BUTTONS",
              buttons: [{ type: "QUICK_REPLY", text: "Yes" }],
            },
          ],
        }).data
      )
    ).toBeNull();
    expect(
      readLoadableWhatsAppTemplateFormFlowId({
        ...formStep("t").data,
        actionType: "reply",
      })
    ).toBeNull();
  });
});
