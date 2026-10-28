import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { CompanyRuntimeCapacityDeferredError } from "@icecore/shared/lib/company-runtime-capacity";
import { extractWhatsAppWamidFingerprint } from "@icecore/shared/lib/whatsapp/message-id";
import type { WhatsAppWebhookBody } from "@icecore/shared/lib/whatsapp/webhook-payload";
import {
  shouldQueueWhatsAppAiriIngress,
  shouldSuppressGeneralWhatsAppAiriReply,
} from "@icecore/shared/lib/whatsapp/webhook-automation-eligibility";

import {
  processWhatsAppWebhookPayload,
  serializeWhatsAppRealtimeMessage,
} from "./whatsapp-webhook-runtime";
import { airiWorkerLogger } from "./logging";
import {
  WHATSAPP_INTAKE_PLAN_LOCKED_MESSAGE,
  buildWhatsAppPlanSkippedProcessResult,
  createWhatsAppIntakePlanGate,
  resolveWhatsAppIntakePlanSkip,
  resolveWhatsAppNewConversationPlanSkip,
} from "./whatsapp-intake-plan-gate";

const CommonJsCapacityDeferredError = createRequire(import.meta.url)(
  "@icecore/shared/lib/company-runtime-capacity",
)
  .CompanyRuntimeCapacityDeferredError as typeof CompanyRuntimeCapacityDeferredError;

class FakeObjectId {
  constructor(private readonly value: string) {}

  toString() {
    return this.value;
  }
}

type RuntimeDeps = Parameters<typeof processWhatsAppWebhookPayload>[0];

test("status recovery receives only trusted event verification, never payload claims", async () => {
  for (const verified of [undefined, false, true]) {
    const body = {
      ...buildInboundWebhookBody(),
      providerSignatureVerified: true,
    };
    let observed: unknown;
    const deps = createRuntimeDeps({
      tryHandleWhatsAppStatusWebhook: async (params) => {
        observed = params.providerSignatureVerified;
        return new Response(JSON.stringify({ status: "ok" }));
      },
    });
    const result = await processWhatsAppWebhookPayload(deps, {
      body,
      providerSignatureVerified: verified,
    });
    assert.equal(result.ok, true);
    assert.equal(observed, verified === true);
  }
});

function buildInboundWebhookBody(
  message: Record<string, unknown> = {},
): WhatsAppWebhookBody {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "waba_1",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: {
                phone_number_id: "phone_1",
                display_phone_number: "+15550000000",
              },
              contacts: [
                {
                  wa_id: "15551111111",
                  profile: { name: "Customer" },
                },
              ],
              messages: [
                {
                  from: "15551111111",
                  id: "wamid.replay_1",
                  timestamp: "1783160000",
                  type: "text",
                  text: { body: "historical message" },
                  ...message,
                },
              ],
            },
          },
        ],
      },
    ],
  } satisfies WhatsAppWebhookBody;
}

function createRuntimeDeps(overrides: Partial<RuntimeDeps> = {}): RuntimeDeps {
  return {
    Chat: {
      findById: async () => null,
    },
    Conversation: {
      findById: async () => null,
    },
    Message: {
      findById: async () => null,
      findOne: async () => null,
    },
    User: {},
    buildGroundedReplyOptionPayload: () => null,
    buildWhatsAppMessageRawSourcePayload: () => ({ payload: {} }),
    buildWhatsAppWebhookSourceSkipPayload: () => ({ status: "ok" }),
    decryptString: () => "access-token",
    directIngressAiriConversation: async () => ({
      workflowId: "airi-workflow",
    }),
    enqueueReferralEnrichment: async () => undefined,
    enqueueMessageRealtime: async (input) => {
      await overrides.realtime?.trigger(
        `private-conversation-${input.conversationId}`,
        input.recoveryRevision ? "message-updated" : "new-message",
        {
          ...input.message,
          ...(input.recoveryRevision
            ? { messageId: String(input.message._id) }
            : {}),
        },
      );
    },
    extractWhatsAppIdentifiersFromWebhookValue: () => ({}),
    findExistingWhatsAppMessageByExternalId: async () => null,
    getWhatsAppLogIdentity: () => "15551111111",
    getWhatsAppPrimaryIdentifier: () => "15551111111",
    getWhatsAppWebhookSourceSkip: () => null,
    getWhatsAppIntakePlanSkip: async () => null,
    handleAccountUpdateWebhook: async () =>
      new Response(JSON.stringify({ status: "ok" })),
    handleUserChangedNumber: async () => ({
      migrated: false,
      chatIds: [],
      userIds: [],
    }),
    handleUserChangedUserId: async () => ({
      migrated: false,
      chatIds: [],
      userIds: [],
    }),
    invalidateRequestsForWorkspace: async () => undefined,
    isWhatsAppAiriRuntimeEnabled: () => true,
    normalizeWhatsAppWebhookContact: () => ({
      waId: "15551111111",
      userId: null,
      parentUserId: null,
      primaryIdType: "wa_id",
      profile: { name: "Customer" },
    }),
    parseWhatsAppLlmFeedbackPayload: () => null,
    parseWhatsAppTimestamp: (timestamp: string) =>
      new Date(Number(timestamp) * 1000),
    processWhatsAppMessage: async () => ({
      message: {
        _id: new FakeObjectId("message_1"),
        conversation: new FakeObjectId("conversation_1"),
        direction: "inbound",
        text: "historical message",
      },
      conversationId: "conversation_1",
      isNewConversation: false,
      messageWasNew: true,
      reopenedConversation: false,
      userId: "user_1",
      chatId: "chat_1",
    }),
    realtime: {
      trigger: async () => undefined,
    },
    resolveWhatsAppConversationAutomationEnabled: () => true,
    resolveWhatsAppDisplayPhoneNumber: () => "+15550000000",
    resolveWhatsAppInteractiveReplyTriggerEventKind: () => null,
    resolveWhatsAppMessageContext: () => ({
      direction: "inbound",
      contactData: {
        waId: "15551111111",
        userId: null,
        parentUserId: null,
        primaryIdType: "wa_id",
        profile: { name: "Customer" },
      },
    }),
    resolveWhatsAppSourceByAccountIdentifiers: async () => ({
      id: "source_1",
      workspace_id: "workspace_1",
      credentials: { access_token: "encrypted" },
    }),
    enqueueWhatsAppLlmFeedbackReasonPrompt: async () => undefined,
    shouldProcessEvenIfDuplicate: () => false,
    shouldQueueWhatsAppAiriIngress: () => true,
    shouldSuppressGeneralWhatsAppAiriReply: () => false,
    supabaseAdmin: {},
    trackScenarioFlowSubmitted: async () => undefined,
    upsertWhatsAppLlmFeedbackReviewItem: async () => undefined,
    triggerConversationRealtime: async () => undefined,
    triggerConversationReopened: async () => undefined,
    triggerWhatsAppReactionRealtimeUpdate: async () => undefined,
    tryHandleWhatsAppCallWebhook: async () => null,
    tryHandleWhatsAppContactSyncWebhook: async () => null,
    tryHandleWhatsAppEchoWebhook: async () => null,
    tryHandleWhatsAppGroupWebhook: async () => null,
    tryHandleWhatsAppHistoryWebhook: async () => null,
    tryHandleWhatsAppLifecycleWebhook: async () => null,
    tryHandleWhatsAppStatusWebhook: async () => null,
    tryHandleWhatsAppUserPreferencesWebhook: async () => null,
    ...overrides,
  };
}

const EXISTING_CLASSIFICATION = {
  category: "Support",
  priority: "high",
  sentiment: "negative",
  summary: "Customer returned on WhatsApp",
  action: "Escalate to support",
  tags: ["whatsapp", "returning"],
  confidence: {
    category: 0.95,
    priority: 0.88,
    sentiment: 0.83,
  },
};

test("queues a Meta 131060 first contact immediately with general AI suppressed", async () => {
  const body = buildInboundWebhookBody({
    type: "unsupported",
    text: undefined,
    unsupported: { type: "unknown" },
    errors: [
      {
        code: 131060,
        title: "This message is unavailable.",
        message: "This message is unavailable.",
      },
    ],
  });
  const ingressPayloads: Record<string, unknown>[] = [];
  const deps = createRuntimeDeps({
    Conversation: {
      findById: async () => ({
        _id: new FakeObjectId("conversation_1"),
        chat: "chat_1",
      }),
    },
    Chat: { findById: async () => ({ _id: new FakeObjectId("chat_1") }) },
    shouldQueueWhatsAppAiriIngress,
    shouldSuppressGeneralWhatsAppAiriReply,
    directIngressAiriConversation: async (payload) => {
      ingressPayloads.push(payload);
      return { workflowId: "airi-workflow" };
    },
  });

  const result = await processWhatsAppWebhookPayload(deps, { body });

  assert.equal(result.ok, true);
  assert.equal(ingressPayloads.length, 1);
  assert.equal(ingressPayloads[0].suppressGeneralAutoReply, true);
  assert.equal(ingressPayloads[0].whatsappMessageContentUnavailable, true);
  assert.equal(ingressPayloads[0].quickReplyPayload, null);
});

