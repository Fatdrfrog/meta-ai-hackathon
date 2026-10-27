import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

import type { BulkCampaignDispatchItem } from "@icecore/temporal";
import type { BulkCampaignReadiness } from "@icecore/scenario-contracts";
import { getWhatsAppGraphClient } from "@icecore/shared/lib/meta/api";

const requireFromTest = createRequire(import.meta.url) as NodeRequire;
const attemptPayloads: Array<Record<string, unknown>> = [];
const sentPayloads: Array<Record<string, unknown>> = [];
const conversationPayloads: Array<Record<string, unknown>> = [];
const acceptanceReads: Array<Record<string, unknown>> = [];
const sqlAcceptances = new Map<number, { messageId: string }>();
let acceptanceReadError: Error | null = null;
let receiptWriteError: Error | null = null;
let receiptReadError: Error | null = null;
let intentWriteError: Error | null = null;
let intentWriteAcknowledgementLost = false;
let intentClearOwnershipLost = false;
let transportThrows: Error | null = null;
let onProviderSend: (() => Promise<void>) | null = null;
let providerPosts = 0;
let readiness: BulkCampaignReadiness;
let readinessError: Error | null = null;
const readinessCalls: Array<Record<string, unknown>> = [];
let readinessForWaba:
  | ((wabaId: string) => Promise<BulkCampaignReadiness>)
  | null = null;
let onAcceptanceRead: ((params: Record<string, unknown>) => void) | null = null;
const dedupeRecords = new Map<
  string,
  {
    messageId?: string;
    workspaceId?: string;
    recipient: string;
    channel: string;
    state?: string;
    intentToken?: string;
    createdAt?: Date | null;
  }
>();
let messageSequence = 0;
let singleTransportResult: Record<string, unknown> | null = null;
const transportContactPolicies: unknown[] = [];
/** Consumed before singleTransportResult; a function runs at send time. */
const transportResultQueue: Array<
  Record<string, unknown> | (() => Record<string, unknown>)
> = [];
let storedProviderCircuit: {
  state: "open" | "closed";
  provider?: string;
  code?: string;
} = { state: "closed" };
let circuitReadError: Error | null = null;
const circuitReads: Array<Record<string, unknown>> = [];
const receiptReads: string[] = [];
const capacityChecks: Array<{ acceptanceReadsSoFar: number }> = [];
let capacityError: Error | null = null;
let onReceiptWrite: (() => Promise<void>) | null = null;
let onSentPersist: (() => void) | null = null;

function installWebModule(specifier: string, exports: unknown) {
  const resolved = requireFromTest.resolve(specifier);
  requireFromTest.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports,
    children: [],
    paths: [],
  } as unknown as NodeModule;
}

