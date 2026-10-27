import assert from "node:assert/strict";
import test from "node:test";

import {
  createWhatsAppEchoWebhookHandler,
  type WhatsAppEchoWebhookHandlerDependencies,
} from "@icecore/airi-runtime/whatsapp-echo-webhook-handler";
import type { WhatsAppWebhookBody } from "@icecore/shared/lib/whatsapp/webhook-payload";
import { createRecordingLogger } from "@icecore/airi-runtime/testing/recording-logger";
import {
  buildWhatsAppPlanSkippedProcessResult,
  createWhatsAppIntakePlanGate,
  resolveWhatsAppIntakePlanSkip,
  resolveWhatsAppNewConversationPlanSkip,
} from "@icecore/airi-runtime/whatsapp-intake-plan-gate";

function buildEchoWebhookBody(): WhatsAppWebhookBody {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "waba-1",
        changes: [
          {
            field: "messages",
            value: {
              contacts: [
                {
                  wa_id: "16505551234",
                  profile: { name: "Customer" },
                },
              ],
              metadata: {
                display_phone_number: "15550783881",
                phone_number_id: "phone-1",
              },
              messaging_product: "whatsapp",
              smb_message_echoes: [
                {
                  from: "15550783881",
                  id: "wamid.echo-1",
                  text: { body: "sent from app" },
                  timestamp: "1770000000",
                  to: "16505551234",
                  type: "text",
                },
              ],
            },
          },
        ],
      },
    ],
  } as WhatsAppWebhookBody;
}

function createDependencies(
  overrides: Partial<WhatsAppEchoWebhookHandlerDependencies> = {},
) {
  const calls: Array<{ name: string; params: unknown }> = [];
  const deps: WhatsAppEchoWebhookHandlerDependencies = {
    buildWhatsAppWebhookSourceSkipPayload: (sourceSkip) => ({
      status: "ok",
      message: "source disconnected",
      reason: sourceSkip.reason,
    }),
    decryptString: (value) => {
      calls.push({ name: "decrypt", params: value });
      return "token-1";
    },
    findExistingWhatsAppMessageByExternalId: async (messageId) => {
      calls.push({ name: "dedupe", params: messageId });
      return null;
    },
    findMessageForRealtime: async (messageId) => {
      calls.push({ name: "findRealtimeMessage", params: messageId });
      return { _id: messageId, author: { firstName: "Manager" } };
    },
    getWhatsAppWebhookSourceSkip: (source) =>
      source.skipReason ? { reason: source.skipReason } : null,
    getWhatsAppIntakePlanSkip: async (input) => {
      calls.push({ name: "planCheck", params: input });
      return null;
    },
    processWhatsAppMessage: async (params) => {
      calls.push({ name: "process", params });
      return {
        conversationId: "conversation-1",
        isNewConversation: false,
        message: { _id: "message-1" },
        messageWasNew: true,
      };
    },
    realtimeTrigger: async (channel, eventName, data) => {
      calls.push({ name: "realtime", params: { channel, eventName, data } });
    },
    resolveWhatsAppSourceByAccountIdentifiers: async (params) => {
      calls.push({ name: "source", params });
      return {
        id: "source-1",
        workspace_id: "workspace-1",
        credentials: {
          access_token: "encrypted-token",
          phone_number_id: "phone-1",
        },
      };
    },
    shouldProcessEvenIfDuplicate: () => false,
    triggerConversationRealtime: async (conversationId, wasJustCreated) => {
      calls.push({
        name: "conversationRealtime",
        params: { conversationId, wasJustCreated },
      });
    },
    triggerWhatsAppReactionRealtimeUpdate: async (params) => {
      calls.push({ name: "reactionRealtime", params });
    },
    ...overrides,
  };

  return { calls, deps };
}

