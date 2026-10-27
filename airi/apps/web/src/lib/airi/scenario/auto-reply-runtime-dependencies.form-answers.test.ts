const mockMessageFindOne = jest.fn();
const mockMessageFind = jest.fn();
const mockScenarioFindOne = jest.fn();
const mockWarn = jest.fn();
jest.mock("@/models/message", () => ({
  __esModule: true,
  default: {
    findOne: (...args: unknown[]) => mockMessageFindOne(...args),
    find: (...args: unknown[]) => mockMessageFind(...args),
  },
}));
jest.mock("@/models/scenario", () => ({
  Scenario: { findOne: (...args: unknown[]) => mockScenarioFindOne(...args) },
}));
jest.mock("@/lib/airi/reply/runtime/reply-logging", () => ({
  airiOrchestrationLogger: { warn: (...args: unknown[]) => mockWarn(...args) },
}));
jest.mock("@/lib/temporal/airi-turn-execution", () => ({}));
jest.mock("./scenario-prompt-input-extraction", () => ({}));
jest.mock("./scenario-runtime", () => ({}));
jest.mock("./scenario-runtime-resources", () => ({}));
jest.mock("./generative-ai-customer-text-screen", () => ({}));
jest.mock("../reply/runtime/generative-ai-execution-store", () => ({}));
jest.mock("../reply/runtime/auto-reply-scenario-state", () => ({}));

import { buildScenarioFormSubmission } from "@icecore/scenario-contracts";
import {
  MEDAL_FLOW_ID,
  medalTemplateForm,
  medalTemplateStep,
} from "@/lib/scenarios/__tests__/scenario-form-fixtures";
import { scenarioRuntimeDependencies } from "./auto-reply-runtime-dependencies";

const workspaceId = "workspace-1";
const conversationId = "conversation-1";
const scenarioId = "65f000000000000000000001";

const SIZE_OPTIONS = [
  { id: "opt_m", title: "Medium" },
  { id: "opt_l", title: "Large" },
];
const ORDER_FLOW = {
  templateId: "order",
  ctaText: "Order",
  metaFlowName: "Order details",
  screens: [
    {
      id: "ORDER",
      title: "Order",
      fields: [
        {
          id: "size",
          label: "Size",
          fieldType: "Dropdown",
          required: true,
          options: SIZE_OPTIONS,
        },
        { id: "address", label: "Address", fieldType: "TextArea" },
      ],
    },
  ],
};
const SERVICE_FIELDS = [
  {
    id: "size",
    label: "Size",
    fieldType: "Dropdown",
    options: SIZE_OPTIONS,
  },
  { id: "address", label: "Address", fieldType: "TextArea", options: [] },
];

function leanQuery(value: unknown) {
  const lean = jest.fn().mockResolvedValue(value);
  const select = jest.fn(() => ({ lean }));
  return { select, lean };
}

function listQuery(values: unknown[]) {
  const lean = jest.fn().mockResolvedValue(values);
  const select = jest.fn(() => ({ lean }));
  const limit = jest.fn(() => ({ select }));
  const sort = jest.fn(() => ({ limit }));
  return { sort, limit, select, lean };
}

function find(scope: {
  contextMessageId?: string | null;
  flowToken?: string | null;
}) {
  const findForm = scenarioRuntimeDependencies.findSubmittedScenarioForm;
  if (!findForm) throw new Error("findSubmittedScenarioForm is not wired");
  return findForm({
    workspaceId,
    conversationId,
    contextMessageId: scope.contextMessageId ?? null,
    flowToken: scope.flowToken ?? null,
  });
}

beforeEach(() => {
  mockMessageFindOne.mockReset().mockReturnValue(leanQuery(null));
  mockMessageFind.mockReset().mockReturnValue(listQuery([]));
  mockScenarioFindOne.mockReset().mockReturnValue(leanQuery(null));
  mockWarn.mockReset();
});