installWebModule("../../../apps/web/src/lib/mongoose", {
  __esModule: true,
  default: async () => undefined,
});
installWebModule("../../../apps/web/src/lib/campaign/campaign-transport", {
  renderCampaignEmail: async () => ({
    subject: "Subject",
    html: "<p>Body</p>",
    text: "Body",
  }),
  sendCampaignTransportSingle: async (request: {
    beforeProviderSend?: () => Promise<void>;
    contactPolicy?: unknown;
  }) => {
    transportContactPolicies.push(request.contactPolicy);
    try {
      await request.beforeProviderSend?.();
    } catch (error) {
      return { success: false, provider: "meta", error: String(error) };
    }
    providerPosts++;
    await onProviderSend?.();
    if (transportThrows) throw transportThrows;
    const queued = transportResultQueue.shift();
    return (
      (typeof queued === "function" ? queued() : queued) ||
      singleTransportResult || {
        success: true,
        messageId: `provider-message-${messageSequence++}`,
        provider: "meta",
        providerRequestAttempted: true,
      }
    );
  },
  sendCampaignTransportBatch: async (request: {
    messages?: Array<Record<string, unknown>>;
  }) => ({
    success: true,
    results: (request.messages || []).map(() => ({
      success: true,
      messageId: `provider-message-${messageSequence++}`,
      provider: "postmark",
    })),
  }),
});
installWebModule("../../../apps/web/src/lib/cross-store-outbox", {
  findCampaignMessageAcceptance: async (params: Record<string, unknown>) => {
    acceptanceReads.push(params);
    onAcceptanceRead?.(params);
    if (acceptanceReadError) throw acceptanceReadError;
    return sqlAcceptances.get(Number(params.snapshotOrdinal)) || null;
  },
  persistCampaignMessageAttemptWithOutbox: async (
    payload: Record<string, unknown>,
  ) => {
    attemptPayloads.push(payload);
    return { applied: true, queuedToOutbox: false };
  },
  persistCampaignMessageSentWithOutbox: async (
    payload: Record<string, unknown>,
  ) => {
    onSentPersist?.();
    sentPayloads.push(payload);
    sqlAcceptances.set(Number(payload.snapshotOrdinal), {
      messageId: String(payload.messageId),
    });
    return { applied: true, queuedToOutbox: false };
  },
});
installWebModule(
  "../../../apps/web/src/lib/campaign/campaign-conversation-persistence",
  {
    persistCampaignEmailConversationMessage: async () => ({
      persisted: true,
    }),
    persistCampaignWhatsAppConversationMessage: async (
      payload: Record<string, unknown>,
    ) => {
      conversationPayloads.push(payload);
      return { persisted: true };
    },
  },
);
installWebModule("../../../apps/web/src/lib/campaign/campaign-stats", {
  reconcileLegacyCampaignSendTotals: async () => ({ ok: true }),
});
installWebModule("../../../apps/web/src/lib/campaign/bulk-campaign-safety", {
  classifyBulkCampaignProviderCircuit: () => ({ state: "closed" }),
});
installWebModule("../../../apps/web/src/lib/campaign/campaign-history-store", {
  getCampaignDispatchProviderCircuit: async (
    params: Record<string, unknown>,
  ) => {
    circuitReads.push(params);
    if (circuitReadError) throw circuitReadError;
    return storedProviderCircuit;
  },
  beginCampaignDispatch: async () => ({
    outcome: "started",
    status: "running",
    workflowId: "workflow-1",
  }),
  finalizeCampaignDispatch: async () => true,
  reconcileCampaignDispatchCancellation: async () => ({
    outcome: "not_found",
    status: null,
  }),
  updateCampaignDispatchProgress: async () => true,
});
installWebModule("../../../apps/web/src/lib/whatsapp/send-context", {
  resolveFreshWhatsAppSendContext: async (params: {
    workspaceId?: string;
    sourceId?: string;
  }) => ({
    workspaceId: params.workspaceId,
    sourceId: params.sourceId,
    phoneNumberId: "phone-number-1",
    accessToken: "test-token",
    wabaId: params.sourceId === "source-2" ? "waba-2" : "waba-1",
    messagingAccountId: "account-1",
    marketingMessagesEnabled: true,
  }),
});
test.mock.method(
  getWhatsAppGraphClient(),
  "getJson",
  async (wabaId: string) => {
    readinessCalls.push({ wabaId });
    if (readinessError) throw readinessError;
    const decision = readinessForWaba
      ? await readinessForWaba(wabaId)
      : readiness;
    return {
      health_status: {
        can_send_message:
          decision.state === "ready"
            ? "AVAILABLE"
            : decision.state === "blocked"
              ? "BLOCKED"
              : "UNKNOWN",
        entities:
          decision.state === "blocked"
            ? [
                {
                  can_send_message: "BLOCKED",
                  errors: decision.reasons.flatMap((reason) =>
                    reason.providerCode
                      ? [{ error_code: reason.providerCode }]
                      : [],
                  ),
                },
              ]
            : [],
      },
    };
  },
);
installWebModule("../../../apps/web/src/lib/telegram/validate-source", {
  fetchAndValidateTelegramSource: async () => ({ valid: false }),
});
installWebModule("../../../apps/web/src/lib/telegram/subscribers", {
  markTelegramSubscriberSendResult: async () => undefined,
});
installWebModule("../../../apps/web/src/lib/limits/company-limits", {
  COMPANY_CONVERSATION_LIMIT_EXCEEDED_CODE: "company_limit_exceeded",
  ensureCompanyConversationCapacity: async () => {
    capacityChecks.push({ acceptanceReadsSoFar: acceptanceReads.length });
    if (capacityError) throw capacityError;
    return { allowed: true };
  },
});
installWebModule("../../../apps/web/src/lib/supabase/admin", {
  supabaseAdmin: {},
});
installWebModule("../../../apps/web/src/models/bulk-dispatch-activity-dedupe", {
  __esModule: true,
  default: {
    findOne: ({ key }: { key: string }) => ({
      select: () => ({
        lean: async () => {
          receiptReads.push(key);
          if (receiptReadError) throw receiptReadError;
          return dedupeRecords.get(key) || null;
        },
      }),
    }),
    create: async (params: {
      key: string;
      messageId: string;
      recipient: string;
      channel: string;
    }) => {
      if (receiptWriteError) throw receiptWriteError;
      dedupeRecords.set(params.key, {
        messageId: params.messageId,
        recipient: params.recipient,
        channel: params.channel,
      });
    },
    updateOne: async (
      filter: Record<string, unknown>,
      update: {
        $setOnInsert?: Record<string, unknown>;
        $set?: Record<string, unknown>;
        $unset?: Record<string, unknown>;
      },
    ) => {
      const key = String(filter.key);
      const existing = dedupeRecords.get(key);
      if (update.$setOnInsert?.state === "attempted") {
        if (intentWriteError) throw intentWriteError;
        if (existing) return { upsertedCount: 0, matchedCount: 1 };
        dedupeRecords.set(key, update.$setOnInsert as never);
        if (intentWriteAcknowledgementLost)
          throw new Error("intent acknowledgement lost");
        return { upsertedCount: 1 };
      }
      await onReceiptWrite?.();
      if (receiptWriteError) throw receiptWriteError;
      if (existing?.messageId) throw { code: 11000 };
      const next: Record<string, unknown> = {
        ...filter,
        ...existing,
        ...update.$set,
      };
      for (const field of Object.keys(update.$unset || {})) delete next[field];
      dedupeRecords.set(key, next as never);
      return existing
        ? { matchedCount: 1, modifiedCount: 1 }
        : { upsertedCount: 1 };
    },
    deleteOne: async (filter: { key: string; intentToken: string }) => {
      if (intentClearOwnershipLost) return { deletedCount: 0 };
      const existing = dedupeRecords.get(filter.key);
      if (
        !existing?.messageId &&
        existing?.intentToken === filter.intentToken
      ) {
        dedupeRecords.delete(filter.key);
        return { deletedCount: 1 };
      }
      return { deletedCount: 0 };
    },
  },
});