test("processes outbound WhatsApp app echoes and emits conversation/message realtime", async () => {
  const body = buildEchoWebhookBody();
  const change = body.entry[0]!.changes[0]!;
  const { calls, deps } = createDependencies();
  const { logger } = createRecordingLogger();
  const tryHandleWhatsAppEchoWebhook = createWhatsAppEchoWebhookHandler(deps);

  const response = await tryHandleWhatsAppEchoWebhook({
    body,
    change,
    requestLogger: logger,
  });

  assert.ok(response);
  assert.deepEqual(await response.json(), {
    status: "ok",
    message: "echoes processed",
  });
  assert.deepEqual(
    calls.map((call) => call.name),
    [
      "source",
      "planCheck",
      "decrypt",
      "dedupe",
      "process",
      "conversationRealtime",
      "findRealtimeMessage",
      "realtime",
    ],
  );
  assert.deepEqual(calls[1]?.params, {
    workspaceId: "workspace-1",
    sourceId: "source-1",
    itemKind: "echo",
  });

  const processed = calls[4]?.params as {
    accessToken?: string;
    contactData?: { waId?: string };
    direction?: string;
    messageData?: { id?: string };
    phoneNumberId?: string;
    sourceId?: string;
    workspaceId?: string;
  };
  assert.equal(processed.accessToken, "token-1");
  assert.equal(processed.contactData?.waId, "16505551234");
  assert.equal(processed.direction, "outbound");
  assert.equal(processed.messageData?.id, "wamid.echo-1");
  assert.equal(processed.phoneNumberId, "phone-1");
  assert.equal(processed.sourceId, "source-1");
  assert.equal(processed.workspaceId, "workspace-1");

  assert.deepEqual(calls[7]?.params, {
    channel: "private-conversation-conversation-1",
    eventName: "new-message",
    data: { _id: "message-1", author: { firstName: "Manager" } },
  });
});

test("skips duplicate echo messages before processing", async () => {
  const body = buildEchoWebhookBody();
  const change = body.entry[0]!.changes[0]!;
  const { calls, deps } = createDependencies({
    findExistingWhatsAppMessageByExternalId: async (messageId) => {
      calls.push({ name: "dedupe", params: messageId });
      return {
        messageId,
        conversation: "conversation-1",
      };
    },
  });
  const { logger } = createRecordingLogger();
  const tryHandleWhatsAppEchoWebhook = createWhatsAppEchoWebhookHandler(deps);

  const response = await tryHandleWhatsAppEchoWebhook({
    body,
    change,
    requestLogger: logger,
  });

  assert.ok(response);
  assert.deepEqual(await response.json(), {
    status: "ok",
    message: "echoes processed",
  });
  assert.deepEqual(
    calls.map((call) => call.name),
    ["source", "planCheck", "decrypt", "dedupe"],
  );
});

test("propagates echo persistence failures so durable events can retry", async () => {
  const body = buildEchoWebhookBody();
  const change = body.entry[0]!.changes[0]!;
  const { calls, deps } = createDependencies({
    processWhatsAppMessage: async (params) => {
      calls.push({ name: "process", params });
      throw new Error("mongo unavailable");
    },
  });
  const { logger, errors } = createRecordingLogger();
  const tryHandleWhatsAppEchoWebhook = createWhatsAppEchoWebhookHandler(deps);

  await assert.rejects(
    () =>
      tryHandleWhatsAppEchoWebhook({
        body,
        change,
        requestLogger: logger,
      }),
    /mongo unavailable/,
  );

  assert.deepEqual(
    calls.map((call) => call.name),
    ["source", "planCheck", "decrypt", "dedupe", "process"],
  );
  assert.equal(errors[0]?.[0], "WhatsApp echo message processing failed");
});

test("acknowledges inactive source echoes without processing messages", async () => {
  const body = buildEchoWebhookBody();
  const change = body.entry[0]!.changes[0]!;
  const { calls, deps } = createDependencies({
    resolveWhatsAppSourceByAccountIdentifiers: async () => ({
      id: "source-1",
      workspace_id: "workspace-1",
      credentials: { access_token: "encrypted-token" },
      skipReason: "partner_removed",
    }),
  });
  const { logger } = createRecordingLogger();
  const tryHandleWhatsAppEchoWebhook = createWhatsAppEchoWebhookHandler(deps);

  const response = await tryHandleWhatsAppEchoWebhook({
    body,
    change,
    requestLogger: logger,
  });

  assert.ok(response);
  assert.deepEqual(await response.json(), {
    status: "ok",
    message: "source disconnected",
    reason: "partner_removed",
  });
  assert.deepEqual(calls, []);
});

