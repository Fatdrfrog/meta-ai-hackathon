// Registers the shared module mocks; keep it the first import.
import {
  mockConversationFindById,
  mockConversationUpdateOne,
  mockScenarioFindOne,
  mockResolveActiveScenarioRuntime,
  mockPersistScenarioState,
  mockFinalizeScenarioResolution,
  mockCompleteScenarioAfterDispatch,
  mockSendAndPersistOutbound,
  mockRunIntentFastPath,
  mockRunRagReplyFlow,
} from "./auto-reply-harness-fixtures";
import type { ScenarioRuntimeDependencies } from "@icecore/airi-runtime/scenario-runtime-dependencies";
import { airiOrchestrationLogger } from "@icecore/airi-runtime/logging";
import {
  GENERATIVE_AI_CUSTOMER_REQUEST_LABEL,
  GENERATIVE_AI_CUSTOMER_VALUES_NOTE,
} from "@icecore/scenario-contracts";
import { buildScenarioInstructionAnswers } from "@/lib/airi/reply/runtime/scenario";
import type { ConversationDocument } from "@/types/models";

/**
 * Auto-reply regressions for form answers: what a Flow reply records, and
 * how AI steps read it. The harness mirrors scenario-runtime-prompt-inputs:
 * web effects are mocked and the scenario host is supplied per invocation.
 */

const mockExtractScenarioPromptInputs = jest.fn();
const mockClaimGenerativeExecution = jest.fn();
const mockCaptureTemporalDeferredCommand = jest.fn();

jest.mock("@/lib/airi/reply/delivery/temporal-outbound", () => ({
  ...jest.requireActual("@/lib/airi/reply/delivery/temporal-outbound"),
  captureTemporalDeferredCommand: (...args: unknown[]) =>
    mockCaptureTemporalDeferredCommand(...args),
}));
jest.mock("@/lib/ai", () => ({
  chatCompletionWithFallback: jest.fn(),
  getLightTextModel: () => "light-test-model",
}));
jest.mock("@/lib/mongoose", () => ({
  __esModule: true,
  default: jest.fn().mockRejectedValue(new Error("Unexpected database access")),
}));
jest.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: {} }));
jest.mock("@icecore/airi-runtime/module-interop", () => {
  const actual = jest.requireActual("@icecore/airi-runtime/module-interop");
  return {
    ...actual,
    createWebRequire: () => (request: string) => {
      if (request.endsWith("/models/conversation")) {
        return {
          Conversation: {
            findById: (...args: unknown[]) => mockConversationFindById(...args),
          },
        };
      }
      if (request.endsWith("/models/scenario")) {
        return {
          Scenario: {
            findOne: (...args: unknown[]) => mockScenarioFindOne(...args),
          },
        };
      }
      throw new Error(`Unexpected web require: ${request}`);
    },
  };
});
jest.mock("@/models/message", () => ({
  __esModule: true,
  default: { findById: jest.fn() },
}));
jest.mock("@/lib/airi/scenario/scenario-runtime", () => ({
  ...jest.requireActual("@/lib/airi/scenario/scenario-post-action-routing"),
  resolveActiveScenarioRuntime: jest.fn(),
  resolveInteractiveReplyConditionTarget: jest.fn().mockReturnValue(null),
}));
jest.mock("@/lib/airi/reply/runtime/auto-reply-scenario-state", () => ({
  completeScenarioAfterDispatch: (...args: unknown[]) =>
    mockCompleteScenarioAfterDispatch(...args),
}));
jest.mock("@/lib/airi/reply/runtime/generative-ai-execution-store", () => ({
  ...jest.requireActual(
    "@/lib/airi/reply/runtime/generative-ai-execution-store"
  ),
  claimGenerativeExecution: (...args: unknown[]) =>
    mockClaimGenerativeExecution(...args),
}));
jest.mock("@/lib/airi/reply/runtime/auto-reply-realtime", () => ({
  persistSuppressedState: jest.fn(),
  TypingManager: class {
    start = jest.fn().mockResolvedValue(undefined);
    stop = jest.fn();
  },
}));
jest.mock("@/lib/cache", () => ({
  buildCacheKey: (...parts: unknown[]) => parts.join(":"),
  cache: {
    del: jest.fn().mockResolvedValue(undefined),
    get: jest.fn().mockResolvedValue(null),
    setNX: jest.fn().mockResolvedValue(true),
  },
}));
jest.mock("@/lib/airi/reply/runtime/inbound-burst", () => ({
  resolveInboundBurstOwnership: jest
    .fn()
    .mockResolvedValue({ shouldProcess: true }),
}));
jest.mock("@/lib/limits/company-limits", () => ({
  ...jest.requireActual("@/lib/limits/company-limits"),
  ensureCompanyAiriAutoReplyCapacity: jest
    .fn()
    .mockResolvedValue({ allowed: true }),
}));
jest.mock("@/lib/airi/reply/runtime/manager-reply-guard", () => ({
  evaluateManagerReplyGuard: jest.fn().mockResolvedValue({ skip: false }),
}));
jest.mock("@/lib/airi/reply/delivery/outbound-message", () => ({
  // Voice replies don't apply to these turns.
  resolveWhatsAppVoiceReplyIntent: () => undefined,
  sendAndPersistOutbound: (...args: unknown[]) =>
    mockSendAndPersistOutbound(...args),
}));
jest.mock("@/lib/airi/reply/delivery/reply-delivery-gate", () => ({
  ...jest.requireActual("@/lib/airi/reply/delivery/reply-delivery-gate"),
  evaluateReplyDeliveryGate: jest.fn().mockReturnValue({ allowSend: true }),
}));
jest.mock("@/lib/airi/coach/coach-utils-server", () => ({
  detectAndUpdateConversationLanguageDecision: jest
    .fn()
    .mockResolvedValue(null),
}));
jest.mock("@/lib/company-context", () => ({
  fetchCompanyContextBySourceId: jest.fn().mockResolvedValue({}),
}));
jest.mock("@/lib/airi/shouldContinueProcessing", () => ({
  shouldContinueProcessing: jest.fn().mockResolvedValue(true),
}));
jest.mock("@icecore/airi-runtime/logging", () => ({
  airiOrchestrationLogger: {
    error: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
  },
  airiReplyLogger: { error: jest.fn(), info: jest.fn(), warn: jest.fn() },
}));