const {
  dispatchBulkCampaignBatch,
  MAX_BULK_CAMPAIGN_DISPATCH_CONCURRENCY,
  resolveBulkCampaignDispatchConcurrency,
} = await import("./bulk-campaign-dispatch");

const campaignId = "11111111-1111-4111-8111-111111111111";
const activityContext = {
  activityDedupePrefix: "activity",
  lifecycleManaged: true,
  campaignId,
};

const { setBulkDispatchThroughputBackoffForTests } = await import(
  "./bulk-campaign-dispatch"
);

function whatsappItem(snapshotOrdinal: number): BulkCampaignDispatchItem {
  return {
    channel: "whatsapp",
    workspaceId: "workspace-1",
    campaignId,
    snapshotOrdinal,
    sourceId: "source-1",
    recipient: { phone: "+7 701 000 00 01" },
    phoneNumberId: "phone-number-1",
    templateName: "launch",
    templateCategory: "MARKETING",
  };
}

function emailItem(snapshotOrdinal: number): BulkCampaignDispatchItem {
  return {
    channel: "email",
    workspaceId: "workspace-1",
    campaignId,
    snapshotOrdinal,
    recipient: { email: "person@example.com" },
    templateKey: "announcement",
  };
}

test.beforeEach(() => {
  attemptPayloads.length = 0;
  sentPayloads.length = 0;
  conversationPayloads.length = 0;
  acceptanceReads.length = 0;
  sqlAcceptances.clear();
  acceptanceReadError = null;
  receiptWriteError = null;
  receiptReadError = null;
  intentWriteError = null;
  intentWriteAcknowledgementLost = false;
  intentClearOwnershipLost = false;
  transportThrows = null;
  onProviderSend = null;
  providerPosts = 0;
  readinessError = null;
  readinessCalls.length = 0;
  readinessForWaba = null;
  onAcceptanceRead = null;
  readiness = {
    state: "ready",
    checkedAt: new Date().toISOString(),
    remainingCapacity: null,
    reasons: [],
  };
  dedupeRecords.clear();
  messageSequence = 0;
  singleTransportResult = null;
  transportContactPolicies.length = 0;
  transportResultQueue.length = 0;
  setBulkDispatchThroughputBackoffForTests([0, 0, 0]);
  storedProviderCircuit = { state: "closed" };
  circuitReadError = null;
  circuitReads.length = 0;
  receiptReads.length = 0;
  capacityChecks.length = 0;
  capacityError = null;
  onReceiptWrite = null;
  onSentPersist = null;
});

test("an asynchronous provider restriction stops the next batch without attempting recipients", async () => {
  await dispatchBulkCampaignBatch([whatsappItem(0)], activityContext);
  storedProviderCircuit = { state: "open", provider: "meta", code: "131048" };
  const nextBatch = await dispatchBulkCampaignBatch(
    [whatsappItem(1), whatsappItem(2)],
    { ...activityContext, activityDedupePrefix: "next-batch" },
  );
  assert.equal(messageSequence, 1);
  assert.equal(attemptPayloads.length, 1);
  assert.equal(sentPayloads.length, 1);
  assert.equal(nextBatch.successfulSends, 0);
  assert.equal(nextBatch.failedSends, 0);
  assert.equal(nextBatch.notAttemptedSends, 2);
  assert.equal(nextBatch.providerCircuit?.state, "open");
  assert.equal(nextBatch.providerCircuit?.code, "131048");
  assert.ok(nextBatch.results.every((result) => result.attempted === false));
  assert.equal(circuitReads.length, 2);
  assert.equal(circuitReads[1]?.workspaceId, "workspace-1");
  assert.equal(circuitReads[1]?.campaignId, campaignId);
});

test("circuit lookup failure blocks sending and leaves activity retry safe", async () => {
  circuitReadError = new Error("circuit database unavailable");
  await assert.rejects(
    dispatchBulkCampaignBatch([whatsappItem(0)], activityContext),
    /circuit database unavailable/,
  );
  assert.equal(messageSequence, 0);
  assert.equal(attemptPayloads.length, 0);
});

test("an opened circuit preserves accepted items when the same activity is retried", async () => {
  storedProviderCircuit = { state: "open", provider: "meta", code: "131048" };
  dedupeRecords.set("activity:0", {
    messageId: "provider-message-already-accepted",
    recipient: "+7 701 000 00 01",
    channel: "whatsapp",
  });
  const result = await dispatchBulkCampaignBatch(
    [whatsappItem(0), whatsappItem(1)],
    activityContext,
  );
  assert.equal(messageSequence, 0);
  assert.equal(attemptPayloads.length, 0);
  assert.equal(sentPayloads.length, 1);
  assert.equal(sentPayloads[0]?.snapshotOrdinal, 0);
  assert.equal(result.successfulSends, 1);
  assert.equal(result.notAttemptedSends, 1);
  assert.equal(result.failedSends, 0);
  assert.equal(result.results[0]?.deduped, true);
  assert.equal(result.results[1]?.attempted, false);
  assert.equal(result.providerCircuit?.state, "open");
});

