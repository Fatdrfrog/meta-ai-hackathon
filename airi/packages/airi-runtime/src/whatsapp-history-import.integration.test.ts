import assert from "node:assert/strict";
import test from "node:test";

test(
  "history receipts reconcile retries, revisions, late chunks and provider errors in isolated local Mongo",
  { skip: process.env.WHATSAPP_HISTORY_TEST_MONGO !== "1", timeout: 60_000 },
  async () => {
    const dbName = `airi_history_fixture_${process.pid}_${Date.now()}`;
    // Deliberately ignore ambient database credentials. This test can only use loopback.
    process.env.MONGODB_URI = `mongodb://127.0.0.1:27017/${dbName}`;
    const mongoose = (await import("mongoose")).default;
    const { default: connectDB } = await import("./mongoose");
    const { default: events } = await import("./whatsapp-webhook-event-model");
    const { ensureWhatsAppWebhookEventIndexes } = await import(
      "./whatsapp-webhook-event-indexes"
    );
    const { attachWhatsAppHistoryImportBinding } = await import(
      "./whatsapp-history-import"
    );
    const { buildWhatsAppWebhookEventEnvelopes } = await import(
      "./whatsapp-webhook-event-envelopes"
    );
    const { expandWhatsAppHistoryChunk, readWhatsAppHistorySyncState } =
      await import("./whatsapp-history-import-store");
    await connectDB();
    try {
      await ensureWhatsAppWebhookEventIndexes();
      const binding = {
        sessionId: "session-current",
        sessionStartedAt: "2026-10-10T00:00:00Z",
        rangeDays: 180,
        sourceId: "source-1",
        workspaceId: "workspace-1",
        phoneNumberId: "phone-1",
      };
      const historySync = {
        session_id: binding.sessionId,
        requested_at: binding.sessionStartedAt,
      };
      const read = () =>
        readWhatsAppHistorySyncState({
          workspaceId: binding.workspaceId,
          sourceId: binding.sourceId,
          historySync,
        });
      const body = {
        object: "whatsapp_business_account",
        entry: [
          {
            changes: [
              {
                field: "history",
                value: {
                  metadata: { phone_number_id: "phone-1" },
                  history: [
                    {
                      metadata: { phase: 2, progress: 100, chunk_order: 1 },
                      threads: [
                        {
                          id: "15550000001",
                          messages: [
                            { id: "wamid.one", type: "media_placeholder" },
                            {
                              id: "wamid.one",
                              type: "image",
                              image: { id: "media-one" },
                            },
                            {
                              id: "wamid.two",
                              type: "text",
                              text: { body: "two" },
                            },
                          ],
                        },
                      ],
                    },
                  ],
                },
              },
            ],
          },
        ],
      };
      const parent = attachWhatsAppHistoryImportBinding(
        buildWhatsAppWebhookEventEnvelopes({
          body,
          rawBody: JSON.stringify(body),
        })[0]!,
        binding,
      );
      const storedParent = await events.create({
        ...parent,
        status: "processing",
        processingLeaseId: "lease",
        firstReceivedAt: new Date(),
        providerSignatureVerified: true,
      });
      const params = {
        parent,
        eventId: String(storedParent._id),
        processingLeaseId: "lease",
        providerSignatureVerified: true,
      };
      const children = await expandWhatsAppHistoryChunk(params);
      await expandWhatsAppHistoryChunk(params);
      assert.equal(
        await events.countDocuments({ "historyImport.role": "message" }),
        3,
      );
      assert.equal((await read())?.status, "in_progress");
      for (const child of children) {
        await events.updateOne(
          { dedupeKey: child.dedupeKey },
          {
            $set: {
              status: "completed",
              completedAt: new Date(),
              "historyImport.outcome": child.payload.rawBody.includes(
                "media_placeholder",
              )
                ? "skipped"
                : "synchronized",
            },
          },
        );
      }
      await events.updateOne(
        { _id: storedParent._id },
        { $set: { status: "completed", completedAt: new Date() } },
      );
      const complete = await read();
      assert.equal(complete?.status, "completed");
      assert.equal(complete?.synchronized_count_total, 2);
      assert.equal(complete?.received_count_total, 2);
      assert.equal(complete?.skipped_count_total, 0);
      const late = await events.create({
        ...parent,
        dedupeKey: "late-current",
        status: "received",
      });
      assert.equal((await read())?.status, "in_progress");
      await events.updateOne({ _id: late._id }, { $set: { status: "dead" } });
      assert.equal((await read())?.status, "error");
      await events.updateOne(
        { _id: late._id },
        {
          $set: {
            status: "completed",
            "historyImport.outcome": "provider_error",
            "historyImport.providerErrors": [
              { code: 2593109, message: "Business declined" },
            ],
          },
        },
      );
      assert.equal((await read())?.status, "declined");
      await events.create({
        ...parent,
        dedupeKey: "other-session",
        historyImport: { ...parent.historyImport, sessionId: "old-session" },
        status: "dead",
      });
      assert.equal((await read())?.failed_chunk_count_total, 0);
    } finally {
      // Only this test's uniquely named loopback database is removed.
      assert.equal(mongoose.connection.name, dbName);
      await mongoose.connection.dropDatabase();
      await mongoose.disconnect();
    }
  },
);
