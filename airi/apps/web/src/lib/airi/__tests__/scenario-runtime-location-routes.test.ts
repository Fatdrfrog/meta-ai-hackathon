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
import { scenarioRuntimeDependencies } from "@/lib/airi/scenario/auto-reply-runtime-dependencies";
import type { RecordScenarioLocationDecisionParams } from "@icecore/airi-runtime/scenario-runtime-dependencies";
import {
  ACTION_LOCATION_ANY_OFFICE_OUTCOME_HANDLE_ID,
  ACTION_LOCATION_OUTSIDE_OUTCOME_HANDLE_ID,
  buildScenarioActionLocationRouteOutcomeHandleId,
  buildScenarioActionOutcomeHandleId,
  getScenarioActionOutcomeVirtualNodeId,
  recordScenarioRoutedLocation,
  SCENARIO_TRIGGER_EVENT_KIND,
  type ScenarioBusinessLocation,
  type ScenarioRuntimeEventKind,
} from "@icecore/scenario-contracts";

const mockMessageFindById = jest.fn();
const mockMessageFindOne = jest.fn();
const mockQuickReplyFind = jest.fn();
const mockLogScenarioTriggerEvaluations = jest.fn();
const mockCompleteLockedScenarioAndPersist = jest.fn();
const mockPersistPendingConditionState = jest.fn();
const mockClearPendingConditionStateAndPersist = jest.fn();
const mockCacheDel = jest.fn();
const mockEvaluateManagerReplyGuard = jest.fn();
const mockDetectAndUpdateConversationLanguageDecision = jest.fn();
const mockFetchCompanyContextBySourceId = jest.fn();
const mockChatCompletionWithFallback = jest.fn();
const mockAcquireConversationLock = jest.fn().mockResolvedValue(true);
const mockResolveInboundBurstOwnership = jest.fn();
const mockEvaluateDeliveryGate = jest.fn();
const mockShouldContinueProcessing = jest.fn();

jest.mock("@/lib/realtime/server", () => ({
  realtime: { trigger: jest.fn().mockResolvedValue(undefined) },
}));

jest.mock("@/lib/airi/reply/runtime/inbound-burst", () => ({
  resolveInboundBurstOwnership: (...args: unknown[]) =>
    mockResolveInboundBurstOwnership(...args),
}));

jest.mock("@/lib/ai", () => ({
  chatCompletionWithFallback: (...args: unknown[]) =>
    mockChatCompletionWithFallback(...args),
  getLightTextModel: () => "light-test-model",
}));

jest.mock("@/lib/mongoose", () => ({
  __esModule: true,
  default: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: {},
}));

