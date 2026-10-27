import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { CompanyRuntimeCapacityDeferredError } from "@icecore/shared/lib/company-runtime-capacity";
import { WhatsAppHistoryCapacityPausedError } from "@icecore/airi-runtime/whatsapp-history-import-store";
import {
  buildWhatsAppIntakePlanSkipBody,
  buildWhatsAppPlanSkippedReceiptFilter,
  createWhatsAppIntakePlanGate,
  resolveWhatsAppIntakePlanSkip,
  resolveWhatsAppNewConversationPlanSkip,
  type WhatsAppIntakePlanCheck,
} from "@icecore/airi-runtime/whatsapp-intake-plan-gate";

// The web runtime loads shared code through CJS while activities import ESM.
const CommonJsCapacityDeferredError = createRequire(import.meta.url)(
  "@icecore/shared/lib/company-runtime-capacity",
).CompanyRuntimeCapacityDeferredError as typeof CompanyRuntimeCapacityDeferredError;

import {
  buildWhatsAppWebhookProcessingClaimFilter,
  DurableWhatsAppWebhookEventFailure,
  isDurableWhatsAppWebhookEventFailure,
  isSourceDependentRuntimeProcessorSkip,
  isWhatsAppWebhookRetryExhausted,
  processStoredWhatsAppWebhookEvent,
  readWhatsAppWebhookEventOrderingState,
} from "./whatsapp-webhook-processor";

test("a history receipt requires a verified signature and commits only a durable outcome", async () => {
  for (const [outcome, providerSignatureVerified] of [
    ["synchronized", true],
    [undefined, true],
    ["synchronized", false],
  ] as const) {
    const updates: any[] = [];
    let runtimeCalls = 0;
    const event = {
      _id: "event-1",
      status: "processing",
      attempts: 1,
      maxAttempts: 12,
      providerSignatureVerified,
      payload: { body: { object: "whatsapp_business_account", entry: [] } },
      historyImport: { role: "message", sessionId: "session-1", workspaceId: "workspace-1" },
    };
    const runtime = {
      connectDB: async () => undefined,
      WhatsAppWebhookEvent: {
        findOneAndUpdate: () => ({
          select: () => ({ lean: async () => event }),
        }),
        updateOne: async (filter: unknown, update: unknown) => {
          updates.push({ filter, update });
          return { modifiedCount: 1 };
        },
      },
      processWhatsAppWebhookPayload: async () => {
        runtimeCalls++;
        return {
          ok: true,
          code: "ok",
          details: { historyOutcome: outcome },
        };
      },
      whatsappWebhookRuntimeDependencies: {},
    };
    const run = processStoredWhatsAppWebhookEvent(
      {
        contractVersion: 1,
        eventId: "event-1",
        dedupeKey: "history-key",
        field: "history",
        orderingKey: "history-lane",
        receivedAt: "2026-10-10T00:00:00Z",
      },
      { runtime: runtime as never, withHistoryCapacity: async (_workspaceId, run) => run("company-1") },
    );
    if (!providerSignatureVerified) {
      await assert.rejects(run, /no verified provider signature/);
      assert.equal(runtimeCalls, 0);
      assert.equal(updates[0].update.$set.status, "failed");
    } else if (outcome) {
      assert.equal((await run).status, "completed");
      assert.equal(
        updates[0].update.$set["historyImport.outcome"],
        "synchronized",
      );
      assert.equal(updates[0].update.$set.status, "completed");
      assert.ok(updates[0].filter.processingLeaseId);
    } else {
      await assert.rejects(run, /did not record a durable outcome/);
      assert.equal(updates[0].update.$set.status, "failed");
    }
  }
});