const SCENARIO_A = "65f0000000000000000000a1";
const SCENARIO_B = "65f0000000000000000000b2";

const FLOW_REPLY_TURN = {
  triggerEventKind: "whatsapp_flow_reply",
  whatsAppFlowResponseJson: JSON.stringify({
    size: "opt_l",
    flow_token: "flow_order_1",
  }),
};
const FLOW_REPLY_MESSAGE = {
  text: "[Flow response: order_details] Size: Large",
  mediaType: "interactive",
  whatsappMeta: { replyToWhatsAppMessageId: "ws_wamid.order" },
  whatsappFlowReply: { flowName: "order_details", flowToken: "flow_order_1" },
};

/** Keys and labels the runtime publishes for the scenario's two forms. */
const FORM_FIELDS = {
  "contact-form": {
    formKey: "contact",
    formLabel: "Contact",
    fields: { full_name: { key: "full_name", label: "Full name" } },
  },
  "order-form": {
    formKey: "order",
    formLabel: "Order details",
    fields: {
      size: { key: "size", label: "Size" },
      notes: { key: "notes", label: "Notes" },
    },
  },
};

const ORDER_SOURCE = {
  scenarioId: SCENARIO_A,
  sourceActionNodeId: "order-form",
  flowId: "flow-order",
  // A dropdown-only form: its answer is the option the customer saw.
  fields: [
    {
      id: "size",
      label: "Size",
      fieldType: "Dropdown",
      options: [
        { id: "opt_m", title: "Medium" },
        { id: "opt_l", title: "Large" },
      ],
    },
  ],
};

function submission(
  sourceActionNodeId: string,
  fields: Array<{ key: string; label: string; value: string }>
) {
  return {
    sourceActionNodeId,
    flowId: null,
    inboundMessageId: `in-${sourceActionNodeId}`,
    submittedAt: "2026-09-30T09:00:00.000Z",
    fields: fields.map(field => ({ ...field, fieldType: "TextInput" })),
  };
}

const CONTACT_SUBMISSION = submission("contact-form", [
  { key: "full_name", label: "Full name", value: "Aya Bek" },
]);
const ORDER_SUBMISSION = submission("order-form", [
  { key: "size", label: "Size", value: 'Large "gold"' },
]);

function formState(
  scenarioId: string,
  submissions: unknown[],
  overrides: Record<string, unknown> = {}
) {
  return {
    lockedScenarioId: SCENARIO_A,
    currentActionNodeId: "order-form",
    formAnswers: { scenarioId, submissions },
    ...overrides,
  };
}

function fixedReplyRuntime(
  text: string,
  overrides: Record<string, unknown> = {}
) {
  return {
    scenarioId: SCENARIO_A,
    scenarioName: "Orders",
    actionType: "reply",
    actionReplyMode: "fixed",
    actionReplyText: text,
    selectedActionNodeId: "reply",
    selectedPathNodeIds: ["trigger", "order-form", "reply"],
    nextActionNodeId: null,
    completesScenario: true,
    formAnswerFields: FORM_FIELDS,
    ...overrides,
  };
}

function aiReplyRuntime(instruction: string) {
  return {
    scenarioId: SCENARIO_A,
    scenarioName: "Orders",
    actionType: "reply",
    actionReplyMode: "ai",
    actionReplyInstruction: instruction,
    selectedActionNodeId: "answer",
    selectedPathNodeIds: ["trigger", "contact-form", "order-form", "answer"],
    nextActionNodeId: null,
    completesScenario: true,
    formAnswerFields: FORM_FIELDS,
    includeConversationTimeline: false,
    includeConversationSummaries: false,
    includeSnippets: false,
    includeKBArticles: false,
    includeIndexedUrls: false,
    includeQuickReplies: false,
    includeCustomerProfile: false,
    includePurchaseHistory: false,
    includeActiveSubscriptions: false,
    includeDynamicBusinessTags: false,
  };
}

const TEXT_INPUT = {
  status: "compatible",
  input: {
    messageId: "message-1",
    kind: "text",
    textOrCaption: "Make it shine",
    whatsappMediaId: null,
    declaredMimeType: null,
    fileName: null,
  },
};