test("ordinary same-recipient sends preserve each ordinal through attempted and sent transitions", async () => {
  await dispatchBulkCampaignBatch(
    [whatsappItem(0), whatsappItem(1)],
    activityContext,
  );

  assert.deepEqual(
    attemptPayloads.map((payload) => payload.snapshotOrdinal).sort(),
    [0, 1],
  );
  assert.deepEqual(
    sentPayloads.map((payload) => payload.snapshotOrdinal).sort(),
    [0, 1],
  );
});

test("the recipient file's name reaches the campaign conversation", async () => {
  const named = whatsappItem(0);
  if (named.channel !== "whatsapp") throw new Error("expected WhatsApp");
  named.recipient = { ...named.recipient, name: "Aigerim" };

  await dispatchBulkCampaignBatch([named, whatsappItem(1)], activityContext);

  assert.deepEqual(
    conversationPayloads.map((payload) => payload.recipientName),
    ["Aigerim", null],
  );
});

const CONCURRENCY_ENV = "BULK_CAMPAIGN_DISPATCH_CONCURRENCY";

/** Returns a setter for the env value; the original is restored once after the test. */
function useDispatchConcurrencyEnv(t: { after: (fn: () => void) => void }) {
  const original = process.env[CONCURRENCY_ENV];
  t.after(() => {
    if (original === undefined) delete process.env[CONCURRENCY_ENV];
    else process.env[CONCURRENCY_ENV] = original;
  });
  return (value: string | undefined) => {
    if (value === undefined) delete process.env[CONCURRENCY_ENV];
    else process.env[CONCURRENCY_ENV] = value;
  };
}

test("resolves dispatch concurrency from the worker env within its bounds", (t) => {
  const setConcurrencyEnv = useDispatchConcurrencyEnv(t);
  for (const [value, expected] of [
    [undefined, 3],
    ["", 3],
    ["ten", 3],
    ["-4", 3],
    ["0", 1],
    ["12", 12],
    ["500", MAX_BULK_CAMPAIGN_DISPATCH_CONCURRENCY],
  ] as const) {
    setConcurrencyEnv(value);
    assert.equal(
      resolveBulkCampaignDispatchConcurrency(),
      expected,
      String(value),
    );
  }
  assert.equal(MAX_BULK_CAMPAIGN_DISPATCH_CONCURRENCY, 25);
});

test("runs as many provider sends at once as the configured concurrency allows", async (t) => {
  const setConcurrencyEnv = useDispatchConcurrencyEnv(t);
  let firstOrdinal = 0;
  async function peakSends(value: string | undefined, itemCount: number) {
    setConcurrencyEnv(value);
    let active = 0;
    let peak = 0;
    onProviderSend = async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
    };
    const items = Array.from({ length: itemCount }, (_, index) =>
      whatsappItem(firstOrdinal + index),
    );
    const result = await dispatchBulkCampaignBatch(items, {
      ...activityContext,
      activityDedupePrefix: `concurrency-${firstOrdinal}`,
    });
    firstOrdinal += itemCount;
    assert.equal(result.successfulSends, itemCount);
    return peak;
  }

  assert.equal(await peakSends(undefined, 8), 3);
  assert.equal(await peakSends("5", 8), 5);
  assert.equal(await peakSends("1", 4), 1);
  assert.equal(await peakSends("500", 30), 25);
});

test("a deduped activity retry persists sent state against the same ordinal", async () => {
  readinessError = new Error("readiness unavailable after acceptance");
  dedupeRecords.set("activity:0", {
    messageId: "provider-message-existing",
    recipient: "+7 701 000 00 01",
    channel: "whatsapp",
  });

  await dispatchBulkCampaignBatch([whatsappItem(5)], activityContext);

  assert.equal(attemptPayloads.length, 0);
  assert.equal(sentPayloads.length, 1);
  assert.equal(sentPayloads[0]?.snapshotOrdinal, 5);
  assert.equal(acceptanceReads.length, 0);
  assert.equal(readinessCalls.length, 0);
});

test("SQL acceptance prevents a second provider send after every Mongo receipt write fails", async () => {
  receiptWriteError = new Error("receipt store unavailable");
  const first = await dispatchBulkCampaignBatch(
    [whatsappItem(5)],
    activityContext,
  );
  assert.equal(first.successfulSends, 1);
  assert.equal(dedupeRecords.get("activity:0")?.messageId, undefined);
  assert.equal(sqlAcceptances.get(5)?.messageId, "provider-message-0");

  const replay = await dispatchBulkCampaignBatch(
    [whatsappItem(5)],
    activityContext,
  );

  assert.equal(messageSequence, 1);
  assert.equal(attemptPayloads.length, 1);
  assert.equal(replay.results[0]?.messageId, first.results[0]?.messageId);
  assert.equal(replay.results[0]?.deduped, true);
  assert.equal(conversationPayloads.length, 2);
  assert.equal(conversationPayloads[1]?.messageId, "provider-message-0");
  assert.equal(acceptanceReads[1]?.workspaceId, "workspace-1");
  assert.equal(acceptanceReads[1]?.campaignId, campaignId);
  assert.equal(acceptanceReads[1]?.snapshotOrdinal, 5);
  assert.equal(readinessCalls.length, 1);
});

