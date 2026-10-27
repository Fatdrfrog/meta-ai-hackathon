import assert from "node:assert/strict";
import test from "node:test";

import { createWhatsAppGroupWebhookHandler } from "./whatsapp-groups-handler";
import { createRecordingLogger } from "./testing/recording-logger";

test("processes WhatsApp group webhook events through injected persistence", async () => {
  const { logger, successes } = createRecordingLogger();
  const upsertedEvents: unknown[] = [];
  const upsertedStates: unknown[] = [];
  const realtimeEvents: unknown[] = [];
  const resolvedSources: unknown[] = [];
  const tryHandleWhatsAppGroupWebhook = createWhatsAppGroupWebhookHandler({
    buildWhatsAppWebhookSourceSkipPayload: (skip) => ({
      reason: skip.reason,
      status: "ok",
    }),
    getWhatsAppWebhookSourceSkip: () => null,
    invalidateRequestsForWorkspace: async (workspaceId) => {
      assert.equal(workspaceId, "workspace-1");
    },
    realtime: {
      trigger: async (channel, event, payload) => {
        realtimeEvents.push({ channel, event, payload });
      },
    },
    resolveWhatsAppSourceByAccountIdentifiers: async (params) => {
      resolvedSources.push(params);
      return {
        id: "source-1",
        workspace_id: "workspace-1",
      };
    },
    upsertWhatsAppGroupEvent: async (params) => {
      upsertedEvents.push(params);
    },
    upsertWhatsAppGroupState: async (params) => {
      upsertedStates.push(params);
    },
  });

  const response = await tryHandleWhatsAppGroupWebhook({
    body: {
      object: "whatsapp_business_account",
      entry: [{ id: "waba-1", changes: [] }],
    },
    change: {
      field: "group_participants_update",
      value: {
        groups: [
          {
            added_participants: [
              {
                input: "+15551234567",
                user_id: "wa_bsuid_123",
                wa_id: "15551234567",
              },
            ],
            group_id: "group-1",
            request_id: "request-1",
            timestamp: "1783000000",
            type: "participants_added",
          },
        ],
        metadata: {
          display_phone_number: "+15557654321",
          phone_number_id: "phone-1",
        },
      },
    },
    requestLogger: logger,
  });

  assert.ok(response);
  assert.deepEqual(await response.json(), {
    groups: 1,
    message: "group_participants_update processed",
    status: "ok",
  });
  assert.equal(resolvedSources.length, 1);
  assert.equal(
    (resolvedSources[0] as { messagingAccountId?: string }).messagingAccountId,
    "waba-1",
  );
  assert.equal(
    (resolvedSources[0] as { phoneNumberId?: string }).phoneNumberId,
    "phone-1",
  );
  assert.equal((resolvedSources[0] as { wabaId?: string }).wabaId, "waba-1");
  assert.equal(upsertedEvents.length, 1);
  assert.equal(upsertedStates.length, 1);
  assert.deepEqual(
    (upsertedEvents[0] as { event: { addedParticipants: unknown[] } }).event
      .addedParticipants,
    [
      {
        input: "+15551234567",
        parentUserId: null,
        userId: "wa_bsuid_123",
        username: null,
        waId: "15551234567",
      },
    ],
  );
  assert.deepEqual(realtimeEvents, [
    {
      channel: "tenant-workspace-1",
      event: "whatsapp.group.updated",
      payload: {
        eventCount: 1,
        field: "group_participants_update",
        groups: [
          {
            groupId: "group-1",
            phoneNumberId: "phone-1",
            type: "participants_added",
          },
        ],
        sourceId: "source-1",
        workspaceId: "workspace-1",
      },
    },
  ]);
  assert.ok(
    successes.some(
      ([message]) => message === "WhatsApp group webhook processed",
    ),
  );
});

test("returns null for non-group WhatsApp webhook fields", async () => {
  const { logger } = createRecordingLogger();
  const tryHandleWhatsAppGroupWebhook = createWhatsAppGroupWebhookHandler({
    buildWhatsAppWebhookSourceSkipPayload: (skip) => skip,
    getWhatsAppWebhookSourceSkip: () => null,
    resolveWhatsAppSourceByAccountIdentifiers: async () => null,
    upsertWhatsAppGroupEvent: async () => undefined,
    upsertWhatsAppGroupState: async () => undefined,
  });

  const response = await tryHandleWhatsAppGroupWebhook({
    body: {
      object: "whatsapp_business_account",
      entry: [{ id: "waba-1", changes: [] }],
    },
    change: { field: "messages", value: {} },
    requestLogger: logger,
  });

  assert.equal(response, null);
});
