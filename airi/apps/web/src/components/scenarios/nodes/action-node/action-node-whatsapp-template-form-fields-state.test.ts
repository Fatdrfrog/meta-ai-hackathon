import type {
  ScenarioNodeData,
  ScenarioWhatsAppTemplateForm,
} from "@icecore/scenario-contracts";
import { DEMOSHOP_FLOW_JSON } from "@/components/scenarios/builders/whatsapp/flow-json-fixtures";
import { MEDAL_GRAPH_CONFIG } from "@/lib/scenarios/__tests__/scenario-form-fixtures";
import { readLoadableWhatsAppTemplateFormFlowId } from "@/lib/scenarios/whatsapp-template-form-snapshot";
import type { TemplateFlowFacts } from "@/lib/whatsapp/flows/template-flow-health";
import {
  buildTemplateFormAnswerSchema,
  type TemplateFormAnswerSchema,
} from "@/lib/whatsapp/flows/template-form-answer-schema";
import {
  readTemplateFormFieldsBasis,
  resolveTemplateFormFieldsNotice,
  type TemplateFormFieldsLoad,
  type TemplateFormFieldsRequest,
} from "./action-node-whatsapp-template-form-fields-state";

type NoticeParams = Parameters<typeof resolveTemplateFormFieldsNotice>[0];
/** A saved template step, from which the enrichment reads its form's Flow. */
type NodeData = NoticeParams["nodeData"] &
  Pick<
    ScenarioNodeData,
    "kind" | "actionType" | "actionWhatsAppTemplateComponents"
  >;

const NODE_ID = "template";
const FLOW_ID = "1571793974235171";
const READ_AT = "2026-10-01T00:00:00.000Z";
const NAME_TOKEN = "form.demoshop_ai_case.f_68d224";
const SCHEMA = buildTemplateFormAnswerSchema({
  flowJson: DEMOSHOP_FLOW_JSON,
  flowName: "demoshop_ai_case",
}) as TemplateFormAnswerSchema;

function savedForm(
  overrides: Partial<ScenarioWhatsAppTemplateForm> = {}
): ScenarioWhatsAppTemplateForm {
  return {
    version: 1,
    flowId: FLOW_ID,
    answersKey: "demoshop_ai_case",
    readAt: READ_AT,
    ...SCHEMA,
    ...overrides,
  };
}

/** DemoShop's template step: one FLOW button, its id a number as Meta saves it. */
function formStep(data: Partial<NodeData> = {}): NodeData {
  return {
    kind: "action",
    actionType: "whatsapp_template",
    actionWhatsAppTemplateComponents: [
      { type: "BODY", text: "Choose your medal" },
      {
        type: "BUTTONS",
        buttons: [
          { type: "FLOW", text: "Open form", flow_id: 1571793974235171 },
        ],
      },
    ],
    uiScenarioFormKeys: new Map([[NODE_ID, "demoshop_ai_case"]]),
    ...data,
  } as NodeData;
}

function found(
  overrides: Partial<Extract<TemplateFlowFacts, { state: "found" }>> = {}
): TemplateFlowFacts {
  return {
    flowId: FLOW_ID,
    state: "found",
    name: "demoshop_ai_case",
    status: "PUBLISHED",
    screenIds: ["QUESTION_ONE", "DETAILS", "OTHER_DETAILS"],
    answerSchema: SCHEMA,
    checkedAt: "2026-10-05T10:00:00.000Z",
    ...overrides,
  };
}

function resolve(
  nodeData: NodeData,
  options: {
    facts?: TemplateFlowFacts;
    formLoading?: boolean;
    refreshing?: boolean;
    lastLoad?: TemplateFormFieldsLoad | null;
    /** The Flow a press loads; the enrichment reads it from the saved step. */
    flowId?: string | null;
  } = {}
) {
  return resolveTemplateFormFieldsNotice({
    nodeId: NODE_ID,
    nodeData,
    flowId:
      options.flowId === undefined
        ? readLoadableWhatsAppTemplateFormFlowId(nodeData)
        : options.flowId,
    flowFacts: {
      factsByFlowId: options.facts ? { [FLOW_ID]: options.facts } : {},
      isRefreshing: flowIds =>
        Boolean(options.refreshing) && flowIds.includes(FLOW_ID),
    },
    formLoading: options.formLoading ?? false,
    lastLoad: options.lastLoad,
  });
}

/** A press on the step as it was, answered with `result`. */
function pressed(
  nodeData: NodeData,
  result: TemplateFormFieldsLoad["result"],
  {
    facts,
    request = { reason: "update" },
  }: { facts?: TemplateFlowFacts; request?: TemplateFormFieldsRequest } = {}
): TemplateFormFieldsLoad {
  return {
    flowId: FLOW_ID,
    basis: readTemplateFormFieldsBasis(
      nodeData,
      readLoadableWhatsAppTemplateFormFlowId(nodeData)
    ),
    facts,
    request,
    result,
  };
}

