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
import { createHash } from "node:crypto";
import { scenarioRuntimeDependencies } from "@/lib/airi/scenario/auto-reply-runtime-dependencies";
import {
  buildAiriConversationTimerTurn,
  planAiriConversationTimer,
  type AiriScenarioTimerDependencies,
} from "@icecore/airi-runtime/temporal-scenario-timers";
import {
  ACTION_INSTAGRAM_BRANCH_OUTPUT_HANDLE_ID,
  ACTION_WHATSAPP_TEMPLATE_FORM_SUBMITTED_HANDLE_ID,
  buildFlowBranchSourceHandleId,
  buildScenarioActionOutcomeHandleId,
  buildTelegramBranchSourceHandleId,
  buildWhatsAppSessionChoiceSourceHandleId,
  buildWhatsAppTemplateButtonPayload,
  buildWhatsAppTemplateButtonSourceHandleId,
  getScenarioActionBranchDelayVirtualNodeId,
  getScenarioActionOutcomeVirtualNodeId,
  SCENARIO_TRIGGER_EVENT_KIND,
  type ScenarioRuntimeEventKind,
} from "@icecore/scenario-contracts";

const mockMessageFindById = jest.fn();
const mockMessageFindOne = jest.fn();
const mockQuickReplyFind = jest.fn();
const mockLogScenarioTriggerEvaluations = jest.fn();
const mockCompleteLockedScenarioAndPersist = jest.fn();
const mockPersistPendingConditionState = jest.fn();
const mockClearPendingConditionStateAndPersist = jest.fn();
const mockPersistScenarioFormSubmission = jest.fn();
const mockCacheDel = jest.fn();
const mockEvaluateManagerReplyGuard = jest.fn();
const mockResolveInteractiveReplyConditionTarget = jest.fn();
const mockDetectAndUpdateConversationLanguageDecision = jest.fn();
const mockFetchCompanyContextBySourceId = jest.fn();
const mockChatCompletionWithFallback = jest.fn();
const mockAcquireConversationLock = jest.fn().mockResolvedValue(true);
const mockResolveInboundBurstOwnership = jest.fn();
const mockEvaluateDeliveryGate = jest.fn();
const mockResolveTemplateLanguage = jest.fn();
const mockShouldContinueProcessing = jest.fn();
const mockResolveScenarioReplyExecutionDecision = jest.fn();
const mockSafeSetMessageReaction = jest.fn().mockResolvedValue(true);

jest.mock("@/lib/telegram", () => ({
  safeSetMessageReaction: (...args: unknown[]) =>
    mockSafeSetMessageReaction(...args),
}));

jest.mock("@/lib/realtime/server", () => ({
  realtime: { trigger: jest.fn().mockResolvedValue(undefined) },
}));

jest.mock("@/lib/airi/reply/runtime/inbound-burst", () => ({
  resolveInboundBurstOwnership: (...args: unknown[]) =>
    mockResolveInboundBurstOwnership(...args),
}));
jest.mock("@/lib/airi/reply/runtime/auto-reply-template-utils", () => ({
  ...jest.requireActual("@/lib/airi/reply/runtime/auto-reply-template-utils"),
  resolveScenarioTemplateLanguage: (...args: unknown[]) =>
    mockResolveTemplateLanguage(...args),
}));

jest.mock("@/lib/ai", () => ({
  chatCompletionWithFallback: (...args: unknown[]) =>
    mockChatCompletionWithFallback(...args),
  getLightTextModel: () => "light-test-model",
}));

