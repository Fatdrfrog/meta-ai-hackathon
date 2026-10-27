import assert from "node:assert/strict";
import test from "node:test";

import {
  createWhatsAppCallWebhookHandler,
  type WhatsAppCallWebhookHandlerDependencies,
} from "@icecore/airi-runtime/whatsapp-call-webhook-handler";
import type { WhatsAppWebhookBody } from "@icecore/shared/lib/whatsapp/webhook-payload";
import { createRecordingLogger } from "@icecore/airi-runtime/testing/recording-logger";

function buildCallWebhookBody(): WhatsAppWebhookBody {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "waba-1",
        changes: [
          {
            field: "calls",
            value: {
              metadata: {
                phone_number_id: "phone-1",
              },
              calls: [
                {
                  id: "wacid.1",
                  event: "connect",
                  direction: "USER_INITIATED",
                  from_user_id: "US.1349.private",
                  to_user_id: "US.1349.business",
                  timestamp: "1770000000",
                  session: {
                    sdp_type: "offer",
                    sdp: "v=0\r\no=- 123 456 IN IP4 127.0.0.1",
                  },
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
  overrides: Partial<WhatsAppCallWebhookHandlerDependencies> = {},
) {
  const calls: Array<{ name: string; params: unknown }> = [];
  const deps: WhatsAppCallWebhookHandlerDependencies = {
    buildWhatsAppWebhookSourceSkipPayload: (sourceSkip) => ({
      status: "ok",
      message: "source disconnected",
      reason: sourceSkip.reason,
    }),
    emitConversationCallUpdatedRealtimeEvent: async (params) => {
      calls.push({ name: "realtime", params });
    },
    getWhatsAppWebhookSourceSkip: (source) =>
      source.skipReason ? { reason: source.skipReason } : null,
    linkWhatsAppCallSessionToConversation: async (params) => {
      calls.push({ name: "link", params });
      return {
        conversationId: "conversation-1",
        customerId: "customer-1",
        createdConversation: false,
      };
    },
    persistWhatsAppCallEvent: async (params) => {
      calls.push({ name: "persist", params });
    },
    resolveWhatsAppSourceByAccountIdentifiers: async () => ({
      id: "source-1",
      workspace_id: "workspace-1",
      credentials: {
        coexistence_mode: true,
        partner_app_installed: true,
      },
    }),
    signalWithStartWhatsAppCallWorkflow: async (params) => {
      calls.push({ name: "signal", params });
    },
    upsertWhatsAppCallSessionFromEvent: async (params) => {
      calls.push({ name: "upsert", params });
      return {
        _id: "session-1",
        callId: "wacid.1",
        phoneNumberId: "phone-1",
        state: "incoming",
      };
    },
    ...overrides,
  };

  return { calls, deps };
}

test("persists call events, reduces sessions, links conversations, emits realtime, and signals Temporal", async () => {
  const { calls, deps } = createDependencies();
  const { logger } = createRecordingLogger();
  const tryHandleWhatsAppCallWebhook = createWhatsAppCallWebhookHandler(deps);

  const response = await tryHandleWhatsAppCallWebhook({
    body: buildCallWebhookBody(),
    requestLogger: logger,
  });

  assert.ok(response);
  assert.deepEqual(await response.json(), {
    status: "ok",
    message: "calls processed",
    received: 1,
  });
  assert.deepEqual(
    calls.map((call) => call.name),
    ["persist", "upsert", "link", "realtime", "signal"],
  );
  const persisted = calls[0]?.params as {
    workspaceId?: string;
    sourceId?: string | null;
    event?: { callId?: string | null; event?: string | null };
    eventAt?: Date | null;
  };
  assert.equal(persisted.workspaceId, "workspace-1");
  assert.equal(persisted.sourceId, "source-1");
  assert.equal(persisted.event?.callId, "wacid.1");
  assert.equal(persisted.event?.event, "connect");
  assert.deepEqual(persisted.eventAt, new Date("2026-02-02T02:40:00.000Z"));
  assert.deepEqual(calls[3]?.params, {
    workspaceId: "workspace-1",
    conversationId: "conversation-1",
    callSessionId: "session-1",
    state: "incoming",
  });
  assert.deepEqual(calls[4]?.params, {
    workspaceId: "workspace-1",
    sourceId: "source-1",
    callSessionId: "session-1",
    callId: "wacid.1",
    conversationId: "conversation-1",
    phoneNumberId: "phone-1",
    state: "incoming",
    sessionSdp: "v=0\r\no=- 123 456 IN IP4 127.0.0.1",
    sessionSdpType: "offer",
    receivedAt: "2026-02-02T02:40:00.000Z",
  });
});

test("acknowledges stored call webhooks when session reduction fails", async () => {
  const { calls, deps } = createDependencies({
    upsertWhatsAppCallSessionFromEvent: async () => {
      calls.push({ name: "upsert", params: null });
      throw new Error("session reducer down");
    },
  });
  const { errors, logger } = createRecordingLogger();
  const tryHandleWhatsAppCallWebhook = createWhatsAppCallWebhookHandler(deps);

  const response = await tryHandleWhatsAppCallWebhook({
    body: buildCallWebhookBody(),
    requestLogger: logger,
  });

  assert.ok(response);
  assert.deepEqual(await response.json(), {
    status: "ok",
    message: "calls processed",
    received: 1,
  });
  assert.deepEqual(
    calls.map((call) => call.name),
    ["persist", "upsert"],
  );
  assert.equal(errors[0]?.[0], "WhatsApp call session reduction failed");
  assert.deepEqual(errors[0]?.[2], {
    workspaceId: "workspace-1",
    sourceId: "source-1",
    callId: "wacid.1",
    event: "connect",
    status: null,
  });
});

test("signals Temporal even when conversation linking fails", async () => {
  const { calls, deps } = createDependencies({
    linkWhatsAppCallSessionToConversation: async () => {
      calls.push({ name: "link", params: null });
      throw new Error("conversation linker down");
    },
  });
  const { errors, logger } = createRecordingLogger();
  const tryHandleWhatsAppCallWebhook = createWhatsAppCallWebhookHandler(deps);

  const response = await tryHandleWhatsAppCallWebhook({
    body: buildCallWebhookBody(),
    requestLogger: logger,
  });

  assert.ok(response);
  assert.deepEqual(await response.json(), {
    status: "ok",
    message: "calls processed",
    received: 1,
  });
  assert.equal(errors[0]?.[0], "WhatsApp call conversation linking failed");
  assert.deepEqual(
    calls.map((call) => call.name),
    ["persist", "upsert", "link", "signal"],
  );
  assert.equal(
    (calls[3]?.params as { conversationId?: string | null }).conversationId,
    null,
  );
});

test("skips call processing when the resolved source is disconnected", async () => {
  const { calls, deps } = createDependencies({
    resolveWhatsAppSourceByAccountIdentifiers: async () => ({
      id: "source-1",
      workspace_id: "workspace-1",
      skipReason: "partner_removed",
    }),
  });
  const { logger } = createRecordingLogger();
  const tryHandleWhatsAppCallWebhook = createWhatsAppCallWebhookHandler(deps);

  const response = await tryHandleWhatsAppCallWebhook({
    body: buildCallWebhookBody(),
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