test("does not start welcome automation for other unsupported events or replay", async () => {
  for (const fixture of [
    { code: 131051, subtype: "unknown", replay: false },
    { code: 131060, subtype: "edit", replay: false },
    { code: 131060, subtype: "unknown", replay: true },
  ]) {
    const body = buildInboundWebhookBody({
      type: "unsupported",
      text: undefined,
      unsupported: { type: fixture.subtype },
      errors: [
        { code: fixture.code, title: "Unavailable", message: "Unavailable" },
      ],
    });
    let ingressCalls = 0;
    const deps = createRuntimeDeps({
      Conversation: {
        findById: async () => ({ _id: "conversation_1", chat: "chat_1" }),
      },
      Chat: { findById: async () => ({ _id: "chat_1" }) },
      shouldQueueWhatsAppAiriIngress,
      shouldSuppressGeneralWhatsAppAiriReply,
      directIngressAiriConversation: async () => {
        ingressCalls += 1;
        return { workflowId: "airi-workflow" };
      },
    });
    const result = await processWhatsAppWebhookPayload(deps, {
      body,
      suppressAiriIngress: fixture.replay,
    });
    assert.equal(result.ok, true);
    assert.equal(ingressCalls, 0);
  }
});

function buildCurrentReopenedConversation() {
  return {
    _id: new FakeObjectId("conversation_1"),
    status: "open",
    createdAt: new Date("2026-08-10T17:00:00.000Z"),
    is_classified: true,
    classification_revision: 24,
    classification_state: {
      contractVersion: 2,
      status: "ready",
      requestedRevision: 24,
      appliedRevision: 24,
    },
    classification_meta: {
      provenance_kind: "v2",
      source_revision: 24,
      analysis_revision_id: "analysis-24",
    },
    classification: {
      ...EXISTING_CLASSIFICATION,
      tags: [...EXISTING_CLASSIFICATION.tags],
      confidence: { ...EXISTING_CLASSIFICATION.confidence },
    },
  };
}

const NON_CURRENT_CLASSIFICATION_CASES: ReadonlyArray<{
  name: string;
  mutate: (
    conversation: ReturnType<typeof buildCurrentReopenedConversation>,
  ) => void;
}> = [
  {
    name: "pending",
    mutate: (conversation) => {
      conversation.is_classified = false;
      conversation.classification_state.status = "pending";
    },
  },
  {
    name: "review-required",
    mutate: (conversation) => {
      conversation.is_classified = false;
      conversation.classification_state.status = "review_required";
    },
  },
  {
    name: "failed",
    mutate: (conversation) => {
      conversation.is_classified = false;
      conversation.classification_state.status = "failed";
    },
  },
  {
    name: "blocked",
    mutate: (conversation) => {
      conversation.is_classified = false;
      conversation.classification_state.status = "blocked";
    },
  },
  {
    name: "legacy",
    mutate: (conversation) => {
      conversation.classification_meta.provenance_kind = "legacy_unknown";
    },
  },
  {
    name: "revision mismatch",
    mutate: (conversation) => {
      conversation.classification_state.appliedRevision = 23;
    },
  },
  {
    name: "blank analysis id",
    mutate: (conversation) => {
      conversation.classification_meta.analysis_revision_id = " ";
    },
  },
  {
    name: "partial root",
    mutate: (conversation) => {
      delete (conversation as Partial<typeof conversation>).classification_meta;
    },
  },
];

async function runReopenedConversation(
  conversation: ReturnType<typeof buildCurrentReopenedConversation>,
  triggerResult: Promise<unknown> = Promise.resolve(undefined),
) {
  let reopenedPayload: Record<string, unknown> | undefined;
  const deps = createRuntimeDeps({
    isWhatsAppAiriRuntimeEnabled: () => false,
    processWhatsAppMessage: async () => ({
      message: {
        _id: new FakeObjectId("message_1"),
        conversation: new FakeObjectId("conversation_1"),
        direction: "inbound",
        text: "historical message",
      },
      conversation,
      conversationId: "conversation_1",
      isNewConversation: false,
      messageWasNew: true,
      reopenedConversation: true,
      userId: "user_1",
      chatId: "chat_1",
    }),
    triggerConversationReopened: async (_workspaceId, payload) => {
      reopenedPayload = payload as Record<string, unknown>;
      return triggerResult;
    },
  });
  const body = buildInboundWebhookBody();

  const result = await processWhatsAppWebhookPayload(deps, {
    body,
    rawBody: JSON.stringify(body),
    suppressAiriIngress: true,
    suppressRealtime: true,
  });

  assert.equal(result.ok, true);
  assert.ok(reopenedPayload);
  return reopenedPayload;
}

test("keeps the complete classification and payload for an exact current-ready WhatsApp reopen", async () => {
  const payload = await runReopenedConversation(
    buildCurrentReopenedConversation(),
  );
  const { updated_at: updatedAt, ...stablePayload } = payload;

  assert.equal(typeof updatedAt, "string");
  assert.deepEqual(stablePayload, {
    conversation_id: "conversation_1",
    status: "open",
    previous_status: "closed",
    channel: "whatsapp",
    customer_phone: "15551111111",
    classification: EXISTING_CLASSIFICATION,
    created_at: "2026-08-10T17:00:00.000Z",
  });
});

for (const classificationCase of NON_CURRENT_CLASSIFICATION_CASES) {
  test(`omits the classification own property for a ${classificationCase.name} WhatsApp reopen root`, async () => {
    const conversation = buildCurrentReopenedConversation();
    classificationCase.mutate(conversation);

    const payload = await runReopenedConversation(conversation);
    const { updated_at: updatedAt, ...stablePayload } = payload;

    assert.equal(typeof updatedAt, "string");
    assert.deepEqual(stablePayload, {
      conversation_id: "conversation_1",
      status: "open",
      previous_status: "closed",
      channel: "whatsapp",
      customer_phone: "15551111111",
      created_at: "2026-08-10T17:00:00.000Z",
    });
    assert.equal(Object.hasOwn(payload, "classification"), false);
  });
}

test("does not await the best-effort WhatsApp reopened webhook", async () => {
  await runReopenedConversation(
    buildCurrentReopenedConversation(),
    new Promise<never>(() => undefined),
  );
});

test("serializes saved WhatsApp inbound messages for realtime without a populate query", () => {
  const message = {
    toObject() {
      return {
        _id: new FakeObjectId("message_1"),
        chat: new FakeObjectId("chat_1"),
        conversation: new FakeObjectId("conversation_1"),
        author: new FakeObjectId("customer_1"),
        direction: "inbound",
        text: "hello",
      };
    },
  };

  assert.deepEqual(serializeWhatsAppRealtimeMessage(message), {
    _id: "message_1",
    chat: "chat_1",
    conversation: "conversation_1",
    author: { _id: "customer_1" },
    direction: "inbound",
    text: "hello",
  });
});

test("preserves populated author metadata when it is already present", () => {
  const payload = serializeWhatsAppRealtimeMessage({
    _id: new FakeObjectId("message_2"),
    author: {
      _id: new FakeObjectId("manager_1"),
      firstName: "Sam",
      isBot: false,
    },
    direction: "outbound",
    text: "sent",
  });

  assert.deepEqual(payload, {
    _id: "message_2",
    author: {
      _id: "manager_1",
      firstName: "Sam",
      isBot: false,
    },
    direction: "outbound",
    text: "sent",
  });
});

test("normalizes Meta's official nfm_reply response JSON for persistence and submission analytics", async () => {
  const responseJson = JSON.stringify({
    flow_token: "flow-token-1",
    customer_name: "Ada",
  });
  const body = buildInboundWebhookBody({
    type: "interactive",
    // Meta cites the message that sent the Flow; answers are attributed by it.
    context: { from: "15550000000", id: "wamid.flow_request_1" },
    interactive: {
      type: "nfm_reply",
      nfm_reply: {
        name: "flow",
        body: "Sent",
        response_json: responseJson,
      },
    },
  });
  const submissions: Array<Record<string, unknown>> = [];
  let normalizedForPersistence: unknown;
  let citedContext: unknown;
  const deps = createRuntimeDeps({
    Chat: {
      findById: async () => ({
        _id: new FakeObjectId("chat_1"),
        sourceId: "source_1",
      }),
    },
    Conversation: {
      findById: async () => ({
        _id: new FakeObjectId("conversation_1"),
        chat: new FakeObjectId("chat_1"),
        sourceId: "source_1",
        airi_bot_enabled: true,
        airi_scenarios_enabled: false,
      }),
    },
    trackScenarioFlowSubmitted: async (params) => {
      submissions.push(params);
    },
  });
  const persistMessage = deps.processWhatsAppMessage;
  deps.processWhatsAppMessage = async (params) => {
    normalizedForPersistence = params.normalizedWhatsAppFlowReply;
    citedContext = params.messageData.context;
    return persistMessage(params);
  };

  const result = await processWhatsAppWebhookPayload(deps, {
    body,
    rawBody: JSON.stringify(body),
  });

  assert.equal(result.ok, true);
  assert.deepEqual(normalizedForPersistence, {
    flowName: "flow",
    flowToken: "flow-token-1",
    body: "Sent",
    responseJson,
  });
  // The processor gets Meta's context as sent. It stores context.id as the
  // reply target (whatsappMeta.replyToWhatsAppMessageId, the same for every
  // message type), which form capture then reads.
  assert.deepEqual(citedContext, {
    from: "15550000000",
    id: "wamid.flow_request_1",
  });
  assert.equal(submissions.length, 1);
  assert.equal(submissions[0]?.flowToken, "flow-token-1");
  assert.equal(submissions[0]?.outboundMessageId, "wamid.flow_request_1");
  assert.equal(submissions[0]?.responseJson, responseJson);
});

