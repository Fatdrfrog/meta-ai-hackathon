import assert from "node:assert/strict";
import test from "node:test";

import type {
  WhatsAppWebhookBody,
  WhatsAppWebhookChange,
} from "@icecore/shared/lib/whatsapp/webhook-payload";

import { createWhatsAppHistoryWebhookHandler } from "./whatsapp-history-webhook-handler";
import {
  buildWhatsAppPlanSkippedProcessResult,
  createWhatsAppIntakePlanGate,
  resolveWhatsAppIntakePlanSkip,
  resolveWhatsAppNewConversationPlanSkip,
  type WhatsAppIntakePlanCheck,
} from "./whatsapp-intake-plan-gate";

type MockFn<Args extends unknown[], Return> = ((...args: Args) => Return) & {
  calls: Args[];
};

function createMockFn<Args extends unknown[], Return>(
  implementation: (...args: Args) => Return,
): MockFn<Args, Return> {
  const fn = ((...args: Args) => {
    fn.calls.push(args);
    return implementation(...args);
  }) as MockFn<Args, Return>;
  fn.calls = [];
  return fn;
}

function createRequestLogger() {
  return {
    error: createMockFn((_message: string, _error?: unknown) => undefined),
    info: createMockFn((_message: string, _context?: unknown) => undefined),
    success: createMockFn((_message: string, _context?: unknown) => undefined),
    warn: createMockFn((_message: string, _context?: unknown) => undefined),
  };
}

function createSource() {
  return {
    id: "source-1",
    type: "whatsapp",
    workspace_id: "workspace-1",
    credentials: {
      access_token: "encrypted-token",
      display_phone_number: "15551234567",
      history_sync: {
        requested_at: "2026-06-15T00:00:00.000Z",
        range_days: 180,
      },
    },
  };
}

function createHandlerHarness(
  options: {
    processError?: Error;
    stateError?: string;
    latestCredentials?: Record<string, unknown>;
    getWhatsAppIntakePlanSkip?: WhatsAppIntakePlanCheck;
    processResult?: Record<string, unknown>;
  } = {},
) {
  const source = createSource();
  const processWhatsAppMessage = createMockFn(async (params: any) => {
    if (options.processError) throw options.processError;
    return (
      options.processResult ?? {
        conversationId: "conversation-1",
        isNewConversation: true,
        messageWasNew: true,
        ...params.resultOverride,
      }
    );
  });
  const updateSourceCredentials = createMockFn(async (_params: any) => ({
    error: options.stateError ? { message: options.stateError } : null,
  }));
  const resolveWhatsAppSourceByAccountIdentifiers = createMockFn(
    async (_params: Record<string, unknown>) => source,
  );
  const decryptString = createMockFn((_value: unknown) => "decrypted-token");
  const triggerConversationRealtime = createMockFn(
    async (_conversationId: string, _wasJustCreated?: boolean) => undefined,
  );
  const getWhatsAppIntakePlanSkip = createMockFn(
    options.getWhatsAppIntakePlanSkip ?? (async () => null),
  );

  const handler = createWhatsAppHistoryWebhookHandler({
    buildWhatsAppWebhookSourceSkipPayload: (sourceSkip: any) => ({
      status: "ok",
      message: "source disconnected",
      reason: sourceSkip.reason,
    }),
    decryptString,
    getWhatsAppWebhookSourceSkip: (candidate: any) =>
      candidate.credentials?.coexistence_reonboarding_status === "removed"
        ? { reason: "partner_removed" }
        : null,
    getWhatsAppIntakePlanSkip,
    invalidateRequestsForWorkspace: async () => undefined,
    processWhatsAppMessage,
    readLatestSourceCredentials: async () =>
      options.latestCredentials ?? source.credentials,
    resolveWhatsAppSourceByAccountIdentifiers,
    triggerConversationRealtime,
    updateSourceCredentials,
  });

  return {
    decryptString,
    getWhatsAppIntakePlanSkip,
    handler,
    processWhatsAppMessage,
    resolveWhatsAppSourceByAccountIdentifiers,
    source,
    triggerConversationRealtime,
    updateSourceCredentials,
  };
}