function generativeRuntime(prompt: string) {
  return {
    scenarioId: SCENARIO_A,
    scenarioName: "Orders",
    actionType: "generative_ai",
    selectedActionNodeId: "generate",
    selectedPathNodeIds: ["trigger", "order-form", "generate"],
    nextActionNodeId: "generate",
    completesScenario: false,
    scenarioRevisionFingerprint: "a".repeat(64),
    formAnswerFields: FORM_FIELDS,
    actionGenerativeAI: {
      config: {
        version: 1,
        mode: "text_to_image",
        prompt,
        image: {
          provider: "google",
          sourceId: "11111111-1111-4111-8111-111111111111",
          modelId: "gemini-3.1-flash-image",
          aspectRatio: "1:1",
          referenceImages: [],
          includeInboundText: true,
        },
      },
      input: TEXT_INPUT,
    },
    actionGenerativeAISuccessTransition: {
      nextActionNodeId: "deliver",
      completesScenario: false,
    },
    actionGenerativeAIFailureTransition: {
      nextActionNodeId: "sorry",
      completesScenario: false,
    },
  };
}

// The real fenced write, against the mocked conversation model.
const { persistScenarioFormSubmission } = jest.requireActual<
  typeof import("@/lib/airi/reply/runtime/auto-reply-scenario-state")
>("@/lib/airi/reply/runtime/auto-reply-scenario-state");

function dependencies(
  overrides: Partial<ScenarioRuntimeDependencies<ConversationDocument>> = {}
): ScenarioRuntimeDependencies<ConversationDocument> {
  return {
    runTextAiAction: async (_scope, run) => run(),
    loadActiveScenarioSnapshot: jest.fn().mockResolvedValue(null),
    resolveActiveScenarioRuntime: (...args) =>
      mockResolveActiveScenarioRuntime(...args),
    clearPendingConditionStateAndPersist: jest.fn(),
    completeLockedScenarioAndPersist: jest.fn(),
    finalizeScenarioResolution: (...args) =>
      mockFinalizeScenarioResolution(...args),
    findLatestScenarioActionOutbound: jest.fn().mockResolvedValue("outbound-1"),
    persistPendingConditionState: jest.fn(),
    persistScenarioFormSubmission,
    persistScenarioState: (...args) => mockPersistScenarioState(...args),
    extractScenarioPromptInputs: (...args) =>
      mockExtractScenarioPromptInputs(...args),
    ...overrides,
  };
}

async function runTurn(params: {
  scenarioState: unknown;
  message?: Record<string, unknown>;
  turn?: Record<string, unknown>;
  conversation?: Record<string, unknown>;
  dependencies?: Partial<ScenarioRuntimeDependencies<ConversationDocument>>;
}) {
  const { default: airiAutoReply } = await import(
    "@icecore/airi-runtime/auto-reply"
  );
  const response = await airiAutoReply(
    {
      type: "whatsapp",
      triggerEventKind: "inbound_message",
      runtimeHydrated: true,
      workspaceId: "workspace-1",
      chatDocument: { _id: "chat-1", sourceId: "source-1" } as never,
      conversation: {
        _id: "conversation-1",
        sourceId: "source-1",
        airi_bot_enabled: false,
        airi_scenarios_enabled: true,
        airi_scenario_state: params.scenarioState,
        ...params.conversation,
      } as never,
      newMessage: {
        _id: "message-1",
        direction: "inbound",
        channel: "whatsapp",
        date: new Date("2026-09-30T10:00:00.000Z"),
        text: "hello",
        ...params.message,
      } as never,
      ...params.turn,
    },
    dependencies(params.dependencies)
  );
  return response.json();
}

function persistedBaseStates() {
  return mockPersistScenarioState.mock.calls.map(([call]) => call.baseState);
}

function warnings(note: string) {
  return (airiOrchestrationLogger.warn as jest.Mock).mock.calls.filter(
    ([, context]) => context?.note === note
  );
}

function infos(note: string) {
  return (airiOrchestrationLogger.info as jest.Mock).mock.calls.filter(
    ([, context]) => context?.note === note
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  mockPersistScenarioState.mockResolvedValue(undefined);
  mockCompleteScenarioAfterDispatch.mockResolvedValue(undefined);
  mockConversationUpdateOne.mockResolvedValue({ matchedCount: 1 });
  mockSendAndPersistOutbound.mockImplementation(async () => ({
    _id: "outbound-1",
    date: new Date("2026-09-30T10:00:01.000Z"),
  }));
  mockScenarioFindOne.mockReturnValue({
    select: () => ({ lean: async () => null }),
  });
  mockClaimGenerativeExecution.mockImplementation(async ({ execution }) => ({
    status: "claimed",
    execution,
  }));
});