test("suppresses Airi ingress during webhook replay without disabling message persistence", async () => {
  let directIngressCalls = 0;
  let processedMessage = false;
  const realtimeEvents: Array<{ channel: string; event: string }> = [];

  const body = buildInboundWebhookBody();
  const deps = createRuntimeDeps({
    Chat: {
      findById() {
        throw new Error(
          "Chat should not be loaded when replay suppresses Airi",
        );
      },
    },
    Conversation: {
      findById() {
        throw new Error(
          "Conversation should not be loaded for Airi when replay suppresses Airi",
        );
      },
    },
    Message: {
      findById() {
        throw new Error("Message lookup should not be needed");
      },
      findOne: async () => null,
    },
    User: {},
    buildGroundedReplyOptionPayload: () => null,
    buildWhatsAppMessageRawSourcePayload: () => ({ payload: {} }),
    buildWhatsAppWebhookSourceSkipPayload: () => ({ status: "ok" }),
    decryptString: () => "access-token",
    directIngressAiriConversation: async () => {
      directIngressCalls += 1;
      return { workflowId: "airi-workflow" };
    },
    extractWhatsAppIdentifiersFromWebhookValue: () => ({}),
    findExistingWhatsAppMessageByExternalId: async () => null,
    getWhatsAppLogIdentity: () => "15551111111",
    getWhatsAppPrimaryIdentifier: () => "15551111111",
    getWhatsAppWebhookSourceSkip: () => null,
    handleAccountUpdateWebhook: async () =>
      new Response(JSON.stringify({ status: "ok" })),
    handleUserChangedNumber: async () => ({
      migrated: false,
      chatIds: [],
      userIds: [],
    }),
    handleUserChangedUserId: async () => ({
      migrated: false,
      chatIds: [],
      userIds: [],
    }),
    invalidateRequestsForWorkspace: async () => undefined,
    isWhatsAppAiriRuntimeEnabled: () => true,
    normalizeWhatsAppWebhookContact: () => ({
      waId: "15551111111",
      userId: null,
      parentUserId: null,
      primaryIdType: "wa_id",
      profile: { name: "Customer" },
    }),
    parseWhatsAppLlmFeedbackPayload: () => null,
    parseWhatsAppTimestamp: (timestamp: string) =>
      new Date(Number(timestamp) * 1000),
    processWhatsAppMessage: async () => {
      processedMessage = true;
      return {
        message: {
          _id: new FakeObjectId("message_1"),
          conversation: new FakeObjectId("conversation_1"),
          direction: "inbound",
          text: "historical message",
        },
        conversationId: "conversation_1",
        isNewConversation: false,
        messageWasNew: true,
        reopenedConversation: false,
        userId: "user_1",
        chatId: "chat_1",
      };
    },
    realtime: {
      trigger: async (channel: string, event: string) => {
        realtimeEvents.push({ channel, event });
      },
    },
    resolveWhatsAppConversationAutomationEnabled: () => true,
    resolveWhatsAppDisplayPhoneNumber: () => "+15550000000",
    resolveWhatsAppInteractiveReplyTriggerEventKind: () => null,
    resolveWhatsAppMessageContext: () => ({
      direction: "inbound",
      contactData: {
        waId: "15551111111",
        userId: null,
        parentUserId: null,
        primaryIdType: "wa_id",
        profile: { name: "Customer" },
      },
    }),
    resolveWhatsAppSourceByAccountIdentifiers: async () => ({
      id: "source_1",
      workspace_id: "workspace_1",
      credentials: { access_token: "encrypted" },
    }),
    enqueueWhatsAppLlmFeedbackReasonPrompt: async () => undefined,
    shouldProcessEvenIfDuplicate: () => false,
    shouldQueueWhatsAppAiriIngress: () => true,
    shouldSuppressGeneralWhatsAppAiriReply: () => false,
    supabaseAdmin: {},
    trackScenarioFlowSubmitted: async () => undefined,
    upsertWhatsAppLlmFeedbackReviewItem: async () => undefined,
    triggerConversationRealtime: async () => undefined,
    triggerConversationReopened: async () => undefined,
    triggerWhatsAppReactionRealtimeUpdate: async () => undefined,
    tryHandleWhatsAppCallWebhook: async () => null,
    tryHandleWhatsAppContactSyncWebhook: async () => null,
    tryHandleWhatsAppEchoWebhook: async () => null,
    tryHandleWhatsAppGroupWebhook: async () => null,
    tryHandleWhatsAppHistoryWebhook: async () => null,
    tryHandleWhatsAppLifecycleWebhook: async () => null,
    tryHandleWhatsAppStatusWebhook: async () => null,
    tryHandleWhatsAppUserPreferencesWebhook: async () => null,
  });

  const result = await processWhatsAppWebhookPayload(deps, {
    body,
    rawBody: JSON.stringify(body),
    suppressAiriIngress: true,
  });

  assert.equal(result.ok, true);
  assert.equal(processedMessage, true);
  assert.equal(directIngressCalls, 0);
  assert.deepEqual(realtimeEvents, [
    { channel: "private-conversation-conversation_1", event: "new-message" },
    { channel: "tenant-workspace_1", event: "requests.update" },
  ]);
});

test("reuses persisted conversation and chat snapshots for Airi ingress", async () => {
  const body = buildInboundWebhookBody({ text: { body: "hello" } });
  const conversation = {
    _id: new FakeObjectId("conversation_1"),
    chat: new FakeObjectId("chat_1"),
    sourceId: "source_1",
    airi_bot_enabled: true,
    airi_scenarios_enabled: false,
  };
  const chat = {
    _id: new FakeObjectId("chat_1"),
    sourceId: "source_1",
  };
  const ingressPayloads: Record<string, unknown>[] = [];

  const deps = createRuntimeDeps({
    decryptString() {
      throw new Error("ordinary inbound processing must not decrypt a token");
    },
    Conversation: {
      findById() {
        throw new Error("conversation must be reused from persistence");
      },
    },
    Chat: {
      findById() {
        throw new Error("chat must be reused from persistence");
      },
    },
    processWhatsAppMessage: async () => ({
      message: {
        _id: new FakeObjectId("message_1"),
        conversation: new FakeObjectId("conversation_1"),
        direction: "inbound",
        text: "hello",
      },
      conversationId: "conversation_1",
      isNewConversation: false,
      messageWasNew: true,
      reopenedConversation: false,
      userId: "user_1",
      chatId: "chat_1",
      conversation,
      chat,
    }),
    directIngressAiriConversation: async (payload) => {
      ingressPayloads.push(payload as Record<string, unknown>);
      return { workflowId: "airi-workflow" };
    },
  });

  const result = await processWhatsAppWebhookPayload(deps, {
    body,
    rawBody: JSON.stringify(body),
  });

  assert.equal(result.ok, true);
  assert.equal(ingressPayloads[0]?.conversation, conversation);
  assert.equal(ingressPayloads[0]?.chatDocument, chat);
  assert.deepEqual(ingressPayloads[0]?.whatsAppInfo, {
    phoneNumberId: "phone_1",
    contactData: {
      waId: "15551111111",
      userId: null,
      parentUserId: null,
      primaryIdType: "wa_id",
      profile: { name: "Customer" },
    },
  });
});

for (const automationEnabled of [true, false]) {
  test(`publishes recovered content even when automation is ${automationEnabled}`, async () => {
    const base = createRuntimeDeps();
    const revision = "a".repeat(64);
    const events: Array<{ event: string; payload: any }> = [];
    const turns: any[] = [];
    const deps = createRuntimeDeps({
      isWhatsAppAiriRuntimeEnabled: () => automationEnabled,
      processWhatsAppMessage: async () => ({
        ...(await base.processWhatsAppMessage({})),
        messageWasNew: false,
        messageRecoveryRevision: revision,
        conversation: {
          _id: "conversation_1",
          chat: "chat_1",
          sourceId: "source_1",
        },
        chat: { _id: "chat_1", sourceId: "source_1" },
      }),
      realtime: {
        trigger: async (_channel, event, payload) => {
          events.push({ event, payload });
        },
      },
      directIngressAiriConversation: async (payload) => {
        turns.push(payload);
        return { workflowId: "airi-workflow" };
      },
    });
    const result = await processWhatsAppWebhookPayload(deps, {
      body: buildInboundWebhookBody(),
    });
    assert.equal(result.ok, true);
    assert.equal(turns.length, automationEnabled ? 1 : 0);
    if (automationEnabled)
      assert.equal(turns[0].messageRecoveryRevision, revision);
    assert.equal(
      events.some((item) => item.event === "new-message"),
      false,
    );
    const update = events.find((item) => item.event === "message-updated");
    assert.equal(update?.payload.messageId, "message_1");
    assert.equal(update?.payload.text, "historical message");
  });
}