describe("the form a Flow reply submitted", () => {
  it("reads the cited service message's form as it was sent", async () => {
    const query = leanQuery({
      origin: { kind: "scenario", scenarioId, nodeId: "order-form" },
      whatsappServiceMessage: {
        version: 1,
        kind: "flow",
        command: { kind: "flow", flowConfig: ORDER_FLOW, flowToken: "flow_1" },
      },
    });
    mockMessageFindOne.mockReturnValue(query);

    await expect(find({ contextMessageId: "wamid.form" })).resolves.toEqual({
      scenarioId,
      sourceActionNodeId: "order-form",
      flowId: null,
      fields: SERVICE_FIELDS,
    });
    expect(mockMessageFindOne).toHaveBeenCalledWith(
      expect.objectContaining({
        conversation: conversationId,
        channel: "whatsapp",
        direction: "outbound",
      })
    );
    expect(query.select).toHaveBeenCalledWith(
      "origin whatsappFlow whatsappServiceMessage"
    );
    expect(mockMessageFind).not.toHaveBeenCalled();
    expect(mockScenarioFindOne).not.toHaveBeenCalled();
  });

  it("reads a template Flow send's field snapshots", async () => {
    mockMessageFindOne.mockReturnValue(
      leanQuery({
        origin: { kind: "scenario", scenarioId, nodeId: "order-template" },
        whatsappFlow: {
          flowId: "1234",
          flowToken: "flow_2",
          scenarioId,
          actionNodeId: "order-template",
          responseFieldMetadata: [
            {
              id: "size",
              label: "Size",
              helperText: null,
              screenTitle: "Order",
              options: SIZE_OPTIONS,
            },
            { id: "address", label: null, options: null },
          ],
        },
      })
    );

    await expect(find({ contextMessageId: "wamid.template" })).resolves.toEqual(
      {
        scenarioId,
        sourceActionNodeId: "order-template",
        flowId: "1234",
        fields: [
          { id: "size", label: "Size", options: SIZE_OPTIONS },
          { id: "address", label: null, options: null },
        ],
      }
    );
    expect(mockScenarioFindOne).not.toHaveBeenCalled();
  });

  it("reads a campaign template's form from its step in the scenario", async () => {
    mockMessageFindOne.mockReturnValue(
      leanQuery({
        origin: { kind: "campaign", scenarioId, nodeId: "bulk-template" },
        whatsappTemplate: { name: "order_form" },
      })
    );
    const scenario = leanQuery({
      nodes: [
        { id: "trigger", data: { kind: "trigger" } },
        {
          id: "bulk-template",
          data: {
            kind: "action",
            actionType: "whatsapp_template",
            actionFlowConfig: ORDER_FLOW,
          },
        },
      ],
    });
    mockScenarioFindOne.mockReturnValue(scenario);

    await expect(find({ contextMessageId: "wamid.bulk" })).resolves.toEqual({
      scenarioId,
      sourceActionNodeId: "bulk-template",
      flowId: null,
      fields: SERVICE_FIELDS,
    });
    expect(mockScenarioFindOne).toHaveBeenCalledWith({
      _id: scenarioId,
      workspaceId,
    });
    expect(scenario.select).toHaveBeenCalledWith("nodes");
  });

  it("formats a stored date field's answer as a date", async () => {
    mockMessageFindOne.mockReturnValue(
      leanQuery({
        origin: { kind: "scenario", scenarioId, nodeId: "booking" },
        whatsappFlow: {
          flowId: "1234",
          responseFieldMetadata: [
            { id: "day", label: "Day", options: null, fieldType: "DatePicker" },
          ],
        },
      })
    );

    const sent = await find({ contextMessageId: "wamid.booking" });
    expect(sent?.fields).toEqual([
      { id: "day", label: "Day", options: null, fieldType: "DatePicker" },
    ]);
    expect(
      buildScenarioFormSubmission({
        sourceActionNodeId: "booking",
        inboundMessageId: "wamid.reply",
        submittedAt: new Date("2026-10-04T00:00:00.000Z"),
        responseJson: JSON.stringify({ day: "1767225600000" }),
        fields: sent?.fields,
      })?.fields
    ).toEqual([
      {
        key: "day",
        label: "Day",
        fieldType: "DatePicker",
        value: "2026-01-01",
      },
    ]);
  });

  it("labels a template send that stored no fields with its step's saved form", async () => {
    // medal_pick_1 sends carry no Flow record; the step now saves its form.
    mockMessageFindOne.mockReturnValue(
      leanQuery({
        origin: { kind: "scenario", scenarioId, nodeId: "medal-pick" },
        whatsappTemplate: { name: "medal_pick_1" },
      })
    );
    mockScenarioFindOne.mockReturnValue(
      leanQuery({
        nodes: [
          {
            id: "medal-pick",
            data: medalTemplateStep({
              actionWhatsAppTemplateForm: medalTemplateForm(),
            }),
          },
        ],
      })
    );

    const sent = await find({ contextMessageId: "wamid.medal" });
    const reply = {
      sourceActionNodeId: "medal-pick",
      inboundMessageId: "wamid.reply",
      submittedAt: new Date("2026-10-04T00:00:00.000Z"),
      responseJson: JSON.stringify({
        __9ba1c9: "1_Таэквондо_/_Каратэ_/_Күрес",
        ____133f36: "1_Классикалық",
        _68d224: "Aruzhan",
        flow_token: "unused",
      }),
    };
    // Without the saved form the reply reads as its raw keys and option ids.
    expect(
      buildScenarioFormSubmission({ ...reply, fields: null })?.fields[0]
    ).toMatchObject({ label: "9ba1c9", value: "1_Таэквондо_/_Каратэ_/_Күрес" });
    const answers = buildScenarioFormSubmission({
      ...reply,
      fields: sent?.fields,
    })?.fields;

    expect(answers).toEqual([
      {
        key: "__9ba1c9",
        label: "Choose a sport",
        fieldType: "Dropdown",
        value: "Taekwondo, karate, wrestling",
      },
      {
        key: "____133f36",
        label: "Design",
        fieldType: "RadioButtonsGroup",
        value: "Classic",
      },
      {
        key: "_68d224",
        label: "Athlete's name",
        fieldType: "TextInput",
        value: "Aruzhan",
      },
    ]);
  });

  it("labels a send only with a saved form of the Flow it sent", async () => {
    const sendOf = (flowId: string) =>
      leanQuery({
        origin: { kind: "scenario", scenarioId, nodeId: "medal-pick" },
        whatsappFlow: {
          flowId,
          scenarioId,
          actionNodeId: "medal-pick",
          responseFieldMetadata: null,
        },
      });
    mockMessageFindOne
      .mockReturnValueOnce(sendOf(MEDAL_FLOW_ID))
      .mockReturnValueOnce(sendOf("1571793974235171"));
    mockScenarioFindOne.mockReturnValue(
      leanQuery({
        nodes: [
          {
            id: "medal-pick",
            data: medalTemplateStep({
              actionWhatsAppTemplateForm: medalTemplateForm(),
            }),
          },
        ],
      })
    );

    const sameFlow = await find({ contextMessageId: "wamid.medal" });
    expect(sameFlow?.fields?.map(field => field.id)).toEqual([
      "__9ba1c9",
      "____133f36",
      "_68d224",
      "_ebfcfb",
      "other_sport",
    ]);
    // A send of another Flow keeps its answers' own keys as labels.
    await expect(find({ contextMessageId: "wamid.other" })).resolves.toEqual({
      scenarioId,
      sourceActionNodeId: "medal-pick",
      flowId: "1571793974235171",
      fields: null,
    });
  });

  it("records a form made only in Meta without its fields", async () => {
    mockMessageFindOne.mockReturnValue(
      leanQuery({
        origin: { kind: "campaign", scenarioId: "legacy", nodeId: "tpl" },
      })
    );

    await expect(find({ contextMessageId: "wamid.legacy" })).resolves.toEqual({
      scenarioId: "legacy",
      sourceActionNodeId: "tpl",
      flowId: null,
      fields: null,
    });
    // Not a scenario id, so no lookup is made.
    expect(mockScenarioFindOne).not.toHaveBeenCalled();
  });

  it("falls back to the latest send of the reply's flow token", async () => {
    const sends = listQuery([
      {
        origin: { scenarioId, nodeId: "form-late" },
        whatsappServiceMessage: {
          command: { kind: "flow", flowConfig: ORDER_FLOW },
        },
      },
      {
        origin: { scenarioId, nodeId: "form-early" },
        whatsappServiceMessage: {
          command: { kind: "flow", flowConfig: ORDER_FLOW },
        },
      },
    ]);
    mockMessageFind.mockReturnValue(sends);

    await expect(find({ flowToken: "airi1.shared" })).resolves.toMatchObject({
      scenarioId,
      sourceActionNodeId: "form-late",
    });
    expect(mockMessageFind).toHaveBeenCalledWith({
      workspaceId,
      conversation: conversationId,
      direction: "outbound",
      $or: [
        { "whatsappFlow.flowToken": "airi1.shared" },
        { "whatsappServiceMessage.command.flowToken": "airi1.shared" },
      ],
    });
    expect(sends.sort).toHaveBeenCalledWith({ date: -1 });
    expect(sends.limit).toHaveBeenCalledWith(2);
    // Two steps sent the same token: the latest wins and the log says so.
    expect(mockWarn).toHaveBeenCalledWith(
      "airi.orchestration.scenario_form_flow_token_ambiguous",
      expect.objectContaining({
        sourceActionNodeId: "form-late",
        otherSourceActionNodeId: "form-early",
      })
    );
    expect(JSON.stringify(mockWarn.mock.calls)).not.toContain("Large");
  });

  it("finds a template's FLOW button send by the token it sent", async () => {
    const flowToken = "flow_1767225600000_abc123def4";
    mockMessageFind.mockReturnValue(
      listQuery([
        {
          origin: { kind: "scenario", scenarioId, nodeId: "medal-pick" },
          whatsappTemplate: { name: "medal_pick_1" },
          whatsappFlow: {
            flowId: MEDAL_FLOW_ID,
            flowToken,
            scenarioId,
            actionNodeId: "medal-pick",
            responseFieldMetadata: null,
          },
        },
      ])
    );

    // A reply that cites no message names its send by its flow_token alone.
    await expect(find({ flowToken })).resolves.toEqual({
      scenarioId,
      sourceActionNodeId: "medal-pick",
      flowId: MEDAL_FLOW_ID,
      fields: null,
    });
    expect(mockMessageFindOne).not.toHaveBeenCalled();
    expect(mockMessageFind).toHaveBeenCalledWith(
      expect.objectContaining({
        $or: expect.arrayContaining([{ "whatsappFlow.flowToken": flowToken }]),
      })
    );
  });

  it("finds nothing without a cited scenario message or a matching token", async () => {
    await expect(find({})).resolves.toBeNull();
    expect(mockMessageFindOne).not.toHaveBeenCalled();
    expect(mockMessageFind).not.toHaveBeenCalled();

    await expect(
      find({ contextMessageId: "wamid.none", flowToken: "flow_x" })
    ).resolves.toBeNull();
    expect(mockMessageFind).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      "a manager's message",
      { origin: { kind: "manual" }, whatsappFlow: { flowId: "1" } },
    ],
    [
      "a Flow send naming another step",
      {
        origin: { scenarioId, nodeId: "order-form" },
        whatsappFlow: { scenarioId, actionNodeId: "other-form" },
      },
    ],
    [
      "a Flow send naming another scenario",
      {
        origin: { scenarioId, nodeId: "order-form" },
        whatsappFlow: {
          scenarioId: "65f000000000000000000002",
          actionNodeId: "order-form",
        },
      },
    ],
  ])("attributes nothing to %s", async (_case, outbound) => {
    mockMessageFindOne.mockReturnValue(leanQuery(outbound));
    await expect(find({ contextMessageId: "wamid.x" })).resolves.toBeNull();
    expect(mockScenarioFindOne).not.toHaveBeenCalled();
  });
});