describe("a submitted form", () => {
  it("is recorded before routing, from the message the reply cites", async () => {
    const findSubmittedScenarioForm = jest.fn().mockResolvedValue(ORDER_SOURCE);
    mockResolveActiveScenarioRuntime.mockResolvedValue({
      runtime: fixedReplyRuntime("Thanks!"),
    });

    await runTurn({
      scenarioState: formState(SCENARIO_A, [CONTACT_SUBMISSION]),
      message: FLOW_REPLY_MESSAGE,
      turn: FLOW_REPLY_TURN,
      dependencies: { findSubmittedScenarioForm },
    });

    expect(findSubmittedScenarioForm).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      contextMessageId: "ws_wamid.order",
      flowToken: "flow_order_1",
    });
    // Forms stack up; the dropdown-only form's answer is its own, by title.
    const formAnswers = {
      scenarioId: SCENARIO_A,
      submissions: [
        CONTACT_SUBMISSION,
        {
          sourceActionNodeId: "order-form",
          flowId: "flow-order",
          inboundMessageId: "message-1",
          submittedAt: expect.any(String),
          fields: [
            {
              key: "size",
              label: "Size",
              fieldType: "Dropdown",
              value: "Large",
            },
          ],
        },
      ],
    };
    expect(mockResolveActiveScenarioRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        scenarioState: expect.objectContaining({ formAnswers }),
      })
    );
    expect(persistedBaseStates()).toEqual([
      expect.objectContaining({ formAnswers }),
    ]);
  });

  it("reaches the next AI step together with every earlier form", async () => {
    const runtime = aiReplyRuntime(
      "Confirm size {{form.order.size}} for {{form.contact.full_name}}."
    );
    mockResolveActiveScenarioRuntime.mockResolvedValue({ runtime });
    mockRunIntentFastPath.mockResolvedValue({
      threadReplyContext: {},
      customerReplyLanguage: "en",
    });
    mockRunRagReplyFlow.mockResolvedValue({
      ragResult: { type: "ai_reply", content: "Large it is, Aya." },
      scenarioRuntime: runtime,
      queryText: "done",
    });

    await runTurn({
      scenarioState: formState(SCENARIO_A, [CONTACT_SUBMISSION]),
      message: FLOW_REPLY_MESSAGE,
      turn: FLOW_REPLY_TURN,
      dependencies: {
        findSubmittedScenarioForm: jest.fn().mockResolvedValue(ORDER_SOURCE),
      },
    });

    const { scenarioStateForResolution } = mockRunRagReplyFlow.mock.calls[0][0];
    const answers = buildScenarioInstructionAnswers({
      scenarioRuntime: runtime as never,
      scenarioState: scenarioStateForResolution,
    });
    expect(answers.scenarioRuntime.actionReplyInstruction).toBe(
      "Confirm size [Order details › Size] for [Contact › Full name]."
    );
    expect(answers.customerAnswersBlock).toBe(
      "[Order details › Size]: “Large”\n" + "[Contact › Full name]: “Aya Bek”"
    );
  });

  it("does not fail the turn when the lookup fails", async () => {
    mockResolveActiveScenarioRuntime.mockResolvedValue({
      runtime: fixedReplyRuntime("Thanks!"),
    });

    expect(
      await runTurn({
        scenarioState: formState(SCENARIO_A, [CONTACT_SUBMISSION]),
        message: FLOW_REPLY_MESSAGE,
        turn: FLOW_REPLY_TURN,
        dependencies: {
          findSubmittedScenarioForm: jest
            .fn()
            .mockRejectedValue(new Error("storage unavailable")),
        },
      })
    ).toMatchObject({ status: "ok", scenario_reply: true });
    expect(warnings("scenario_form_lookup_failed")).toHaveLength(1);
    expect(persistedBaseStates()).toEqual([
      expect.objectContaining({
        formAnswers: {
          scenarioId: SCENARIO_A,
          submissions: [CONTACT_SUBMISSION],
        },
      }),
    ]);
  });

  it("looks nothing up for a contact-info reply or a plain message", async () => {
    const findSubmittedScenarioForm = jest.fn();
    mockResolveActiveScenarioRuntime.mockResolvedValue({
      runtime: fixedReplyRuntime("Thanks!"),
    });

    await runTurn({
      scenarioState: { lockedScenarioId: SCENARIO_A },
      message: {
        ...FLOW_REPLY_MESSAGE,
        whatsappFlowReply: { flowName: "address_message" },
      },
      turn: FLOW_REPLY_TURN,
      dependencies: { findSubmittedScenarioForm },
    });
    await runTurn({
      scenarioState: { lockedScenarioId: SCENARIO_A },
      dependencies: { findSubmittedScenarioForm },
    });

    expect(findSubmittedScenarioForm).not.toHaveBeenCalled();
  });

  it("renders a missing answer empty in fixed text instead of failing the turn", async () => {
    mockResolveActiveScenarioRuntime.mockResolvedValue({
      runtime: fixedReplyRuntime(
        "Size: {{form.order.size}}. Name: {{form.contact.full_name}}."
      ),
    });

    expect(
      await runTurn({
        scenarioState: formState(SCENARIO_A, [ORDER_SUBMISSION]),
      })
    ).toMatchObject({ status: "ok", scenario_reply: true });
    expect(mockSendAndPersistOutbound).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'Size: Large "gold". Name: .' })
    );
  });
});