for (const mediaType of [undefined, "audio", "video"] as const) {
  test(`a late unavailable duplicate retains canonical ${mediaType || "text"} recovery admission`, async () => {
    const revision = "c".repeat(64);
    const turns: any[] = [];
    const base = createRuntimeDeps();
    const deps = createRuntimeDeps({
      shouldQueueWhatsAppAiriIngress,
      shouldSuppressGeneralWhatsAppAiriReply,
      processWhatsAppMessage: async () => ({
        ...(await base.processWhatsAppMessage({})),
        messageWasNew: false,
        messageRecoveryRevision: revision,
        mediaAnalysisType: mediaType,
        message: {
          _id: new FakeObjectId("message_1"),
          direction: "inbound",
          text: mediaType ? "" : "Recovered content",
          mediaType,
          whatsappRecoveryRevision: revision,
        },
        conversation: {
          _id: "conversation_1",
          chat: "chat_1",
          sourceId: "source_1",
        },
        chat: { _id: "chat_1", sourceId: "source_1" },
      }),
      directIngressAiriConversation: async (params) => {
        turns.push(params);
        return { workflowId: "airi-workflow" };
      },
    });
    const result = await processWhatsAppWebhookPayload(deps, {
      body: buildInboundWebhookBody({
        type: "unsupported",
        text: undefined,
        unsupported: { type: "unknown" },
        errors: [{ code: 131060 }],
      }),
    });
    assert.equal(result.ok, true);
    assert.equal(turns.length, 1);
    assert.equal(turns[0].messageRecoveryRevision, revision);
    assert.equal(turns[0].whatsappMessageContentUnavailable, undefined);
  });
}

test("a late unavailable duplicate cannot claim the readable delivery's original Airi turn", async () => {
  const turns: any[] = [];
  const events: string[] = [];
  const base = createRuntimeDeps();
  const deps = createRuntimeDeps({
    shouldQueueWhatsAppAiriIngress,
    shouldSuppressGeneralWhatsAppAiriReply,
    processWhatsAppMessage: async () => ({
      ...(await base.processWhatsAppMessage({})),
      messageWasNew: false,
      message: {
        _id: new FakeObjectId("message_1"),
        direction: "inbound",
        text: "The usable delivery arrived first",
        rawSourcePayload: {
          provider: "whatsapp",
          eventType: "message",
          payload: {
            message: {
              type: "text",
              text: { body: "The usable delivery arrived first" },
            },
          },
        },
      },
      conversation: {
        _id: "conversation_1",
        chat: "chat_1",
        sourceId: "source_1",
      },
      chat: { _id: "chat_1", sourceId: "source_1" },
    }),
    directIngressAiriConversation: async (params) => {
      turns.push(params);
      return { workflowId: "airi-workflow" };
    },
    realtime: {
      trigger: async (_channel, event) => {
        events.push(event);
      },
    },
  });
  const unavailable = await processWhatsAppWebhookPayload(deps, {
    body: buildInboundWebhookBody({
      type: "unsupported",
      text: undefined,
      unsupported: { type: "unknown" },
      errors: [{ code: 131060 }],
    }),
  });
  assert.equal(unavailable.ok, true);
  assert.equal(turns.length, 0);
  assert.deepEqual(events, ["new-message"]);

  const richRetry = await processWhatsAppWebhookPayload(deps, {
    body: buildInboundWebhookBody({
      type: "text",
      text: { body: "The usable delivery arrived first" },
    }),
  });
  assert.equal(richRetry.ok, true);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].suppressGeneralAutoReply, false);
});

/** Equality, `$in` and `$or`: the operators the context lookup uses. */
function matchesMongoFilter(
  document: Record<string, unknown>,
  filter: Record<string, unknown>,
): boolean {
  return Object.entries(filter).every(([key, condition]) => {
    if (key === "$or") {
      return (condition as Record<string, unknown>[]).some((branch) =>
        matchesMongoFilter(document, branch),
      );
    }
    if (condition && typeof condition === "object" && "$in" in condition) {
      return (condition.$in as unknown[]).includes(document[key]);
    }
    return document[key] === condition;
  });
}

test("resolves a grounded quick reply when Meta cites the BSUID twin of the stored outbound message", async () => {
  // The same message as stored (phone form) and as cited by Meta (BSUID form).
  const phoneWamid =
    "ws_wamid.HBgLNzc3NzM4NTk4MzAVAgASGBQyQTVGMkMxQUE0NzI3NTQzRjgzQQA=";
  const bsuidWamid =
    "wamid.HBgTS1ouMTY5MjA3NDMzNTMzNzM3OBUUABIYFDJBNUYyQzFBQTQ3Mjc1NDNGODNBAA==";
  const storedOutbound = {
    conversation: "conversation_1",
    channel: "whatsapp",
    direction: "outbound",
    messageId: phoneWamid,
    whatsappWamidFingerprint: extractWhatsAppWamidFingerprint(phoneWamid),
    groundedReplyOptions: {
      options: [{ id: "offer-1", callbackKey: "offer-1", label: "Starter" }],
    },
  };
  const body = buildInboundWebhookBody({
    id: "wamid.grounded_tap",
    type: "interactive",
    interactive: {
      type: "button_reply",
      button_reply: { id: "offer-1", title: "Starter" },
    },
    context: { id: bsuidWamid },
  });
  const conversation = {
    _id: new FakeObjectId("conversation_1"),
    chat: new FakeObjectId("chat_1"),
    sourceId: "source_1",
    airi_bot_enabled: true,
    airi_scenarios_enabled: true,
  };
  const chat = { _id: new FakeObjectId("chat_1"), sourceId: "source_1" };
  const ingressPayloads: Record<string, unknown>[] = [];
  const deps = createRuntimeDeps({
    Message: {
      findById: async () => null,
      findOne: (filter: Record<string, unknown>) => ({
        select: () => ({
          lean: async () =>
            matchesMongoFilter(storedOutbound, filter) ? storedOutbound : null,
        }),
      }),
    },
    buildGroundedReplyOptionPayload: (option) =>
      option ? `grounded:${String(option.id)}` : null,
    processWhatsAppMessage: async () => ({
      message: {
        _id: new FakeObjectId("message_tap"),
        conversation: new FakeObjectId("conversation_1"),
        direction: "inbound",
        text: "Starter",
      },
      conversationId: "conversation_1",
      isNewConversation: false,
      messageWasNew: true,
      reopenedConversation: false,
      userId: "user_1",
      chatId: "chat_1",
      conversation,
      chat,
    }),
    directIngressAiriConversation: async (payload) => {
      ingressPayloads.push(payload as Record<string, unknown>);
      return { workflowId: "airi-workflow" };
    },
  });

  const result = await processWhatsAppWebhookPayload(deps, {
    body,
    rawBody: JSON.stringify(body),
  });

  assert.equal(result.ok, true);
  assert.equal(ingressPayloads.length, 1);
  assert.equal(ingressPayloads[0]?.quickReplyPayload, "grounded:offer-1");
});

test("queues a negative-feedback reason prompt without decrypting a Meta token", async () => {
  const body = buildInboundWebhookBody({
    type: "button",
    button: { payload: "airi-feedback:not-helpful" },
    context: { id: "wamid.airi_reply" },
  });
  const conversation = {
    _id: new FakeObjectId("conversation_1"),
    chat: new FakeObjectId("chat_1"),
    sourceId: "source_1",
    airi_bot_enabled: true,
    airi_scenarios_enabled: false,
  };
  const chat = {
    _id: new FakeObjectId("chat_1"),
    sourceId: "source_1",
  };
  let decryptCalls = 0;
  let queuedPrompt: Record<string, unknown> | null = null;
  let ingressCalls = 0;

  const deps = createRuntimeDeps({
    decryptString(value) {
      assert.equal(value, "encrypted");
      decryptCalls += 1;
      return "access-token";
    },
    parseWhatsAppLlmFeedbackPayload: () => ({
      kind: "helpfulness",
      helpful: false,
      sourceMessageId: "wamid.airi_reply",
    }),
    resolveWhatsAppMessageContext: () => ({
      direction: "inbound",
      contactData: {
        waId: null,
        userId: "106715167761417",
        parentUserId: null,
        primaryIdType: "user_id",
        profile: { name: "Customer" },
      },
    }),
    processWhatsAppMessage: async () => ({
      message: {
        _id: new FakeObjectId("message_1"),
        conversation: new FakeObjectId("conversation_1"),
        direction: "inbound",
        text: "Not helpful",
      },
      conversationId: "conversation_1",
      isNewConversation: false,
      messageWasNew: true,
      reopenedConversation: false,
      userId: "user_1",
      chatId: "chat_1",
      conversation,
      chat,
    }),
    enqueueWhatsAppLlmFeedbackReasonPrompt: async (params) => {
      queuedPrompt = params;
    },
    directIngressAiriConversation: async () => {
      ingressCalls += 1;
      return { workflowId: "airi-workflow" };
    },
  });

  const result = await processWhatsAppWebhookPayload(deps, {
    body,
    rawBody: JSON.stringify(body),
  });

  assert.equal(result.ok, true);
  assert.equal(decryptCalls, 0);
  assert.deepEqual(queuedPrompt, {
    workspaceId: "workspace_1",
    conversationId: "conversation_1",
    sourceId: "source_1",
    recipient: { kind: "bsuid", value: "106715167761417" },
    sourceMessageId: "wamid.airi_reply",
  });
  assert.equal(ingressCalls, 0);
});

