import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import mongoose from "mongoose";

import WhatsAppWebhookEvent, {
  WHATSAPP_WEBHOOK_PAYLOAD_COMPACTION_INDEX,
} from "@icecore/airi-runtime/whatsapp-webhook-event-model";
import { ensureWhatsAppWebhookEventIndexes } from "@icecore/airi-runtime/whatsapp-webhook-event-indexes";
import { buildWhatsAppWebhookEventEnvelopes } from "@icecore/airi-runtime/whatsapp-webhook-event-envelopes";
import { compactCompletedWhatsAppWebhookEventPayloads } from "@icecore/airi-runtime/whatsapp-webhook-event-retention";

import { claimWhatsAppWebhookEventForReplay } from "./whatsapp-webhook-replay-claim";

const testMongoUri = process.env.WHATSAPP_WEBHOOK_RETENTION_TEST_MONGODB_URI;

type StoredWebhookEvent = Record<string, unknown> & {
  status: string;
  payload?: unknown;
  processingCursor?: unknown;
  originalPayloadHash?: string;
  payloadCompactedAt?: Date;
  completedAt?: Date | null;
};

async function loadStoredEvent(eventId: unknown): Promise<StoredWebhookEvent> {
  const event = await WhatsAppWebhookEvent.findById(
    eventId,
  ).lean<StoredWebhookEvent | null>();
  assert.ok(event);
  return event;
}