describe("a submitted form whose reply takes no route", () => {
  // The order form waits for No reply when its reply arrives.
  const WAITING_STATE = formState(SCENARIO_A, [CONTACT_SUBMISSION], {
    lockedScenarioName: "Orders",
    currentPathNodeIds: ["trigger", "contact-form", "order-form"],
    pendingConditionNodeId: "order-form-no-reply",
    pendingSourceActionNodeId: "order-form",
    pendingStartedAt: new Date("2026-09-30T09:30:00.000Z"),
    pendingLastOutboundMessageId: "outbound-order",
    lastMessageId: "outbound-order",
  });
  const NO_MATCH = {
    runtime: null,
    lockedScenarioNoMatch: {
      scenarioId: SCENARIO_A,
      scenarioName: "Orders",
      lastActionNodeId: "order-form",
    },
  };
  const submitOrder = (scenarioState: unknown) =>
    runTurn({
      scenarioState,
      message: FLOW_REPLY_MESSAGE,
      turn: FLOW_REPLY_TURN,
      dependencies: {
        findSubmittedScenarioForm: jest.fn().mockResolvedValue(ORDER_SOURCE),
      },
    });

  it.each([
    [
      "matches no route",
      NO_MATCH,
      { skipped_interactive_reply_no_branch_match: true },
    ],
    [
      "starts no scenario",
      { runtime: null },
      { skipped_flow_reply_no_branch_match: true },
    ],
  ])(
    "saves its answers over the turn's state when the reply %s",
    async (_, resolution, skipped) => {
      mockResolveActiveScenarioRuntime.mockResolvedValue(resolution);

      expect(await submitOrder(WAITING_STATE)).toEqual({
        status: "ok",
        ...skipped,
      });
      expect(mockPersistScenarioState).not.toHaveBeenCalled();
      expect(mockFinalizeScenarioResolution).not.toHaveBeenCalled();
      expect(mockConversationUpdateOne).toHaveBeenCalledTimes(1);
      const [filter, update] = mockConversationUpdateOne.mock.calls[0];
      // Fenced to the state the turn began with: any write since then wins.
      expect(filter).toEqual({
        _id: "conversation-1",
        "airi_scenario_state.lockedScenarioId": SCENARIO_A,
        "airi_scenario_state.lockedScenarioName": "Orders",
        "airi_scenario_state.currentActionNodeId": "order-form",
        "airi_scenario_state.scenarioRevisionFingerprint": null,
        "airi_scenario_state.currentPathNodeIds": [
          "trigger",
          "contact-form",
          "order-form",
        ],
        "airi_scenario_state.currentBranchNodeIds": [],
        "airi_scenario_state.lastMessageId": "outbound-order",
        "airi_scenario_state.pendingConditionNodeId": "order-form-no-reply",
        "airi_scenario_state.pendingSourceActionNodeId": "order-form",
        "airi_scenario_state.pendingStartedAt": new Date(
          "2026-09-30T09:30:00.000Z"
        ),
        "airi_scenario_state.pendingLastOutboundMessageId": "outbound-order",
        "airi_scenario_state.pendingLinkedConditionId": null,
      });
      // The wait and its timer stay; the answers join the earlier form's.
      expect(update.$set.airi_scenario_state).toMatchObject({
        currentActionNodeId: "order-form",
        pendingConditionNodeId: "order-form-no-reply",
        pendingSourceActionNodeId: "order-form",
        pendingStartedAt: new Date("2026-09-30T09:30:00.000Z"),
        pendingLastOutboundMessageId: "outbound-order",
        lastMessageId: "outbound-order",
        formAnswers: {
          scenarioId: SCENARIO_A,
          submissions: [
            CONTACT_SUBMISSION,
            expect.objectContaining({
              sourceActionNodeId: "order-form",
              inboundMessageId: "message-1",
            }),
          ],
        },
      });
      expect(infos("scenario_form_submission_persisted")).toHaveLength(1);
    }
  );

  it.each([
    [
      "no scenario holds the conversation",
      { lockedScenarioId: null, currentActionNodeId: null },
    ],
    [
      "another scenario holds the conversation",
      { ...WAITING_STATE, lockedScenarioId: SCENARIO_B },
    ],
    [
      // Typed text ended the scenario before its form came back.
      "the scenario already ended",
      {
        lockedScenarioId: null,
        currentActionNodeId: null,
        completedScenarios: [
          {
            scenarioId: SCENARIO_A,
            scenarioName: "Orders",
            completedAt: "2026-09-30T09:59:00.000Z",
            lastActionNodeId: "order-form",
          },
        ],
      },
    ],
  ])("saves nothing when %s", async (_, scenarioState) => {
    mockResolveActiveScenarioRuntime.mockResolvedValue({ runtime: null });

    expect(await submitOrder(scenarioState)).toEqual({
      status: "ok",
      skipped_flow_reply_no_branch_match: true,
    });
    expect(mockConversationUpdateOne).not.toHaveBeenCalled();
    expect(infos("scenario_form_submission_persist_skipped")).toHaveLength(1);
  });

  it("saves nothing once the conversation changed after the turn began", async () => {
    mockResolveActiveScenarioRuntime.mockResolvedValue(NO_MATCH);
    mockConversationUpdateOne.mockResolvedValue({ matchedCount: 0 });

    expect(await submitOrder(WAITING_STATE)).toEqual({
      status: "ok",
      skipped_interactive_reply_no_branch_match: true,
    });
    expect(mockConversationUpdateOne).toHaveBeenCalledTimes(1);
    expect(infos("scenario_form_submission_persist_skipped")).toHaveLength(1);
    expect(infos("scenario_form_submission_persisted")).toHaveLength(0);
  });

  it("does not fail the turn when the write fails", async () => {
    mockResolveActiveScenarioRuntime.mockResolvedValue(NO_MATCH);
    mockConversationUpdateOne.mockRejectedValue(new Error("write failed"));

    expect(await submitOrder(WAITING_STATE)).toEqual({
      status: "ok",
      skipped_interactive_reply_no_branch_match: true,
    });
    expect(warnings("scenario_form_submission_persist_failed")).toEqual([
      [
        "airi.orchestration",
        expect.objectContaining({
          scenarioId: SCENARIO_A,
          sourceActionNodeId: "order-form",
          errorMessage: "write failed",
        }),
      ],
    ]);
  });
});