test("a trial-expired company completes echo receipts without processing or media download", async () => {
  const body = buildEchoWebhookBody();
  const change = body.entry[0]!.changes[0]!;
  const { calls, deps } = createDependencies({
    getWhatsAppIntakePlanSkip: async (input) => {
      calls.push({ name: "planCheck", params: input });
      return resolveWhatsAppIntakePlanSkip({
        trialExpired: true,
        newConversationsAllowed: false,
      });
    },
  });
  const { logger, infos } = createRecordingLogger();
  const tryHandleWhatsAppEchoWebhook = createWhatsAppEchoWebhookHandler(deps);

  const response = await tryHandleWhatsAppEchoWebhook({
    body,
    change,
    requestLogger: logger,
  });

  assert.ok(response);
  assert.deepEqual(await response.json(), {
    status: "ok",
    message: "WhatsApp intake skipped: company plan locked",
    reason: "company_trial_expired",
  });
  // processWhatsAppMessage is the only path that downloads echo media.
  assert.deepEqual(
    calls.map((call) => call.name),
    ["source", "planCheck"],
  );
  const skipLog = infos.find(
    ([message]) => message === "WhatsApp echo intake skipped by company plan",
  );
  assert.equal(skipLog?.[1]?.workspaceId, "workspace-1");
  assert.equal(skipLog?.[1]?.sourceId, "source-1");
  assert.equal(skipLog?.[1]?.itemKind, "echo");
  assert.equal(skipLog?.[1]?.reason, "company_trial_expired");
});

test("an echo plan read failure fails open and processes the echo", async () => {
  const body = buildEchoWebhookBody();
  const change = body.entry[0]!.changes[0]!;
  const gate = createWhatsAppIntakePlanGate({
    readPlan: async () => {
      throw new Error("supabase unavailable");
    },
    logger: { warn: () => undefined },
  });
  const { calls, deps } = createDependencies({
    getWhatsAppIntakePlanSkip: gate.getIntakeSkip,
  });
  const { logger } = createRecordingLogger();

  const response = await createWhatsAppEchoWebhookHandler(deps)({
    body,
    change,
    requestLogger: logger,
  });

  assert.deepEqual(await response!.json(), {
    status: "ok",
    message: "echoes processed",
  });
  assert.ok(calls.some((call) => call.name === "process"));
  assert.ok(calls.some((call) => call.name === "realtime"));
});

test("an echo refused a new conversation completes without realtime", async () => {
  const body = buildEchoWebhookBody();
  const change = body.entry[0]!.changes[0]!;
  const { calls, deps } = createDependencies({
    processWhatsAppMessage: async (params) => {
      calls.push({ name: "process", params });
      return buildWhatsAppPlanSkippedProcessResult(
        resolveWhatsAppNewConversationPlanSkip({
          trialExpired: false,
          newConversationsAllowed: false,
        })!,
      );
    },
  });
  const { logger, infos } = createRecordingLogger();

  const response = await createWhatsAppEchoWebhookHandler(deps)({
    body,
    change,
    requestLogger: logger,
  });

  // The reason marks the completed receipt for --plan-skipped replay.
  assert.deepEqual(await response!.json(), {
    status: "ok",
    message: "echoes processed",
    reason: "company_conversation_limit_exceeded",
  });
  assert.deepEqual(
    calls.map((call) => call.name),
    ["source", "planCheck", "decrypt", "dedupe", "process"],
  );
  assert.equal(
    infos.find(
      ([message]) =>
        message === "WhatsApp echo new conversation skipped by company plan",
    )?.[1]?.reason,
    "company_conversation_limit_exceeded",
  );
});