test("SQL acceptance recovers before an opened circuit while another ordinal stays suppressed", async () => {
  sqlAcceptances.set(0, { messageId: "provider-message-already-accepted" });
  storedProviderCircuit = { state: "open", provider: "meta", code: "131048" };

  const replay = await dispatchBulkCampaignBatch(
    [whatsappItem(0), whatsappItem(1)],
    activityContext,
  );

  assert.equal(messageSequence, 0);
  assert.equal(attemptPayloads.length, 0);
  assert.equal(replay.results[0]?.deduped, true);
  assert.equal(
    replay.results[0]?.messageId,
    "provider-message-already-accepted",
  );
  assert.equal(replay.successfulSends, 1);
  assert.equal(replay.notAttemptedSends, 1);
  assert.equal(sentPayloads[0]?.snapshotOrdinal, 0);
  assert.equal(readinessCalls.length, 0);
});

test("live Meta health stops new attempts after queueing with one lookup per business account", async () => {
  readiness = {
    ...readiness,
    state: "blocked",
    reasons: [{ code: "meta_business_limit", providerCode: "141015" }],
  };

  const result = await dispatchBulkCampaignBatch(
    [whatsappItem(0), whatsappItem(1), whatsappItem(2), whatsappItem(3)],
    activityContext,
  );

  assert.equal(messageSequence, 0);
  assert.equal(attemptPayloads.length, 0);
  assert.equal(sentPayloads.length, 0);
  assert.equal(readinessCalls.length, 1);
  assert.equal(readinessCalls[0]?.wabaId, "waba-1");
  assert.equal(result.failedSends, 0);
  assert.equal(result.notAttemptedSends, 4);
  assert.equal(result.providerCircuit?.state, "open");
  assert.equal(result.providerCircuit?.code, "141015");
  assert.ok(result.results.every((item) => item.attempted === false));
});

test("a failed health lookup stops the batch without fabricating a numeric Meta error", async () => {
  readinessError = new Error("provider health timeout");

  const result = await dispatchBulkCampaignBatch(
    [whatsappItem(0)],
    activityContext,
  );

  assert.equal(messageSequence, 0);
  assert.equal(attemptPayloads.length, 0);
  assert.equal(result.notAttemptedSends, 1);
  assert.equal(result.failedSends, 0);
  assert.equal(result.providerCircuit?.state, "open");
  assert.equal(result.providerCircuit?.code, "meta_check_unavailable");
});

test(
  "a blocked account stops other sources that are awaiting readiness and later batch items",
  { timeout: 2_000 },
  async () => {
    let releaseReady!: (value: BulkCampaignReadiness) => void;
    const readyDecision = new Promise<BulkCampaignReadiness>((resolve) => {
      releaseReady = resolve;
    });
    let blockedWorkerAdvanced!: () => void;
    const nextItemStarted = new Promise<void>((resolve) => {
      blockedWorkerAdvanced = resolve;
    });
    readinessForWaba = async (wabaId) =>
      wabaId === "waba-2"
        ? {
            ...readiness,
            state: "blocked",
            reasons: [{ code: "meta_sender_restricted" }],
          }
        : readyDecision;
    onAcceptanceRead = (params) => {
      if (params.snapshotOrdinal === 3) blockedWorkerAdvanced();
    };
    const items = [
      whatsappItem(0),
      { ...whatsappItem(1), sourceId: "source-2" },
      whatsappItem(2),
      whatsappItem(3),
    ];

    const dispatch = dispatchBulkCampaignBatch(items, activityContext);
    // Only the blocked worker can advance: the other two share a pending health read.
    await nextItemStarted;
    releaseReady(readiness);
    const result = await dispatch;

    assert.equal(messageSequence, 0);
    assert.equal(attemptPayloads.length, 0);
    assert.equal(readinessCalls.length, 2);
    assert.equal(result.notAttemptedSends, 4);
    assert.equal(result.providerCircuit?.code, "meta_sender_restricted");
  },
);

test("Meta readiness is refreshed for the next batch rather than cached across dispatch", async () => {
  await dispatchBulkCampaignBatch([whatsappItem(0)], activityContext);
  readiness = {
    ...readiness,
    state: "blocked",
    reasons: [{ code: "meta_sender_restricted", providerCode: "131048" }],
  };

  const result = await dispatchBulkCampaignBatch([whatsappItem(1)], {
    ...activityContext,
    activityDedupePrefix: "next-batch",
  });

  assert.equal(messageSequence, 1);
  assert.equal(readinessCalls.length, 2);
  assert.equal(attemptPayloads.length, 1);
  assert.equal(result.notAttemptedSends, 1);
  assert.equal(result.providerCircuit?.code, "131048");
});

test("service-window text does not use the business-initiated health gate", async () => {
  readinessError = new Error("must not inspect template health");
  const item: BulkCampaignDispatchItem = {
    channel: "whatsapp",
    workspaceId: "workspace-1",
    campaignId,
    snapshotOrdinal: 0,
    sourceId: "source-1",
    recipient: { phone: "77010000001" },
    phoneNumberId: "phone-number-1",
    whatsappMessageType: "service_text",
    messageText: "Reply within the customer service window",
    serviceWindowExpiresAt: new Date(Date.now() + 60_000).toISOString(),
  };

  const result = await dispatchBulkCampaignBatch([item], activityContext);

  assert.equal(readinessCalls.length, 0);
  assert.equal(messageSequence, 1);
  assert.equal(result.successfulSends, 1);
});

test("an unknown SQL acceptance blocks the activity without sending or marking a recipient failed", async () => {
  acceptanceReadError = new Error("acceptance database unavailable");

  await assert.rejects(
    dispatchBulkCampaignBatch([whatsappItem(0)], activityContext),
    /acceptance database unavailable/,
  );

  assert.equal(messageSequence, 0);
  assert.equal(attemptPayloads.length, 0);
  assert.equal(sentPayloads.length, 0);
  assert.equal(conversationPayloads.length, 0);
});

