import assert from "node:assert/strict";
import { test } from "node:test";
import mongoose from "mongoose";
import {
  parseMongoIndexCostOperatorArgs,
  runMongoIndexCostOperation,
  type MongoIndexCostAdapter,
  type MongoIndexMetadata,
  type MongoIndexUsage,
} from "../src/lib/mongo-index-cost-operator";
import { ensureSingleFieldTtlIndex } from "../src/lib/mongo-ttl-indexes";
import { WHATSAPP_WEBHOOK_PAYLOAD_COMPACTION_INDEX } from "@icecore/airi-runtime/whatsapp-webhook-event-model";

function requireLocalFixtureUri(value: string): URL {
  const uri = new URL(value);
  assert.equal(
    uri.protocol,
    "mongodb:",
    "Mongo integration tests require a standard local URI"
  );
  assert.ok(
    ["127.0.0.1", "localhost", "[::1]"].includes(uri.hostname),
    "Refusing a non-loopback Mongo host"
  );
  assert.equal(
    uri.port,
    "27277",
    "Refusing a port outside the dedicated cost-test replica set"
  );
  assert.equal(uri.username, "", "Fixture URI must not contain credentials");
  assert.equal(uri.password, "", "Fixture URI must not contain credentials");
  assert.equal(
    uri.pathname,
    "/airi_mongo_index_cost_tests",
    "Refusing a non-fixture database"
  );
  assert.equal(
    uri.searchParams.get("replicaSet"),
    "airiCostTests",
    "Refusing an unexpected replica set"
  );
  return uri;
}

function indexNames(plan: unknown): string[] {
  if (!plan || typeof plan !== "object") return [];
  const names: string[] = [];
  for (const [key, value] of Object.entries(plan)) {
    if (key === "indexName" && typeof value === "string") names.push(value);
    else if (value && typeof value === "object")
      names.push(...indexNames(value));
  }
  return [...new Set(names)];
}

test("Mongo cost integration refuses production and non-fixture URIs", () => {
  for (const uri of [
    "mongodb+srv://cluster.example/test",
    "mongodb://example.com:27277/airi_mongo_index_cost_tests?replicaSet=airiCostTests",
    "mongodb://127.0.0.1:27277/test?replicaSet=airiCostTests",
    "mongodb://user:password@127.0.0.1:27277/airi_mongo_index_cost_tests?replicaSet=airiCostTests",
    "mongodb://127.0.0.1:27017/airi_mongo_index_cost_tests?replicaSet=airiCostTests",
  ])
    assert.throws(() => requireLocalFixtureUri(uri));
});

