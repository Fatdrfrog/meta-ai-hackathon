import {
  ACTION_WHATSAPP_TEMPLATE_FORM_SUBMITTED_HANDLE_ID,
  buildWhatsAppTemplateButtonSourceHandleId,
  type ScenarioNodeData,
} from "@icecore/scenario-contracts";
import { compileScenarioGraph } from "@icecore/airi-runtime/scenario-graph";
import { medalTemplateStep } from "./__tests__/scenario-form-fixtures";
import {
  readFormSubmittedRouteNodeIds,
  whatsappTemplateHasFormSubmittedRoute,
  whatsappTemplateOffersFormSubmittedRoute,
} from "./whatsapp-template-form-route";

const FORM_SUBMITTED = ACTION_WHATSAPP_TEMPLATE_FORM_SUBMITTED_HANDLE_ID;

const step = (data: Record<string, unknown> = {}) =>
  medalTemplateStep(data) as ScenarioNodeData;
const withButtons = (...buttons: Array<Record<string, unknown>>) =>
  step({
    actionWhatsAppTemplateComponents: [{ type: "BUTTONS", buttons }],
  });
const flowButton = { type: "FLOW", text: "Choose", flow_id: "123" };
const quickReply = { type: "QUICK_REPLY", text: "Call me" };
// A linked Flow whose choice field routes each answer on its own.
const radioFlowConfig = {
  templateId: "pick",
  ctaText: "Choose",
  metaFlowId: "123",
  screens: [
    {
      id: "PICK",
      title: "Pick",
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
};

describe("whatsappTemplateOffersFormSubmittedRoute", () => {
  it.each([
    ["one FLOW button", step()],
    ["a FLOW button beside quick replies", withButtons(quickReply, flowButton)],
    [
      "a linked Flow without choice routes",
      step({ actionFlowConfig: { ...radioFlowConfig, screens: [] } }),
    ],
  ])("is offered on a template with %s", (_, data) => {
    expect(whatsappTemplateOffersFormSubmittedRoute(data)).toBe(true);
  });

  it.each([
    ["quick replies only", withButtons(quickReply)],
    ["two FLOW buttons", withButtons(flowButton, flowButton)],
    [
      "Flow choice routes in use",
      step({ actionReplyCtaType: "flow", actionFlowConfig: radioFlowConfig }),
    ],
    ["a reply step", step({ actionType: "reply" })],
  ])("is not offered with %s", (_, data) => {
    expect(whatsappTemplateOffersFormSubmittedRoute(data)).toBe(false);
  });
});

describe("whatsappTemplateHasFormSubmittedRoute", () => {
  it("needs the step's own route edge", () => {
    const route = {
      source: "menu",
      target: "next",
      sourceHandle: FORM_SUBMITTED,
    };
    const has = (data: ScenarioNodeData, edges: Array<typeof route>) =>
      whatsappTemplateHasFormSubmittedRoute({ nodeId: "menu", data, edges });

    expect(has(step(), [route])).toBe(true);
    expect(has(step(), [{ ...route, source: "other" }])).toBe(false);
    expect(has(step(), [{ ...route, sourceHandle: "right-source" }])).toBe(
      false
    );
    // A route left on a template that no longer opens one form is inert.
    expect(has(withButtons(quickReply), [route])).toBe(false);
  });
});

describe("readFormSubmittedRouteNodeIds", () => {
  const action = (id: string, data: Record<string, unknown>) => ({
    id,
    data: data as ScenarioNodeData,
  });
  const reply = { kind: "action", actionType: "reply" };
  const graph = compileScenarioGraph(
    [
      action("medal", step()),
      action("stale", withButtons(quickReply)),
      action("deleted-target", step()),
      action("form-answered", reply),
      action("call-back", reply),
    ],
    [
      {
        source: "medal",
        target: "form-answered",
        sourceHandle: FORM_SUBMITTED,
      },
      {
        source: "stale",
        target: "call-back",
        sourceHandle: buildWhatsAppTemplateButtonSourceHandleId(0),
      },
      {
        source: "stale",
        target: "form-answered",
        sourceHandle: FORM_SUBMITTED,
      },
      {
        source: "deleted-target",
        target: "gone",
        sourceHandle: FORM_SUBMITTED,
      },
    ]
  );

  it("lists the steps whose route leads to a step of the graph", () => {
    expect([...readFormSubmittedRouteNodeIds(graph)]).toEqual(["medal"]);
  });

  it("reads each compiled graph once", () => {
    expect(readFormSubmittedRouteNodeIds(graph)).toBe(
      readFormSubmittedRouteNodeIds(graph)
    );
  });
});
