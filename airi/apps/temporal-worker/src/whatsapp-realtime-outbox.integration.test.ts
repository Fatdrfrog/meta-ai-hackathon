import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import mongoose from "mongoose";

const fixtureUri = process.env.MONGO_COST_TEST_URI;
test(
  "real Mongo WhatsApp outbox repairs crash and deduplicates provider IDs across restarts",
  { skip: !fixtureUri, timeout: 60_000 },
  async () => {
    const uri = new URL(fixtureUri!);
    assert.equal(uri.protocol, "mongodb:");
    assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(uri.hostname));
    assert.equal(uri.port, "27277");
    assert.equal(uri.username, "");
    assert.equal(uri.password, "");
    assert.equal(uri.pathname, "/airi_mongo_index_cost_tests");
    assert.equal(uri.searchParams.get("replicaSet"), "airiCostTests");
    const databaseName = `airi_mongo_index_cost_tests_realtime_${randomUUID().replaceAll("-", "").slice(0, 20)}`;
    uri.pathname = `/${databaseName}`;
    process.env.MONGODB_URI = uri.toString();
    await mongoose.connect(uri.toString());
    try {
      const serverNamespace = await import("@/lib/realtime/server");
      const server =
        (serverNamespace as unknown as { default?: typeof serverNamespace })
          .default || serverNamespace;
      const modelNamespace = await import("@/models/realtime-event");
      const { RealtimeEvent } =
        (modelNamespace as unknown as { default?: typeof modelNamespace })
          .default || modelNamespace;
      const input = {
        workspaceId: "workspace-fixture",
        conversationId: new mongoose.Types.ObjectId().toString(),
        message: {
          _id: new mongoose.Types.ObjectId().toString(),
          messageId: "wamid.fixture-provider-message",
          direction: "inbound",
          date: new Date(0).toISOString(),
          text: "fixture only",
        },
      };
      // A saved message survived a crash before intent creation; retry repairs it.
      await mongoose.connection
        .collection<{ _id: string }>("messages")
        .insertOne(input.message);
      const first = await server.enqueueWhatsAppMessageRealtimeEvent(input);
      assert.ok(first);
      const stored = await RealtimeEvent.findOne({
        eventId: first.eventId,
      }).lean<{ status: string; nextAttemptAt?: Date } | null>();
      assert.equal(stored?.status, "pending");
      assert.ok(stored?.nextAttemptAt instanceof Date);
      const retry = await server.enqueueWhatsAppMessageRealtimeEvent({
        ...input,
        message: { ...input.message, text: "later hydration" },
      });
      assert.deepEqual(retry, first);
      await Promise.all(
        Array.from({ length: 4 }, () =>
          server.enqueueWhatsAppMessageRealtimeEvent(input),
        ),
      );
      assert.equal(
        await RealtimeEvent.countDocuments({ eventId: first.eventId }),
        1,
      );
      await RealtimeEvent.updateOne(
        { eventId: first.eventId },
        { $set: { status: "published", publishedAt: new Date() } },
      );
      assert.equal(
        await server.enqueueWhatsAppMessageRealtimeEvent(input),
        null,
      );
      const recovered = { ...input, recoveryRevision: "revision-fixture" };
      const updated =
        await server.enqueueWhatsAppMessageRealtimeEvent(recovered);
      assert.ok(updated);
      assert.notEqual(updated.eventId, first.eventId);
      assert.equal(updated.payload.messageId, input.message._id);
      assert.deepEqual(
        await server.enqueueWhatsAppMessageRealtimeEvent(recovered),
        updated,
      );
      assert.equal(await RealtimeEvent.countDocuments({}), 2);
    } finally {
      assert.equal(mongoose.connection.name, databaseName);
      await mongoose.connection.dropDatabase();
      await mongoose.disconnect();
    }
  },
);