test("history capacity defers durable receipts without consuming failure retries", async () => {
  for (const error of [
    new CompanyRuntimeCapacityDeferredError("limited", Date.now() + 60_000),
    new CommonJsCapacityDeferredError("unavailable", Date.now() + 60_000),
    new WhatsAppHistoryCapacityPausedError("company-1"),
  ]) {
    const updates: any[] = [];
    let processed = false;
    const runtime = {
      connectDB: async () => undefined,
      WhatsAppWebhookEvent: {
        findOneAndUpdate: () => ({
          select: () => ({
            lean: async () => ({
              _id: "event",
              status: "processing",
              attempts: 12,
              maxAttempts: 12,
              providerSignatureVerified: true,
              payload: { body: {}, rawBody: "{}" },
              historyImport: { role: "message", workspaceId: "ws" },
            }),
          }),
        }),
        updateOne: async (_filter: unknown, update: unknown) => {
          updates.push(update);
          return { modifiedCount: 1 };
        },
      },
      processWhatsAppWebhookPayload: async () => {
        processed = true;
        return { ok: true };
      },
      whatsappWebhookRuntimeDependencies: {},
    };
    const result = await processStoredWhatsAppWebhookEvent(
      {
        contractVersion: 1,
        eventId: "event",
        dedupeKey: "key",
        field: "history",
        orderingKey: "lane",
        receivedAt: new Date().toISOString(),
      },
      {
        runtime: runtime as never,
        withHistoryCapacity: async () => {
          throw error;
        },
      },
    );
    assert.equal(result.status, "skipped");
    assert.equal(processed, false);
    assert.equal(updates[0].$set.status, "received");
    assert.equal(updates[0].$inc.attempts, -1);
    assert.equal(updates[0].$set.processingLeaseId, null);
    assert.ok(updates[0].$set.nextRetryAt instanceof Date);
    assert.equal(
      updates[0].$set["historyImport.capacityPaused"],
      error instanceof WhatsAppHistoryCapacityPausedError,
    );
  }
});

for (const [loader, CapacityDeferredError] of [
  ["ESM", CompanyRuntimeCapacityDeferredError],
  ["CJS", CommonJsCapacityDeferredError],
] as const) {
  for (const reason of ["limited", "unavailable"] as const) {
    test(`ordinary message ${loader} capacity ${reason} preserves the final retry without creating history metadata`, async () => {
      const retryAt = Date.now() + 60_000;
      const error = new CapacityDeferredError(reason, retryAt);
      const writes: Array<{
        filter: Record<string, unknown>;
        update: { $set: Record<string, unknown>; $inc: Record<string, number> };
      }> = [];
      const runtime = {
        connectDB: async () => undefined,
        WhatsAppWebhookEvent: {
          findOneAndUpdate: () => ({
            select: () => ({
              lean: async () => ({
                _id: "event",
                status: "processing",
                attempts: 12,
                maxAttempts: 12,
                payload: { body: {} },
              }),
            }),
          }),
          updateOne: async (
            filter: (typeof writes)[number]["filter"],
            update: (typeof writes)[number]["update"],
          ) => {
            writes.push({ filter, update });
            return { modifiedCount: 1 };
          },
        },
        processWhatsAppWebhookPayload: async () => {
          throw error;
        },
        whatsappWebhookRuntimeDependencies: {},
      };

      const result = await processStoredWhatsAppWebhookEvent(
        {
          contractVersion: 1,
          eventId: "event",
          dedupeKey: "key",
          field: "messages",
          orderingKey: "lane",
          receivedAt: new Date().toISOString(),
        },
        { runtime: runtime as never },
      );

      assert.equal(result.runtimeCode, "company_capacity_deferred");
      assert.equal(writes.length, 1);
      assert.equal(writes[0].filter._id, "event");
      assert.ok(writes[0].filter.processingLeaseId);
      assert.deepEqual(writes[0].update, {
        $set: {
          status: "received",
          processingLeaseId: null,
          nextRetryAt: new Date(retryAt),
          lastError: error.message,
        },
        $inc: { attempts: -1 },
      });
    });
  }
}