test("uses history thread context when phone fields are omitted", async () => {
  const { handler, processWhatsAppMessage } = createHandlerHarness();
  const body: WhatsAppWebhookBody = {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "waba-1",
        changes: [],
      },
    ],
  };
  const change: WhatsAppWebhookChange = {
    field: "history",
    value: {
      messaging_product: "whatsapp",
      metadata: {
        phone_number_id: "phone-1",
        display_phone_number: "15551234567",
      },
      history: [
        {
          metadata: {
            phase: 1,
            chunk_order: 1,
            progress: 50,
          },
          threads: [
            {
              context: {
                user_id: "US.1349.private",
                parent_user_id: "US.parent.private",
                username: "@private_user",
              },
              messages: [
                {
                  id: "wamid.history-1",
                  from_user_id: "US.1349.private",
                  timestamp: "1781481600",
                  type: "text",
                  text: { body: "hello" },
                },
                {
                  id: "wamid.history-2",
                  from_user_id: "US.1349.private",
                  timestamp: "1781481660",
                  type: "text",
                  text: { body: "again" },
                },
              ],
            },
          ],
        },
      ],
    },
  };

  const response = await handler({
    body,
    change,
    requestLogger: createRequestLogger(),
  });

  assert.deepEqual(await response?.json(), {
    status: "ok",
    message: "history processed",
  });
  assert.equal(processWhatsAppMessage.calls.length, 2);
  assert.equal(
    processWhatsAppMessage.calls[0]?.[0].contactData.userId,
    "US.1349.private",
  );
  assert.equal(
    processWhatsAppMessage.calls[0]?.[0].contactData.parentUserId,
    "US.parent.private",
  );
  assert.equal(
    processWhatsAppMessage.calls[0]?.[0].contactData.profile.username,
    "@private_user",
  );
  assert.equal(processWhatsAppMessage.calls[0]?.[0].direction, "inbound");
  assert.equal(processWhatsAppMessage.calls[0]?.[0].conversationId, undefined);
  assert.equal(
    processWhatsAppMessage.calls[1]?.[0].conversationId,
    "conversation-1",
  );
});

function historyMessageChange(): WhatsAppWebhookChange {
  return {
    field: "history",
    value: {
      metadata: { phone_number_id: "phone-1" },
      history: [
        {
          metadata: { progress: 100 },
          threads: [
            {
              id: "15550000001",
              messages: [
                {
                  id: "wamid.history-failure",
                  from: "15550000001",
                  timestamp: "1781481600",
                  type: "text",
                  text: { body: "history" },
                },
              ],
            },
          ],
        },
      ],
    },
  };
}

test("does not acknowledge a failed history message as completed", async () => {
  const { handler, updateSourceCredentials } = createHandlerHarness({
    processError: new Error("database unavailable"),
  });
  const change = historyMessageChange();
  await assert.rejects(
    handler({
      body: { object: "whatsapp_business_account", entry: [] },
      change,
      requestLogger: createRequestLogger(),
    }),
    /database unavailable/,
  );
  assert.equal(updateSourceCredentials.calls.length, 0);
});

test("does not acknowledge a failed history status write", async () => {
  const { handler } = createHandlerHarness({
    stateError: "source state unavailable",
  });
  await assert.rejects(
    handler({
      body: { object: "whatsapp_business_account", entry: [] },
      change: historyMessageChange(),
      requestLogger: createRequestLogger(),
    }),
    /source state unavailable/,
  );
});

const importBinding = {
  role: "message" as const,
  sessionId: "session-1",
  sessionStartedAt: "2026-06-15T00:00:00.000Z",
  rangeDays: 180,
  sourceId: "source-1",
  workspaceId: "workspace-1",
  phoneNumberId: "phone-1",
};

test("a bound receipt synchronizes without incrementing mutable credential counters", async () => {
  const harness = createHandlerHarness();
  Object.assign(harness.source.credentials.history_sync, {
    session_id: "session-1",
  });
  const response = await harness.handler({
    body: { object: "whatsapp_business_account", entry: [] },
    change: historyMessageChange(),
    requestLogger: createRequestLogger(),
    historyImport: importBinding,
  });
  assert.equal((await response!.json()).historyOutcome, "synchronized");
  assert.equal(harness.updateSourceCredentials.calls.length, 0);
  assert.equal(
    harness.processWhatsAppMessage.calls[0]![0].importMode,
    "history",
  );
  assert.equal(
    harness.processWhatsAppMessage.calls[0]![0].messageDate.toISOString(),
    "2026-06-15T00:00:00.000Z",
  );
});

test("a bound history receipt without a provider message id fails instead of claiming synchronization", async () => {
  const harness = createHandlerHarness();
  Object.assign(harness.source.credentials.history_sync, {
    session_id: "session-1",
  });
  const change = historyMessageChange();
  delete (change.value as any).history[0].threads[0].messages[0].id;
  await assert.rejects(
    harness.handler({
      body: { object: "whatsapp_business_account", entry: [] },
      change,
      requestLogger: createRequestLogger(),
      historyImport: importBinding,
    }),
    /message id is required/,
  );
  assert.equal(harness.processWhatsAppMessage.calls.length, 0);
});