test("waits for Temporal to accept Airi ingress before acknowledging the webhook", async () => {
  const body = buildInboundWebhookBody({ text: { body: "hello" } });
  const conversation = {
    _id: new FakeObjectId("conversation_1"),
    chat: new FakeObjectId("chat_1"),
    sourceId: "source_1",
    airi_bot_enabled: true,
    airi_scenarios_enabled: false,
  };
  const chat = {
    _id: new FakeObjectId("chat_1"),
    sourceId: "source_1",
  };
  let acceptIngress!: (value: { workflowId: string }) => void;
  const ingressAccepted = new Promise<{ workflowId: string }>((resolve) => {
    acceptIngress = resolve;
  });
  const deps = createRuntimeDeps({
    processWhatsAppMessage: async () => ({
      message: {
        _id: new FakeObjectId("message_1"),
        conversation: new FakeObjectId("conversation_1"),
        direction: "inbound",
        text: "hello",
      },
      conversationId: "conversation_1",
      isNewConversation: false,
      messageWasNew: true,
      reopenedConversation: false,
      userId: "user_1",
      chatId: "chat_1",
      conversation,
      chat,
    }),
    directIngressAiriConversation: async () => ingressAccepted,
  });

  let settled = false;
  const processing = processWhatsAppWebhookPayload(deps, {
    body,
    rawBody: JSON.stringify(body),
  }).then((result) => {
    settled = true;
    return result;
  });

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false);

  acceptIngress({ workflowId: "airi-workflow" });
  const result = await processing;
  assert.equal(result.ok, true);
});

for (const [loader, CapacityDeferredError] of [
  ["ESM", CompanyRuntimeCapacityDeferredError],
  ["CJS", CommonJsCapacityDeferredError],
] as const) {
  for (const reason of ["limited", "unavailable"] as const) {
    test(`preserves ${loader} ${reason} capacity deferral from Airi ingress`, async () => {
      const retryAt = Date.parse("2026-10-10T16:00:00.000Z");
      const deferred = new CapacityDeferredError(reason, retryAt);
      let ingressCalls = 0;
      const deps = createRuntimeDeps({
        Conversation: {
          findById: async () => ({ _id: "conversation_1", chat: "chat_1" }),
        },
        Chat: { findById: async () => ({ _id: "chat_1" }) },
        directIngressAiriConversation: async () => {
          ingressCalls += 1;
          throw deferred;
        },
      });

      await assert.rejects(
        processWhatsAppWebhookPayload(deps, {
          body: buildInboundWebhookBody(),
        }),
        (error) => {
          assert.equal(error, deferred);
          assert.equal(deferred.reason, reason);
          assert.equal(deferred.retryAt, retryAt);
          return true;
        },
      );
      assert.equal(ingressCalls, 1);
    });
  }
}

test("does not treat an ordinary error with capacity text as a deferral", async () => {
  const error = new Error(
    "Company processing capacity unavailable; received work remains queued",
  );
  error.name = "CompanyRuntimeCapacityDeferredError";
  const deps = createRuntimeDeps({
    Conversation: {
      findById: async () => ({ _id: "conversation_1", chat: "chat_1" }),
    },
    Chat: { findById: async () => ({ _id: "chat_1" }) },
    directIngressAiriConversation: async () => {
      throw error;
    },
  });

  const result = await processWhatsAppWebhookPayload(deps, {
    body: buildInboundWebhookBody(),
  });

  assert.equal(result.ok, false);
  assert.equal(result.retryable, true);
  assert.equal(result.code, "Server error");
  assert.equal(result.message, error.message);
});

test("returns a retryable failure when Temporal rejects Airi ingress", async () => {
  const body = buildInboundWebhookBody({ text: { body: "hello" } });
  const conversation = {
    _id: new FakeObjectId("conversation_1"),
    chat: new FakeObjectId("chat_1"),
    sourceId: "source_1",
    airi_bot_enabled: true,
    airi_scenarios_enabled: false,
  };
  const chat = {
    _id: new FakeObjectId("chat_1"),
    sourceId: "source_1",
  };
  const deps = createRuntimeDeps({
    processWhatsAppMessage: async () => ({
      message: {
        _id: new FakeObjectId("message_1"),
        conversation: new FakeObjectId("conversation_1"),
        direction: "inbound",
        text: "hello",
      },
      conversationId: "conversation_1",
      isNewConversation: false,
      messageWasNew: true,
      reopenedConversation: false,
      userId: "user_1",
      chatId: "chat_1",
      conversation,
      chat,
    }),
    directIngressAiriConversation: async () => {
      throw new Error("Temporal unavailable");
    },
  });

  const result = await processWhatsAppWebhookPayload(deps, {
    body,
    rawBody: JSON.stringify(body),
  });

  assert.equal(result.ok, false);
  assert.equal(result.retryable, true);
  assert.match(result.message || "", /Temporal unavailable/);
});

test("persists WhatsApp LLM feedback once before acknowledging and prompting for a reason", async () => {
  const body = buildInboundWebhookBody({
    id: "wamid.feedback_click",
    type: "interactive",
    interactive: {
      type: "button_reply",
      button_reply: {
        id: "llmfb:v1:helpfulness:not_helpful:wamid.answer_1",
        title: "Not helpful",
      },
    },
    context: { id: "wamid.feedback_prompt_1" },
  });
  const conversation = {
    _id: new FakeObjectId("conversation_1"),
    chat: new FakeObjectId("chat_1"),
    sourceId: "source_1",
    airi_bot_enabled: true,
    airi_scenarios_enabled: false,
  };
  const chat = {
    _id: new FakeObjectId("chat_1"),
    sourceId: "source_1",
  };
  let persistenceAccepted!: () => void;
  const persistence = new Promise<void>((resolve) => {
    persistenceAccepted = resolve;
  });
  let persistenceCalls = 0;
  let reasonPromptCalls = 0;
  const deps = createRuntimeDeps({
    Message: {
      findById: async () => null,
      findOne: () => ({
        select: () => ({
          lean: async () => null,
        }),
      }),
    },
    parseWhatsAppLlmFeedbackPayload: () => ({
      kind: "helpfulness",
      helpful: false,
      sourceMessageId: "wamid.answer_1",
    }),
    processWhatsAppMessage: async () => ({
      message: {
        _id: new FakeObjectId("message_feedback_click"),
        conversation: new FakeObjectId("conversation_1"),
        direction: "inbound",
        text: "Not helpful",
      },
      conversationId: "conversation_1",
      isNewConversation: false,
      messageWasNew: true,
      reopenedConversation: false,
      userId: "user_1",
      chatId: "chat_1",
      conversation,
      chat,
    }),
    upsertWhatsAppLlmFeedbackReviewItem: async () => {
      persistenceCalls += 1;
      await persistence;
      return { inserted: true };
    },
    enqueueWhatsAppLlmFeedbackReasonPrompt: async () => {
      reasonPromptCalls += 1;
    },
  });

  let settled = false;
  const processing = processWhatsAppWebhookPayload(deps, {
    body,
    rawBody: JSON.stringify(body),
  }).then((result) => {
    settled = true;
    return result;
  });

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  assert.equal(persistenceCalls, 1);
  assert.equal(reasonPromptCalls, 0);

  persistenceAccepted();
  const result = await processing;
  assert.equal(result.ok, true);
  assert.equal(persistenceCalls, 1);
  assert.equal(reasonPromptCalls, 1);
});

