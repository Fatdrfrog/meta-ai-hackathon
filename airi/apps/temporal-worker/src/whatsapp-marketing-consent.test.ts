import assert from "node:assert/strict";
import test from "node:test";

test("writes one canonical audit event and updates matching conversations", async () => {
  process.env.MONGODB_URI ||= "mongodb://127.0.0.1:27017/icecore-test";
  process.env.NEXT_PUBLIC_SUPABASE_URL ||= "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY ||= "test-service-role-key";
  const { createWhatsAppMarketingConsentUpserter } = await import(
    "@/lib/whatsapp/marketing-consent"
  );

  const upserts: Array<{
    table: string;
    values: Record<string, unknown>;
    options: Record<string, unknown>;
  }> = [];
  const updates: Array<{
    query: Record<string, unknown>;
    update: Record<string, unknown>;
  }> = [];
  let connectCount = 0;
  const upsertWhatsAppMarketingConsent = createWhatsAppMarketingConsentUpserter(
    {
      connectDB: async () => {
        connectCount += 1;
      },
      conversationModel: {
        updateMany: async (query, update) => {
          updates.push({ query, update });
          return { matchedCount: 1, modifiedCount: 1 };
        },
      },
      supabaseAdmin: {
        from: (table) => ({
          upsert: async (values, options) => {
            upserts.push({ table, values, options });
            return { error: null };
          },
        }),
      },
    },
  );

  const result = await upsertWhatsAppMarketingConsent({
    eventKey: "event-1",
    workspaceId: "workspace-1",
    sourceId: "source-1",
    wabaId: "waba-1",
    phoneNumberId: "phone-1",
    waId: "77010000001",
    status: true,
    source: "manual_import_with_proof",
    eventAt: new Date("2026-06-23T10:00:00.000Z"),
    detail: "Customer tapped opt in",
    payload: { messageId: "wamid.1" },
  });

  assert.equal(connectCount, 1);
  assert.equal(upserts[0]?.table, "whatsapp_opt_in_events");
  assert.deepEqual(upserts[0]?.options, {
    ignoreDuplicates: true,
    onConflict: "event_key",
  });
  assert.equal(upserts[0]?.values.event_key, "event-1");
  assert.equal(upserts[0]?.values.workspace_id, "workspace-1");
  assert.equal(upserts[0]?.values.source_id, "source-1");
  assert.equal(upserts[0]?.values.waba_id, "waba-1");
  assert.equal(upserts[0]?.values.phone_number_id, "phone-1");
  assert.equal(upserts[0]?.values.wa_id, "77010000001");
  assert.equal(upserts[0]?.values.status, true);
  assert.equal(upserts[0]?.values.source, "manual_import_with_proof");
  assert.equal(upserts[0]?.values.detail, "Customer tapped opt in");
  assert.deepEqual(updates[0]?.query, {
    $and: [{ $or: [
      { "whatsapp_opt_in.updatedAt": { $lt: new Date("2026-06-23T10:00:00.000Z") } },
      { "whatsapp_opt_in.updatedAt": { $exists: false } },
      { "whatsapp_opt_in.updatedAt": null },
    ] }],
    workspaceId: "workspace-1",
    channel: "whatsapp",
    $or: [
      { chat: { $in: ["wa_77010000001"] } },
      { user: { $in: ["wa_77010000001"] } },
      { "participants.from": { $in: ["77010000001"] } },
      { "participants.to": { $in: ["77010000001"] } },
    ],
  });
  assert.deepEqual(updates[0]?.update, {
    $set: {
      "whatsapp_opt_in.status": true,
      "whatsapp_opt_in.updatedAt": new Date("2026-06-23T10:00:00.000Z"),
      "whatsapp_opt_in.source": "manual_import_with_proof",
    },
  });
  assert.deepEqual(result, {
    eventKey: "event-1",
    matchedConversations: 1,
    modifiedConversations: 1,
  });
});