const load = (request: TemplateFormFieldsRequest) => ({
  type: "load",
  flowId: FLOW_ID,
  request,
});

describe("resolveTemplateFormFieldsNotice", () => {
  it("offers to load the fields of a form the step hasn't read", () => {
    expect(resolve(formStep(), { facts: found() })).toEqual({
      kind: "missing",
      action: load({ reason: "load" }),
      busy: false,
      live: false,
    });
    // Facts not read yet, or unreadable, still need a Load.
    expect(resolve(formStep())).toMatchObject({ kind: "missing" });
    expect(
      resolve(formStep(), {
        facts: { flowId: FLOW_ID, state: "unavailable", checkedAt: READ_AT },
      })
    ).toMatchObject({ kind: "missing" });
  });

  it.each([
    [
      "a template without a form button",
      formStep({
        actionWhatsAppTemplateComponents: [
          { type: "BUTTONS", buttons: [{ type: "QUICK_REPLY", text: "Yes" }] },
        ],
      }),
      found(),
    ],
    [
      "a form built here",
      formStep({
        actionFlowConfig:
          MEDAL_GRAPH_CONFIG as unknown as NodeData["actionFlowConfig"],
      }),
      found(),
    ],
    ["a bulk send", formStep({ uiBulkPrimaryWhatsAppTemplate: true }), found()],
    [
      "a form WhatsApp doesn't have",
      formStep(),
      { flowId: FLOW_ID, state: "missing", checkedAt: READ_AT } as const,
    ],
  ])("shows nothing for %s", (_, nodeData, facts) => {
    expect(resolve(nodeData, { facts })).toBeNull();
  });

  it("offers no Load for a form the saved step doesn't open", () => {
    // A step saved without its buttons shows the approved template's form,
    // but a press loads the saved step's, and it has none.
    expect(resolve(formStep(), { facts: found(), flowId: null })).toBeNull();
  });

  it("shows nothing while the saved fields match the form", () => {
    expect(
      resolve(formStep({ actionWhatsAppTemplateForm: savedForm() }), {
        facts: found(),
      })
    ).toBeNull();
  });

  it("names a key another form has, and loads the step's own", () => {
    const copy = formStep({
      actionWhatsAppTemplateForm: savedForm(),
      uiScenarioFormKeys: new Map([[NODE_ID, "demoshop_ai_case_2"]]),
    });

    expect(resolve(copy, { facts: found() })).toEqual({
      kind: "duplicate",
      action: load({ reason: "update" }),
      busy: false,
      live: false,
    });
    // A key the step's Flow config stores wins; a Load can't move it.
    expect(
      resolve(
        {
          ...copy,
          actionFlowConfig: {
            templateId: "",
            screens: [],
            ctaText: "",
            answersKey: "demoshop_ai_case",
          },
        },
        { facts: found() }
      )
    ).toBeNull();
  });

  describe("a form that changed in WhatsApp", () => {
    const step = formStep({
      actionWhatsAppTemplateForm: savedForm({ digest: "old" }),
    });

    it("offers to update its fields once facts newer than them say so", () => {
      expect(resolve(step, { facts: found() })).toEqual({
        kind: "changed",
        action: load({ reason: "update" }),
        busy: false,
        live: false,
      });
    });

    it.each([
      ["as old as", READ_AT],
      ["older than", "2026-09-30T00:00:00.000Z"],
    ])("stays quiet for facts read %s the fields", (_, checkedAt) => {
      expect(resolve(step, { facts: found({ checkedAt }) })).toBeNull();
    });

    it("asks before an update removes answers AI steps read", () => {
      const facts = found();
      const needsConfirmation = pressed(
        step,
        {
          status: "needs_confirmation",
          newlyUnavailable: [{ token: NAME_TOKEN, label: "Athlete's name" }],
        },
        { facts }
      );

      expect(resolve(step, { facts, lastLoad: needsConfirmation })).toEqual({
        kind: "confirm",
        labels: ["Athlete's name"],
        action: load({ reason: "update", confirmRemovals: true }),
        busy: false,
        live: true,
      });
      // Once the step's fields change, the question is moot.
      expect(
        resolve(
          formStep({ actionWhatsAppTemplateForm: savedForm({ digest: "x" }) }),
          { facts, lastLoad: needsConfirmation }
        )
      ).toMatchObject({ kind: "changed", live: false });
    });

    it("names only the answers AI steps still read, and stops asking once they read none", () => {
      const facts = found();
      const city = { token: "form.demoshop_ai_case.f_city", label: "City" };
      const otherForm = { token: "form.order_form.size", label: "Size" };
      const asked = (
        newlyUnavailable: { token: string; label: string }[]
      ): TemplateFormFieldsLoad =>
        pressed(
          step,
          { status: "needs_confirmation", newlyUnavailable },
          { facts }
        );
      const reading = (tokens: string[]) =>
        resolve(
          { ...step, uiScenarioFormAnswerTokensRead: tokens },
          {
            facts,
            lastLoad: asked([
              { token: NAME_TOKEN, label: "Athlete's name" },
              city,
            ]),
          }
        );

      expect(reading([NAME_TOKEN, city.token])).toMatchObject({
        kind: "confirm",
        labels: ["Athlete's name", "City"],
      });
      // The user took the name out of the AI step, as the details tell them.
      expect(reading([city.token])).toMatchObject({
        kind: "confirm",
        labels: ["City"],
      });
      // Nothing an AI step reads goes now, so a plain update saves.
      expect(reading([])).toEqual({
        kind: "changed",
        action: load({ reason: "update" }),
        busy: false,
        live: false,
      });
      // The step lists only its own form's tokens; another form's answer stays.
      expect(
        resolve(
          { ...step, uiScenarioFormAnswerTokensRead: [] },
          { facts, lastLoad: asked([otherForm]) }
        )
      ).toMatchObject({ kind: "confirm", labels: ["Size"] });
    });

    it("trusts an update that found nothing new until newer facts arrive", () => {
      const facts = found();
      const unchanged = pressed(step, { status: "unchanged" }, { facts });

      expect(resolve(step, { facts, lastLoad: unchanged })).toEqual({
        kind: "loaded",
        fieldCount: SCHEMA.fields.length,
        live: true,
      });
      expect(
        resolve(step, {
          facts: found({ checkedAt: "2026-10-06T00:00:00.000Z" }),
          lastLoad: unchanged,
        })
      ).toMatchObject({ kind: "changed" });
    });
  });

  describe("a form WhatsApp couldn't read", () => {
    const step = formStep({ actionWhatsAppTemplateForm: savedForm() });

    it.each([
      [
        "its facts",
        { flowId: FLOW_ID, state: "unavailable", checkedAt: READ_AT } as const,
      ],
      ["its JSON", found({ answerSchema: null })],
    ])("reads it again after %s failed", (_, facts) => {
      expect(resolve(step, { facts })).toEqual({
        kind: "unavailable",
        action: { type: "refresh", flowId: FLOW_ID },
        busy: false,
        live: false,
      });
      expect(resolve(step, { facts, refreshing: true })).toMatchObject({
        kind: "unavailable",
        busy: true,
      });
    });

    it("repeats a Load that couldn't read it", () => {
      const step = formStep();
      const failed = pressed(
        step,
        { status: "unavailable" },
        { request: { reason: "load" } }
      );

      expect(resolve(step, { facts: found(), lastLoad: failed })).toEqual({
        kind: "unavailable",
        action: load({ reason: "load" }),
        busy: false,
        live: true,
      });
    });
  });

  it("says when the form sends no answers, or some can't be listed", () => {
    expect(
      resolve(
        formStep({ actionWhatsAppTemplateForm: savedForm({ fields: [] }) }),
        { facts: found() }
      )
    ).toEqual({ kind: "empty", live: false });
    // An endpoint form that lists nothing is partial, not empty.
    expect(
      resolve(
        formStep({
          actionWhatsAppTemplateForm: savedForm({
            fields: [],
            coverage: "partial",
            endpoint: true,
          }),
        }),
        { facts: found() }
      )
    ).toEqual({ kind: "partial", live: false });
  });

  it("reads out the saved answers once after a Load, until Undo", () => {
    const before = formStep();
    const after = formStep({ actionWhatsAppTemplateForm: savedForm() });
    const saved = pressed(
      before,
      {
        status: "saved",
        fieldCount: 5,
        coverage: "complete",
        newlyUnavailable: [],
      },
      { request: { reason: "load" } }
    );

    expect(resolve(after, { facts: found(), lastLoad: saved })).toEqual({
      kind: "loaded",
      fieldCount: SCHEMA.fields.length,
      live: true,
    });
    expect(resolve(before, { facts: found(), lastLoad: saved })).toMatchObject({
      kind: "missing",
      live: false,
    });
    // Another template's form is another form.
    expect(
      resolve(after, {
        facts: found(),
        lastLoad: { ...saved, flowId: "2244981489363579" },
      })
    ).toBeNull();
  });

  it("keeps the button while a read runs, and says so when there is none", () => {
    expect(
      resolve(formStep(), { facts: found(), formLoading: true })
    ).toMatchObject({ kind: "missing", busy: true });
    expect(
      resolve(formStep({ actionWhatsAppTemplateForm: savedForm() }), {
        facts: found(),
        formLoading: true,
      })
    ).toEqual({ kind: "loading", live: false });
  });
});