test("returns a retryable failure when WhatsApp LLM feedback persistence fails", async () => {
  const body = buildInboundWebhookBody({
    id: "wamid.feedback_click",
    type: "interactive",
    interactive: {
      type: "button_reply",
      button_reply: {
        id: "llmfb:v1:helpfulness:not_helpful:wamid.answer_1",
        title: "Not helpful",
      },
    },
    context: { id: "wamid.feedback_prompt_1" },
  });
  const conversation = {
    _id: new FakeObjectId("conversation_1"),
    chat: new FakeObjectId("chat_1"),
    sourceId: "source_1",
    airi_bot_enabled: true,
    airi_scenarios_enabled: false,
  };
  const chat = {
    _id: new FakeObjectId("chat_1"),
    sourceId: "source_1",
  };
  const deps = createRuntimeDeps({
    Message: {
      findById: async () => null,
      findOne: () => ({
        select: () => ({
          lean: async () => null,
        }),
      }),
    },
    parseWhatsAppLlmFeedbackPayload: () => ({
      kind: "helpfulness",
      helpful: false,
      sourceMessageId: "wamid.answer_1",
    }),
    processWhatsAppMessage: async () => ({
      message: {
        _id: new FakeObjectId("message_feedback_click"),
        conversation: new FakeObjectId("conversation_1"),
        direction: "inbound",
        text: "Not helpful",
      },
      conversationId: "conversation_1",
      isNewConversation: false,
      messageWasNew: true,
      reopenedConversation: false,
      userId: "user_1",
      chatId: "chat_1",
      conversation,
      chat,
    }),
    upsertWhatsAppLlmFeedbackReviewItem: async () => {
      throw new Error("Mongo persistence failed");
    },
  });

  const result = await processWhatsAppWebhookPayload(deps, {
    body,
    rawBody: JSON.stringify(body),
  });

  assert.equal(result.ok, false);
  assert.equal(result.retryable, true);
  assert.match(result.message || "", /Mongo persistence failed/);
});

test("persists WhatsApp LLM feedback when the Airi runtime is disabled", async () => {
  const body = buildInboundWebhookBody({
    id: "wamid.feedback_runtime_disabled",
    type: "interactive",
    interactive: {
      type: "button_reply",
      button_reply: {
        id: "llmfb:v1:helpfulness:helpful:wamid.answer_1",
        title: "Helpful",
      },
    },
    context: { id: "wamid.feedback_prompt_1" },
  });
  let persistenceCalls = 0;
  const deps = createRuntimeDeps({
    isWhatsAppAiriRuntimeEnabled: () => false,
    parseWhatsAppLlmFeedbackPayload: () => ({
      kind: "helpfulness",
      helpful: true,
      sourceMessageId: "wamid.answer_1",
    }),
    processWhatsAppMessage: async () => ({
      message: {
        _id: new FakeObjectId("message_feedback_runtime_disabled"),
        conversation: new FakeObjectId("conversation_1"),
        direction: "inbound",
        text: "Helpful",
      },
      conversationId: "conversation_1",
      isNewConversation: false,
      messageWasNew: true,
      reopenedConversation: false,
      userId: "user_1",
      chatId: "chat_1",
      conversation: null,
      chat: null,
    }),
    upsertWhatsAppLlmFeedbackReviewItem: async () => {
      persistenceCalls += 1;
      return { inserted: true };
    },
  });

  const result = await processWhatsAppWebhookPayload(deps, {
    body,
    rawBody: JSON.stringify(body),
  });

  assert.equal(result.ok, true);
  assert.equal(persistenceCalls, 1);
});

test("persists WhatsApp LLM feedback when conversation automation is disabled", async () => {
  const body = buildInboundWebhookBody({
    id: "wamid.feedback_automation_disabled",
    type: "interactive",
    interactive: {
      type: "button_reply",
      button_reply: {
        id: "llmfb:v1:helpfulness:helpful:wamid.answer_1",
        title: "Helpful",
      },
    },
    context: { id: "wamid.feedback_prompt_1" },
  });
  let persistenceCalls = 0;
  let automationResolutionCalls = 0;
  const conversation = {
    _id: new FakeObjectId("conversation_1"),
    chat: new FakeObjectId("chat_1"),
    sourceId: "source_1",
    airi_bot_enabled: false,
    airi_scenarios_enabled: false,
  };
  const deps = createRuntimeDeps({
    isWhatsAppAiriRuntimeEnabled: () => true,
    parseWhatsAppLlmFeedbackPayload: () => ({
      kind: "helpfulness",
      helpful: true,
      sourceMessageId: "wamid.answer_1",
    }),
    processWhatsAppMessage: async () => ({
      message: {
        _id: new FakeObjectId("message_feedback_automation_disabled"),
        conversation: new FakeObjectId("conversation_1"),
        direction: "inbound",
        text: "Helpful",
      },
      conversationId: "conversation_1",
      isNewConversation: false,
      messageWasNew: true,
      reopenedConversation: false,
      userId: "user_1",
      chatId: "chat_1",
      conversation,
      chat: null,
    }),
    resolveWhatsAppConversationAutomationEnabled: (candidate) => {
      assert.equal(candidate, conversation);
      automationResolutionCalls += 1;
      return false;
    },
    upsertWhatsAppLlmFeedbackReviewItem: async () => {
      persistenceCalls += 1;
      return { inserted: true };
    },
  });

  const result = await processWhatsAppWebhookPayload(deps, {
    body,
    rawBody: JSON.stringify(body),
  });

  assert.equal(result.ok, true);
  assert.equal(automationResolutionCalls, 1);
  assert.equal(persistenceCalls, 1);
});

test("re-enqueues provider feedback retries but suppresses operational replay messaging", async () => {
  const body = buildInboundWebhookBody({
    id: "wamid.feedback_replay",
    type: "interactive",
    interactive: {
      type: "button_reply",
      button_reply: {
        id: "llmfb:v1:helpfulness:not_helpful:wamid.answer_1",
        title: "Not helpful",
      },
    },
    context: { id: "wamid.feedback_prompt_1" },
  });
  let persistenceCalls = 0;
  let reasonPromptCalls = 0;
  const deps = createRuntimeDeps({
    isWhatsAppAiriRuntimeEnabled: () => false,
    parseWhatsAppLlmFeedbackPayload: () => ({
      kind: "helpfulness",
      helpful: false,
      sourceMessageId: "wamid.answer_1",
    }),
    processWhatsAppMessage: async () => ({
      message: {
        _id: new FakeObjectId("message_feedback_replay"),
        conversation: new FakeObjectId("conversation_1"),
        direction: "inbound",
        text: "Not helpful",
      },
      conversationId: "conversation_1",
      isNewConversation: false,
      messageWasNew: false,
      reopenedConversation: false,
      userId: "user_1",
      chatId: "chat_1",
      conversation: null,
      chat: null,
    }),
    upsertWhatsAppLlmFeedbackReviewItem: async () => {
      persistenceCalls += 1;
      return { inserted: false };
    },
    enqueueWhatsAppLlmFeedbackReasonPrompt: async () => {
      reasonPromptCalls += 1;
    },
  });

  const result = await processWhatsAppWebhookPayload(deps, {
    body,
    rawBody: JSON.stringify(body),
  });

  const replayResult = await processWhatsAppWebhookPayload(deps, {
    body,
    rawBody: JSON.stringify(body),
    suppressAiriIngress: true,
  });

  assert.equal(result.ok, true);
  assert.equal(replayResult.ok, true);
  assert.equal(persistenceCalls, 2);
  assert.equal(reasonPromptCalls, 1);
});
test("retries Airi ingress for a persisted inbound duplicate", async () => {
  const body = buildInboundWebhookBody({ text: { body: "hello" } });
  const conversation = {
    _id: new FakeObjectId("conversation_1"),
    chat: new FakeObjectId("chat_1"),
    sourceId: "source_1",
    airi_bot_enabled: true,
    airi_scenarios_enabled: false,
  };
  const chat = {
    _id: new FakeObjectId("chat_1"),
    sourceId: "source_1",
  };
  let ingressCalls = 0;
  const deps = createRuntimeDeps({
    processWhatsAppMessage: async () => ({
      message: {
        _id: new FakeObjectId("message_1"),
        conversation: new FakeObjectId("conversation_1"),
        direction: "inbound",
        text: "hello",
      },
      conversationId: "conversation_1",
      isNewConversation: false,
      messageWasNew: false,
      reopenedConversation: false,
      userId: "user_1",
      chatId: "chat_1",
      conversation,
      chat,
    }),
    directIngressAiriConversation: async (_payload, metadata) => {
      assert.equal(metadata.idempotent, true);
      ingressCalls += 1;
      return { workflowId: "airi-workflow" };
    },
  });

  const result = await processWhatsAppWebhookPayload(deps, {
    body,
    rawBody: JSON.stringify(body),
  });

  assert.equal(result.ok, true);
  assert.equal(ingressCalls, 1);
});

test("recovers Airi ingress when the duplicate exists before processing", async () => {
  const body = buildInboundWebhookBody({ text: { body: "hello" } });
  const conversation = {
    _id: new FakeObjectId("conversation_1"),
    chat: new FakeObjectId("chat_1"),
    sourceId: "source_1",
    airi_bot_enabled: true,
    airi_scenarios_enabled: false,
  };
  const chat = {
    _id: new FakeObjectId("chat_1"),
    sourceId: "source_1",
  };
  let processCalls = 0;
  let ingressCalls = 0;
  const deps = createRuntimeDeps({
    findExistingWhatsAppMessageByExternalId: async () => ({
      messageId: "wamid.replay_1",
      conversation: new FakeObjectId("conversation_1"),
    }),
    processWhatsAppMessage: async () => {
      processCalls += 1;
      return {
        message: {
          _id: new FakeObjectId("message_1"),
          conversation: new FakeObjectId("conversation_1"),
          direction: "inbound",
          text: "hello",
        },
        conversationId: "conversation_1",
        isNewConversation: false,
        messageWasNew: false,
        reopenedConversation: false,
        userId: "user_1",
        chatId: "chat_1",
        conversation,
        chat,
      };
    },
    directIngressAiriConversation: async (_payload, metadata) => {
      assert.equal(metadata.idempotent, true);
      ingressCalls += 1;
      return { workflowId: "airi-workflow" };
    },
  });

  const result = await processWhatsAppWebhookPayload(deps, {
    body,
    rawBody: JSON.stringify(body),
  });

  assert.equal(result.ok, true);
  assert.equal(processCalls, 1);
  assert.equal(ingressCalls, 1);
});