test("claims only retryable or stale webhook events", () => {
  const now = new Date("2026-07-10T10:00:00.000Z");

  assert.deepEqual(
    buildWhatsAppWebhookProcessingClaimFilter({
      eventId: "event-1",
      now,
    }),
    {
      _id: "event-1",
      $and: [
        {
          $or: [
            {
              status: {
                $in: ["received", "published", "queued", "failed"],
              },
            },
            {
              status: "processing",
              processingStartedAt: {
                $lte: new Date("2026-07-10T09:45:00.000Z"),
              },
            },
          ],
        },
        {
          $expr: {
            $lt: [
              { $ifNull: ["$attempts", 0] },
              {
                $cond: [
                  { $gt: [{ $ifNull: ["$maxAttempts", 0] }, 0] },
                  "$maxAttempts",
                  12,
                ],
              },
            ],
          },
        },
        { $or: [{ nextRetryAt: null }, { nextRetryAt: { $lte: now } }] },
        { $or: [{ "historyImport.capacityDeferredUntil": null }, { "historyImport.capacityDeferredUntil": { $lte: now } }] },
      ],
    },
  );
});

test("exhausted duplicate signals preserve a fresh processing lease and concurrent retry resets", async () => {
  const startedAt = Date.now();
  for (const modifiedCount of [0, 1]) {
    let writeFilter: Record<string, any> | undefined;
    const result = await processStoredWhatsAppWebhookEvent(
      {
        contractVersion: 1,
        eventId: "final-attempt",
        dedupeKey: "dedupe-final-attempt",
        field: "messages",
        orderingKey: "phone-1",
        receivedAt: "2026-10-10T00:00:00Z",
      },
      {
        runtime: {
          connectDB: async () => undefined,
          WhatsAppWebhookEvent: {
            findOneAndUpdate: () => ({
              select: () => ({ lean: async () => null }),
            }),
            findById: () => ({
              select: () => ({
                lean: async () => ({
                  status: "processing",
                  attempts: 12,
                  maxAttempts: 12,
                }),
              }),
            }),
            updateOne: async (filter: Record<string, any>) => {
              writeFilter = filter;
              return { modifiedCount };
            },
          },
        } as never,
      },
    );

    assert.ok(writeFilter);
    assert.equal(writeFilter._id, "final-attempt");
    assert.deepEqual(writeFilter.$and?.[1], {
      attempts: 12,
      maxAttempts: 12,
    });
    const states = writeFilter.$and?.[0].$or;
    assert.equal(states?.length, 2);
    assert.deepEqual(states[0], {
      status: { $in: ["received", "published", "queued", "failed"] },
    });
    assert.equal(states[1].status, "processing");
    const cutoff = states[1].processingStartedAt.$lte;
    assert.ok(cutoff instanceof Date);
    assert.ok(cutoff.getTime() >= startedAt - 15 * 60_000);
    assert.ok(cutoff.getTime() <= Date.now() - 15 * 60_000);
    assert.deepEqual(result, {
      eventId: "final-attempt",
      status: "skipped",
      runtimeCode: modifiedCount ? "retry_exhausted" : "event_already_claimed",
    });
  }
});

test("retries source-dependent skips for phone and WABA scoped onboarding events", () => {
  assert.equal(
    isSourceDependentRuntimeProcessorSkip({
      runtimeResult: {
        ok: true,
        code: "ok",
        message: "source not found for WABA",
      },
      wabaId: "waba-1",
    }),
    true,
  );
  assert.equal(
    isSourceDependentRuntimeProcessorSkip({
      runtimeResult: {
        ok: true,
        code: "ok",
        message: "history skipped while source may still be onboarding",
      },
      phoneNumberId: "phone-1",
    }),
    true,
  );
  assert.equal(
    isSourceDependentRuntimeProcessorSkip({
      runtimeResult: {
        ok: true,
        code: "ok",
        message: "source not found for WABA",
      },
    }),
    false,
  );
});