jest.mock("@icecore/airi-runtime/module-interop", () => {
  const actual = jest.requireActual("@icecore/airi-runtime/module-interop");
  return {
    ...actual,
    createWebRequire: () => (request: string) => {
      if (request.endsWith("/models/conversation")) {
        return {
          Conversation: {
            findById: (...args: unknown[]) => mockConversationFindById(...args),
            updateOne: (...args: unknown[]) =>
              mockConversationUpdateOne(...args),
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
  default: {
    findById: (...args: unknown[]) => mockMessageFindById(...args),
    findOne: (...args: unknown[]) => mockMessageFindOne(...args),
  },
}));

jest.mock("@/models/quick-reply", () => ({
  QuickReply: { find: (...args: unknown[]) => mockQuickReplyFind(...args) },
}));
jest.mock("@/lib/airi/scenario/scenario-trigger-logging", () => ({
  logScenarioTriggerEvaluations: (...args: unknown[]) =>
    mockLogScenarioTriggerEvaluations(...args),
}));

// The real resolver runs behind a spy, so each test can read its calls.
jest.mock("@/lib/airi/scenario/scenario-runtime", () => ({
  ...jest.requireActual("@/lib/airi/scenario/scenario-runtime"),
  resolveActiveScenarioRuntime: (...args: unknown[]) =>
    mockResolveActiveScenarioRuntime(...args),
}));

jest.mock("@/lib/airi/reply/runtime/auto-reply-scenario-state", () => ({
  clearPendingConditionStateAndPersist: (...args: unknown[]) =>
    mockClearPendingConditionStateAndPersist(...args),
  completeLockedScenarioAndPersist: (...args: unknown[]) =>
    mockCompleteLockedScenarioAndPersist(...args),
  completeScenarioAfterDispatch: (...args: unknown[]) =>
    mockCompleteScenarioAfterDispatch(...args),
  finalizeScenarioResolution: (...args: unknown[]) =>
    mockFinalizeScenarioResolution(...args),
  isScenarioStateLocked: () => true,
  isScenarioPendingWriteCoordinationError: () => false,
  persistPendingConditionState: (...args: unknown[]) =>
    mockPersistPendingConditionState(...args),
  persistScenarioState: (...args: unknown[]) =>
    mockPersistScenarioState(...args),
}));

jest.mock("@/lib/airi/reply/runtime/auto-reply-realtime", () => ({
  clearSuppressedState: jest.fn().mockResolvedValue(undefined),
  persistSuppressedState: jest.fn(),
  TypingManager: class {
    start = jest.fn().mockResolvedValue(undefined);
    stop = jest.fn();
  },
}));

jest.mock("@/lib/cache", () => ({
  buildCacheKey: (...parts: unknown[]) => parts.join(":"),
  cache: {
    del: (...args: unknown[]) => mockCacheDel(...args),
    get: jest.fn().mockResolvedValue(null),
    setNX: (...args: unknown[]) => mockAcquireConversationLock(...args),
  },
}));

// Chat AI is on: an unclaimed message may reach the assistant.
jest.mock("@/lib/limits/company-limits", () => ({
  ...jest.requireActual("@/lib/limits/company-limits"),
  ensureCompanyAiriAutoReplyCapacity: jest
    .fn()
    .mockResolvedValue({ allowed: true }),
}));

jest.mock("@/lib/airi/reply/runtime/reply-trace", () => ({
  ...jest.requireActual("@/lib/airi/reply/runtime/reply-trace"),
  persistAiriReplyTrace: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("@/lib/airi/rag/knowledge/knowledge-gap-tracker", () => ({
  trackMissingKnowledgeGap: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("@/lib/airi/reply/runtime/manager-reply-guard", () => ({
  evaluateManagerReplyGuard: (...args: unknown[]) =>
    mockEvaluateManagerReplyGuard(...args),
}));

jest.mock("@/lib/airi/reply/delivery/outbound-message", () => ({
  // Voice replies don't apply to these turns.
  resolveWhatsAppVoiceReplyIntent: () => undefined,
  sendAndPersistOutbound: (...args: unknown[]) =>
    mockSendAndPersistOutbound(...args),
}));

jest.mock("@/lib/airi/reply/delivery/reply-delivery-gate", () => ({
  ...jest.requireActual("@/lib/airi/reply/delivery/reply-delivery-gate"),
  evaluateReplyDeliveryGate: (...args: unknown[]) =>
    mockEvaluateDeliveryGate(...args),
}));

jest.mock("@/lib/airi/coach/coach-utils-server", () => ({
  detectAndUpdateConversationLanguageDecision: (...args: unknown[]) =>
    mockDetectAndUpdateConversationLanguageDecision(...args),
}));

jest.mock("@/lib/company-context", () => ({
  fetchCompanyContextBySourceId: (...args: unknown[]) =>
    mockFetchCompanyContextBySourceId(...args),
}));

jest.mock("@/lib/airi/shouldContinueProcessing", () => ({
  shouldContinueProcessing: (...args: unknown[]) =>
    mockShouldContinueProcessing(...args),
}));

jest.mock("@icecore/airi-runtime/logging", () => ({
  airiOrchestrationLogger: {
    error: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
  },
  airiReplyLogger: {
    error: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
  },
}));

const scenarioId = "65f000000000000000000020";
const WAIT_STARTED_AT = new Date("2026-09-20T08:00:00.000Z");
const TURN_AT = new Date("2026-09-20T08:05:00.000Z");
const waitNodeId = getScenarioActionOutcomeVirtualNodeId("ask");
const TIMER_MESSAGE_ID = `scenario-timeout:post_action_no_reply_timeout:${scenarioId}:${WAIT_STARTED_AT.toISOString()}`;

const OFFICES: ScenarioBusinessLocation[] = [
  {
    key: "almaty_abay",
    name: "Abay",
    country: "KZ",
    city: "Almaty",
    cityKey: "almaty",
    address: "Abay Ave 10",
    phone: "+7 727 000 00 00",
    tags: [],
    latitude: 43.238949,
    longitude: 76.889709,
    sortOrder: 0,
  },
  {
    key: "tashkent_chilanzar",
    name: "Chilanzar",
    country: "UZ",
    city: "Tashkent",
    cityKey: "tashkent",
    tags: [],
    latitude: 41.2756,
    longitude: 69.2034,
    sortOrder: 1,
  },
];
// 3.7 km from Abay.
const NEAR_ALMATY = { latitude: 43.2567, longitude: 76.9286 };
// 7.5 km from Chilanzar; no route groups Uzbekistan.
const NEAR_TASHKENT = { latitude: 41.3111, longitude: 69.2797 };
// 2,790 km from the nearest office.
const MOSCOW = { latitude: 55.7558, longitude: 37.6173 };

const ASK_MESSAGE = {
  version: 1,
  message: {
    kind: "location_request",
    body: { mode: "fixed", text: "Share your location" },
  },
};

const step = (id: string, text: string) => ({
  id,
  data: {
    kind: "action",
    actionType: "reply",
    actionReplyMode: "fixed",
    actionReplyText: text,
  },
});

// A Request location step: Kazakhstan, Any other office and No office
// within 100 km, beside a pricing answer rule and No reply. Without
// `locationRoutes` it is the same step as before location routes existed.
function locationGraph(
  options: {
    anyReply?: boolean;
    anyOfficeEdge?: boolean;
    locationRoutes?: boolean;
  } = {}
) {
  const withRoutes = options.locationRoutes ?? true;
  const anyOfficeEdge = withRoutes && (options.anyOfficeEdge ?? true);
  return {
    nodes: [
      { id: "trigger", data: { kind: "trigger" } },
      {
        id: "ask",
        data: {
          kind: "action",
          actionType: "reply",
          actionReplyMode: "fixed",
          actionReplyText: "Share your location",
          actionWhatsAppServiceMessage: ASK_MESSAGE,
          actionOutcomes: {
            version: withRoutes ? 2 : 1,
            ...(options.anyReply ? { anyReply: { enabled: true } } : {}),
            noReply: { enabled: true, timeoutMinutes: 30 },
            answerMatches: [
              { id: "pricing", mode: "intent", text: "asks about prices" },
            ],
            ...(withRoutes
              ? {
                  locationRoutes: {
                    routes: [
                      { id: "kz", match: { by: "country", values: ["KZ"] } },
                    ],
                    outside: { maxDistanceKm: 100 },
                  },
                }
              : {}),
          },
        },
      },
      step("kz-step", "Nearest: {{office.name}} {{office.distance_km}} km"),
      step("any-step", "Nearest office: {{office.name}}"),
      step("far-step", "No office near you"),
      step("remind-step", "Please share your location"),
      step("pricing-step", "Prices start at 1000"),
      step("reply-step", "Thanks for your message"),
    ],
    edges: [
      { source: "trigger", target: "ask" },
      ...(withRoutes
        ? [
            {
              source: "ask",
              sourceHandle:
                buildScenarioActionLocationRouteOutcomeHandleId("kz"),
              target: "kz-step",
            },
            {
              source: "ask",
              sourceHandle: ACTION_LOCATION_OUTSIDE_OUTCOME_HANDLE_ID,
              target: "far-step",
            },
          ]
        : []),
      ...(anyOfficeEdge
        ? [
            {
              source: "ask",
              sourceHandle: ACTION_LOCATION_ANY_OFFICE_OUTCOME_HANDLE_ID,
              target: "any-step",
            },
          ]
        : []),
      {
        source: "ask",
        sourceHandle: buildScenarioActionOutcomeHandleId({
          type: "answer",
          ruleId: "pricing",
        }),
        target: "pricing-step",
      },
      ...(options.anyReply
        ? [
            {
              source: "ask",
              sourceHandle: buildScenarioActionOutcomeHandleId("any_reply"),
              target: "reply-step",
            },
          ]
        : []),
      {
        source: "ask",
        sourceHandle: buildScenarioActionOutcomeHandleId("no_reply"),
        target: "remind-step",
      },
    ],
  };
}

const waitingState = (extra: Record<string, unknown> = {}) => ({
  lockedScenarioId: scenarioId,
  lockedScenarioName: "Nearest office",
  currentActionNodeId: "ask",
  pendingConditionNodeId: waitNodeId,
  pendingSourceActionNodeId: "ask",
  pendingStartedAt: WAIT_STARTED_AT,
  pendingLastOutboundMessageId: "outbound-ask",
  ...extra,
});

// What Meta's location reply stores: the coordinates and a display text.
// The text is never parsed, so every pin here carries the same one.
const pinMessage = (
  id: string,
  point: { latitude: number; longitude: number },
  options: { date?: Date; replyTo?: string } = {}
) => ({
  _id: id,
  direction: "inbound",
  channel: "whatsapp",
  date: options.date ?? TURN_AT,
  text: "[Location] Abay Ave 10, Almaty",
  whatsappLocation: {
    ...point,
    name: "Abay Ave 10",
    address: "Almaty",
    url: null,
  },
  ...(options.replyTo
    ? { whatsappMeta: { replyToWhatsAppMessageId: options.replyTo } }
    : {}),
});

const textMessage = (id: string, text: string) => ({
  _id: id,
  direction: "inbound",
  channel: "whatsapp",
  date: TURN_AT,
  text,
});

const timerMessage = () => ({
  _id: TIMER_MESSAGE_ID,
  direction: "inbound",
  channel: "whatsapp",
  date: TURN_AT,
  text: "",
});

const lookupShare = (
  id: string,
  point: { latitude: number; longitude: number },
  date: Date
) => ({
  messageId: id,
  date,
  ...point,
  hasReplyContext: false,
  text: "[Location] Abay Ave 10, Almaty",
});

const mockLoadBusinessLocations = jest.fn();
const mockFindLatestInboundLocation = jest.fn();
const mockRecordScenarioLocationDecision = jest.fn();
const locationPorts = {
  loadBusinessLocations: mockLoadBusinessLocations,
  findLatestInboundLocation: mockFindLatestInboundLocation,
  recordScenarioLocationDecision: mockRecordScenarioLocationDecision,
};
const withoutLocationPorts = {
  loadBusinessLocations: undefined,
  findLatestInboundLocation: undefined,
  recordScenarioLocationDecision: undefined,
};

// Compiled graphs are cached by scenario ID and revision.
let revision = 0;
async function runTurn(params: {
  newMessage: Record<string, unknown>;
  /** Plain WhatsApp text and pins arrive without one. */
  triggerEventKind?: ScenarioRuntimeEventKind;
  graph?: ReturnType<typeof locationGraph>;
  scenarioState?: Record<string, unknown>;
  dependencies?: Partial<typeof scenarioRuntimeDependencies>;
  timer?: boolean;
  /** Text of messages merged into this turn, oldest first. */
  burstText?: string;
}) {
  const graph = params.graph ?? locationGraph();
  const updatedAt = new Date(Date.UTC(2026, 8, 20, 7, 0, 0, ++revision));
  mockScenarioFindOne.mockReturnValue({
    select: () => ({
      lean: async () => ({
        _id: scenarioId,
        name: "Nearest office",
        nodes: graph.nodes,
        edges: graph.edges,
        updatedAt,
      }),
    }),
  });
  const messageId = String(params.newMessage._id);
  mockResolveInboundBurstOwnership.mockResolvedValue({
    shouldProcess: true,
    burstText: params.burstText ?? params.newMessage.text,
    burstMessageIds: [messageId],
    latestBurstMessageId: messageId,
  });
  const { default: airiAutoReply } = await import(
    "@icecore/airi-runtime/auto-reply"
  );
  const response = await airiAutoReply(
    {
      type: "whatsapp",
      triggerEventKind: params.triggerEventKind,
      ...(params.timer
        ? { scenarioOverrideId: scenarioId, proactiveTrigger: true }
        : {}),
      runtimeHydrated: true,
      workspaceId: "workspace-1",
      chatDocument: { _id: "chat-1", sourceId: "source-1" } as never,
      whatsAppInfo: {
        phoneNumberId: "phone-1",
        contactData: { waId: "77000000000" },
      } as never,
      conversation: {
        _id: "conversation-1",
        sourceId: "source-1",
        airi_bot_enabled: true,
        airi_scenarios_enabled: true,
        airi_scenario_state: params.scenarioState ?? waitingState(),
      } as never,
      newMessage: params.newMessage as never,
    },
    {
      ...scenarioRuntimeDependencies,
      ...(params.dependencies ?? locationPorts),
    }
  );
  return response.json();
}

describe("location routes while a Request location step waits", () => {
  // Loading the runtime takes seconds, so no test's timeout pays for it.
  beforeAll(async () => {
    await import("@icecore/airi-runtime/auto-reply");
  }, 60_000);

  beforeEach(() => {
    jest.clearAllMocks();
    mockMessageFindOne.mockImplementation((filter: { _id?: string }) => {
      const query = {
        sort: () => query,
        select: () => query,
        lean: async () => ({
          _id: filter._id ?? "outbound-1",
          channel: "whatsapp",
          messageId: "wamid.accepted",
        }),
      };
      return query;
    });
    mockResolveActiveScenarioRuntime.mockImplementation(
      jest.requireActual<typeof import("@/lib/airi/scenario/scenario-runtime")>(
        "@/lib/airi/scenario/scenario-runtime"
      ).resolveActiveScenarioRuntime
    );
    const quickReplies = {
      sort: () => quickReplies,
      limit: () => quickReplies,
      select: () => quickReplies,
      lean: async () => [],
    };
    mockQuickReplyFind.mockReturnValue(quickReplies);
    mockLogScenarioTriggerEvaluations.mockResolvedValue(undefined);
    mockShouldContinueProcessing.mockResolvedValue(true);
    mockEvaluateDeliveryGate.mockReturnValue({ allowSend: true });
    mockSendAndPersistOutbound.mockResolvedValue({
      _id: "outbound-2",
      date: new Date("2026-09-20T08:05:01.000Z"),
    });
    mockChatCompletionWithFallback.mockResolvedValue({
      content: JSON.stringify({ matches: [] }),
    });
    mockRunIntentFastPath.mockResolvedValue({
      threadReplyContext: {},
      customerReplyLanguage: "en",
    });
    mockRunRagReplyFlow.mockResolvedValue({
      ragResult: { type: "ai_reply", content: "General AI answer" },
      scenarioRuntime: null,
      queryText: "",
    });
    mockPersistScenarioState.mockResolvedValue(undefined);
    mockCompleteScenarioAfterDispatch.mockResolvedValue(undefined);
    mockCompleteLockedScenarioAndPersist.mockResolvedValue({
      state: {},
      persisted: true,
    });
    mockFinalizeScenarioResolution.mockResolvedValue(null);
    mockConversationUpdateOne.mockResolvedValue({ matchedCount: 1 });
    mockCacheDel.mockResolvedValue(undefined);
    mockEvaluateManagerReplyGuard.mockResolvedValue({ skip: false });
    mockDetectAndUpdateConversationLanguageDecision.mockResolvedValue(null);
    mockFetchCompanyContextBySourceId.mockResolvedValue({});
    mockLoadBusinessLocations.mockResolvedValue(OFFICES);
    mockFindLatestInboundLocation.mockResolvedValue(null);
    mockRecordScenarioLocationDecision.mockImplementation(
      async (input: RecordScenarioLocationDecisionParams) => ({
        persisted: true,
        state: recordScenarioRoutedLocation(input.baseState, {
          scenarioId: input.expectedPendingState.scenarioId,
          entry: input.entry,
        }),
      })
    );
  });

  const kzEntry = {
    sourceActionNodeId: "ask",
    outcome: "route",
    routeId: "kz",
    office: expect.objectContaining({ key: "almaty_abay", name: "Abay" }),
    distanceMeters: 3717,
  };

  function expectRoutedTo(
    body: unknown,
    actionNodeId: string,
    content: string,
    entry: Record<string, unknown>
  ) {
    expect(body).toEqual({ status: "ok", scenario_reply: true });
    expect(mockResolveActiveScenarioRuntime).toHaveBeenCalledTimes(1);
    expect(mockResolveActiveScenarioRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        forcedScenarioId: scenarioId,
        forcedActionNodeId: actionNodeId,
        skipTriggerMatch: true,
        triggerEventKind: "post_action_user_reply",
      })
    );
    expect(mockLogScenarioTriggerEvaluations).toHaveBeenCalledWith([
      expect.objectContaining({
        eventKind: "post_action_user_reply",
        result: "winner",
        selectedActionNodeId: actionNodeId,
      }),
    ]);
    expect(mockSendAndPersistOutbound).toHaveBeenCalledTimes(1);
    expect(mockSendAndPersistOutbound).toHaveBeenCalledWith(
      expect.objectContaining({
        content,
        scenarioOrigin: expect.objectContaining({ scenarioId, actionNodeId }),
      })
    );
    // The share is recorded with the step's own state write.
    expect(mockPersistScenarioState).toHaveBeenCalledWith(
      expect.objectContaining({
        scenarioRuntime: expect.objectContaining({
          selectedActionNodeId: actionNodeId,
        }),
        baseState: expect.objectContaining({
          routedLocations: {
            scenarioId,
            entries: [{ ...entry, decidedAt: expect.any(String) }],
          },
        }),
      })
    );
    expect(mockRecordScenarioLocationDecision).not.toHaveBeenCalled();
    expect(mockCompleteLockedScenarioAndPersist).not.toHaveBeenCalled();
    // A pin never reaches the answer rules or the assistant.
    expect(mockChatCompletionWithFallback).not.toHaveBeenCalled();
    expect(mockRunIntentFastPath).not.toHaveBeenCalled();
    expect(mockRunRagReplyFlow).not.toHaveBeenCalled();
  }

  function expectNothingSent() {
    expect(mockResolveActiveScenarioRuntime).not.toHaveBeenCalled();
    expect(mockSendAndPersistOutbound).not.toHaveBeenCalled();
    expect(mockPersistScenarioState).not.toHaveBeenCalled();
    expect(mockPersistPendingConditionState).not.toHaveBeenCalled();
    expect(mockClearPendingConditionStateAndPersist).not.toHaveBeenCalled();
    expect(mockCompleteLockedScenarioAndPersist).not.toHaveBeenCalled();
    expect(mockChatCompletionWithFallback).not.toHaveBeenCalled();
    expect(mockRunIntentFastPath).not.toHaveBeenCalled();
    expect(mockRunRagReplyFlow).not.toHaveBeenCalled();
  }

  function orchestrationLogs(note: string) {
    const { airiOrchestrationLogger } = jest.requireMock<
      typeof import("@icecore/airi-runtime/logging")
    >("@icecore/airi-runtime/logging");
    return (airiOrchestrationLogger.info as jest.Mock).mock.calls
      .map(call => call[1] as Record<string, unknown>)
      .filter(context => context?.note === note);
  }

  // A message no step claims: no answer rule matches, so Chat AI answers.
  const answeredByAssistant = {
    body: { status: "ok", reply_outcome: "delivered_or_ready" },
    sent: [{ content: "Airi: General AI answer", actionNodeId: null }],
    resolvedActionNodeIds: [],
    answerRuleCalls: 1,
    intentCalls: 1,
    ragCalls: 1,
    persistedRuntimes: [],
    completedScenario: 0,
  };

  /** What one turn did, to compare it with the same turn before routes. */
  async function observeTurn(turn: Parameters<typeof runTurn>[0]) {
    jest.clearAllMocks();
    const body = await runTurn(turn);
    return {
      body,
      sent: mockSendAndPersistOutbound.mock.calls.map(call => ({
        content: call[0].content,
        actionNodeId: call[0].scenarioOrigin?.actionNodeId ?? null,
      })),
      resolvedActionNodeIds: mockResolveActiveScenarioRuntime.mock.calls.map(
        call => call[0].forcedActionNodeId ?? null
      ),
      answerRuleCalls: mockChatCompletionWithFallback.mock.calls.length,
      intentCalls: mockRunIntentFastPath.mock.calls.length,
      ragCalls: mockRunRagReplyFlow.mock.calls.length,
      persistedRuntimes: mockPersistScenarioState.mock.calls.map(
        call => call[0].scenarioRuntime?.selectedActionNodeId ?? null
      ),
      completedScenario: mockCompleteLockedScenarioAndPersist.mock.calls.length,
    };
  }

  it.each([
    ["without", undefined, false],
    ["with", "wamid.location-request", true],
  ] as const)(
    "routes a shared pin %s a reply context to its group's step and renders the office",
    async (_, replyTo, hasReplyContext) => {
      const body = await runTurn({
        newMessage: pinMessage("message-pin", NEAR_ALMATY, { replyTo }),
        triggerEventKind: SCENARIO_TRIGGER_EVENT_KIND.inboundMessage,
      });

      expectRoutedTo(body, "kz-step", "Nearest: Abay 3.7 km", {
        ...kzEntry,
        inboundMessageId: "message-pin",
        sharedAt: TURN_AT.toISOString(),
        source: "turn",
      });
      expect(mockLoadBusinessLocations).toHaveBeenCalledWith({
        workspaceId: "workspace-1",
      });
      expect(mockFindLatestInboundLocation).not.toHaveBeenCalled();
      expect(orchestrationLogs("scenario_location_routed")).toEqual([
        expect.objectContaining({
          scenarioId,
          sourceActionNodeId: "ask",
          outcome: "route",
          routeId: "kz",
          officeKey: "almaty_abay",
          distanceBucket: "1-5",
          source: "turn",
          hasReplyContext,
        }),
      ]);
      // The customer's own coordinates are never logged or stored.
      const { airiOrchestrationLogger } = jest.requireMock<
        typeof import("@icecore/airi-runtime/logging")
      >("@icecore/airi-runtime/logging");
      const written = JSON.stringify([
        (airiOrchestrationLogger.info as jest.Mock).mock.calls,
        (airiOrchestrationLogger.warn as jest.Mock).mock.calls,
        mockPersistScenarioState.mock.calls.map(
          call => call[0].baseState.routedLocations
        ),
      ]);
      expect(written).not.toContain(String(NEAR_ALMATY.latitude));
      expect(written).not.toContain(String(NEAR_ALMATY.longitude));
    }
  );

  it("routes a pin farther than the cutoff to No office within 100 km", async () => {
    const body = await runTurn({
      newMessage: pinMessage("message-pin", MOSCOW),
      triggerEventKind: SCENARIO_TRIGGER_EVENT_KIND.inboundMessage,
    });

    expectRoutedTo(body, "far-step", "No office near you", {
      sourceActionNodeId: "ask",
      inboundMessageId: "message-pin",
      sharedAt: TURN_AT.toISOString(),
      source: "turn",
      outcome: "outside",
      office: expect.objectContaining({ key: "tashkent_chilanzar" }),
      distanceMeters: 2790804,
    });
  });

  it("routes a pin whose nearest office no group holds to Any other office", async () => {
    const body = await runTurn({
      newMessage: pinMessage("message-pin", NEAR_TASHKENT),
      triggerEventKind: SCENARIO_TRIGGER_EVENT_KIND.inboundMessage,
    });

    expectRoutedTo(body, "any-step", "Nearest office: Chilanzar", {
      sourceActionNodeId: "ask",
      inboundMessageId: "message-pin",
      sharedAt: TURN_AT.toISOString(),
      source: "turn",
      outcome: "any_office",
      office: expect.objectContaining({ key: "tashkent_chilanzar" }),
      distanceMeters: 7498,
    });
  });

  it("sends a group's pin to Any other office while the group has no connection", async () => {
    const graph = locationGraph();
    const body = await runTurn({
      graph: {
        ...graph,
        edges: graph.edges.filter(edge => edge.target !== "kz-step"),
      },
      newMessage: pinMessage("message-pin", NEAR_ALMATY),
      triggerEventKind: SCENARIO_TRIGGER_EVENT_KIND.inboundMessage,
    });

    // The ledger names the route that ran, not the unconnected group.
    expectRoutedTo(body, "any-step", "Nearest office: Abay", {
      sourceActionNodeId: kzEntry.sourceActionNodeId,
      office: kzEntry.office,
      distanceMeters: kzEntry.distanceMeters,
      outcome: "any_office",
      inboundMessageId: "message-pin",
      sharedAt: TURN_AT.toISOString(),
      source: "turn",
    });
  });

  it("routes every pin to No office within 100 km once the catalog is empty", async () => {
    mockLoadBusinessLocations.mockResolvedValue([]);

    const body = await runTurn({
      newMessage: pinMessage("message-pin", NEAR_ALMATY),
      triggerEventKind: SCENARIO_TRIGGER_EVENT_KIND.inboundMessage,
    });

    expectRoutedTo(body, "far-step", "No office near you", {
      sourceActionNodeId: "ask",
      inboundMessageId: "message-pin",
      sharedAt: TURN_AT.toISOString(),
      source: "turn",
      outcome: "outside",
    });
  });

  it("routes a pin a merged turn left behind when the customer then types", async () => {
    const pinAt = new Date("2026-09-20T08:04:58.000Z");
    mockFindLatestInboundLocation.mockResolvedValue(
      lookupShare("message-pin", NEAR_ALMATY, pinAt)
    );

    const body = await runTurn({
      newMessage: textMessage("message-text", "вот"),
      triggerEventKind: SCENARIO_TRIGGER_EVENT_KIND.inboundMessage,
    });

    expect(mockFindLatestInboundLocation).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      since: new Date(WAIT_STARTED_AT.getTime() - 2_000),
      until: TURN_AT,
      excludeMessageIds: [],
    });
    expectRoutedTo(body, "kz-step", "Nearest: Abay 3.7 km", {
      ...kzEntry,
      inboundMessageId: "message-pin",
      sharedAt: pinAt.toISOString(),
      source: "lookup",
    });
  });

  it("routes a lost pin on the No reply timer turn instead of reminding", async () => {
    const pinAt = new Date("2026-09-20T08:10:00.000Z");
    mockFindLatestInboundLocation.mockResolvedValue(
      lookupShare("message-pin", NEAR_ALMATY, pinAt)
    );

    const body = await runTurn({
      newMessage: timerMessage(),
      triggerEventKind: SCENARIO_TRIGGER_EVENT_KIND.noHumanReplyTimeout,
      timer: true,
    });

    expect(mockFindLatestInboundLocation).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      since: new Date(WAIT_STARTED_AT.getTime() - 2_000),
      until: expect.any(Date),
      excludeMessageIds: [],
    });
    expectRoutedTo(body, "kz-step", "Nearest: Abay 3.7 km", {
      ...kzEntry,
      inboundMessageId: "message-pin",
      sharedAt: pinAt.toISOString(),
      source: "timer",
    });
    expect(mockResolveActiveScenarioRuntime).not.toHaveBeenCalledWith(
      expect.objectContaining({ forcedActionNodeId: "remind-step" })
    );
  });

  describe("a pin whose route can't run", () => {
    const unconnected = locationGraph({ anyOfficeEdge: false });
    const expectedPendingState = {
      scenarioId,
      conditionNodeId: waitNodeId,
      sourceActionNodeId: "ask",
      pendingStartedAt: WAIT_STARTED_AT,
      lastOutboundMessageId: "outbound-ask",
    };

    it("sends nothing, even with Chat AI on, and keeps the wait", async () => {
      const body = await runTurn({
        graph: unconnected,
        newMessage: pinMessage("message-pin", NEAR_TASHKENT),
        triggerEventKind: SCENARIO_TRIGGER_EVENT_KIND.inboundMessage,
      });

      expect(body).toEqual({
        status: "ok",
        skipped_unrouted_scenario_location: true,
      });
      expect(mockRecordScenarioLocationDecision).toHaveBeenCalledTimes(1);
      expect(mockRecordScenarioLocationDecision).toHaveBeenCalledWith({
        conversationId: "conversation-1",
        baseState: expect.objectContaining({
          lockedScenarioId: scenarioId,
          pendingConditionNodeId: waitNodeId,
        }),
        entry: {
          sourceActionNodeId: "ask",
          inboundMessageId: "message-pin",
          sharedAt: TURN_AT.toISOString(),
          decidedAt: expect.any(String),
          source: "turn",
          outcome: "unrouted",
          office: expect.objectContaining({ key: "tashkent_chilanzar" }),
          distanceMeters: 7498,
          reason: "not_connected",
        },
        expectedPendingState,
      });
      expect(orchestrationLogs("scenario_location_unrouted")).toEqual([
        expect.objectContaining({
          outcome: "unrouted",
          reason: "not_connected",
          source: "turn",
        }),
      ]);
      expectNothingSent();
    });

    it("drops the pin without sending when the wait changed before it was recorded", async () => {
      mockRecordScenarioLocationDecision.mockResolvedValue({
        persisted: false,
        state: {},
      });

      const body = await runTurn({
        graph: unconnected,
        newMessage: pinMessage("message-pin", NEAR_TASHKENT),
        triggerEventKind: SCENARIO_TRIGGER_EVENT_KIND.inboundMessage,
      });

      expect(body).toEqual({ status: "ok", skipped_stale_pending_wait: true });
      expect(mockRecordScenarioLocationDecision).toHaveBeenCalledTimes(1);
      expectNothingSent();
    });

    it("records a lost pin on the timer turn and goes on to No reply", async () => {
      const pinAt = new Date("2026-09-20T08:10:00.000Z");
      mockFindLatestInboundLocation.mockResolvedValue(
        lookupShare("message-pin", NEAR_TASHKENT, pinAt)
      );

      const body = await runTurn({
        graph: unconnected,
        newMessage: timerMessage(),
        triggerEventKind: SCENARIO_TRIGGER_EVENT_KIND.noHumanReplyTimeout,
        timer: true,
      });

      const unroutedEntry = {
        sourceActionNodeId: "ask",
        inboundMessageId: "message-pin",
        sharedAt: pinAt.toISOString(),
        decidedAt: expect.any(String),
        source: "timer",
        outcome: "unrouted",
        office: expect.objectContaining({ key: "tashkent_chilanzar" }),
        distanceMeters: 7498,
        reason: "not_connected",
      };
      expect(mockRecordScenarioLocationDecision).toHaveBeenCalledWith(
        expect.objectContaining({ entry: unroutedEntry, expectedPendingState })
      );
      expect(body).toEqual({ status: "ok", scenario_reply: true });
      expect(mockResolveActiveScenarioRuntime).toHaveBeenCalledTimes(1);
      expect(mockResolveActiveScenarioRuntime).toHaveBeenCalledWith(
        expect.objectContaining({
          forcedActionNodeId: "remind-step",
          triggerEventKind: "no_human_reply_timeout",
        })
      );
      expect(mockSendAndPersistOutbound).toHaveBeenCalledTimes(1);
      expect(mockSendAndPersistOutbound).toHaveBeenCalledWith(
        expect.objectContaining({
          content: "Please share your location",
          scenarioOrigin: expect.objectContaining({
            actionNodeId: "remind-step",
          }),
        })
      );
      // The reminder's state keeps the pin consumed.
      expect(mockPersistScenarioState).toHaveBeenCalledWith(
        expect.objectContaining({
          baseState: expect.objectContaining({
            routedLocations: { scenarioId, entries: [unroutedEntry] },
          }),
        })
      );
      expect(mockRunRagReplyFlow).not.toHaveBeenCalled();
    });

    it("records a pin found behind typed text and handles the text as itself", async () => {
      const pinAt = new Date("2026-09-20T08:04:58.000Z");
      mockFindLatestInboundLocation.mockResolvedValue(
        lookupShare("message-pin", NEAR_TASHKENT, pinAt)
      );

      const withRoutes = await observeTurn({
        graph: unconnected,
        newMessage: textMessage("message-text", "вот"),
        triggerEventKind: SCENARIO_TRIGGER_EVENT_KIND.inboundMessage,
      });
      expect(mockRecordScenarioLocationDecision).toHaveBeenCalledWith(
        expect.objectContaining({
          entry: expect.objectContaining({
            inboundMessageId: "message-pin",
            source: "lookup",
            outcome: "unrouted",
            reason: "not_connected",
          }),
          expectedPendingState,
        })
      );
      const before = await observeTurn({
        graph: locationGraph({ locationRoutes: false }),
        newMessage: textMessage("message-text", "вот"),
        triggerEventKind: SCENARIO_TRIGGER_EVENT_KIND.inboundMessage,
        dependencies: withoutLocationPorts,
      });

      expect(withRoutes).toEqual(before);
      // The answer rules read the customer's words, then Chat AI answers.
      expect(before).toEqual(answeredByAssistant);
    });

    it("sends nothing when the routed step can't be built on a customer turn", async () => {
      mockResolveActiveScenarioRuntime.mockResolvedValueOnce({ runtime: null });

      const body = await runTurn({
        newMessage: pinMessage("message-pin", NEAR_ALMATY),
        triggerEventKind: SCENARIO_TRIGGER_EVENT_KIND.inboundMessage,
      });

      expect(body).toEqual({
        status: "ok",
        skipped_unrouted_scenario_location: true,
      });
      expect(mockResolveActiveScenarioRuntime).toHaveBeenCalledWith(
        expect.objectContaining({ forcedActionNodeId: "kz-step" })
      );
      expect(mockRecordScenarioLocationDecision).toHaveBeenCalledWith(
        expect.objectContaining({
          entry: expect.objectContaining({
            inboundMessageId: "message-pin",
            source: "turn",
            outcome: "unrouted",
            reason: "step_not_built",
          }),
          expectedPendingState,
        })
      );
      expect(mockSendAndPersistOutbound).not.toHaveBeenCalled();
      expect(mockPersistScenarioState).not.toHaveBeenCalled();
      expect(mockCompleteLockedScenarioAndPersist).not.toHaveBeenCalled();
      expect(mockRunRagReplyFlow).not.toHaveBeenCalled();
    });

    it("records the pin and reminds when the routed step can't be built on a timer turn", async () => {
      mockFindLatestInboundLocation.mockResolvedValue(
        lookupShare(
          "message-pin",
          NEAR_ALMATY,
          new Date("2026-09-20T08:10:00.000Z")
        )
      );
      mockResolveActiveScenarioRuntime.mockResolvedValueOnce({ runtime: null });

      const body = await runTurn({
        newMessage: timerMessage(),
        triggerEventKind: SCENARIO_TRIGGER_EVENT_KIND.noHumanReplyTimeout,
        timer: true,
      });

      expect(mockRecordScenarioLocationDecision).toHaveBeenCalledWith(
        expect.objectContaining({
          entry: expect.objectContaining({
            inboundMessageId: "message-pin",
            source: "timer",
            outcome: "unrouted",
            reason: "step_not_built",
          }),
          expectedPendingState,
        })
      );
      // The routed step was tried first, then the due reminder ran.
      expect(
        mockResolveActiveScenarioRuntime.mock.calls.map(
          call => call[0].forcedActionNodeId
        )
      ).toEqual(["kz-step", "remind-step"]);
      expect(body).toEqual({ status: "ok", scenario_reply: true });
      expect(mockSendAndPersistOutbound).toHaveBeenCalledWith(
        expect.objectContaining({
          content: "Please share your location",
          scenarioOrigin: expect.objectContaining({
            actionNodeId: "remind-step",
          }),
        })
      );
      expect(mockCompleteLockedScenarioAndPersist).not.toHaveBeenCalled();
    });

    const answerRuleTexts = () =>
      mockChatCompletionWithFallback.mock.calls.map(call =>
        JSON.stringify(call)
      );

    it("keeps a pin merged into typed text away from the answer rules", async () => {
      mockFindLatestInboundLocation.mockResolvedValue(
        lookupShare(
          "message-pin",
          NEAR_TASHKENT,
          new Date("2026-09-20T08:04:58.000Z")
        )
      );

      // Without an event kind, as WhatsApp text arrives, the burst merges.
      const body = await runTurn({
        graph: unconnected,
        newMessage: textMessage("message-text", "вот"),
        burstText: "[Location] Abay Ave 10, Almaty\nвот",
      });

      expect(mockRecordScenarioLocationDecision).toHaveBeenCalledWith(
        expect.objectContaining({
          entry: expect.objectContaining({
            inboundMessageId: "message-pin",
            source: "lookup",
            outcome: "unrouted",
          }),
        })
      );
      expect(answerRuleTexts()).toHaveLength(1);
      expect(answerRuleTexts()[0]).toContain("вот");
      expect(answerRuleTexts()[0]).not.toContain("[Location]");
      expect(body).toEqual({
        status: "ok",
        reply_outcome: "delivered_or_ready",
      });
    });

    it("handles words typed just before an unroutable pin as themselves", async () => {
      const body = await runTurn({
        graph: unconnected,
        newMessage: pinMessage("message-pin", NEAR_TASHKENT),
        burstText: "Where is your office?\n[Location] Abay Ave 10, Almaty",
      });

      expect(mockRecordScenarioLocationDecision).toHaveBeenCalledWith(
        expect.objectContaining({
          entry: expect.objectContaining({
            inboundMessageId: "message-pin",
            source: "turn",
            outcome: "unrouted",
          }),
        })
      );
      expect(answerRuleTexts()).toHaveLength(1);
      expect(answerRuleTexts()[0]).toContain("Where is your office?");
      expect(answerRuleTexts()[0]).not.toContain("[Location]");
      expect(body).toEqual({
        status: "ok",
        reply_outcome: "delivered_or_ready",
      });
    });
  });

  const decidedEntry = (inboundMessageId: string, sharedAt: Date) => ({
    sourceActionNodeId: "ask",
    inboundMessageId,
    sharedAt: sharedAt.toISOString(),
    decidedAt: sharedAt.toISOString(),
    source: "turn",
    outcome: "route",
    routeId: "kz",
    office: {
      key: "almaty_abay",
      name: "Abay",
      country: "KZ",
      city: "Almaty",
      cityKey: "almaty",
      tags: [],
      latitude: 43.238949,
      longitude: 76.889709,
    },
    distanceMeters: 3717,
  });

  it.each([
    ["already decided", decidedEntry("message-pin", TURN_AT)],
    [
      "older than a decided share",
      decidedEntry("message-newer", new Date("2026-09-20T08:06:00.000Z")),
    ],
  ])("drops a retried pin %s without sending", async (_, entry) => {
    const body = await runTurn({
      newMessage: pinMessage("message-pin", NEAR_ALMATY),
      triggerEventKind: SCENARIO_TRIGGER_EVENT_KIND.inboundMessage,
      scenarioState: waitingState({
        routedLocations: { scenarioId, entries: [entry] },
      }),
    });

    expect(body).toEqual({
      status: "ok",
      skipped_decided_scenario_location: true,
    });
    expect(mockLoadBusinessLocations).not.toHaveBeenCalled();
    expect(mockFindLatestInboundLocation).not.toHaveBeenCalled();
    expect(mockRecordScenarioLocationDecision).not.toHaveBeenCalled();
    expectNothingSent();
  });

  it("keeps typed text without a pin as it was before location routes", async () => {
    const withRoutes = await observeTurn({
      newMessage: textMessage("message-text", "Where are you?"),
      triggerEventKind: SCENARIO_TRIGGER_EVENT_KIND.inboundMessage,
    });
    expect(mockFindLatestInboundLocation).toHaveBeenCalledTimes(1);
    expect(mockLoadBusinessLocations).not.toHaveBeenCalled();
    expect(mockRecordScenarioLocationDecision).not.toHaveBeenCalled();
    const before = await observeTurn({
      graph: locationGraph({ locationRoutes: false }),
      newMessage: textMessage("message-text", "Where are you?"),
      triggerEventKind: SCENARIO_TRIGGER_EVENT_KIND.inboundMessage,
      dependencies: withoutLocationPorts,
    });

    expect(withRoutes).toEqual(before);
    expect(before).toEqual(answeredByAssistant);
  });

  it("lets a pin take its location route ahead of an Any reply", async () => {
    const body = await runTurn({
      graph: locationGraph({ anyReply: true }),
      newMessage: pinMessage("message-pin", NEAR_ALMATY),
      triggerEventKind: SCENARIO_TRIGGER_EVENT_KIND.inboundMessage,
    });

    expectRoutedTo(body, "kz-step", "Nearest: Abay 3.7 km", {
      ...kzEntry,
      inboundMessageId: "message-pin",
      sharedAt: TURN_AT.toISOString(),
      source: "turn",
    });
    expect(mockResolveActiveScenarioRuntime).not.toHaveBeenCalledWith(
      expect.objectContaining({ forcedActionNodeId: "reply-step" })
    );
  });

  it.each([
    ["all location ports are", withoutLocationPorts],
    [
      "the decision recorder is",
      { ...locationPorts, recordScenarioLocationDecision: undefined },
    ],
    [
      "the office catalog is",
      { ...locationPorts, loadBusinessLocations: undefined },
    ],
  ])("handles a pin as before when %s missing", async (_, dependencies) => {
    const withRoutes = await observeTurn({
      newMessage: pinMessage("message-pin", NEAR_ALMATY),
      triggerEventKind: SCENARIO_TRIGGER_EVENT_KIND.inboundMessage,
      dependencies,
    });
    expect(mockLoadBusinessLocations).not.toHaveBeenCalled();
    expect(mockFindLatestInboundLocation).not.toHaveBeenCalled();
    expect(mockRecordScenarioLocationDecision).not.toHaveBeenCalled();
    const before = await observeTurn({
      graph: locationGraph({ locationRoutes: false }),
      newMessage: pinMessage("message-pin", NEAR_ALMATY),
      triggerEventKind: SCENARIO_TRIGGER_EVENT_KIND.inboundMessage,
      dependencies: withoutLocationPorts,
    });

    expect(withRoutes).toEqual(before);
    // The pin's display text is read as typed text, as before.
    expect(before).toEqual(answeredByAssistant);
  });

  // A minute after a pin no turn decided, its rescue timer turn routes it.
  // It never sends the No reply reminder, which keeps its own timer.
  describe("the rescue timer turn of a lost pin", () => {
    const PIN_AT = new Date("2026-09-20T08:04:00.000Z");
    const rescueMessage = () => ({
      ...timerMessage(),
      _id: `${TIMER_MESSAGE_ID}:location-rescue:message-pin`,
    });
    const runRescue = (
      params: Omit<Parameters<typeof runTurn>[0], "newMessage"> = {}
    ) =>
      runTurn({
        newMessage: rescueMessage(),
        triggerEventKind: SCENARIO_TRIGGER_EVENT_KIND.noHumanReplyTimeout,
        timer: true,
        ...params,
      });

    it("routes the pin to its group's step", async () => {
      mockFindLatestInboundLocation.mockResolvedValue(
        lookupShare("message-pin", NEAR_ALMATY, PIN_AT)
      );

      const body = await runRescue();

      expectRoutedTo(body, "kz-step", "Nearest: Abay 3.7 km", {
        ...kzEntry,
        inboundMessageId: "message-pin",
        sharedAt: PIN_AT.toISOString(),
        source: "timer",
      });
      expect(mockResolveActiveScenarioRuntime).not.toHaveBeenCalledWith(
        expect.objectContaining({ forcedActionNodeId: "remind-step" })
      );
    });

    it("does not use a synthetic location rescue to bypass a missing outbound", async () => {
      mockFindLatestInboundLocation.mockResolvedValue(
        lookupShare("message-pin", NEAR_ALMATY, PIN_AT)
      );
      const body = await runRescue({
        scenarioState: {
          ...waitingState(),
          pendingLastOutboundMessageId: null,
        },
      });
      expect(body).toEqual({
        status: "ok",
        skipped_pending_outbound_unconfirmed: true,
      });
      expect(mockFindLatestInboundLocation).not.toHaveBeenCalled();
      expect(mockRecordScenarioLocationDecision).not.toHaveBeenCalled();
      expectNothingSent();
    });

    it("still decides a real incoming pin when the preceding outbound is absent", async () => {
      const body = await runTurn({
        newMessage: pinMessage("message-pin", NEAR_ALMATY),
        scenarioState: {
          ...waitingState(),
          pendingLastOutboundMessageId: null,
        },
      });
      expectRoutedTo(body, "kz-step", "Nearest: Abay 3.7 km", {
        ...kzEntry,
        inboundMessageId: "message-pin",
        sharedAt: TURN_AT.toISOString(),
        source: "turn",
      });
    });

    it("does not let a pin advance an unsent action without location routing", async () => {
      const body = await runTurn({
        newMessage: pinMessage("message-pin", NEAR_ALMATY),
        graph: locationGraph({ locationRoutes: false, anyReply: true }),
        scenarioState: {
          ...waitingState(),
          pendingLastOutboundMessageId: null,
        },
      });
      expect(body).toEqual({
        status: "ok",
        skipped_pending_outbound_unconfirmed: true,
      });
      expectNothingSent();
    });

    it("records a pin whose route can't run and sends no reminder", async () => {
      mockFindLatestInboundLocation.mockResolvedValue(
        lookupShare("message-pin", NEAR_TASHKENT, PIN_AT)
      );

      const body = await runRescue({
        graph: locationGraph({ anyOfficeEdge: false }),
      });

      expect(body).toEqual({
        status: "ok",
        skipped_unrouted_scenario_location: true,
      });
      expect(mockRecordScenarioLocationDecision).toHaveBeenCalledTimes(1);
      expect(mockRecordScenarioLocationDecision).toHaveBeenCalledWith(
        expect.objectContaining({
          entry: expect.objectContaining({
            inboundMessageId: "message-pin",
            source: "timer",
            outcome: "unrouted",
            reason: "not_connected",
          }),
        })
      );
      expectNothingSent();
    });

    it("sends nothing once the pin was settled", async () => {
      mockFindLatestInboundLocation.mockResolvedValue(null);

      const body = await runRescue();

      expect(body).toEqual({ status: "ok", skipped_location_rescue: true });
      expect(mockFindLatestInboundLocation).toHaveBeenCalledTimes(1);
      expect(mockRecordScenarioLocationDecision).not.toHaveBeenCalled();
      expectNothingSent();
    });

    it("sends nothing once the step lost its location routes", async () => {
      mockFindLatestInboundLocation.mockResolvedValue(
        lookupShare("message-pin", NEAR_ALMATY, PIN_AT)
      );

      const body = await runRescue({
        graph: locationGraph({ locationRoutes: false }),
      });

      expect(body).toEqual({ status: "ok", skipped_location_rescue: true });
      expect(mockFindLatestInboundLocation).not.toHaveBeenCalled();
      expectNothingSent();
    });

    it("sends nothing once the conversation stopped waiting", async () => {
      mockFindLatestInboundLocation.mockResolvedValue(
        lookupShare("message-pin", NEAR_ALMATY, PIN_AT)
      );

      const body = await runRescue({
        scenarioState: {
          lockedScenarioId: scenarioId,
          lockedScenarioName: "Nearest office",
          currentActionNodeId: "kz-step",
        },
      });

      expect(body).toEqual({ status: "ok", skipped_location_rescue: true });
      expect(mockFindLatestInboundLocation).not.toHaveBeenCalled();
      expectNothingSent();
    });
  });
});