test("an unreadable Mongo receipt fails closed before SQL recovery or a provider attempt", async () => {
  receiptReadError = new Error("receipt lookup unavailable");

  await assert.rejects(
    dispatchBulkCampaignBatch([whatsappItem(0)], activityContext),
    /receipt lookup unavailable/,
  );

  assert.equal(messageSequence, 0);
  assert.equal(acceptanceReads.length, 0);
  assert.equal(attemptPayloads.length, 0);
  assert.equal(readinessCalls.length, 0);
});

test("email batch attempt and sent transitions retain each dispatch ordinal", async () => {
  await dispatchBulkCampaignBatch(
    [emailItem(4), emailItem(5)],
    activityContext,
  );

  assert.deepEqual(
    attemptPayloads.map((payload) => payload.snapshotOrdinal),
    [4, 5],
  );
  assert.deepEqual(
    sentPayloads.map((payload) => payload.snapshotOrdinal),
    [4, 5],
  );
});

test("provider failures retain the attempted item's dispatch ordinal", async () => {
  singleTransportResult = {
    success: false,
    error: "provider rejected message",
    provider: "meta",
    providerCode: "131026",
    failureScope: "recipient",
    providerRequestAttempted: true,
  };

  await dispatchBulkCampaignBatch([whatsappItem(3)], activityContext);

  assert.deepEqual(
    attemptPayloads.map((payload) => ({
      status: payload.status,
      snapshotOrdinal: payload.snapshotOrdinal,
    })),
    [
      { status: "attempted", snapshotOrdinal: 3 },
      { status: "failed", snapshotOrdinal: 3 },
    ],
  );
});

test("a lost provider response leaves durable intent and activity replay never posts again", async () => {
  singleTransportResult = {
    success: false,
    provider: "meta",
    error: "response lost",
    providerRequestAttempted: true,
    providerAcceptanceUnknown: true,
  };
  await assert.rejects(
    dispatchBulkCampaignBatch([whatsappItem(0)], activityContext),
    /acceptance.*unknown/i,
  );
  assert.equal(providerPosts, 1);
  assert.equal(dedupeRecords.get("activity:0")?.state, "attempted");
  assert.equal(dedupeRecords.get("activity:0")?.createdAt, null);
  assert.equal(
    attemptPayloads.some((payload) => payload.status === "failed"),
    false,
  );
  singleTransportResult = null;
  await assert.rejects(
    dispatchBulkCampaignBatch([whatsappItem(0)], activityContext),
    /acceptance.*unknown/i,
  );
  assert.equal(providerPosts, 1);
});

test("a provider-boundary crash leaves intent that prevents activity retry from sending", async () => {
  transportThrows = new Error("simulated crash after provider accepted");
  await assert.rejects(
    dispatchBulkCampaignBatch([whatsappItem(0)], activityContext),
    /acceptance.*unknown/i,
  );
  transportThrows = null;
  await assert.rejects(
    dispatchBulkCampaignBatch([whatsappItem(0)], activityContext),
    /acceptance.*unknown/i,
  );
  assert.equal(providerPosts, 1);
  assert.equal(
    attemptPayloads.some((payload) => payload.status === "failed"),
    false,
  );
});

test("unconfirmed intent persistence stops before provider I/O without recording a recipient failure", async () => {
  intentWriteError = new Error("intent store unavailable");
  await assert.rejects(
    dispatchBulkCampaignBatch([whatsappItem(0)], activityContext),
    /intent store unavailable/,
  );
  assert.equal(providerPosts, 0);
  assert.equal(
    attemptPayloads.some((payload) => payload.status === "failed"),
    false,
  );
});

test("definitive Meta rejection clears only that attempt so activity retry can try again", async () => {
  // No throughput resends left: the rejection ends this attempt.
  setBulkDispatchThroughputBackoffForTests([]);
  singleTransportResult = {
    success: false,
    provider: "meta",
    error: "rate limit",
    providerCode: "130429",
    providerRequestAttempted: true,
    failureScope: "provider",
  };
  await dispatchBulkCampaignBatch([whatsappItem(0)], activityContext);
  assert.equal(dedupeRecords.has("activity:0"), false);
  singleTransportResult = null;
  const replay = await dispatchBulkCampaignBatch(
    [whatsappItem(0)],
    activityContext,
  );
  assert.equal(providerPosts, 2);
  assert.equal(replay.successfulSends, 1);
  assert.equal(
    dedupeRecords.get("activity:0")?.messageId,
    "provider-message-0",
  );
});

const throughputRejection = {
  success: false,
  provider: "meta",
  error: "(#130429) Rate limit hit",
  providerCode: "130429",
  providerRequestAttempted: true,
  failureScope: "provider",
};

test("resends a Meta 130429 after backoff and records the later acceptance", async () => {
  transportResultQueue.push(throughputRejection);

  const result = await dispatchBulkCampaignBatch(
    [whatsappItem(0)],
    activityContext,
  );

  assert.equal(result.successfulSends, 1);
  assert.equal(result.failedSends, 0);
  assert.equal(providerPosts, 2);
  assert.deepEqual(
    attemptPayloads.map((payload) => payload.status),
    ["attempted"],
  );
  assert.equal(sentPayloads.length, 1);
  assert.equal(
    dedupeRecords.get("activity:0")?.messageId,
    "provider-message-0",
  );
});

