import assert from "node:assert/strict";
import { mock, test } from "node:test";
import type { mongo } from "mongoose";

test(
  "Requests source joins, durable batching, and resume hold on a local replica set",
  { timeout: 90_000 },
  async t => {
    // An isolated database on a dedicated local replica set; never accept a
    // production URI from the developer's environment for this fixture.
    const databaseName = `airi_requests_fixture_${process.pid}_${Date.now()}`;
    const address = "mongodb://127.0.0.1:28021";
    process.env.MONGODB_URI = `${address}/${databaseName}?replicaSet=airiRequestsTest`;
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "local-fixture-key";
    process.env.ENCRYPTION_SECRET = "local-fixture-key";
    process.env.PUBSUB_EMULATOR_HOST = "127.0.0.1:28022";
    process.env.GOOGLE_CLOUD_PROJECT = "airi-local-fixture";
    const { PubSub } = await import("@google-cloud/pubsub");
    const publications: unknown[] = [];
    mock.method(PubSub.prototype, "topic", () => ({
      publishMessage: async (input: unknown) => {
        publications.push(input);
        return "fixture-publication";
      },
    }));
    const mongoose = (await import("mongoose")).default;
    const bootstrap = new mongoose.mongo.MongoClient(
      `${address}/admin?directConnection=true`
    );
    await bootstrap.connect();
    try {
      try {
        await bootstrap.db().command({
          replSetInitiate: {
            _id: "airiRequestsTest",
            members: [{ _id: 0, host: "127.0.0.1:28021" }],
          },
        });
      } catch (error) {
        if (
          !(error instanceof mongoose.mongo.MongoServerError) ||
          error.code !== 23
        )
          throw error;
      }
      for (let attempt = 0; attempt < 60; attempt += 1) {
        if ((await bootstrap.db().command({ hello: 1 })).isWritablePrimary)
          break;
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    } finally {
      await bootstrap.close();
    }

    await mongoose.connect(process.env.MONGODB_URI, {
      autoIndex: false,
      autoCreate: false,
      monitorCommands: true,
      maxPoolSize: 12,
    });
    let stop: (() => Promise<void>) | undefined;
    try {
      const db = mongoose.connection.db!;
      const {
        startProductionRequestsProjectionRuntime,
        REQUESTS_PROJECTION_ROW_INDEX_DEFINITIONS,
        REQUESTS_PROJECTION_OUTBOX_INDEX_DEFINITIONS,
      } = await import("../src/lib/requests-projection/activation");
      const { ensureRequestsProjectionCheckpoint } = await import(
        "../src/lib/requests-projection/checkpoint"
      );
      const { readRequestProjectionSource } = await import(
        "../src/lib/requests-projection/source-reader"
      );
      const {
        default: Message,
        MESSAGE_REQUEST_AIRI_WITNESS_INDEX_NAME,
        MESSAGE_WHATSAPP_INBOUND_DEDUPE_INDEX,
      } = await import("../src/models/message");
      const { RealtimeEvent } = await import("../src/models/realtime-event");
      for (const name of ["conversations", "messages", "chats", "users"]) {
        await db.createCollection(name, {
          changeStreamPreAndPostImages: { enabled: true },
        });
      }
      const legacyMessageIdentityIndex = Message.schema
        .indexes()
        .find(
          ([keys, options]) =>
            keys.chat === 1 && keys.messageId === 1 && options.unique === true
        );
      assert.ok(legacyMessageIdentityIndex);
      await Message.collection.createIndex(
        legacyMessageIdentityIndex[0] as mongo.IndexSpecification,
        legacyMessageIdentityIndex[1] as mongo.CreateIndexesOptions
      );
      for (const [name, definitions] of [
        ["request_list_items", REQUESTS_PROJECTION_ROW_INDEX_DEFINITIONS],
        [
          RealtimeEvent.collection.collectionName,
          REQUESTS_PROJECTION_OUTBOX_INDEX_DEFINITIONS,
        ],
      ] as const) {
        for (const definition of definitions)
          await db
            .collection(name)
            .createIndex(definition.keys, definition.options);
      }
      await ensureRequestsProjectionCheckpoint();
      await db
        .collection("messages")
        .createIndex({ conversation: 1, date: 1, _id: 1 });
      await db
        .collection("messages")
        .createIndex(
          { conversation: 1, direction: 1, "origin.kind": 1, _id: -1 },
          { name: MESSAGE_REQUEST_AIRI_WITNESS_INDEX_NAME }
        );
      const id = new mongoose.Types.ObjectId();
      const customerObjectId = new mongoose.Types.ObjectId();
      await db.collection("users").insertMany([
        { _id: 123 as never, firstName: "Numeric" },
        { _id: "123" as never, firstName: "String" },
        { _id: customerObjectId, firstName: "Object" },
      ]);
      await db.collection("chats").insertOne({
        _id: "fixture-chat" as never,
        type: "private",
        title: "Fixture",
      });
      await db.collection("conversations").insertOne({
        _id: id,
        workspaceId: "fixture-workspace",
        channel: "telegram",
        status: "open",
        user: customerObjectId,
        chat: "fixture-chat",
        createdAt: new Date(),
        is_read_by_manager: false,
      });
      const witnessId = new mongoose.Types.ObjectId();
      await db.collection("messages").insertMany([
        {
          _id: witnessId,
          conversation: id,
          date: new Date(1),
          direction: "outbound",
          origin: { kind: "airi" },
          text: "Airi : historical answer",
        },
        {
          conversation: id,
          date: new Date(2),
          direction: "outbound",
          origin: { kind: "airi" },
          text: "Airi: template",
          whatsappTemplate: { name: "campaign" },
        },
        {
          conversation: id,
          date: new Date(3),
          direction: "outbound",
          origin: { kind: "manager" },
          text: "Airi: manually copied",
        },
        {
          conversation: id,
          date: new Date(4),
          author: 123,
          direction: "inbound",
          text: "Numeric identity",
        },
        {
          conversation: id,
          date: new Date(5),
          author: "123",
          direction: "inbound",
          text: "String identity",
        },
      ]);
      const session = await mongoose.startSession({ causalConsistency: true });
      const sourceTime = (await db.command({ hello: 1 })).$clusterTime
        .clusterTime;
      const commands: mongo.CommandStartedEvent[] = [];
      const capture = (event: mongo.CommandStartedEvent) => {
        commands.push(event);
      };
      mongoose.connection.getClient().on("commandStarted", capture);
      const source = await readRequestProjectionSource({
        conversationId: id,
        session,
        sourceClusterTime: sourceTime,
      });
      mongoose.connection.getClient().off("commandStarted", capture);
      await session.endSession();
      assert.ok(source);
      assert.equal(source.messages.length, 2);
      assert.equal(source.messages[0].text, "String identity");
      assert.deepEqual(
        new Set(source.users.map(user => typeof user._id)),
        new Set(["number", "string", "object"])
      );
      assert.equal(String(source.airiWitness?._id), witnessId.toHexString());
      assert.equal(source.chat?.title, "Fixture");
      assert.equal(commands.length, 1);
      assert.equal(commands[0].commandName, "aggregate");
      assert.equal(commands[0].command.readConcern.level, "majority");
      assert.ok(
        commands[0].command.readConcern.afterClusterTime.greaterThanOrEqual(
          sourceTime
        )
      );

      const errors: Error[] = [];
      await db
        .collection("requests_projection_checkpoint_v2")
        .updateOne(
          { _id: "requests-read-model:v2" as never },
          { $set: { state: "ready", clusterTime: sourceTime } }
        );
      stop = await startProductionRequestsProjectionRuntime({
        signal: new AbortController().signal,
        ownerToken: "fixture-first",
        realtimeEnabled: true,
        onFatal: error => {
          errors.push(error);
        },
      });
      const before = await db
        .collection("requests_projection_checkpoint_v2")
        .findOne({ _id: "requests-read-model:v2" as never });
      const started = performance.now();
      await db.collection("messages").insertMany(
        Array.from({ length: 128 }, (_, index) => ({
          conversation: id,
          workspaceId: "fixture-workspace",
          direction: "inbound",
          channel: "telegram",
          date: new Date(1000 + index),
          text: `Burst ${index}`,
          author: 123,
        }))
      );
      const waitForText = async (text: string) => {
        const deadline = Date.now() + 15_000;
        while (Date.now() < deadline) {
          assert.equal(errors.length, 0, errors[0]?.message);
          const row = await db
            .collection("request_list_items")
            .findOne({ _id: id });
          if (row?.recentMessages?.[0]?.text === text) return row;
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        assert.fail(`Projection did not catch up to ${text}`);
      };
      await waitForText("Burst 127");
      await stop();
      stop = undefined;
      const after = await db
        .collection("requests_projection_checkpoint_v2")
        .findOne({ _id: "requests-read-model:v2" as never });
      const materializations =
        Number(after!.projectedCount) - Number(before!.projectedCount);
      assert.ok(
        materializations < 128,
        `Expected coalescing, got ${materializations} materializations`
      );
      assert.ok(
        (await db
          .collection(RealtimeEvent.collection.collectionName)
          .countDocuments({ name: "conversation.row.changed" })) > 0
      );
      assert.ok(
        publications.length > 0,
        "Committed rows should publish without waiting for outbox polling"
      );
      const outbox = db.collection(RealtimeEvent.collection.collectionName);
      const acknowledgmentDeadline = Date.now() + 5_000;
      while (
        (await outbox.countDocuments({ status: { $ne: "published" } })) > 0 &&
        Date.now() < acknowledgmentDeadline
      ) {
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.equal(
        await outbox.countDocuments({ status: { $ne: "published" } }),
        0,
        "Confirmed immediate publications must acknowledge their transactional rows"
      );
      const publicationsBeforeReplay = publications.length;
      const { replayRealtimeOutboxBatch } = await import(
        "../src/lib/realtime/outbox-replay"
      );
      const replay = await replayRealtimeOutboxBatch({
        now: new Date(Date.now() + 60_000),
      });
      assert.deepEqual(replay, { claimed: 0, published: 0, failed: 0 });
      assert.equal(publications.length, publicationsBeforeReplay);

      // The durable checkpoint must resume updates that arrive while no writer runs.
      await db.collection("messages").insertOne({
        conversation: id,
        workspaceId: "fixture-workspace",
        direction: "inbound",
        channel: "telegram",
        date: new Date(5000),
        text: "After restart",
        author: 123,
      });
      stop = await startProductionRequestsProjectionRuntime({
        signal: new AbortController().signal,
        ownerToken: "fixture-second",
        realtimeEnabled: false,
        onFatal: error => {
          errors.push(error);
        },
      });
      await waitForText("After restart");
      t.diagnostic(
        JSON.stringify({
          test: "requests_projection_mongo",
          burstChanges: 128,
          materializations,
          durationMs: Math.round(performance.now() - started),
          resumed: true,
        })
      );
      await stop();
      stop = undefined;

      const duplicateBase = {
        workspaceId: "dedupe-fixture",
        channel: "whatsapp",
        direction: "inbound",
        date: new Date(),
      };
      await db.collection("messages").insertMany([
        {
          ...duplicateBase,
          chat: "historical-phone-chat",
          messageId: "wamid.historical",
        },
        {
          ...duplicateBase,
          chat: "historical-bsuid-chat",
          messageId: "wamid.historical",
        },
      ]);
      await db
        .collection("messages")
        .createIndex(
          MESSAGE_WHATSAPP_INBOUND_DEDUPE_INDEX.keys,
          MESSAGE_WHATSAPP_INBOUND_DEDUPE_INDEX.options
        );
      const insertInbound = async (
        messageId: string,
        workspaceId = duplicateBase.workspaceId,
        chat = "inbound-chat"
      ) => {
        const message = new Message({
          ...duplicateBase,
          messageId,
          workspaceId,
          chat,
        });
        await message.validate();
        return db.collection("messages").insertOne(message.toObject());
      };
      const race = await Promise.allSettled(
        Array.from({ length: 8 }, (_, index) =>
          insertInbound(
            index % 2 ? "wamid.concurrent" : "ws_wamid.concurrent",
            duplicateBase.workspaceId,
            `inbound-alias-chat-${index}`
          )
        )
      );
      assert.equal(
        race.filter(result => result.status === "fulfilled").length,
        1
      );
      for (const result of race)
        if (result.status === "rejected")
          assert.equal(result.reason.code, 11000);
      // Workspace dedupe permits different conversation identities, while the
      // pre-existing chat/messageId uniqueness still constrains shared chats.
      await insertInbound(
        "wamid.concurrent",
        "different-workspace",
        "different-workspace-chat"
      );
      await insertInbound(
        "wamid.legacy-shared",
        duplicateBase.workspaceId,
        "legacy-shared-chat"
      );
      await assert.rejects(
        insertInbound(
          "wamid.legacy-shared",
          "different-workspace",
          "legacy-shared-chat"
        ),
        { code: 11000 }
      );
      assert.equal(
        await db
          .collection("messages")
          .countDocuments({ ...duplicateBase, messageId: "wamid.historical" }),
        2
      );
      const {
        persistReplayWhatsAppMessageAndLink,
        recoverReplayWhatsAppMessageLinkIfExisting,
      } = await import(
        "../../temporal-worker/src/replay-whatsapp-message-link"
      );
      const linkedRawMessages: string[] = [];
      const replayDependencies = {
        appendMessage: async (_conversationId: unknown, messageId: unknown) => {
          linkedRawMessages.push(String(messageId));
          return { appended: true };
        },
      };
      const replayParams = {
        messageModel: Message,
        normalizedMessageId: "ws_wamid.raw-race",
        providerMessageId: "wamid.raw-race",
        fallbackDate: duplicateBase.date,
        fallbackWorkspaceId: duplicateBase.workspaceId,
        fallbackSourceId: "fixture-source",
      };
      const rawRace = await Promise.all(
        Array.from({ length: 8 }, (_, index) =>
          persistReplayWhatsAppMessageAndLink(
            {
              ...replayParams,
              existingMessageKnownMissing: true,
              messageDocument: {
                ...duplicateBase,
                _id: new mongoose.Types.ObjectId(),
                conversation: id,
                messageId: "wamid.raw-race",
                chat: `raw-alias-chat-${index}`,
              },
            },
            replayDependencies
          )
        )
      );
      assert.equal(rawRace.filter(result => result.created).length, 1);
      assert.equal(new Set(linkedRawMessages).size, 1);
      const rawRows = await db
        .collection("messages")
        .find({
          workspaceId: duplicateBase.workspaceId,
          messageId: "wamid.raw-race",
        })
        .toArray();
      assert.equal(rawRows.length, 1);
      assert.equal(rawRows[0].whatsappInboundDedupeKey, "ws_wamid.raw-race");
      await assert.rejects(
        insertInbound(
          "ws_wamid.raw-race",
          duplicateBase.workspaceId,
          "live-after-raw-chat"
        ),
        { code: 11000 }
      );
      assert.equal(
        await recoverReplayWhatsAppMessageLinkIfExisting(
          {
            ...replayParams,
            fallbackWorkspaceId: "unrelated-workspace",
          },
          replayDependencies
        ),
        null
      );
      await assert.rejects(
        persistReplayWhatsAppMessageAndLink(
          {
            ...replayParams,
            fallbackWorkspaceId: "unrelated-workspace",
            existingMessageKnownMissing: true,
            messageDocument: {
              ...duplicateBase,
              _id: new mongoose.Types.ObjectId(),
              workspaceId: "unrelated-workspace",
              conversation: new mongoose.Types.ObjectId(),
              messageId: "wamid.raw-race",
              chat: rawRows[0].chat,
            },
          },
          replayDependencies
        ),
        { code: 11000 }
      );
      assert.equal(linkedRawMessages.length, 8);
      t.diagnostic(
        JSON.stringify({
          test: "whatsapp_inbound_dedupe",
          concurrentWrites: 8,
          inserted: 1,
          distinctWorkspaceChatAccepted: true,
          legacySharedChatConflictPreserved: true,
          historicalDuplicatesPreserved: true,
          rawReplayWrites: 8,
          rawReplayInserted: 1,
          rawAndLiveShareDedupe: true,
        })
      );
    } finally {
      await stop?.();
      // The database name is constructed above exclusively for this local fixture.
      await mongoose.connection.dropDatabase();
      await mongoose.disconnect();
      mock.restoreAll();
    }
  }
);