test("a stale session receipt cannot populate the replacement onboarding", async () => {
  const harness = createHandlerHarness();
  Object.assign(harness.source.credentials.history_sync, {
    session_id: "replacement-session",
  });
  const response = await harness.handler({
    body: { object: "whatsapp_business_account", entry: [] },
    change: historyMessageChange(),
    requestLogger: createRequestLogger(),
    historyImport: importBinding,
  });
  assert.equal((await response!.json()).historyOutcome, "superseded");
  assert.equal(harness.processWhatsAppMessage.calls.length, 0);
  assert.equal(harness.updateSourceCredentials.calls.length, 0);
});

test("an unbound legacy receipt cannot enter a future session hidden by the source cache", async () => {
  const harness = createHandlerHarness({
    latestCredentials: {
      access_token: "encrypted-token",
      history_sync: { session_id: "future-session" },
    },
  });
  const response = await harness.handler({
    body: { object: "whatsapp_business_account", entry: [] },
    change: historyMessageChange(),
    requestLogger: createRequestLogger(),
  });
  assert.equal((await response!.json()).historyOutcome, "superseded");
  assert.equal(harness.processWhatsAppMessage.calls.length, 0);
  assert.equal(harness.updateSourceCredentials.calls.length, 0);
});

test("a bound history receipt rejects malformed timestamps instead of importing them as current messages", async () => {
  for (const timestamp of [
    "",
    "invalid",
    "1781481600oops",
    "0",
    "99999999999999999999",
  ]) {
    const harness = createHandlerHarness();
    Object.assign(harness.source.credentials.history_sync, {
      session_id: "session-1",
    });
    const change = historyMessageChange();
    (change.value as any).history[0].threads[0].messages[0].timestamp =
      timestamp;
    await assert.rejects(
      harness.handler({
        body: { object: "whatsapp_business_account", entry: [] },
        change,
        requestLogger: createRequestLogger(),
        historyImport: importBinding,
      }),
      /history message.*timestamp/i,
    );
    assert.equal(harness.processWhatsAppMessage.calls.length, 0);
    assert.equal(harness.updateSourceCredentials.calls.length, 0);
  }
});

test("skips history processing when the resolved source is disconnected", async () => {
  const { decryptString, handler, processWhatsAppMessage, source } =
    createHandlerHarness();
  source.credentials = {
    ...source.credentials,
    coexistence_reonboarding_status: "removed",
    cloud_api_messaging_suspended: true,
  } as typeof source.credentials;

  const body: WhatsAppWebhookBody = {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "waba-1",
        changes: [],
      },
    ],
  };
  const change: WhatsAppWebhookChange = {
    field: "history",
    value: {
      messaging_product: "whatsapp",
      metadata: {
        phone_number_id: "phone-1",
        display_phone_number: "15551234567",
      },
      messages: [
        {
          id: "wamid.history-removed",
          from: "15551234567",
          timestamp: "1781481600",
          type: "text",
          text: { body: "hello" },
        },
      ],
    },
  };

  const response = await handler({
    body,
    change,
    requestLogger: createRequestLogger(),
  });

  assert.deepEqual(await response?.json(), {
    status: "ok",
    message: "source disconnected",
    reason: "partner_removed",
  });
  assert.equal(processWhatsAppMessage.calls.length, 0);
  assert.equal(decryptString.calls.length, 0);
});

test("processes history message echoes as outbound messages", async () => {
  const { handler, processWhatsAppMessage } = createHandlerHarness();
  const body: WhatsAppWebhookBody = {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "waba-1",
        changes: [],
      },
    ],
  };
  const change: WhatsAppWebhookChange = {
    field: "history",
    value: {
      messaging_product: "whatsapp",
      metadata: {
        phone_number_id: "phone-1",
        display_phone_number: "15551234567",
      },
      contacts: [
        {
          user_id: "US.1349.private",
          profile: {
            username: "@private_user",
          },
        },
      ],
      message_echoes: [
        {
          id: "wamid.echo-1",
          from: "15551234567",
          to_user_id: "US.1349.private",
          timestamp: "1781481600",
          type: "text",
          text: { body: "Business reply" },
        },
      ],
    },
  };

  const response = await handler({
    body,
    change,
    requestLogger: createRequestLogger(),
  });

  assert.deepEqual(await response?.json(), {
    status: "ok",
    message: "history processed",
  });
  assert.equal(processWhatsAppMessage.calls.length, 1);
  const call = processWhatsAppMessage.calls[0]?.[0];
  assert.equal(call.contactData.userId, "US.1349.private");
  assert.equal(call.contactData.profile.username, "@private_user");
  assert.equal(call.direction, "outbound");
  assert.equal(call.rawSourcePayload.eventType, "history_message_echo");
});

function createBoundHarness(
  options: Parameters<typeof createHandlerHarness>[0] = {},
) {
  const harness = createHandlerHarness(options);
  Object.assign(harness.source.credentials.history_sync, {
    session_id: "session-1",
  });
  return harness;
}

