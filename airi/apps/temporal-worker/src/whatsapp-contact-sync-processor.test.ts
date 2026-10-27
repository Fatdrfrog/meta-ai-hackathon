import assert from "node:assert/strict";
import { mock, test } from "node:test";

process.env.MONGODB_URI ||= "mongodb://127.0.0.1:27017/icecore-test";

const { processWhatsAppContactSyncWebhook } = await import(
  "./whatsapp-contact-sync/processor.js"
);
const { buildContactSyncWebhookState } = await import(
  "@icecore/shared/lib/whatsapp/contact-sync-state"
);

function createCustomerModel(overrides: Record<string, unknown> = {}) {
  return {
    findOne: mock.fn(async () => null),
    create: mock.fn(async () => ({ _id: "customer-1" })),
    updateOne: mock.fn(async () => ({})),
    ...overrides,
  } as any;
}

test("creates an active contact customer for add events", async () => {
  const customerModel = createCustomerModel();
  const persistCredentials = mock.fn(
    async (_credentials: Record<string, unknown>) => undefined,
  );

  const result = await processWhatsAppContactSyncWebhook({
    source: {
      id: "source-1",
      workspace_id: "workspace-1",
      credentials: {
        contact_sync: {
          requested_at: "2026-01-01T00:00:00.000Z",
          status: "requested",
        },
      },
    },
    phoneNumberId: "phone-business-1",
    stateSync: [
      {
        action: "add",
        contact_full_name: "Pablo Morales",
        contact_first_name: "Pablo",
        contact_phone_number: "+1 (650) 555-1234",
        timestamp: "1739321024",
      },
    ],
    persistCredentials,
    receivedAt: "2026-05-06T12:00:00.000Z",
    connect: async () => undefined,
    customerModel,
  });

  assert.deepEqual(result, { processedCount: 1, skippedCount: 0 });
  const created = customerModel.create.mock.calls[0]?.arguments[0] as any;
  assert.equal(created.workspaceId, "workspace-1");
  assert.equal(created.status, "active");
  assert.equal(created.displayName, "Pablo Morales");
  assert.equal(created.identities[0].type, "phone");
  assert.equal(created.identities[0].channel, "whatsapp");
  assert.equal(created.identities[0].normalizedValue, "16505551234");
  assert.deepEqual(created.profileSummary.channels, ["whatsapp"]);
  assert.deepEqual(created.profileSummary.contactPoints.phones, [
    "16505551234",
  ]);
  assert.equal(created.profileSummary.conversationCount, 0);

  const persisted = persistCredentials.mock.calls[0]?.arguments[0] as any;
  assert.equal(persisted.contact_sync.status, "in_progress");
  assert.equal(persisted.contact_sync.processed_count_total, 1);
  assert.equal(persisted.contact_sync.skipped_count_total, 0);
  assert.equal(persisted.contact_sync.webhook_count, 1);
  assert.equal(
    persisted.contact_sync.last_webhook_at,
    "2026-05-06T12:00:00.000Z",
  );
});

test("creates contact customers from BSUID-only state sync contacts", async () => {
  const customerModel = createCustomerModel();

  const result = await processWhatsAppContactSyncWebhook({
    source: {
      id: "source-1",
      workspace_id: "workspace-1",
      credentials: {},
    },
    phoneNumberId: "phone-business-1",
    stateSync: [
      {
        type: "contact",
        action: "add",
        contact: {
          full_name: "Private Customer",
          user_id: "US.1349.private",
          parent_user_id: "US.parent.private",
          username: "@private_customer",
        },
      },
    ],
    persistCredentials: async () => undefined,
    receivedAt: "2026-05-06T12:00:00.000Z",
    connect: async () => undefined,
    customerModel,
  });

  assert.deepEqual(result, { processedCount: 1, skippedCount: 0 });
  const findFilter = customerModel.findOne.mock.calls[0]?.arguments[0] as any;
  assert.equal(findFilter.workspaceId, "workspace-1");
  assert.ok(
    findFilter.$or.some(
      (filter: any) =>
        filter.identities?.$elemMatch?.type === "whatsapp_user_id" &&
        filter.identities.$elemMatch.normalizedValue === "US.1349.private",
    ),
  );

  const created = customerModel.create.mock.calls[0]?.arguments[0] as any;
  assert.equal(created.displayName, "Private Customer");
  assert.ok(
    created.identities.some(
      (identity: any) =>
        identity.type === "whatsapp_parent_user_id" &&
        identity.normalizedValue === "US.parent.private",
    ),
  );
  assert.deepEqual(created.profileSummary.contactPoints.usernames, [
    "@private_customer",
  ]);
  assert.deepEqual(created.profileSummary.contactPoints.whatsappUserIds, [
    "US.1349.private",
  ]);
});

test("archives contact-only customers for remove events", async () => {
  const customerModel = createCustomerModel({
    findOne: mock.fn(async () => ({
      _id: "customer-1",
      workspaceId: "workspace-1",
      displayName: "Pablo Morales",
      status: "active",
      conversationIds: [],
      identities: [],
      profileSummary: null,
    })),
  });

  const result = await processWhatsAppContactSyncWebhook({
    source: {
      id: "source-1",
      workspace_id: "workspace-1",
      credentials: {},
    },
    phoneNumberId: "phone-business-1",
    stateSync: {
      action: "remove",
      contact_phone_number: "16505551234",
    },
    persistCredentials: async () => undefined,
    receivedAt: "2026-05-06T12:00:00.000Z",
    connect: async () => undefined,
    customerModel,
  });

  assert.deepEqual(result, { processedCount: 1, skippedCount: 0 });
  assert.deepEqual(customerModel.updateOne.mock.calls[0]?.arguments, [
    { _id: "customer-1" },
    {
      $set: {
        status: "archived",
      },
    },
  ]);
});

test("does not archive customers with linked conversations on remove", async () => {
  const customerModel = createCustomerModel({
    findOne: mock.fn(async () => ({
      _id: "customer-1",
      workspaceId: "workspace-1",
      displayName: "Pablo Morales",
      status: "active",
      conversationIds: ["conversation-1"],
      identities: [],
      profileSummary: null,
    })),
  });

  await processWhatsAppContactSyncWebhook({
    source: {
      id: "source-1",
      workspace_id: "workspace-1",
      credentials: {},
    },
    phoneNumberId: "phone-business-1",
    stateSync: {
      action: "remove",
      contact_phone_number: "16505551234",
    },
    persistCredentials: async () => undefined,
    receivedAt: "2026-05-06T12:00:00.000Z",
    connect: async () => undefined,
    customerModel,
  });

  assert.equal(customerModel.updateOne.mock.calls.length, 0);
});

test("adds webhook counters to existing contact sync state", () => {
  assert.deepEqual(
    buildContactSyncWebhookState({
      current: {
        requested_at: "2026-01-01T00:00:00.000Z",
        status: "requested",
        processed_count_total: 2,
        skipped_count_total: 1,
        webhook_count: 3,
      },
      processedCount: 4,
      skippedCount: 2,
      receivedAt: "2026-05-06T12:00:00.000Z",
    }),
    {
      requested_at: "2026-01-01T00:00:00.000Z",
      status: "in_progress",
      processed_count_total: 6,
      skipped_count_total: 3,
      webhook_count: 4,
      last_processed_count: 4,
      last_skipped_count: 2,
      last_webhook_at: "2026-05-06T12:00:00.000Z",
    },
  );
});