test("records the throughput failure once the backoff schedule is used up", async () => {
  singleTransportResult = throughputRejection;

  const result = await dispatchBulkCampaignBatch(
    [whatsappItem(0)],
    activityContext,
  );

  assert.equal(providerPosts, 4);
  assert.equal(result.failedSends, 1);
  assert.equal(result.results[0]?.code, "130429");
  assert.deepEqual(
    attemptPayloads.map((payload) => ({
      status: payload.status,
      code: (payload.providerError as { code?: string } | undefined)?.code,
    })),
    [
      { status: "attempted", code: undefined },
      { status: "failed", code: "130429" },
    ],
  );
  assert.equal(dedupeRecords.has("activity:0"), false);
});

test("reserves the contact slot under the campaign recipient key a failed status can rebuild", async () => {
  transportResultQueue.push(throughputRejection);

  await dispatchBulkCampaignBatch([whatsappItem(0)], activityContext);

  // The resend after 130429 reuses the same key, so it never takes a 2nd slot.
  assert.deepEqual(transportContactPolicies, [
    {
      workspaceId: "workspace-1",
      deliveryKey: `campaign:${campaignId}:77010000001`,
    },
    {
      workspaceId: "workspace-1",
      deliveryKey: `campaign:${campaignId}:77010000001`,
    },
  ]);
});

test("stops resending 130429 for the rest of the batch once one item runs out of resends", async (t) => {
  const setConcurrencyEnv = useDispatchConcurrencyEnv(t);
  setConcurrencyEnv("1");
  singleTransportResult = throughputRejection;

  const result = await dispatchBulkCampaignBatch(
    [whatsappItem(0), whatsappItem(1), whatsappItem(2), whatsappItem(3)],
    activityContext,
  );

  // 1 send + 3 resends for the first item, then one send each for the rest.
  assert.equal(providerPosts, 7);
  assert.equal(result.failedSends, 4);
  assert.deepEqual(
    result.results.map((item) => item.code),
    ["130429", "130429", "130429", "130429"],
  );
});

test("does not resend a 130429 once the batch circuit opens during the wait", async () => {
  setBulkDispatchThroughputBackoffForTests([50]);
  let markFirstSend!: () => void;
  const firstSend = new Promise<void>((resolve) => {
    markFirstSend = resolve;
  });
  transportResultQueue.push(() => {
    markFirstSend();
    return throughputRejection;
  });
  readinessForWaba = async (wabaId) => {
    if (wabaId !== "waba-2") return readiness;
    await firstSend;
    return {
      ...readiness,
      state: "blocked",
      reasons: [{ code: "meta_sender_restricted" }],
    };
  };

  const items = [whatsappItem(0), { ...whatsappItem(1), sourceId: "source-2" }];
  const result = await dispatchBulkCampaignBatch(items, activityContext);

  assert.equal(providerPosts, 1);
  assert.equal(result.results[0]?.code, "130429");
  assert.equal(result.results[1]?.attempted, false);
  assert.deepEqual(
    attemptPayloads.map((payload) => payload.status),
    ["attempted", "failed"],
  );
});

test("does not resend other definitive Meta rejections", async () => {
  singleTransportResult = {
    ...throughputRejection,
    error: "(#131048) Spam rate limit hit",
    providerCode: "131048",
  };

  await dispatchBulkCampaignBatch([whatsappItem(0)], activityContext);

  assert.equal(providerPosts, 1);
});

test("SQL acceptance resolves a pending intent before mutable readiness checks", async () => {
  dedupeRecords.set("activity:0", {
    workspaceId: "workspace-1",
    channel: "whatsapp",
    recipient: "+7 701 000 00 01",
    state: "attempted",
    intentToken: "crashed-token",
    createdAt: null,
  });
  sqlAcceptances.set(0, { messageId: "wamid-recovered" });
  readinessError = new Error("must not check readiness");
  const replay = await dispatchBulkCampaignBatch(
    [whatsappItem(0)],
    activityContext,
  );
  assert.equal(replay.results[0]?.messageId, "wamid-recovered");
  assert.equal(replay.results[0]?.deduped, true);
  assert.equal(providerPosts, 0);
  assert.equal(dedupeRecords.get("activity:0")?.messageId, "wamid-recovered");
});

test("legacy ad hoc activity also retains uncertainty without lifecycle SQL", async () => {
  const context = { activityDedupePrefix: "legacy-activity" };
  singleTransportResult = {
    success: false,
    provider: "meta",
    error: "empty message ID",
    providerRequestAttempted: true,
    providerAcceptanceUnknown: true,
  };
  await assert.rejects(
    dispatchBulkCampaignBatch([whatsappItem(0)], context),
    /acceptance.*unknown/i,
  );
  singleTransportResult = null;
  await assert.rejects(
    dispatchBulkCampaignBatch([whatsappItem(0)], context),
    /acceptance.*unknown/i,
  );
  assert.equal(providerPosts, 1);
});