test(
  "Mongo TTL conversion, hidden-prefix replacement plans and rollback work on the isolated replica set",
  { skip: !process.env.MONGO_COST_TEST_URI, timeout: 60_000 },
  async t => {
    // No MONGODB_URI fallback and no app environment loader: only the explicit fixture URI is accepted.
    const uri = requireLocalFixtureUri(process.env.MONGO_COST_TEST_URI!);
    const fixtureName = `airi_mongo_index_cost_tests_${process.pid}_${Date.now()}`;
    uri.pathname = `/${fixtureName}`;
    process.env.MONGODB_URI = uri.toString();
    const { MESSAGE_TEMPORAL_DELIVERY_KEY_INDEX, buildTemporalDeliveryKeyFilter } = await import(
      "../src/models/message"
    );
    const { CONVERSATION_REQUESTS_DEPENDENCY_INDEXES } = await import(
      "../src/models/conversation"
    );
    const client = new mongoose.mongo.MongoClient(uri.toString(), {
      serverSelectionTimeoutMS: 5_000,
    });
    await client.connect();
    const db = client.db(fixtureName);
    assert.equal(db.databaseName, fixtureName);
    const commands: string[] = [];
    const ttlDb = {
      command: async (command: Record<string, unknown>) => {
        commands.push(String(Object.keys(command)[0]));
        return db.command(command);
      },
    };
    const plans: unknown[] = [];
    try {
      await t.test(
        "partial delivery-key uniqueness allows legacy rows and fences concurrent owners",
        async () => {
          const receipts = db.collection("delivery_receipts");
          await receipts.insertMany([
            ...Array.from({ length: 2000 }, () => ({
              temporalDeliveryKey: null,
            })),
            ...Array.from({ length: 2000 }, () => ({})),
          ]);
          await receipts.createIndex(
            MESSAGE_TEMPORAL_DELIVERY_KEY_INDEX.keys,
            MESSAGE_TEMPORAL_DELIVERY_KEY_INDEX.options
          );
          const results = await Promise.allSettled(
            Array.from({ length: 12 }, () =>
              receipts.insertOne({
                temporalDeliveryKey: "same-logical-delivery",
              })
            )
          );
          assert.equal(
            results.filter(result => result.status === "fulfilled").length,
            1
          );
          for (const result of results.filter(
            result => result.status === "rejected"
          )) {
            assert.equal((result as PromiseRejectedResult).reason.code, 11000);
          }
          assert.equal(await receipts.countDocuments({}), 4001);
          const plan = await receipts
            .find({
              $or: [
                { _id: new mongoose.Types.ObjectId() },
                {
              ...buildTemporalDeliveryKeyFilter("same-logical-delivery"),
                },
              ],
            })
            .explain("executionStats");
          assert.ok(
            indexNames(plan.queryPlanner.winningPlan).includes(
              MESSAGE_TEMPORAL_DELIVERY_KEY_INDEX.options.name
            )
          );
          assert.equal(plan.executionStats.totalDocsExamined, 1);
          plans.push({
            query: "delivery-key-or-id",
            indexes: indexNames(plan.queryPlanner.winningPlan),
            docsExamined: plan.executionStats.totalDocsExamined,
          });
        }
      );
      await t.test(
        "Mixed user/chat fanout pages preserve every cross-workspace reference using compound indexes",
        async () => {
          const conversations = db.collection("dependency_conversations");
          const references = [12345, "12345", new mongoose.Types.ObjectId()];
          const rows = references.flatMap(reference =>
            Array.from({ length: 405 }, (_, i) => ({
              _id: new mongoose.Types.ObjectId(),
              user: reference,
              chat: reference,
              workspaceId: `workspace-${i % 3}`,
            }))
          );
          await conversations.insertMany(rows);
          for (const definition of CONVERSATION_REQUESTS_DEPENDENCY_INDEXES) {
            await conversations.createIndex(
              definition.keys,
              definition.options
            );
          }
          for (const field of ["user", "chat"] as const) {
            for (const reference of references) {
              const expected = rows
                .filter(row => row[field] === reference)
                .map(row => row._id.toHexString());
              const actual: string[] = [];
              let after: mongoose.Types.ObjectId | undefined;
              while (true) {
                const filter = {
                  [field]: reference,
                  ...(after ? { _id: { $gt: after } } : {}),
                };
                const query = () =>
                  conversations
                    .find(filter, {
                      projection: { _id: 1, workspaceId: 1 },
                      maxTimeMS: 5_000,
                    })
                    .sort({ _id: 1 })
                    .limit(201);
                const plan = await query().explain("executionStats");
                assert.ok(
                  indexNames(plan.queryPlanner.winningPlan).includes(
                    `conversations_requests_${field}_id_v1`
                  )
                );
                assert.ok(plan.executionStats.totalDocsExamined <= 201);
                const page = await query().toArray();
                const emitted = page.slice(0, 200);
                actual.push(...emitted.map(row => row._id.toHexString()));
                if (page.length <= 200) break;
                after = emitted.at(-1)!._id;
              }
              assert.deepEqual(actual, expected);
            }
          }
        }
      );
      await t.test(
        "converts a real plain timestamp index, repairs drift and leaves correct retention untouched",
        async () => {
          const logs = db.collection("scenariotriggerlogs");
          await logs.insertOne({
            evaluatedAt: new Date(),
            marker: "preserved",
          });
          await logs.createIndex({ evaluatedAt: 1 });
          const collection = {
            collectionName: logs.collectionName,
            indexes: async () => await logs.indexes(),
            createIndex: async (
              key: Record<string, 1>,
              options: { name: string; expireAfterSeconds: number }
            ) => logs.createIndex(key, options),
          };
          const params = {
            collection,
            db: ttlDb,
            field: "evaluatedAt",
            expireAfterSeconds: 2_592_000,
          };
          const preview = await ensureSingleFieldTtlIndex({
            ...params,
            dryRun: true,
          });
          assert.equal(preview.action, "convert");
          assert.equal(
            (await logs.indexes()).find(index => index.name === "evaluatedAt_1")
              ?.expireAfterSeconds,
            undefined
          );
          assert.equal(commands.length, 0);

          const converted = await ensureSingleFieldTtlIndex(params);
          assert.equal(converted.action, "convert");
          assert.equal(
            (await logs.indexes()).find(index => index.name === "evaluatedAt_1")
              ?.expireAfterSeconds,
            2_592_000
          );
          assert.equal(await logs.countDocuments({ marker: "preserved" }), 1);
          assert.deepEqual(commands, ["collMod"]);

          assert.equal(
            (
              await ensureSingleFieldTtlIndex({
                ...params,
                expireAfterSeconds: 5_184_000,
              })
            ).action,
            "update"
          );
          assert.equal(
            (await logs.indexes()).find(index => index.name === "evaluatedAt_1")
              ?.expireAfterSeconds,
            5_184_000
          );
          const commandsBefore = commands.length;
          assert.equal(
            (
              await ensureSingleFieldTtlIndex({
                ...params,
                expireAfterSeconds: 5_184_000,
              })
            ).action,
            "unchanged"
          );
          assert.equal(commands.length, commandsBefore);
        }
      );

      await t.test(
        "creates a missing TTL and refuses an existing unique timestamp index",
        async () => {
          const metrics = db.collection("scenariotriggerdailymetrics");
          await metrics.insertOne({ day: new Date() });
          const collection = {
            collectionName: metrics.collectionName,
            indexes: async () => await metrics.indexes(),
            createIndex: async (
              key: Record<string, 1>,
              options: { name: string; expireAfterSeconds: number }
            ) => metrics.createIndex(key, options),
          };
          assert.equal(
            (
              await ensureSingleFieldTtlIndex({
                collection,
                db: ttlDb,
                field: "day",
                expireAfterSeconds: 31_536_000,
              })
            ).action,
            "create"
          );
          assert.equal(
            (await metrics.indexes()).find(index => index.name === "day_1")
              ?.expireAfterSeconds,
            31_536_000
          );
          await metrics.createIndex({ uniqueDate: 1 }, { unique: true });
          const commandsBefore = commands.length;
          await assert.rejects(
            ensureSingleFieldTtlIndex({
              collection,
              db: ttlDb,
              field: "uniqueDate",
              expireAfterSeconds: 3600,
            }),
            /Unexpected TTL index definition/
          );
          assert.equal(commands.length, commandsBefore);
          assert.equal(
            (await metrics.indexes()).find(
              index => index.name === "uniqueDate_1"
            )?.expireAfterSeconds,
            undefined
          );
        }
      );

      await t.test(
        "accepts the terminal-payload partial index including legacy missing compaction fields",
        async () => {
          const events = db.collection("whatsappwebhookevents");
          await events.insertMany([
            {
              status: "completed",
              completedAt: new Date("2026-01-01"),
              payload: { marker: "legacy" },
            },
            {
              status: "completed",
              completedAt: new Date("2026-01-02"),
              payloadCompactedAt: null,
              payload: { marker: "fresh" },
            },
            {
              status: "completed",
              completedAt: new Date("2026-01-03"),
              payloadCompactedAt: new Date(),
            },
            {
              status: "processing",
              completedAt: null,
              payload: { marker: "active" },
            },
          ]);
          await events.createIndex(
            WHATSAPP_WEBHOOK_PAYLOAD_COMPACTION_INDEX.key,
            WHATSAPP_WEBHOOK_PAYLOAD_COMPACTION_INDEX.options
          );
          const filter = {
            status: "completed",
            payloadCompactedAt: null,
            completedAt: { $lte: new Date("2026-02-01") },
          };
          assert.equal(await events.countDocuments(filter), 2);
          const plan = await events
            .find(filter)
            .sort({ completedAt: 1, _id: 1 })
            .explain("executionStats");
          assert.ok(
            indexNames(plan.queryPlanner.winningPlan).includes(
              "whatsapp_webhook_events_payload_compaction"
            )
          );
          assert.equal(plan.executionStats.nReturned, 2);
          plans.push({
            query: "completed_payload_compaction",
            indexes: indexNames(plan.queryPlanner.winningPlan),
            keysExamined: plan.executionStats.totalKeysExamined,
            docsExamined: plan.executionStats.totalDocsExamined,
            returned: plan.executionStats.nReturned,
          });
        }
      );

      await t.test(
        "hides both prefixes and real unhinted queries choose their replacements, then unhides",
        async () => {
          const messages = db.collection("messages");
          await messages.insertMany(
            Array.from({ length: 600 }, (_, index) => ({
              workspaceId: `workspace-${index % 20}`,
              text: `text-${index % 10}`,
              conversation: `conversation-${index % 30}`,
              date: new Date(Date.UTC(2026, 0, 1, 0, 0, index)),
            }))
          );
          await messages.createIndex({ workspaceId: 1, text: 1 });
          await messages.createIndex({
            workspaceId: 1,
            text: 1,
            conversation: 1,
          });
          await messages.createIndex({ conversation: 1, date: 1 });
          await messages.createIndex({ conversation: 1, date: 1, _id: 1 });
          const adapter: MongoIndexCostAdapter = {
            readIndexes: async name =>
              (await db
                .collection(name)
                .indexes()) as unknown as MongoIndexMetadata[],
            readIndexSizes: async name =>
              (await db.command({ collStats: name, scale: 1 })).indexSizes,
            readUsage: async name =>
              (await db
                .collection(name)
                .aggregate([{ $indexStats: {} }])
                .toArray()) as MongoIndexUsage[],
            setHidden: async (name, index, hidden) => {
              await db.command({
                collMod: name,
                index: { name: index, hidden },
              });
            },
            dropIndex: async (name, index) => {
              await db.collection(name).dropIndex(index);
            },
          };
          const args = (
            index: string,
            operation: string,
            extra: string[] = []
          ) =>
            parseMongoIndexCostOperatorArgs([
              `--operation=${operation}`,
              "--collection=messages",
              `--index=${index}`,
              ...extra,
            ]);
          for (const [prefix, replacement, filter, sort] of [
            [
              "workspaceId_1_text_1",
              "workspaceId_1_text_1_conversation_1",
              { workspaceId: "workspace-0", text: "text-0" },
              { date: -1 },
            ],
            [
              "conversation_1_date_1",
              "conversation_1_date_1__id_1",
              { conversation: "conversation-0" },
              { date: 1, _id: 1 },
            ],
          ] as const) {
            const before = await messages
              .find(filter)
              .sort(sort)
              .limit(10)
              .toArray();
            await assert.rejects(
              runMongoIndexCostOperation(
                adapter,
                args(prefix, "drop", [
                  "--apply",
                  "--observed-since=2026-01-01T00:00:00.000Z",
                ])
              ),
              /candidate_must_be_hidden/
            );
            await runMongoIndexCostOperation(
              adapter,
              args(prefix, "hide", ["--apply"])
            );
            assert.equal(
              (await messages.indexes()).find(index => index.name === prefix)
                ?.hidden,
              true
            );
            assert.equal(
              (await messages.indexes()).find(
                index => index.name === replacement
              )?.hidden,
              undefined
            );
            await assert.rejects(
              runMongoIndexCostOperation(
                adapter,
                args(prefix, "drop", ["--apply"])
              ),
              /drop_observation_required/
            );
            assert.ok(
              (await messages.indexes()).some(index => index.name === prefix)
            );
            const plan = await messages
              .find(filter)
              .sort(sort)
              .limit(10)
              .explain("executionStats");
            const chosen = indexNames(plan.queryPlanner.winningPlan);
            assert.ok(
              chosen.includes(replacement),
              `Expected replacement ${replacement}; found ${chosen.join(",")}`
            );
            assert.ok(!chosen.includes(prefix));
            assert.deepEqual(
              (await messages.find(filter).sort(sort).limit(10).toArray())
                .map(doc => doc._id.toString())
                .sort(),
              before.map(doc => doc._id.toString()).sort()
            );
            plans.push({
              query: prefix,
              indexes: chosen,
              keysExamined: plan.executionStats.totalKeysExamined,
              docsExamined: plan.executionStats.totalDocsExamined,
              returned: plan.executionStats.nReturned,
            });
            await runMongoIndexCostOperation(
              adapter,
              args(prefix, "unhide", ["--apply"])
            );
            assert.equal(
              (await messages.indexes()).find(index => index.name === prefix)
                ?.hidden,
              undefined
            );
          }
        }
      );
      await t.test(
        "an unused partial candidate hides, waits seven days to drop and recreates exactly",
        async () => {
          const name = "scenariotriggerlogs";
          const index = "scenario_trigger_logs_workspace_evaluation_id";
          const logs = db.collection(name);
          await logs.insertMany(
            Array.from({ length: 50 }, (_, i) => ({
              workspaceId: `workspace-${i % 3}`,
              evaluationId: i % 2 ? `evaluation-${i}` : null,
            }))
          );
          await logs.createIndex(
            { workspaceId: 1, evaluationId: 1 },
            {
              background: true,
              name: index,
              partialFilterExpression: { evaluationId: { $type: "string" } },
            }
          );
          const original = (await logs.indexes()).find(i => i.name === index);
          const adapter: MongoIndexCostAdapter = {
            readIndexes: async collection =>
              (await db
                .collection(collection)
                .indexes()) as unknown as MongoIndexMetadata[],
            readIndexSizes: async collection =>
              (await db.command({ collStats: collection, scale: 1 }))
                .indexSizes,
            readUsage: async collection =>
              (await db
                .collection(collection)
                .aggregate([{ $indexStats: {} }])
                .toArray()) as MongoIndexUsage[],
            setHidden: async (collection, target, hidden) => {
              await db.command({
                collMod: collection,
                index: { name: target, hidden },
              });
            },
            dropIndex: async (collection, target) => {
              await db.collection(collection).dropIndex(target);
            },
          };
          const args = (operation: string, extra: string[] = []) =>
            parseMongoIndexCostOperatorArgs([
              `--operation=${operation}`,
              `--collection=${name}`,
              `--index=${index}`,
              ...extra,
            ]);
          const daysAgo = (days: number) =>
            new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
          await runMongoIndexCostOperation(adapter, args("hide", ["--apply"]));
          assert.equal(
            (await logs.indexes()).find(i => i.name === index)?.hidden,
            true
          );
          await assert.rejects(
            runMongoIndexCostOperation(
              adapter,
              args("drop", ["--apply", `--observed-since=${daysAgo(6)}`])
            ),
            /drop_observation_required/
          );
          const dropped = await runMongoIndexCostOperation(
            adapter,
            args("drop", ["--apply", `--observed-since=${daysAgo(8)}`])
          );
          assert.ok(!(await logs.indexes()).some(i => i.name === index));
          const { key, options } = dropped.candidates[0].recreate;
          await logs.createIndex(key, options);
          const recreated = (await logs.indexes()).find(i => i.name === index);
          assert.deepEqual(recreated?.key, original?.key);
          assert.deepEqual(
            recreated?.partialFilterExpression,
            original?.partialFilterExpression
          );
        }
      );
      t.diagnostic(JSON.stringify({ fixture: fixtureName, plans }));
    } finally {
      try {
        assert.ok(fixtureName.startsWith("airi_mongo_index_cost_tests_"));
        await db.dropDatabase();
      } finally {
        await client.close();
      }
    }
  }
);
