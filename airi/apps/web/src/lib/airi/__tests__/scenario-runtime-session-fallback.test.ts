const mockConnectDB = jest.fn();
const mockScenarioFind = jest.fn();
const mockScenarioFindOne = jest.fn();
const mockMessageFind = jest.fn();
const mockQuickReplyFind = jest.fn();
const mockLogScenarioTriggerEvaluations = jest.fn();

jest.mock("@/lib/mongoose", () => ({
  __esModule: true,
  connectDB: (...args: unknown[]) => mockConnectDB(...args),
  default: (...args: unknown[]) => mockConnectDB(...args),
}));

jest.mock("@/models/scenario", () => ({
  Scenario: {
    find: (...args: unknown[]) => mockScenarioFind(...args),
    findOne: (...args: unknown[]) => mockScenarioFindOne(...args),
  },
}));

jest.mock("@/models/message", () => ({
  __esModule: true,
  default: {
    find: (...args: unknown[]) => mockMessageFind(...args),
  },
}));

jest.mock("@/models/quick-reply", () => ({
  QuickReply: {
    find: (...args: unknown[]) => mockQuickReplyFind(...args),
  },
}));

jest.mock("@/lib/airi/scenario/scenario-trigger-logging", () => ({
  logScenarioTriggerEvaluations: (...args: unknown[]) =>
    mockLogScenarioTriggerEvaluations(...args),
}));

import {
  previewScenarioEvaluation,
  resolveActiveScenarioRuntime,
} from "@/lib/airi/scenario/scenario-runtime";
import multiRootTemplateContinuation from "./multi-root-template-continuation.fixture.json";
import {
  DESIGN_FIELD,
  MEDAL_FLOW_ID,
  MEDAL_GRAPH_CONFIG,
  medalTemplateForm,
  medalTemplateStep,
} from "@/lib/scenarios/__tests__/scenario-form-fixtures";
import {
  makeClientMessageTriggerNode,
  makeLegacyPersistedTrigger,
} from "@/lib/scenarios/__tests__/scenario-trigger-fixtures";
import type {
  ScenarioRecord,
  ScenarioRuntimeEdge,
  ScenarioRuntimeNode,
} from "@icecore/airi-runtime/scenario-graph";
import type { ConversationScenarioState } from "@icecore/airi-runtime/scenario-state";
import {
  ACTION_WHATSAPP_TEMPLATE_FORM_SUBMITTED_HANDLE_ID,
  buildFlowBranchSourceHandleId,
  buildScenarioActionOutcomeHandleId,
  buildWhatsAppSessionChoicePayload,
  buildWhatsAppSessionChoiceSourceHandleId,
  buildWhatsAppTemplateButtonPayload,
  getScenarioActionOutcomeVirtualNodeId,
  type ScenarioNodeData,
  type ScenarioRuntimeEventKind,
} from "@icecore/scenario-contracts";

function createSelectSortLeanQuery<T>(value: T) {
  return {
    select: jest.fn().mockReturnThis(),
    sort: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    lean: jest.fn().mockResolvedValue(value),
  };
}

function createSelectLeanQuery<T>(value: T) {
  return {
    select: jest.fn().mockReturnThis(),
    lean: jest.fn().mockResolvedValue(value),
  };
}

type ScenarioFactoryParams = {
  id: string;
  name: string;
  priority: number;
  matchingRole?: "default" | "fallback";
  triggerConfig?: Record<string, unknown>;
  replyText: string;
  actionReplyChannel?: "instagram";
  legacyLoopScenario?: boolean;
  entryPolicy?: "repeatable" | "once_per_conversation";
};

type ScenarioTestRecord = Omit<
  ScenarioRecord,
  "_id" | "name" | "priority" | "matchingRole" | "nodes" | "edges" | "updatedAt"
> & {
  _id: string;
  name: string;
  priority: number;
  matchingRole: "default" | "fallback";
  nodes: ScenarioRuntimeNode[];
  edges: ScenarioRuntimeEdge[];
  updatedAt: Date;
};

type LegacyLoopScenarioRecord = Omit<ScenarioTestRecord, "entryPolicy"> & {
  loopScenario: true;
};

function createScenario(
  params: ScenarioFactoryParams & {
    legacyLoopScenario: true;
    entryPolicy?: undefined;
  }
): LegacyLoopScenarioRecord;
function createScenario(params: ScenarioFactoryParams): ScenarioTestRecord;
function createScenario(
  params: ScenarioFactoryParams
): ScenarioTestRecord | LegacyLoopScenarioRecord {
  const triggerId = `${params.id}-trigger`;
  const actionId = `${params.id}-action`;
  return {
    _id: params.id,
    name: params.name,
    priority: params.priority,
    matchingRole: params.matchingRole ?? "default",
    ...(params.entryPolicy
      ? { entryPolicy: params.entryPolicy }
      : params.legacyLoopScenario
        ? { loopScenario: true }
        : { entryPolicy: "once_per_conversation" as const }),
    updatedAt: new Date("2026-03-27T00:00:00.000Z"),
    nodes: [
      {
        id: triggerId,
        data: makeClientMessageTriggerNode({
          triggerConfig: params.triggerConfig,
        }),
      },
      {
        id: actionId,
        data: {
          kind: "action",
          actionType: "reply",
          actionReplyMode: "fixed",
          actionReplyText: params.replyText,
          ...(params.actionReplyChannel
            ? { actionReplyChannel: params.actionReplyChannel }
            : {}),
        },
      },
    ],
    edges: [{ source: triggerId, target: actionId }],
  } as ScenarioTestRecord | LegacyLoopScenarioRecord;
}

function createMultiTriggerScenario() {
  return {
    _id: "507f191e810c19729de860ec",
    name: "Multi trigger product start",
    priority: 10,
    matchingRole: "default",
    entryPolicy: "once_per_conversation" as const,
    updatedAt: new Date("2026-06-07T00:00:00.000Z"),
    nodes: [
      {
        id: "trigger-catch-all",
        data: makeClientMessageTriggerNode({
          triggerConfig: { enabled: true },
        }),
      },
      {
        id: "trigger-exact",
        data: makeClientMessageTriggerNode({
          triggerConfig: {
            enabled: true,
            messageMatchMode: "exact",
            keywordPattern: "buy product",
            keywordMatchMode: "contains",
          },
        }),
      },
      {
        id: "action-catch-all",
        data: {
          kind: "action",
          actionType: "reply",
          actionReplyMode: "fixed",
          actionReplyText: "generic branch",
        },
      },
      {
        id: "action-exact",
        data: {
          kind: "action",
          actionType: "reply",
          actionReplyMode: "fixed",
          actionReplyText: "exact branch",
        },
      },
    ],
    edges: [
      { source: "trigger-catch-all", target: "action-catch-all" },
      { source: "trigger-exact", target: "action-exact" },
    ],
  };
}

function createMixedSpecificityScenario() {
  return {
    _id: "507f191e810c19729de860fd",
    name: "Broad with unrelated exact root",
    priority: 20,
    matchingRole: "default",
    entryPolicy: "once_per_conversation" as const,
    updatedAt: new Date("2026-07-31T00:00:00.000Z"),
    nodes: [
      {
        id: "mixed-any",
        data: makeClientMessageTriggerNode({
          triggerConfig: {
            enabled: true,
            messageMatchMode: "any",
          },
        }),
      },
      {
        id: "mixed-exact-other",
        data: makeClientMessageTriggerNode({
          triggerConfig: {
            enabled: true,
            messageMatchMode: "exact",
            keywordPattern: "other",
          },
        }),
      },
      {
        id: "mixed-any-action",
        data: {
          kind: "action",
          actionType: "reply",
          actionReplyMode: "fixed",
          actionReplyText: "broad branch",
        },
      },
      {
        id: "mixed-exact-action",
        data: {
          kind: "action",
          actionType: "reply",
          actionReplyMode: "fixed",
          actionReplyText: "unrelated exact branch",
        },
      },
    ],
    edges: [
      { source: "mixed-any", target: "mixed-any-action" },
      { source: "mixed-exact-other", target: "mixed-exact-action" },
    ],
  };
}

function setActiveScenarios(scenarios: unknown[]) {
  const query = createSelectSortLeanQuery(scenarios);
  mockScenarioFind.mockReturnValue(query);
  mockScenarioFindOne.mockReturnValue(createSelectLeanQuery(null));
  return query;
}

function setLockedScenario(scenario: unknown) {
  const query = createSelectLeanQuery(scenario);
  mockScenarioFindOne.mockReturnValue(query);
  return query;
}

function expectScenarioSelectIncludesRuntimeEntryPolicy(query: {
  select: jest.Mock;
}) {
  const selection = query.select.mock.calls[0]?.[0];
  if (typeof selection === "string") {
    expect(selection).toContain("entryPolicy");
    expect(selection).toContain("loopScenario");
  } else {
    expect(selection).toMatchObject({ entryPolicy: 1, loopScenario: 1 });
  }
  expect(query.select).not.toHaveBeenCalledWith(
    expect.stringContaining("journeyPoolKey")
  );
}

function setInboundCustomerMessages(dates: string[]) {
  mockMessageFind.mockReturnValue(
    createSelectSortLeanQuery(
      dates.map(date => ({
        date,
        author: "wa_77010000201",
      }))
    )
  );
}

// Resolves for WhatsApp conversation conv-1 in workspace-1.
function resolveRuntime(
  input: Partial<Parameters<typeof resolveActiveScenarioRuntime>[0]> = {}
) {
  return resolveActiveScenarioRuntime({
    workspaceId: "workspace-1",
    conversation: { _id: "conv-1" } as never,
    channel: "whatsapp",
    ...input,
  });
}

function getLoggedScenarioEvaluations() {
  return mockLogScenarioTriggerEvaluations.mock.calls.flatMap(
    call => ((call[0] as unknown[]) || []) as Record<string, unknown>[]
  );
}