test("does not query an inbound duplicate when Airi runtime is disabled", async () => {
  const body = buildInboundWebhookBody({ text: { body: "hello" } });
  let duplicateLookupCalls = 0;
  let processCalls = 0;
  const deps = createRuntimeDeps({
    isWhatsAppAiriRuntimeEnabled: () => false,
    findExistingWhatsAppMessageByExternalId: async () => {
      duplicateLookupCalls += 1;
      return null;
    },
    processWhatsAppMessage: async () => {
      processCalls += 1;
      return {
        message: {
          _id: new FakeObjectId("message_1"),
          conversation: new FakeObjectId("conversation_1"),
          direction: "inbound",
          text: "hello",
        },
        conversationId: "conversation_1",
        isNewConversation: false,
        messageWasNew: true,
        reopenedConversation: false,
        userId: "user_1",
        chatId: "chat_1",
      };
    },
  });

  const result = await processWhatsAppWebhookPayload(deps, {
    body,
    rawBody: JSON.stringify(body),
  });

  assert.equal(result.ok, true);
  assert.equal(processCalls, 1);
  assert.equal(duplicateLookupCalls, 0);
});

test("keeps conversation-level Airi-off inbounds on the persistence and realtime path only", async () => {
  const body = buildInboundWebhookBody({ text: { body: "hello" } });
  const conversation = {
    _id: new FakeObjectId("conversation_1"),
    chat: new FakeObjectId("chat_1"),
    sourceId: "source_1",
    airi_bot_enabled: false,
    airi_scenarios_enabled: false,
  };
  let chatLookupCalls = 0;
  let credentialDecryptCalls = 0;
  let ingressCalls = 0;
  const deps = createRuntimeDeps({
    Chat: {
      findById: async () => {
        chatLookupCalls += 1;
        return null;
      },
    },
    decryptString: () => {
      credentialDecryptCalls += 1;
      return "access-token";
    },
    processWhatsAppMessage: async () => ({
      message: {
        _id: new FakeObjectId("message_1"),
        conversation: new FakeObjectId("conversation_1"),
        direction: "inbound",
        text: "hello",
      },
      conversationId: "conversation_1",
      isNewConversation: false,
      messageWasNew: true,
      reopenedConversation: false,
      userId: "user_1",
      chatId: "chat_1",
      conversation,
    }),
    resolveWhatsAppConversationAutomationEnabled: () => false,
    directIngressAiriConversation: async () => {
      ingressCalls += 1;
      return { workflowId: "airi-workflow" };
    },
  });

  const result = await processWhatsAppWebhookPayload(deps, {
    body,
    rawBody: JSON.stringify(body),
  });

  assert.equal(result.ok, true);
  assert.equal(chatLookupCalls, 0);
  assert.equal(credentialDecryptCalls, 0);
  assert.equal(ingressCalls, 0);
});

test("hands media to durable ingress without waiting for optional Temporal work", async () => {
  let accepted = 0;
  const deps = createRuntimeDeps({
    processWhatsAppMessage: async () => ({
      message: {
        _id: "message_1",
        direction: "inbound",
        text: "",
        mediaType: "audio",
      },
      conversationId: "conversation_1",
      messageWasNew: true,
      mediaAnalysisType: "audio",
      conversation: {
        _id: "conversation_1",
        chat: "chat_1",
        sourceId: "source_1",
      },
      chat: { _id: "chat_1", sourceId: "source_1" },
    }),
    directIngressAiriConversation: async () => {
      accepted++;
      return {};
    },
  });
  const result = await processWhatsAppWebhookPayload(deps, {
    body: buildInboundWebhookBody({ type: "audio", audio: { id: "media_1" } }),
  });
  assert.equal(result.ok, true);
  assert.equal(accepted, 1);
  deps.directIngressAiriConversation = async () => {
    throw new Error("durable persistence unavailable");
  };
  const failed = await processWhatsAppWebhookPayload(deps, {
    body: buildInboundWebhookBody({ type: "audio", audio: { id: "media_1" } }),
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.retryable, true);
});

test("does not enqueue automatic media analysis when Airi runtime is disabled", async () => {
  const body = buildInboundWebhookBody({
    type: "video",
    video: { id: "media_1", mime_type: "video/mp4" },
  });
  let ingressCalls = 0;
  const deps = createRuntimeDeps({
    isWhatsAppAiriRuntimeEnabled: () => false,
    processWhatsAppMessage: async () => ({
      message: {
        _id: new FakeObjectId("message_1"),
        conversation: new FakeObjectId("conversation_1"),
        direction: "inbound",
        text: "",
      },
      conversationId: "conversation_1",
      isNewConversation: false,
      messageWasNew: true,
      reopenedConversation: false,
      userId: "user_1",
      chatId: "chat_1",
      mediaAnalysisType: "video",
    }),
    directIngressAiriConversation: async () => {
      ingressCalls += 1;
      return { workflowId: "airi-workflow" };
    },
  });

  const result = await processWhatsAppWebhookPayload(deps, {
    body,
    rawBody: JSON.stringify(body),
  });

  assert.equal(result.ok, true);
  assert.equal(ingressCalls, 0);
});

test("fails the runtime when inbound message persistence fails", async () => {
  const body = buildInboundWebhookBody();
  const deps = createRuntimeDeps({
    processWhatsAppMessage: async () => {
      throw new Error("database unavailable");
    },
  });

  const result = await processWhatsAppWebhookPayload(deps, {
    body,
    rawBody: JSON.stringify(body),
    suppressAiriIngress: true,
  });

  assert.equal(result.ok, false);
  assert.equal(result.retryable, true);
  assert.match(result.message || "", /database unavailable/);
});

test("routes template status lifecycle events before generic account updates", async () => {
  let accountUpdateCalls = 0;
  let lifecycleCalls = 0;
  const body = {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "waba_1",
        changes: [
          {
            field: "message_template_status_update",
            value: {
              event: "APPROVED",
              message_template_id: 1396288019008192,
              message_template_name: "road_to_battlifield_confirmation",
              message_template_language: "en",
              message_template_category: "MARKETING",
            },
          },
        ],
      },
    ],
  } satisfies WhatsAppWebhookBody;
  const deps = createRuntimeDeps({
    handleAccountUpdateWebhook: async () => {
      accountUpdateCalls += 1;
      return new Response(JSON.stringify({ status: "ok" }));
    },
    tryHandleWhatsAppLifecycleWebhook: async ({ change }) => {
      lifecycleCalls += 1;
      assert.equal(change.field, "message_template_status_update");
      return new Response(
        JSON.stringify({
          status: "ok",
          message: "message_template_status_update processed",
        }),
      );
    },
  });

  const result = await processWhatsAppWebhookPayload(deps, {
    body,
    rawBody: JSON.stringify(body),
  });

  assert.equal(result.ok, true);
  assert.equal(accountUpdateCalls, 0);
  assert.equal(lifecycleCalls, 1);
});

test("retries missing durable realtime intent for an already saved message before duplicate return", async () => {
  let attempts = 0;
  const deps = createRuntimeDeps({
    isWhatsAppAiriRuntimeEnabled: () => false,
    processWhatsAppMessage: async () => ({
      message: {
        _id: "message_1",
        conversation: "conversation_1",
        direction: "inbound",
        text: "saved",
      },
      conversationId: "conversation_1",
      messageWasNew: false,
    }),
    enqueueMessageRealtime: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("outbox unavailable");
    },
  });
  const first = await processWhatsAppWebhookPayload(deps, {
    body: buildInboundWebhookBody(),
  });
  assert.equal(first.ok, false);
  const retry = await processWhatsAppWebhookPayload(deps, {
    body: buildInboundWebhookBody(),
  });
  assert.equal(retry.ok, true);
  assert.equal(attempts, 2);
});

test("repairs deferred referral handoff on duplicate retry before returning success", async () => {
  let attempts = 0;
  const deps = createRuntimeDeps({
    isWhatsAppAiriRuntimeEnabled: () => false,
    processWhatsAppMessage: async () => ({
      message: { _id: "message_1", direction: "inbound" },
      conversationId: "conversation_1",
      messageWasNew: false,
    }),
    enqueueReferralEnrichment: async () => {
      attempts++;
      if (attempts === 1) throw new Error("outbox offline");
    },
  });
  const body = buildInboundWebhookBody({
    referral: { source_type: "ad", source_id: "ad_1" },
  });
  assert.equal((await processWhatsAppWebhookPayload(deps, { body })).ok, false);
  assert.equal((await processWhatsAppWebhookPayload(deps, { body })).ok, true);
  assert.equal(attempts, 2);
});