test(
  "real Mongo compacts completed payloads while retaining recoverability and provider dedupe",
  { skip: !testMongoUri },
  async () => {
    const uri = new URL(testMongoUri!);
    assert.ok(
      ["127.0.0.1", "localhost", "[::1]"].includes(uri.hostname),
      "integration Mongo must be local",
    );
    assert.equal(
      uri.pathname,
      "/airi_webhook_retention_tests",
      "integration Mongo must use the isolated test database",
    );
    await mongoose.connect(testMongoUri!, {
      autoIndex: false,
      autoCreate: false,
    });
    const prefix = `retention-test:${randomUUID()}`;
    const dedupeKeys: string[] = [];
    const now = new Date("2026-10-02T12:00:00.000Z");
    const cutoff = new Date("2026-09-02T12:00:00.000Z");
    try {
      await ensureWhatsAppWebhookEventIndexes();
      const indexes = await WhatsAppWebhookEvent.collection.indexes();
      const retentionIndex = indexes.find(
        (index) =>
          index.name === WHATSAPP_WEBHOOK_PAYLOAD_COMPACTION_INDEX.options.name,
      );
      assert.deepEqual(retentionIndex?.partialFilterExpression, {
        status: "completed",
        payloadCompactedAt: null,
      });
      assert.equal(retentionIndex?.expireAfterSeconds, undefined);
      const indexName = retentionIndex?.name;
      assert.ok(indexName);

      const body = {
        object: "whatsapp_business_account",
        entry: [
          {
            id: `${prefix}:waba`,
            changes: [
              {
                field: "messages",
                value: {
                  metadata: { phone_number_id: `${prefix}:phone` },
                  messages: [
                    {
                      id: `${prefix}:message`,
                      from: "15550001",
                      type: "text",
                      text: { body: "original message" },
                    },
                  ],
                },
              },
            ],
          },
        ],
      };
      const envelope = buildWhatsAppWebhookEventEnvelopes({
        body,
        rawBody: JSON.stringify(body),
        receivedAt: new Date("2026-08-01"),
      })[0];
      dedupeKeys.push(envelope.dedupeKey);
      const completed = await WhatsAppWebhookEvent.create({
        ...envelope,
        status: "completed",
        completedAt: new Date("2026-08-01"),
        originalPayloadHash: "original-hash",
        processingCursor: { raw: "cursor" },
      });
      // Older records predate the marker field; null equality must cover absence.
      await WhatsAppWebhookEvent.collection.updateOne(
        { _id: completed._id },
        { $unset: { payloadCompactedAt: "" } },
      );
      const recoveryIds: unknown[] = [];
      for (const status of [
        "received",
        "published",
        "queued",
        "processing",
        "failed",
        "dead",
      ]) {
        const dedupeKey = `${prefix}:${status}`;
        dedupeKeys.push(dedupeKey);
        const event = await WhatsAppWebhookEvent.create({
          ...envelope,
          dedupeKey,
          status,
          completedAt: new Date("2026-08-01"),
          payload: { raw: status },
        });
        recoveryIds.push(event._id);
      }
      const recentKey = `${prefix}:recent`;
      dedupeKeys.push(recentKey);
      const recent = await WhatsAppWebhookEvent.create({
        ...envelope,
        dedupeKey: recentKey,
        status: "completed",
        completedAt: now,
      });
      const missingKey = `${prefix}:missing-completed-at`;
      dedupeKeys.push(missingKey);
      const missing = await WhatsAppWebhookEvent.create({
        ...envelope,
        dedupeKey: missingKey,
        status: "completed",
        completedAt: null,
      });

      const filter = {
        status: "completed",
        completedAt: { $type: "date", $lte: cutoff },
        payloadCompactedAt: null,
        payload: { $exists: true, $ne: null },
      };
      const explain = await WhatsAppWebhookEvent.collection
        .find(filter, { projection: { _id: 1 } })
        .sort({ completedAt: 1, _id: 1 })
        .limit(1)
        .hint(indexName)
        .explain("executionStats");
      assert.match(
        JSON.stringify(explain.queryPlanner.winningPlan),
        /whatsapp_webhook_events_payload_compaction/,
      );
      assert.ok(explain.executionStats.totalDocsExamined <= 1);

      const preview = await compactCompletedWhatsAppWebhookEventPayloads({
        model: WhatsAppWebhookEvent,
        now,
        limit: 1,
      });
      assert.equal(preview.scanned, 1);
      assert.equal(preview.compacted, 0);
      assert.ok((await loadStoredEvent(completed._id)).payload);
      const applied = await compactCompletedWhatsAppWebhookEventPayloads({
        model: WhatsAppWebhookEvent,
        now,
        limit: 1,
        dryRun: false,
      });
      assert.equal(applied.compacted, 1);
      const receipt = await loadStoredEvent(completed._id);
      assert.equal(receipt.status, "completed");
      assert.equal(receipt.payload, undefined);
      assert.equal(receipt.processingCursor, undefined);
      assert.equal(receipt.originalPayloadHash, "original-hash");
      assert.deepEqual(receipt.payloadCompactedAt, now);
      await WhatsAppWebhookEvent.hydrate(receipt).validate();
      assert.equal(
        await WhatsAppWebhookEvent.countDocuments({
          _id: { $in: recoveryIds },
          payload: { $exists: true },
          payloadCompactedAt: null,
        }),
        6,
      );
      assert.ok((await loadStoredEvent(recent._id)).payload);
      assert.ok((await loadStoredEvent(missing._id)).payload);

      const { enqueueWhatsAppWebhookEvents } = await import(
        "@/lib/whatsapp/webhook-event-ingest"
      );
      const redelivery = await enqueueWhatsAppWebhookEvents({
        body,
        rawBody: JSON.stringify(body),
        receivedAt: now,
      });
      assert.equal(redelivery.skippedAlreadyHandled, 1);
      assert.equal(redelivery.published, 0);
      assert.equal((await loadStoredEvent(completed._id)).payload, undefined);
      const replay = await claimWhatsAppWebhookEventForReplay({
        model: WhatsAppWebhookEvent,
        eventId: completed._id,
        status: "completed",
        now,
      });
      assert.equal(replay.status, "skipped");
      assert.equal((await loadStoredEvent(completed._id)).status, "completed");

      const raceKey = `${prefix}:replay-race`;
      dedupeKeys.push(raceKey);
      const raceEvent = await WhatsAppWebhookEvent.create({
        ...envelope,
        dedupeKey: raceKey,
        status: "completed",
        completedAt: new Date("2026-08-01"),
      });
      const raced = await compactCompletedWhatsAppWebhookEventPayloads({
        model: {
          find: WhatsAppWebhookEvent.find.bind(WhatsAppWebhookEvent),
          updateMany: async (match, update, options) => {
            const replayClaim = await claimWhatsAppWebhookEventForReplay({
              model: WhatsAppWebhookEvent,
              eventId: raceEvent._id,
              status: "completed",
              now,
            });
            assert.equal(replayClaim.status, "ready");
            return WhatsAppWebhookEvent.updateMany(match, update, options);
          },
        },
        now,
        limit: 1,
        dryRun: false,
      });
      assert.equal(raced.scanned, 1);
      assert.equal(raced.compacted, 0);
      const claimedForReplay = await loadStoredEvent(raceEvent._id);
      assert.equal(claimedForReplay.status, "failed");
      assert.equal(claimedForReplay.completedAt, null);
      assert.ok(claimedForReplay.payload);
      console.log(
        JSON.stringify({
          retentionExplain: {
            indexName,
            totalDocsExamined: explain.executionStats.totalDocsExamined,
            totalKeysExamined: explain.executionStats.totalKeysExamined,
          },
          preview,
          applied,
        }),
      );
    } finally {
      await WhatsAppWebhookEvent.deleteMany({ dedupeKey: { $in: dedupeKeys } });
      await mongoose.disconnect();
    }
  },
);