test("detects exhausted durable WhatsApp webhook retries", () => {
  assert.equal(isWhatsAppWebhookRetryExhausted(null), false);
  assert.equal(isWhatsAppWebhookRetryExhausted({ attempts: 11 }), false);
  assert.equal(isWhatsAppWebhookRetryExhausted({ attempts: 12 }), true);
  assert.equal(
    isWhatsAppWebhookRetryExhausted({ attempts: 4, maxAttempts: 5 }),
    false,
  );
  assert.equal(
    isWhatsAppWebhookRetryExhausted({ attempts: 5, maxAttempts: 5 }),
    true,
  );
});

test("identifies durable webhook event failures for Pub/Sub ack decisions", () => {
  const error = new DurableWhatsAppWebhookEventFailure({
    eventId: "event-1",
    durableStatus: "failed",
    message: "runtime failed after durable state was saved",
    runtimeCode: "server_error",
  });

  assert.equal(isDurableWhatsAppWebhookEventFailure(error), true);
  assert.equal(error.eventId, "event-1");
  assert.equal(error.durableStatus, "failed");
  assert.equal(error.runtimeCode, "server_error");
  assert.equal(isDurableWhatsAppWebhookEventFailure(new Error("boom")), false);
});

type ReceiptUpdate = {
  $set: Record<string, unknown>;
  $inc?: Record<string, number>;
  $unset?: Record<string, string>;
};

function createHistoryChunkRuntime(
  getWhatsAppIntakePlanSkip: WhatsAppIntakePlanCheck,
) {
  const updates: ReceiptUpdate[] = [];
  let runtimeCalls = 0;
  const runtime = {
    connectDB: async () => undefined,
    WhatsAppWebhookEvent: {
      findOneAndUpdate: () => ({
        select: () => ({
          lean: async () => ({
            _id: "chunk-event",
            status: "processing",
            attempts: 1,
            maxAttempts: 12,
            providerSignatureVerified: true,
            phoneNumberId: "phone-1",
            payload: {
              body: { object: "whatsapp_business_account", entry: [] },
            },
            historyImport: {
              role: "chunk",
              sessionId: "session-1",
              workspaceId: "workspace-1",
              sourceId: "source-1",
            },
          }),
        }),
      }),
      updateOne: async (_filter: unknown, update: ReceiptUpdate) => {
        updates.push(update);
        return { modifiedCount: 1 };
      },
    },
    processWhatsAppWebhookPayload: async () => {
      runtimeCalls++;
      return { ok: true, code: "ok" };
    },
    whatsappWebhookRuntimeDependencies: { getWhatsAppIntakePlanSkip },
  };
  return { runtime, updates, runtimeCalls: () => runtimeCalls };
}

const historyChunkInput = {
  contractVersion: 1,
  eventId: "chunk-event",
  dedupeKey: "history-chunk",
  field: "history",
  orderingKey: "history-lane",
  receivedAt: "2026-10-18T00:00:00Z",
};

test("a trial-expired company pauses history chunk expansion without burning attempts", async () => {
  const checks: unknown[] = [];
  const { runtime, updates, runtimeCalls } = createHistoryChunkRuntime(
    async (input) => {
      checks.push(input);
      return resolveWhatsAppIntakePlanSkip({
        trialExpired: true,
        newConversationsAllowed: false,
      });
    },
  );
  let expansions = 0;
  const before = Date.now();
  const result = await processStoredWhatsAppWebhookEvent(historyChunkInput, {
    runtime: runtime as never,
    withHistoryCapacity: async (_workspaceId, run) => run("company-1"),
    expandHistoryChunk: async () => {
      expansions++;
      return [];
    },
  });

  assert.deepEqual(result, {
    eventId: "chunk-event",
    status: "skipped",
    runtimeCode: "history_plan_paused",
  });
  assert.deepEqual(checks, [
    {
      workspaceId: "workspace-1",
      sourceId: "source-1",
      itemKind: "history_chunk",
    },
  ]);
  assert.equal(expansions, 0);
  assert.equal(runtimeCalls(), 0);
  assert.equal(updates.length, 1);
  const pause = updates[0];
  assert.equal(pause.$set.status, "received");
  assert.equal(pause.$inc?.attempts, -1);
  assert.equal(pause.$set["historyImport.capacityPaused"], true);
  assert.equal(pause.$set["historyImport.capacityCompanyId"], "company-1");
  assert.equal(
    pause.$set["historyImport.capacityPauseReason"],
    "company_trial_expired",
  );
  assert.ok((pause.$set.nextRetryAt as Date).getTime() >= before + 3_600_000);
  assert.match(String(pause.$set.lastError), /company plan locked/);
});