const TRIAL_EXPIRED_PLAN = {
  trialExpired: true,
  newConversationsAllowed: false,
};

function createIntakeCounters() {
  const counts = {
    processed: 0,
    ingress: 0,
    realtime: 0,
    identityMigrations: 0,
  };
  const overrides: Partial<RuntimeDeps> = {
    Conversation: {
      findById: async () => ({ _id: "conversation_1", chat: "chat_1" }),
    },
    Chat: { findById: async () => ({ _id: "chat_1" }) },
    processWhatsAppMessage: async () => {
      counts.processed += 1;
      return {
        message: {
          _id: new FakeObjectId("message_1"),
          conversation: new FakeObjectId("conversation_1"),
          direction: "inbound",
          text: "hello",
        },
        conversationId: "conversation_1",
        isNewConversation: false,
        messageWasNew: true,
      };
    },
    directIngressAiriConversation: async () => {
      counts.ingress += 1;
      return { workflowId: "airi-workflow" };
    },
    enqueueMessageRealtime: async () => {
      counts.realtime += 1;
    },
    handleUserChangedNumber: async () => {
      counts.identityMigrations += 1;
      return { migrated: true, chatIds: [], userIds: [] };
    },
  };
  return { counts, overrides };
}

test("a trial-expired company completes live message receipts without any intake write", async () => {
  for (const message of [
    { text: { body: "hello" } },
    { type: "image", text: undefined, image: { id: "media_1" } },
    {
      type: "reaction",
      text: undefined,
      reaction: { message_id: "wamid.x", emoji: "👍" },
    },
    // Edits and revokes carry the plan reason too, so --plan-skipped replay
    // restores them (--missing-only never selects mutations).
    { type: "revoke", text: undefined, revoke: { original_message_id: "x" } },
    { type: "unsupported", text: undefined, unsupported: { type: "edit" } },
    {
      type: "system",
      text: undefined,
      system: { type: "user_changed_number" },
    },
  ]) {
    const { counts, overrides } = createIntakeCounters();
    const checks: unknown[] = [];
    const deps = createRuntimeDeps({
      ...overrides,
      getWhatsAppIntakePlanSkip: async (input) => {
        checks.push(input);
        return resolveWhatsAppIntakePlanSkip(TRIAL_EXPIRED_PLAN);
      },
    });

    const result = await processWhatsAppWebhookPayload(deps, {
      body: buildInboundWebhookBody(message),
    });

    assert.equal(result.ok, true);
    assert.equal(result.retryable, false);
    assert.equal(result.message, WHATSAPP_INTAKE_PLAN_LOCKED_MESSAGE);
    assert.equal(result.details?.reason, "company_trial_expired");
    assert.deepEqual(checks, [
      { workspaceId: "workspace_1", sourceId: "source_1", itemKind: "message" },
    ]);
    assert.deepEqual(counts, {
      processed: 0,
      ingress: 0,
      realtime: 0,
      identityMigrations: 0,
    });
  }
});

test("an unlocked, paid, active-trial or null-trial company processes live messages unchanged", async () => {
  // company-limits reports trialExpired=false for all of these.
  for (const plan of [
    { trialExpired: false, newConversationsAllowed: true },
    { trialExpired: false, newConversationsAllowed: false },
  ]) {
    const { counts, overrides } = createIntakeCounters();
    const gate = createWhatsAppIntakePlanGate({ readPlan: async () => plan });
    const deps = createRuntimeDeps({
      ...overrides,
      getWhatsAppIntakePlanSkip: gate.getIntakeSkip,
    });

    const result = await processWhatsAppWebhookPayload(deps, {
      body: buildInboundWebhookBody({ text: { body: "hello" } }),
    });

    assert.equal(result.ok, true);
    assert.equal(counts.processed, 1);
    assert.equal(counts.realtime, 1);
    assert.equal(counts.ingress, 1);
  }
});

test("a plan read failure processes the live message normally", async () => {
  const { counts, overrides } = createIntakeCounters();
  const warnings: unknown[] = [];
  const gate = createWhatsAppIntakePlanGate({
    readPlan: async () => {
      throw new Error("supabase unavailable");
    },
    logger: { warn: (...args) => warnings.push(args) },
  });
  const deps = createRuntimeDeps({
    ...overrides,
    getWhatsAppIntakePlanSkip: gate.getIntakeSkip,
  });

  const result = await processWhatsAppWebhookPayload(deps, {
    body: buildInboundWebhookBody({ text: { body: "hello" } }),
  });

  assert.equal(result.ok, true);
  assert.equal(counts.processed, 1);
  assert.equal(counts.ingress, 1);
  assert.equal(warnings.length, 1);
});

test("a refused new WhatsApp conversation completes as a skip without side effects", async () => {
  for (const message of [
    { text: { body: "hello" } },
    {
      type: "reaction",
      text: undefined,
      reaction: { message_id: "wamid.x", emoji: "👍" },
    },
  ]) {
    const { counts, overrides } = createIntakeCounters();
    const deps = createRuntimeDeps({
      ...overrides,
      processWhatsAppMessage: async () => {
        counts.processed += 1;
        return buildWhatsAppPlanSkippedProcessResult(
          resolveWhatsAppNewConversationPlanSkip({
            trialExpired: false,
            newConversationsAllowed: false,
          })!,
        );
      },
    });

    const result = await processWhatsAppWebhookPayload(deps, {
      body: buildInboundWebhookBody(message),
    });

    assert.equal(result.ok, true);
    assert.equal(result.retryable, false);
    assert.equal(result.details?.reason, "company_conversation_limit_exceeded");
    assert.equal(counts.processed, 1);
    assert.equal(counts.realtime, 0);
    assert.equal(counts.ingress, 0);
  }
});

test("statuses and calls never consult the intake plan gate", async () => {
  let planChecks = 0;
  for (const handler of [
    "tryHandleWhatsAppStatusWebhook",
    "tryHandleWhatsAppCallWebhook",
  ] as const) {
    const deps = createRuntimeDeps({
      getWhatsAppIntakePlanSkip: async () => {
        planChecks += 1;
        return resolveWhatsAppIntakePlanSkip(TRIAL_EXPIRED_PLAN);
      },
      [handler]: async () =>
        new Response(JSON.stringify({ status: "ok", message: handler })),
    });
    const result = await processWhatsAppWebhookPayload(deps, {
      body: buildInboundWebhookBody(),
    });
    assert.equal(result.ok, true);
    assert.equal(result.message, handler);
  }
  assert.equal(planChecks, 0);
});

test("hands a shop owner's video on airi's own number to the Products intake, with no Airi reply", async () => {
  const body = buildInboundWebhookBody({
    type: "video",
    video: { id: "media_1", mime_type: "video/mp4" },
  });
  const intakeMessages: Record<string, unknown>[] = [];
  let ingressCalls = 0;
  const saved = (text: string) => async () => ({
    message: {
      _id: new FakeObjectId("message_1"),
      conversation: new FakeObjectId("conversation_1"),
      direction: "inbound",
      text,
    },
    conversationId: "conversation_1",
    isNewConversation: false,
    messageWasNew: true,
    reopenedConversation: false,
    userId: "user_1",
    chatId: "chat_1",
    conversation: {
      _id: new FakeObjectId("conversation_1"),
      sourceId: "source_1",
      airi_bot_enabled: true,
    },
    chat: { _id: new FakeObjectId("chat_1") },
  });
  const deps = createRuntimeDeps({
    processWhatsAppMessage: saved("[video attachment]"),
    handleProductsWhatsAppIntake: async (message) => {
      intakeMessages.push(message);
      return { handled: true, outcome: "import_started" };
    },
    directIngressAiriConversation: async () => {
      ingressCalls += 1;
      return { workflowId: "airi-workflow" };
    },
  });

  const result = await processWhatsAppWebhookPayload(deps, {
    body,
    rawBody: JSON.stringify(body),
  });

  assert.equal(result.ok, true);
  assert.equal(result.message, "products intake processed");
  assert.equal(ingressCalls, 0);
  assert.deepEqual(intakeMessages, [
    {
      receivingPhone: "+15550000000",
      sourceId: "source_1",
      workspaceId: "workspace_1",
      conversationId: "conversation_1",
      messageId: "message_1",
      from: "15551111111",
      text: null,
      buttonReplyId: null,
      video: { mediaId: "media_1", mimeType: "video/mp4" },
    },
  ]);

  // A message the intake leaves alone gets the usual handling.
  const textBody = buildInboundWebhookBody({ text: { body: "hello" } });
  const passOn = createRuntimeDeps({
    processWhatsAppMessage: saved("hello"),
    handleProductsWhatsAppIntake: async () => ({
      handled: false,
      outcome: "not_a_video",
    }),
    directIngressAiriConversation: async () => {
      ingressCalls += 1;
      return { workflowId: "airi-workflow" };
    },
  });
  await processWhatsAppWebhookPayload(passOn, {
    body: textBody,
    rawBody: JSON.stringify(textBody),
  });
  assert.equal(ingressCalls, 1);
});