test("a trial-expired company completes bound history children as skipped without importing", async () => {
  const harness = createBoundHarness({
    getWhatsAppIntakePlanSkip: async () =>
      resolveWhatsAppIntakePlanSkip({
        trialExpired: true,
        newConversationsAllowed: false,
      }),
  });
  const requestLogger = createRequestLogger();
  const response = await harness.handler({
    body: { object: "whatsapp_business_account", entry: [] },
    change: historyMessageChange(),
    requestLogger,
    historyImport: importBinding,
  });

  assert.deepEqual(await response!.json(), {
    status: "ok",
    message: "WhatsApp intake skipped: company plan locked",
    reason: "company_trial_expired",
    historyOutcome: "skipped",
  });
  assert.deepEqual(harness.getWhatsAppIntakePlanSkip.calls, [
    [
      {
        workspaceId: "workspace-1",
        sourceId: "source-1",
        itemKind: "history_message",
      },
    ],
  ]);
  // processWhatsAppMessage is the only path that downloads history media.
  assert.equal(harness.processWhatsAppMessage.calls.length, 0);
  assert.equal(harness.decryptString.calls.length, 0);
  assert.equal(harness.updateSourceCredentials.calls.length, 0);
  assert.equal(
    requestLogger.info.calls.some(
      ([message]) =>
        message === "WhatsApp history intake skipped by company plan",
    ),
    true,
  );
});

test("a trial-expired company completes legacy history without a retryable skip message", async () => {
  const harness = createHandlerHarness({
    getWhatsAppIntakePlanSkip: async () =>
      resolveWhatsAppIntakePlanSkip({
        trialExpired: true,
        newConversationsAllowed: false,
      }),
  });
  const response = await harness.handler({
    body: { object: "whatsapp_business_account", entry: [] },
    change: historyMessageChange(),
    requestLogger: createRequestLogger(),
  });

  const body = await response!.json();
  assert.deepEqual(body, {
    status: "ok",
    message: "WhatsApp intake skipped: company plan locked",
    reason: "company_trial_expired",
  });
  assert.equal(JSON.stringify(body).includes("history skipped"), false);
  assert.equal(harness.processWhatsAppMessage.calls.length, 0);
  assert.equal(harness.updateSourceCredentials.calls.length, 0);
});

test("history children refused a new conversation record a skipped outcome", async () => {
  const harness = createBoundHarness({
    processResult: buildWhatsAppPlanSkippedProcessResult(
      resolveWhatsAppNewConversationPlanSkip({
        trialExpired: false,
        newConversationsAllowed: false,
      })!,
    ),
  });
  const response = await harness.handler({
    body: { object: "whatsapp_business_account", entry: [] },
    change: historyMessageChange(),
    requestLogger: createRequestLogger(),
    historyImport: importBinding,
  });

  assert.deepEqual(await response!.json(), {
    status: "ok",
    message: "history message synchronized",
    historyOutcome: "skipped",
    reason: "company_conversation_limit_exceeded",
  });
  assert.equal(harness.processWhatsAppMessage.calls.length, 1);
  assert.equal(harness.triggerConversationRealtime.calls.length, 0);
});

test("legacy history with a refused new conversation carries the plan reason for replay", async () => {
  const harness = createHandlerHarness({
    processResult: buildWhatsAppPlanSkippedProcessResult(
      resolveWhatsAppNewConversationPlanSkip({
        trialExpired: false,
        newConversationsAllowed: false,
      })!,
    ),
  });
  const response = await harness.handler({
    body: { object: "whatsapp_business_account", entry: [] },
    change: historyMessageChange(),
    requestLogger: createRequestLogger(),
  });

  // Unbound receipts have no historyOutcome; the reason is their only marker.
  assert.deepEqual(await response!.json(), {
    status: "ok",
    message: "history processed",
    reason: "company_conversation_limit_exceeded",
  });
  assert.equal(harness.processWhatsAppMessage.calls.length, 1);
  assert.equal(harness.triggerConversationRealtime.calls.length, 0);
});

test("unlocked companies and plan read failures still synchronize history children", async () => {
  for (const readPlan of [
    async () => ({ trialExpired: false, newConversationsAllowed: true }),
    async () => ({ trialExpired: false, newConversationsAllowed: false }),
    async (): Promise<never> => {
      throw new Error("supabase unavailable");
    },
  ]) {
    const gate = createWhatsAppIntakePlanGate({
      readPlan,
      logger: { warn: () => undefined },
    });
    const harness = createBoundHarness({
      getWhatsAppIntakePlanSkip: gate.getIntakeSkip,
    });
    const response = await harness.handler({
      body: { object: "whatsapp_business_account", entry: [] },
      change: historyMessageChange(),
      requestLogger: createRequestLogger(),
      historyImport: importBinding,
    });
    assert.equal((await response!.json()).historyOutcome, "synchronized");
    assert.equal(harness.processWhatsAppMessage.calls.length, 1);
  }
});