jest.mock("@/lib/mongoose", () => ({
  __esModule: true,
  default: jest.fn().mockRejectedValue(new Error("Unexpected database access")),
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

// Read only by tests that run the real scenario resolver.
jest.mock("@/models/quick-reply", () => ({
  QuickReply: { find: (...args: unknown[]) => mockQuickReplyFind(...args) },
}));
jest.mock("@/lib/airi/scenario/scenario-trigger-logging", () => ({
  logScenarioTriggerEvaluations: (...args: unknown[]) =>
    mockLogScenarioTriggerEvaluations(...args),
}));

jest.mock("@/lib/airi/scenario/scenario-runtime", () => ({
  ...jest.requireActual("@/lib/airi/scenario/scenario-post-action-routing"),
  resolveActiveScenarioRuntime: (...args: unknown[]) =>
    mockResolveActiveScenarioRuntime(...args),
  resolveInteractiveReplyConditionTarget: (...args: unknown[]) =>
    mockResolveInteractiveReplyConditionTarget(...args),
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
  isScenarioPendingWriteCoordinationError: (error: unknown) =>
    Boolean(
      error &&
        typeof error === "object" &&
        "scenarioPendingWriteCoordinationError" in error
    ),
  persistPendingConditionState: (...args: unknown[]) =>
    mockPersistPendingConditionState(...args),
  persistScenarioFormSubmission: (...args: unknown[]) =>
    mockPersistScenarioFormSubmission(...args),
  persistScenarioState: (...args: unknown[]) =>
    mockPersistScenarioState(...args),
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
    del: (...args: unknown[]) => mockCacheDel(...args),
    get: jest.fn().mockResolvedValue(null),
    setNX: (...args: unknown[]) => mockAcquireConversationLock(...args),
  },
}));

jest.mock("@/lib/airi/reply/runtime/manager-reply-guard", () => ({
  evaluateManagerReplyGuard: (...args: unknown[]) =>
    mockEvaluateManagerReplyGuard(...args),
}));

jest.mock("@/lib/airi/reply/runtime/reply-action-utils", () => ({
  ...jest.requireActual("@/lib/airi/reply/runtime/reply-action-utils"),
  resolveScenarioReplyExecutionDecision: (...args: unknown[]) =>
    mockResolveScenarioReplyExecutionDecision(...args),
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

// The conversation the runtime reads back from storage.
function mockStoredConversation(
  airiScenarioState: unknown,
  { botEnabled = false }: { botEnabled?: boolean } = {}
) {
  mockConversationFindById.mockReturnValue({
    select: () => ({
      lean: async () => ({
        airi_bot_enabled: botEnabled,
        airi_scenarios_enabled: true,
        sourceId: "source-1",
        airi_scenario_state: airiScenarioState,
      }),
    }),
  });
}

function widgetMessage(text: string, id = "message-1") {
  return {
    _id: id,
    direction: "inbound",
    channel: "web_widget",
    date: new Date("2026-07-10T10:00:00.000Z"),
    text,
  };
}

// One web-widget turn on conversation-1 with the real runtime dependencies.
async function runWidgetTurn(
  newMessage: unknown,
  turn: Record<string, unknown> = { triggerEventKind: "inbound_message" }
) {
  const { default: airiAutoReply } = await import(
    "@icecore/airi-runtime/auto-reply"
  );
  return airiAutoReply(
    {
      type: "web_widget",
      ...turn,
      workspaceId: "workspace-1",
      chatDocument: { _id: "chat-1", sourceId: "source-1" } as never,
      conversation: { _id: "conversation-1" } as never,
      newMessage: newMessage as never,
    } as Parameters<typeof airiAutoReply>[0],
    scenarioRuntimeDependencies
  );
}

describe("auto-reply pending graph diagnostics", () => {
  describe("Telegram AI message reactions", () => {
    async function runTelegramTurn(input: {
      reactionsEnabled?: boolean;
      botEnabled?: boolean;
      legacyEnabled?: boolean;
      scenariosEnabled?: boolean;
      handoffActive?: boolean;
      actionType?: "reply" | "assign_human";
    }) {
      mockEvaluateDeliveryGate.mockReturnValue({ allowSend: true });
      mockSendAndPersistOutbound.mockResolvedValue({
        _id: "outbound-1",
        date: new Date(),
      });
      mockResolveActiveScenarioRuntime.mockResolvedValue({
        runtime: {
          scenarioId: "scenario-1",
          scenarioName: "Telegram reply",
          actionType: input.actionType ?? "reply",
          actionReplyMode: "fixed",
          actionReplyText: "Hello",
        },
      });
      const { default: airiAutoReply } = await import(
        "@icecore/airi-runtime/auto-reply"
      );
      const response = await airiAutoReply(
        {
          type: "telegram",
          runtimeHydrated: true,
          triggerEventKind: "inbound_message",
          workspaceId: "workspace-1",
          chatId: "123",
          botToken: "bot-token",
          telegramReactionsEnabled: input.reactionsEnabled,
          chatDocument: { _id: "chat-1", sourceId: "source-1" } as never,
          conversation: {
            _id: "conversation-1",
            sourceId: "source-1",
            airi_bot_enabled: input.botEnabled,
            airi_enabled: input.legacyEnabled,
            airi_scenarios_enabled: input.scenariosEnabled ?? true,
            airi_handoff_active: input.handoffActive,
          } as never,
          newMessage: {
            _id: "message-1",
            messageId: "42",
            direction: "inbound",
            channel: "telegram",
            date: new Date(),
            text: "Hello",
          } as never,
        } as Parameters<typeof airiAutoReply>[0],
        {
          ...scenarioRuntimeDependencies,
          loadActiveScenarioSnapshot: jest.fn().mockResolvedValue(null),
        }
      );
      return response.json();
    }

    it.each([undefined, false])(
      "defaults reactions to off for setting %s while AI is on",
      async reactionsEnabled => {
        const body = await runTelegramTurn({
          reactionsEnabled,
          botEnabled: true,
        });
        expect(body).toMatchObject({ status: "ok" });
        expect(mockSendAndPersistOutbound).toHaveBeenCalled();
        expect(mockSafeSetMessageReaction).not.toHaveBeenCalled();
      }
    );

    it.each([true, false])(
      "never reacts with chat AI off and scenarios enabled %s",
      async scenariosEnabled => {
        const body = await runTelegramTurn({
          reactionsEnabled: true,
          botEnabled: false,
          legacyEnabled: true,
          scenariosEnabled,
        });
        expect(body).toMatchObject({ status: "ok" });
        if (scenariosEnabled) {
          expect(mockSendAndPersistOutbound).toHaveBeenCalled();
        } else {
          expect(mockSendAndPersistOutbound).not.toHaveBeenCalled();
        }
        expect(mockSafeSetMessageReaction).not.toHaveBeenCalled();
      }
    );

    it.each(["reply", "assign_human"] as const)(
      "never reacts on a scenario %s when chat AI is off",
      async actionType => {
        await runTelegramTurn({
          reactionsEnabled: true,
          botEnabled: false,
          actionType,
        });
        expect(mockSafeSetMessageReaction).not.toHaveBeenCalled();
      }
    );

    it.each([
      ["current toggle", true, undefined],
      ["legacy toggle", undefined, true],
    ] as const)(
      "reacts only for explicit opt-in with AI enabled via %s",
      async (_, botEnabled, legacyEnabled) => {
        const body = await runTelegramTurn({
          reactionsEnabled: true,
          botEnabled,
          legacyEnabled,
        });
        expect(body).toMatchObject({ status: "ok" });
        expect(mockSafeSetMessageReaction.mock.calls).toEqual([
          ["123", 42, "👀", { botToken: "bot-token" }],
          ["123", 42, "⚡", { botToken: "bot-token" }],
        ]);
      }
    );

    it.each([false, true])(
      "stays silent when a handoff lock suppresses AI and scenarios enabled %s",
      async scenariosEnabled => {
        await runTelegramTurn({
          reactionsEnabled: true,
          botEnabled: true,
          scenariosEnabled,
          handoffActive: true,
        });
        expect(mockSafeSetMessageReaction).not.toHaveBeenCalled();
      }
    );
  });

  it.each([
    "new",
    "newer",
    "answered",
    "send",
    "cancel_before_commit",
    "stale",
    "stale_handoff",
    "started",
    "pending",
    "handoff",
    "generative",
    "recovered_new",
    "recovered_started",
    "recovered_stale",
    "recovered_handoff",
    "placeholder_context_pending",
    "placeholder_context_stale",
    "legacy_placeholder_pending",
    "legacy_placeholder_read_pending",
  ])(
    "handles a provider-unavailable first contact without placeholder AI or existing state mutation: %s",
    async kind => {
      const isRecovery = kind.startsWith("recovered_");
      const originalPlaceholder = kind.startsWith("placeholder_context_");
      const legacyPlaceholder = kind.startsWith("legacy_placeholder_");
      const readAfterUpgrade = kind === "legacy_placeholder_read_pending";
      kind = kind.replace(
        /^(recovered_|placeholder_context_|legacy_placeholder_(read_)?)/,
        ""
      );
      const conversation = {
        _id: "conversation-1",
        sourceId: "source-1",
        airi_bot_enabled: true,
        airi_scenarios_enabled: true,
        ...(kind === "started"
          ? {
              airi_scenario_state: {
                startedScenarios: [
                  { scenarioId: "scenario-1", startedAt: new Date() },
                ],
              },
            }
          : {}),
        ...(kind === "pending"
          ? { airi_scenario_state: { pendingConditionNodeId: "condition-1" } }
          : {}),
        ...(kind === "handoff" ? { airi_handoff_active: true } : {}),
        ...(kind === "generative"
          ? { airi_pending_generative_execution: { executionId: "busy" } }
          : {}),
      };
      mockConversationFindById.mockReturnValue({
        select: () => ({
          lean: async () => ({
            ...conversation,
            ...(kind === "stale"
              ? {
                  airi_scenario_state: {
                    startedScenarios: [{ scenarioId: "already-started" }],
                  },
                }
              : {}),
            ...(kind === "stale_handoff" ? { airi_handoff_active: true } : {}),
          }),
        }),
      });
      const newMessage = {
        _id: "message-1",
        direction: "inbound",
        channel: "whatsapp",
        date: new Date(),
        text: "[WhatsApp message unavailable: open WhatsApp Business app to view]",
        rawSourcePayload: {
          provider: "whatsapp",
          eventType: "message",
          payload: {
            direction: "inbound",
            messages: [{ type: "unsupported", errors: [{ code: 131060 }] }],
          },
        },
        ...(isRecovery ||
        originalPlaceholder ||
        (legacyPlaceholder && !readAfterUpgrade)
          ? {
              text: "Interested in medals",
              rawSourcePayload: null,
              whatsappRecoveryRevision: "b".repeat(64),
            }
          : {}),
      };
      if (readAfterUpgrade) {
        mockMessageFindById.mockReturnValue({
          select: () => ({
            populate: () => ({
              lean: async () => ({
                ...newMessage,
                text: "Interested in medals",
                rawSourcePayload: null,
                whatsappRecoveryRevision: "b".repeat(64),
              }),
            }),
          }),
        });
      }
      mockResolveActiveScenarioRuntime.mockResolvedValue({ runtime: null });
      if (kind === "newer")
        mockResolveInboundBurstOwnership.mockResolvedValue({
          shouldProcess: false,
          reason: "superseded_by_newer_inbound_burst",
          burstOwnerMessageId: "message-2",
        });
      if (kind === "answered")
        mockResolveInboundBurstOwnership.mockResolvedValue({
          shouldProcess: false,
          reason: "already_answered_by_prior_outbound",
          answeredByMessageId: "manager-message",
        });
      if (kind === "send" || kind === "cancel_before_commit") {
        mockResolveActiveScenarioRuntime.mockResolvedValue({
          runtime: {
            scenarioId: "first-contact",
            scenarioName: "First contact",
            actionType: "whatsapp_template",
            actionWhatsAppTemplateName: "pick_lang",
            actionWhatsAppTemplateLanguage: "kk",
            selectedActionNodeId: "picker",
          },
        });
        mockEvaluateDeliveryGate.mockReturnValue({ allowSend: true });
        mockSendAndPersistOutbound.mockResolvedValue({
          _id: "outbound-1",
          date: new Date(),
        });
        if (kind === "cancel_before_commit")
          mockShouldContinueProcessing.mockResolvedValue(false);
      }
      const { default: airiAutoReply } = await import(
        "@icecore/airi-runtime/auto-reply"
      );
      const response = await airiAutoReply(
        {
          type: "whatsapp",
          triggerEventKind: "inbound_message",
          suppressGeneralAutoReply: kind === "new" ? undefined : true,
          ...(isRecovery ? { messageRecoveryRevision: "a".repeat(64) } : {}),
          ...(originalPlaceholder
            ? { whatsappMessageContentUnavailable: true }
            : {}),
          runtimeHydrated: !readAfterUpgrade,
          workspaceId: "workspace-1",
          conversation: conversation as never,
          newMessage: newMessage as never,
          chatDocument: { _id: "chat-1", sourceId: "source-1" } as never,
          whatsAppInfo: {
            phoneNumberId: "phone-1",
            contactData: { waId: "77000000000" },
          } as never,
        },
        scenarioRuntimeDependencies
      );
      expect(await response.json()).toMatchObject({ status: "ok" });
      if (kind === "new" || kind === "send" || kind === "cancel_before_commit")
        expect(mockResolveActiveScenarioRuntime).toHaveBeenCalledWith(
          expect.objectContaining({
            contentIndependentEntryOnly: !isRecovery,
            triggerMessageText: isRecovery ? "Interested in medals" : "",
          })
        );
      else expect(mockResolveActiveScenarioRuntime).not.toHaveBeenCalled();
      if (!isRecovery)
        expect(
          mockDetectAndUpdateConversationLanguageDecision
        ).not.toHaveBeenCalled();
      expect(mockRunRagReplyFlow).not.toHaveBeenCalled();
      expect(mockChatCompletionWithFallback).not.toHaveBeenCalled();
      if (kind === "send") {
        expect(mockSendAndPersistOutbound).toHaveBeenCalledWith(
          expect.objectContaining({
            whatsappTemplate: expect.objectContaining({
              name: "pick_lang",
              languageCode: "kk",
            }),
          })
        );
        expect(mockPersistScenarioState).toHaveBeenCalledTimes(1);
        expect(mockShouldContinueProcessing).toHaveBeenCalledWith(
          "workspace-1",
          "conversation-1",
          "message-1",
          expect.any(Number),
          expect.objectContaining({
            preserveScenarioDelivery: false,
            checkpointLabel: "Pre-Unavailable-Scenario-Commit",
          })
        );
        expect(
          mockShouldContinueProcessing.mock.invocationCallOrder[0]
        ).toBeLessThan(mockPersistScenarioState.mock.invocationCallOrder[0]);
        expect(mockShouldContinueProcessing).toHaveBeenLastCalledWith(
          "workspace-1",
          "conversation-1",
          "message-1",
          expect.any(Number),
          expect.objectContaining({
            preserveScenarioDelivery: true,
            checkpointLabel: "Pre-Scenario-WhatsApp-Template",
          })
        );
      } else {
        expect(mockSendAndPersistOutbound).not.toHaveBeenCalled();
        expect(mockPersistScenarioState).not.toHaveBeenCalled();
      }
      expect(mockPersistPendingConditionState).not.toHaveBeenCalled();
      expect(mockCompleteLockedScenarioAndPersist).not.toHaveBeenCalled();
    }
  );

  beforeEach(() => {
    jest.clearAllMocks();
    mockResolveScenarioReplyExecutionDecision.mockReturnValue({
      kind: "direct_fixed",
      replyText: "Payment received",
    });
    mockCompleteScenarioAfterDispatch.mockResolvedValue(undefined);
    mockPersistScenarioFormSubmission.mockResolvedValue(true);
    mockShouldContinueProcessing.mockResolvedValue(true);
    mockResolveInboundBurstOwnership.mockResolvedValue({
      shouldProcess: true,
      burstText: "[WhatsApp message unavailable]",
      burstMessageIds: ["message-1"],
      latestBurstMessageId: "message-1",
    });
    mockEvaluateDeliveryGate.mockReturnValue({
      allowSend: false,
      reason: "test_suppressed",
      rolloutBucket: 0,
      rolloutPercentage: 100,
    });
    mockResolveTemplateLanguage.mockResolvedValue({
      resolvedLanguage: "kk",
      matchedVariant: true,
      availableLanguages: ["kk"],
    });
    mockChatCompletionWithFallback.mockResolvedValue({
      content: JSON.stringify({ matches: [] }),
    });

    const scenarioState = {
      lockedScenarioId: "65f000000000000000000001",
      lockedScenarioName: "Invalid scenario",
      currentActionNodeId: "source",
      pendingConditionNodeId: "condition",
      pendingSourceActionNodeId: "source",
    };
    mockStoredConversation(scenarioState);
    mockMessageFindById.mockReturnValue({
      select: () => ({
        populate: () => ({
          lean: async () => ({
            direction: "inbound",
            channel: "web_widget",
            date: new Date("2026-07-10T10:00:00.000Z"),
            text: "I paid",
          }),
        }),
      }),
    });
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
    mockScenarioFindOne.mockReturnValue({
      select: () => ({
        lean: async () => ({
          _id: "65f000000000000000000001",
          name: "Invalid scenario",
          nodes: [
            {
              id: "source",
              data: {
                kind: "action",
                actionType: "reply",
                actionOutcomes: { version: 99 },
              },
            },
            {
              id: "condition",
              data: {
                kind: "logic",
                logicType: "post_action_condition",
                conditionBranches: [
                  { id: "payment_detected", type: "payment_detected" },
                ],
              },
            },
          ],
          edges: [{ source: "source", target: "condition" }],
          updatedAt: new Date("2026-07-10T09:00:00.000Z"),
        }),
      }),
    });
    mockResolveActiveScenarioRuntime.mockResolvedValue({
      runtime: {
        scenarioId: "payment-scenario",
        scenarioName: "Payment",
        actionType: "reply",
        actionReplyMode: "fixed",
        actionReplyText: "Payment received",
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
      },
    });
    mockCompleteLockedScenarioAndPersist.mockResolvedValue({
      state: {},
      persisted: true,
    });
    mockPersistScenarioState.mockResolvedValue(undefined);
    mockCacheDel.mockResolvedValue(undefined);
    mockEvaluateManagerReplyGuard.mockResolvedValue({ skip: false });
    mockDetectAndUpdateConversationLanguageDecision.mockResolvedValue(null);
    mockFetchCompanyContextBySourceId.mockResolvedValue({});
  });

  it.each(["inbound_message", "whatsapp_button_reply"] as const)(
    "consumes an explicit ending on %s without sending or restarting",
    async triggerEventKind => {
      mockConversationFindById.mockReturnValue({
        select: () => ({
          lean: async () => ({
            airi_bot_enabled: true,
            airi_scenarios_enabled: true,
            sourceId: "source-1",
            airi_scenario_state: {
              lockedScenarioId: "scenario",
              currentActionNodeId: "menu",
            },
          }),
        }),
      });
      mockScenarioFindOne.mockReturnValue({
        select: () => ({ lean: async () => null }),
      });
      mockResolveInteractiveReplyConditionTarget.mockReturnValue(null);
      const runtime = {
        scenarioId: "scenario",
        scenarioName: "Scenario",
        actionType: "end_scenario",
        selectedActionNodeId: "end",
        completesScenario: true,
      };
      mockResolveActiveScenarioRuntime.mockResolvedValue({ runtime });
      const { default: airiAutoReply } = await import(
        "@icecore/airi-runtime/auto-reply"
      );
      const response = await airiAutoReply(
        {
          type: "whatsapp",
          triggerEventKind,
          ...(triggerEventKind === "whatsapp_button_reply"
            ? { quickReplyPayload: "finish" }
            : {}),
          workspaceId: "workspace-1",
          chatDocument: { _id: "chat-1", sourceId: "source-1" } as never,
          conversation: { _id: "conversation-1" } as never,
          newMessage: {
            _id: "message-1",
            direction: "inbound",
            channel: "whatsapp",
            date: new Date(),
            text: "Finish",
          } as never,
        },
        scenarioRuntimeDependencies
      );
      expect(await response.json()).toEqual({
        status: "ok",
        scenario_ended: true,
      });
      expect(mockPersistScenarioState).toHaveBeenCalledWith(
        expect.objectContaining({ scenarioRuntime: runtime })
      );
      expect(mockResolveActiveScenarioRuntime).toHaveBeenCalledTimes(1);
      expect(mockFinalizeScenarioResolution).not.toHaveBeenCalled();
      expect(mockSendAndPersistOutbound).not.toHaveBeenCalled();
      expect(mockRunIntentFastPath).not.toHaveBeenCalled();
      expect(mockRunRagReplyFlow).not.toHaveBeenCalled();
    }
  );

  it("fails closed when a terminal action discovered during finalization cannot persist", async () => {
    const oldState = {
      lockedScenarioId: "old-scenario",
      currentActionNodeId: "old-action",
    };
    mockStoredConversation(oldState, { botEnabled: true });
    mockScenarioFindOne.mockReturnValue({
      select: () => ({ lean: async () => null }),
    });
    mockResolveActiveScenarioRuntime
      .mockReset()
      .mockResolvedValueOnce({
        runtime: null,
        lockedScenarioNoMatch: {
          scenarioId: "old-scenario",
          scenarioName: "Old scenario",
          lastActionNodeId: "old-action",
        },
      })
      .mockResolvedValueOnce({
        runtime: {
          scenarioId: "end-scenario",
          scenarioName: "End",
          actionType: "end_scenario",
          selectedActionNodeId: "end",
          completesScenario: true,
        },
      });
    const failure = new Error("database disconnected during terminal commit");
    mockConversationUpdateOne
      .mockReset()
      .mockResolvedValueOnce({ matchedCount: 1 })
      .mockRejectedValueOnce(failure);
    const actualState = jest.requireActual<
      typeof import("@/lib/airi/reply/runtime/auto-reply-scenario-state")
    >("@/lib/airi/reply/runtime/auto-reply-scenario-state");
    mockFinalizeScenarioResolution.mockImplementationOnce(
      actualState.finalizeScenarioResolution
    );
    const { default: airiAutoReply } = await import(
      "@icecore/airi-runtime/auto-reply"
    );
    await expect(
      airiAutoReply(
        {
          type: "whatsapp",
          triggerEventKind: "inbound_message",
          workspaceId: "workspace-1",
          chatDocument: { _id: "chat-1", sourceId: "source-1" } as never,
          conversation: { _id: "conversation-1" } as never,
          newMessage: {
            _id: "message-1",
            direction: "inbound",
            channel: "whatsapp",
            date: new Date(),
            text: "Finish",
          } as never,
        },
        scenarioRuntimeDependencies
      )
    ).rejects.toMatchObject({
      code: "conversation_write_failed",
      cause: failure,
    });
    expect(mockConversationUpdateOne).toHaveBeenCalledTimes(2);
    expect(mockRunIntentFastPath).not.toHaveBeenCalled();
    expect(mockRunRagReplyFlow).not.toHaveBeenCalled();
    expect(mockSendAndPersistOutbound).not.toHaveBeenCalled();
  });

  it.each([
    [
      "exact answer ahead of intent",
      "yes, tell me the price",
      true,
      false,
      "exact-target",
    ],
    ["intent answer", "what does it cost?", true, false, "intent-target"],
    ["Any reply after unmatched answers", "hello", true, false, "reply-target"],
    ["matcher-only wait", "hello", undefined, false, null],
    ["disabled Any reply wait", "hello", false, false, null],
    ["exact answer without Any reply", "yes", false, false, "exact-target"],
    ["timer despite matching text", "yes", true, true, "timeout-target"],
  ] as const)(
    "routes %s through auto-reply orchestration",
    async (caseName, messageText, anyReplyEnabled, isTimeout, target) => {
      const scenarioId = createHash("sha256")
        .update(caseName)
        .digest("hex")
        .slice(0, 24);
      const scenarioState = {
        lockedScenarioId: scenarioId,
        lockedScenarioName: "Action outcomes",
        currentActionNodeId: "source",
        pendingConditionNodeId: getScenarioActionOutcomeVirtualNodeId("source"),
        pendingSourceActionNodeId: "source",
      };
      const newMessage = {
        _id: "message-outcomes",
        direction: "inbound",
        channel: "web_widget",
        date: new Date("2026-07-10T10:00:00.000Z"),
        text: messageText,
      };
      mockStoredConversation(scenarioState);
      mockMessageFindById.mockReturnValue({
        select: () => ({ populate: () => ({ lean: async () => newMessage }) }),
      });
      mockScenarioFindOne.mockReturnValue({
        select: () => ({
          lean: async () => ({
            _id: scenarioId,
            name: "Action outcomes",
            nodes: [
              {
                id: "source",
                data: {
                  kind: "action",
                  actionType: "reply",
                  actionOutcomes: {
                    version: 1,
                    ...(anyReplyEnabled === undefined
                      ? {}
                      : { anyReply: { enabled: anyReplyEnabled } }),
                    noReply: { enabled: true, timeoutMinutes: 15 },
                    answerMatches: [
                      { id: "exact", mode: "exact", text: "yes" },
                      {
                        id: "intent",
                        mode: "intent",
                        text: "asks about pricing",
                      },
                    ],
                  },
                },
              },
              ...[
                "exact-target",
                "intent-target",
                "reply-target",
                "timeout-target",
              ].map(id => ({
                id,
                data: { kind: "action", actionType: "reply" },
              })),
            ],
            edges: [
              ...["exact", "intent"].map(ruleId => ({
                source: "source",
                sourceHandle: buildScenarioActionOutcomeHandleId({
                  type: "answer",
                  ruleId,
                }),
                target: `${ruleId}-target`,
              })),
              ...(anyReplyEnabled
                ? [
                    {
                      source: "source",
                      sourceHandle:
                        buildScenarioActionOutcomeHandleId("any_reply"),
                      target: "reply-target",
                    },
                  ]
                : []),
              {
                source: "source",
                sourceHandle: buildScenarioActionOutcomeHandleId("no_reply"),
                target: "timeout-target",
              },
            ],
          }),
        }),
      });
      if (target === "intent-target") {
        mockChatCompletionWithFallback.mockResolvedValue({
          content: JSON.stringify({
            matches: [{ id: "intent", confidence: 0.94 }],
          }),
        });
      }
      mockResolveActiveScenarioRuntime.mockResolvedValue({ runtime: null });

      const triggerEventKind: ScenarioRuntimeEventKind = isTimeout
        ? SCENARIO_TRIGGER_EVENT_KIND.noHumanReplyTimeout
        : SCENARIO_TRIGGER_EVENT_KIND.inboundMessage;
      const response = await runWidgetTurn(newMessage, { triggerEventKind });

      expect(await response.json()).toMatchObject({ status: "ok" });
      if (target) {
        expect(mockResolveActiveScenarioRuntime).toHaveBeenCalledTimes(1);
        expect(mockResolveActiveScenarioRuntime).toHaveBeenCalledWith(
          expect.objectContaining({
            forcedScenarioId: scenarioId,
            forcedActionNodeId: target,
            skipTriggerMatch: true,
            triggerEventKind: isTimeout
              ? "no_human_reply_timeout"
              : "post_action_user_reply",
          })
        );
      } else {
        expect(mockResolveActiveScenarioRuntime).not.toHaveBeenCalled();
        expect(mockCompleteLockedScenarioAndPersist).not.toHaveBeenCalled();
        expect(mockPersistScenarioState).not.toHaveBeenCalled();
      }
      if (target === "exact-target" || isTimeout) {
        expect(mockChatCompletionWithFallback).not.toHaveBeenCalled();
      }
      expect(mockSendAndPersistOutbound).not.toHaveBeenCalled();
    }
  );

  it.each([
    "valid",
    "missing_snapshot",
    "untrusted_trigger",
    "source",
    "workspace",
    "scenario",
    "condition",
    "action",
    "current_action",
    "started_at",
    "outbound",
    "revision",
    "wait_revision",
    "missing_wait_revision",
    "resolver_revision",
    "link_valid",
    "link_revision",
    "link_missing",
    "missing_scenario",
    "disabled",
    "generative_execution",
  ])("fences confirmed payment continuation against %s", async mismatch => {
    const scenarioId = createHash("sha256")
      .update(`payment:${mismatch}`)
      .digest("hex")
      .slice(0, 24);
    const snapshot = {
      sourceId: "source-1",
      scenarioId,
      scenarioUpdatedAt: "2026-07-10T09:00:00.000Z",
      pendingConditionNodeId: getScenarioActionOutcomeVirtualNodeId("source"),
      pendingSourceActionNodeId: "source",
      pendingStartedAt: "2026-07-10T09:45:00.000Z",
      pendingLastOutboundMessageId: "outbound-1",
      occurredAt: "2026-07-10T10:00:00.000Z",
    };
    const state = {
      lockedScenarioId: scenarioId,
      currentActionNodeId: "source",
      pendingConditionNodeId: snapshot.pendingConditionNodeId,
      pendingSourceActionNodeId: "source",
      pendingStartedAt: new Date(snapshot.pendingStartedAt),
      pendingScenarioUpdatedAt: new Date(snapshot.scenarioUpdatedAt),
      pendingLastOutboundMessageId: "outbound-1",
    };
    const original = {
      _id: "conversation-1",
      workspaceId: "workspace-1",
      channel: "whatsapp",
      sourceId: "source-1",
      airi_bot_enabled: true,
      airi_scenarios_enabled: true,
      airi_scenario_state: state,
    };
    const latest: typeof original & {
      airi_pending_generative_execution?: unknown;
    } = { ...original, airi_scenario_state: { ...state } };
    if (mismatch === "source") latest.sourceId = "source-2";
    if (mismatch === "workspace") latest.workspaceId = "workspace-2";
    if (mismatch === "scenario")
      latest.airi_scenario_state.lockedScenarioId = "other";
    if (mismatch === "condition")
      latest.airi_scenario_state.pendingConditionNodeId = "other";
    if (mismatch === "action")
      latest.airi_scenario_state.pendingSourceActionNodeId = "other";
    if (mismatch === "current_action")
      latest.airi_scenario_state.currentActionNodeId = "other";
    if (mismatch === "started_at")
      latest.airi_scenario_state.pendingStartedAt = new Date(
        "2026-07-10T09:46:00Z"
      );
    if (mismatch === "outbound")
      latest.airi_scenario_state.pendingLastOutboundMessageId = "outbound-2";
    if (mismatch === "wait_revision")
      latest.airi_scenario_state.pendingScenarioUpdatedAt = new Date(
        "2026-07-10T08:00:00Z"
      );
    if (mismatch === "missing_wait_revision")
      Reflect.deleteProperty(
        latest.airi_scenario_state,
        "pendingScenarioUpdatedAt"
      );
    if (mismatch === "disabled") latest.airi_scenarios_enabled = false;
    if (mismatch === "generative_execution")
      latest.airi_pending_generative_execution = { version: 1 };
    mockConversationFindById.mockImplementation(() => {
      return { select: () => ({ lean: async () => latest }) };
    });
    const linked = mismatch.startsWith("link_");
    let scenarioRead = 0;
    mockScenarioFindOne.mockImplementation(() => ({
      select: () => ({
        lean: async () => {
          scenarioRead++;
          return mismatch === "missing_scenario" ||
            (scenarioRead > 1 && mismatch === "link_missing")
            ? null
            : {
                _id: scenarioId,
                name: "Payment wait",
                updatedAt: new Date(
                  mismatch === "revision" ||
                  (scenarioRead > 1 && mismatch === "link_revision")
                    ? "2026-07-10T09:01:00Z"
                    : snapshot.scenarioUpdatedAt
                ),
                nodes: [
                  {
                    id: "source",
                    data: {
                      kind: "action",
                      actionType: "reply",
                      actionOutcomes: {
                        version: 1,
                        paymentDetected: { enabled: true },
                        anyReply: { enabled: true },
                        noReply: { enabled: true, timeoutMinutes: 15 },
                        answerMatches: [
                          {
                            id: "intent",
                            mode: "intent",
                            text: "asks about payment",
                          },
                        ],
                      },
                    },
                  },
                  ...["paid", "reply", "timeout"].map(id => ({
                    id,
                    data:
                      linked && id === "paid"
                        ? {
                            kind: "scenario_link",
                            linkedScenarioId: "child-scenario",
                          }
                        : { kind: "action", actionType: "reply" },
                  })),
                ],
                edges: [
                  {
                    source: "source",
                    sourceHandle:
                      buildScenarioActionOutcomeHandleId("payment_detected"),
                    target: "paid",
                  },
                  {
                    source: "source",
                    sourceHandle:
                      buildScenarioActionOutcomeHandleId("any_reply"),
                    target: "reply",
                  },
                  {
                    source: "source",
                    sourceHandle:
                      buildScenarioActionOutcomeHandleId("no_reply"),
                    target: "timeout",
                  },
                ],
              };
        },
      }),
    }));
    mockResolveActiveScenarioRuntime.mockResolvedValue({
      runtime: null,
      ...(mismatch === "resolver_revision"
        ? { staleScenarioRevision: true }
        : {}),
    });
    const { default: airiAutoReply } = await import(
      "@icecore/airi-runtime/auto-reply"
    );
    const response = await airiAutoReply(
      {
        type: "whatsapp",
        workspaceId: "workspace-1",
        runtimeHydrated: true,
        triggerEventKind:
          mismatch === "untrusted_trigger"
            ? "inbound_message"
            : "payment_detected",
        scenarioOverrideId: scenarioId,
        suppressGeneralAutoReply: true,
        confirmedPaymentScenario:
          mismatch === "missing_snapshot" ? undefined : snapshot,
        chatDocument: { _id: "chat-1", sourceId: "source-1" } as never,
        conversation: original as never,
        newMessage: {
          _id: "confirmed-payment:127fb80b-dbc3-4a2c-a859-f60e65cde1e3",
          direction: "inbound",
          channel: "whatsapp",
          date: new Date(snapshot.occurredAt),
          text: "",
        } as never,
      },
      scenarioRuntimeDependencies
    );
    const body = await response.json();
    expect(body.status).toBe("ok");
    if (mismatch === "link_valid") {
      expect(scenarioRead).toBe(2);
      expect(mockCompleteLockedScenarioAndPersist).toHaveBeenCalledTimes(1);
      expect(mockResolveActiveScenarioRuntime).toHaveBeenCalledWith(
        expect.objectContaining({ forcedScenarioId: "child-scenario" })
      );
    } else if (mismatch === "valid") {
      expect(mockResolveActiveScenarioRuntime).toHaveBeenCalledTimes(1);
      expect(mockResolveActiveScenarioRuntime).toHaveBeenCalledWith(
        expect.objectContaining({
          forcedScenarioId: scenarioId,
          forcedActionNodeId: "paid",
          skipTriggerMatch: true,
          triggerEventKind: "payment_detected",
          expectedScenarioUpdatedAt: snapshot.scenarioUpdatedAt,
        })
      );
      expect(body.skipped_authoritative_scenario_continuation).toBe(true);
    } else {
      expect(body.skipped_confirmed_payment_scenario).toBe(true);
      expect(mockResolveActiveScenarioRuntime).toHaveBeenCalledTimes(
        mismatch === "resolver_revision" ? 1 : 0
      );
      expect(mockCompleteLockedScenarioAndPersist).not.toHaveBeenCalled();
      expect(mockPersistScenarioState).not.toHaveBeenCalled();
      expect(mockFinalizeScenarioResolution).not.toHaveBeenCalled();
    }
    expect(mockPersistPendingConditionState).not.toHaveBeenCalled();
    expect(mockClearPendingConditionStateAndPersist).not.toHaveBeenCalled();
    expect(mockRunIntentFastPath).not.toHaveBeenCalled();
    expect(mockRunRagReplyFlow).not.toHaveBeenCalled();
    expect(mockChatCompletionWithFallback).not.toHaveBeenCalled();
    expect(
      mockDetectAndUpdateConversationLanguageDecision
    ).not.toHaveBeenCalled();
    expect(mockSendAndPersistOutbound).not.toHaveBeenCalled();
  });

  it("does not resolve payment or persist state for an invalid locked pending graph", async () => {
    const response = await runWidgetTurn(widgetMessage("I paid"));

    expect(await response.json()).toMatchObject({ status: "ok" });
    expect(mockResolveActiveScenarioRuntime).not.toHaveBeenCalled();
    expect(mockCompleteLockedScenarioAndPersist).not.toHaveBeenCalled();
    expect(mockPersistScenarioState).not.toHaveBeenCalled();
    expect(mockPersistPendingConditionState).not.toHaveBeenCalled();
    expect(mockClearPendingConditionStateAndPersist).not.toHaveBeenCalled();
    expect(mockFinalizeScenarioResolution).not.toHaveBeenCalled();
    expect(mockScenarioFindOne).toHaveBeenCalledTimes(1);
    expect(mockEvaluateManagerReplyGuard).not.toHaveBeenCalled();
  });

  it("propagates pending-write coordination failures so the delivery can retry", async () => {
    mockStoredConversation(null);
    mockScenarioFindOne.mockReturnValue({
      select: () => ({ lean: async () => null }),
    });
    const coordinationError = Object.assign(
      new Error("Scenario routing changed while persisting a pending wait."),
      { scenarioPendingWriteCoordinationError: true }
    );
    mockPersistScenarioState.mockRejectedValue(coordinationError);

    await expect(runWidgetTurn(widgetMessage("hello"))).rejects.toBe(
      coordinationError
    );
  });

  it.each([
    [
      "WhatsApp button",
      "whatsapp",
      "whatsapp_button_reply",
      "wsc:follow-up:other",
      undefined,
    ],
    [
      "WhatsApp Flow",
      "whatsapp",
      "whatsapp_flow_reply",
      undefined,
      '{"choice":"other"}',
    ],
    [
      "Instagram button",
      "instagram",
      "instagram_quick_reply",
      "other",
      undefined,
    ],
    ["Telegram button", "telegram", "telegram_quick_reply", "other", undefined],
    [
      "inferred button",
      "whatsapp",
      undefined,
      "wsc:follow-up:other",
      undefined,
    ],
    ["inferred Flow", "whatsapp", undefined, undefined, '{"choice":"other"}'],
  ] as const)(
    "preserves an active scenario when an unmatched %s reply arrives",
    async (
      _,
      channel,
      triggerEventKind,
      quickReplyPayload,
      whatsAppFlowResponseJson
    ) => {
      const scenarioState = {
        lockedScenarioId: "65f000000000000000000001",
        lockedScenarioName: "Follow-up",
        currentActionNodeId: "follow-up",
        pendingConditionNodeId: null,
        pendingSourceActionNodeId: null,
      };
      const newMessage = {
        _id: "message-unmatched-button",
        direction: "inbound",
        channel,
        date: new Date("2026-09-20T08:59:02.000Z"),
        text: "Other option",
      };
      mockStoredConversation(scenarioState, { botEnabled: true });
      mockMessageFindById.mockReturnValue({
        select: () => ({ populate: () => ({ lean: async () => newMessage }) }),
      });
      mockScenarioFindOne.mockReturnValue({
        select: () => ({ lean: async () => null }),
      });
      mockResolveInteractiveReplyConditionTarget.mockReturnValue(null);
      mockResolveActiveScenarioRuntime.mockResolvedValue({
        runtime: null,
        lockedScenarioNoMatch: {
          scenarioId: scenarioState.lockedScenarioId,
          scenarioName: scenarioState.lockedScenarioName,
          lastActionNodeId: "follow-up",
          lastMatchedAt: new Date("2026-09-20T08:58:52.257Z"),
        },
      });
      mockFinalizeScenarioResolution.mockResolvedValue(null);

      const { default: airiAutoReply } = await import(
        "@icecore/airi-runtime/auto-reply"
      );
      const response = await airiAutoReply(
        {
          type: channel,
          triggerEventKind,
          quickReplyPayload,
          whatsAppFlowResponseJson,
          suppressGeneralAutoReply: !triggerEventKind,
          workspaceId: "workspace-1",
          chatDocument: { _id: "chat-1", sourceId: "source-1" } as never,
          conversation: { _id: "conversation-1" } as never,
          newMessage: newMessage as never,
        },
        scenarioRuntimeDependencies
      );

      expect(mockFinalizeScenarioResolution).not.toHaveBeenCalled();
      expect(mockCompleteLockedScenarioAndPersist).not.toHaveBeenCalled();
      expect(mockPersistScenarioState).not.toHaveBeenCalled();
      expect(mockPersistPendingConditionState).not.toHaveBeenCalled();
      expect(mockClearPendingConditionStateAndPersist).not.toHaveBeenCalled();
      expect(mockSendAndPersistOutbound).not.toHaveBeenCalled();
      expect(mockRunIntentFastPath).not.toHaveBeenCalled();
      expect(mockRunRagReplyFlow).not.toHaveBeenCalled();
      expect(mockResolveActiveScenarioRuntime).toHaveBeenCalledTimes(1);
      expect(await response.json()).toEqual({
        status: "ok",
        skipped_interactive_reply_no_branch_match: true,
      });
      expect(mockCacheDel).not.toHaveBeenCalled();
    }
  );

  it.each([undefined, "wsc:follow-up:other"])(
    "still finalizes an ordinary inbound miss with inherited payload %s",
    async quickReplyPayload => {
      const lockedScenarioNoMatch = {
        scenarioId: "65f000000000000000000001",
        scenarioName: "Completed text branch",
        lastActionNodeId: "last-action",
      };
      mockConversationFindById.mockReturnValue({
        select: () => ({
          lean: async () => ({
            airi_bot_enabled: false,
            airi_scenarios_enabled: true,
            sourceId: "source-1",
            airi_scenario_state: {
              lockedScenarioId: lockedScenarioNoMatch.scenarioId,
              currentActionNodeId: "last-action",
            },
          }),
        }),
      });
      mockScenarioFindOne.mockReturnValue({
        select: () => ({ lean: async () => null }),
      });
      mockResolveActiveScenarioRuntime.mockResolvedValue({
        runtime: null,
        lockedScenarioNoMatch,
      });
      mockFinalizeScenarioResolution.mockResolvedValue(null);

      const { default: airiAutoReply } = await import(
        "@icecore/airi-runtime/auto-reply"
      );
      await airiAutoReply(
        {
          type: "whatsapp",
          triggerEventKind: "inbound_message",
          quickReplyPayload,
          workspaceId: "workspace-1",
          chatDocument: { _id: "chat-1", sourceId: "source-1" } as never,
          conversation: { _id: "conversation-1" } as never,
          newMessage: {
            _id: "message-after-text-branch",
            direction: "inbound",
            channel: "whatsapp",
            date: new Date("2026-09-20T08:59:02.000Z"),
            text: "Hello again",
          } as never,
        },
        scenarioRuntimeDependencies
      );

      expect(mockFinalizeScenarioResolution).toHaveBeenCalledTimes(1);
      expect(mockFinalizeScenarioResolution).toHaveBeenCalledWith(
        expect.objectContaining({ lockedScenarioNoMatch })
      );
    }
  );

  it("terminates a blocked scenario action without a payment-only prepass", async () => {
    mockScenarioFindOne.mockReturnValue({
      select: () => ({
        lean: async () => null,
      }),
    });
    mockResolveActiveScenarioRuntime.mockResolvedValue({
      runtime: null,
      blockedScenarioAction: {
        reason: "whatsapp_service_message_unsupported",
        scenarioId: "future-scenario",
        actionNodeId: "future-action",
      },
    });

    const response = await runWidgetTurn(widgetMessage("hello"));

    expect(await response.json()).toEqual({
      status: "ok",
      skipped_scenario_action: "whatsapp_service_message_unsupported",
    });
    expect(mockPersistScenarioState).not.toHaveBeenCalled();
    expect(mockFinalizeScenarioResolution).not.toHaveBeenCalled();
    expect(mockSendAndPersistOutbound).not.toHaveBeenCalled();
    expect(mockRunIntentFastPath).not.toHaveBeenCalled();
    expect(mockRunRagReplyFlow).not.toHaveBeenCalled();
    expect(mockResolveActiveScenarioRuntime).toHaveBeenCalledTimes(1);
    expect(
      mockResolveActiveScenarioRuntime.mock.calls[0]?.[0]
    ).not.toHaveProperty("restrictToTriggerTypes");
    expect(mockCacheDel).not.toHaveBeenCalled();
  });

  it("does not retry scenario resolution or generate a reply after claiming an unresolved pending branch", async () => {
    const scenarioState = {
      lockedScenarioId: "65f000000000000000000002",
      lockedScenarioName: "Pending scenario",
      currentActionNodeId: "source",
      pendingConditionNodeId: "condition",
      pendingSourceActionNodeId: "source",
      pendingStartedAt: new Date("2026-07-10T09:45:00.000Z"),
      pendingLastOutboundMessageId: "outbound-1",
    };
    mockStoredConversation(scenarioState, { botEnabled: true });
    mockScenarioFindOne.mockReturnValue({
      select: () => ({
        lean: async () => ({
          _id: "65f000000000000000000002",
          name: "Pending scenario",
          nodes: [
            {
              id: "source",
              data: {
                kind: "action",
                actionType: "reply",
                actionReplyMode: "fixed",
                actionReplyText: "Original action must not repeat",
              },
            },
            {
              id: "condition",
              data: {
                kind: "logic",
                logicType: "post_action_condition",
                conditionBranches: [
                  { id: "user_replied", type: "user_replied" },
                ],
              },
            },
          ],
          edges: [{ source: "source", target: "condition" }],
          updatedAt: new Date("2026-07-10T09:00:00.000Z"),
        }),
      }),
    });

    const response = await runWidgetTurn(widgetMessage("hello"));

    expect(await response.json()).toEqual({
      status: "ok",
      skipped_authoritative_scenario_continuation: true,
    });
    expect(mockResolveActiveScenarioRuntime).not.toHaveBeenCalled();
    expect(mockCompleteLockedScenarioAndPersist).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: "conversation-1",
        scenarioId: "65f000000000000000000002",
        expectedPendingState: {
          conditionNodeId: "condition",
          sourceActionNodeId: "source",
          pendingStartedAt: new Date("2026-07-10T09:45:00.000Z"),
          lastOutboundMessageId: "outbound-1",
        },
      })
    );
    expect(mockSendAndPersistOutbound).not.toHaveBeenCalled();
    expect(mockRunIntentFastPath).not.toHaveBeenCalled();
    expect(mockRunRagReplyFlow).not.toHaveBeenCalled();
    expect(mockCacheDel).not.toHaveBeenCalled();
  });

  it.each([
    ["matching", "source", "outbound-1"],
    ["mismatched", "other-action", null],
  ] as const)(
    "uses %s action provenance when an interactive reply enters another pending condition",
    async (_, currentActionNodeId, expectedAnchor) => {
      const pendingStartedAt = new Date("2026-07-10T09:45:00.000Z");
      const scenarioState = {
        lockedScenarioId: "65f000000000000000000003",
        lockedScenarioName: "Interactive scenario",
        currentActionNodeId,
        pendingConditionNodeId: "condition-1",
        pendingSourceActionNodeId: "source",
        pendingStartedAt,
        pendingLastOutboundMessageId: "outbound-1",
      };
      mockStoredConversation(scenarioState);
      mockScenarioFindOne.mockReturnValue({
        select: () => ({
          lean: async () => ({
            _id: "65f000000000000000000003",
            name: "Interactive scenario",
            nodes: [
              {
                id: "source",
                data: {
                  kind: "action",
                  actionType: "whatsapp_template",
                  actionReplyCtaType: "flow",
                  actionReplyCtaFlowId: "flow-1",
                },
              },
              {
                id: "condition-1",
                data: {
                  kind: "logic",
                  logicType: "post_action_condition",
                  conditionBranches: [
                    { id: "user_replied", type: "user_replied" },
                  ],
                },
              },
              {
                id: "condition-2",
                data: {
                  kind: "logic",
                  logicType: "post_action_condition",
                  conditionBranches: [
                    {
                      id: "no_reply_timeout",
                      type: "no_reply_timeout",
                      timeoutMinutes: 15,
                    },
                  ],
                },
              },
            ],
            edges: [{ source: "source", target: "condition-1" }],
            updatedAt: new Date("2026-07-10T09:00:00.000Z"),
          }),
        }),
      });
      mockResolveInteractiveReplyConditionTarget.mockReturnValue({
        conditionNode: { id: "condition-2" },
        pathNodeIds: ["source", "condition-2"],
      });
      mockPersistPendingConditionState.mockResolvedValue({
        ...scenarioState,
        pendingConditionNodeId: "condition-2",
        pendingStartedAt: new Date("2026-07-10T10:00:00.000Z"),
      });

      const response = await runWidgetTurn(widgetMessage(""), {
        triggerEventKind: "whatsapp_flow_reply",
        whatsAppFlowResponseJson: JSON.stringify({ product: "one" }),
      });

      expect(await response.json()).toMatchObject({ status: "ok" });
      expect(mockPersistPendingConditionState).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceActionNodeId: "source",
          conditionNodeId: "condition-2",
          pendingLastOutboundMessageId: expectedAnchor,
        })
      );
      expect(mockCompleteLockedScenarioAndPersist).not.toHaveBeenCalled();
      expect(mockSendAndPersistOutbound).not.toHaveBeenCalled();
    }
  );

  it("lets a frozen generating execution bypass all ordinary scenario resolution and state mutation", async () => {
    mockConversationFindById.mockReturnValue({
      select: () => ({
        lean: async () => ({
          airi_bot_enabled: false,
          airi_scenarios_enabled: true,
          sourceId: "source-1",
          airi_scenario_state: {
            lockedScenarioId: "edited-scenario",
            currentActionNodeId: "edited-action",
          },
          airi_pending_generative_execution: {
            version: 1,
            configVersion: 1,
            executionId: "execution-1",
            phase: "generating",
            scenarioId: "frozen-scenario",
            scenarioRevisionFingerprint: "a".repeat(64),
            actionNodeId: "frozen-action",
            inputMessageId: "message-original",
            expectedInputKind: "text",
            mode: "text_to_video",
            composedPrompt: "Frozen prompt",
            sourceMedia: null,
            successTransition: {
              nextActionNodeId: "success-action",
              completesScenario: false,
            },
            failureTransition: {
              nextActionNodeId: "failure-action",
              completesScenario: false,
            },
            scenarioWorkflowId: "scenario-generation:execution-1",
            acceptedAt: "2026-07-10T09:00:00.000Z",
          },
        }),
      }),
    });

    const response = await runWidgetTurn(
      widgetMessage("is it ready?", "message-2")
    );

    // A message during generation waits silently; the result is the reply.
    expect(await response.json()).toEqual({
      status: "ok",
      scenario_generative_waiting: true,
    });
    expect(mockSendAndPersistOutbound).not.toHaveBeenCalled();
    expect(mockResolveActiveScenarioRuntime).not.toHaveBeenCalled();
    expect(mockScenarioFindOne).not.toHaveBeenCalled();
    expect(mockPersistScenarioState).not.toHaveBeenCalled();
    expect(mockFinalizeScenarioResolution).not.toHaveBeenCalled();
    expect(mockCompleteLockedScenarioAndPersist).not.toHaveBeenCalled();
  });

  it("projects no generative inbound from a populated synthetic timeout turn", async () => {
    mockConversationFindById.mockReturnValue({
      select: () => ({
        lean: async () => ({
          airi_bot_enabled: false,
          airi_scenarios_enabled: true,
          sourceId: "source-1",
          airi_scenario_state: {},
        }),
      }),
    });
    mockResolveActiveScenarioRuntime.mockResolvedValue({ runtime: null });

    const response = await runWidgetTurn(
      {
        _id: "scenario-timeout:no_human_reply_timeout:scenario-1:2026-07-10T10:00:00.000Z",
        direction: "inbound",
        channel: "web_widget",
        date: new Date("2026-07-10T10:00:00.000Z"),
        text: "synthetic text must not become model input",
        imageUrl: "https://example.com/synthetic.jpg",
        whatsappMediaId: "synthetic-media",
        mimeType: "image/jpeg",
      },
      { triggerEventKind: "no_human_reply_timeout" }
    );

    expect(await response.json()).toMatchObject({ status: "ok" });
    expect(mockMessageFindById).not.toHaveBeenCalled();
    expect(mockResolveActiveScenarioRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        generativeInbound: null,
      })
    );
  });

  describe("replies while an action waits", () => {
    const scenarioId = "65f000000000000000000010";
    const noReply = { enabled: true, timeoutMinutes: 30 };
    const outcomeEdge = (
      source: string,
      outcome: "any_reply" | "no_reply",
      target: string
    ) => ({
      source,
      sourceHandle: buildScenarioActionOutcomeHandleId(outcome),
      target,
    });
    const action = (id: string, data: Record<string, unknown> = {}) => ({
      id,
      data: {
        kind: "action",
        actionType: "reply",
        actionReplyMode: "fixed",
        actionReplyText: id,
        ...data,
      },
    });
    const flowMessage = (
      field:
        | { id: string; label: string; fieldType: "TextInput" }
        | {
            id: string;
            label: string;
            fieldType: "RadioButtonsGroup";
            options: Array<{ id: string; title: string }>;
          }
    ) => ({
      version: 1,
      message: {
        kind: "flow",
        body: { mode: "fixed", text: "Open the form" },
        flowConfig: {
          templateId: "flow-1",
          ctaText: "Open",
          screens: [{ id: "screen-1", title: "Form", fields: [field] }],
        },
      },
    });
    const replyButtonsMenu = action("menu", {
      actionWhatsAppServiceMessage: {
        version: 1,
        message: {
          kind: "reply_buttons",
          body: { mode: "fixed", text: "Choose" },
          options: [
            { id: "wsc:menu:help", label: "Help" },
            { id: "wsc:menu:pricing", label: "Pricing" },
          ],
        },
      },
      actionOutcomes: { version: 1, noReply },
    });
    const templateMenu = action("menu", {
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
      actionOutcomes: { version: 1, noReply },
    });
    // DemoShop's medal_pick_1: the template's only button opens a form.
    const flowButtonTemplateMenu = action("menu", {
      actionType: "whatsapp_template",
      actionWhatsAppTemplateName: "medal_pick_1",
      actionWhatsAppTemplateLanguage: "kk",
      actionWhatsAppTemplateComponents: [
        {
          type: "BUTTONS",
          buttons: [
            {
              type: "FLOW",
              text: "Choose",
              flow_id: 2244981489363579,
              flow_action: "navigate",
              navigate_screen: "QUESTION_ONE",
            },
          ],
        },
      ],
      actionOutcomes: { version: 1, noReply },
    });
    const instagramMenu = action("menu", {
      actionReplyChannel: "instagram",
      actionInstagramConfig: {
        kind: "quick_replies",
        quickReplies: [
          { title: "Pricing", payload: "pricing" },
          { title: "Other", payload: "other" },
        ],
      },
      actionOutcomes: { version: 1, noReply },
    });
    const telegramMenu = action("menu", {
      actionReplyChannel: "telegram",
      actionTelegramQuickReplies: [
        [
          { text: "Yes", payload: "yes" },
          { text: "No", payload: "no" },
        ],
      ],
      actionOutcomes: { version: 1, noReply },
    });
    const flowChoiceMenu = action("menu", {
      actionWhatsAppServiceMessage: flowMessage({
        id: "plan",
        label: "Plan",
        fieldType: "RadioButtonsGroup",
        options: [
          { id: "one", title: "One" },
          { id: "two", title: "Two" },
        ],
      }),
      actionOutcomes: { version: 1, noReply },
    });
    const endAction = (id: string, data: Record<string, unknown> = {}) => ({
      id,
      data: { kind: "action", actionType: "end_scenario", ...data },
    });
    const endRuntime = (selectedActionNodeId: string) => ({
      scenarioId,
      scenarioName: "Waiting scenario",
      actionType: "end_scenario",
      selectedActionNodeId,
      completesScenario: true,
    });
    const replyRuntime = (
      selectedActionNodeId: string,
      patch: Record<string, unknown> = {}
    ) => ({
      scenarioId,
      scenarioName: "Waiting scenario",
      actionType: "reply",
      selectedActionNodeId,
      ...patch,
    });
    // An action's own outcome wait, armed on its delivered message.
    const waitingState = (
      actionNodeId: string,
      extra: Record<string, unknown> = {}
    ) => ({
      lockedScenarioId: scenarioId,
      lockedScenarioName: "Waiting scenario",
      currentActionNodeId: actionNodeId,
      pendingConditionNodeId:
        getScenarioActionOutcomeVirtualNodeId(actionNodeId),
      pendingSourceActionNodeId: actionNodeId,
      pendingStartedAt: new Date("2026-09-20T08:00:00.000Z"),
      pendingLastOutboundMessageId: "outbound-1",
      ...extra,
    });
    const keptWait = {
      startedAt: new Date("2026-09-20T08:00:00.000Z"),
      lastOutboundMessageId: "outbound-1",
    };
    const collecting = (
      sourceActionNodeId: string,
      extra: Record<string, unknown> = {}
    ) => ({
      scenarioId,
      sourceActionNodeId,
      awaitingReply: true,
      resumeActionNodeId: null,
      sourcePathNodeIds: [sourceActionNodeId],
      values: {},
      followsChoice: true,
      choiceOptionId: null,
      ...extra,
    });
    const extracting = (values: Record<string, string | null> | null) => ({
      extractScenarioPromptInputs: jest
        .fn()
        .mockResolvedValue(values && { values, choiceOptionId: null }),
    });
    const lockedScenarioNoMatch = {
      runtime: null,
      lockedScenarioNoMatch: {
        scenarioId,
        scenarioName: "Waiting scenario",
        lastActionNodeId: "menu",
      },
    };

    // Compiled graphs are cached by scenario ID and revision.
    let revision = 0;
    async function replyWhileWaiting(params: {
      waitingActionNodeId?: string;
      /** Defaults to the waiting action's outcome wait. */
      pendingConditionNodeId?: string;
      nodes: readonly unknown[];
      edges: readonly unknown[];
      channel?: "whatsapp" | "instagram" | "telegram";
      triggerEventKind: ScenarioRuntimeEventKind;
      quickReplyPayload?: string;
      whatsAppFlowResponseJson?: string;
      text?: string;
      /** Replaces the default wait on the action's own outcomes. */
      scenarioState?: Record<string, unknown>;
      /** Set to replay a timer turn. */
      turn?: {
        messageId: string;
        scenarioOverrideId?: string;
        proactiveTrigger?: boolean;
      };
      /** Overrides individual runtime dependencies. */
      dependencies?: Partial<typeof scenarioRuntimeDependencies>;
    }) {
      const waitingActionNodeId = params.waitingActionNodeId ?? "menu";
      const channel = params.channel ?? "whatsapp";
      const updatedAt = new Date(Date.UTC(2026, 8, 20, 7, 0, 0, ++revision));
      mockScenarioFindOne.mockReturnValue({
        select: () => ({
          lean: async () => ({
            _id: scenarioId,
            name: "Waiting scenario",
            nodes: params.nodes,
            edges: params.edges,
            updatedAt,
          }),
        }),
      });
      const { default: airiAutoReply } = await import(
        "@icecore/airi-runtime/auto-reply"
      );
      const response = await airiAutoReply(
        {
          type: channel,
          triggerEventKind: params.triggerEventKind,
          quickReplyPayload: params.quickReplyPayload,
          whatsAppFlowResponseJson: params.whatsAppFlowResponseJson,
          scenarioOverrideId: params.turn?.scenarioOverrideId,
          proactiveTrigger: params.turn?.proactiveTrigger,
          runtimeHydrated: true,
          workspaceId: "workspace-1",
          chatDocument: { _id: "chat-1", sourceId: "source-1" } as never,
          conversation: {
            _id: "conversation-1",
            sourceId: "source-1",
            airi_bot_enabled: false,
            airi_scenarios_enabled: true,
            airi_scenario_state:
              params.scenarioState ??
              waitingState(
                waitingActionNodeId,
                params.pendingConditionNodeId
                  ? { pendingConditionNodeId: params.pendingConditionNodeId }
                  : {}
              ),
          } as never,
          newMessage: {
            _id: params.turn?.messageId ?? "message-1",
            direction: "inbound",
            channel,
            date: new Date("2026-09-20T08:05:00.000Z"),
            text: params.text ?? "Tapped a reply",
          } as never,
        },
        { ...scenarioRuntimeDependencies, ...params.dependencies }
      );
      return response.json();
    }

    const clearedWait = {
      lockedScenarioId: scenarioId,
      currentActionNodeId: "menu",
      pendingConditionNodeId: null,
      pendingSourceActionNodeId: null,
    };

    beforeEach(() => {
      mockResolveInteractiveReplyConditionTarget.mockReturnValue(null);
      mockClearPendingConditionStateAndPersist.mockResolvedValue(clearedWait);
      mockFinalizeScenarioResolution.mockResolvedValue(null);
    });

    function expectWaitKept() {
      expect(mockClearPendingConditionStateAndPersist).not.toHaveBeenCalled();
      expect(mockPersistScenarioState).not.toHaveBeenCalled();
      expect(mockPersistPendingConditionState).not.toHaveBeenCalled();
      expect(mockCompleteLockedScenarioAndPersist).not.toHaveBeenCalled();
      expect(mockFinalizeScenarioResolution).not.toHaveBeenCalled();
      expect(mockSendAndPersistOutbound).not.toHaveBeenCalled();
    }

    it.each([
      "inbound_message",
      "whatsapp_button_reply",
      "no_human_reply_timeout",
    ] as const)(
      "keeps an unsent action pending on %s without progressing or answering",
      async triggerEventKind => {
        const findLatestScenarioActionOutbound = jest
          .fn()
          .mockResolvedValue(null);
        const body = await replyWhileWaiting({
          nodes: [
            action("menu", {
              actionOutcomes: {
                version: 1,
                noReply,
                anyReply: { enabled: true },
              },
            }),
            action("later"),
          ],
          edges: [
            outcomeEdge("menu", "no_reply", "later"),
            outcomeEdge("menu", "any_reply", "later"),
          ],
          triggerEventKind,
          quickReplyPayload:
            triggerEventKind === "whatsapp_button_reply"
              ? "wsc:menu:help"
              : undefined,
          scenarioState: waitingState("menu", {
            pendingLastOutboundMessageId: null,
          }),
          dependencies: { findLatestScenarioActionOutbound },
          ...(triggerEventKind === "no_human_reply_timeout"
            ? {
                turn: {
                  messageId:
                    "scenario-timeout:no_human_reply_timeout:scenario-1:2026-09-20T10:00:00.000Z",
                  scenarioOverrideId: scenarioId,
                  proactiveTrigger: true,
                },
              }
            : {}),
        });
        expect(body).toEqual({
          status: "ok",
          skipped_pending_outbound_unconfirmed: true,
        });
        expectWaitKept();
        expect(mockResolveActiveScenarioRuntime).not.toHaveBeenCalled();
        expect(mockRunRagReplyFlow).not.toHaveBeenCalled();
        expect(findLatestScenarioActionOutbound).not.toHaveBeenCalled();
      }
    );

    it("requires the exact pending outbound to have been accepted, not merely reserved", async () => {
      mockMessageFindOne.mockReturnValue({
        sort: () => ({
          select: () => ({
            lean: async () => ({
              _id: "outbound-1",
              channel: "whatsapp",
              temporalDispatch: { state: "reserved" },
            }),
          }),
        }),
      });
      const body = await replyWhileWaiting({
        nodes: [
          action("menu", {
            actionOutcomes: {
              version: 1,
              noReply,
              anyReply: { enabled: true },
            },
          }),
          action("later"),
        ],
        edges: [
          outcomeEdge("menu", "no_reply", "later"),
          outcomeEdge("menu", "any_reply", "later"),
        ],
        triggerEventKind: "inbound_message",
      });
      expect(body).toEqual({
        status: "ok",
        skipped_pending_outbound_unconfirmed: true,
      });
      expectWaitKept();
      expect(mockMessageFindOne).toHaveBeenCalledWith(
        expect.objectContaining({
          _id: "outbound-1",
          workspaceId: "workspace-1",
          conversation: "conversation-1",
          direction: "outbound",
          "origin.scenarioId": scenarioId,
          "origin.nodeId": "menu",
        })
      );
    });

    function expectWaitReplacedAfterRouting(baseState: unknown = clearedWait) {
      expect(mockClearPendingConditionStateAndPersist).toHaveBeenCalledTimes(1);
      expect(
        mockClearPendingConditionStateAndPersist.mock.invocationCallOrder[0]
      ).toBeGreaterThan(
        mockResolveActiveScenarioRuntime.mock.invocationCallOrder[0]
      );
      expect(mockPersistScenarioState).toHaveBeenCalledWith(
        expect.objectContaining({ baseState })
      );
      expect(
        mockPersistScenarioState.mock.invocationCallOrder[0]
      ).toBeGreaterThan(
        mockClearPendingConditionStateAndPersist.mock.invocationCallOrder[0]
      );
    }

    describe("a No reply reminder on a text message that collects details", () => {
      const TEXT_ASK = {
        version: 1,
        message: {
          kind: "text",
          body: { mode: "fixed", text: "Send the name to engrave." },
          previewUrl: false,
        },
        promptInputs: [
          { key: "name", label: "Name", prompt: "Name to engrave" },
        ],
      };
      const nodes = [
        action("ask", {
          actionWhatsAppServiceMessage: TEXT_ASK,
          actionOutcomes: { version: 1, noReply },
        }),
        endAction("engrave"),
        action("reminder"),
      ];
      const edges = [
        { source: "ask", sourceHandle: "right-source", target: "engrave" },
        outcomeEdge("ask", "no_reply", "reminder"),
      ];
      const reminderWaitId = getScenarioActionOutcomeVirtualNodeId("ask");
      // The ask's reminder is armed; no resume target is known yet.
      const askState = waitingState("ask", {
        collectedPromptInputs: collecting("ask", { followsChoice: false }),
      });
      // What the resolver returns for the ask while its own wait holds it.
      const askRuntime = replyRuntime("ask", {
        selectedPathNodeIds: ["ask"],
        nextActionNodeId: "ask",
        completesScenario: false,
        pendingConditionNodeId: reminderWaitId,
        pendingSourceActionNodeId: "ask",
        actionWhatsAppServiceMessage: TEXT_ASK,
        actionPromptInputsMetTransition: {
          nextActionNodeId: "engrave",
          completesScenario: false,
        },
      });

      it("keeps a partial answer and the reminder instead of ending the scenario", async () => {
        mockResolveActiveScenarioRuntime.mockResolvedValue({
          runtime: askRuntime,
        });

        const body = await replyWhileWaiting({
          waitingActionNodeId: "ask",
          nodes,
          edges,
          triggerEventKind: SCENARIO_TRIGGER_EVENT_KIND.inboundMessage,
          text: "Let me think about the name",
          scenarioState: askState,
          dependencies: extracting({ name: null }),
        });

        expect(body).toEqual({
          status: "ok",
          scenario_prompt_input_stored: true,
        });
        expect(mockCompleteLockedScenarioAndPersist).not.toHaveBeenCalled();
        expect(mockPersistScenarioState).toHaveBeenCalledWith(
          expect.objectContaining({
            scenarioRuntime: expect.objectContaining({
              selectedActionNodeId: "ask",
              pendingConditionNodeId: reminderWaitId,
            }),
            keepPendingWait: keptWait,
          })
        );
        expect(mockSendAndPersistOutbound).not.toHaveBeenCalled();
      });

      it("continues on the collected route once the answer is complete", async () => {
        mockResolveActiveScenarioRuntime
          .mockResolvedValueOnce({ runtime: askRuntime })
          .mockResolvedValueOnce({ runtime: endRuntime("engrave") });

        const body = await replyWhileWaiting({
          waitingActionNodeId: "ask",
          nodes,
          edges,
          triggerEventKind: SCENARIO_TRIGGER_EVENT_KIND.inboundMessage,
          text: "Aya",
          scenarioState: askState,
          dependencies: extracting({ name: "Aya" }),
        });

        expect(mockCompleteLockedScenarioAndPersist).not.toHaveBeenCalled();
        expect(mockResolveActiveScenarioRuntime).toHaveBeenCalledTimes(2);
        expect(mockResolveActiveScenarioRuntime.mock.calls[1][0]).toMatchObject(
          {
            scenarioState: expect.objectContaining({
              currentActionNodeId: "engrave",
            }),
          }
        );
        expect(body).toEqual({ status: "ok", scenario_ended: true });
      });
    });

    describe("a No reply reminder on a message that collects details", () => {
      const ASK_MESSAGE = {
        version: 1,
        message: {
          kind: "reply_buttons",
          body: { mode: "fixed", text: "Pick a frame, then send the name." },
          options: [
            { id: "wsc:menu:gold", label: "Gold" },
            { id: "wsc:menu:silver", label: "Silver" },
          ],
        },
        promptInputs: [
          { key: "name", label: "Name", prompt: "Name to engrave" },
        ],
      };
      const nodes = [
        action("menu", {
          actionWhatsAppServiceMessage: ASK_MESSAGE,
          actionOutcomes: { version: 1, noReply },
        }),
        action("gold"),
        action("reminder"),
      ];
      const edges = [
        {
          source: "menu",
          sourceHandle:
            buildWhatsAppSessionChoiceSourceHandleId("wsc:menu:gold"),
          target: "gold",
        },
        outcomeEdge("menu", "no_reply", "reminder"),
      ];
      const reminderWaitId = getScenarioActionOutcomeVirtualNodeId("menu");
      const askState = (collection: Record<string, unknown> = {}) =>
        waitingState("menu", {
          collectedPromptInputs: collecting("menu", collection),
        });

      it("hands words sent before the tap to the ask and keeps the reminder", async () => {
        mockResolveActiveScenarioRuntime.mockResolvedValue({
          runtime: replyRuntime("menu", {
            selectedPathNodeIds: ["menu"],
            nextActionNodeId: "menu",
            pendingConditionNodeId: reminderWaitId,
            pendingSourceActionNodeId: "menu",
            actionWhatsAppServiceMessage: ASK_MESSAGE,
          }),
        });

        const body = await replyWhileWaiting({
          nodes,
          edges,
          triggerEventKind: SCENARIO_TRIGGER_EVENT_KIND.inboundMessage,
          text: "Aya",
          scenarioState: askState(),
          // An unavailable reading holds silently.
          dependencies: extracting(null),
        });

        expect(body).toEqual({
          status: "ok",
          scenario_prompt_input_stored: true,
        });
        expect(mockResolveActiveScenarioRuntime).toHaveBeenCalledWith(
          expect.objectContaining({
            forcedActionNodeId: "menu",
            skipTriggerMatch: true,
          })
        );
        expect(mockClearPendingConditionStateAndPersist).not.toHaveBeenCalled();
        expect(mockPersistScenarioState).toHaveBeenCalledWith(
          expect.objectContaining({
            scenarioRuntime: expect.objectContaining({
              pendingConditionNodeId: reminderWaitId,
            }),
            keepPendingWait: keptWait,
          })
        );
        expect(mockSendAndPersistOutbound).not.toHaveBeenCalled();
      });

      it("keeps the reminder armed after a tap whose details are pending", async () => {
        mockResolveActiveScenarioRuntime.mockResolvedValue({
          runtime: replyRuntime("gold", {
            selectedPathNodeIds: ["menu", "gold"],
            nextActionNodeId: "gold",
            choicePromptInputSource: {
              actionNodeId: "menu",
              optionId: "wsc:menu:gold",
              config: ASK_MESSAGE,
            },
          }),
        });

        const body = await replyWhileWaiting({
          nodes,
          edges,
          triggerEventKind: SCENARIO_TRIGGER_EVENT_KIND.whatsAppButtonReply,
          quickReplyPayload: "wsc:menu:gold",
          text: "Gold",
          scenarioState: askState(),
        });

        expect(body).toEqual({
          status: "ok",
          scenario_prompt_input_stored: true,
        });
        expect(mockClearPendingConditionStateAndPersist).not.toHaveBeenCalled();
        expect(mockPersistScenarioState).toHaveBeenCalledWith(
          expect.objectContaining({
            scenarioRuntime: expect.objectContaining({
              selectedActionNodeId: "menu",
              pendingConditionNodeId: reminderWaitId,
              pendingSourceActionNodeId: "menu",
            }),
            keepPendingWait: keptWait,
            baseState: expect.objectContaining({
              collectedPromptInputs: expect.objectContaining({
                awaitingReply: true,
                choiceOptionId: "wsc:menu:gold",
              }),
            }),
          })
        );
        expect(mockSendAndPersistOutbound).not.toHaveBeenCalled();
      });

      const tappedAsk = askState({
        choiceOptionId: "wsc:menu:gold",
        resumeActionNodeId: "gold",
        values: { name: "Aya" },
      });
      const reminderRuntime = (patch: Record<string, unknown> = {}) =>
        replyRuntime("reminder", {
          selectedPathNodeIds: ["menu", "reminder"],
          nextActionNodeId: null,
          completesScenario: true,
          ...patch,
        });

      it("follows No reply, then hands the conversation back to the ask", async () => {
        mockResolveActiveScenarioRuntime.mockResolvedValue({
          runtime: reminderRuntime(),
        });

        await replyWhileWaiting({
          nodes,
          edges,
          triggerEventKind: SCENARIO_TRIGGER_EVENT_KIND.noHumanReplyTimeout,
          scenarioState: tappedAsk,
        });

        expect(mockResolveActiveScenarioRuntime).toHaveBeenCalledWith(
          expect.objectContaining({
            forcedActionNodeId: "reminder",
            triggerEventKind: "no_human_reply_timeout",
          })
        );
        // The reminder only nudges; the ask keeps its tap and answers.
        expect(mockPersistScenarioState).toHaveBeenCalledWith(
          expect.objectContaining({
            scenarioRuntime: expect.objectContaining({
              selectedActionNodeId: "reminder",
              nextActionNodeId: "menu",
              completesScenario: false,
            }),
            baseState: expect.objectContaining({
              collectedPromptInputs: expect.objectContaining({
                awaitingReply: true,
                choiceOptionId: "wsc:menu:gold",
                values: { name: "Aya" },
              }),
            }),
          })
        );
        expect(mockCompleteLockedScenarioAndPersist).not.toHaveBeenCalled();
      });

      it("closes the ask when the reminder's route goes on past it", async () => {
        mockResolveActiveScenarioRuntime.mockResolvedValue({
          runtime: reminderRuntime({
            nextActionNodeId: "offer",
            completesScenario: false,
          }),
        });

        await replyWhileWaiting({
          nodes,
          edges,
          triggerEventKind: SCENARIO_TRIGGER_EVENT_KIND.noHumanReplyTimeout,
          scenarioState: tappedAsk,
        });

        expect(mockPersistScenarioState).toHaveBeenCalledWith(
          expect.objectContaining({
            scenarioRuntime: expect.objectContaining({
              nextActionNodeId: "offer",
            }),
            baseState: expect.objectContaining({
              collectedPromptInputs: expect.objectContaining({
                awaitingReply: false,
                choiceOptionId: null,
                values: { name: "Aya" },
              }),
            }),
          })
        );
      });
    });

    it("routes an Instagram quick reply to the waiting action's branch", async () => {
      mockResolveActiveScenarioRuntime.mockResolvedValue({
        runtime: endRuntime("pricing"),
      });

      const body = await replyWhileWaiting({
        channel: "instagram",
        nodes: [
          instagramMenu,
          endAction("pricing", { instagramBranchPayload: "pricing" }),
          action("later", { actionReplyChannel: "instagram" }),
        ],
        edges: [
          {
            source: "menu",
            sourceHandle: ACTION_INSTAGRAM_BRANCH_OUTPUT_HANDLE_ID,
            target: "pricing",
          },
          outcomeEdge("menu", "no_reply", "later"),
        ],
        triggerEventKind: SCENARIO_TRIGGER_EVENT_KIND.instagramQuickReply,
        quickReplyPayload: "pricing",
      });

      expect(body).toEqual({ status: "ok", scenario_ended: true });
      expect(mockResolveInteractiveReplyConditionTarget).toHaveBeenCalledWith(
        expect.objectContaining({
          preferredActionNodeId: "menu",
          triggerEventKind: "instagram_quick_reply",
        })
      );
      expect(mockResolveActiveScenarioRuntime).toHaveBeenCalledTimes(1);
      expect(mockResolveActiveScenarioRuntime).toHaveBeenCalledWith(
        expect.objectContaining({
          triggerEventKind: "instagram_quick_reply",
          quickReplyPayload: "pricing",
        })
      );
      expectWaitReplacedAfterRouting();
    });

    it.each([
      [
        "Instagram quick reply",
        instagramMenu,
        "instagram",
        ACTION_INSTAGRAM_BRANCH_OUTPUT_HANDLE_ID,
        SCENARIO_TRIGGER_EVENT_KIND.instagramQuickReply,
        { quickReplyPayload: "other" },
      ],
      [
        "Telegram inline button",
        telegramMenu,
        "telegram",
        buildTelegramBranchSourceHandleId("yes"),
        SCENARIO_TRIGGER_EVENT_KIND.telegramQuickReply,
        { quickReplyPayload: "no" },
      ],
      [
        "WhatsApp reply button",
        replyButtonsMenu,
        "whatsapp",
        buildWhatsAppSessionChoiceSourceHandleId("wsc:menu:help"),
        SCENARIO_TRIGGER_EVENT_KIND.whatsAppButtonReply,
        { quickReplyPayload: "wsc:menu:pricing" },
      ],
      [
        "WhatsApp template quick-reply button",
        templateMenu,
        "whatsapp",
        buildWhatsAppTemplateButtonSourceHandleId(0),
        SCENARIO_TRIGGER_EVENT_KIND.whatsAppButtonReply,
        { quickReplyPayload: buildWhatsAppTemplateButtonPayload("menu", 1) },
      ],
      [
        "WhatsApp Flow choice",
        flowChoiceMenu,
        "whatsapp",
        buildFlowBranchSourceHandleId("plan", "one"),
        SCENARIO_TRIGGER_EVENT_KIND.whatsAppFlowReply,
        { whatsAppFlowResponseJson: JSON.stringify({ plan: "two" }) },
      ],
    ] as const)(
      "keeps the wait and its timer when a %s matches no connected branch",
      async (_, menu, channel, branchHandle, triggerEventKind, reply) => {
        mockResolveActiveScenarioRuntime.mockResolvedValue(
          lockedScenarioNoMatch
        );

        const body = await replyWhileWaiting({
          channel,
          nodes: [menu, action("help"), action("later")],
          edges: [
            { source: "menu", sourceHandle: branchHandle, target: "help" },
            outcomeEdge("menu", "no_reply", "later"),
          ],
          triggerEventKind,
          ...reply,
        });

        expect(body).toEqual({
          status: "ok",
          skipped_interactive_reply_no_branch_match: true,
        });
        expect(mockResolveActiveScenarioRuntime).toHaveBeenCalledTimes(1);
        expect(mockResolveActiveScenarioRuntime).toHaveBeenCalledWith(
          expect.objectContaining({ triggerEventKind, ...reply })
        );
        expectWaitKept();
      }
    );

    it.each([
      ["leads to a No-reply follow-up", true],
      ["has no No-reply follow-up", false],
    ] as const)(
      "keeps a tap on another campaign's button with the lock only when the wait %s",
      async (_, followUpPending) => {
        mockResolveActiveScenarioRuntime.mockResolvedValue(
          lockedScenarioNoMatch
        );

        await replyWhileWaiting({
          nodes: [templateMenu, action("help"), action("later")],
          edges: [
            {
              source: "menu",
              sourceHandle: buildWhatsAppTemplateButtonSourceHandleId(0),
              target: "help",
            },
            ...(followUpPending
              ? [outcomeEdge("menu", "no_reply", "later")]
              : []),
          ],
          triggerEventKind: SCENARIO_TRIGGER_EVENT_KIND.whatsAppButtonReply,
          // An older campaign's template step, not in this scenario.
          quickReplyPayload: buildWhatsAppTemplateButtonPayload("fall-tpl", 0),
        });

        expect(mockResolveActiveScenarioRuntime).toHaveBeenCalledTimes(1);
        const resolution = mockResolveActiveScenarioRuntime.mock.calls[0][0];
        if (followUpPending) {
          expect(resolution).toMatchObject({
            lockedScenarioFollowUpPending: true,
          });
          expectWaitKept();
        } else {
          expect(resolution).not.toHaveProperty(
            "lockedScenarioFollowUpPending"
          );
        }
      }
    );

    const reminderWait = {
      waitingActionNodeId: "reminder",
      nodes: [
        replyButtonsMenu,
        endAction("help", { whatsAppSessionChoicePayload: "wsc:menu:help" }),
        action("reminder", { actionOutcomes: { version: 1, noReply } }),
        action("last-call"),
      ],
      edges: [
        {
          source: "menu",
          sourceHandle:
            buildWhatsAppSessionChoiceSourceHandleId("wsc:menu:help"),
          target: "help",
        },
        outcomeEdge("menu", "no_reply", "reminder"),
        outcomeEdge("reminder", "no_reply", "last-call"),
      ],
      triggerEventKind: SCENARIO_TRIGGER_EVENT_KIND.whatsAppButtonReply,
    } as const;
    const flowWithoutChoicesWait = {
      nodes: [
        action("menu", {
          actionWhatsAppServiceMessage: flowMessage({
            id: "name",
            label: "Name",
            fieldType: "TextInput",
          }),
          actionOutcomes: { version: 1, anyReply: { enabled: true }, noReply },
        }),
        endAction("thanks"),
        action("later"),
      ],
      edges: [
        outcomeEdge("menu", "any_reply", "thanks"),
        outcomeEdge("menu", "no_reply", "later"),
      ],
      triggerEventKind: SCENARIO_TRIGGER_EVENT_KIND.whatsAppFlowReply,
      whatsAppFlowResponseJson: JSON.stringify({ name: "Amina" }),
    } as const;

    it.each([
      [
        "an older message's button after the timer sent a reminder",
        { ...reminderWait, quickReplyPayload: "wsc:menu:help" },
        "help",
      ],
      [
        "a Flow submission without choice fields",
        flowWithoutChoicesWait,
        "thanks",
      ],
    ] as const)(
      "resolves %s normally and replaces the wait when it routes",
      async (_, wait, routedActionNodeId) => {
        mockResolveActiveScenarioRuntime.mockResolvedValue({
          runtime: endRuntime(routedActionNodeId),
        });

        const body = await replyWhileWaiting(wait);

        expect(body).toEqual({ status: "ok", scenario_ended: true });
        expect(mockResolveActiveScenarioRuntime).toHaveBeenCalledTimes(1);
        const resolution = mockResolveActiveScenarioRuntime.mock.calls[0][0];
        expect(resolution).toMatchObject({
          triggerEventKind: wait.triggerEventKind,
        });
        expect(resolution).not.toHaveProperty("forcedActionNodeId");
        expectWaitReplacedAfterRouting();
        expect(mockCompleteLockedScenarioAndPersist).not.toHaveBeenCalled();
      }
    );

    it.each([
      [
        "an older message's button that matches nothing",
        { ...reminderWait, quickReplyPayload: "wsc:menu:pricing" },
        { runtime: null },
        { skipped_quick_reply_no_branch_match: true },
      ],
      [
        "a Flow submission without choice fields or a continuation",
        {
          ...flowWithoutChoicesWait,
          edges: [outcomeEdge("menu", "no_reply", "later")],
        },
        lockedScenarioNoMatch,
        { skipped_interactive_reply_no_branch_match: true },
      ],
    ] as const)(
      "keeps the wait when %s arrives",
      async (_, wait, resolution, skipped) => {
        mockResolveActiveScenarioRuntime.mockResolvedValue(resolution);

        const body = await replyWhileWaiting(wait);

        expect(body).toEqual({ status: "ok", ...skipped });
        expect(mockResolveActiveScenarioRuntime).toHaveBeenCalledTimes(1);
        expectWaitKept();
      }
    );

    it.each([
      ["template quick-reply buttons", templateMenu],
      ["service-message reply buttons", replyButtonsMenu],
      ["a plain text message", action("menu")],
      ["a template whose only button opens a form", flowButtonTemplateMenu],
    ] as const)("treats typed text on %s the same way", async (_, menu) => {
      mockResolveActiveScenarioRuntime.mockResolvedValue({ runtime: null });
      const typedWhileWaiting = (anyReply: boolean) =>
        replyWhileWaiting({
          nodes: [
            {
              ...menu,
              data: {
                ...menu.data,
                actionOutcomes: {
                  version: 1,
                  noReply,
                  ...(anyReply ? { anyReply: { enabled: true } } : {}),
                },
              },
            },
            action("reply-target"),
            action("later"),
          ],
          edges: [
            ...(anyReply
              ? [outcomeEdge("menu", "any_reply", "reply-target")]
              : []),
            outcomeEdge("menu", "no_reply", "later"),
          ],
          triggerEventKind: SCENARIO_TRIGGER_EVENT_KIND.inboundMessage,
          text: "Can I choose something else?",
        });

      const ignored = await typedWhileWaiting(false);
      expect(ignored).toMatchObject({ status: "ok" });
      // The reminder chain goes on: nothing claims or completes the wait.
      expect(ignored).not.toHaveProperty(
        "skipped_authoritative_scenario_continuation"
      );
      expect(mockResolveActiveScenarioRuntime).not.toHaveBeenCalled();
      expectWaitKept();

      await typedWhileWaiting(true);
      expect(mockResolveActiveScenarioRuntime).toHaveBeenCalledTimes(1);
      expect(mockResolveActiveScenarioRuntime).toHaveBeenCalledWith(
        expect.objectContaining({
          forcedScenarioId: scenarioId,
          forcedActionNodeId: "reply-target",
          triggerEventKind: "post_action_user_reply",
        })
      );
    });

    // medal_pick_1 today: No reply only, no route for the form.
    it.each([
      [
        "matches no route",
        lockedScenarioNoMatch,
        { skipped_interactive_reply_no_branch_match: true },
      ],
      [
        "starts nothing",
        { runtime: null },
        { skipped_flow_reply_no_branch_match: true },
      ],
    ] as const)(
      "saves a template form's answers and keeps its No reply wait when the reply %s",
      async (_, resolution, skipped) => {
        mockResolveActiveScenarioRuntime.mockResolvedValue(resolution);

        const body = await replyWhileWaiting({
          nodes: [flowButtonTemplateMenu, action("later")],
          edges: [outcomeEdge("menu", "no_reply", "later")],
          triggerEventKind: SCENARIO_TRIGGER_EVENT_KIND.whatsAppFlowReply,
          whatsAppFlowResponseJson: JSON.stringify({
            _68d224: "Aya",
            flow_token: "flow_1",
          }),
          dependencies: {
            findSubmittedScenarioForm: jest.fn().mockResolvedValue({
              scenarioId,
              sourceActionNodeId: "menu",
              flowId: "2244981489363579",
              fields: null,
            }),
          },
        });

        expect(body).toEqual({ status: "ok", ...skipped });
        expectWaitKept();
        expect(mockPersistScenarioFormSubmission).toHaveBeenCalledTimes(1);
        expect(mockPersistScenarioFormSubmission).toHaveBeenCalledWith({
          conversationId: "conversation-1",
          baseState: waitingState("menu"),
          submitted: {
            scenarioId,
            submission: expect.objectContaining({
              sourceActionNodeId: "menu",
              flowId: "2244981489363579",
              inboundMessageId: "message-1",
            }),
          },
        });
      }
    );

    describe("a template whose form has its own Form submitted route", () => {
      const formRouteEdge = {
        source: "menu",
        sourceHandle: ACTION_WHATSAPP_TEMPLATE_FORM_SUBMITTED_HANDLE_ID,
        target: "design",
      };
      const formRouteWait = {
        nodes: [flowButtonTemplateMenu, endAction("design"), action("later")],
        edges: [formRouteEdge, outcomeEdge("menu", "no_reply", "later")],
        triggerEventKind: SCENARIO_TRIGGER_EVENT_KIND.whatsAppFlowReply,
        whatsAppFlowResponseJson: JSON.stringify({
          _68d224: "Aya",
          flow_token: "flow_1",
        }),
      };
      // The scenario message whose form the reply submitted.
      const formSentBy = (sourceActionNodeId: string | null) => ({
        findSubmittedScenarioForm: jest.fn().mockResolvedValue(
          sourceActionNodeId && {
            scenarioId,
            sourceActionNodeId,
            flowId: "2244981489363579",
            fields: null,
          }
        ),
      });

      it("ends the wait only through the route a reply to its form takes", async () => {
        mockResolveActiveScenarioRuntime.mockResolvedValue({
          runtime: endRuntime("design"),
        });

        const body = await replyWhileWaiting({
          ...formRouteWait,
          dependencies: formSentBy("menu"),
        });

        expect(body).toEqual({ status: "ok", scenario_ended: true });
        expect(mockResolveActiveScenarioRuntime).toHaveBeenCalledTimes(1);
        expect(mockResolveActiveScenarioRuntime).toHaveBeenCalledWith(
          expect.objectContaining({
            triggerEventKind: "whatsapp_flow_reply",
            whatsAppFlowReplySource: { scenarioId, actionNodeId: "menu" },
          })
        );
        // Routing, not the wait, answers the form: only the locked step looks
        // for a Flow-choice branch, once.
        expect(
          mockResolveInteractiveReplyConditionTarget
        ).toHaveBeenCalledTimes(1);
        expectWaitReplacedAfterRouting({
          ...clearedWait,
          formAnswers: {
            scenarioId,
            submissions: [
              expect.objectContaining({ sourceActionNodeId: "menu" }),
            ],
          },
        });
        expect(mockCompleteLockedScenarioAndPersist).not.toHaveBeenCalled();
        // The routed turn saves the answers with its own state.
        expect(mockPersistScenarioFormSubmission).not.toHaveBeenCalled();
      });

      it.each([
        ["the template's form", "menu"],
        ["no scenario message's form", null],
      ])(
        "keeps the wait and its timer when a reply to %s takes no route",
        async (_, sourceActionNodeId) => {
          mockResolveActiveScenarioRuntime.mockResolvedValue(
            lockedScenarioNoMatch
          );

          const body = await replyWhileWaiting({
            ...formRouteWait,
            dependencies: formSentBy(sourceActionNodeId),
          });

          expect(body).toEqual({
            status: "ok",
            skipped_interactive_reply_no_branch_match: true,
          });
          const resolution = mockResolveActiveScenarioRuntime.mock.calls[0][0];
          if (sourceActionNodeId) {
            expect(resolution.whatsAppFlowReplySource).toEqual({
              scenarioId,
              actionNodeId: sourceActionNodeId,
            });
            // Its answers still count, saved over the state the turn began
            // with, which keeps the wait.
            expect(mockPersistScenarioFormSubmission).toHaveBeenCalledWith({
              conversationId: "conversation-1",
              baseState: waitingState("menu"),
              submitted: {
                scenarioId,
                submission: expect.objectContaining({
                  sourceActionNodeId: "menu",
                }),
              },
            });
          } else {
            expect(resolution).not.toHaveProperty("whatsAppFlowReplySource");
            expect(mockPersistScenarioFormSubmission).not.toHaveBeenCalled();
          }
          expectWaitKept();
        }
      );

      it("keeps the wait on typed text unless Any reply is on", async () => {
        mockResolveActiveScenarioRuntime.mockResolvedValue({ runtime: null });
        const typedWhileWaiting = (anyReply: boolean) =>
          replyWhileWaiting({
            nodes: [
              {
                ...flowButtonTemplateMenu,
                data: {
                  ...flowButtonTemplateMenu.data,
                  actionOutcomes: {
                    version: 1,
                    noReply,
                    ...(anyReply ? { anyReply: { enabled: true } } : {}),
                  },
                },
              },
              endAction("design"),
              action("reply-target"),
              action("later"),
            ],
            edges: [
              formRouteEdge,
              ...(anyReply
                ? [outcomeEdge("menu", "any_reply", "reply-target")]
                : []),
              outcomeEdge("menu", "no_reply", "later"),
            ],
            triggerEventKind: SCENARIO_TRIGGER_EVENT_KIND.inboundMessage,
            text: "Can I send the names later?",
          });

        await typedWhileWaiting(false);
        expect(mockResolveActiveScenarioRuntime).not.toHaveBeenCalled();
        expectWaitKept();

        await typedWhileWaiting(true);
        expect(mockResolveActiveScenarioRuntime).toHaveBeenCalledWith(
          expect.objectContaining({
            forcedActionNodeId: "reply-target",
            triggerEventKind: "post_action_user_reply",
          })
        );
      });
    });

    describe("after a builder edit removes the wait", () => {
      const waitNodeId = getScenarioActionOutcomeVirtualNodeId("menu");
      const releasedState = {
        lockedScenarioId: null,
        currentActionNodeId: null,
        pendingConditionNodeId: null,
        pendingSourceActionNodeId: null,
        completedScenarios: [{ scenarioId }],
      };
      const menuWithNoReply = action("menu", {
        actionOutcomes: { version: 1, noReply },
      });

      beforeEach(() => {
        mockCompleteLockedScenarioAndPersist.mockResolvedValue({
          state: releasedState,
          persisted: true,
        });
      });

      // The release must not touch a wait that replaced this one.
      function expectFencedRelease(conditionNodeId = waitNodeId) {
        expect(mockCompleteLockedScenarioAndPersist).toHaveBeenCalledTimes(1);
        expect(mockCompleteLockedScenarioAndPersist).toHaveBeenCalledWith(
          expect.objectContaining({
            conversationId: "conversation-1",
            scenarioId,
            lastActionNodeId: "menu",
            expectedPendingState: {
              conditionNodeId,
              sourceActionNodeId: "menu",
              pendingStartedAt: new Date("2026-09-20T08:00:00.000Z"),
              lastOutboundMessageId: "outbound-1",
            },
          })
        );
      }

      it.each([
        [
          "the waiting action's outcomes are disconnected",
          undefined,
          [menuWithNoReply, action("later")],
        ],
        ["the waiting action is deleted", undefined, [action("later")]],
        [
          "the legacy wait node is deleted",
          "legacy-wait",
          [action("menu"), action("later")],
        ],
      ] as const)(
        "releases the wait and handles typed text as a new message when %s",
        async (_, pendingConditionNodeId, nodes) => {
          mockResolveActiveScenarioRuntime.mockResolvedValue({
            runtime: endRuntime("entry"),
          });

          const body = await replyWhileWaiting({
            pendingConditionNodeId,
            nodes,
            edges: [],
            triggerEventKind: SCENARIO_TRIGGER_EVENT_KIND.inboundMessage,
            text: "Hello again",
          });

          expect(body).toEqual({ status: "ok", scenario_ended: true });
          expectFencedRelease(pendingConditionNodeId);
          expect(mockResolveActiveScenarioRuntime).toHaveBeenCalledTimes(1);
          const resolution = mockResolveActiveScenarioRuntime.mock.calls[0][0];
          expect(resolution).toMatchObject({
            scenarioState: releasedState,
            triggerEventKind: "inbound_message",
            triggerMessageText: "Hello again",
          });
          expect(resolution.forcedScenarioId).toBeUndefined();
          expect(resolution).not.toHaveProperty("forcedActionNodeId");
          expect(
            mockCompleteLockedScenarioAndPersist.mock.invocationCallOrder[0]
          ).toBeLessThan(
            mockResolveActiveScenarioRuntime.mock.invocationCallOrder[0]
          );
          expect(mockPersistScenarioState).toHaveBeenCalledWith(
            expect.objectContaining({ baseState: releasedState })
          );
        }
      );

      const helpBranch = {
        nodes: [
          replyButtonsMenu,
          endAction("help", { whatsAppSessionChoicePayload: "wsc:menu:help" }),
        ],
        edges: [
          {
            source: "menu",
            sourceHandle:
              buildWhatsAppSessionChoiceSourceHandleId("wsc:menu:help"),
            target: "help",
          },
        ],
      };

      it("routes a button tap after the release without the stale lock", async () => {
        mockResolveActiveScenarioRuntime.mockResolvedValue({
          runtime: endRuntime("help"),
        });

        const body = await replyWhileWaiting({
          ...helpBranch,
          triggerEventKind: SCENARIO_TRIGGER_EVENT_KIND.whatsAppButtonReply,
          quickReplyPayload: "wsc:menu:help",
        });

        expect(body).toEqual({ status: "ok", scenario_ended: true });
        expectFencedRelease();
        expect(
          mockResolveInteractiveReplyConditionTarget
        ).not.toHaveBeenCalled();
        expect(mockPersistPendingConditionState).not.toHaveBeenCalled();
        expect(mockClearPendingConditionStateAndPersist).not.toHaveBeenCalled();
        expect(mockResolveActiveScenarioRuntime).toHaveBeenCalledTimes(1);
        expect(mockResolveActiveScenarioRuntime).toHaveBeenCalledWith(
          expect.objectContaining({
            scenarioState: releasedState,
            triggerEventKind: "whatsapp_button_reply",
            quickReplyPayload: "wsc:menu:help",
          })
        );
      });

      it("keeps the pick of a tap that releases the removed wait", async () => {
        mockResolveActiveScenarioRuntime.mockResolvedValue({
          runtime: endRuntime("help"),
        });
        // The stored copy of the tapped message, as the send recorded it.
        const findTappedScenarioServiceMessage = jest.fn().mockResolvedValue({
          scenarioId,
          whatsappServiceMessage: {
            version: 1,
            kind: "reply_buttons",
            bodyText: "Choose",
            command: {
              kind: "reply_buttons",
              body: "Choose",
              options: [
                { id: "wsc:menu:help", label: "Help" },
                { id: "wsc:menu:pricing", label: "Pricing" },
              ],
            },
          },
        });

        await replyWhileWaiting({
          ...helpBranch,
          triggerEventKind: SCENARIO_TRIGGER_EVENT_KIND.whatsAppButtonReply,
          quickReplyPayload: "wsc:menu:help",
          dependencies: { findTappedScenarioServiceMessage },
        });

        expectFencedRelease();
        expect(findTappedScenarioServiceMessage).toHaveBeenCalledWith(
          expect.objectContaining({ actionNodeId: "menu" })
        );
        // Completing the scenario cleared its picks; the tap still counts.
        expect(mockResolveActiveScenarioRuntime).toHaveBeenCalledTimes(1);
        expect(
          mockResolveActiveScenarioRuntime.mock.calls[0][0].scenarioState
        ).toEqual({
          ...releasedState,
          pickedOptions: {
            scenarioId,
            picks: [
              {
                sourceActionNodeId: "menu",
                optionId: "wsc:menu:help",
                label: "Help",
                pickedAt: expect.any(String),
              },
            ],
          },
        });
      });

      it("keeps the form of a Flow reply that releases the removed wait", async () => {
        mockResolveActiveScenarioRuntime.mockResolvedValue({
          runtime: endRuntime("help"),
        });
        // The stored copy of the message that sent the form.
        const findSubmittedScenarioForm = jest.fn().mockResolvedValue({
          scenarioId,
          sourceActionNodeId: "menu",
          flowId: null,
          fields: [{ id: "name", label: "Name", fieldType: "TextInput" }],
        });

        await replyWhileWaiting({
          ...helpBranch,
          triggerEventKind: SCENARIO_TRIGGER_EVENT_KIND.whatsAppFlowReply,
          whatsAppFlowResponseJson: JSON.stringify({
            name: "Aya",
            flow_token: "flow-1",
          }),
          dependencies: { findSubmittedScenarioForm },
        });

        expectFencedRelease();
        // Completing the scenario cleared its answers; the form still counts.
        expect(mockResolveActiveScenarioRuntime).toHaveBeenCalledTimes(1);
        expect(
          mockResolveActiveScenarioRuntime.mock.calls[0][0].scenarioState
        ).toEqual({
          ...releasedState,
          formAnswers: {
            scenarioId,
            submissions: [
              {
                sourceActionNodeId: "menu",
                flowId: null,
                inboundMessageId: "message-1",
                submittedAt: expect.any(String),
                fields: [
                  {
                    key: "name",
                    label: "Name",
                    fieldType: "TextInput",
                    value: "Aya",
                  },
                ],
              },
            ],
          },
        });
      });

      it("fails closed when the wait changes before it can be released", async () => {
        mockCompleteLockedScenarioAndPersist.mockResolvedValue({
          state: releasedState,
          persisted: false,
        });

        const body = await replyWhileWaiting({
          nodes: [menuWithNoReply, action("later")],
          edges: [],
          triggerEventKind: SCENARIO_TRIGGER_EVENT_KIND.inboundMessage,
          text: "Hello again",
        });

        expect(body).toEqual({
          status: "ok",
          skipped_stale_pending_wait: true,
        });
        expectFencedRelease();
        expect(mockResolveActiveScenarioRuntime).not.toHaveBeenCalled();
        expect(mockPersistScenarioState).not.toHaveBeenCalled();
        expect(mockSendAndPersistOutbound).not.toHaveBeenCalled();
      });

      it("keeps a removed wait untouched while the graph has blocking diagnostics", async () => {
        const body = await replyWhileWaiting({
          nodes: [
            action("menu", { actionOutcomes: { version: 99 } }),
            action("later"),
          ],
          edges: [],
          triggerEventKind: SCENARIO_TRIGGER_EVENT_KIND.inboundMessage,
          text: "Hello again",
        });

        expect(body).toMatchObject({ status: "ok" });
        expect(mockResolveActiveScenarioRuntime).not.toHaveBeenCalled();
        expectWaitKept();
      });

      describe("a timer turn prepared before the edit", () => {
        const menuOutcomes = {
          version: 1,
          anyReply: { enabled: true },
          noReply,
        };
        const waitingNodes = [
          action("menu", { actionOutcomes: menuOutcomes }),
          action("reply-target"),
          action("later"),
        ];
        const anyReplyEdge = outcomeEdge("menu", "any_reply", "reply-target");

        // Arms and fires the timer against the scenario as it was before the
        // edit, as the conversation workflow does.
        async function prepareTimerTurnBeforeEdit() {
          const scenarioBeforeEdit = {
            _id: scenarioId,
            name: "Waiting scenario",
            nodes: waitingNodes,
            edges: [anyReplyEdge, outcomeEdge("menu", "no_reply", "later")],
            updatedAt: new Date(Date.UTC(2026, 8, 20, 6, 0, 0, ++revision)),
          };
          const releaseFromTimer = jest.fn();
          const timerDependencies: AiriScenarioTimerDependencies = {
            connectDB: async () => undefined,
            loadConversation: async () => ({
              _id: "conversation-1",
              workspaceId: "workspace-1",
              channel: "whatsapp",
              airi_scenario_state: {
                lockedScenarioId: scenarioId,
                lockedScenarioName: "Waiting scenario",
                currentActionNodeId: "menu",
                pendingConditionNodeId: waitNodeId,
                pendingSourceActionNodeId: "menu",
                pendingStartedAt: new Date("2026-09-20T08:00:00.000Z"),
                pendingLastOutboundMessageId: "outbound-1",
              },
            }),
            resolveScenariosEnabled: async () => true,
            loadScenario: async () => scenarioBeforeEdit,
            findLatestMessageAfter: async () => null,
            findTextMessagesAfter: async () => [],
            findPendingOutbound: async () => ({
              delivery: { status: "sent" },
            }),
            buildTimerTurnSignal: async ({ timer, channel, messageId }) => ({
              workspaceId: timer.workspaceId,
              conversationId: timer.conversationId,
              messageId,
              channel,
              triggerEventKind: SCENARIO_TRIGGER_EVENT_KIND.noHumanReplyTimeout,
              scenarioOverrideId: timer.scenarioId,
            }),
            completeLockedScenarioAndPersist: releaseFromTimer,
            generativeAIResult: {} as never,
          };

          const planned = await planAiriConversationTimer(
            {
              turn: {
                workspaceId: "workspace-1",
                conversationId: "conversation-1",
                messageId: "outbound-1",
              },
            },
            timerDependencies
          );
          expect(planned.timer).not.toBeNull();
          const prepared = await buildAiriConversationTimerTurn(
            planned.timer!,
            timerDependencies
          );
          expect(prepared.reason).toBe("timer_turn_ready");
          expect(releaseFromTimer).not.toHaveBeenCalled();
          return prepared.turn!;
        }

        async function processAfterEdit(
          edit: Pick<Parameters<typeof replyWhileWaiting>[0], "nodes" | "edges">
        ) {
          const turn = await prepareTimerTurnBeforeEdit();
          return replyWhileWaiting({
            ...edit,
            triggerEventKind: SCENARIO_TRIGGER_EVENT_KIND.noHumanReplyTimeout,
            text: "",
            turn: {
              messageId: turn.messageId,
              scenarioOverrideId: turn.scenarioOverrideId ?? undefined,
              proactiveTrigger: true,
            },
          });
        }

        function expectNothingDispatched() {
          expect(mockResolveActiveScenarioRuntime).not.toHaveBeenCalled();
          expect(mockPersistScenarioState).not.toHaveBeenCalled();
          expect(mockPersistPendingConditionState).not.toHaveBeenCalled();
          expect(mockSendAndPersistOutbound).not.toHaveBeenCalled();
        }

        it("releases the wait without replaying or restarting the scenario when the wait was removed", async () => {
          const body = await processAfterEdit({
            nodes: waitingNodes,
            edges: [],
          });

          expect(body).toEqual({
            status: "ok",
            released_removed_pending_wait: true,
          });
          expectFencedRelease();
          expectNothingDispatched();
        });

        it("keeps waiting when only the no-reply branch was removed and other outcomes remain", async () => {
          const body = await processAfterEdit({
            nodes: waitingNodes,
            edges: [anyReplyEdge],
          });

          expect(body).toEqual({
            status: "ok",
            skipped_timeout_without_no_reply_branch: true,
          });
          expect(mockCompleteLockedScenarioAndPersist).not.toHaveBeenCalled();
          expectNothingDispatched();
        });

        it("ends a wait left without any outcome, as the timer does", async () => {
          const body = await processAfterEdit({
            nodes: waitingNodes,
            edges: [outcomeEdge("menu", "no_reply", "deleted-node")],
          });

          expect(body).toEqual({
            status: "ok",
            skipped_authoritative_scenario_continuation: true,
          });
          expectFencedRelease();
          expectNothingDispatched();
        });
      });
    });

    describe("delayed CTA follow-ups", () => {
      const kazakh = buildWhatsAppTemplateButtonSourceHandleId(0);
      const russian = buildWhatsAppTemplateButtonSourceHandleId(1);
      const english = buildWhatsAppTemplateButtonSourceHandleId(2);
      const kazakhWaitId = getScenarioActionBranchDelayVirtualNodeId(
        "menu",
        kazakh
      );
      const russianWaitId = getScenarioActionBranchDelayVirtualNodeId(
        "menu",
        russian
      );
      const tap = (buttonIndex: number) =>
        buildWhatsAppTemplateButtonPayload("menu", buttonIndex);
      const quietPeriodMs = 30 * 60_000;
      // The pick_lang menu with a third, undelayed button. Kazakh waits 30
      // minutes unless "Order accepted" appears; Russian waits 90 minutes.
      const delayedGraph = (outcomes: Record<string, unknown> = {}) => ({
        nodes: [
          { id: "trigger", data: { kind: "trigger" } },
          {
            ...templateMenu,
            data: {
              ...templateMenu.data,
              actionWhatsAppTemplateComponents: [
                {
                  type: "BUTTONS",
                  buttons: [
                    { type: "QUICK_REPLY", text: "Kazakh" },
                    { type: "QUICK_REPLY", text: "Russian" },
                    { type: "QUICK_REPLY", text: "English" },
                  ],
                },
              ],
              actionOutcomes: {
                version: 1,
                noReply,
                ...outcomes,
                branchDelays: [
                  {
                    sourceHandle: kazakh,
                    delayMinutes: 30,
                    cancelIfPhrases: ["Order accepted"],
                  },
                  { sourceHandle: russian, delayMinutes: 90 },
                ],
              },
            },
          },
          action("kazakh", {
            actionType: "whatsapp_template",
            actionWhatsAppTemplateName: "pick_lang",
            actionWhatsAppTemplateLanguage: "kk",
          }),
          action("russian"),
          action("english"),
          action("later"),
          action("reply-target"),
        ],
        edges: [
          { source: "trigger", target: "menu" },
          { source: "menu", sourceHandle: kazakh, target: "kazakh" },
          { source: "menu", sourceHandle: russian, target: "russian" },
          { source: "menu", sourceHandle: english, target: "english" },
          ...(outcomes.anyReply
            ? [outcomeEdge("menu", "any_reply", "reply-target")]
            : []),
          outcomeEdge("menu", "no_reply", "later"),
        ],
      });
      const lockedAfterBulkSend = {
        lockedScenarioId: scenarioId,
        lockedScenarioName: "Waiting scenario",
        currentActionNodeId: "menu",
        currentPathNodeIds: ["menu"],
        pendingConditionNodeId: null,
        pendingSourceActionNodeId: null,
        pendingStartedAt: null,
        pendingLastOutboundMessageId: null,
      };
      const delayedWait = (conditionNodeId: string) => ({
        lockedScenarioId: scenarioId,
        lockedScenarioName: "Waiting scenario",
        currentActionNodeId: "menu",
        pendingConditionNodeId: conditionNodeId,
        pendingSourceActionNodeId: "menu",
        pendingStartedAt: new Date("2026-09-20T08:01:00.000Z"),
        pendingLastOutboundMessageId: "outbound-1",
      });
      function mockLatestActionOutbound(outbound: unknown) {
        const lean = jest.fn().mockResolvedValue(outbound);
        const select = jest.fn(() => ({ lean }));
        const sort = jest.fn(() => ({ select }));
        mockMessageFindOne.mockReturnValue({ sort });
        return { sort, select };
      }

      beforeEach(() => {
        mockResolveInteractiveReplyConditionTarget.mockImplementation(
          jest.requireActual<
            typeof import("@/lib/airi/scenario/scenario-interactive-replies")
          >("@/lib/airi/scenario/scenario-interactive-replies")
            .resolveInteractiveReplyConditionTarget
        );
        mockPersistPendingConditionState.mockResolvedValue({});
      });

      it("arms the follow-up on a tap without sending, keeping the wait's anchor", async () => {
        const body = await replyWhileWaiting({
          ...delayedGraph(),
          triggerEventKind: SCENARIO_TRIGGER_EVENT_KIND.whatsAppButtonReply,
          quickReplyPayload: tap(0),
        });

        expect(body).toMatchObject({ status: "ok" });
        expect(mockPersistPendingConditionState).toHaveBeenCalledTimes(1);
        expect(mockPersistPendingConditionState).toHaveBeenCalledWith(
          expect.objectContaining({
            scenarioId,
            sourceActionNodeId: "menu",
            conditionNodeId: kazakhWaitId,
            pendingLastOutboundMessageId: "outbound-1",
            startedAt: new Date("2026-09-20T08:05:00.000Z"),
          })
        );
        expect(mockMessageFindOne).toHaveBeenCalledWith(
          expect.objectContaining({ _id: "outbound-1" })
        );
        expect(mockResolveActiveScenarioRuntime).not.toHaveBeenCalled();
        expect(mockCompleteLockedScenarioAndPersist).not.toHaveBeenCalled();
        expect(mockClearPendingConditionStateAndPersist).not.toHaveBeenCalled();
        expect(mockSendAndPersistOutbound).not.toHaveBeenCalled();
      });

      it("anchors a tap after a bulk send to the action's latest outbound", async () => {
        const lookup = mockLatestActionOutbound({ _id: "campaign-outbound-1" });

        const body = await replyWhileWaiting({
          ...delayedGraph(),
          scenarioState: lockedAfterBulkSend,
          triggerEventKind: SCENARIO_TRIGGER_EVENT_KIND.whatsAppButtonReply,
          quickReplyPayload: tap(0),
        });

        expect(body).toMatchObject({ status: "ok" });
        expect(mockMessageFindOne).toHaveBeenCalledWith({
          workspaceId: "workspace-1",
          conversation: "conversation-1",
          direction: "outbound",
          "origin.scenarioId": scenarioId,
          "origin.nodeId": "menu",
        });
        expect(lookup.sort).toHaveBeenCalledWith({ date: -1 });
        expect(mockPersistPendingConditionState).toHaveBeenCalledWith(
          expect.objectContaining({
            sourceActionNodeId: "menu",
            conditionNodeId: kazakhWaitId,
            pendingLastOutboundMessageId: "campaign-outbound-1",
          })
        );
        expect(mockResolveActiveScenarioRuntime).not.toHaveBeenCalled();
        expect(mockSendAndPersistOutbound).not.toHaveBeenCalled();
      });

      it("does not arm a follow-up it cannot anchor, and sends nothing", async () => {
        const { airiOrchestrationLogger } = jest.requireMock<
          typeof import("@icecore/airi-runtime/logging")
        >("@icecore/airi-runtime/logging");
        mockLatestActionOutbound(null);

        const body = await replyWhileWaiting({
          ...delayedGraph(),
          scenarioState: lockedAfterBulkSend,
          triggerEventKind: SCENARIO_TRIGGER_EVENT_KIND.whatsAppButtonReply,
          quickReplyPayload: tap(0),
        });

        expect(body).toMatchObject({ status: "ok" });
        expect(mockPersistPendingConditionState).not.toHaveBeenCalled();
        expect(mockResolveActiveScenarioRuntime).not.toHaveBeenCalled();
        expect(mockSendAndPersistOutbound).not.toHaveBeenCalled();
        expect(airiOrchestrationLogger.warn).toHaveBeenCalledWith(
          "airi.orchestration",
          expect.objectContaining({
            note: "delayed_cta_follow_up_not_armed",
            reason: "missing_outbound_anchor",
            actionNodeId: "menu",
            conditionNodeId: kazakhWaitId,
          })
        );
      });

      it.each([
        ["a message while a delay without stop phrases waits", russianWaitId],
        ["a stop phrase, which the timer checks when it fires", kazakhWaitId],
      ])(
        "keeps the wait on %s, even though the menu's Any reply is on",
        async (_, conditionNodeId) => {
          const body = await replyWhileWaiting({
            ...delayedGraph({ anyReply: { enabled: true } }),
            scenarioState: delayedWait(conditionNodeId),
            triggerEventKind: SCENARIO_TRIGGER_EVENT_KIND.inboundMessage,
            text: "Order accepted, thanks!",
          });

          expect(body).toMatchObject({ status: "ok" });
          expect(mockResolveActiveScenarioRuntime).not.toHaveBeenCalled();
          expectWaitKept();
        }
      );

      it("re-arms on a tap on another delayed CTA with the same anchor", async () => {
        await replyWhileWaiting({
          ...delayedGraph(),
          scenarioState: delayedWait(kazakhWaitId),
          triggerEventKind: SCENARIO_TRIGGER_EVENT_KIND.whatsAppButtonReply,
          quickReplyPayload: tap(1),
        });

        expect(mockPersistPendingConditionState).toHaveBeenCalledWith(
          expect.objectContaining({
            sourceActionNodeId: "menu",
            conditionNodeId: russianWaitId,
            pendingLastOutboundMessageId: "outbound-1",
            startedAt: new Date("2026-09-20T08:05:00.000Z"),
          })
        );
        expect(mockMessageFindOne).toHaveBeenCalledWith(
          expect.objectContaining({ _id: "outbound-1" })
        );
        expect(mockResolveActiveScenarioRuntime).not.toHaveBeenCalled();
        expect(mockSendAndPersistOutbound).not.toHaveBeenCalled();
      });

      it("routes a tap on a CTA without a delay and replaces the delayed wait", async () => {
        mockResolveActiveScenarioRuntime.mockResolvedValue({
          runtime: endRuntime("english"),
        });

        const body = await replyWhileWaiting({
          ...delayedGraph(),
          scenarioState: delayedWait(kazakhWaitId),
          triggerEventKind: SCENARIO_TRIGGER_EVENT_KIND.whatsAppButtonReply,
          quickReplyPayload: tap(2),
        });

        expect(body).toEqual({ status: "ok", scenario_ended: true });
        expect(mockPersistPendingConditionState).not.toHaveBeenCalled();
        expect(mockResolveActiveScenarioRuntime).toHaveBeenCalledWith(
          expect.objectContaining({
            triggerEventKind: "whatsapp_button_reply",
            quickReplyPayload: tap(2),
          })
        );
        expectWaitReplacedAfterRouting();
      });

      it("taps, waits for quiet and sends the follow-up through the real runtime and timer", async () => {
        const actualState = jest.requireActual<
          typeof import("@/lib/airi/reply/runtime/auto-reply-scenario-state")
        >("@/lib/airi/reply/runtime/auto-reply-scenario-state");
        const { buildAiriConversationTimerTurn, planAiriConversationTimer } =
          await import("@icecore/airi-runtime/temporal-scenario-timers");
        const { default: airiAutoReply } = await import(
          "@icecore/airi-runtime/auto-reply"
        );
        const graph = delayedGraph();
        const scenario = {
          _id: scenarioId,
          name: "Waiting scenario",
          nodes: graph.nodes,
          edges: graph.edges,
          updatedAt: new Date(Date.UTC(2026, 8, 20, 6, 0, 0, ++revision)),
        };
        mockScenarioFindOne.mockReturnValue({
          select: () => ({ lean: async () => scenario }),
        });
        // Real time keeps the rescheduled deadline in the future.
        const tapAt = new Date(Date.now() - 60_000);
        const replyAt = new Date(tapAt.getTime() + 20_000);
        const whatsAppTurn = (
          scenarioState: unknown,
          turn: Partial<Parameters<typeof airiAutoReply>[0]>
        ) =>
          airiAutoReply(
            {
              type: "whatsapp",
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
                airi_bot_enabled: false,
                airi_scenarios_enabled: true,
                airi_scenario_state: scenarioState,
              } as never,
              ...turn,
            } as Parameters<typeof airiAutoReply>[0],
            scenarioRuntimeDependencies
          );

        // 1. The customer taps Kazakh on the bulk-sent menu. Nothing is sent.
        mockLatestActionOutbound({ _id: "campaign-outbound-1" });
        mockConversationUpdateOne.mockReset().mockResolvedValue({
          matchedCount: 1,
        });
        mockPersistPendingConditionState.mockImplementationOnce(
          actualState.persistPendingConditionState
        );
        await whatsAppTurn(lockedAfterBulkSend, {
          triggerEventKind: SCENARIO_TRIGGER_EVENT_KIND.whatsAppButtonReply,
          quickReplyPayload: tap(0),
          newMessage: {
            _id: "message-tap",
            direction: "inbound",
            channel: "whatsapp",
            date: tapAt,
            text: "Kazakh",
          } as never,
        });
        expect(mockConversationUpdateOne).toHaveBeenCalledTimes(1);
        const armedState =
          mockConversationUpdateOne.mock.calls[0][1].$set.airi_scenario_state;
        expect(armedState).toMatchObject({
          lockedScenarioId: scenarioId,
          currentActionNodeId: "menu",
          pendingConditionNodeId: kazakhWaitId,
          pendingSourceActionNodeId: "menu",
          pendingStartedAt: tapAt,
          pendingLastOutboundMessageId: "campaign-outbound-1",
        });
        expect(mockSendAndPersistOutbound).not.toHaveBeenCalled();

        // 2. The workflow plans the quiet period from the tap.
        let latestActivityAt: Date | null = null;
        let textsSinceWait: string[] = [];
        const completeLockedScenario = jest.fn();
        const buildTimerTurnSignal = jest.fn().mockResolvedValue({
          workspaceId: "workspace-1",
          conversationId: "conversation-1",
          messageId: "timer-turn-1",
        });
        const timerHost = {
          connectDB: async () => undefined,
          loadConversation: async () => ({
            _id: "conversation-1",
            workspaceId: "workspace-1",
            channel: "whatsapp",
            sourceId: "source-1",
            airi_scenario_state: armedState,
          }),
          resolveScenariosEnabled: async () => true,
          loadScenario: async () => scenario,
          findLatestMessageAfter: async () =>
            latestActivityAt ? { date: latestActivityAt } : null,
          findTextMessagesAfter: async () =>
            textsSinceWait.map(text => ({ text })),
          findPendingOutbound: async (input: {
            messageId: string;
            sourceActionNodeId: string | null;
          }) =>
            input.messageId === "campaign-outbound-1" &&
            input.sourceActionNodeId === "menu"
              ? { delivery: { status: "read" } }
              : null,
          completeLockedScenarioAndPersist: completeLockedScenario,
          buildTimerTurnSignal,
          generativeAIResult: {} as never,
        };
        const plan = await planAiriConversationTimer(
          {
            turn: {
              workspaceId: "workspace-1",
              conversationId: "conversation-1",
              messageId: "message-tap",
              channel: "whatsapp",
              triggerEventKind: "whatsapp_button_reply",
            } as never,
          },
          timerHost
        );
        expect(plan).toMatchObject({
          reason: "pending_post_action_condition",
          timer: {
            kind: "post_action_no_reply_timeout",
            scenarioId,
            conditionNodeId: kazakhWaitId,
            sourceActionNodeId: "menu",
            waitStartedAt: tapAt.toISOString(),
            pendingLastOutboundMessageId: "campaign-outbound-1",
            dueAt: new Date(tapAt.getTime() + quietPeriodMs).toISOString(),
          },
        });

        // 3. The customer writes during the wait. The wait stays armed.
        await whatsAppTurn(armedState, {
          triggerEventKind: SCENARIO_TRIGGER_EVENT_KIND.inboundMessage,
          newMessage: {
            _id: "message-thanks",
            direction: "inbound",
            channel: "whatsapp",
            date: replyAt,
            text: "Thanks!",
          } as never,
        });
        expect(mockConversationUpdateOne).toHaveBeenCalledTimes(1);
        expect(mockResolveActiveScenarioRuntime).not.toHaveBeenCalled();
        expect(mockSendAndPersistOutbound).not.toHaveBeenCalled();

        // 4. At the first deadline the reply restarts the quiet period.
        latestActivityAt = replyAt;
        textsSinceWait = ["Thanks!"];
        const firstFire = await buildAiriConversationTimerTurn(
          plan.timer!,
          timerHost
        );
        expect(firstFire).toMatchObject({
          turn: null,
          reason: "newer_message_rescheduled",
          timer: {
            conditionNodeId: kazakhWaitId,
            dueAt: new Date(replyAt.getTime() + quietPeriodMs).toISOString(),
          },
        });
        expect(buildTimerTurnSignal).not.toHaveBeenCalled();

        // 5. After a full quiet period the timer prepares the follow-up turn.
        const secondFire = await buildAiriConversationTimerTurn(
          firstFire.timer!,
          timerHost
        );
        const timeoutMessageId = `scenario-timeout:post_action_no_reply_timeout:${scenarioId}:${tapAt.toISOString()}`;
        expect(secondFire).toMatchObject({
          reason: "timer_turn_ready",
          turn: { messageId: "timer-turn-1" },
        });
        expect(buildTimerTurnSignal).toHaveBeenCalledWith(
          expect.objectContaining({
            channel: "whatsapp",
            messageId: timeoutMessageId,
          })
        );
        expect(completeLockedScenario).not.toHaveBeenCalled();

        // 6. The timer turn sends the target of the tapped CTA.
        mockResolveActiveScenarioRuntime.mockResolvedValue({
          runtime: {
            scenarioId,
            scenarioName: "Waiting scenario",
            actionType: "whatsapp_template",
            actionWhatsAppTemplateName: "pick_lang",
            actionWhatsAppTemplateLanguage: "kk",
            selectedActionNodeId: "kazakh",
          },
        });
        mockEvaluateDeliveryGate.mockReturnValue({ allowSend: true });
        mockSendAndPersistOutbound.mockResolvedValue({
          _id: "outbound-kazakh",
          date: new Date(),
        });
        await whatsAppTurn(armedState, {
          scenarioOverrideId: scenarioId,
          proactiveTrigger: true,
          triggerEventKind: SCENARIO_TRIGGER_EVENT_KIND.noHumanReplyTimeout,
          newMessage: {
            _id: timeoutMessageId,
            direction: "inbound",
            channel: "whatsapp",
            date: new Date(),
            text: "",
          } as never,
        });
        expect(mockResolveActiveScenarioRuntime).toHaveBeenCalledTimes(1);
        expect(mockResolveActiveScenarioRuntime).toHaveBeenCalledWith(
          expect.objectContaining({
            forcedScenarioId: scenarioId,
            forcedActionNodeId: "kazakh",
            skipTriggerMatch: true,
            triggerEventKind: "no_human_reply_timeout",
          })
        );
        expect(mockSendAndPersistOutbound).toHaveBeenCalledTimes(1);
        expect(mockSendAndPersistOutbound).toHaveBeenCalledWith(
          expect.objectContaining({
            whatsappTemplate: expect.objectContaining({
              name: "pick_lang",
              languageCode: "kk",
            }),
            scenarioOrigin: expect.objectContaining({
              scenarioId,
              actionNodeId: "kazakh",
            }),
          })
        );
        expect(mockCompleteLockedScenarioAndPersist).not.toHaveBeenCalled();
      });
    });

    describe("timer follow-ups behind an earlier reply outcome", () => {
      const kazakh = buildWhatsAppTemplateButtonSourceHandleId(0);
      const quietPeriodMs = 30 * 60_000;
      const connectDB = () =>
        jest.requireMock<{ default: jest.Mock }>("@/lib/mongoose").default;
      const template = (id: string, name: string) => ({
        id,
        data: {
          kind: "action",
          actionType: "whatsapp_template",
          actionWhatsAppTemplateName: name,
          actionWhatsAppTemplateLanguage: "kk",
        },
      });
      // The welcome message's Any reply leads to the pick_lang menu, which
      // then waits on its own No reply outcome or on a tapped delayed CTA.
      const scenarioBehindAnyReply = () => ({
        _id: scenarioId,
        name: "Waiting scenario",
        updatedAt: new Date(Date.UTC(2026, 8, 21, 6, 0, 0, ++revision)),
        nodes: [
          { id: "trigger", data: { kind: "trigger" } },
          action("welcome", {
            actionOutcomes: { version: 1, anyReply: { enabled: true } },
          }),
          {
            ...templateMenu,
            data: {
              ...templateMenu.data,
              actionOutcomes: {
                version: 1,
                noReply,
                branchDelays: [{ sourceHandle: kazakh, delayMinutes: 30 }],
              },
            },
          },
          template("reminder", "pick_lang_reminder"),
          template("kazakh", "pick_lang_kk"),
        ],
        edges: [
          { source: "trigger", target: "welcome" },
          outcomeEdge("welcome", "any_reply", "menu"),
          outcomeEdge("menu", "no_reply", "reminder"),
          { source: "menu", sourceHandle: kazakh, target: "kazakh" },
        ],
      });
      const waitOn = (conditionNodeId: string) => ({
        lockedScenarioId: scenarioId,
        lockedScenarioName: "Waiting scenario",
        currentActionNodeId: "menu",
        pendingConditionNodeId: conditionNodeId,
        pendingSourceActionNodeId: "menu",
        // The quiet period has already elapsed.
        pendingStartedAt: new Date(Date.now() - quietPeriodMs - 60_000),
        pendingLastOutboundMessageId: "outbound-menu",
      });

      beforeEach(() => {
        connectDB().mockResolvedValue(undefined);
        mockResolveActiveScenarioRuntime.mockImplementation(
          jest.requireActual<
            typeof import("@/lib/airi/scenario/scenario-runtime")
          >("@/lib/airi/scenario/scenario-runtime").resolveActiveScenarioRuntime
        );
        const quickReplies = {
          sort: () => quickReplies,
          limit: () => quickReplies,
          select: () => quickReplies,
          lean: async () => [],
        };
        mockQuickReplyFind.mockReturnValue(quickReplies);
        mockLogScenarioTriggerEvaluations.mockResolvedValue(undefined);
        mockEvaluateDeliveryGate.mockReturnValue({ allowSend: true });
        mockSendAndPersistOutbound.mockResolvedValue({
          _id: "outbound-follow-up",
          date: new Date(),
        });
      });

      afterEach(() => {
        connectDB().mockRejectedValue(new Error("Unexpected database access"));
      });

      /** Plans and fires the wait's timer, then runs the timer turn. */
      async function fireTimerFollowUp(waitState: ReturnType<typeof waitOn>) {
        const scenario = scenarioBehindAnyReply();
        mockScenarioFindOne.mockReturnValue({
          select: () => ({ lean: async () => scenario }),
        });
        const completeWaitFromTimer = jest.fn();
        const buildTimerTurnSignal = jest.fn(
          async (input: { messageId: string }) => ({
            workspaceId: "workspace-1",
            conversationId: "conversation-1",
            messageId: input.messageId,
          })
        );
        const timerHost = {
          connectDB: async () => undefined,
          loadConversation: async () => ({
            _id: "conversation-1",
            workspaceId: "workspace-1",
            channel: "whatsapp",
            sourceId: "source-1",
            airi_scenario_state: waitState,
          }),
          resolveScenariosEnabled: async () => true,
          loadScenario: async () => scenario,
          findLatestMessageAfter: async () => null,
          findTextMessagesAfter: async () => [],
          findPendingOutbound: async (input: {
            messageId: string;
            sourceActionNodeId: string | null;
          }) =>
            input.messageId === "outbound-menu" &&
            input.sourceActionNodeId === "menu"
              ? { delivery: { status: "read" } }
              : null,
          completeLockedScenarioAndPersist: completeWaitFromTimer,
          buildTimerTurnSignal,
          generativeAIResult: {} as never,
        };
        const { buildAiriConversationTimerTurn, planAiriConversationTimer } =
          await import("@icecore/airi-runtime/temporal-scenario-timers");

        const plan = await planAiriConversationTimer(
          {
            turn: {
              workspaceId: "workspace-1",
              conversationId: "conversation-1",
              messageId: "message-1",
              channel: "whatsapp",
            } as never,
          },
          timerHost
        );
        expect(plan.timer).toMatchObject({
          conditionNodeId: waitState.pendingConditionNodeId,
          sourceActionNodeId: "menu",
          dueAt: new Date(
            waitState.pendingStartedAt.getTime() + quietPeriodMs
          ).toISOString(),
        });
        const fired = await buildAiriConversationTimerTurn(
          plan.timer!,
          timerHost
        );
        expect(fired.reason).toBe("timer_turn_ready");
        expect(completeWaitFromTimer).not.toHaveBeenCalled();

        const { default: airiAutoReply } = await import(
          "@icecore/airi-runtime/auto-reply"
        );
        return airiAutoReply(
          {
            type: "whatsapp",
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
              airi_bot_enabled: false,
              airi_scenarios_enabled: true,
              airi_scenario_state: waitState,
            } as never,
            scenarioOverrideId: scenarioId,
            proactiveTrigger: true,
            triggerEventKind: SCENARIO_TRIGGER_EVENT_KIND.noHumanReplyTimeout,
            newMessage: {
              _id: buildTimerTurnSignal.mock.calls[0][0].messageId,
              direction: "inbound",
              channel: "whatsapp",
              date: new Date(),
              text: "",
            } as never,
          },
          scenarioRuntimeDependencies
        );
      }

      function expectFollowUpSent(actionNodeId: string, templateName: string) {
        expect(mockSendAndPersistOutbound).toHaveBeenCalledTimes(1);
        expect(mockSendAndPersistOutbound).toHaveBeenCalledWith(
          expect.objectContaining({
            whatsappTemplate: expect.objectContaining({ name: templateName }),
            scenarioOrigin: expect.objectContaining({
              scenarioId,
              actionNodeId,
            }),
          })
        );
        expect(mockLogScenarioTriggerEvaluations).toHaveBeenCalledWith([
          expect.objectContaining({
            eventKind: "no_human_reply_timeout",
            result: "winner",
            selectedActionNodeId: actionNodeId,
          }),
        ]);
        expect(mockCompleteLockedScenarioAndPersist).not.toHaveBeenCalled();
      }

      it("sends a no-reply outcome's follow-up", async () => {
        await fireTimerFollowUp(
          waitOn(getScenarioActionOutcomeVirtualNodeId("menu"))
        );

        expectFollowUpSent("reminder", "pick_lang_reminder");
      });

      it("sends a delayed CTA's follow-up", async () => {
        await fireTimerFollowUp(
          waitOn(getScenarioActionBranchDelayVirtualNodeId("menu", kazakh))
        );

        expectFollowUpSent("kazakh", "pick_lang_kk");
      });
    });

    describe("answer-match follow-ups", () => {
      const connectDB = () =>
        jest.requireMock<{ default: jest.Mock }>("@/lib/mongoose").default;
      const template = (id: string, name: string) => ({
        id,
        data: {
          kind: "action",
          actionType: "whatsapp_template",
          actionWhatsAppTemplateName: name,
          actionWhatsAppTemplateLanguage: "kk",
        },
      });
      // The pick_lang menu waits on its No reply outcome; a typed "yes"
      // matches its answer rule and continues to the confirmation.
      const answerGraph = {
        nodes: [
          { id: "trigger", data: { kind: "trigger" } },
          {
            ...templateMenu,
            data: {
              ...templateMenu.data,
              actionOutcomes: {
                version: 1,
                noReply,
                answerMatches: [{ id: "yes", mode: "exact", text: "yes" }],
              },
            },
          },
          template("confirmed", "order_confirmed"),
          template("reminder", "pick_lang_reminder"),
        ],
        edges: [
          { source: "trigger", target: "menu" },
          {
            source: "menu",
            sourceHandle: buildScenarioActionOutcomeHandleId({
              type: "answer",
              ruleId: "yes",
            }),
            target: "confirmed",
          },
          outcomeEdge("menu", "no_reply", "reminder"),
        ],
      };

      beforeEach(() => {
        connectDB().mockResolvedValue(undefined);
        mockResolveActiveScenarioRuntime.mockImplementation(
          jest.requireActual<
            typeof import("@/lib/airi/scenario/scenario-runtime")
          >("@/lib/airi/scenario/scenario-runtime").resolveActiveScenarioRuntime
        );
        const quickReplies = {
          sort: () => quickReplies,
          limit: () => quickReplies,
          select: () => quickReplies,
          lean: async () => [],
        };
        mockQuickReplyFind.mockReturnValue(quickReplies);
        mockLogScenarioTriggerEvaluations.mockResolvedValue(undefined);
        mockEvaluateDeliveryGate.mockReturnValue({ allowSend: true });
        mockSendAndPersistOutbound.mockResolvedValue({
          _id: "outbound-confirmed",
          date: new Date(),
        });
      });

      afterEach(() => {
        connectDB().mockRejectedValue(new Error("Unexpected database access"));
      });

      it("sends the follow-up of a typed reply that matches an answer rule", async () => {
        await replyWhileWaiting({
          ...answerGraph,
          triggerEventKind: SCENARIO_TRIGGER_EVENT_KIND.inboundMessage,
          text: "yes",
        });

        expect(mockSendAndPersistOutbound).toHaveBeenCalledTimes(1);
        expect(mockSendAndPersistOutbound).toHaveBeenCalledWith(
          expect.objectContaining({
            whatsappTemplate: expect.objectContaining({
              name: "order_confirmed",
            }),
            scenarioOrigin: expect.objectContaining({
              scenarioId,
              actionNodeId: "confirmed",
            }),
          })
        );
        expect(mockLogScenarioTriggerEvaluations).toHaveBeenCalledWith([
          expect.objectContaining({
            eventKind: "post_action_user_reply",
            result: "winner",
            selectedActionNodeId: "confirmed",
          }),
        ]);
        expect(mockCompleteLockedScenarioAndPersist).not.toHaveBeenCalled();
      });
    });
  });

  describe("AI-mode scenario replies", () => {
    const scenarioId = "65f000000000000000000004";
    const outboundDate = new Date("2026-07-10T10:00:05.000Z");
    const scenarioState = {
      lockedScenarioId: scenarioId,
      lockedScenarioName: "AI outcomes",
      currentActionNodeId: "ai-action",
    };
    const buildAiRuntime = (withPendingWait: boolean) => ({
      scenarioId,
      scenarioName: "AI outcomes",
      actionType: "reply",
      actionReplyMode: "ai",
      selectedActionNodeId: "ai-action",
      selectedPathNodeIds: ["trigger", "ai-action"],
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
      ...(withPendingWait
        ? {
            nextActionNodeId: "ai-action",
            completesScenario: false,
            pendingConditionNodeId:
              getScenarioActionOutcomeVirtualNodeId("ai-action"),
            pendingSourceActionNodeId: "ai-action",
          }
        : { nextActionNodeId: null, completesScenario: true }),
    });
    const runAiReply = async (runtime: ReturnType<typeof buildAiRuntime>) => {
      const newMessage = {
        _id: "message-ai-1",
        direction: "inbound",
        channel: "web_widget",
        date: new Date("2026-07-10T10:00:00.000Z"),
        text: "When are you open?",
      };
      mockStoredConversation(scenarioState);
      mockMessageFindById.mockReturnValue({
        select: () => ({ populate: () => ({ lean: async () => newMessage }) }),
      });
      mockResolveActiveScenarioRuntime.mockResolvedValue({ runtime });
      mockResolveScenarioReplyExecutionDecision.mockReturnValue({
        kind: "ai_context",
      });
      mockRunIntentFastPath.mockResolvedValue({
        threadReplyContext: {},
        customerReplyLanguage: "en",
      });
      mockRunRagReplyFlow.mockResolvedValue({
        ragResult: {
          type: "ai_reply",
          content: "We are open from 9:00 to 18:00.",
        },
        scenarioRuntime: runtime,
        queryText: newMessage.text,
      });
      mockEvaluateDeliveryGate.mockReturnValue({
        allowSend: true,
        reason: null,
        rolloutBucket: 0,
        rolloutPercentage: 100,
      });

      return runWidgetTurn(newMessage);
    };

    it("anchors the pending no-reply wait to the delivered AI reply", async () => {
      mockSendAndPersistOutbound.mockResolvedValue({
        _id: "outbound-ai-1",
        date: outboundDate,
      });
      const runtime = buildAiRuntime(true);

      const response = await runAiReply(runtime);

      expect(await response.json()).toEqual({
        status: "ok",
        reply_outcome: "delivered_or_ready",
      });
      expect(mockPersistScenarioState).toHaveBeenCalledWith(
        expect.objectContaining({
          scenarioRuntime: runtime,
          baseState: scenarioState,
        })
      );
      expect(mockSendAndPersistOutbound).toHaveBeenCalledTimes(1);
      expect(mockSendAndPersistOutbound).toHaveBeenCalledWith(
        expect.objectContaining({
          content: expect.stringContaining("We are open from 9:00 to 18:00."),
          scenarioOrigin: {
            scenarioId,
            scenarioName: "AI outcomes",
            actionNodeId: "ai-action",
          },
        })
      );
      expect(mockCompleteScenarioAfterDispatch).toHaveBeenCalledTimes(1);
      expect(mockCompleteScenarioAfterDispatch).toHaveBeenCalledWith({
        conversationId: "conversation-1",
        scenarioRuntime: runtime,
        baseState: scenarioState,
        completionTimestamp: outboundDate,
        lastMessageId: "outbound-ai-1",
      });
      expect(
        mockSendAndPersistOutbound.mock.invocationCallOrder[0]
      ).toBeLessThan(
        mockCompleteScenarioAfterDispatch.mock.invocationCallOrder[0]
      );
      expect(mockCompleteLockedScenarioAndPersist).not.toHaveBeenCalled();
    });

    it("keeps the delivered AI reply when anchoring its wait fails", async () => {
      const { airiOrchestrationLogger } = jest.requireMock<
        typeof import("@icecore/airi-runtime/logging")
      >("@icecore/airi-runtime/logging");
      mockSendAndPersistOutbound.mockResolvedValue({
        _id: "outbound-ai-1",
        date: outboundDate,
      });
      mockCompleteScenarioAfterDispatch.mockRejectedValue(
        new Error("pending wait write failed")
      );

      const response = await runAiReply(buildAiRuntime(true));

      expect(await response.json()).toEqual({
        status: "ok",
        reply_outcome: "delivered_or_ready",
      });
      expect(airiOrchestrationLogger.warn).toHaveBeenCalledWith(
        "airi.orchestration",
        expect.objectContaining({
          note: "complete_scenario_after_ai_reply_failed",
          conversationId: "conversation-1",
          scenarioId,
          errorMessage: "pending wait write failed",
        })
      );
    });

    it("captures the anchor as a post-delivery effect of the reserved Temporal outbound", async () => {
      const temporalOutbound = await import(
        "@/lib/airi/reply/delivery/temporal-outbound"
      );
      mockSendAndPersistOutbound.mockImplementation(
        async (context: { content?: string }) => {
          const capture = temporalOutbound.reserveTemporalOutboundDispatch({
            context: { content: context.content },
          });
          return {
            _id: capture.placeholderMessageId,
            date: capture.placeholderDate,
          };
        }
      );

      const prepared = await temporalOutbound.runWithTemporalOutboundCapture({
        workspaceId: "workspace-1",
        conversationId: "conversation-1",
        messageId: "message-ai-1",
        capturePostDeliveryEffects: true,
        run: () => runAiReply(buildAiRuntime(true)),
      });

      const delivery = prepared.pendingDelivery;
      if (!delivery) throw new Error("Expected a reserved AI reply delivery");
      expect(mockCompleteScenarioAfterDispatch).not.toHaveBeenCalled();
      const anchorEffects = prepared.postDeliveryEffects.filter(
        effect => effect.kind === "complete_scenario_after_dispatch"
      );
      expect(anchorEffects).toEqual([
        {
          kind: "complete_scenario_after_dispatch",
          payload: expect.objectContaining({
            conversationId: "conversation-1",
            lastMessageId: delivery.reservedMessageId,
          }),
        },
      ]);

      await temporalOutbound.applyTemporalPostDeliveryEffects({
        delivery: {
          deliveryKey: delivery.deliveryKey,
          outboundMessageId: delivery.reservedMessageId,
          outboundDate: "2026-07-10T10:00:07.000Z",
          classification: "sent",
        },
        effects: anchorEffects,
      });

      expect(mockCompleteScenarioAfterDispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          conversationId: "conversation-1",
          scenarioRuntime: expect.objectContaining({
            pendingConditionNodeId:
              getScenarioActionOutcomeVirtualNodeId("ai-action"),
            pendingSourceActionNodeId: "ai-action",
          }),
          completionTimestamp: "2026-07-10T10:00:07.000Z",
          lastMessageId: delivery.reservedMessageId,
        })
      );
    });

    it("does not run post-delivery completion for an AI reply without a pending wait", async () => {
      mockSendAndPersistOutbound.mockResolvedValue({
        _id: "outbound-ai-1",
        date: outboundDate,
      });

      const response = await runAiReply(buildAiRuntime(false));

      expect(await response.json()).toEqual({
        status: "ok",
        reply_outcome: "delivered_or_ready",
      });
      expect(mockSendAndPersistOutbound).toHaveBeenCalledTimes(1);
      expect(mockCompleteScenarioAfterDispatch).not.toHaveBeenCalled();
      expect(mockCompleteLockedScenarioAndPersist).not.toHaveBeenCalled();
    });
  });

  describe("template sends that open a Flow", () => {
    const scenarioId = "65f000000000000000000005";
    const flowId = "2244981489363579";
    // Saved as a number, as the production medal_pick_1 template stores it.
    const medalButton = {
      type: "FLOW",
      text: "Choose",
      flow_id: 2244981489363579,
    };
    const templateWithButtons = (buttons: Record<string, unknown>[]) => [
      { type: "BODY", text: "Choose your medal" },
      { type: "BUTTONS", buttons },
    ];
    // The reply sends completion keys; the screen's sport list is not one.
    const storedFields = [
      {
        id: "__9ba1c9",
        label: "Choose a sport",
        helperText: "Design and name",
        screenTitle: null,
        options: [
          {
            id: "1_Таэквондо_/_Каратэ_/_Күрес",
            title: "Taekwondo, karate, wrestling",
          },
        ],
        fieldType: "Dropdown",
      },
      {
        id: "day",
        label: "Day",
        helperText: null,
        screenTitle: null,
        options: null,
        fieldType: "DatePicker",
      },
    ];
    const sendMedalTemplate = async (
      runtime: Record<string, unknown>,
      turn: {
        messageId?: string;
        scenarioState?: Record<string, unknown>;
        dependencies?: typeof scenarioRuntimeDependencies;
      } = {}
    ) => {
      const conversation = {
        _id: "conversation-1",
        sourceId: "source-1",
        airi_bot_enabled: true,
        airi_scenarios_enabled: true,
        ...(turn.scenarioState
          ? { airi_scenario_state: turn.scenarioState }
          : {}),
      };
      mockConversationFindById.mockReturnValue({
        select: () => ({ lean: async () => conversation }),
      });
      mockResolveActiveScenarioRuntime.mockResolvedValue({
        runtime: {
          scenarioId,
          scenarioName: "Medal order",
          actionType: "whatsapp_template",
          actionWhatsAppTemplateName: "medal_pick_1",
          actionWhatsAppTemplateLanguage: "kk",
          actionWhatsAppTemplateComponents: templateWithButtons([medalButton]),
          actionFlowConfig: {
            templateId: "",
            ctaText: "Choose",
            flowNavigationMode: "static_graph",
            metaFlowId: flowId,
            screens: [
              {
                id: "QUESTION_ONE",
                title: "Choose a sport",
                fields: [
                  {
                    id: "sport_list",
                    label: "Sport",
                    fieldType: "NavigationList",
                  },
                ],
              },
            ],
          },
          selectedActionNodeId: "medal-pick",
          ...runtime,
        },
      });
      mockEvaluateDeliveryGate.mockReturnValue({ allowSend: true });
      mockSendAndPersistOutbound.mockResolvedValue({
        _id: "outbound-medal",
        date: new Date(),
      });
      const { default: airiAutoReply } = await import(
        "@icecore/airi-runtime/auto-reply"
      );
      const response = await airiAutoReply(
        {
          type: "whatsapp",
          triggerEventKind: "inbound_message",
          suppressGeneralAutoReply: true,
          runtimeHydrated: true,
          workspaceId: "workspace-1",
          conversation: conversation as never,
          newMessage: {
            _id: turn.messageId ?? "message-medal",
            direction: "inbound",
            channel: "whatsapp",
            date: new Date(),
            text: "Medal",
          } as never,
          chatDocument: { _id: "chat-1", sourceId: "source-1" } as never,
          whatsAppInfo: {
            phoneNumberId: "phone-1",
            contactData: { waId: "77000000000" },
          } as never,
        },
        turn.dependencies ?? scenarioRuntimeDependencies
      );
      expect(await response.json()).toMatchObject({ status: "ok" });
      expect(mockSendAndPersistOutbound).toHaveBeenCalledTimes(1);
      return mockSendAndPersistOutbound.mock.calls[0]?.[0] as {
        whatsappFlowCta?: Record<string, unknown>;
        whatsappTemplate?: { components?: Record<string, unknown>[] };
      };
    };
    // The flow_token each FLOW button of the sent template carries.
    const sentFlowTokens = (
      sent: Awaited<ReturnType<typeof sendMedalTemplate>>
    ) =>
      (sent.whatsappTemplate?.components ?? [])
        .filter(component => component.sub_type === "flow")
        .map(
          component =>
            (
              component.parameters as {
                action?: { flow_token?: string };
              }[]
            )[0]?.action?.flow_token
        );

    it("stores the form fields the runtime read, keyed as the reply sends them", async () => {
      const sent = await sendMedalTemplate({
        actionFormResponseFields: { flowId, fields: storedFields },
      });

      expect(sent.whatsappFlowCta).toEqual(
        expect.objectContaining({
          flowId,
          responseFieldMetadata: storedFields,
          scenarioId,
          actionNodeId: "medal-pick",
        })
      );
      expect(sentFlowTokens(sent)).toEqual([sent.whatsappFlowCta?.flowToken]);
    });

    it("captures template-owned header media and the outbound source for delivery refresh", async () => {
      const sent = await sendMedalTemplate({});
      expect(sent.whatsappTemplate).toEqual(
        expect.objectContaining({ headerMediaSource: "template" })
      );
      expect(mockResolveTemplateLanguage).toHaveBeenCalledWith(
        expect.objectContaining({ sourceId: "source-1" })
      );
    });

    it("stores no fields when the runtime read none, not the Flow's screen fields", async () => {
      const sent = await sendMedalTemplate({});

      expect(sent.whatsappFlowCta).toEqual(
        expect.objectContaining({ flowId, responseFieldMetadata: null })
      );
    });

    it("records the Flow and the token a FLOW button sends when the step links none", async () => {
      const sent = await sendMedalTemplate({ actionFlowConfig: undefined });

      // No source binding: the Flow is the template's, not the step's. The
      // label is the button's, which titles the reply.
      expect(sent.whatsappFlowCta).toEqual({
        flowId,
        flowToken: expect.stringMatching(/^flow_\d+_[a-z0-9]{1,10}$/),
        flowCta: "Choose",
        responseFieldMetadata: null,
        scenarioId,
        scenarioName: "Medal order",
        actionNodeId: "medal-pick",
      });
      // The reply carries the token the send records.
      expect(sentFlowTokens(sent)).toEqual([sent.whatsappFlowCta?.flowToken]);
    });

    it("labels the button's Flow generically when the FLOW button has no text", async () => {
      const sent = await sendMedalTemplate({
        actionFlowConfig: undefined,
        actionWhatsAppTemplateComponents: templateWithButtons([
          { ...medalButton, text: "  " },
        ]),
      });

      expect(sent.whatsappFlowCta).toEqual(
        expect.objectContaining({ flowId, flowCta: "Open flow" })
      );
    });

    it("records the button's Flow without the step's source when the step's own Flow cannot be sent", async () => {
      const sent = await sendMedalTemplate({
        actionFlowConfig: {
          templateId: "",
          ctaText: "Choose",
          flowNavigationMode: "data_endpoint",
          screens: [
            { id: "DETAILS", title: "Details", fields: [] },
            { id: "CONFIRM", title: "Confirm", fields: [] },
          ],
          managedProvisioning: {
            operationId: "operation-1",
            sourceId: "source-1",
            wabaId: "waba-1",
            contentRevision: 1,
            contentDigest: "digest-1",
            flowId,
            providerStatus: "DEPRECATED",
          },
        },
      });

      expect(sent.whatsappFlowCta).toEqual(
        expect.objectContaining({
          flowId,
          flowToken: expect.stringMatching(/^flow_\d+_[a-z0-9]{1,10}$/),
        })
      );
      expect(sent.whatsappFlowCta).not.toHaveProperty("managedSourceId");
      expect(sentFlowTokens(sent)).toEqual([sent.whatsappFlowCta?.flowToken]);
    });

    it.each([
      ["read from it", flowId, storedFields],
      ["read from another Flow", "1571793974235171", null],
      ["read from an unknown Flow", null, null],
    ])(
      "stores a saved form's fields only when read from the button's Flow: %s",
      async (_case, formFlowId, expected) => {
        const sent = await sendMedalTemplate({
          actionFlowConfig: undefined,
          actionFormResponseFields: {
            flowId: formFlowId,
            fields: storedFields,
          },
        });

        expect(sent.whatsappFlowCta).toEqual(
          expect.objectContaining({ flowId, responseFieldMetadata: expected })
        );
      }
    );

    it.each([
      ["no FLOW button", [{ type: "QUICK_REPLY", text: "Yes" }]],
      [
        "two FLOW buttons",
        [medalButton, { ...medalButton, flow_id: "1571793974235171" }],
      ],
    ])("records no Flow for a template with %s", async (_case, buttons) => {
      const sent = await sendMedalTemplate({
        actionFlowConfig: undefined,
        actionWhatsAppTemplateComponents: templateWithButtons(buttons),
      });

      expect(sent.whatsappFlowCta).toBeUndefined();
    });

    it.each([
      [
        "a customer behaviour",
        "customer-behavior:65f000000000000000000b01",
        undefined,
      ],
      [
        "a behaviour run's timer",
        "scenario-timeout:post_action_no_reply_timeout:65f000000000000000000005:2026-10-04T00:00:00.000Z",
        { behaviorRunId: "65f000000000000000000b01" },
      ],
    ])(
      "records no Flow for a template sent by %s",
      async (_case, messageId, scenarioState) => {
        const loadBehaviorTemplateValues = jest.fn().mockResolvedValue({});

        const sent = await sendMedalTemplate(
          { actionFlowConfig: undefined },
          {
            messageId,
            scenarioState,
            dependencies: {
              ...scenarioRuntimeDependencies,
              loadBehaviorTemplateValues,
            },
          }
        );

        // Behaviour runs send through a transport that refuses any Flow.
        expect(loadBehaviorTemplateValues).toHaveBeenCalledTimes(1);
        expect(sent.whatsappFlowCta).toBeUndefined();
      }
    );
  });
});
