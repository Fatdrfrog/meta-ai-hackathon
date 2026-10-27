import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import mongoose from "mongoose";
import WhatsAppWebhookEvent from "@icecore/airi-runtime/whatsapp-webhook-event-model";
import { CompanyRuntimeCapacityDeferredError } from "@icecore/shared/lib/company-runtime-capacity";

import type { TemporalWorkerConfig } from "../config";
import {
  buildWhatsAppWebhookDrainFilter,
  buildWhatsAppWebhookExhaustedRetryFilter,
  drainPendingWhatsAppWebhookEventsToTemporal,
} from "./whatsapp-webhook-drain";
import {
  buildWhatsAppWebhookProcessingClaimFilter,
  processStoredWhatsAppWebhookEvent,
} from "./whatsapp-webhook-processor";
import { runWhatsAppWebhookFastReplay } from "../whatsapp-webhook-replay-claim";

const fixtureUri = process.env.MONGO_COST_TEST_URI;
type ProcessorRuntime = NonNullable<
  NonNullable<
    Parameters<typeof processStoredWhatsAppWebhookEvent>[1]
  >["runtime"]
>;

test(
  "real Mongo drain preserves concurrent receipt transitions and bounds exhausted recovery",
  {
    skip: !fixtureUri,
    timeout: 60_000,
  },
  async (t) => {
    // Only the explicit, dedicated local fixture is permitted; no application env loader.
    const uri = new URL(fixtureUri!);
    assert.equal(uri.protocol, "mongodb:");
    assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(uri.hostname));
    assert.equal(uri.port, "27277");
    assert.equal(uri.username, "");
    assert.equal(uri.password, "");
    assert.equal(uri.pathname, "/airi_mongo_index_cost_tests");
    assert.equal(uri.searchParams.get("replicaSet"), "airiCostTests");
    const databaseName = `airi_mongo_index_cost_tests_drain_${randomUUID().replaceAll("-", "").slice(0, 24)}`;
    assert.ok(databaseName.length <= 63);
    uri.pathname = `/${databaseName}`;
    const connection = await mongoose
      .createConnection(uri.toString(), {
        autoIndex: false,
        autoCreate: false,
        serverSelectionTimeoutMS: 5_000,
      })
      .asPromise();
    const model = connection.model(
      "WhatsAppWebhookEvent",
      WhatsAppWebhookEvent.schema,
    );
    const drainModel = model as unknown as Parameters<
      typeof drainPendingWhatsAppWebhookEventsToTemporal
    >[0]["model"];
    const now = new Date("2026-10-10T10:00:00.000Z");
    const config = { taskQueue: "airi-worker" } as TemporalWorkerConfig;
    const receipt = (extra: Record<string, unknown> = {}) => ({
      _id: new mongoose.Types.ObjectId(),
      dedupeKey: randomUUID(),
      field: "messages",
      orderingKey: "test-phone",
      status: "received",
      attempts: 0,
      maxAttempts: 12,
      completedAt: null,
      nextRetryAt: new Date(now.getTime() - 60_000),
      payload: { body: { marker: "fixture-only" } },
      firstReceivedAt: now,
      createdAt: now,
      ...extra,
    });
    try {
      for (const reason of ["limited", "unavailable"] as const) {
        for (const attempts of [0, 11]) {
          await t.test(
            `ordinary ${reason} capacity deferral preserves attempt ${attempts} and resumes only when due`,
            async () => {
              const event = receipt({ attempts });
              await model.collection.insertOne(event);
              const retryAt = new Date(Date.now() + 60_000);
              const capacityError = new CompanyRuntimeCapacityDeferredError(
                reason,
                retryAt.getTime(),
              );
              let calls = 0;
              const input = {
                contractVersion: 1,
                eventId: String(event._id),
                dedupeKey: event.dedupeKey,
                field: "messages",
                orderingKey: event.orderingKey,
                receivedAt: now.toISOString(),
              };
              const runtime = {
                connectDB: async () => undefined,
                WhatsAppWebhookEvent: model,
                processWhatsAppWebhookPayload: async () => {
                  calls += 1;
                  if (calls === 1) throw capacityError;
                  return { ok: true, code: "messages_processed" };
                },
                whatsappWebhookRuntimeDependencies: {},
              } as unknown as ProcessorRuntime;
              try {
                const deferred = await processStoredWhatsAppWebhookEvent(input, {
                  runtime,
                });
                assert.equal(deferred.runtimeCode, "company_capacity_deferred");
                const stored = await model.collection.findOne({ _id: event._id });
                assert.equal(stored?.status, "received");
                assert.equal(stored?.attempts, attempts);
                assert.equal(stored?.processingLeaseId, null);
                assert.equal(stored?.lastError, capacityError.message);
                assert.deepEqual(stored?.nextRetryAt, retryAt);
                assert.deepEqual(stored?.payload, event.payload);
                assert.equal(stored?.historyImport, undefined);
                assert.equal(
                  await model.countDocuments({
                    _id: event._id,
                    ...buildWhatsAppWebhookDrainFilter(new Date()),
                  }),
                  0,
                );

                const duplicate = await processStoredWhatsAppWebhookEvent(input, {
                  runtime,
                });
                assert.equal(duplicate.status, "skipped");
                assert.equal(calls, 1);
                assert.deepEqual(
                  await model.collection.findOne({ _id: event._id }),
                  stored,
                );

                await model.collection.updateOne(
                  { _id: event._id },
                  { $set: { nextRetryAt: new Date(Date.now() - 1_000) } },
                );
                const completed = await processStoredWhatsAppWebhookEvent(input, {
                  runtime,
                });
                assert.equal(completed.status, "completed");
                assert.equal(calls, 2);
                const final = await model.collection.findOne({ _id: event._id });
                assert.equal(final?.status, "completed");
                assert.equal(final?.attempts, attempts + 1);
                assert.equal(final?.processingLeaseId, null);
                assert.equal(final?.lastError, null);
                assert.equal(final?.historyImport, undefined);
              } finally {
                await model.deleteOne({ _id: event._id });
              }
            },
          );
        }
      }
      await t.test(
        "processor leaves future ordinary retries untouched across claimable states",
        async () => {
          for (const status of ["received", "published", "queued", "failed"]) {
            const event = receipt({
              status,
              attempts: 11,
              nextRetryAt: new Date(Date.now() + 60_000),
            });
            await model.collection.insertOne(event);
            try {
              const result = await processStoredWhatsAppWebhookEvent(
                {
                  contractVersion: 1,
                  eventId: String(event._id),
                  dedupeKey: event.dedupeKey,
                  field: "messages",
                  orderingKey: event.orderingKey,
                  receivedAt: now.toISOString(),
                },
                {
                  runtime: {
                    connectDB: async () => undefined,
                    WhatsAppWebhookEvent: model,
                    processWhatsAppWebhookPayload: async () => {
                      assert.fail("future retry must not execute payload");
                    },
                    whatsappWebhookRuntimeDependencies: {},
                  } as unknown as ProcessorRuntime,
                },
              );
              assert.equal(result.status, "skipped");
              assert.deepEqual(
                await model.collection.findOne({ _id: event._id }),
                event,
              );
            } finally {
              await model.deleteOne({ _id: event._id });
            }
          }
        },
      );
      await t.test(
        "capacity deferral from a replaced lease cannot overwrite the newer owner",
        async () => {
          const event = receipt({ attempts: 11 });
          await model.collection.insertOne(event);
          let newerOwner: Record<string, unknown> | null = null;
          try {
            await processStoredWhatsAppWebhookEvent(
              {
                contractVersion: 1,
                eventId: String(event._id),
                dedupeKey: event.dedupeKey,
                field: "messages",
                orderingKey: event.orderingKey,
                receivedAt: now.toISOString(),
              },
              {
                runtime: {
                  connectDB: async () => undefined,
                  WhatsAppWebhookEvent: model,
                  processWhatsAppWebhookPayload: async () => {
                    await model.collection.updateOne(
                      { _id: event._id },
                      {
                        $set: {
                          processingLeaseId: "new-owner",
                          processingStartedAt: new Date(),
                        },
                      },
                    );
                    newerOwner = await model.collection.findOne({
                      _id: event._id,
                    });
                    assert.ok(newerOwner);
                    assert.equal(newerOwner.processingLeaseId, "new-owner");
                    assert.equal(newerOwner.attempts, 12);
                    assert.equal(newerOwner.status, "processing");
                    throw new CompanyRuntimeCapacityDeferredError("limited");
                  },
                  whatsappWebhookRuntimeDependencies: {},
                } as unknown as ProcessorRuntime,
              },
            );
            assert.ok(newerOwner);
            assert.deepEqual(
              await model.collection.findOne({ _id: event._id }),
              newerOwner,
            );
          } finally {
            await model.deleteOne({ _id: event._id });
          }
        },
      );
      for (const takeover of [false, true]) {
        for (const fails of [false, true]) {
          await t.test(
            `fast replay ${fails ? "failure" : "completion"} ${takeover ? "preserves a newer lease" : "finishes its own lease"}`,
            async () => {
              const event = receipt({ status: "completed", completedAt: now });
              await model.collection.insertOne(event);
              const failure = new Error("fixture fast import failure");
              const run = runWhatsAppWebhookFastReplay({
                model,
                eventId: event._id,
                status: "completed",
                run: async () => {
                  assert.equal(
                    await model.countDocuments({
                      _id: event._id,
                      ...buildWhatsAppWebhookDrainFilter(new Date()),
                    }),
                    0,
                  );
                  assert.equal(
                    await model.countDocuments(
                      buildWhatsAppWebhookProcessingClaimFilter({
                        eventId: String(event._id),
                      }),
                    ),
                    0,
                  );
                  if (takeover)
                    await model.collection.updateOne(
                      { _id: event._id },
                      {
                        $set: {
                          processingLeaseId: "new-owner",
                          processingStartedAt: new Date(),
                        },
                      },
                    );
                  if (fails) throw failure;
                  return {
                    status: "completed",
                    runtimeCode: "fast_import",
                    importedMessages: 1,
                  };
                },
              });
              if (fails) await assert.rejects(run, failure);
              else {
                const result = await run;
                assert.equal(result.status, takeover ? "skipped" : "completed");
                assert.equal(
                  result.runtimeCode,
                  takeover ? "event_claim_lost" : "fast_import",
                );
              }
              const stored = await model.collection.findOne({ _id: event._id });
              assert.equal(
                stored?.status,
                takeover ? "processing" : fails ? "failed" : "completed",
              );
              assert.equal(
                stored?.processingLeaseId,
                takeover ? "new-owner" : null,
              );
              await model.deleteOne({ _id: event._id });
            },
          );
        }
      }
      await t.test(
        "drain and processor agree on retryable legacy nonpositive attempt limits",
        async () => {
          const events = [null, 0, -1, 12].map((maxAttempts) =>
            receipt({
              maxAttempts,
              attempts: 1,
            }),
          );
          await model.collection.insertMany(events);
          const ids = events.map((event) => event._id);
          try {
            for (const event of events) {
              assert.ok(
                await model.findOne(
                  buildWhatsAppWebhookProcessingClaimFilter({
                    eventId: String(event._id),
                    now,
                  }),
                ),
              );
            }
            assert.equal(
              await model.countDocuments({
                _id: { $in: ids },
                ...buildWhatsAppWebhookDrainFilter(now),
              }),
              4,
            );
            assert.equal(
              await model.countDocuments({
                _id: { $in: ids },
                ...buildWhatsAppWebhookExhaustedRetryFilter(now),
              }),
              0,
            );
          } finally {
            await model.deleteMany({ _id: { $in: ids } });
          }
        },
      );
      await t.test(
        "successful dispatch still queues an eligible receipt",
        async () => {
          const event = receipt();
          await model.collection.insertOne(event);
          await drainPendingWhatsAppWebhookEventsToTemporal({
            model: drainModel,
            config,
            now,
            signalWithStart: async () => ({ workflowId: "fixture-workflow" }),
          });
          assert.equal(
            (await model.collection.findOne({ _id: event._id }))?.status,
            "queued",
          );
        },
      );

      for (const signalFails of [false, true]) {
        for (const state of [
          "processing",
          "completed",
          "dead",
          "queued",
          "failed",
        ]) {
          await t.test(
            `${signalFails ? "failed" : "accepted"} signal preserves concurrent ${state}`,
            async () => {
              const event = receipt();
              await model.collection.insertOne(event);
              const transition = {
                status: state,
                ...(state === "processing"
                  ? {
                      processingStartedAt: now,
                      processingLeaseId: "new-owner",
                      attempts: 1,
                    }
                  : {}),
                ...(state === "completed" ? { completedAt: now } : {}),
                ...(state === "queued" ? { queuedAt: now } : {}),
                ...(state === "failed"
                  ? { nextRetryAt: new Date(now.getTime() + 60_000) }
                  : {}),
              };
              await drainPendingWhatsAppWebhookEventsToTemporal({
                model: drainModel,
                config,
                now,
                signalWithStart: async ({ event: signal }) => {
                  assert.equal(signal.eventId, String(event._id));
                  await model.collection.updateOne(
                    { _id: event._id },
                    { $set: transition },
                  );
                  if (signalFails) throw new Error("fixture response lost");
                  return { workflowId: "fixture-workflow" };
                },
              });
              const stored = await model.collection.findOne({ _id: event._id });
              assert.ok(stored);
              for (const [key, value] of Object.entries(transition))
                assert.deepEqual(stored[key], value);
              assert.deepEqual(stored.payload, event.payload);
            },
          );
        }
      }

      await t.test(
        "exhausted sweep respects batch limit and leaves the active final attempt alone",
        async () => {
          const fresh = receipt({
            status: "processing",
            attempts: 12,
            processingStartedAt: now,
            processingLeaseId: "active-final-attempt",
          });
          const stale = [1, 2, 3].map(() =>
            receipt({
              status: "processing",
              attempts: 12,
              processingStartedAt: new Date(now.getTime() - 16 * 60_000),
            }),
          );
          await model.collection.insertMany([fresh, ...stale]);
          const result = await drainPendingWhatsAppWebhookEventsToTemporal({
            model: drainModel,
            config,
            now,
            limit: 2,
            signalWithStart: async () => {
              throw new Error("no eligible signal expected");
            },
          });
          assert.deepEqual(result, { scanned: 0, queued: 0, failed: 0 });
          assert.equal(
            await model.countDocuments({
              _id: { $in: stale.map((event) => event._id) },
              status: "dead",
            }),
            2,
          );
          assert.equal(
            (await model.collection.findOne({ _id: fresh._id }))?.status,
            "processing",
          );
          assert.equal(
            await model.countDocuments({
              _id: { $in: [fresh, ...stale].map((event) => event._id) },
              payload: { $exists: true },
            }),
            4,
          );
        },
      );

      for (const active of [true, false]) {
        await t.test(
          `processor duplicate ${active ? "preserves active" : "terminates stale"} final attempt`,
          async () => {
            const processingStartedAt = new Date(
              Date.now() - (active ? 0 : 16 * 60_000),
            );
            const event = receipt({
              status: "processing",
              attempts: 12,
              processingStartedAt,
              processingLeaseId: "final-owner",
            });
            await model.collection.insertOne(event);
            const result = await processStoredWhatsAppWebhookEvent(
              {
                contractVersion: 1,
                eventId: String(event._id),
                dedupeKey: event.dedupeKey,
                field: "messages",
                orderingKey: event.orderingKey,
                receivedAt: now.toISOString(),
              },
              {
                runtime: {
                  connectDB: async () => undefined,
                  WhatsAppWebhookEvent: model,
                  processWhatsAppWebhookPayload: async () => {
                    throw new Error(
                      "exhausted receipt must not execute payload",
                    );
                  },
                  whatsappWebhookRuntimeDependencies: {},
                } as unknown as ProcessorRuntime,
              },
            );
            assert.equal(
              result.runtimeCode,
              active ? "event_already_claimed" : "retry_exhausted",
            );
            const stored = await model.collection.findOne({ _id: event._id });
            assert.equal(stored?.status, active ? "processing" : "dead");
            assert.equal(stored?.processingLeaseId, "final-owner");
            assert.deepEqual(stored?.payload, event.payload);
          },
        );
      }
    } finally {
      try {
        assert.equal(connection.name, databaseName);
        await connection.dropDatabase();
      } finally {
        await connection.close();
      }
    }
  },
);