describe("a submitted form when the conversation's state changes", () => {
  /** The order form's answer as the capture records it. */
  const CAPTURED_ORDER = {
    sourceActionNodeId: "order-form",
    flowId: "flow-order",
    inboundMessageId: "message-1",
    submittedAt: expect.any(String),
    fields: [
      { key: "size", label: "Size", fieldType: "Dropdown", value: "Large" },
    ],
  };
  const RELEASED_STATE = {
    lockedScenarioId: null,
    currentActionNodeId: null,
    completedScenarios: [{ scenarioId: SCENARIO_A }],
  };

  it("still counts when the reply releases an expired ask", async () => {
    const completeLockedScenarioAndPersist = jest
      .fn()
      .mockResolvedValue({ state: RELEASED_STATE, persisted: true });
    mockResolveActiveScenarioRuntime.mockResolvedValue({
      runtime: fixedReplyRuntime("Thanks!"),
    });

    await runTurn({
      scenarioState: formState(SCENARIO_A, [CONTACT_SUBMISSION], {
        currentActionNodeId: "ask",
        collectedPromptInputs: {
          scenarioId: SCENARIO_A,
          sourceActionNodeId: "ask",
          awaitingReply: true,
          resumeActionNodeId: null,
          sourcePathNodeIds: ["trigger", "ask"],
          values: {},
          expiresAt: new Date(Date.now() - 60_000).toISOString(),
        },
      }),
      message: FLOW_REPLY_MESSAGE,
      turn: FLOW_REPLY_TURN,
      dependencies: {
        completeLockedScenarioAndPersist,
        findSubmittedScenarioForm: jest.fn().mockResolvedValue(ORDER_SOURCE),
      },
    });

    expect(completeLockedScenarioAndPersist).toHaveBeenCalledTimes(1);
    // Releasing the ask ended the scenario and cleared its answers; this
    // reply's form still counts in the state routing reads.
    expect(
      mockResolveActiveScenarioRuntime.mock.calls[0][0].scenarioState
    ).toEqual({
      ...RELEASED_STATE,
      formAnswers: { scenarioId: SCENARIO_A, submissions: [CAPTURED_ORDER] },
    });
  });

  it("still counts after finalization replaces a missing locked scenario", async () => {
    mockResolveActiveScenarioRuntime.mockResolvedValue({
      runtime: null,
      lockedScenarioMissing: { scenarioId: SCENARIO_A, scenarioName: "Orders" },
    });
    mockFinalizeScenarioResolution.mockResolvedValue(
      fixedReplyRuntime("Size: {{form.order.size}}", { scenarioId: SCENARIO_B })
    );
    mockConversationFindById.mockReturnValue({
      select: () => ({
        lean: async () => ({ airi_scenario_state: RELEASED_STATE }),
      }),
    });

    await runTurn({
      scenarioState: formState(SCENARIO_A, [CONTACT_SUBMISSION]),
      message: FLOW_REPLY_MESSAGE,
      turn: FLOW_REPLY_TURN,
      dependencies: {
        findSubmittedScenarioForm: jest
          .fn()
          .mockResolvedValue({ ...ORDER_SOURCE, scenarioId: SCENARIO_B }),
      },
    });

    expect(mockFinalizeScenarioResolution).toHaveBeenCalledTimes(1);
    // The turn continues from the committed state, with this reply's form.
    expect(mockSendAndPersistOutbound).toHaveBeenCalledWith(
      expect.objectContaining({ content: "Size: Large" })
    );
  });

  it("keeps the answers of the scenario holding the conversation when another scenario's form arrives", async () => {
    mockResolveActiveScenarioRuntime.mockResolvedValue({
      runtime: fixedReplyRuntime("Thanks!"),
    });
    const heldAnswers = {
      scenarioId: SCENARIO_A,
      submissions: [CONTACT_SUBMISSION],
    };

    await runTurn({
      scenarioState: formState(SCENARIO_A, [CONTACT_SUBMISSION]),
      message: FLOW_REPLY_MESSAGE,
      turn: FLOW_REPLY_TURN,
      dependencies: {
        findSubmittedScenarioForm: jest
          .fn()
          .mockResolvedValue({ ...ORDER_SOURCE, scenarioId: SCENARIO_B }),
      },
    });

    expect(
      mockResolveActiveScenarioRuntime.mock.calls[0][0].scenarioState
    ).toEqual(expect.objectContaining({ formAnswers: heldAnswers }));
    expect(persistedBaseStates()).toEqual([
      expect.objectContaining({ formAnswers: heldAnswers }),
    ]);
  });

  it("records another scenario's form once that scenario takes the turn", async () => {
    mockResolveActiveScenarioRuntime.mockResolvedValue({
      runtime: fixedReplyRuntime("Thanks!", { scenarioId: SCENARIO_B }),
    });

    await runTurn({
      scenarioState: formState(SCENARIO_A, [CONTACT_SUBMISSION]),
      message: FLOW_REPLY_MESSAGE,
      turn: FLOW_REPLY_TURN,
      dependencies: {
        findSubmittedScenarioForm: jest
          .fn()
          .mockResolvedValue({ ...ORDER_SOURCE, scenarioId: SCENARIO_B }),
      },
    });

    expect(persistedBaseStates()).toEqual([
      expect.objectContaining({
        formAnswers: { scenarioId: SCENARIO_B, submissions: [CAPTURED_ORDER] },
      }),
    ]);
  });
});