describe("session-aware fallback runtime", () => {
  it("retains explicit template bindings in the selected runtime action", async () => {
    const scenario = createScenario({
      id: "507f191e810c19729de868bc",
      name: "Order notification",
      priority: 1,
      replyText: "",
    });
    const bindings = {
      version: 1 as const,
      parameters: {
        "body:1": { source: "prompt_input" as const, key: "order_id" },
      },
    };
    scenario.nodes[1]!.data = {
      kind: "action",
      actionType: "whatsapp_template",
      actionWhatsAppTemplateName: "order_update",
      actionWhatsAppTemplateLanguage: "en",
      actionWhatsAppTemplateComponents: [{ type: "BODY", text: "Order {{1}}" }],
      actionWhatsAppTemplateBindings: bindings,
    };
    setActiveScenarios([scenario]);

    const result = await resolveRuntime();

    expect(result.runtime?.actionType).toBe("whatsapp_template");
    expect(result.runtime?.actionWhatsAppTemplateBindings).toEqual(bindings);
  });

  describe("the fields a template's form send stores", () => {
    // Compiled graphs are cached per scenario id, so each step gets its own.
    let scenarioCount = 0;
    async function resolveTemplateStep(data: Record<string, unknown>) {
      scenarioCount += 1;
      const scenario = createScenario({
        id: `507f191e810c19729de869${String(scenarioCount).padStart(2, "0")}`,
        name: "Medal order",
        priority: 1,
        replyText: "",
      });
      scenario.nodes[1]!.data = medalTemplateStep({
        actionWhatsAppTemplateName: "medal_pick_1",
        actionWhatsAppTemplateLanguage: "kk",
        ...data,
      }) as ScenarioNodeData;
      setActiveScenarios([scenario]);
      const result = await resolveRuntime();
      expect(result.runtime?.actionType).toBe("whatsapp_template");
      return result.runtime?.actionFormResponseFields;
    }

    it("keys a linked static-graph form's fields as its reply does", async () => {
      const stored = await resolveTemplateStep({
        actionFlowConfig: { ...MEDAL_GRAPH_CONFIG, metaFlowId: MEDAL_FLOW_ID },
      });

      expect(stored?.flowId).toBe(MEDAL_FLOW_ID);
      expect(stored?.fields.map(field => [field.id, field.fieldType])).toEqual([
        ["__9ba1c9", "Dropdown"],
        ["____133f36", "RadioButtonsGroup"],
        ["_68d224", "TextInput"],
        ["_ebfcfb", "TextInput"],
        ["other_sport", "TextInput"],
      ]);
      // The screen's sport list is not an answer the reply sends.
      expect(stored?.fields.map(field => field.id)).not.toContain("sport_list");
    });

    it.each([
      ["a Flow linked from Meta", { templateId: "", ctaText: "", screens: [] }],
      ["the template's own FLOW button", null],
    ])(
      "reads the fields of %s from the step's saved form",
      async (_case, actionFlowConfig) => {
        const stored = await resolveTemplateStep({
          actionFlowConfig: actionFlowConfig && {
            ...actionFlowConfig,
            metaFlowId: MEDAL_FLOW_ID,
          },
          actionWhatsAppTemplateForm: medalTemplateForm(),
        });

        expect(stored?.flowId).toBe(MEDAL_FLOW_ID);
        expect(stored?.fields.map(field => field.id)).toEqual([
          "__9ba1c9",
          "____133f36",
          "_68d224",
          "_ebfcfb",
          "other_sport",
        ]);
        expect(stored?.fields[1]).toEqual({
          id: "____133f36",
          label: "Design",
          helperText: "Design and name",
          screenTitle: null,
          options: DESIGN_FIELD.options,
          fieldType: "RadioButtonsGroup",
        });
      }
    );

    it("keeps a linear form's stored fields as they were, each with its type", async () => {
      // Read from the config as the send normalizes it: labels as plain text.
      const stored = await resolveTemplateStep({
        actionFlowConfig: {
          templateId: "order",
          ctaText: "Order",
          metaFlowId: "1234",
          screens: [
            {
              id: "ORDER",
              title: "Order",
              fields: [
                {
                  id: "size",
                  label: "<b>Size</b>",
                  fieldType: "Dropdown",
                  options: [{ id: "opt_l", title: "Large" }],
                },
              ],
            },
          ],
        },
      });

      expect(stored).toEqual({
        flowId: "1234",
        fields: [
          {
            id: "size",
            label: "Size",
            helperText: null,
            screenTitle: "Order",
            options: [{ id: "opt_l", title: "Large" }],
            fieldType: "Dropdown",
          },
        ],
      });
    });

    it("stores nothing for a template whose saved form is another Flow's", async () => {
      await expect(
        resolveTemplateStep({
          actionWhatsAppTemplateForm: {
            ...medalTemplateForm(),
            flowId: "1571793974235171",
          },
        })
      ).resolves.toBeUndefined();
    });
  });

  it("resolves an explicit ending without loading reply content", async () => {
    const scenario = createScenario({
      id: "507f191e810c19729de86999",
      name: "End",
      priority: 0,
      replyText: "",
    });
    scenario.nodes[1].data = { kind: "action", actionType: "end_scenario" };
    setActiveScenarios([scenario]);
    const result = await resolveRuntime({
      triggerMessageText: "done",
    });
    expect(result.runtime).toMatchObject({
      actionType: "end_scenario",
      completesScenario: true,
      nextActionNodeId: null,
      pendingConditionNodeId: null,
    });
    expect(mockQuickReplyFind).not.toHaveBeenCalled();
  });

  it.each([
    {
      index: 0,
      label: "plain fixed",
      mode: "fixed",
      service: undefined,
      reads: 0,
    },
    { index: 1, label: "plain AI", mode: "ai", service: undefined, reads: 1 },
    {
      index: 2,
      label: "canonical fixed",
      mode: "ai",
      service: {
        version: 1,
        message: { kind: "text", body: { mode: "fixed", text: "Exact copy" } },
      },
      reads: 0,
    },
    {
      index: 3,
      label: "canonical AI",
      mode: "fixed",
      service: {
        version: 1,
        message: {
          kind: "reply_buttons",
          body: { mode: "ai", instruction: "Use selected knowledge" },
          options: [{ id: "details", label: "Details" }],
        },
      },
      reads: 1,
    },
    {
      index: 4,
      label: "bodyless service",
      mode: "ai",
      service: {
        version: 1,
        message: { kind: "contacts", contacts: [{ formattedName: "Airi" }] },
      },
      reads: 0,
    },
  ])(
    "hydrates quick replies only for generated reply bodies: $label",
    async ({ index, mode, service, reads }) => {
      const scenario = createScenario({
        id: `507f191e810c19729de8668${index}`,
        name: "Reply content",
        priority: 1,
        replyText: "Exact copy",
      });
      scenario.nodes[1].data = {
        kind: "action",
        actionType: "reply",
        actionReplyChannel: "whatsapp",
        actionReplyMode: mode,
        actionReplyText: "Exact copy",
        ...(service ? { actionWhatsAppServiceMessage: service } : {}),
      } as ScenarioNodeData;
      setActiveScenarios([scenario]);
      mockQuickReplyFind.mockReturnValue(
        createSelectSortLeanQuery([
          { text: "Grounded answer", category: "FAQ" },
        ])
      );

      const result = await resolveRuntime({
        triggerMessageText: "hello",
      });

      expect(result.runtime).toMatchObject({
        scenarioId: scenario._id,
        selectedActionNodeId: scenario.nodes[1].id,
        selectedPathNodeIds: [scenario.nodes[0].id, scenario.nodes[1].id],
      });
      expect(mockQuickReplyFind).toHaveBeenCalledTimes(reads);
      if (reads) {
        expect(result.runtime?.actionReplyMode).toBe("ai");
        expect(result.runtime?.quickReplies).toEqual([
          { text: "Grounded answer", category: "FAQ", channel: undefined },
        ]);
      } else {
        expect(result.runtime?.quickReplies).toBeUndefined();
        if (index !== 4)
          expect(result.runtime?.actionReplyText).toBe("Exact copy");
      }
      if (service) {
        expect(result.runtime?.actionWhatsAppServiceMessage).toEqual(service);
      }
    }
  );

  it.each(["fixed", "ai"] as const)(
    "retains the fixed winner and a shadowed %s candidate",
    async mode => {
      const winner = createScenario({
        id: "507f191e810c19729de86690",
        name: "Winner",
        priority: 20,
        replyText: "Winner copy",
      });
      const shadowed = createScenario({
        id:
          mode === "fixed"
            ? "507f191e810c19729de86691"
            : "507f191e810c19729de86695",
        name: "Shadowed",
        priority: 10,
        replyText: "Shadowed copy",
      });
      shadowed.nodes[1].data.actionReplyMode = mode;
      setActiveScenarios([shadowed, winner]);

      const result = await resolveRuntime({
        triggerMessageText: "hello",
      });

      expect(result.runtime).toMatchObject({
        scenarioId: winner._id,
        actionReplyText: "Winner copy",
        selectedActionNodeId: winner.nodes[1].id,
      });
      expect(getLoggedScenarioEvaluations()).toEqual([
        expect.objectContaining({ scenarioId: winner._id, result: "winner" }),
        expect.objectContaining({
          scenarioId: shadowed._id,
          result: "matched_but_shadowed",
          winnerScenarioId: winner._id,
        }),
      ]);
      expect(mockQuickReplyFind).not.toHaveBeenCalled();
    }
  );
  it.each(["any", "keyword", "empty_regex", "ai_action", "fixed_action"])(
    "limits unavailable first-contact recovery to a content-independent template: %s",
    async kind => {
      const scenario = createScenario({
        id: `507f191e810c19729de8655${["any", "keyword", "empty_regex", "ai_action", "fixed_action"].indexOf(kind)}`,
        name: "First contact",
        priority: 10,
        replyText: "hello",
        triggerConfig:
          kind === "keyword"
            ? { messageMatchMode: "contains", keywordPattern: "WhatsApp" }
            : kind === "empty_regex"
              ? {
                  messageMatchMode: "contains",
                  keywordPattern: ".*",
                  keywordMatchMode: "regex",
                }
              : { messageMatchMode: "any" },
      });
      scenario.nodes[1].data = kind.endsWith("action")
        ? {
            kind: "action",
            actionType: "reply",
            actionReplyMode: kind === "ai_action" ? "ai" : "fixed",
            actionReplyText: "hello",
          }
        : {
            kind: "action",
            actionType: "whatsapp_template",
            actionWhatsAppTemplateName: "pick_lang",
            actionWhatsAppTemplateLanguage: "ru",
          };
      setActiveScenarios([scenario]);
      const result = await resolveRuntime({
        triggerMessageText: "[WhatsApp message unavailable]",
        contentIndependentEntryOnly: true,
      });
      expect(result.runtime?.actionType ?? null).toBe(
        kind === "any" ? "whatsapp_template" : null
      );
    }
  );

  it("selects the any-message root when a higher-specificity keyword also matches the referral", async () => {
    const scenario = createMultiTriggerScenario();
    scenario._id = "507f191e810c19729de86888";
    scenario.nodes.find(node => node.id === "action-catch-all")!.data = {
      kind: "action",
      actionType: "whatsapp_template",
      actionWhatsAppTemplateName: "pick_lang",
      actionWhatsAppTemplateLanguage: "kk",
    };
    setActiveScenarios([scenario]);
    const result = await resolveRuntime({
      contentIndependentEntryOnly: true,
      triggerMessageText: "",
      triggerWhatsAppReferral: {
        sourceType: "ad",
        sourceId: "ad-1",
        headline: "buy product",
      },
    });
    expect(result.runtime?.selectedActionNodeId).toBe("action-catch-all");
  });

  it("holds a session-button fallback before entry, then permits the readable recovery", async () => {
    const scenario = createScenario({
      id: "507f191e810c19729de86889",
      name: "Readable first contact",
      priority: 1,
      triggerConfig: {
        messageMatchMode: "any",
        onlyNewCustomers: true,
        channelFilter: ["whatsapp"],
      },
      replyText: "",
    });
    const action = scenario.nodes[1];
    action.data = {
      kind: "action",
      actionType: "reply",
      actionWhatsAppServiceMessage: {
        version: 1,
        message: {
          kind: "reply_buttons",
          body: { mode: "fixed", text: "Тілді таңдаңыз / Выберите язык" },
          options: [
            {
              id: buildWhatsAppSessionChoicePayload({
                actionNodeId: action.id,
                choiceId: "kk",
              }),
              label: "Қазақ тілі",
            },
          ],
        },
      },
    };
    setActiveScenarios([scenario]);
    const conversation = { _id: "conv-1" } as never;
    expect(
      await resolveActiveScenarioRuntime({
        workspaceId: "workspace-1",
        conversation,
        channel: "whatsapp",
        triggerMessageText: "",
        contentIndependentEntryOnly: true,
      })
    ).toEqual({ runtime: null });
    expect(conversation).toEqual({ _id: "conv-1" });
    const recovery = await resolveActiveScenarioRuntime({
      workspaceId: "workspace-1",
      conversation,
      channel: "whatsapp",
      triggerMessageText: "Сәлеметсіз бе",
    });
    expect(recovery.runtime).toMatchObject({
      scenarioId: scenario._id,
      selectedActionNodeId: action.id,
      actionType: "reply",
      actionWhatsAppServiceMessage: action.data.actionWhatsAppServiceMessage,
    });
  });

  it.each([
    {
      scenarioState: {
        startedScenarios: [{ scenarioId: "previous", startedAt: new Date() }],
      },
    },
    { scenarioState: { pendingConditionNodeId: "condition-1" } },
    { conversation: { _id: "conv-1", airi_handoff_active: true } },
    {
      conversation: {
        _id: "conv-1",
        airi_pending_generative_execution: { executionId: "busy" },
      },
    },
    { forcedScenarioId: "507f191e810c19729de86888" },
    { triggerEventKind: "whatsapp_button_reply" },
  ])(
    "rejects unavailable-content entry overrides or existing journeys: %j",
    async extra => {
      const result = await resolveActiveScenarioRuntime({
        workspaceId: "workspace-1",
        conversation: { _id: "conv-1" },
        channel: "whatsapp",
        contentIndependentEntryOnly: true,
        triggerMessageText: "",
        ...extra,
      } as never);
      expect(result).toEqual({ runtime: null });
      expect(mockScenarioFind).not.toHaveBeenCalled();
    }
  );

  const medalScenario = createScenario({
    id: "507f1f77bcf86cd799439011",
    name: "Медаль ілгіш",
    priority: 50,
    triggerConfig: {
      messageMatchMode: "contains",
      keywordPattern: "медаль",
      keywordMatchMode: "contains",
    },
    replyText: "specific medal",
  });

  const priceScenario = createScenario({
    id: "507f191e810c19729de860ea",
    name: "Қанша",
    priority: 40,
    triggerConfig: {
      messageMatchMode: "contains",
      keywordPattern: "баға",
      keywordMatchMode: "contains",
    },
    replyText: "specific price",
  });

  const fallbackScenario = createScenario({
    id: "507f191e810c19729de860eb",
    name: "Общее начало",
    priority: 999,
    matchingRole: "fallback",
    replyText: "fallback",
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockConnectDB.mockResolvedValue(undefined);
    mockLogScenarioTriggerEvaluations.mockResolvedValue(undefined);
    mockQuickReplyFind.mockReturnValue(createSelectSortLeanQuery([]));
    setInboundCustomerMessages([]);
  });

  it.each(["matching", "changed", "missing", "malformed"])(
    "fences a forced continuation against a %s scenario revision",
    async revision => {
      const scenario = createScenario({
        id: "507f191e810c19729de861fe",
        name: "Confirmed payment",
        priority: 1,
        replyText: "Paid branch",
      });
      setLockedScenario(revision === "missing" ? null : scenario);
      const result = await resolveRuntime({
        forcedScenarioId: scenario._id,
        forcedActionNodeId: scenario.nodes[1].id,
        triggerEventKind: "payment_detected",
        skipTriggerMatch: true,
        expectedScenarioUpdatedAt:
          revision === "changed"
            ? "2026-03-28T00:00:00.000Z"
            : revision === "malformed"
              ? "invalid"
              : scenario.updatedAt.toISOString(),
      });
      if (revision === "matching") {
        expect(result.runtime?.actionReplyText).toBe("Paid branch");
      } else {
        expect(result).toEqual({ runtime: null, staleScenarioRevision: true });
        expect(mockScenarioFind).not.toHaveBeenCalled();
        expect(mockLogScenarioTriggerEvaluations).not.toHaveBeenCalled();
      }
    }
  );

  it.each(["matching", "changed", "missing", "malformed"])(
    "uses one scoped snapshot for the same forced and locked scenario: %s revision",
    async revision => {
      const scenario = createScenario({
        id: "507f191e810c19729de86692",
        name: "Confirmed payment",
        priority: 1,
        replyText: "Paid branch",
      });
      setLockedScenario(revision === "missing" ? null : scenario);

      const result = await resolveActiveScenarioRuntime({
        workspaceId: "workspace-1",
        conversation: { _id: "conv-1" } as never,
        scenarioState: {
          lockedScenarioId: scenario._id,
          currentActionNodeId: scenario.nodes[1].id,
        },
        channel: "whatsapp",
        forcedScenarioId: scenario._id,
        forcedActionNodeId: scenario.nodes[1].id,
        triggerEventKind: "payment_detected",
        skipTriggerMatch: true,
        expectedScenarioUpdatedAt:
          revision === "changed"
            ? "2026-03-28T00:00:00.000Z"
            : revision === "malformed"
              ? "invalid"
              : scenario.updatedAt.toISOString(),
      });

      expect(mockScenarioFindOne).toHaveBeenCalledTimes(1);
      expect(mockScenarioFindOne).toHaveBeenCalledWith({
        _id: scenario._id,
        workspaceId: "workspace-1",
        status: "active",
        mode: { $ne: "bulk_campaign" },
        deletedAt: null,
      });
      if (revision === "matching") {
        expect(result.runtime).toMatchObject({
          scenarioId: scenario._id,
          actionReplyText: "Paid branch",
        });
      } else {
        expect(result).toEqual({ runtime: null, staleScenarioRevision: true });
        expect(mockQuickReplyFind).not.toHaveBeenCalled();
        expect(mockScenarioFind).not.toHaveBeenCalled();
        expect(mockLogScenarioTriggerEvaluations).not.toHaveBeenCalled();
      }
    }
  );

  it("keeps distinct forced and locked scenario snapshots separate", async () => {
    const locked = createScenario({
      id: "507f191e810c19729de86693",
      name: "Locked",
      priority: 1,
      replyText: "Locked copy",
    });
    const forced = createScenario({
      id: "507f191e810c19729de86694",
      name: "Forced",
      priority: 1,
      replyText: "Forced copy",
    });
    mockScenarioFindOne.mockImplementation((query: { _id: string }) =>
      createSelectLeanQuery(query._id === locked._id ? locked : forced)
    );

    const result = await resolveActiveScenarioRuntime({
      workspaceId: "workspace-1",
      conversation: { _id: "conv-1" } as never,
      scenarioState: {
        lockedScenarioId: locked._id,
        currentActionNodeId: locked.nodes[1].id,
      },
      channel: "whatsapp",
      forcedScenarioId: forced._id,
      forcedActionNodeId: forced.nodes[1].id,
      triggerEventKind: "payment_detected",
      skipTriggerMatch: true,
      expectedScenarioUpdatedAt: forced.updatedAt.toISOString(),
    });

    expect(result.runtime).toMatchObject({
      scenarioId: forced._id,
      actionReplyText: "Forced copy",
    });
    expect(mockScenarioFindOne).toHaveBeenCalledTimes(2);
    expect(mockScenarioFindOne.mock.calls.map(call => call[0]._id)).toEqual([
      locked._id,
      forced._id,
    ]);
  });

  it("starts behavior templates only through an explicit event and fences revisions", async () => {
    const scenario = createScenario({
      id: "507f191e810c19729de861ff",
      name: "Repeat purchase",
      priority: 1,
      entryPolicy: "repeatable",
      replyText: "",
      triggerConfig: {
        enabled: true,
        entryPointType: "customer_behavior",
        behavior: { preset: "second_purchase", delayMinutes: 20160 },
      },
    });
    scenario.nodes[1].data = {
      kind: "action",
      actionType: "whatsapp_template",
      actionWhatsAppTemplateName: "repeat",
      actionWhatsAppTemplateLanguage: "ru",
    };
    setActiveScenarios([scenario]);
    const base = {
      workspaceId: "workspace-1",
      conversation: { _id: "conv-1" } as never,
      channel: "whatsapp" as const,
    };
    expect(
      (
        await resolveActiveScenarioRuntime({
          ...base,
          triggerMessageText: "hello",
        })
      ).runtime
    ).toBeNull();
    setLockedScenario(scenario);
    const forced = {
      ...base,
      forcedScenarioId: scenario._id,
      forcedTriggerNodeId: scenario.nodes[0].id,
      skipTriggerMatch: true,
    };
    expect(
      (
        await resolveActiveScenarioRuntime({
          ...forced,
          expectedScenarioUpdatedAt: scenario.updatedAt.toISOString(),
        })
      ).runtime
    ).toMatchObject({
      actionType: "whatsapp_template",
      actionWhatsAppTemplateName: "repeat",
    });
    expect(
      await resolveActiveScenarioRuntime({
        ...forced,
        expectedScenarioUpdatedAt: "2026-03-28T00:00:00Z",
      })
    ).toEqual({ runtime: null, staleScenarioRevision: true });
  });

  it("evaluates specific scenarios before fallback even when fallback has higher numeric priority", async () => {
    setActiveScenarios([fallbackScenario, medalScenario]);

    const result = await resolveRuntime({
      triggerMessageText: "маған медаль ілгіш керек",
    });

    expect(result.runtime?.scenarioId).toBe(medalScenario._id);
    expect(result.runtime?.actionReplyText).toBe("specific medal");
  });

  it.each([
    { label: "top-level candidate", forced: false },
    { label: "forced scenario", forced: true },
  ])(
    "preserves contains-matcher no-action state for a canonical $label",
    async ({ forced }) => {
      const scenarioWithAction = createScenario({
        id: "507f191e810c19729de861aa",
        name: "Contains without action",
        priority: 60,
        triggerConfig: {
          messageMatchMode: "contains",
          keywordPattern: "medal",
          keywordMatchMode: "contains",
        },
        replyText: "unused",
      });
      const scenario = {
        ...scenarioWithAction,
        nodes: [scenarioWithAction.nodes[0]],
        edges: [],
      };

      if (forced) {
        setLockedScenario(scenario);
      } else {
        setActiveScenarios([scenario]);
      }

      const result = await resolveRuntime({
        forcedScenarioId: forced ? scenario._id : undefined,
        triggerEventKind: "inbound_message",
        triggerMessageText: "I need a medal hanger",
      });

      expect(result).toEqual({
        runtime: null,
        containsTriggerMatchedNoAction: true,
      });
    }
  );

  it("includes the canonical WhatsApp appointment in the selected runtime", async () => {
    const scenario = {
      _id: "507f191e810c19729de860bc",
      name: "Book a demo",
      priority: 20,
      entryPolicy: "once_per_conversation" as const,
      matchingRole: "default",
      updatedAt: new Date("2026-06-11T00:00:00.000Z"),
      nodes: [
        {
          id: "trigger-1",
          data: {
            kind: "trigger",
            triggerConfig: { enabled: true },
          },
        },
        {
          id: "book-call-1",
          data: {
            kind: "action",
            actionType: "reply",
            actionReplyMode: "fixed",
            actionReplyChannel: "whatsapp",
            actionWhatsAppServiceMessage: {
              version: 1,
              message: {
                kind: "appointment",
                body: { mode: "fixed", text: "Choose a call time" },
                config: {
                  enabled: true,
                  dateRangeMode: "custom_days",
                  durationMinutes: 45,
                  minNoticeMinutes: 15,
                  horizonDays: 14,
                  maxSlots: 3,
                  timeZone: "Asia/Almaty",
                  eventTitle: "Demo call",
                  createMeetLink: true,
                },
              },
            },
          },
        },
      ],
      edges: [{ source: "trigger-1", target: "book-call-1" }],
    };
    setActiveScenarios([scenario]);

    const result = await resolveRuntime({
      triggerMessageText: "demo",
    });

    expect(result.runtime?.selectedActionNodeId).toBe("book-call-1");
    expect(result.runtime?.actionReplyChannel).toBe("whatsapp");
    expect(result.runtime?.actionWhatsAppServiceMessage).toEqual({
      version: 1,
      message: {
        kind: "appointment",
        body: { mode: "fixed", text: "Choose a call time" },
        config: {
          enabled: true,
          dateRangeMode: "custom_days",
          durationMinutes: 45,
          minNoticeMinutes: 15,
          horizonDays: 14,
          maxSlots: 3,
          timeZone: "Asia/Almaty",
          eventTitle: "Demo call",
          createMeetLink: true,
        },
      },
    });
  });

  it("gives a text ask held by its No reply reminder its collected route", async () => {
    const scenario = {
      _id: "507f191e810c19729de860be",
      name: "Engraving",
      priority: 20,
      entryPolicy: "once_per_conversation" as const,
      matchingRole: "default",
      updatedAt: new Date("2026-09-20T00:00:00.000Z"),
      nodes: [
        {
          id: "trigger-1",
          data: { kind: "trigger", triggerConfig: { enabled: true } },
        },
        {
          id: "ask",
          data: {
            kind: "action",
            actionType: "reply",
            actionReplyMode: "fixed",
            actionReplyChannel: "whatsapp",
            actionWhatsAppServiceMessage: {
              version: 1,
              message: {
                kind: "text",
                body: { mode: "fixed", text: "Send the name to engrave." },
                previewUrl: false,
              },
              promptInputs: [
                { key: "name", label: "Name", prompt: "Name to engrave" },
              ],
            },
            actionOutcomes: {
              version: 1,
              noReply: { enabled: true, timeoutMinutes: 30 },
            },
          },
        },
        {
          id: "engrave",
          data: {
            kind: "action",
            actionType: "reply",
            actionReplyMode: "fixed",
            actionReplyText: "Engraving your medal",
          },
        },
        {
          id: "reminder",
          data: {
            kind: "action",
            actionType: "reply",
            actionReplyMode: "fixed",
            actionReplyText: "Still want your medal?",
          },
        },
      ],
      edges: [
        { source: "trigger-1", target: "ask" },
        { source: "ask", sourceHandle: "right-source", target: "engrave" },
        {
          source: "ask",
          sourceHandle: buildScenarioActionOutcomeHandleId("no_reply"),
          target: "reminder",
        },
      ],
    };
    setActiveScenarios([scenario]);

    const result = await resolveRuntime({
      triggerMessageText: "medal",
    });

    expect(result.runtime).toMatchObject({
      selectedActionNodeId: "ask",
      nextActionNodeId: "ask",
      pendingConditionNodeId: getScenarioActionOutcomeVirtualNodeId("ask"),
      actionPromptInputsMetTransition: {
        nextActionNodeId: "engrave",
        completesScenario: false,
      },
    });
  });

  it("uses a canonical service message AI body as the runtime instruction", async () => {
    const scenario = {
      _id: "507f191e810c19729de860bd",
      name: "Generated service reply",
      priority: 20,
      entryPolicy: "once_per_conversation" as const,
      matchingRole: "default",
      updatedAt: new Date("2026-07-29T00:00:00.000Z"),
      nodes: [
        {
          id: "trigger-1",
          data: {
            kind: "trigger",
            triggerConfig: { enabled: true },
          },
        },
        {
          id: "service-1",
          data: {
            kind: "action",
            actionType: "reply",
            actionReplyMode: "fixed",
            actionReplyChannel: "whatsapp",
            actionReplyText: "stale fixed copy",
            actionReplyInstruction: "stale instruction",
            actionWhatsAppServiceMessage: {
              version: 1,
              message: {
                kind: "reply_buttons",
                body: {
                  mode: "ai",
                  instruction: "Answer from the selected knowledge",
                },
                options: [{ id: "details", label: "Details" }],
              },
            },
          },
        },
      ],
      edges: [{ source: "trigger-1", target: "service-1" }],
    };
    setActiveScenarios([scenario]);

    const result = await resolveRuntime({
      triggerMessageText: "details",
    });

    expect(result.runtime).toMatchObject({
      actionReplyMode: "ai",
      actionReplyInstruction: "Answer from the selected knowledge",
      actionWhatsAppServiceMessage:
        scenario.nodes[1]?.data.actionWhatsAppServiceMessage,
    });
    expect(result.runtime?.actionReplyText).toBeUndefined();
  });

  it.each([
    {
      id: "507f191e810c19729de860be",
      canonical: {
        version: 2,
        message: {
          kind: "text",
          body: { mode: "fixed", text: "future copy" },
        },
      },
      reason: "whatsapp_service_message_unsupported",
    },
    {
      id: "507f191e810c19729de860c1",
      canonical: null,
      reason: "whatsapp_service_message_invalid",
    },
  ] as const)(
    "blocks a $reason canonical action instead of using generic copy or another scenario",
    async ({ id, canonical, reason }) => {
      const scenario = {
        _id: id,
        name: "Blocked service reply",
        priority: 40,
        entryPolicy: "once_per_conversation" as const,
        matchingRole: "default",
        updatedAt: new Date("2026-07-29T00:00:00.000Z"),
        nodes: [
          {
            id: "trigger-1",
            data: {
              kind: "trigger",
              triggerConfig: { enabled: true },
            },
          },
          {
            id: "service-1",
            data: {
              kind: "action",
              actionType: "reply",
              actionReplyMode: "fixed",
              actionReplyChannel: "whatsapp",
              actionReplyText: "must not be sent",
              actionWhatsAppServiceMessage: canonical,
            },
          },
        ],
        edges: [{ source: "trigger-1", target: "service-1" }],
      };
      const lowerPriorityScenario = createScenario({
        id: "507f191e810c19729de860bf",
        name: "Must not replace the blocked scenario",
        priority: 10,
        replyText: "must not be sent either",
      });
      setActiveScenarios([lowerPriorityScenario, scenario]);

      const result = await resolveRuntime({
        triggerMessageText: "hello",
      });

      expect(result.runtime).toBeNull();
      expect(result.blockedScenarioAction).toEqual({
        reason,
        scenarioId: scenario._id,
        actionNodeId: "service-1",
      });
    }
  );

  it("sends a reply whose message key is left undefined as its own copy", async () => {
    // The builder's type change leaves the key set to undefined; that is no
    // service message, while a saved null above still blocks.
    const scenario = {
      _id: "507f191e810c19729de860c2",
      name: "Plain reply",
      priority: 40,
      entryPolicy: "once_per_conversation" as const,
      matchingRole: "default",
      updatedAt: new Date("2026-07-29T00:00:00.000Z"),
      nodes: [
        {
          id: "trigger-1",
          data: {
            kind: "trigger",
            triggerConfig: { enabled: true },
          },
        },
        {
          id: "reply-1",
          data: {
            kind: "action",
            actionType: "reply",
            actionReplyMode: "fixed",
            actionReplyChannel: "whatsapp",
            actionReplyText: "plain copy",
            actionWhatsAppServiceMessage: undefined,
          },
        },
      ],
      edges: [{ source: "trigger-1", target: "reply-1" }],
    };
    setActiveScenarios([scenario]);

    const result = await resolveRuntime({
      triggerMessageText: "hello",
    });

    expect(result.blockedScenarioAction).toBeUndefined();
    expect(result.runtime).toMatchObject({
      selectedActionNodeId: "reply-1",
      actionReplyMode: "fixed",
      actionReplyText: "plain copy",
    });
  });

  it("propagates a blocked canonical action from forced resolution", async () => {
    const scenario = {
      _id: "507f191e810c19729de860c0",
      name: "Forced future service reply",
      priority: 20,
      entryPolicy: "once_per_conversation" as const,
      matchingRole: "default",
      updatedAt: new Date("2026-07-29T00:00:00.000Z"),
      nodes: [
        {
          id: "trigger-1",
          data: {
            kind: "trigger",
            triggerConfig: { enabled: true },
          },
        },
        {
          id: "service-1",
          data: {
            kind: "action",
            actionType: "reply",
            actionReplyMode: "fixed",
            actionReplyChannel: "whatsapp",
            actionReplyText: "must not be sent",
            actionWhatsAppServiceMessage: {
              version: 2,
              message: {
                kind: "text",
                body: { mode: "fixed", text: "future copy" },
              },
            },
          },
        },
      ],
      edges: [{ source: "trigger-1", target: "service-1" }],
    };
    mockScenarioFindOne.mockReturnValue(createSelectLeanQuery(scenario));

    const result = await resolveRuntime({
      forcedScenarioId: scenario._id,
      triggerMessageText: "hello",
    });

    expect(result).toMatchObject({
      runtime: null,
      blockedScenarioAction: {
        reason: "whatsapp_service_message_unsupported",
        scenarioId: scenario._id,
        actionNodeId: "service-1",
      },
    });
  });

  it("carries a canonical WhatsApp service message as the sole WhatsApp owner", async () => {
    const serviceMessage = {
      version: 1 as const,
      message: {
        kind: "reply_buttons" as const,
        body: { mode: "fixed" as const, text: "Choose one" },
        options: [{ id: "yes", label: "Yes" }],
      },
    };
    const scenario = {
      _id: "507f191e810c19729de860bd",
      name: "Canonical service message",
      priority: 20,
      entryPolicy: "once_per_conversation" as const,
      matchingRole: "default",
      updatedAt: new Date("2026-07-10T00:00:00.000Z"),
      nodes: [
        {
          id: "trigger-1",
          data: {
            kind: "trigger",
            triggerConfig: { enabled: true },
          },
        },
        {
          id: "service-1",
          data: {
            kind: "action",
            actionType: "reply",
            actionReplyChannel: "whatsapp",
            actionWhatsAppServiceMessage: serviceMessage,
          },
        },
      ],
      edges: [{ source: "trigger-1", target: "service-1" }],
    };
    setActiveScenarios([scenario]);

    const result = await resolveRuntime({
      triggerMessageText: "start",
    });

    expect(result.runtime).toMatchObject({
      selectedActionNodeId: "service-1",
      actionReplyMode: "fixed",
      actionReplyChannel: "whatsapp",
      actionReplyText: "Choose one",
      actionWhatsAppServiceMessage: serviceMessage,
    });
  });

  it("routes a multi-trigger scenario from the most specific matching trigger branch", async () => {
    const multiTriggerScenario = createMultiTriggerScenario();
    setActiveScenarios([multiTriggerScenario]);

    const result = await resolveRuntime({
      triggerMessageText: "buy product",
    });

    expect(result.runtime?.scenarioId).toBe(multiTriggerScenario._id);
    expect(result.runtime?.actionReplyText).toBe("exact branch");

    const winnerLog = getLoggedScenarioEvaluations().find(
      entry => entry.result === "winner"
    );
    expect(winnerLog).not.toHaveProperty("triggerType");
    expect(winnerLog).toMatchObject({
      selectedActionNodeId: "action-exact",
      meta: expect.objectContaining({
        triggerNodeId: "trigger-exact",
        filters: expect.objectContaining({
          messageMatchMode: "exact",
        }),
      }),
    });
  });

  it("keeps production and preview aligned on event-time root specificity", async () => {
    const mixedScenario = createMixedSpecificityScenario();
    const containsScenario = createScenario({
      id: "507f191e810c19729de860fe",
      name: "Refund contains",
      priority: 20,
      triggerConfig: {
        enabled: true,
        messageMatchMode: "contains",
        keywordPattern: "refund",
        keywordMatchMode: "contains",
      },
      replyText: "refund branch",
    });
    const scenarios = [mixedScenario, containsScenario];
    setActiveScenarios(scenarios);

    const production = await resolveRuntime({
      triggerMessageText: "please refund this order",
    });
    const preview = await previewScenarioEvaluation({
      workspaceId: "workspace-1",
      conversation: { _id: "conv-1" } as never,
      channel: "whatsapp",
      eventKind: "inbound_message",
      messageText: "please refund this order",
      scenarios,
    });

    expect(production.runtime).toMatchObject({
      scenarioId: containsScenario._id,
      selectedActionNodeId: `${containsScenario._id}-action`,
      actionReplyText: "refund branch",
    });
    expect(preview.winner).toMatchObject({
      scenarioId: containsScenario._id,
      triggerNodeId: `${containsScenario._id}-trigger`,
      selectedActionNodeId: `${containsScenario._id}-action`,
    });
  });

  it("keeps production and preview aligned when only a fallback root matches", async () => {
    const nonmatchingDefault = createScenario({
      id: "507f191e810c19729de861ad",
      name: "Specific default",
      priority: 999,
      triggerConfig: {
        enabled: true,
        messageMatchMode: "exact",
        keywordPattern: "specific",
      },
      replyText: "specific default",
    });
    const fallback = createScenario({
      id: "507f191e810c19729de861ae",
      name: "Fallback start",
      priority: 1,
      matchingRole: "fallback",
      replyText: "fallback start",
    });
    const scenarios = [nonmatchingDefault, fallback];
    setActiveScenarios(scenarios);

    const production = await resolveRuntime({
      triggerMessageText: "hello",
    });
    const preview = await previewScenarioEvaluation({
      workspaceId: "workspace-1",
      conversation: { _id: "conv-1" } as never,
      channel: "whatsapp",
      eventKind: "inbound_message",
      messageText: "hello",
      scenarios,
    });

    expect(production.runtime).toMatchObject({
      scenarioId: fallback._id,
      selectedActionNodeId: `${fallback._id}-action`,
      actionReplyText: "fallback start",
    });
    expect(preview.winner).toMatchObject({
      scenarioId: fallback._id,
      triggerNodeId: `${fallback._id}-trigger`,
      selectedActionNodeId: `${fallback._id}-action`,
    });
  });

  it("keeps production and preview aligned on stable scenario ID ties", async () => {
    const firstById = createScenario({
      id: "507f191e810c19729de861b2",
      name: "First exact tie",
      priority: 50,
      triggerConfig: {
        enabled: true,
        messageMatchMode: "exact",
        keywordPattern: "tie",
      },
      replyText: "first exact tie",
    });
    const secondById = createScenario({
      id: "507f191e810c19729de861b3",
      name: "Second exact tie",
      priority: 50,
      triggerConfig: {
        enabled: true,
        messageMatchMode: "exact",
        keywordPattern: "tie",
      },
      replyText: "second exact tie",
    });
    const scenarios = [secondById, firstById];
    setActiveScenarios(scenarios);

    const production = await resolveRuntime({
      triggerMessageText: "tie",
    });
    const preview = await previewScenarioEvaluation({
      workspaceId: "workspace-1",
      conversation: { _id: "conv-1" } as never,
      channel: "whatsapp",
      eventKind: "inbound_message",
      messageText: "tie",
      scenarios,
    });
    const productionWinner = getLoggedScenarioEvaluations().find(
      entry => entry.result === "winner"
    );
    const productionWinnerMeta = productionWinner?.meta as
      | { triggerNodeId?: string | null }
      | undefined;

    expect({
      scenarioId: production.runtime?.scenarioId,
      triggerNodeId: productionWinnerMeta?.triggerNodeId,
      actionNodeId: production.runtime?.selectedActionNodeId,
    }).toEqual({
      scenarioId: preview.winner?.scenarioId,
      triggerNodeId: preview.winner?.triggerNodeId,
      actionNodeId: preview.winner?.selectedActionNodeId,
    });
    expect(preview.winner).toMatchObject({
      scenarioId: firstById._id,
      triggerNodeId: `${firstById._id}-trigger`,
      selectedActionNodeId: `${firstById._id}-action`,
    });
  });

  it("keeps linked children and disabled legacy roots out of production and preview top-level selection", async () => {
    const linkedChild = {
      ...createScenario({
        id: "507f191e810c19729de861af",
        name: "Linked child",
        priority: 999,
        triggerConfig: {
          enabled: true,
          messageMatchMode: "exact",
          keywordPattern: "hello",
        },
        replyText: "linked child",
      }),
      nodes: [
        {
          id: "linked-root",
          data: makeClientMessageTriggerNode({
            linkedConditionId: "condition-1",
            triggerConfig: {
              enabled: true,
              messageMatchMode: "exact",
              keywordPattern: "hello",
            },
          }),
        },
        {
          id: "linked-action",
          data: {
            kind: "action",
            actionType: "reply",
            actionReplyMode: "fixed",
            actionReplyText: "linked child",
          },
        },
      ],
      edges: [{ source: "linked-root", target: "linked-action" }],
    };
    const disabledLegacy = {
      ...createScenario({
        id: "507f191e810c19729de861b0",
        name: "Retired payment root",
        priority: 998,
        triggerConfig: {
          enabled: true,
          messageMatchMode: "exact",
          keywordPattern: "other",
        },
        replyText: "other canonical branch",
      }),
      nodes: [
        {
          id: "retired-payment-root",
          data: makeLegacyPersistedTrigger("payment_detected"),
        },
        {
          id: "canonical-other-root",
          data: makeClientMessageTriggerNode({
            triggerConfig: {
              enabled: true,
              messageMatchMode: "exact",
              keywordPattern: "other",
            },
          }),
        },
        {
          id: "retired-payment-action",
          data: {
            kind: "action",
            actionType: "reply",
            actionReplyMode: "fixed",
            actionReplyText: "retired payment",
          },
        },
        {
          id: "canonical-other-action",
          data: {
            kind: "action",
            actionType: "reply",
            actionReplyMode: "fixed",
            actionReplyText: "other canonical branch",
          },
        },
      ],
      edges: [
        {
          source: "retired-payment-root",
          target: "retired-payment-action",
        },
        {
          source: "canonical-other-root",
          target: "canonical-other-action",
        },
      ],
    };
    const ordinary = createScenario({
      id: "507f191e810c19729de861b1",
      name: "Ordinary Any root",
      priority: 1,
      replyText: "ordinary winner",
    });
    const scenarios = [linkedChild, disabledLegacy, ordinary];
    setActiveScenarios(scenarios);

    const production = await resolveRuntime({
      triggerMessageText: "hello",
    });
    const preview = await previewScenarioEvaluation({
      workspaceId: "workspace-1",
      conversation: { _id: "conv-1" } as never,
      channel: "whatsapp",
      eventKind: "inbound_message",
      messageText: "hello",
      scenarios,
    });

    expect(production.runtime).toMatchObject({
      scenarioId: ordinary._id,
      selectedActionNodeId: `${ordinary._id}-action`,
      actionReplyText: "ordinary winner",
    });
    expect(preview.winner).toMatchObject({
      scenarioId: ordinary._id,
      triggerNodeId: `${ordinary._id}-trigger`,
      selectedActionNodeId: `${ordinary._id}-action`,
    });
    expect(preview.evaluations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scenarioId: ordinary._id,
          result: "winner",
        }),
        expect.objectContaining({
          scenarioId: disabledLegacy._id,
          result: "skipped",
          reason: "trigger_mismatch",
        }),
      ])
    );
    expect(preview.evaluations).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scenarioId: linkedChild._id,
        }),
      ])
    );
  });

  it("returns preview candidates and winners without a trigger-type dimension", async () => {
    const multiTriggerScenario = createMultiTriggerScenario();

    const preview = await previewScenarioEvaluation({
      workspaceId: "workspace-1",
      conversation: { _id: "conv-1" } as never,
      channel: "whatsapp",
      eventKind: "inbound_message",
      messageText: "buy product",
      scenarios: [multiTriggerScenario],
    });

    expect(preview.winner).toMatchObject({
      scenarioId: multiTriggerScenario._id,
      triggerNodeId: "trigger-exact",
      result: "winner",
    });
    expect(preview.winner).not.toHaveProperty("triggerType");
    expect(preview.evaluations).toHaveLength(1);
    expect(preview.evaluations[0]).not.toHaveProperty("triggerType");
  });

  it("keeps stale explicit child trigger ids on the legacy primary-trigger fallback", async () => {
    const multiTriggerScenario = createMultiTriggerScenario();
    setLockedScenario(multiTriggerScenario);

    const result = await resolveRuntime({
      forcedScenarioId: multiTriggerScenario._id,
      forcedTriggerNodeId: "deleted-trigger",
      triggerMessageText: "buy product",
    });

    expect(result.runtime?.scenarioId).toBe(multiTriggerScenario._id);
    expect(result.runtime?.actionReplyText).toBe("generic branch");

    const winnerLog = getLoggedScenarioEvaluations().find(
      entry => entry.result === "winner"
    );
    expect(winnerLog).not.toHaveProperty("triggerType");
    expect(winnerLog).toMatchObject({
      selectedActionNodeId: "action-catch-all",
      meta: expect.objectContaining({
        triggerNodeId: "trigger-catch-all",
      }),
    });
  });

  it("keeps a linked-condition child available for forced runtime continuation", async () => {
    const linkedScenario = {
      ...createScenario({
        id: "507f191e810c19729de861b4",
        name: "Forced linked child",
        priority: 60,
        triggerConfig: {
          enabled: true,
          messageMatchMode: "exact",
          keywordPattern: "continue",
        },
        replyText: "forced linked continuation",
      }),
      nodes: [
        {
          id: "forced-linked-root",
          data: makeClientMessageTriggerNode({
            linkedConditionId: "condition-1",
            triggerConfig: {
              enabled: true,
              messageMatchMode: "exact",
              keywordPattern: "continue",
            },
          }),
        },
        {
          id: "forced-linked-action",
          data: {
            kind: "action",
            actionType: "reply",
            actionReplyMode: "fixed",
            actionReplyText: "forced linked continuation",
          },
        },
      ],
      edges: [
        {
          source: "forced-linked-root",
          target: "forced-linked-action",
        },
      ],
    };
    setLockedScenario(linkedScenario);

    const result = await resolveRuntime({
      forcedScenarioId: linkedScenario._id,
      triggerMessageText: "continue",
    });

    expect(result.runtime).toMatchObject({
      scenarioId: linkedScenario._id,
      selectedActionNodeId: "forced-linked-action",
      actionReplyText: "forced linked continuation",
    });
    expect(mockScenarioFind).not.toHaveBeenCalled();
  });

  it("does not fall through a post-action event into top-level roots", async () => {
    setActiveScenarios([fallbackScenario]);

    const result = await resolveRuntime({
      triggerEventKind: "payment_detected",
      triggerMessageText: "hello",
    });

    expect(result.runtime).toBeNull();
    expect(mockScenarioFind).not.toHaveBeenCalled();
    expect(getLoggedScenarioEvaluations()).toEqual([]);
  });

  it("preserves the missing-lock diagnostic for post-action events without evaluating roots", async () => {
    setActiveScenarios([fallbackScenario]);

    const result = await resolveRuntime({
      scenarioState: {
        lockedScenarioId: "507f191e810c19729de861b5",
        lockedScenarioName: "Deleted payment continuation",
        currentActionNodeId: "deleted-action",
      },
      triggerEventKind: "payment_detected",
    });

    expect(result).toEqual({
      runtime: null,
      lockedScenarioMissing: {
        scenarioId: "507f191e810c19729de861b5",
        scenarioName: "Deleted payment continuation",
      },
    });
    expect(mockScenarioFind).not.toHaveBeenCalled();
    expect(getLoggedScenarioEvaluations()).toEqual([]);
  });

  it("continues a locked scenario for a post-action event without evaluating ingress roots", async () => {
    const lockedScenario = createScenario({
      id: "507f191e810c19729de861ab",
      name: "Locked payment continuation",
      priority: 60,
      replyText: "continue locked payment",
    });
    setLockedScenario(lockedScenario);

    const result = await resolveRuntime({
      scenarioState: {
        lockedScenarioId: lockedScenario._id,
        lockedScenarioName: lockedScenario.name,
        currentActionNodeId: `${lockedScenario._id}-action`,
      },
      triggerEventKind: "payment_detected",
    });

    expect(result.runtime).toMatchObject({
      scenarioId: lockedScenario._id,
      selectedActionNodeId: `${lockedScenario._id}-action`,
      actionReplyText: "continue locked payment",
      lockedByConversationState: true,
    });
    expect(mockScenarioFind).not.toHaveBeenCalled();
  });

  it("continues a once-per-conversation scenario from a text prompt to unsent buttons", async () => {
    const scenario = createScenario({
      id: "507f191e810c19729de861d9",
      name: "Company intake",
      priority: 60,
      entryPolicy: "once_per_conversation",
      triggerConfig: { enabled: true, messageMatchMode: "any" },
      replyText: "Company name?",
    });
    const promptId = `${scenario._id}-action`;
    const buttonsId = "company-intake-buttons";
    scenario.nodes.push({
      id: buttonsId,
      data: {
        kind: "action",
        actionType: "reply",
        actionWhatsAppServiceMessage: {
          version: 1,
          message: {
            kind: "reply_buttons",
            body: { mode: "fixed", text: "What would you like first?" },
            options: [{ id: "pricing", label: "Pricing" }],
          },
        },
      },
    });
    scenario.edges.push({
      source: promptId,
      target: buttonsId,
      sourceHandle: "right-source",
    });
    setActiveScenarios([scenario]);
    const ingress = {
      workspaceId: "workspace-1",
      conversation: { _id: "conv-1" } as never,
      channel: "whatsapp" as const,
      triggerEventKind: "inbound_message" as const,
    };
    const initial = await resolveActiveScenarioRuntime({
      ...ingress,
      triggerMessageText: "Hello",
    });
    expect(initial.runtime).toMatchObject({
      selectedActionNodeId: promptId,
      nextActionNodeId: buttonsId,
      scenarioUpdatedAt: scenario.updatedAt.toISOString(),
    });
    setLockedScenario(scenario);
    mockScenarioFind.mockClear();

    const continuation = await resolveActiveScenarioRuntime({
      ...ingress,
      triggerMessageText: "Airi.chat",
      scenarioState: {
        lockedScenarioId: scenario._id,
        lockedScenarioName: scenario.name,
        currentActionNodeId: initial.runtime?.nextActionNodeId,
        currentPathNodeIds: initial.runtime?.selectedPathNodeIds,
        startedScenarios: [
          {
            scenarioId: scenario._id,
            startedAt: new Date("2026-09-05T00:00:00.000Z"),
          },
        ],
      },
    });
    expect(continuation.runtime).toMatchObject({
      scenarioId: scenario._id,
      selectedActionNodeId: buttonsId,
      lockedByConversationState: true,
      actionWhatsAppServiceMessage: { message: { kind: "reply_buttons" } },
    });
    expect(mockScenarioFind).not.toHaveBeenCalled();
  });

  it("does not let an ignored lock turn a post-action event into root selection", async () => {
    const lockedScenario = createScenario({
      id: "507f191e810c19729de861ac",
      name: "Ignored payment continuation",
      priority: 60,
      replyText: "must remain ignored",
    });
    setLockedScenario(lockedScenario);

    const result = await resolveRuntime({
      scenarioState: {
        lockedScenarioId: lockedScenario._id,
        lockedScenarioName: lockedScenario.name,
        currentActionNodeId: `${lockedScenario._id}-action`,
      },
      triggerEventKind: "payment_detected",
      ignoreLockedScenario: true,
    });

    expect(result.runtime).toBeNull();
    expect(mockScenarioFind).not.toHaveBeenCalled();
    expect(getLoggedScenarioEvaluations()).toEqual([]);
  });

  it("routes bulk campaign template quick replies without requiring a trigger node", async () => {
    const payload = buildWhatsAppTemplateButtonPayload("tpl-1", 0);
    const bulkScenario = {
      _id: "65f000000000000000000001",
      name: "VIP bulk follow-up",
      priority: 5,
      entryPolicy: "once_per_conversation" as const,
      matchingRole: "default",
      updatedAt: new Date("2026-05-15T00:00:00.000Z"),
      nodes: [
        {
          id: "bulk-1",
          data: {
            kind: "bulk",
            bulkRootConfig: {
              workflowKind: "bulk_campaign",
              sendMode: "immediate",
              channels: ["whatsapp"],
              campaignName: "VIP bulk",
              recipientSourceSummary: "CSV upload",
              generationStatus: "idle",
            },
          },
        },
        {
          id: "tpl-1",
          data: {
            kind: "action",
            actionType: "whatsapp_template",
            actionWhatsAppTemplateName: "vip_offer",
            actionWhatsAppTemplateLanguage: "en",
            actionWhatsAppTemplateComponents: [
              {
                type: "BUTTONS",
                buttons: [{ type: "QUICK_REPLY", text: "Interested" }],
              },
            ],
          },
        },
        {
          id: "follow-1",
          data: {
            kind: "action",
            actionType: "reply",
            actionReplyMode: "fixed",
            actionReplyText: "Thanks, here is the next step.",
            whatsAppTemplateButtonPayload: payload,
          },
        },
      ],
      edges: [
        { source: "bulk-1", sourceHandle: "right-source", target: "tpl-1" },
        {
          source: "tpl-1",
          sourceHandle: "right-source-whatsapp-template-button-branch::0",
          target: "follow-1",
        },
      ],
    };
    setActiveScenarios([bulkScenario]);

    const result = await resolveRuntime({
      triggerEventKind: "whatsapp_button_reply",
      quickReplyPayload: payload,
    });

    expect(result.runtime?.scenarioId).toBe(bulkScenario._id);
    expect(result.runtime?.selectedActionNodeId).toBe("follow-1");
    expect(result.runtime?.selectedPathNodeIds).toEqual([
      "bulk-1",
      "tpl-1",
      "follow-1",
    ]);
  });

  it("routes bulk campaign template Flow radio replies without requiring a trigger node", async () => {
    const bulkScenario = {
      _id: "65f000000000000000000002",
      name: "VIP bulk flow follow-up",
      priority: 5,
      entryPolicy: "once_per_conversation" as const,
      matchingRole: "default",
      updatedAt: new Date("2026-05-15T00:00:00.000Z"),
      nodes: [
        {
          id: "bulk-1",
          data: {
            kind: "bulk",
            bulkRootConfig: {
              workflowKind: "bulk_campaign",
              sendMode: "immediate",
              channels: ["whatsapp"],
              campaignName: "VIP bulk",
              recipientSourceSummary: "CSV upload",
              generationStatus: "idle",
            },
          },
        },
        {
          id: "tpl-1",
          data: {
            kind: "action",
            actionType: "whatsapp_template",
            actionWhatsAppTemplateName: "vip_offer_flow",
            actionWhatsAppTemplateLanguage: "en",
            actionFlowConfig: {
              screens: [
                {
                  id: "lead",
                  fields: [
                    {
                      id: "message",
                      fieldType: "RadioButtonsGroup",
                      options: [{ id: "opt_1", title: "Interested" }],
                    },
                  ],
                },
              ],
            },
          },
        },
        {
          id: "follow-1",
          data: {
            kind: "action",
            actionType: "reply",
            actionReplyMode: "fixed",
            actionReplyText: "Thanks, here is the Flow follow-up.",
          },
        },
      ],
      edges: [
        { source: "bulk-1", sourceHandle: "right-source", target: "tpl-1" },
        {
          source: "tpl-1",
          sourceHandle: buildFlowBranchSourceHandleId("message", "opt_1"),
          target: "follow-1",
        },
      ],
    };
    setActiveScenarios([bulkScenario]);

    const result = await resolveRuntime({
      triggerEventKind: "whatsapp_flow_reply",
      whatsAppFlowResponseJson: JSON.stringify({
        message: "opt_1",
        flow_token: "bulk:65f000000000000000000002:tpl-1",
      }),
    });

    expect(result.runtime?.scenarioId).toBe(bulkScenario._id);
    expect(result.runtime?.selectedActionNodeId).toBe("follow-1");
    expect(result.runtime?.selectedPathNodeIds).toEqual([
      "bulk-1",
      "tpl-1",
      "follow-1",
    ]);
  });

  describe("taps on bulk campaign template buttons", () => {
    /** A trigger-less bulk scenario: its template's buttons route to follow-ups. */
    const bulkButtonScenario = (
      scenarioId: string,
      prefix: string,
      labels: string[]
    ) => ({
      _id: scenarioId,
      name: `Bulk ${prefix}`,
      priority: 5,
      entryPolicy: "once_per_conversation" as const,
      matchingRole: "default",
      updatedAt: new Date("2026-10-05T00:00:00.000Z"),
      nodes: [
        {
          id: `${prefix}-bulk`,
          data: {
            kind: "bulk",
            bulkRootConfig: {
              workflowKind: "bulk_campaign",
              sendMode: "immediate",
              channels: ["whatsapp"],
              campaignName: `Bulk ${prefix}`,
              recipientSourceSummary: "CSV upload",
              generationStatus: "idle",
            },
          },
        },
        {
          id: `${prefix}-tpl`,
          data: {
            kind: "action",
            actionType: "whatsapp_template",
            actionWhatsAppTemplateName: `${prefix}_offer`,
            actionWhatsAppTemplateLanguage: "en",
            actionWhatsAppTemplateComponents: [
              {
                type: "BUTTONS",
                buttons: labels.map(text => ({ type: "QUICK_REPLY", text })),
              },
            ],
          },
        },
        ...labels.map((label, index) => ({
          id: `${prefix}-follow-${index}`,
          data: {
            kind: "action",
            actionType: "reply",
            actionReplyMode: "fixed",
            actionReplyText: `${label} details`,
            whatsAppTemplateButtonPayload: buildWhatsAppTemplateButtonPayload(
              `${prefix}-tpl`,
              index
            ),
          },
        })),
      ],
      edges: [
        {
          source: `${prefix}-bulk`,
          sourceHandle: "right-source",
          target: `${prefix}-tpl`,
        },
        ...labels.map((_, index) => ({
          source: `${prefix}-tpl`,
          sourceHandle: `right-source-whatsapp-template-button-branch::${index}`,
          target: `${prefix}-follow-${index}`,
        })),
      ],
    });
    const fall = bulkButtonScenario("65f000000000000000000101", "fall", [
      "Coats",
      "Boots",
    ]);

    it("does not let a bulk scenario take a tap on a template sent without our payload", async () => {
      // A template sent from Campaigns or the inbox returns its button label.
      setActiveScenarios([fall]);

      const result = await resolveRuntime({
        quickReplyPayload: "Boots",
        triggerMessageText: "Boots",
      });

      expect(result.runtime).toBeNull();
      expect(
        getLoggedScenarioEvaluations().map(entry => entry.eventKind)
      ).not.toContain("whatsapp_button_reply");
    });

    const winter = bulkButtonScenario("65f000000000000000000102", "winter", [
      "Scarves",
    ]);
    // A later campaign took the lock and waits on its own template's buttons.
    const lockedToWinter = {
      lockedScenarioId: winter._id,
      lockedScenarioName: winter.name,
      currentActionNodeId: "winter-tpl",
      currentPathNodeIds: ["winter-bulk", "winter-tpl"],
      startedScenarios: [
        {
          scenarioId: winter._id,
          scenarioName: winter.name,
          startedAt: "2026-10-06T08:00:00.000Z",
          firstActionNodeId: "winter-tpl",
        },
      ],
    };

    it("routes a tap on an older campaign's button after a later campaign took the lock", async () => {
      setActiveScenarios([fall, winter]);
      setLockedScenario(winter);

      const result = await resolveRuntime({
        triggerEventKind: "whatsapp_button_reply",
        quickReplyPayload: buildWhatsAppTemplateButtonPayload("fall-tpl", 1),
        scenarioState: lockedToWinter,
      });

      expect(result.lockedScenarioNoMatch).toBeUndefined();
      expect(result.runtime?.scenarioId).toBe(fall._id);
      expect(result.runtime?.selectedActionNodeId).toBe("fall-follow-1");
    });

    it("keeps a tap on an older campaign's button with the lock while its No-reply follow-up waits", async () => {
      setActiveScenarios([fall, winter]);
      setLockedScenario(winter);

      const result = await resolveRuntime({
        triggerEventKind: "whatsapp_button_reply",
        quickReplyPayload: buildWhatsAppTemplateButtonPayload("fall-tpl", 1),
        scenarioState: lockedToWinter,
        lockedScenarioFollowUpPending: true,
      });

      // The older campaign's route would end the later one's follow-up.
      expect(result.runtime).toBeNull();
      expect(result.lockedScenarioNoMatch?.scenarioId).toBe(winter._id);
      expect(mockScenarioFind).not.toHaveBeenCalled();
    });

    it("keeps a tap on the locked campaign's own button in that campaign", async () => {
      setActiveScenarios([fall, winter]);
      setLockedScenario(winter);

      const result = await resolveRuntime({
        triggerEventKind: "whatsapp_button_reply",
        quickReplyPayload: buildWhatsAppTemplateButtonPayload("winter-tpl", 0),
        scenarioState: lockedToWinter,
      });

      expect(result.runtime?.scenarioId).toBe(winter._id);
      expect(result.runtime?.selectedActionNodeId).toBe("winter-follow-0");
      // Pinned to the lock: no other active scenario was read.
      expect(mockScenarioFind).not.toHaveBeenCalled();
    });

    it("still reports the locked campaign's miss when no active scenario has the tapped step", async () => {
      // The older campaign was turned off after its template went out.
      setActiveScenarios([winter]);
      setLockedScenario(winter);

      const result = await resolveRuntime({
        triggerEventKind: "whatsapp_button_reply",
        quickReplyPayload: buildWhatsAppTemplateButtonPayload("fall-tpl", 1),
        scenarioState: lockedToWinter,
      });

      expect(result.runtime).toBeNull();
      expect(result.lockedScenarioNoMatch?.scenarioId).toBe(winter._id);
    });
  });

  it("uses a forced post-action branch target even when the target template has quick replies", async () => {
    const scenario = {
      _id: "65f000000000000000000003",
      name: "No reply branch follow-up",
      priority: 5,
      entryPolicy: "once_per_conversation" as const,
      matchingRole: "default",
      updatedAt: new Date("2026-05-15T00:00:00.000Z"),
      nodes: [
        {
          id: "trigger-1",
          data: {
            kind: "trigger",
            triggerConfig: { enabled: true },
          },
        },
        {
          id: "entry-template",
          data: {
            kind: "action",
            actionType: "whatsapp_template",
            actionWhatsAppTemplateName: "pick_lang",
            actionWhatsAppTemplateLanguage: "en",
          },
        },
        {
          id: "follow-template",
          data: {
            kind: "action",
            actionType: "whatsapp_template",
            actionWhatsAppTemplateName: "dozhim_1",
            actionWhatsAppTemplateLanguage: "en",
            actionWhatsAppTemplateComponents: [
              {
                type: "BUTTONS",
                buttons: [{ type: "QUICK_REPLY", text: "Interested" }],
              },
            ],
          },
        },
      ],
      edges: [
        {
          source: "trigger-1",
          sourceHandle: "right-source",
          target: "entry-template",
        },
        {
          source: "entry-template",
          sourceHandle: "right-source",
          target: "follow-template",
        },
      ],
    };
    setLockedScenario(scenario);

    const result = await resolveRuntime({
      scenarioState: {
        lockedScenarioId: scenario._id,
        lockedScenarioName: scenario.name,
        currentActionNodeId: "entry-template",
      },
      forcedScenarioId: scenario._id,
      forcedActionNodeId: "follow-template",
      triggerEventKind: "no_human_reply_timeout",
    });

    expect(result.runtime?.selectedActionNodeId).toBe("follow-template");
    expect(result.runtime?.actionWhatsAppTemplateName).toBe("dozhim_1");
    expect(mockScenarioFind).not.toHaveBeenCalled();
  });

  it("continues a claimed wait behind an earlier Any reply outcome", async () => {
    const scenario = {
      _id: "65f000000000000000000042",
      name: "Reminder after a reply",
      priority: 5,
      entryPolicy: "once_per_conversation" as const,
      matchingRole: "default",
      updatedAt: new Date("2026-09-27T00:00:00.000Z"),
      nodes: [
        { id: "trigger-1", data: makeClientMessageTriggerNode() },
        {
          id: "welcome",
          data: {
            kind: "action",
            actionType: "reply",
            actionReplyMode: "fixed",
            actionReplyText: "What are you looking for?",
            actionOutcomes: { version: 1, anyReply: { enabled: true } },
          },
        },
        {
          id: "offer",
          data: {
            kind: "action",
            actionType: "reply",
            actionReplyMode: "fixed",
            actionReplyText: "Here is our offer.",
            actionOutcomes: {
              version: 1,
              noReply: { enabled: true, timeoutMinutes: 60 },
            },
          },
        },
        {
          id: "reminder",
          data: {
            kind: "action",
            actionType: "reply",
            actionReplyMode: "fixed",
            actionReplyText: "Still interested?",
          },
        },
      ],
      edges: [
        { source: "trigger-1", target: "welcome" },
        {
          source: "welcome",
          sourceHandle: buildScenarioActionOutcomeHandleId("any_reply"),
          target: "offer",
        },
        {
          source: "offer",
          sourceHandle: buildScenarioActionOutcomeHandleId("no_reply"),
          target: "reminder",
        },
      ],
    };
    setLockedScenario(scenario);
    const continueFromOffer = (pendingSourceActionNodeId?: string) =>
      resolveRuntime({
        // The pending-wait continuation keeps the claimed wait in the state.
        scenarioState: {
          lockedScenarioId: scenario._id,
          lockedScenarioName: scenario.name,
          currentActionNodeId: "reminder",
          pendingConditionNodeId:
            getScenarioActionOutcomeVirtualNodeId("offer"),
          pendingSourceActionNodeId,
        },
        forcedScenarioId: scenario._id,
        forcedActionNodeId: "reminder",
        triggerEventKind: "no_human_reply_timeout",
        skipTriggerMatch: true,
      });

    const result = await continueFromOffer("offer");

    expect(result.runtime).toMatchObject({
      selectedActionNodeId: "reminder",
      actionReplyText: "Still interested?",
      selectedPathNodeIds: [
        "trigger-1",
        "welcome",
        getScenarioActionOutcomeVirtualNodeId("welcome"),
        "offer",
        getScenarioActionOutcomeVirtualNodeId("offer"),
        "reminder",
      ],
    });
    // Without the claimed wait's action, every branch from the trigger is checked.
    await expect(continueFromOffer()).resolves.toMatchObject({
      runtime: null,
    });
  });

  it("uses a forced bulk template no-reply target that is also a quick-reply branch target", async () => {
    const payload = buildWhatsAppTemplateButtonPayload("offer-template", 0);
    const scenario = {
      _id: "65f000000000000000000041",
      name: "Bulk final follow-up",
      priority: 5,
      entryPolicy: "once_per_conversation" as const,
      matchingRole: "default",
      updatedAt: new Date("2026-08-01T00:00:00.000Z"),
      nodes: [
        {
          id: "bulk-root",
          data: {
            kind: "bulk",
            bulkRootConfig: {
              workflowKind: "bulk_campaign",
              sendMode: "immediate",
              channels: ["whatsapp"],
              campaignName: "Final follow-up canary",
              recipientSourceSummary: "DemoShop group",
              generationStatus: "idle",
            },
          },
        },
        {
          id: "offer-template",
          data: {
            kind: "action",
            actionType: "whatsapp_template",
            actionWhatsAppTemplateName: "offer",
            actionWhatsAppTemplateLanguage: "en",
            actionWhatsAppTemplateComponents: [
              {
                type: "BUTTONS",
                buttons: [{ type: "QUICK_REPLY", text: "Interested" }],
              },
            ],
            actionOutcomes: {
              version: 1,
              noReply: { enabled: true, timeoutMinutes: 120 },
            },
          },
        },
        {
          id: "final-follow-up",
          data: {
            kind: "action",
            actionType: "reply",
            actionReplyMode: "fixed",
            actionReplyText: "This is the final follow-up.",
            whatsAppTemplateButtonPayload: payload,
          },
        },
      ],
      edges: [
        {
          source: "bulk-root",
          sourceHandle: "right-source",
          target: "offer-template",
        },
        {
          source: "offer-template",
          sourceHandle: buildScenarioActionOutcomeHandleId("no_reply"),
          target: "final-follow-up",
        },
        {
          source: "offer-template",
          sourceHandle: "right-source-whatsapp-template-button-branch::0",
          target: "final-follow-up",
        },
      ],
    };
    setLockedScenario(scenario);

    const result = await resolveRuntime({
      scenarioState: {
        lockedScenarioId: scenario._id,
        lockedScenarioName: scenario.name,
        currentActionNodeId: "offer-template",
      },
      forcedScenarioId: scenario._id,
      forcedActionNodeId: "final-follow-up",
      triggerEventKind: "no_human_reply_timeout",
    });

    expect(result.runtime?.selectedActionNodeId).toBe("final-follow-up");
    expect(result.runtime?.actionReplyText).toBe(
      "This is the final follow-up."
    );
    expect(mockScenarioFind).not.toHaveBeenCalled();
  });

  it.each([
    "template",
    "medal template",
    "service",
    "form",
    "service form",
    "text",
  ] as const)(
    "continues a locked %s branch when a different root matches the reply",
    async kind => {
      // Routing slice of the persisted DemoShop graph/state from 2026-10-11.
      // The ad-specific entry led to this menu; the reply has no ad referral,
      // so the unrelated readable root matches if entry selection runs again.
      const fixture = structuredClone(multiRootTemplateContinuation);
      const scenario = fixture.scenario as unknown as ScenarioTestRecord;
      // The production graph cache keys revisions by scenario id/update time.
      scenario.updatedAt = new Date(
        Date.UTC(
          2026,
          9,
          11,
          0,
          0,
          [
            "template",
            "medal template",
            "service",
            "form",
            "service form",
            "text",
          ].indexOf(kind)
        )
      );
      const state: ConversationScenarioState = fixture.state;
      const sourceId =
        kind === "medal template"
          ? "node-demoshop-medal-lang-20260927"
          : "node-demoshop-orteke-lang-20260927";
      const targetId =
        kind === "medal template"
          ? "node-1790495389291-1-669"
          : "node-1779454010349-254";
      const triggerId =
        kind === "medal template"
          ? "node-1773740009253-973"
          : "node-1781294812166-1-281";
      state.currentActionNodeId = sourceId;
      state.currentPathNodeIds = [triggerId, sourceId];
      state.pendingConditionNodeId =
        getScenarioActionOutcomeVirtualNodeId(sourceId);
      state.pendingSourceActionNodeId = sourceId;
      state.startedScenarios![0]!.firstActionNodeId = sourceId;
      const source = scenario.nodes.find(node => node.id === sourceId)!;
      let eventKind: ScenarioRuntimeEventKind = "whatsapp_button_reply";
      let payload: string | undefined = `stb:${sourceId}:0`;
      let formReply: string | undefined;
      if (kind === "service") {
        source.data = {
          kind: "action",
          actionType: "reply",
          actionWhatsAppServiceMessage: {
            version: 1,
            message: {
              kind: "reply_buttons",
              body: { mode: "fixed", text: "Choose language" },
              options: [{ id: "kk", label: "Қазақ тілі" }],
            },
          },
        };
        payload = buildWhatsAppSessionChoicePayload({
          actionNodeId: sourceId,
          choiceId: "kk",
        });
        scenario.edges = scenario.edges.filter(
          edge => edge.source !== sourceId
        );
        scenario.edges.push({
          source: sourceId,
          sourceHandle: buildWhatsAppSessionChoiceSourceHandleId(payload),
          target: targetId,
        });
      } else if (kind === "form" || kind === "service form") {
        source.data =
          kind === "form"
            ? (medalTemplateStep({
                actionWhatsAppTemplateName: "medal_pick_1",
                actionWhatsAppTemplateLanguage: "kk",
                actionWhatsAppTemplateForm: medalTemplateForm(),
              }) as ScenarioNodeData)
            : {
                kind: "action",
                actionType: "reply",
                actionWhatsAppServiceMessage: {
                  version: 1,
                  message: {
                    kind: "flow",
                    body: { mode: "fixed", text: "Tell us more" },
                    flowConfig: {
                      ctaText: "Open",
                      screens: [
                        {
                          id: "FORM",
                          title: "Form",
                          fields: [
                            {
                              id: "name",
                              label: "Name",
                              fieldType: "TextInput",
                            },
                          ],
                        },
                      ],
                    },
                  },
                },
              };
        scenario.edges = scenario.edges.filter(
          edge => edge.source !== sourceId
        );
        scenario.edges.push({
          source: sourceId,
          sourceHandle:
            kind === "form"
              ? ACTION_WHATSAPP_TEMPLATE_FORM_SUBMITTED_HANDLE_ID
              : "right-source",
          target: targetId,
        });
        eventKind = "whatsapp_flow_reply";
        payload = undefined;
        formReply = JSON.stringify({ name: "Airi", flow_token: "fixture" });
      } else if (kind === "text") {
        source.data = {
          kind: "action",
          actionType: "reply",
          actionReplyMode: "fixed",
          actionReplyText: "Company name?",
        };
        scenario.edges = scenario.edges.filter(
          edge => edge.source !== sourceId
        );
        scenario.edges.push({
          source: sourceId,
          sourceHandle: "right-source",
          target: targetId,
        });
        state.currentActionNodeId = targetId;
        state.pendingConditionNodeId = null;
        state.pendingSourceActionNodeId = null;
        state.pendingLastOutboundMessageId = null;
        eventKind = "inbound_message";
        payload = undefined;
      }
      setActiveScenarios([scenario]);
      setLockedScenario(scenario);

      const result = await resolveRuntime({
        scenarioState: state,
        triggerEventKind: eventKind,
        triggerMessageText: kind === "text" ? "Airi.chat" : "Қазақ тілі",
        quickReplyPayload: payload,
        whatsAppFlowResponseJson: formReply,
        ...(kind === "form"
          ? {
              whatsAppFlowReplySource: {
                scenarioId: scenario._id,
                actionNodeId: sourceId,
              },
            }
          : {}),
      });

      expect(result.runtime).toMatchObject({
        scenarioId: scenario._id,
        selectedActionNodeId: targetId,
        lockedByConversationState: true,
      });
      expect(result.runtime?.selectedPathNodeIds).toEqual([
        triggerId,
        sourceId,
        targetId,
      ]);
      if (kind === "form") {
        const foreignForm = await resolveRuntime({
          scenarioState: state,
          triggerEventKind: "whatsapp_flow_reply",
          whatsAppFlowResponseJson: formReply,
          whatsAppFlowReplySource: {
            scenarioId: "another-scenario",
            actionNodeId: sourceId,
          },
        });
        expect(foreignForm.runtime).toBeNull();
      }
    }
  );

  it.each([false, true])(
    "keeps entry criteria and once-per-conversation policy without a continuation (started=%s)",
    async started => {
      const { scenario, state } = structuredClone(
        multiRootTemplateContinuation
      );
      setActiveScenarios([scenario]);
      const result = await resolveRuntime({
        triggerEventKind: "inbound_message",
        triggerMessageText: "Hello",
        scenarioState: started
          ? { startedScenarios: state.startedScenarios }
          : null,
      });
      if (started) {
        expect(result.runtime).toBeNull();
      } else {
        expect(result.runtime?.selectedActionNodeId).toBe(
          "node-demoshop-readable-lang-20261008"
        );
      }
    }
  );

  it("does not repeat a prior question or switch roots when a locked text continuation fails its run conditions", async () => {
    const fixture = structuredClone(multiRootTemplateContinuation);
    const scenario = fixture.scenario as unknown as ScenarioTestRecord;
    scenario.updatedAt = new Date("2026-10-11T00:01:00Z");
    const state: ConversationScenarioState = fixture.state;
    const sourceId = "node-demoshop-orteke-lang-20260927";
    const targetId = "node-1779454010349-254";
    scenario.nodes.find(node => node.id === sourceId)!.data = {
      kind: "action",
      actionType: "reply",
      actionReplyMode: "fixed",
      actionReplyText: "Company name?",
    };
    scenario.nodes.find(
      node => node.id === targetId
    )!.data.actionRunConditions = {
      version: 1,
      match: "all",
      conditions: [{ id: "vip", type: "internal_label", label: "vip" }],
    };
    scenario.edges = scenario.edges.filter(edge => edge.source !== sourceId);
    scenario.edges.push({
      source: sourceId,
      sourceHandle: "right-source",
      target: targetId,
    });
    state.currentActionNodeId = targetId;
    state.pendingConditionNodeId = null;
    state.pendingSourceActionNodeId = null;
    state.pendingLastOutboundMessageId = null;
    setActiveScenarios([scenario]);
    setLockedScenario(scenario);

    const result = await resolveRuntime({
      scenarioState: state,
      triggerEventKind: "inbound_message",
      triggerMessageText: "Airi.chat",
    });

    expect(result.runtime).toBeNull();
  });

  it("rejects an unknown template button instead of entering the matching fallback root", async () => {
    const { scenario, state } = structuredClone(multiRootTemplateContinuation);
    setActiveScenarios([scenario]);
    setLockedScenario(scenario);
    const result = await resolveRuntime({
      scenarioState: state,
      triggerEventKind: "whatsapp_button_reply",
      quickReplyPayload: "stb:node-demoshop-orteke-lang-20260927:99",
    });
    expect(result.runtime).toBeNull();
  });

  it("continues a locked WhatsApp template quick-reply branch without reapplying top-level trigger filters", async () => {
    const payload = buildWhatsAppTemplateButtonPayload("pick-lang", 0);
    const scenario = {
      _id: "65f000000000000000000004",
      name: "Language picker",
      priority: 5,
      entryPolicy: "once_per_conversation" as const,
      matchingRole: "default",
      updatedAt: new Date("2026-05-15T00:00:00.000Z"),
      nodes: [
        {
          id: "trigger-1",
          data: {
            kind: "trigger",
            triggerConfig: { enabled: true, onlyNewCustomers: true },
          },
        },
        {
          id: "pick-lang",
          data: {
            kind: "action",
            actionType: "whatsapp_template",
            actionWhatsAppTemplateName: "pick_lang",
            actionWhatsAppTemplateLanguage: "kk",
            actionWhatsAppTemplateComponents: [
              {
                type: "BUTTONS",
                buttons: [
                  { type: "QUICK_REPLY", text: "Kazakh" },
                  { type: "QUICK_REPLY", text: "Russian" },
                ],
              },
            ],
          },
        },
        {
          id: "send-kz",
          data: {
            kind: "action",
            actionType: "reply",
            actionReplyMode: "fixed",
            actionReplyText: "Kazakh path",
            whatsAppTemplateButtonPayload: payload,
          },
        },
      ],
      edges: [
        { source: "trigger-1", target: "pick-lang" },
        { source: "pick-lang", target: "send-kz" },
      ],
    };
    setLockedScenario(scenario);

    const result = await resolveActiveScenarioRuntime({
      workspaceId: "workspace-1",
      conversation: {
        _id: "conv-1",
        classification: { category: "Existing customer" },
      } as never,
      channel: "whatsapp",
      scenarioState: {
        lockedScenarioId: scenario._id,
        lockedScenarioName: scenario.name,
        currentActionNodeId: "pick-lang",
        startedScenarios: [
          {
            scenarioId: scenario._id,
            scenarioName: scenario.name,
            startedAt: "2026-05-15T13:40:00.000Z",
            firstActionNodeId: "pick-lang",
          },
        ],
      },
      triggerEventKind: "whatsapp_button_reply",
      quickReplyPayload: payload,
    });

    expect(result.runtime?.scenarioId).toBe(scenario._id);
    expect(result.runtime?.selectedActionNodeId).toBe("send-kz");
    expect(result.lockedScenarioNoMatch).toBeUndefined();
  });

  it("routes WhatsApp template button replies through edge-handle branches before no-reply fallbacks", async () => {
    const payload = buildWhatsAppTemplateButtonPayload("pick-lang", 1);
    const scenario = {
      _id: "65f000000000000000000040",
      name: "Language picker with fallback",
      priority: 5,
      entryPolicy: "once_per_conversation" as const,
      matchingRole: "default",
      updatedAt: new Date("2026-06-07T00:00:00.000Z"),
      nodes: [
        {
          id: "trigger-1",
          data: {
            kind: "trigger",
            triggerConfig: { enabled: true },
          },
        },
        {
          id: "pick-lang",
          data: {
            kind: "action",
            actionType: "whatsapp_template",
            actionWhatsAppTemplateName: "pick_lang",
            actionWhatsAppTemplateLanguage: "kk",
            actionWhatsAppTemplateComponents: [
              {
                type: "BUTTONS",
                buttons: [
                  { type: "QUICK_REPLY", text: "Kazakh" },
                  { type: "QUICK_REPLY", text: "Russian" },
                ],
              },
            ],
          },
        },
        {
          id: "medal-fallback",
          data: {
            kind: "action",
            actionType: "whatsapp_template",
            actionWhatsAppTemplateName: "medal_dozhim_1",
          },
        },
        {
          id: "send-ru",
          data: {
            kind: "action",
            actionType: "reply",
            actionReplyMode: "fixed",
            actionReplyText: "Russian product picker",
          },
        },
        {
          id: "language-wait",
          data: {
            kind: "logic",
            logicType: "post_action_condition",
            conditionBranches: [
              { id: "user_replied", type: "user_replied" },
              {
                id: "no_reply_timeout",
                type: "no_reply_timeout",
                timeoutMinutes: 1200,
              },
            ],
          },
        },
      ],
      edges: [
        { source: "trigger-1", target: "pick-lang" },
        {
          source: "pick-lang",
          sourceHandle: "right-source-whatsapp-template-button-branch::1",
          target: "send-ru",
        },
        {
          source: "pick-lang",
          sourceHandle: "right-source",
          target: "language-wait",
        },
        {
          source: "language-wait",
          sourceHandle: "right-source-condition-no_reply_timeout",
          target: "medal-fallback",
        },
      ],
    };
    setLockedScenario(scenario);

    const result = await resolveRuntime({
      scenarioState: {
        lockedScenarioId: scenario._id,
        lockedScenarioName: scenario.name,
        currentActionNodeId: "pick-lang",
        pendingConditionNodeId: "language-wait",
        pendingSourceActionNodeId: "pick-lang",
      },
      triggerEventKind: "whatsapp_button_reply",
      quickReplyPayload: payload,
    });

    expect(result.runtime?.scenarioId).toBe(scenario._id);
    expect(result.runtime?.selectedActionNodeId).toBe("send-ru");
    expect(result.runtime?.actionReplyText).toBe("Russian product picker");
  });

  it("continues a payload-anchored WhatsApp template branch even after the scenario lock was cleared", async () => {
    const payload = buildWhatsAppTemplateButtonPayload("pick-lang", 0);
    const scenario = {
      _id: "65f000000000000000000005",
      name: "Cleared language picker",
      priority: 5,
      matchingRole: "default",
      entryPolicy: "once_per_conversation",
      updatedAt: new Date("2026-05-15T00:00:00.000Z"),
      nodes: [
        {
          id: "trigger-1",
          data: {
            kind: "trigger",
            triggerConfig: { enabled: true, onlyNewCustomers: true },
          },
        },
        {
          id: "pick-lang",
          data: {
            kind: "action",
            actionType: "whatsapp_template",
            actionWhatsAppTemplateName: "pick_lang",
            actionWhatsAppTemplateLanguage: "kk",
            actionWhatsAppTemplateComponents: [
              {
                type: "BUTTONS",
                buttons: [{ type: "QUICK_REPLY", text: "Kazakh" }],
              },
            ],
          },
        },
        {
          id: "send-kz",
          data: {
            kind: "action",
            actionType: "reply",
            actionReplyMode: "fixed",
            actionReplyText: "Kazakh path after cleared state",
            whatsAppTemplateButtonPayload: payload,
          },
        },
      ],
      edges: [
        { source: "trigger-1", target: "pick-lang" },
        { source: "pick-lang", target: "send-kz" },
      ],
    };
    setActiveScenarios([scenario, fallbackScenario]);

    const result = await resolveActiveScenarioRuntime({
      workspaceId: "workspace-1",
      conversation: {
        _id: "conv-1",
        classification: { category: "Existing customer" },
      } as never,
      channel: "whatsapp",
      scenarioState: {
        lockedScenarioId: null,
        lockedScenarioName: null,
        currentActionNodeId: null,
        startedScenarios: [
          {
            scenarioId: scenario._id,
            scenarioName: scenario.name,
            startedAt: "2026-05-15T13:40:00.000Z",
            firstActionNodeId: "pick-lang",
          },
        ],
        completedScenarios: [
          {
            scenarioId: scenario._id,
            scenarioName: scenario.name,
            completedAt: "2026-05-15T13:45:00.000Z",
            lastActionNodeId: "pick-lang",
          },
        ],
      },
      triggerEventKind: "whatsapp_button_reply",
      quickReplyPayload: payload,
    });

    expect(result.runtime?.scenarioId).toBe(scenario._id);
    expect(result.runtime?.selectedActionNodeId).toBe("send-kz");
    expect(result.runtime?.actionReplyText).toBe(
      "Kazakh path after cleared state"
    );
  });

  it("runs Instagram-scoped reply actions only on Instagram conversations", async () => {
    const instagramScenario = createScenario({
      id: "507f191e810c19729de86111",
      name: "Instagram reply",
      priority: 10,
      replyText: "instagram only",
      actionReplyChannel: "instagram",
    });
    setActiveScenarios([instagramScenario]);

    const whatsappResult = await resolveRuntime({
      triggerMessageText: "hi",
    });

    expect(whatsappResult.runtime).toBeNull();
    expect(getLoggedScenarioEvaluations()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scenarioId: instagramScenario._id,
          mismatchReason: "action_channel_mismatch",
        }),
      ])
    );

    jest.clearAllMocks();
    mockConnectDB.mockResolvedValue(undefined);
    mockLogScenarioTriggerEvaluations.mockResolvedValue(undefined);
    mockQuickReplyFind.mockReturnValue(createSelectSortLeanQuery([]));
    setInboundCustomerMessages([]);
    setActiveScenarios([instagramScenario]);

    const instagramResult = await resolveActiveScenarioRuntime({
      workspaceId: "workspace-1",
      conversation: { _id: "conv-1" } as never,
      channel: "instagram",
      triggerMessageText: "hi",
    });

    expect(instagramResult.runtime?.scenarioId).toBe(instagramScenario._id);
    expect(instagramResult.runtime?.actionReplyChannel).toBe("instagram");
  });

  it("runs Telegram builder replies only on Telegram conversations", async () => {
    const telegramScenario = {
      _id: "507f191e810c19729de86112",
      name: "Telegram builder",
      priority: 10,
      matchingRole: "default",
      entryPolicy: "once_per_conversation" as const,
      updatedAt: new Date("2026-03-27T00:00:00.000Z"),
      nodes: [
        {
          id: "trigger-1",
          data: {
            kind: "trigger",
            triggerConfig: { enabled: true },
          },
        },
        {
          id: "action-1",
          data: {
            kind: "action",
            actionType: "reply",
            actionReplyMode: "fixed",
            actionReplyChannel: "telegram",
            actionReplyText: "Choose",
            actionTelegramQuickReplies: [[{ text: "Yes", payload: "yes" }]],
          },
        },
      ],
      edges: [{ source: "trigger-1", target: "action-1" }],
    };
    setActiveScenarios([telegramScenario]);

    const whatsappResult = await resolveRuntime({
      triggerMessageText: "hi",
    });

    expect(whatsappResult.runtime).toBeNull();
    expect(getLoggedScenarioEvaluations()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scenarioId: telegramScenario._id,
          mismatchReason: "action_channel_mismatch",
        }),
      ])
    );

    jest.clearAllMocks();
    mockConnectDB.mockResolvedValue(undefined);
    mockLogScenarioTriggerEvaluations.mockResolvedValue(undefined);
    mockQuickReplyFind.mockReturnValue(createSelectSortLeanQuery([]));
    setInboundCustomerMessages([]);
    setActiveScenarios([telegramScenario]);

    const telegramResult = await resolveActiveScenarioRuntime({
      workspaceId: "workspace-1",
      conversation: { _id: "conv-1" } as never,
      channel: "telegram",
      triggerMessageText: "hi",
    });

    expect(telegramResult.runtime?.scenarioId).toBe(telegramScenario._id);
    expect(telegramResult.runtime?.actionReplyChannel).toBe("telegram");
    expect(telegramResult.runtime?.actionTelegramQuickReplies).toEqual([
      [{ text: "Yes", payload: "yes" }],
    ]);
  });

  it("suppresses fallback after a recent specific scenario completion", async () => {
    setActiveScenarios([medalScenario, fallbackScenario]);
    setInboundCustomerMessages([
      "2026-03-27T12:00:00.000Z",
      "2026-03-27T11:00:00.000Z",
    ]);
    const scenarioState = {
      completedScenarios: [
        {
          scenarioId: medalScenario._id,
          scenarioName: medalScenario.name,
          completedAt: "2026-03-27T10:55:00.000Z",
        },
      ],
    };

    const result = await resolveRuntime({
      triggerMessageText: "сәлем",
      scenarioState,
    });
    const preview = await previewScenarioEvaluation({
      workspaceId: "workspace-1",
      conversation: { _id: "conv-1" } as never,
      channel: "whatsapp",
      eventKind: "inbound_message",
      messageText: "hello",
      scenarioState,
      scenarios: [medalScenario, fallbackScenario],
    });

    expect(result.runtime).toBeNull();
    expect(getLoggedScenarioEvaluations()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scenarioId: fallbackScenario._id,
          mismatchReason: "fallback_suppressed_recent_specific_session",
        }),
      ])
    );
    expect(preview.winner).toBeNull();
    expect(preview.evaluations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scenarioId: fallbackScenario._id,
          reason: "fallback_suppressed_recent_specific_session",
          result: "skipped",
        }),
      ])
    );
  });

  it("re-enables fallback after 24 hours of customer inactivity", async () => {
    setActiveScenarios([medalScenario, fallbackScenario]);
    setInboundCustomerMessages([
      "2026-03-28T12:00:00.000Z",
      "2026-03-27T11:00:00.000Z",
    ]);

    const result = await resolveRuntime({
      triggerMessageText: "сәлем",
      scenarioState: {
        completedScenarios: [
          {
            scenarioId: medalScenario._id,
            scenarioName: medalScenario.name,
            completedAt: "2026-03-27T10:55:00.000Z",
          },
        ],
      },
    });

    expect(result.runtime?.scenarioId).toBe(fallbackScenario._id);
    expect(result.runtime?.actionReplyText).toBe("fallback");
  });

  it("still allows a different specific scenario during fallback suppression", async () => {
    setActiveScenarios([medalScenario, priceScenario, fallbackScenario]);
    setInboundCustomerMessages([
      "2026-03-27T12:00:00.000Z",
      "2026-03-27T11:30:00.000Z",
    ]);

    const result = await resolveRuntime({
      triggerMessageText: "баға қандай",
      scenarioState: {
        completedScenarios: [
          {
            scenarioId: medalScenario._id,
            scenarioName: medalScenario.name,
            completedAt: "2026-03-27T10:55:00.000Z",
          },
        ],
      },
    });

    expect(result.runtime?.scenarioId).toBe(priceScenario._id);
    expect(result.runtime?.actionReplyText).toBe("specific price");
  });

  it("prefers more specific triggers before broader ones even at lower numeric priority", async () => {
    const exactPriceScenario = createScenario({
      id: "507f191e810c19729de860ec",
      name: "\u041d\u0430\u049b\u0442\u044b \u0431\u0430\u0493\u0430",
      priority: 10,
      triggerConfig: {
        messageMatchMode: "exact",
        keywordPattern:
          "\u0431\u0430\u0493\u0430\u0441\u044b \u049b\u0430\u043d\u0448\u0430",
        keywordMatchMode: "contains",
      },
      replyText: "exact price",
    });

    setActiveScenarios([priceScenario, exactPriceScenario, fallbackScenario]);

    const result = await resolveRuntime({
      triggerMessageText:
        "\u0431\u0430\u0493\u0430\u0441\u044b \u049b\u0430\u043d\u0448\u0430",
    });

    expect(result.runtime?.scenarioId).toBe(exactPriceScenario._id);
    expect(result.runtime?.actionReplyText).toBe("exact price");
  });

  it("logs shadowed fallback candidates under the same evaluation session", async () => {
    const primaryGreetingScenario = createScenario({
      id: "507f191e810c19729de860f9",
      name: "Specific greeting",
      priority: 5,
      replyText: "primary greeting",
    });
    const fallbackGreetingScenario = createScenario({
      id: "507f191e810c19729de860fa",
      name: "Fallback greeting",
      priority: 999,
      matchingRole: "fallback",
      replyText: "fallback greeting",
    });

    setActiveScenarios([primaryGreetingScenario, fallbackGreetingScenario]);

    const result = await resolveRuntime({
      triggerMessageText: "hello",
    });

    expect(result.runtime?.scenarioId).toBe(primaryGreetingScenario._id);

    const loggedEvaluations = getLoggedScenarioEvaluations();
    const winnerLog = loggedEvaluations.find(
      entry => entry.scenarioId === primaryGreetingScenario._id
    );
    const shadowedLog = loggedEvaluations.find(
      entry => entry.scenarioId === fallbackGreetingScenario._id
    );

    expect(winnerLog).toEqual(
      expect.objectContaining({
        result: "winner",
        matched: true,
        winnerScenarioId: primaryGreetingScenario._id,
      })
    );
    expect(shadowedLog).toEqual(
      expect.objectContaining({
        result: "matched_but_shadowed",
        matched: false,
        winnerScenarioId: primaryGreetingScenario._id,
        shadowedByScenarioId: primaryGreetingScenario._id,
      })
    );
    expect(shadowedLog?.evaluationId).toBe(winnerLog?.evaluationId);
  });

  it("persists one evaluation id across the session and marks later matches as shadowed", async () => {
    setActiveScenarios([medalScenario, fallbackScenario]);

    const result = await resolveRuntime({
      triggerMessageText: "маған медаль ілгіш керек",
    });

    expect(result.runtime?.scenarioId).toBe(medalScenario._id);

    const loggedEvaluations = getLoggedScenarioEvaluations();
    const winnerLog = loggedEvaluations.find(
      entry => entry.scenarioId === medalScenario._id
    );
    const shadowedLog = loggedEvaluations.find(
      entry => entry.scenarioId === fallbackScenario._id
    );

    expect(winnerLog).toEqual(
      expect.objectContaining({
        result: "winner",
        matched: true,
        winnerScenarioId: medalScenario._id,
      })
    );
    expect(shadowedLog).toEqual(
      expect.objectContaining({
        result: "matched_but_shadowed",
        matched: false,
        winnerScenarioId: medalScenario._id,
        shadowedByScenarioId: medalScenario._id,
      })
    );
    expect(shadowedLog?.evaluationId).toBe(winnerLog?.evaluationId);
  });

  it("blocks non-loop scenarios from re-entering after they already started in the conversation", async () => {
    setActiveScenarios([medalScenario]);

    const result = await resolveRuntime({
      triggerMessageText: "маған медаль ілгіш керек",
      scenarioState: {
        startedScenarios: [
          {
            scenarioId: medalScenario._id,
            scenarioName: medalScenario.name,
            startedAt: "2026-03-27T10:00:00.000Z",
            firstActionNodeId: `${medalScenario._id}-action`,
            firstMessageId: "msg-1",
          },
        ],
      },
    });

    expect(result.runtime).toBeNull();
    expect(getLoggedScenarioEvaluations()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scenarioId: medalScenario._id,
          mismatchReason: "blocked_by_once_per_conversation",
        }),
      ])
    );
  });

  it("still allows loop-enabled scenarios to re-enter in the same conversation", async () => {
    const loopingScenario = createScenario({
      id: "507f191e810c19729de860ed",
      name: "Looping medal",
      priority: 55,
      triggerConfig: {
        messageMatchMode: "contains",
        keywordPattern: "медаль",
        keywordMatchMode: "contains",
      },
      replyText: "loop",
      legacyLoopScenario: true,
    });
    setActiveScenarios([loopingScenario]);

    const result = await resolveRuntime({
      triggerMessageText: "маған медаль керек",
      scenarioState: {
        startedScenarios: [
          {
            scenarioId: loopingScenario._id,
            scenarioName: loopingScenario.name,
            startedAt: "2026-03-27T10:00:00.000Z",
          },
        ],
      },
    });

    expect(result.runtime?.scenarioId).toBe(loopingScenario._id);
    expect(result.runtime?.actionReplyText).toBe("loop");
  });

  it("allows the canonical repeatable entry policy after a prior start", async () => {
    const repeatableScenario = createScenario({
      id: "507f191e810c19729de860ef",
      name: "Repeatable medal",
      priority: 56,
      triggerConfig: {
        messageMatchMode: "contains",
        keywordPattern: "РјРµРґР°Р»СЊ",
        keywordMatchMode: "contains",
      },
      replyText: "repeatable",
      entryPolicy: "repeatable",
    });
    setActiveScenarios([repeatableScenario]);

    const result = await resolveRuntime({
      triggerMessageText: "РјРµРґР°Р»СЊ РєРµСЂРµРє",
      scenarioState: {
        startedScenarios: [
          {
            scenarioId: repeatableScenario._id,
            scenarioName: repeatableScenario.name,
            startedAt: "2026-03-27T10:00:00.000Z",
          },
        ],
      },
    });

    expect(result.runtime?.scenarioId).toBe(repeatableScenario._id);
    expect(result.runtime?.actionReplyText).toBe("repeatable");
  });

  it("keeps locked scenarios eligible for in-workflow continuation even after they started", async () => {
    const flowScenario = {
      _id: "507f191e810c19729de860ee",
      name: "Locked flow",
      priority: 60,
      entryPolicy: "once_per_conversation" as const,
      matchingRole: "default",
      updatedAt: new Date("2026-03-27T00:00:00.000Z"),
      nodes: [
        {
          id: "trigger-1",
          data: {
            kind: "trigger",
            triggerConfig: { enabled: true },
          },
        },
        {
          id: "flow-1",
          data: {
            kind: "action",
            actionType: "reply",
            actionReplyChannel: "whatsapp",
            actionWhatsAppServiceMessage: {
              version: 1,
              message: {
                kind: "flow",
                body: { mode: "fixed", text: "Choose an option" },
                flowConfig: {
                  ctaText: "Open",
                  screens: [
                    {
                      id: "LEAD_FORM",
                      fields: [
                        {
                          id: "message",
                          fieldType: "RadioButtonsGroup",
                          options: [{ id: "opt_1", title: "Option 1" }],
                        },
                      ],
                    },
                  ],
                },
              },
            },
          },
        },
        {
          id: "reply-1",
          data: {
            kind: "action",
            actionType: "reply",
            actionReplyMode: "fixed",
            actionReplyText: "continued",
          },
        },
      ],
      edges: [
        { source: "trigger-1", target: "flow-1" },
        { source: "flow-1", target: "reply-1" },
      ],
    };
    setActiveScenarios([]);
    setLockedScenario(flowScenario);

    const result = await resolveRuntime({
      triggerEventKind: "whatsapp_flow_reply",
      whatsAppFlowResponseJson: JSON.stringify({
        message: "opt_1",
        flow_token: "flow_123",
      }),
      scenarioState: {
        lockedScenarioId: flowScenario._id,
        lockedScenarioName: flowScenario.name,
        currentActionNodeId: "flow-1",
        startedScenarios: [
          {
            scenarioId: flowScenario._id,
            scenarioName: flowScenario.name,
            startedAt: "2026-03-27T10:00:00.000Z",
            firstActionNodeId: "flow-1",
          },
        ],
      },
    });

    expect(result.runtime?.scenarioId).toBe(flowScenario._id);
    expect(result.runtime?.selectedActionNodeId).toBe("reply-1");
  });

  it("recovers telegram quick-reply branches when the locked action anchor is stale", async () => {
    const telegramScenario = {
      _id: "507f191e810c19729de860f0",
      name: "Консультация",
      priority: 10,
      entryPolicy: "once_per_conversation" as const,
      matchingRole: "default",
      updatedAt: new Date("2026-03-27T00:00:00.000Z"),
      nodes: [
        {
          id: "trigger-1",
          data: {
            kind: "trigger",
            triggerConfig: { enabled: true },
          },
        },
        {
          id: "reply-root",
          data: {
            kind: "action",
            actionType: "reply",
            actionReplyMode: "fixed",
            actionReplyText: "Choose an option",
            actionTelegramQuickReplies: [
              [{ text: "Да", payload: "btn_pss" }],
              [{ text: "Нет", payload: "btn_no" }],
            ],
          },
        },
        {
          id: "branch-yes",
          data: {
            kind: "action",
            actionType: "reply",
            actionReplyMode: "fixed",
            actionReplyText: "Продолжаем консультацию",
            telegramBranchPayload: "btn_pss",
            telegramBranchLabel: "Да",
          },
        },
        {
          id: "branch-no",
          data: {
            kind: "action",
            actionType: "reply",
            actionReplyMode: "fixed",
            actionReplyText: "Ок, остановились",
            telegramBranchPayload: "btn_no",
            telegramBranchLabel: "Нет",
          },
        },
        {
          id: "stale-action",
          data: {
            kind: "action",
            actionType: "assign_human",
          },
        },
      ],
      edges: [
        { source: "trigger-1", target: "reply-root" },
        { source: "reply-root", target: "branch-yes" },
        { source: "reply-root", target: "branch-no" },
        { source: "reply-root", target: "stale-action" },
      ],
    };
    setActiveScenarios([telegramScenario]);
    setLockedScenario(telegramScenario);

    const result = await resolveActiveScenarioRuntime({
      workspaceId: "workspace-1",
      conversation: { _id: "conv-1" } as never,
      channel: "telegram",
      triggerEventKind: "telegram_quick_reply",
      quickReplyPayload: "btn_pss",
      scenarioState: {
        lockedScenarioId: telegramScenario._id,
        lockedScenarioName: telegramScenario.name,
        currentActionNodeId: "stale-action",
        startedScenarios: [
          {
            scenarioId: telegramScenario._id,
            scenarioName: telegramScenario.name,
            startedAt: "2026-03-27T10:00:00.000Z",
            firstActionNodeId: "reply-root",
          },
        ],
      },
    });

    expect(result.runtime?.scenarioId).toBe(telegramScenario._id);
    expect(result.runtime?.selectedActionNodeId).toBe("branch-yes");
    expect(result.lockedScenarioNoMatch).toBeUndefined();
  });

  it("routes Instagram quick-reply payloads to Instagram branch actions", async () => {
    const instagramScenario = {
      _id: "507f191e810c19729de86120",
      name: "Instagram branches",
      priority: 10,
      entryPolicy: "once_per_conversation" as const,
      matchingRole: "default",
      updatedAt: new Date("2026-03-27T00:00:00.000Z"),
      nodes: [
        {
          id: "trigger-1",
          data: {
            kind: "trigger",
            triggerConfig: { enabled: true },
          },
        },
        {
          id: "reply-root",
          data: {
            kind: "action",
            actionType: "reply",
            actionReplyChannel: "instagram",
            actionReplyMode: "fixed",
            actionReplyText: "Choose an option",
            actionInstagramConfig: {
              kind: "quick_replies",
              quickReplies: [{ title: "Pricing", payload: "pricing" }],
            },
          },
        },
        {
          id: "branch-pricing",
          data: {
            kind: "action",
            actionType: "reply",
            actionReplyChannel: "instagram",
            actionReplyMode: "fixed",
            actionReplyText: "Here is pricing",
            instagramBranchPayload: "pricing",
            instagramBranchLabel: "Pricing",
          },
        },
      ],
      edges: [
        { source: "trigger-1", target: "reply-root" },
        { source: "reply-root", target: "branch-pricing" },
      ],
    };
    setActiveScenarios([instagramScenario]);
    setLockedScenario(instagramScenario);

    const result = await resolveActiveScenarioRuntime({
      workspaceId: "workspace-1",
      conversation: { _id: "conv-1" } as never,
      channel: "instagram",
      triggerEventKind: "instagram_quick_reply" as never,
      quickReplyPayload: "pricing",
      scenarioState: {
        lockedScenarioId: instagramScenario._id,
        lockedScenarioName: instagramScenario.name,
        currentActionNodeId: "reply-root",
        startedScenarios: [
          {
            scenarioId: instagramScenario._id,
            scenarioName: instagramScenario.name,
            startedAt: "2026-03-27T10:00:00.000Z",
            firstActionNodeId: "reply-root",
          },
        ],
      },
    });

    expect(result.runtime?.scenarioId).toBe(instagramScenario._id);
    expect(result.runtime?.selectedActionNodeId).toBe("branch-pricing");
    expect(result.runtime?.actionReplyText).toBe("Here is pricing");
  });

  describe("structured replies the waiting action does not own", () => {
    const noReply = { enabled: true, timeoutMinutes: 10 };
    const fixedReply = (id: string, text: string, extra = {}) => ({
      id,
      data: {
        kind: "action",
        actionType: "reply",
        actionWhatsAppServiceMessage: {
          version: 1,
          message: { kind: "text", body: { mode: "fixed", text } },
        },
        ...extra,
      },
    });
    const waitingScenario = (
      scenarioId: string,
      nodes: unknown[],
      edges: Array<{ source: string; target: string; sourceHandle?: string }>
    ) => ({
      _id: scenarioId,
      name: "Waiting on an action",
      priority: 5,
      entryPolicy: "once_per_conversation" as const,
      matchingRole: "default",
      updatedAt: new Date("2026-09-20T00:00:00.000Z"),
      nodes: [
        {
          id: "trigger-1",
          data: { kind: "trigger", triggerConfig: { enabled: true } },
        },
        ...nodes,
      ],
      edges: [{ source: "trigger-1", target: "menu" }, ...edges],
    });
    const waitingOn = (scenarioId: string, actionNodeId: string) => ({
      lockedScenarioId: scenarioId,
      lockedScenarioName: "Waiting on an action",
      currentActionNodeId: actionNodeId,
      pendingConditionNodeId:
        getScenarioActionOutcomeVirtualNodeId(actionNodeId),
      pendingSourceActionNodeId: actionNodeId,
      startedScenarios: [
        {
          scenarioId,
          scenarioName: "Waiting on an action",
          startedAt: "2026-09-20T08:00:00.000Z",
          firstActionNodeId: "menu",
        },
      ],
    });

    it("routes an older message's button through its own branch after a reminder took over the wait", async () => {
      const scenario = waitingScenario(
        "65f000000000000000000060",
        [
          fixedReply("menu", "Choose", {
            actionWhatsAppServiceMessage: {
              version: 1,
              message: {
                kind: "reply_buttons",
                body: { mode: "fixed", text: "Choose" },
                options: [{ id: "wsc:menu:help", label: "Help" }],
              },
            },
            actionOutcomes: { version: 1, noReply },
          }),
          fixedReply("help", "How can I help?"),
          fixedReply("reminder", "Still there?", {
            actionOutcomes: { version: 1, noReply },
          }),
          fixedReply("last-call", "Last call"),
        ],
        [
          {
            source: "menu",
            sourceHandle:
              buildWhatsAppSessionChoiceSourceHandleId("wsc:menu:help"),
            target: "help",
          },
          {
            source: "menu",
            sourceHandle: buildScenarioActionOutcomeHandleId("no_reply"),
            target: "reminder",
          },
          {
            source: "reminder",
            sourceHandle: buildScenarioActionOutcomeHandleId("no_reply"),
            target: "last-call",
          },
        ]
      );
      setActiveScenarios([scenario]);
      setLockedScenario(scenario);

      const result = await resolveRuntime({
        triggerEventKind: "whatsapp_button_reply",
        quickReplyPayload: "wsc:menu:help",
        scenarioState: waitingOn(scenario._id, "reminder"),
      });

      expect(result.runtime?.selectedActionNodeId).toBe("help");
    });

    it("routes a Flow submission without choice fields to the Any reply outcome", async () => {
      const scenario = waitingScenario(
        "65f000000000000000000061",
        [
          fixedReply("menu", "Tell us about you", {
            actionWhatsAppServiceMessage: {
              version: 1,
              message: {
                kind: "flow",
                body: { mode: "fixed", text: "Tell us about you" },
                flowConfig: {
                  templateId: "flow-1",
                  ctaText: "Open",
                  screens: [
                    {
                      id: "about",
                      title: "About you",
                      fields: [
                        { id: "name", label: "Name", fieldType: "TextInput" },
                      ],
                    },
                  ],
                },
              },
            },
            actionOutcomes: {
              version: 1,
              anyReply: { enabled: true },
              noReply,
            },
          }),
          fixedReply("typed", "You wrote a message"),
          fixedReply("later", "Still there?"),
        ],
        [
          {
            source: "menu",
            sourceHandle: buildScenarioActionOutcomeHandleId("any_reply"),
            target: "typed",
          },
          {
            source: "menu",
            sourceHandle: buildScenarioActionOutcomeHandleId("no_reply"),
            target: "later",
          },
        ]
      );
      setActiveScenarios([scenario]);
      setLockedScenario(scenario);

      const result = await resolveRuntime({
        triggerEventKind: "whatsapp_flow_reply",
        whatsAppFlowResponseJson: JSON.stringify({ name: "Amina" }),
        scenarioState: waitingOn(scenario._id, "menu"),
      });

      expect(result.runtime?.selectedActionNodeId).toBe("typed");
    });
  });

  describe("a template's Form submitted route", () => {
    const scenarioId = "65f000000000000000000070";
    // A Flow config on the step, linked to the Flow its button opens or left
    // from an older one, makes the step await any Flow reply.
    const flowConfigs = [
      ["no Flow config", undefined],
      ["a linked Flow config", MEDAL_FLOW_ID],
      ["a stale Flow config", "1571793974235171"],
    ] as const;
    // Left on the route's step by a template button and a session choice of
    // other steps that also lead there.
    const otherBranchStamps = {
      whatsAppTemplateButtonPayload: buildWhatsAppTemplateButtonPayload(
        "promo",
        0
      ),
      whatsAppSessionChoicePayload: buildWhatsAppSessionChoicePayload({
        actionNodeId: "menu",
        choiceId: "design",
      }),
    };
    // Compiled graphs are cached per scenario id and update time.
    let scenarioCount = 0;
    const scenarioWith = (
      metaFlowId?: string,
      designStamps?: typeof otherBranchStamps
    ) => ({
      _id: scenarioId,
      name: "Medal order",
      priority: 5,
      entryPolicy: "once_per_conversation" as const,
      matchingRole: "default",
      updatedAt: new Date(Date.UTC(2026, 9, 4, 0, 0, (scenarioCount += 1))),
      nodes: [
        {
          id: "trigger-1",
          data: { kind: "trigger", triggerConfig: { enabled: true } },
        },
        {
          id: "medal",
          data: medalTemplateStep({
            actionWhatsAppTemplateName: "medal_pick_1",
            actionWhatsAppTemplateLanguage: "kk",
            actionOutcomes: {
              version: 1,
              noReply: { enabled: true, timeoutMinutes: 30 },
            },
            ...(metaFlowId
              ? {
                  actionFlowConfig: {
                    templateId: "",
                    ctaText: "",
                    screens: [],
                    metaFlowId,
                  },
                }
              : {}),
          }),
        },
        {
          id: "design",
          data: {
            kind: "action",
            actionType: "reply",
            actionReplyMode: "fixed",
            actionReplyText: "Here is your design",
            ...designStamps,
          },
        },
        {
          id: "reminder",
          data: {
            kind: "action",
            actionType: "reply",
            actionReplyMode: "fixed",
            actionReplyText: "Still choosing?",
          },
        },
      ],
      edges: [
        { source: "trigger-1", target: "medal" },
        {
          source: "medal",
          sourceHandle: ACTION_WHATSAPP_TEMPLATE_FORM_SUBMITTED_HANDLE_ID,
          target: "design",
        },
        {
          source: "medal",
          sourceHandle: buildScenarioActionOutcomeHandleId("no_reply"),
          target: "reminder",
        },
      ],
    });
    const submit = (
      whatsAppFlowReplySource?: {
        scenarioId: string;
        actionNodeId: string;
      },
      metaFlowId?: string,
      designStamps?: typeof otherBranchStamps
    ) => {
      const scenario = scenarioWith(metaFlowId, designStamps);
      setActiveScenarios([scenario]);
      setLockedScenario(scenario);
      return resolveRuntime({
        triggerEventKind: "whatsapp_flow_reply",
        whatsAppFlowResponseJson: JSON.stringify({
          _68d224: "Aya",
          flow_token: "flow_1",
        }),
        whatsAppFlowReplySource,
        scenarioState: {
          lockedScenarioId: scenarioId,
          lockedScenarioName: "Medal order",
          currentActionNodeId: "medal",
          currentPathNodeIds: ["trigger-1", "medal"],
          pendingConditionNodeId:
            getScenarioActionOutcomeVirtualNodeId("medal"),
          pendingSourceActionNodeId: "medal",
          startedScenarios: [
            {
              scenarioId,
              scenarioName: "Medal order",
              startedAt: "2026-10-04T08:00:00.000Z",
              firstActionNodeId: "medal",
            },
          ],
        },
      });
    };

    describe.each(flowConfigs)("on a template with %s", (_, metaFlowId) => {
      it("follows the route for a reply to the waiting template's form", async () => {
        const result = await submit(
          { scenarioId, actionNodeId: "medal" },
          metaFlowId
        );

        expect(result.runtime?.selectedActionNodeId).toBe("design");
        expect(result.runtime?.selectedPathNodeIds).toEqual([
          "trigger-1",
          "medal",
          "design",
        ]);
      });

      it("follows the route to a step other steps' buttons lead to as well", async () => {
        const result = await submit(
          { scenarioId, actionNodeId: "medal" },
          metaFlowId,
          otherBranchStamps
        );

        expect(result.runtime?.selectedActionNodeId).toBe("design");
        expect(result.runtime?.selectedPathNodeIds).toEqual([
          "trigger-1",
          "medal",
          "design",
        ]);
        // A reply to no known form still takes no route.
        await expect(
          submit(undefined, metaFlowId, otherBranchStamps)
        ).resolves.toMatchObject({ runtime: null });
      });

      it.each([
        ["no known form", undefined],
        [
          "a form another scenario sent",
          { scenarioId: "65f000000000000000000071", actionNodeId: "medal" },
        ],
        ["a form no template sent", { scenarioId, actionNodeId: "design" }],
      ])("does not take the route for a reply to %s", async (__, source) => {
        const result = await submit(source, metaFlowId);

        expect(result.runtime).toBeNull();
      });
    });
  });

  it("treats legacy completedScenarios history as already started for one-shot entry", async () => {
    setActiveScenarios([fallbackScenario]);

    const result = await resolveRuntime({
      triggerMessageText: "сәлем",
      scenarioState: {
        completedScenarios: [
          {
            scenarioId: fallbackScenario._id,
            scenarioName: fallbackScenario.name,
            completedAt: "2026-03-27T10:55:00.000Z",
          },
        ],
      },
    });

    expect(result.runtime).toBeNull();
    expect(getLoggedScenarioEvaluations()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scenarioId: fallbackScenario._id,
          mismatchReason: "blocked_by_once_per_conversation",
        }),
      ])
    );
  });

  // Older Mongo conversations may still store a journey pool lock.
  const retiredJourneyPoolState = {
    journeyPools: [
      {
        poolKey: "product_entry",
        ownerScenarioId: medalScenario._id,
        ownerScenarioName: medalScenario.name,
        lockedAt: "2026-03-27T10:00:00.000Z",
      },
    ],
  } as never;

  it("ignores a retired journey pool lock from older conversation state", async () => {
    const fallbackWithCanonicalPolicy = createScenario({
      id: fallbackScenario._id,
      name: fallbackScenario.name,
      priority: fallbackScenario.priority,
      matchingRole: fallbackScenario.matchingRole,
      replyText: "fallback",
      entryPolicy: "once_per_conversation",
    });
    setActiveScenarios([fallbackWithCanonicalPolicy]);

    const result = await resolveRuntime({
      triggerMessageText: "сәлем",
      scenarioState: retiredJourneyPoolState,
    });

    expect(result.runtime?.scenarioId).toBe(fallbackWithCanonicalPolicy._id);
  });

  it("does not let retired pool state block a repeatable scenario", async () => {
    const pooledPriceScenario = createScenario({
      id: priceScenario._id,
      name: priceScenario.name,
      priority: priceScenario.priority,
      matchingRole: priceScenario.matchingRole,
      triggerConfig: (priceScenario.nodes[0].data as ScenarioNodeData)
        .triggerConfig,
      replyText: "specific price",
      entryPolicy: "repeatable",
    });
    setActiveScenarios([pooledPriceScenario]);

    const result = await resolveRuntime({
      triggerMessageText: "баға қандай",
      scenarioState: retiredJourneyPoolState,
    });

    expect(result.runtime?.scenarioId).toBe(pooledPriceScenario._id);
    expect(result.runtime?.actionReplyText).toBe("specific price");
  });

  it("fetches active scenarios with the legacy-compatible conversation mode filter", async () => {
    setActiveScenarios([medalScenario]);

    await resolveRuntime({
      triggerMessageText: "маған медаль керек",
    });

    expect(mockScenarioFind).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-1",
        status: "active",
        deletedAt: null,
        mode: { $ne: "bulk_campaign" },
      })
    );
  });

  it("loads canonical and legacy entry policy fields for runtime eligibility", async () => {
    const query = setActiveScenarios([medalScenario]);

    await resolveRuntime({
      triggerMessageText: "маған медаль керек",
    });

    expectScenarioSelectIncludesRuntimeEntryPolicy(query);
  });

  it("loads canonical and legacy entry policy fields for locked scenario lookup", async () => {
    const query = setLockedScenario(medalScenario);

    await resolveRuntime({
      triggerMessageText: "pricing",
      scenarioState: {
        lockedScenarioId: medalScenario._id,
        lockedScenarioName: medalScenario.name,
        currentActionNodeId: `${medalScenario._id}-action`,
      },
    });

    expectScenarioSelectIncludesRuntimeEntryPolicy(query);
  });

  describe("a buttons message that also asks for details", () => {
    const scenarioId = "65f000000000000000000070";
    const ask = {
      version: 1,
      message: {
        kind: "reply_buttons",
        body: { mode: "fixed", text: "Pick a frame, then send the name." },
        options: [
          { id: "wsc:ask:gold", label: "Gold" },
          { id: "wsc:ask:silver", label: "Silver" },
        ],
      },
      promptInputs: [{ key: "name", label: "Name", prompt: "Name to engrave" }],
    };
    const branch = (id: string, payload: string) => ({
      id,
      data: {
        kind: "action",
        actionType: "reply",
        whatsAppSessionChoicePayload: payload,
        actionWhatsAppServiceMessage: {
          version: 1,
          message: {
            kind: "text",
            body: { mode: "fixed", text: `${id} for {{input.name}}` },
          },
        },
      },
    });
    const scenario = {
      _id: scenarioId,
      name: "Frames",
      priority: 5,
      entryPolicy: "once_per_conversation" as const,
      matchingRole: "default",
      updatedAt: new Date("2026-09-27T00:00:00.000Z"),
      nodes: [
        {
          id: "trigger-1",
          data: { kind: "trigger", triggerConfig: { enabled: true } },
        },
        {
          id: "ask",
          data: {
            kind: "action",
            actionType: "reply",
            actionWhatsAppServiceMessage: ask,
          },
        },
        branch("gold", "wsc:ask:gold"),
        branch("silver", "wsc:ask:silver"),
      ],
      edges: [
        { source: "trigger-1", target: "ask" },
        {
          source: "ask",
          sourceHandle:
            buildWhatsAppSessionChoiceSourceHandleId("wsc:ask:gold"),
          target: "gold",
        },
        {
          source: "ask",
          sourceHandle:
            buildWhatsAppSessionChoiceSourceHandleId("wsc:ask:silver"),
          target: "silver",
        },
      ],
    };
    const anchoredOnAsk = {
      lockedScenarioId: scenarioId,
      lockedScenarioName: "Frames",
      currentActionNodeId: "ask",
      currentPathNodeIds: ["trigger-1", "ask"],
      startedScenarios: [
        {
          scenarioId,
          scenarioName: "Frames",
          startedAt: "2026-09-27T08:00:00.000Z",
          firstActionNodeId: "ask",
        },
      ],
    };

    beforeEach(() => {
      setActiveScenarios([scenario]);
      setLockedScenario(scenario);
    });

    it("hands a tap's branch the message that asked for details", async () => {
      const result = await resolveRuntime({
        triggerEventKind: "whatsapp_button_reply",
        quickReplyPayload: "wsc:ask:gold",
        scenarioState: anchoredOnAsk,
      });

      expect(result.runtime?.selectedActionNodeId).toBe("gold");
      expect(result.runtime?.choicePromptInputSource).toEqual({
        actionNodeId: "ask",
        optionId: "wsc:ask:gold",
        config: expect.objectContaining({ promptInputs: ask.promptInputs }),
      });
    });

    it("answers the asking message with the customer's words when forced to it", async () => {
      const result = await resolveRuntime({
        triggerEventKind: "inbound_message",
        triggerMessageText: "Aya",
        forcedScenarioId: scenarioId,
        forcedActionNodeId: "ask",
        skipTriggerMatch: true,
        scenarioState: anchoredOnAsk,
      });

      expect(result.runtime?.selectedActionNodeId).toBe("ask");
      expect(
        result.runtime?.actionWhatsAppServiceMessage?.promptInputs
      ).toEqual(ask.promptInputs);
      expect(result.runtime?.choicePromptInputSource).toBeUndefined();
    });

    it("leaves a tap on a message that asks nothing without an ask", async () => {
      const plain = {
        ...scenario,
        // A new revision, so the compiled graph is not reused.
        updatedAt: new Date("2026-09-27T01:00:00.000Z"),
        nodes: scenario.nodes.map(node =>
          node.id === "ask"
            ? {
                ...node,
                data: {
                  ...node.data,
                  actionWhatsAppServiceMessage: { ...ask, promptInputs: [] },
                },
              }
            : node
        ),
      };
      setActiveScenarios([plain]);
      setLockedScenario(plain);

      const result = await resolveRuntime({
        triggerEventKind: "whatsapp_button_reply",
        quickReplyPayload: "wsc:ask:silver",
        scenarioState: anchoredOnAsk,
      });

      expect(result.runtime?.selectedActionNodeId).toBe("silver");
      expect(result.runtime?.choicePromptInputSource).toBeUndefined();
    });
  });
});