test("an unlocked company, or a failed plan read, still expands history chunks", async () => {
  const failingGate = createWhatsAppIntakePlanGate({
    readPlan: async () => {
      throw new Error("supabase unavailable");
    },
    logger: { warn: () => undefined },
  });
  for (const check of [async () => null, failingGate.getIntakeSkip]) {
    const { runtime, updates } = createHistoryChunkRuntime(check);
    const expanded: unknown[] = [];
    const published: unknown[] = [];
    const result = await processStoredWhatsAppWebhookEvent(historyChunkInput, {
      runtime: runtime as never,
      withHistoryCapacity: async (_workspaceId, run) => run("company-1"),
      expandHistoryChunk: async (params) => {
        expanded.push(params.companyId);
        return [];
      },
      publishHistoryChildren: async (children) => {
        published.push(children);
      },
    });

    assert.equal(result.status, "completed");
    assert.equal(result.runtimeCode, "history_expanded");
    assert.deepEqual(expanded, ["company-1"]);
    assert.equal(published.length, 1);
    assert.equal(updates[0].$set.status, "completed");
  }
});

test("plan-skipped message receipts complete instead of retrying as onboarding skips", async () => {
  for (const reason of [
    "company_trial_expired",
    "company_conversation_limit_exceeded",
  ] as const) {
    const body = buildWhatsAppIntakePlanSkipBody(
      reason === "company_trial_expired"
        ? resolveWhatsAppIntakePlanSkip({
            trialExpired: true,
            newConversationsAllowed: false,
          })!
        : resolveWhatsAppNewConversationPlanSkip({
            trialExpired: false,
            newConversationsAllowed: false,
          })!,
    );
    const runtimeResult = {
      ok: true,
      code: body.status,
      message: body.message,
      details: body,
      retryable: false,
    };
    assert.equal(
      isSourceDependentRuntimeProcessorSkip({
        runtimeResult,
        phoneNumberId: "phone-1",
        wabaId: "waba-1",
      }),
      false,
    );

    const updates: ReceiptUpdate[] = [];
    const runtime = {
      connectDB: async () => undefined,
      WhatsAppWebhookEvent: {
        findOneAndUpdate: () => ({
          select: () => ({
            lean: async () => ({
              _id: "message-event",
              status: "processing",
              attempts: 1,
              maxAttempts: 12,
              phoneNumberId: "phone-1",
              payload: {
                body: { object: "whatsapp_business_account", entry: [] },
              },
            }),
          }),
        }),
        updateOne: async (_filter: unknown, update: ReceiptUpdate) => {
          updates.push(update);
          return { modifiedCount: 1 };
        },
      },
      processWhatsAppWebhookPayload: async () => runtimeResult,
      whatsappWebhookRuntimeDependencies: {},
    };
    const result = await processStoredWhatsAppWebhookEvent(
      {
        contractVersion: 1,
        eventId: "message-event",
        dedupeKey: "message-key",
        field: "messages",
        orderingKey: "lane",
        receivedAt: "2026-10-18T00:00:00Z",
      },
      { runtime: runtime as never },
    );
    assert.equal(result.status, "completed");
    assert.equal(updates.length, 1);
    assert.equal(updates[0].$set.status, "completed");
    // The payload is untouched, so the 30-day replay window still applies.
    assert.equal("payload" in updates[0].$set, false);
    // The marker is what --plan-skipped selects, whatever the createdAt.
    assert.equal(updates[0].$set.planSkipReason, reason);
    assert.equal(updates[0].$unset, undefined);
  }
});