describe("form answers in an image or video prompt", () => {
  it("freezes the answers quoted, with the note, and screens them by name", async () => {
    mockResolveActiveScenarioRuntime.mockResolvedValue({
      runtime: generativeRuntime(
        "A medal for {{form.contact.full_name}} in size {{form.order.size}}"
      ),
    });
    const screenGenerativeAICustomerText = jest
      .fn()
      .mockResolvedValue({ flagged: false, reason: null });

    expect(
      await runTurn({
        scenarioState: formState(SCENARIO_A, [
          CONTACT_SUBMISSION,
          ORDER_SUBMISSION,
        ]),
        message: { text: "Make it shine" },
        dependencies: {
          countGenerativeAIStarts: jest.fn().mockResolvedValue(0),
          screenGenerativeAICustomerText,
        },
      })
    ).toEqual({ status: "ok", scenario_generative_ai: "started" });
    expect(mockClaimGenerativeExecution).toHaveBeenCalledWith(
      expect.objectContaining({
        execution: expect.objectContaining({
          composedPrompt: [
            "A medal for “Aya Bek” in size “Large gold”",
            GENERATIVE_AI_CUSTOMER_VALUES_NOTE,
            `${GENERATIVE_AI_CUSTOMER_REQUEST_LABEL}\nMake it shine`,
          ].join("\n\n"),
        }),
      })
    );
    expect(screenGenerativeAICustomerText).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      mode: "text_to_image",
      parts: [
        { kind: "answer", label: "Contact › Full name", text: "Aya Bek" },
        { kind: "answer", label: "Order details › Size", text: 'Large "gold"' },
        { kind: "request", label: "message", text: "Make it shine" },
      ],
    });
  });

  it("renders a blank answer of a submitted form empty and still generates", async () => {
    mockResolveActiveScenarioRuntime.mockResolvedValue({
      runtime: generativeRuntime(
        "Size {{form.order.size}}, notes: {{form.order.notes}}"
      ),
    });

    expect(
      await runTurn({
        scenarioState: formState(SCENARIO_A, [ORDER_SUBMISSION]),
      })
    ).toEqual({ status: "ok", scenario_generative_ai: "started" });
    expect(
      mockClaimGenerativeExecution.mock.calls[0][0].execution.composedPrompt
    ).toBe(
      [
        "Size “Large gold”, notes:",
        GENERATIVE_AI_CUSTOMER_VALUES_NOTE,
        `${GENERATIVE_AI_CUSTOMER_REQUEST_LABEL}\nMake it shine`,
      ].join("\n\n")
    );
  });

  it.each([
    ["no form submitted yet", formState(SCENARIO_A, [])],
    ["only another form", formState(SCENARIO_A, [CONTACT_SUBMISSION])],
    ["another scenario's form", formState(SCENARIO_B, [ORDER_SUBMISSION])],
  ])(
    "follows Failure before any claim or check with %s",
    async (_case, scenarioState) => {
      mockResolveActiveScenarioRuntime.mockResolvedValue({
        runtime: generativeRuntime("A medal in size {{form.order.size}}"),
      });
      const countGenerativeAIStarts = jest.fn().mockResolvedValue(0);
      const screenGenerativeAICustomerText = jest.fn();

      expect(
        await runTurn({
          scenarioState,
          dependencies: {
            countGenerativeAIStarts,
            screenGenerativeAICustomerText,
          },
        })
      ).toEqual({ status: "ok", scenario_generative_ai: "failure" });
      expect(mockClaimGenerativeExecution).not.toHaveBeenCalled();
      expect(mockCaptureTemporalDeferredCommand).not.toHaveBeenCalled();
      expect(countGenerativeAIStarts).not.toHaveBeenCalled();
      expect(screenGenerativeAICustomerText).not.toHaveBeenCalled();
      expect(mockPersistScenarioState.mock.calls[0][0].scenarioRuntime).toEqual(
        expect.objectContaining({ nextActionNodeId: "sorry" })
      );
      expect(warnings("scenario_generative_prompt_rejected")).toEqual([
        [
          "airi.orchestration",
          expect.objectContaining({ reason: "form_answer_missing" }),
        ],
      ]);
    }
  );
});