test("an unconfirmed committed intent stays nonexpiring and blocks a later activity retry", async () => {
  intentWriteAcknowledgementLost = true;
  await assert.rejects(
    dispatchBulkCampaignBatch([whatsappItem(0)], activityContext),
    /intent acknowledgement lost/,
  );
  intentWriteAcknowledgementLost = false;
  await assert.rejects(
    dispatchBulkCampaignBatch([whatsappItem(0)], activityContext),
    /acceptance.*unknown/i,
  );
  assert.equal(providerPosts, 0);
  assert.equal(dedupeRecords.get("activity:0")?.createdAt, null);
  assert.equal(
    attemptPayloads.some((payload) => payload.status === "failed"),
    false,
  );
});

test("concurrent execution of the same activity item crosses the provider boundary only once", async () => {
  const outcomes = await Promise.allSettled([
    dispatchBulkCampaignBatch([whatsappItem(0)], activityContext),
    dispatchBulkCampaignBatch([whatsappItem(0)], activityContext),
  ]);
  assert.equal(providerPosts, 1);
  assert.equal(
    outcomes.filter((result) => result.status === "fulfilled").length,
    1,
  );
  const replay = await dispatchBulkCampaignBatch(
    [whatsappItem(0)],
    activityContext,
  );
  assert.equal(replay.results[0]?.deduped, true);
  assert.equal(providerPosts, 1);
});

test("lost intent ownership after rejection cannot overwrite lifecycle state with a failure", async () => {
  intentClearOwnershipLost = true;
  singleTransportResult = {
    success: false,
    provider: "meta",
    error: "rate limit",
    providerCode: "130429",
    providerRequestAttempted: true,
    failureScope: "provider",
  };
  await assert.rejects(
    dispatchBulkCampaignBatch([whatsappItem(0)], activityContext),
    /acceptance.*unknown/i,
  );
  assert.equal(providerPosts, 1);
  assert.equal(
    attemptPayloads.some((payload) => payload.status === "failed"),
    false,
  );
});

test("does not read conversation capacity for a batch whose provider circuit is already open", async () => {
  storedProviderCircuit = { state: "open", provider: "meta", code: "131048" };

  const result = await dispatchBulkCampaignBatch(
    [whatsappItem(0), whatsappItem(1)],
    activityContext,
  );

  assert.equal(result.notAttemptedSends, 2);
  assert.deepEqual(capacityChecks, []);
  assert.equal(providerPosts, 0);
});

test("reads the dispatch receipt and its send intent with one Mongo read", async () => {
  await dispatchBulkCampaignBatch([whatsappItem(0)], activityContext);

  assert.equal(providerPosts, 1);
  assert.deepEqual(receiptReads, ["activity:0"]);
});

test("starts the conversation-capacity check before the SQL acceptance read returns", async () => {
  await dispatchBulkCampaignBatch([whatsappItem(0)], activityContext);

  assert.equal(acceptanceReads.length, 1);
  assert.deepEqual(capacityChecks, [{ acceptanceReadsSoFar: 0 }]);
});

test("writes the acceptance witness and the sent ledger row together", async () => {
  let markSentStarted!: () => void;
  const sentStarted = new Promise<void>((resolve) => {
    markSentStarted = resolve;
  });
  onSentPersist = () => markSentStarted();
  const order: string[] = [];
  onReceiptWrite = async () => {
    const overlapped = await Promise.race([
      sentStarted.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 200)),
    ]);
    order.push(overlapped ? "witness-overlapped" : "witness-alone");
  };

  const result = await dispatchBulkCampaignBatch(
    [whatsappItem(0)],
    activityContext,
  );

  assert.equal(result.successfulSends, 1);
  assert.deepEqual(order, ["witness-overlapped"]);
  assert.equal(sentPayloads.length, 1);
  assert.equal(
    dedupeRecords.get("activity:0")?.messageId,
    "provider-message-0",
  );
});

test("shares one conversation lookup cache per batch and does not wait for realtime", async () => {
  await dispatchBulkCampaignBatch(
    [whatsappItem(0), whatsappItem(1)],
    activityContext,
  );
  await dispatchBulkCampaignBatch([whatsappItem(2)], {
    ...activityContext,
    activityDedupePrefix: "next-batch",
  });

  const caches = conversationPayloads.map((payload) => payload.lookupCache);
  assert.equal(caches.length, 3);
  assert.ok(caches[0]);
  assert.equal(caches[0], caches[1]);
  assert.notEqual(caches[0], caches[2]);
  assert.deepEqual(
    conversationPayloads.map((payload) => payload.awaitRealtime),
    [false, false, false],
  );
});

test("an unavailable capacity check does not fail an already accepted retry", async () => {
  capacityError = new Error("capacity lookup unavailable");
  dedupeRecords.set("activity:0", {
    messageId: "provider-message-existing",
    recipient: "+7 701 000 00 01",
    channel: "whatsapp",
  });

  const result = await dispatchBulkCampaignBatch(
    [whatsappItem(5)],
    activityContext,
  );

  assert.equal(result.successfulSends, 1);
  assert.equal(providerPosts, 0);
});

test("an unavailable capacity check still fails a new send before the provider", async () => {
  capacityError = new Error("capacity lookup unavailable");

  const result = await dispatchBulkCampaignBatch(
    [whatsappItem(0)],
    activityContext,
  );

  assert.equal(result.failedSends, 1);
  assert.equal(providerPosts, 0);
  assert.match(String(result.results[0]?.error), /capacity lookup unavailable/);
  assert.deepEqual(
    attemptPayloads.map((payload) => payload.status),
    ["failed"],
  );
});