function createMessageReceiptRuntime(
  runtimeResult: Record<string, unknown>,
  message: Record<string, unknown>,
) {
  const updates: ReceiptUpdate[] = [];
  const runtime = {
    connectDB: async () => undefined,
    WhatsAppWebhookEvent: {
      findOneAndUpdate: () => ({
        select: () => ({
          lean: async () => ({
            _id: "message-event",
            status: "processing",
            attempts: 1,
            maxAttempts: 12,
            phoneNumberId: "phone-1",
            payload: {
              body: {
                object: "whatsapp_business_account",
                entry: [
                  {
                    id: "waba-1",
                    changes: [
                      { field: "messages", value: { messages: [message] } },
                    ],
                  },
                ],
              },
            },
          }),
        }),
      }),
      updateOne: async (_filter: unknown, update: ReceiptUpdate) => {
        updates.push(update);
        return { modifiedCount: 1 };
      },
    },
    processWhatsAppWebhookPayload: async () => runtimeResult,
    whatsappWebhookRuntimeDependencies: {},
  };
  return { runtime, updates };
}

const messageReceiptInput = {
  contractVersion: 1,
  eventId: "message-event",
  dedupeKey: "message-key",
  field: "messages",
  orderingKey: "lane",
  receivedAt: "2026-10-18T00:00:00Z",
};

test("a plan-skipped revoke is selected by --plan-skipped, and its replay clears the marker", async () => {
  const revoke = {
    id: "wamid.revoke",
    type: "revoke",
    revoke: { original_message_id: "wamid.original" },
  };
  const body = buildWhatsAppIntakePlanSkipBody(
    resolveWhatsAppIntakePlanSkip({
      trialExpired: true,
      newConversationsAllowed: false,
    })!,
  );
  const skipped = createMessageReceiptRuntime(
    { ok: true, code: "ok", message: body.message, details: body },
    revoke,
  );
  await processStoredWhatsAppWebhookEvent(messageReceiptInput, {
    runtime: skipped.runtime as never,
  });
  // --missing-only never selects a revoke; the receipt marker does.
  const { $in: selectedReasons } =
    buildWhatsAppPlanSkippedReceiptFilter().planSkipReason;
  assert.ok(
    selectedReasons.includes(
      skipped.updates[0].$set
        .planSkipReason as (typeof selectedReasons)[number],
    ),
  );

  // After the upgrade the replay applies the revoke and drops the marker, so
  // the next --plan-skipped run moves on to the remaining receipts.
  const replayed = createMessageReceiptRuntime(
    { ok: true, code: "ok", message: "message processed", details: {} },
    revoke,
  );
  const result = await processStoredWhatsAppWebhookEvent(messageReceiptInput, {
    runtime: replayed.runtime as never,
  });
  assert.equal(result.status, "completed");
  assert.equal("planSkipReason" in replayed.updates[0].$set, false);
  assert.deepEqual(replayed.updates[0].$unset, { planSkipReason: "" });
});