describe("answers a Flow also saves as collected details", () => {
  const fullDetails = Object.fromEntries(
    Array.from({ length: 24 }, (_, index) => [`detail_${index}`, "answer"])
  );

  it("no longer fail the turn when the collected details are full", async () => {
    mockResolveActiveScenarioRuntime.mockResolvedValue({
      runtime: fixedReplyRuntime("Thanks!", {
        flowPromptInputCapture: {
          sourceActionNodeId: "order-form",
          values: { full_name: "Aya Bek" },
        },
      }),
    });
    const collectedPromptInputs = {
      scenarioId: SCENARIO_A,
      sourceActionNodeId: "ask",
      awaitingReply: false,
      resumeActionNodeId: null,
      sourcePathNodeIds: ["trigger", "ask"],
      values: fullDetails,
    };

    expect(
      await runTurn({
        scenarioState: formState(SCENARIO_A, [], { collectedPromptInputs }),
        message: FLOW_REPLY_MESSAGE,
        turn: FLOW_REPLY_TURN,
        dependencies: {
          findSubmittedScenarioForm: jest.fn().mockResolvedValue(ORDER_SOURCE),
        },
      })
    ).toMatchObject({ status: "ok", scenario_reply: true });
    expect(mockSendAndPersistOutbound).toHaveBeenCalledWith(
      expect.objectContaining({ content: "Thanks!" })
    );
    expect(warnings("scenario_flow_prompt_inputs_over_capacity")).toEqual([
      [
        "airi.orchestration",
        expect.objectContaining({
          scenarioId: SCENARIO_A,
          sourceActionNodeId: "order-form",
          // The log says whether the answers were kept as form answers.
          formAnswersCaptured: true,
        }),
      ],
    ]);
    const [persisted] = persistedBaseStates();
    expect(persisted.collectedPromptInputs.values).toEqual(fullDetails);
    expect(persisted.formAnswers.submissions).toHaveLength(1);
  });

  it("stay with the form answers when a tap starts another ask", async () => {
    const choiceAsk = {
      version: 1,
      message: {
        kind: "reply_buttons",
        body: { mode: "fixed", text: "Pick a frame, then send the name." },
        options: [{ id: "wsc:ask:gold", label: "Gold" }],
      },
      promptInputs: [{ key: "name", label: "Name", prompt: "Name" }],
    };
    mockResolveActiveScenarioRuntime.mockResolvedValue({
      runtime: fixedReplyRuntime("Gold frame for {{input.name}}", {
        selectedActionNodeId: "gold",
        selectedPathNodeIds: ["trigger", "order-form", "ask", "gold"],
        choicePromptInputSource: {
          actionNodeId: "ask",
          optionId: "wsc:ask:gold",
          config: choiceAsk,
        },
      }),
    });
    const scenarioState = formState(SCENARIO_A, [ORDER_SUBMISSION], {
      currentActionNodeId: "ask",
      collectedPromptInputs: {
        scenarioId: SCENARIO_A,
        sourceActionNodeId: "earlier-ask",
        awaitingReply: false,
        resumeActionNodeId: null,
        sourcePathNodeIds: ["trigger", "earlier-ask"],
        values: { city: "Almaty" },
      },
    });

    expect(
      await runTurn({
        scenarioState,
        message: { text: "Gold" },
        turn: {
          triggerEventKind: "whatsapp_button_reply",
          quickReplyPayload: "wsc:ask:gold",
        },
      })
    ).toEqual({ status: "ok", scenario_prompt_input_stored: true });
    expect(persistedBaseStates()).toEqual([
      expect.objectContaining({
        collectedPromptInputs: expect.objectContaining({
          sourceActionNodeId: "ask",
          choiceOptionId: "wsc:ask:gold",
        }),
        formAnswers: {
          scenarioId: SCENARIO_A,
          submissions: [ORDER_SUBMISSION],
        },
      }),
    ]);
  });
});

describe("a scenario turn", () => {
  it("takes no Upstash processing lock", async () => {
    const { cache } = jest.requireMock("@/lib/cache") as {
      cache: Record<"del" | "get" | "setNX", jest.Mock>;
    };
    mockResolveActiveScenarioRuntime.mockResolvedValue({
      runtime: fixedReplyRuntime("Thanks!"),
    });

    await expect(
      runTurn({ scenarioState: { lockedScenarioId: SCENARIO_A } })
    ).resolves.toMatchObject({ status: "ok" });

    const touchedKeys = [cache.del, cache.get, cache.setNX].flatMap(fn =>
      fn.mock.calls.map(([key]) => String(key))
    );
    expect(touchedKeys.filter(key => key.includes("airi:processing"))).toEqual(
      []
    );
    expect(cache.setNX).not.toHaveBeenCalled();
  });

  it("reads its own business context after another workspace took over the shared chat", async () => {
    const { fetchCompanyContextBySourceId } = jest.requireMock(
      "@/lib/company-context"
    ) as { fetchCompanyContextBySourceId: jest.Mock };
    const runtime = aiReplyRuntime("Answer the question.");
    mockResolveActiveScenarioRuntime.mockResolvedValue({ runtime });
    mockRunIntentFastPath.mockResolvedValue({
      threadReplyContext: {},
      customerReplyLanguage: "en",
    });
    mockRunRagReplyFlow.mockResolvedValue({
      ragResult: { type: "ai_reply", content: "Hello!" },
      scenarioRuntime: runtime,
      queryText: "hello",
    });

    await runTurn({
      scenarioState: { lockedScenarioId: SCENARIO_A },
      // The customer's latest message went to another business on airi.chat.
      turn: {
        chatDocument: {
          _id: "chat-1",
          workspaceId: "workspace-2",
          sourceId: "source-2",
        },
      },
    });

    const sourceIds = fetchCompanyContextBySourceId.mock.calls.map(
      ([sourceId]) => sourceId
    );
    expect(sourceIds.length).toBeGreaterThan(0);
    expect(new Set(sourceIds)).toEqual(new Set(["source-1"]));
  });
});
