/* eslint-disable no-console -- isolated QA CLI emits its verification summary */
import assert from "node:assert/strict";
import mongoose from "mongoose";

function fakeRpc<T>(run: () => Promise<T>) {
  let signal: AbortSignal | undefined;
  const response = Promise.resolve().then(() => {
    signal?.throwIfAborted();
    return run();
  });
  return {
    then: response.then.bind(response),
    abortSignal(nextSignal: AbortSignal) {
      signal = nextSignal;
      return this;
    },
  };
}

// The entire fixture is confined to an explicitly named localhost QA database.
const databaseName = "airi_analytics_qa_acquisition_identity_20261002";
const uri = `mongodb://127.0.0.1:27017/${databaseName}`;
async function main() {
  process.env.MONGODB_URI = uri;
  await mongoose.connect(uri);
  let checks = 0;
  try {
    assert.equal(mongoose.connection.db!.databaseName, databaseName);
    await mongoose.connection.db!.dropDatabase();
    const [
      { Conversation },
      { default: Message },
      models,
      { projectAcquisitionPage, resetAcquisitionCheckpoints },
      { acquisitionEntry },
    ] = await Promise.all([
      import("../src/models/conversation"),
      import("../src/models/message"),
      import("../src/models/analytics-acquisition"),
      import("../src/lib/analytics/acquisition-projector"),
      import("../src/lib/analytics/acquisition-contract"),
    ]);
    const {
      AnalyticsAcquisitionEntry: Entry,
      AnalyticsAcquisitionCheckpoint: Checkpoint,
      AnalyticsAcquisitionDaily: Daily,
      AnalyticsConversionFact: Conversion,
    } = models;
    await Promise.all([
      Entry.init(),
      Checkpoint.init(),
      Daily.init(),
      Conversion.init(),
    ]);
    const workspaceId = "00000000-0000-4000-8000-000000000001",
      sourceId = "00000000-0000-4000-8000-000000000002";
    const conversationId = new mongoose.Types.ObjectId(
      "000000000000000000000001"
    );
    const firstMessage = new mongoose.Types.ObjectId(
        "000000000000000000000010"
      ),
      secondMessage = new mongoose.Types.ObjectId("000000000000000000000011");
    const at = (day: number) =>
      new Date(`2026-09-${String(day).padStart(2, "0")}T00:00:00Z`);
    await Conversation.collection.insertOne({
      _id: conversationId,
      workspaceId,
      sourceId,
      channel: "whatsapp",
      createdAt: at(1),
      updatedAt: at(1),
    });
    await Message.collection.insertOne({
      _id: firstMessage,
      workspaceId,
      conversation: conversationId,
      channel: "whatsapp",
      direction: "inbound",
      date: at(3),
      createdAt: at(3),
      updatedAt: at(3),
      whatsappReferral: { sourceType: "ad", sourceId: "ad1" },
    });
    const project = () =>
      projectAcquisitionPage({ workspaceId, stream: "messages" });
    await project();
    await Message.collection.insertOne({
      _id: secondMessage,
      workspaceId,
      conversation: conversationId,
      channel: "whatsapp",
      direction: "inbound",
      date: at(2),
      createdAt: at(2),
      updatedAt: at(4),
      whatsappReferral: {
        sourceType: "ad",
        sourceId: "ad1",
        ctwaClid: "click1",
      },
    });
    await project();
    await Message.collection.updateOne(
      { _id: firstMessage },
      { $set: { "whatsappReferral.ctwaClid": "click1", updatedAt: at(5) } }
    );
    await project();
    assert.equal(
      await Entry.countDocuments({ workspaceId, supersededBy: null }),
      1,
      "Enriching a fallback message with its known click must merge the existing episode"
    );
    checks++;
    const canonical = await Entry.findOne({
      workspaceId,
      supersededBy: null,
    }).lean<{
      capturedAt: Date;
      entryOrder: string;
      entryKey: string;
    } | null>();
    assert.equal(
      new Date(canonical!.capturedAt).toISOString(),
      at(2).toISOString(),
      "A merge preserves the earliest receipt"
    );
    checks++;
    assert.equal(
      canonical!.entryOrder,
      String(firstMessage),
      "Equal-time cohort ordering uses a stable observed message identity"
    );
    checks++;
    const {
      AnalyticsAcquisitionMessageLink: Link,
      AnalyticsCustomerPurchaseObservation: PurchaseObservation,
    } = models;
    await Promise.all([Link.init(), PurchaseObservation.init()]);
    assert.equal(
      await Link.countDocuments({ workspaceId, entryKey: canonical!.entryKey }),
      2,
      "One bounded durable mapping exists for each source message"
    );
    checks++;
    await Checkpoint.updateOne(
      { workspaceId, stream: "messages" },
      { $set: { cursorAt: null, cursorId: null } }
    );
    await project();
    assert.equal(
      await Entry.countDocuments({ workspaceId, supersededBy: null }),
      1,
      "Replaying both streams cannot resurrect superseded fallback entries"
    );
    checks++;
    await Message.collection.insertOne({
      _id: new mongoose.Types.ObjectId("000000000000000000000012"),
      workspaceId,
      conversation: conversationId,
      channel: "whatsapp",
      direction: "inbound",
      date: at(1),
      createdAt: at(1),
      updatedAt: at(6),
      whatsappReferral: {
        sourceType: "ad",
        sourceId: "ad1",
        ctwaClid: "click1",
      },
    });
    await project();
    assert.equal(
      (await Daily.find({ workspaceId }).lean()).reduce(
        (sum, row) => sum + Number(row.entries),
        0
      ),
      1,
      "Moving an entry to an earlier day clears the stale replacement rollup"
    );
    checks++;

    const failureMessage = new mongoose.Types.ObjectId(
      "000000000000000000000013"
    );
    await Message.collection.insertOne({
      _id: failureMessage,
      workspaceId,
      conversation: conversationId,
      channel: "whatsapp",
      direction: "inbound",
      date: at(7),
      createdAt: at(7),
      updatedAt: at(7),
      whatsappReferral: { sourceType: "ad", sourceId: "ad1" },
    });
    await project();
    const fallback = acquisitionEntry({
      workspaceId,
      conversationId: String(conversationId),
      sourceId,
      channel: "whatsapp",
      capturedAt: at(7),
      messageId: String(failureMessage),
      referral: { sourceType: "ad", sourceId: "ad1" },
    });
    await Message.collection.updateOne(
      { _id: failureMessage },
      { $set: { "whatsappReferral.ctwaClid": "click1", updatedAt: at(8) } }
    );
    const originalEntryWrite = Entry.updateOne;
    Object.defineProperty(Entry, "updateOne", {
      configurable: true,
      value: (...args: unknown[]) => {
        const [filter, update] = args as [
          Record<string, unknown>,
          { $set?: { supersededBy?: string } },
        ];
        if (filter.entryKey === fallback.entryKey && update.$set?.supersededBy)
          throw new Error("injected_merge_crash");
        return Reflect.apply(originalEntryWrite, Entry, args);
      },
    });
    try {
      await assert.rejects(project(), /injected_merge_crash/);
    } finally {
      Object.defineProperty(Entry, "updateOne", {
        configurable: true,
        value: originalEntryWrite,
      });
    }
    assert.equal(
      (await Checkpoint.findOne({ workspaceId, stream: "messages" }).lean<{
        incomplete: boolean;
      } | null>())!.incomplete,
      true,
      "A crash leaves explicit incomplete coverage until its page is repaired"
    );
    checks++;
    await project();
    assert.equal(
      await Entry.countDocuments({ workspaceId, supersededBy: null }),
      1,
      "Crash replay finishes the merge before acknowledgment"
    );
    checks++;
    assert.equal(
      (await Checkpoint.findOne({ workspaceId, stream: "messages" }).lean<{
        incomplete: boolean;
      } | null>())!.incomplete,
      false
    );
    checks++;

    const oldCheckpoint = await Checkpoint.findOne({
      workspaceId,
      stream: "messages",
    }).lean<{ through: Date } | null>();
    const originalCheckpointWrite = Checkpoint.updateOne;
    Object.defineProperty(Checkpoint, "updateOne", {
      configurable: true,
      value: async (...args: unknown[]) => {
        const [filter, update] = args as [
          Record<string, unknown>,
          { $set?: Record<string, unknown> },
        ];
        if (filter.owner && update.$set && "cursorAt" in update.$set)
          await Checkpoint.collection.updateOne(
            { workspaceId, stream: "messages" },
            { $set: { leaseUntil: new Date(0) } }
          );
        return Reflect.apply(originalCheckpointWrite, Checkpoint, args);
      },
    });
    try {
      await assert.rejects(project(), /analytics_projection_lease_lost/);
    } finally {
      Object.defineProperty(Checkpoint, "updateOne", {
        configurable: true,
        value: originalCheckpointWrite,
      });
    }
    assert.equal(
      (await Checkpoint.findOne({ workspaceId, stream: "messages" }).lean<{
        through: Date;
      } | null>())!.through!.getTime(),
      oldCheckpoint!.through!.getTime(),
      "An expired owner cannot acknowledge a page after its pre-write lease check"
    );
    checks++;

    const customerId = "customer-fixture";
    let ledger = [
      {
        conversionId: "00000000-0000-4000-8000-000000000021",
        conversationId: String(conversationId),
        customerId,
        sourceId,
        conversionType: "sale",
        value: 100,
        currency: "USD",
        occurredAt: at(5),
        ledgerCreatedAt: at(5),
        transactionId: "purchase1",
      },
    ];
    let ledgerNow = new Date();
    const projectLedger = () =>
      projectAcquisitionPage({
        workspaceId,
        stream: "conversions_reconciliation",
        supabase: {
          rpc: () => fakeRpc(async () => ({ data: ledger, error: null })),
        } as never,
        now: ledgerNow,
      });
    await projectLedger();
    ledgerNow = new Date(ledgerNow.getTime() + 360_000);
    await projectLedger();
    assert.equal(
      await PurchaseObservation.countDocuments({ workspaceId }),
      2,
      "Sale replay materializes one global and one exact-source first-purchase observation"
    );
    checks++;
    ledger = [
      {
        ...ledger[0],
        conversionId: "00000000-0000-4000-8000-000000000022",
        occurredAt: at(1),
        ledgerCreatedAt: at(9),
        transactionId: "purchase0",
      },
    ];
    ledgerNow = new Date(ledgerNow.getTime() + 360_000);
    await projectLedger();
    assert.equal(
      (await PurchaseObservation.findOne({
        workspaceId,
        scope: "workspace",
        customerId,
      }).lean<{ firstPurchase: Date } | null>())!.firstPurchase.getTime(),
      at(1).getTime(),
      "A late first purchase corrects the materialized cohort monotonically"
    );
    checks++;
    assert.equal(
      (await PurchaseObservation.findOne({
        workspaceId,
        scope: "source",
        sourceId,
        customerId,
      }).lean<{ firstPurchase: Date } | null>())!.firstPurchase.getTime(),
      at(1).getTime()
    );
    checks++;

    const lateMessage = new mongoose.Types.ObjectId("000000000000000000000014");
    const liveCursor = await Checkpoint.findOne({
      workspaceId,
      stream: "messages",
    }).lean<{ cursorId: string; cursorAt: Date } | null>();
    await Message.collection.insertOne({
      _id: lateMessage,
      workspaceId,
      conversation: conversationId,
      channel: "whatsapp",
      direction: "inbound",
      date: at(2),
      createdAt: at(2),
      updatedAt: at(1),
      whatsappReferral: {
        sourceType: "ad",
        sourceId: "ad2",
        ctwaClid: "late-import",
      },
    });
    await project();
    assert.equal(
      await Entry.countDocuments({
        workspaceId,
        adId: "ad2",
        supersededBy: null,
      }),
      0,
      "The regression source really lies behind the live update cursor"
    );
    checks++;
    let sweepNow = new Date();
    const sweep = () =>
      projectAcquisitionPage({
        workspaceId,
        stream: "messages_reconciliation",
        batchSize: 1,
        now: sweepNow,
      });
    await sweep();
    const behindSweep = new mongoose.Types.ObjectId("000000000000000000000009");
    await Message.collection.insertOne({
      _id: behindSweep,
      workspaceId,
      conversation: conversationId,
      channel: "whatsapp",
      direction: "inbound",
      date: at(2),
      createdAt: at(2),
      updatedAt: at(1),
      whatsappReferral: {
        sourceType: "ad",
        sourceId: "ad3",
        ctwaClid: "late-sweep-import",
      },
    });
    for (let pages = 0; pages < 20; pages++) {
      if ((await sweep()).status === "caught_up") break;
      assert.ok(pages < 19, "Sweep has a finite snapshot boundary");
    }
    assert.equal(
      await Entry.countDocuments({
        workspaceId,
        adId: "ad2",
        supersededBy: null,
      }),
      1,
      "Independent reconciliation recovers a backdated import"
    );
    checks++;
    assert.equal(
      await Entry.countDocuments({
        workspaceId,
        adId: "ad3",
        supersededBy: null,
      }),
      0,
      "An import behind an ongoing snapshot cursor needs the next cycle"
    );
    checks++;
    const reconciled = await Checkpoint.findOne({
      workspaceId,
      stream: "messages_reconciliation",
    }).lean<{ reconcileThrough: Date; sweepStartedAt: Date | null } | null>();
    assert.ok(reconciled!.reconcileThrough);
    assert.equal(reconciled!.sweepStartedAt, null);
    checks++;
    sweepNow = new Date(sweepNow.getTime() + 360_000);
    for (let pages = 0; pages < 20; pages++) {
      if ((await sweep()).status === "caught_up") break;
      assert.ok(pages < 19);
    }
    assert.equal(
      await Entry.countDocuments({
        workspaceId,
        adId: "ad3",
        supersededBy: null,
      }),
      1,
      "Periodic sweeps recover imports arriving behind a previous snapshot"
    );
    checks++;
    assert.equal(
      (await Checkpoint.findOne({ workspaceId, stream: "messages" }).lean<{
        cursorId: string;
      } | null>())!.cursorId,
      liveCursor!.cursorId,
      "Reconciliation never rewinds or blocks the live cursor"
    );
    checks++;

    const queueRow = {
      ...ledger[0],
      conversionId: "00000000-0000-4000-8000-000000000023",
      customerId: "queued-customer",
      transactionId: "queued-purchase",
    };
    let pending = true,
      failAck = true,
      claimed = false,
      ackCalls = 0;
    const pendingClient = {
      rpc: (name: string, args: Record<string, unknown>) =>
        fakeRpc(async () => {
          if (name === "claim_analytics_conversion_page")
            return {
              data: {
                rows: pending
                  ? [
                      {
                        ...queueRow,
                        claimToken: args.p_claim_token,
                        claimFence: 1,
                      },
                    ]
                  : [],
                outstanding: pending || claimed,
              },
              error: null,
            };
          assert.equal(name, "ack_analytics_conversion_page");
          ackCalls++;
          assert.ok(
            await Conversion.exists({
              workspaceId,
              conversionId: queueRow.conversionId,
            }),
            "Durable fact must precede SQL acknowledgment"
          );
          assert.equal(
            await PurchaseObservation.countDocuments({
              workspaceId,
              customerId: queueRow.customerId,
            }),
            2,
            "First-purchase materialization must precede acknowledgment"
          );
          if (failAck)
            return { data: null, error: { message: "injected_ack_failure" } };
          pending = false;
          return { data: 1, error: null };
        }),
    };
    const drain = () =>
      projectAcquisitionPage({
        workspaceId,
        stream: "conversions",
        supabase: pendingClient as never,
      });
    await assert.rejects(drain(), /analytics_ledger_acknowledgment_failed/);
    assert.equal(
      (await Checkpoint.findOne({ workspaceId, stream: "conversions" }).lean<{
        incomplete: boolean;
      } | null>())!.incomplete,
      true
    );
    checks++;
    failAck = false;
    assert.equal(
      (await drain()).status,
      "backfilling",
      "A claimed page cannot assert an empty queue"
    );
    checks++;
    assert.equal(ackCalls, 2);
    assert.equal(
      await Conversion.countDocuments({
        workspaceId,
        conversionId: queueRow.conversionId,
      }),
      1,
      "Ack recovery does not duplicate a fact"
    );
    checks++;
    assert.equal((await drain()).status, "caught_up");
    checks++;
    claimed = true;
    const queueThrough = await Checkpoint.findOne({
      workspaceId,
      stream: "conversions",
    }).lean<{ through: Date } | null>();
    assert.equal(
      (await drain()).status,
      "backfilling",
      "Other unexpired claims keep queue coverage incomplete even when no rows can be claimed"
    );
    checks++;
    assert.equal(
      (await Checkpoint.findOne({ workspaceId, stream: "conversions" }).lean<{
        through: Date;
      } | null>())!.through.getTime(),
      queueThrough!.through.getTime()
    );
    checks++;
    const unknownConversation = new mongoose.Types.ObjectId(
      "000000000000000000000002"
    );
    const unknownMessage = new mongoose.Types.ObjectId(
      "000000000000000000000020"
    );
    await Conversation.collection.insertOne({
      _id: unknownConversation,
      workspaceId,
      sourceId: null,
      channel: "whatsapp",
      createdAt: at(10),
      updatedAt: at(10),
    });
    await Message.collection.insertOne({
      _id: unknownMessage,
      workspaceId,
      conversation: unknownConversation,
      channel: "whatsapp",
      direction: "inbound",
      date: at(10),
      createdAt: at(10),
      updatedAt: at(10),
      whatsappReferral: { sourceType: "ad", ctwaClid: "missing-ad" },
    });
    await project();
    const unknownAd = await Entry.findOne({
      workspaceId,
      conversationId: String(unknownConversation),
      supersededBy: null,
    }).lean<{
      entryKey: string;
      kind: string;
      adId: string | null;
      sourceId: string | null;
    } | null>();
    assert.equal(
      unknownAd!.kind,
      "ad",
      "A known ad referral is never presented as organic merely because its ad ID is unavailable"
    );
    checks++;
    assert.equal(unknownAd!.adId, null);
    checks++;
    await Conversation.collection.updateOne(
      { _id: unknownConversation },
      { $set: { sourceId, updatedAt: at(11) } }
    );
    await Message.collection.updateOne(
      { _id: unknownMessage },
      { $set: { "whatsappReferral.sourceId": "known-ad", updatedAt: at(11) } }
    );
    await project();
    const enrichedAd = await Entry.findOne({
      workspaceId,
      conversationId: String(unknownConversation),
      supersededBy: null,
    }).lean<{
      entryKey: string;
      adId: string | null;
      sourceId: string | null;
    } | null>();
    assert.equal(
      enrichedAd!.entryKey,
      unknownAd!.entryKey,
      "Mutable source/ad metadata cannot create a second click episode"
    );
    checks++;
    assert.equal(enrichedAd!.adId, "known-ad");
    checks++;
    assert.equal(
      enrichedAd!.sourceId,
      null,
      "A later source assignment cannot prove the historical entry source"
    );
    checks++;
    assert.equal(
      await Entry.countDocuments({
        workspaceId,
        conversationId: String(unknownConversation),
        supersededBy: null,
      }),
      1
    );
    checks++;

    // A completed page within a longer sweep is safe; a partly applied page is not.
    const repairWorkspace = "00000000-0000-4000-8000-000000000034";
    const repairConversation = new mongoose.Types.ObjectId(
      "000000000000000000000101"
    );
    const repairMessage = new mongoose.Types.ObjectId(
      "000000000000000000000110"
    );
    const laterRepairMessage = new mongoose.Types.ObjectId(
      "000000000000000000000111"
    );
    await Conversation.collection.insertOne({
      _id: repairConversation,
      workspaceId: repairWorkspace,
      sourceId,
      channel: "whatsapp",
      createdAt: at(1),
      updatedAt: at(1),
    });
    const repairSource = {
      workspaceId: repairWorkspace,
      conversation: repairConversation,
      channel: "whatsapp",
      direction: "inbound",
      date: at(2),
      createdAt: at(2),
      updatedAt: at(2),
    };
    await Message.collection.insertOne({
      ...repairSource,
      _id: repairMessage,
      whatsappReferral: { sourceType: "ad", sourceId: "repair-ad" },
    });
    await projectAcquisitionPage({
      workspaceId: repairWorkspace,
      stream: "messages",
    });
    await projectAcquisitionPage({
      workspaceId: repairWorkspace,
      stream: "messages_reconciliation",
      batchSize: 2,
    });
    const repairKey = {
      workspaceId: repairWorkspace,
      stream: "messages_reconciliation",
    };
    type RepairCheckpoint = {
      incomplete: boolean;
      owner: string | null;
      cursorId: string | null;
      sweepStartedAt: Date | null;
      reconcileThrough: Date;
      through: Date;
    };
    const priorRepairCoverage = await Checkpoint.findOne(
      repairKey
    ).lean<RepairCheckpoint | null>();
    const idleRepairNow = new Date(
      priorRepairCoverage!.through.getTime() + 60_000
    );
    const beforeIdleRepair = await Checkpoint.findOne(repairKey).lean();
    assert.equal(
      (
        await projectAcquisitionPage({
          ...repairKey,
          stream: "messages_reconciliation",
          now: idleRepairNow,
        })
      ).status,
      "idle",
      "A completed sweep remains idle during its durable cooldown"
    );
    checks++;
    assert.deepEqual(
      await Checkpoint.findOne(repairKey).lean(),
      beforeIdleRepair,
      "An idle reconciliation page cannot churn its fence, lease, or incomplete flag"
    );
    checks++;
    await Checkpoint.updateOne(repairKey, {
      $set: {
        owner: "other-reconciliation-operator",
        leaseUntil: new Date(Date.now() + 120_000),
      },
    });
    assert.equal(
      (
        await projectAcquisitionPage({
          ...repairKey,
          stream: "messages_reconciliation",
          now: idleRepairNow,
        })
      ).status,
      "busy",
      "A held lease remains busy rather than appearing to be an idle sweep"
    );
    checks++;
    await Checkpoint.updateOne(repairKey, {
      $set: { owner: null, leaseUntil: null },
    });
    await Message.collection.insertOne({
      ...repairSource,
      _id: laterRepairMessage,
      whatsappReferral: {
        sourceType: "ad",
        sourceId: "repair-ad2",
        ctwaClid: "later-repair-click",
      },
    });
    await Message.collection.updateOne(
      { _id: repairMessage },
      { $set: { "whatsappReferral.ctwaClid": "repair-click" } }
    );
    const repairEntry = acquisitionEntry({
      workspaceId: repairWorkspace,
      conversationId: String(repairConversation),
      sourceId,
      channel: "whatsapp",
      capturedAt: at(2),
      messageId: String(repairMessage),
      referral: {
        sourceType: "ad",
        sourceId: "repair-ad",
        ctwaClid: "repair-click",
      },
    });
    let reachRepair!: () => void;
    let releaseRepair!: () => void;
    const repairReached = new Promise<void>(resolve => {
      reachRepair = resolve;
    });
    const repairReleased = new Promise<void>(resolve => {
      releaseRepair = resolve;
    });
    Object.defineProperty(Entry, "updateOne", {
      configurable: true,
      value: async (...args: unknown[]) => {
        const [filter, update] = args as [
          Record<string, unknown>,
          { $setOnInsert?: unknown },
        ];
        if (
          filter.workspaceId === repairWorkspace &&
          filter.entryKey === repairEntry.entryKey &&
          update.$setOnInsert
        ) {
          reachRepair();
          await repairReleased;
          throw new Error("injected_reconciliation_partial_write");
        }
        return Reflect.apply(originalEntryWrite, Entry, args);
      },
    });
    const reconcileRepair = () =>
      projectAcquisitionPage({
        workspaceId: repairWorkspace,
        stream: "messages_reconciliation",
        batchSize: 1,
        now: new Date(priorRepairCoverage!.through.getTime() + 360_000),
      });
    const activeRepair = reconcileRepair();
    try {
      await Promise.race([
        repairReached,
        activeRepair.then(() => {
          throw new Error("Reconciliation repair barrier was not reached");
        }),
      ]);
      assert.equal(
        await Entry.countDocuments({
          workspaceId: repairWorkspace,
          supersededBy: null,
        }),
        0,
        "The barrier exposes a real partly applied merge after tombstoning the fallback"
      );
      checks++;
      const activeCheckpoint = await Checkpoint.findOne(
        repairKey
      ).lean<RepairCheckpoint | null>();
      assert.equal(activeCheckpoint!.incomplete, true);
      assert.ok(activeCheckpoint!.owner);
      assert.ok(activeCheckpoint!.sweepStartedAt);
      assert.equal(
        activeCheckpoint!.reconcileThrough.getTime(),
        priorRepairCoverage!.reconcileThrough.getTime(),
        "An active partial page preserves the prior completed sweep boundary"
      );
      checks++;
      releaseRepair();
      await assert.rejects(
        activeRepair,
        /injected_reconciliation_partial_write/
      );
    } finally {
      releaseRepair();
      Object.defineProperty(Entry, "updateOne", {
        configurable: true,
        value: originalEntryWrite,
      });
    }
    const failedRepair = await Checkpoint.findOne(
      repairKey
    ).lean<RepairCheckpoint | null>();
    assert.equal(failedRepair!.incomplete, true);
    assert.equal(failedRepair!.owner, null);
    checks++;
    assert.equal((await reconcileRepair()).status, "backfilling");
    const completedRepairPage = await Checkpoint.findOne(
      repairKey
    ).lean<RepairCheckpoint | null>();
    assert.equal(completedRepairPage!.incomplete, false);
    assert.equal(completedRepairPage!.owner, null);
    assert.equal(completedRepairPage!.cursorId, String(repairMessage));
    assert.ok(completedRepairPage!.sweepStartedAt);
    assert.equal(
      completedRepairPage!.reconcileThrough.getTime(),
      priorRepairCoverage!.reconcileThrough.getTime(),
      "A completed page clears partial-write coverage while the longer sweep still has pending rows"
    );
    checks++;
    assert.equal(
      await Entry.countDocuments({
        workspaceId: repairWorkspace,
        supersededBy: null,
      }),
      1
    );
    assert.equal(
      (await Daily.find({ workspaceId: repairWorkspace }).lean()).reduce(
        (sum, row) => sum + Number(row.entries),
        0
      ),
      1,
      "Page completion follows both the canonical fact and replacement rollup"
    );
    checks++;
    const repairCompletedAt = new Date(
      priorRepairCoverage!.through.getTime() + 960_000
    );
    const finishRepairSweep = () =>
      projectAcquisitionPage({
        workspaceId: repairWorkspace,
        stream: "messages_reconciliation",
        batchSize: 1,
        now: repairCompletedAt,
      });
    assert.equal((await finishRepairSweep()).processed, 1);
    assert.equal((await finishRepairSweep()).status, "caught_up");
    const finishedRepairSweep = await Checkpoint.findOne(
      repairKey
    ).lean<RepairCheckpoint | null>();
    assert.equal(finishedRepairSweep!.sweepStartedAt, null);
    assert.equal(
      finishedRepairSweep!.through.getTime(),
      repairCompletedAt.getTime()
    );
    assert.equal(
      finishedRepairSweep!.reconcileThrough.getTime(),
      priorRepairCoverage!.through.getTime() + 360_000,
      "Long sweeps keep their covered start boundary separate from their completion time"
    );
    checks++;
    assert.equal(
      (
        await projectAcquisitionPage({
          ...repairKey,
          stream: "messages_reconciliation",
          now: new Date(repairCompletedAt.getTime() + 60_000),
        })
      ).status,
      "idle",
      "Even a sweep taking longer than the cooldown pauses after completion"
    );
    checks++;
    const beforeReset = await Checkpoint.find({ workspaceId })
      .select("stream cursorId through reconcileThrough")
      .sort({ stream: 1 })
      .lean<
        Array<{
          stream: string;
          cursorId: string | null;
          through: Date | null;
          reconcileThrough?: Date | null;
        }>
      >();
    await Checkpoint.updateOne(
      { workspaceId, stream: "conversions" },
      {
        $set: {
          owner: "other-operator",
          leaseUntil: new Date(Date.now() + 120_000),
        },
      }
    );
    await assert.rejects(
      () => resetAcquisitionCheckpoints(workspaceId),
      /analytics_replay_checkpoint_busy/
    );
    checks++;
    const afterRejectedReset = await Checkpoint.find({
      workspaceId,
      stream: { $in: beforeReset.map(row => row.stream) },
    })
      .select("stream cursorId through reconcileThrough")
      .sort({ stream: 1 })
      .lean();
    assert.deepEqual(
      afterRejectedReset,
      beforeReset,
      "A conflict while acquiring all stream leases cannot partially reset cursor data"
    );
    checks++;
    await Checkpoint.updateOne(
      { workspaceId, stream: "conversions" },
      { $set: { owner: null, leaseUntil: null } }
    );
    await resetAcquisitionCheckpoints(workspaceId);
    assert.equal(
      await Checkpoint.countDocuments({
        workspaceId,
        incomplete: true,
        cursorId: null,
        through: null,
        reconcileThrough: null,
        sweepStartedAt: null,
        sweepMaxId: null,
        owner: null,
        leaseUntil: null,
      }),
      6,
      "Replay clears all live and sweep coverage only under owned fences"
    );
    checks++;
    assert.equal(
      (
        await projectAcquisitionPage({
          workspaceId,
          stream: "messages_reconciliation",
          batchSize: 1,
        })
      ).processed,
      1,
      "Explicit replay clears the durable cooldown and projects immediately"
    );
    checks++;
    console.log(
      JSON.stringify({ status: "passed", checks, database: databaseName })
    );
  } finally {
    assert.equal(mongoose.connection.db!.databaseName, databaseName);
    await mongoose.connection.db!.dropDatabase();
    await mongoose.disconnect();
  }
}
main().catch(error => {
  console.error(error);
  process.exitCode = 1;
  void mongoose.disconnect();
});