// Evaluates the processor's query filters so ordering tests exercise them.
function orderingRuntime(events: Array<Record<string, unknown>>) {
  const same = (a: unknown, b: unknown) =>
    a instanceof Date && b instanceof Date
      ? a.getTime() === b.getTime()
      : String(a) === String(b);
  const less = (a: unknown, b: unknown) =>
    a instanceof Date && b instanceof Date
      ? a.getTime() < b.getTime()
      : String(a) < String(b);
  const matches = (
    doc: Record<string, unknown>,
    filter: Record<string, unknown>,
  ): boolean =>
    Object.entries(filter).every(([key, expected]) => {
      if (key === "$and") {
        return (expected as Record<string, unknown>[]).every((part) =>
          matches(doc, part),
        );
      }
      if (key === "$or") {
        return (expected as Record<string, unknown>[]).some((part) =>
          matches(doc, part),
        );
      }
      const actual = doc[key];
      if (
        expected &&
        typeof expected === "object" &&
        !(expected instanceof Date)
      ) {
        const operators = expected as Record<string, unknown>;
        if ("$lt" in operators) return less(actual, operators.$lt);
        if ("$lte" in operators) {
          return less(actual, operators.$lte) || same(actual, operators.$lte);
        }
        if ("$in" in operators) {
          return (operators.$in as unknown[]).some((value) =>
            same(actual, value),
          );
        }
        throw new Error(`Unsupported operator on ${key}`);
      }
      return same(actual, expected);
    });
  return {
    connectDB: async () => undefined,
    WhatsAppWebhookEvent: {
      findById: (id: string) => ({
        select: () => ({
          lean: async () => events.find((event) => event._id === id) ?? null,
        }),
      }),
      findOne: (filter: Record<string, unknown>) => ({
        select: () => ({
          lean: async () =>
            events.find((event) => matches(event, filter)) ?? null,
        }),
      }),
    },
  } as never;
}

test("ordering state lets only a chat's head event run without Pub/Sub ordering", async () => {
  const now = new Date("2026-10-19T08:00:00.000Z");
  const at = (second: number) =>
    new Date(now.getTime() - 60_000 + second * 1000);
  const base = { orderingKey: "phone-1:message:chat-a", nextRetryAt: at(0) };
  const read = (events: Array<Record<string, unknown>>, eventId = "event-2") =>
    readWhatsAppWebhookEventOrderingState(eventId, {
      runtime: orderingRuntime(events),
      now: () => now,
    });
  const current = {
    ...base,
    _id: "event-2",
    status: "published",
    createdAt: at(2),
  };

  assert.deepEqual(await read([], "event-9"), { state: "missing" });
  assert.deepEqual(await read([{ ...current, status: "processing" }]), {
    state: "claimed",
  });
  for (const status of ["completed", "failed", "queued", "dead"]) {
    assert.deepEqual(await read([{ ...current, status }]), {
      state: "settled",
      status,
    });
  }
  assert.deepEqual(await read([current]), { state: "head" });

  for (const status of ["published", "processing"]) {
    assert.deepEqual(
      await read([
        current,
        { ...base, _id: "event-1", status, createdAt: at(1) },
      ]),
      { state: "waiting", predecessorEventId: "event-1" },
    );
  }
  assert.deepEqual(
    await read([
      current,
      { ...base, _id: "event-1", status: "received", createdAt: at(1) },
    ]),
    { state: "waiting", predecessorEventId: "event-1" },
  );
  // A predecessor whose publish failed waits for the drain, not this chat.
  assert.deepEqual(
    await read([
      current,
      {
        ...base,
        _id: "event-1",
        status: "received",
        createdAt: at(1),
        nextRetryAt: new Date(now.getTime() + 60_000),
      },
    ]),
    { state: "head" },
  );
  assert.deepEqual(
    await read([
      current,
      { ...base, _id: "event-1", status: "completed", createdAt: at(1) },
      { ...base, _id: "event-3", status: "published", createdAt: at(3) },
      {
        ...base,
        _id: "event-0",
        orderingKey: "phone-1:message:chat-b",
        status: "published",
        createdAt: at(0),
      },
    ]),
    { state: "head" },
  );
  // Same timestamp: the lower id was stored first.
  assert.deepEqual(
    await read([
      current,
      { ...base, _id: "event-1", status: "published", createdAt: at(2) },
    ]),
    { state: "waiting", predecessorEventId: "event-1" },
  );
  assert.deepEqual(
    await read([
      current,
      { ...base, _id: "event-3", status: "published", createdAt: at(2) },
    ]),
    { state: "head" },
  );
});
