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

async function main() {
  const uri =
    "mongodb://127.0.0.1:27017/airi_analytics_qa_acquisition_20261002";
  process.env.MONGODB_URI = uri;
  await mongoose.connect(uri);
  const [
    { Conversation },
    { default: Message },
    { default: CustomerEvent },
    {
      AnalyticsAcquisitionEntry: Entry,
      AnalyticsConversionFact: Conversion,
      AnalyticsAcquisitionCheckpoint: Checkpoint,
      AnalyticsAcquisitionDaily: Daily,
    },
    { projectAcquisitionPage, ACQUISITION_STREAMS },
    { getAcquisitionReport },
    { ScenarioFlowEvent },
  ] = await Promise.all([
    import("../src/models/conversation"),
    import("../src/models/message"),
    import("../src/models/customer-event"),
    import("../src/models/analytics-acquisition"),
    import("../src/lib/analytics/acquisition-projector"),
    import("../src/lib/analytics/acquisition-report"),
    import("../src/models/scenario-flow-event"),
  ]);
  assert.equal(
    mongoose.connection.db!.databaseName,
    "airi_analytics_qa_acquisition_20261002"
  );
  await mongoose.connection.db!.dropDatabase();
  await Promise.all([
    Entry.init(),
    Conversion.init(),
    Checkpoint.init(),
    Daily.init(),
  ]);
  const workspaceId = "00000000-0000-4000-8000-000000000001",
    sourceId = "00000000-0000-4000-8000-000000000002";
  const conversationId = new mongoose.Types.ObjectId(),
    customerId = new mongoose.Types.ObjectId();
  const at = (day: number) =>
    new Date(`2026-09-${String(day).padStart(2, "0")}T00:00:00Z`);
  await Conversation.collection.insertOne({
    _id: conversationId,
    workspaceId,
    sourceId,
    channel: "whatsapp",
    customerId,
    createdAt: at(1),
    updatedAt: at(9),
    whatsappReferral: {
      sourceType: "ad",
      sourceId: "ad1",
      ctwaClid: "click1",
      capturedAt: at(1),
    },
  });
  await Message.collection.insertMany([
    {
      _id: new mongoose.Types.ObjectId(),
      workspaceId,
      conversation: conversationId,
      channel: "whatsapp",
      direction: "inbound",
      date: at(1),
      createdAt: at(1),
      updatedAt: at(1),
      whatsappReferral: {
        sourceType: "ad",
        sourceId: "ad1",
        ctwaClid: "click1",
      },
    },
    {
      _id: new mongoose.Types.ObjectId(),
      workspaceId,
      conversation: conversationId,
      channel: "whatsapp",
      direction: "inbound",
      date: at(2),
      createdAt: at(2),
      updatedAt: at(2),
      whatsappReferral: {
        sourceType: "ad",
        sourceId: "ad1",
        ctwaClid: "click1",
      },
    },
    {
      _id: new mongoose.Types.ObjectId(),
      workspaceId,
      conversation: conversationId,
      channel: "whatsapp",
      direction: "outbound",
      date: at(3),
      createdAt: at(3),
      updatedAt: at(3),
    },
    {
      _id: new mongoose.Types.ObjectId(),
      workspaceId,
      conversation: conversationId,
      channel: "whatsapp",
      direction: "inbound",
      date: at(5),
      createdAt: at(5),
      updatedAt: at(5),
      whatsappReferral: {
        sourceType: "ad",
        sourceId: "ad1",
        ctwaClid: "click2",
      },
    },
  ]);
  await CustomerEvent.collection.insertOne({
    workspaceId,
    conversationId,
    customerId,
    type: "stage_changed",
    occurredAt: at(3),
    payload: { stage: "qualified" },
  });
  const now = new Date();
  for (const stream of ["conversations", "messages"] as const)
    await projectAcquisitionPage({ workspaceId, stream, now });
  assert.equal(
    await Entry.countDocuments({ workspaceId }),
    2,
    "Repeated receipts for the same click cannot create extra entries"
  );
  assert.equal(
    await Daily.countDocuments({ workspaceId }),
    2,
    "Daily rollups retain each distinct entry day"
  );
  await Checkpoint.updateMany(
    { workspaceId },
    { $set: { cursorAt: null, cursorId: null } }
  );
  for (const stream of ["conversations", "messages"] as const)
    await projectAcquisitionPage({ workspaceId, stream, now: new Date() });
  assert.equal(
    await Entry.countDocuments({ workspaceId }),
    2,
    "Replay must be idempotent"
  );
  assert.equal(
    (await Daily.find({ workspaceId }).lean()).reduce(
      (sum, row) => sum + Number(row.entries),
      0
    ),
    2,
    "Replay must not increment daily counts"
  );
  const ledger = [
    {
      conversionId: "00000000-0000-4000-8000-000000000011",
      conversationId: String(conversationId),
      customerId: String(customerId),
      sourceId,
      conversionType: "sale",
      value: 100,
      currency: "USD",
      occurredAt: at(4),
      ledgerCreatedAt: at(4),
      transactionId: "p1",
    },
    {
      conversionId: "00000000-0000-4000-8000-000000000012",
      conversationId: String(conversationId),
      customerId: String(customerId),
      sourceId,
      conversionType: "sale",
      value: 200,
      currency: "USD",
      occurredAt: at(6),
      ledgerCreatedAt: at(6),
      transactionId: "p2",
    },
    {
      conversionId: "00000000-0000-4000-8000-000000000013",
      conversationId: String(conversationId),
      customerId: String(customerId),
      sourceId,
      conversionType: "refund",
      value: 30,
      currency: "USD",
      occurredAt: at(20),
      ledgerCreatedAt: at(20),
      transactionId: "r1",
      purchaseTransactionId: "p1",
    },
  ];
  const projected = new Set<string>();
  const supabase = {
    rpc: (name: string, params: Record<string, unknown>) =>
      fakeRpc(async () => {
        if (name === "ack_analytics_conversion_page") {
          const claims = params.p_claims as Array<{ conversionId: string }>;
          claims.forEach(row => projected.add(row.conversionId));
          return { data: claims.length, error: null };
        }
        if (name === "claim_analytics_conversion_page") {
          const rows = ledger
            .filter(row => !projected.has(row.conversionId))
            .map(row => ({
              ...row,
              claimToken: params.p_claim_token,
              claimFence: 1,
            }));
          return { data: { rows, outstanding: rows.length > 0 }, error: null };
        }
        return { data: ledger, error: null };
      }),
  };
  await projectAcquisitionPage({
    workspaceId,
    stream: "conversions",
    supabase: supabase as never,
    now: new Date(),
  });
  for (const stream of ACQUISITION_STREAMS)
    await projectAcquisitionPage({
      workspaceId,
      stream,
      supabase: supabase as never,
    });
  await ScenarioFlowEvent.collection.insertMany([
    {
      workspaceId,
      sourceId,
      conversationId: String(conversationId),
      outboundMessageId: "flowmsg1",
      flowId: "flow1",
      flowToken: "token1",
      eventType: "sent",
      eventAt: at(2),
    },
    {
      workspaceId,
      sourceId,
      conversationId: String(conversationId),
      outboundMessageId: "flowmsg1",
      flowId: "flow1",
      flowToken: "token1",
      eventType: "read",
      eventAt: at(3),
    },
    {
      workspaceId,
      sourceId,
      conversationId: String(conversationId),
      flowId: "flow1",
      flowToken: "token1",
      eventType: "submitted",
      eventAt: at(3),
    },
  ]);
  const report = await getAcquisitionReport({
    workspaceId,
    start: at(1),
    end: new Date("2026-10-01"),
    observationDays: 7,
    now: new Date(),
  });
  assert.equal(report.coverage.status, "ready");
  assert.equal(report.cohorts[0].entries, 2);
  assert.equal(
    report.cohorts[0].paid,
    2,
    "Each payment belongs to exactly one entry episode"
  );
  assert.equal(report.cohorts[0].qualified, 1);
  assert.equal(
    report.cohorts[0].currencies[0].netRevenue,
    270,
    "A linked later refund follows the original cohort"
  );
  assert.equal(
    report.retention[0].repeatCustomers,
    1,
    "Repeat purchases use stable customer identity and sale facts"
  );
  assert.equal(
    report.retention[0].netRevenue,
    270,
    "Later linked refunds also follow their retention purchase cohort"
  );
  assert.equal(report.flows[0].submitted, 1);
  const scoped = await getAcquisitionReport({
    workspaceId,
    start: at(1),
    end: new Date("2026-10-01"),
    observationDays: 7,
    sourceId: "00000000-0000-4000-8000-000000000099",
  });
  assert.equal(scoped.cohorts.length, 0, "Source filters apply to entry facts");
  await ScenarioFlowEvent.collection.insertMany([
    {
      workspaceId,
      sourceId,
      conversationId: String(conversationId),
      outboundMessageId: "flowmsg2",
      flowId: "flow2",
      flowToken: "token2",
      eventType: "sent",
      eventAt: at(2),
    },
    {
      workspaceId,
      sourceId,
      conversationId: String(conversationId),
      flowId: "flow2",
      flowToken: "token2",
      eventType: "submitted",
      eventAt: at(7),
    },
  ]);
  const flowReport = await getAcquisitionReport({
    workspaceId,
    start: at(1),
    end: new Date("2026-10-01"),
    observationDays: 7,
    now: new Date(),
  });
  assert.equal(
    flowReport.flows.find(row => row.flowId === "flow2")!.paid,
    0,
    "A payment before submission cannot be a Flow outcome"
  );
  assert.equal(
    flowReport.flows.find(row => row.flowId === "flow2")!.qualified,
    0,
    "Qualification before submission cannot be a Flow outcome"
  );
  const immature = await getAcquisitionReport({
    workspaceId,
    start: at(1),
    end: new Date("2026-10-01"),
    observationDays: 7,
    now: at(8),
  });
  assert.equal(
    immature.retention[0].pendingCustomers,
    1,
    "Young first-purchase cohorts are explicitly pending"
  );
  ledger.push({
    ...ledger[0],
    conversionId: "00000000-0000-4000-8000-000000000014",
    transactionId: "unknown-price",
    value: null as never,
    occurredAt: at(6),
    ledgerCreatedAt: at(21),
  });
  await projectAcquisitionPage({
    workspaceId,
    stream: "conversions",
    supabase: supabase as never,
    now: new Date(),
  });
  const unknown = await getAcquisitionReport({
    workspaceId,
    start: at(1),
    end: new Date("2026-10-01"),
    observationDays: 7,
    now: new Date(),
  });
  assert.equal(
    unknown.cohorts[0].currencies[0].netRevenue,
    null,
    "Unknown sale value must not become verified zero"
  );
  assert.equal(unknown.cohorts[0].currencies[0].unknownValues, 1);
  assert.equal(
    unknown.retention[0].netRevenue,
    null,
    "Retention preserves unknown monetary coverage"
  );
  await Conversion.updateOne(
    { workspaceId, transactionId: "unknown-price" },
    { $set: { value: Number.POSITIVE_INFINITY } }
  );
  const invalid = await getAcquisitionReport({
    workspaceId,
    start: at(1),
    end: new Date("2026-10-01"),
    observationDays: 7,
    now: new Date(),
  });
  assert.equal(
    invalid.cohorts[0].currencies[0].unknownValues,
    1,
    "Infinity is not verified monetary evidence"
  );
  assert.equal(invalid.cohorts[0].currencies[0].netRevenue, null);
  await Conversion.collection.updateOne(
    { workspaceId, transactionId: "unknown-price" },
    { $set: { value: Number.NaN } }
  );
  const nan = await getAcquisitionReport({
    workspaceId,
    start: at(1),
    end: new Date("2026-10-01"),
    observationDays: 7,
    now: new Date(),
  });
  assert.equal(
    nan.retention[0].unknownValues,
    1,
    "NaN is not a measured zero-value purchase"
  );
  assert.equal(nan.retention[0].netRevenue, null);
  const repeatConversation = String(new mongoose.Types.ObjectId());
  await ScenarioFlowEvent.collection.insertMany([
    {
      workspaceId,
      sourceId,
      conversationId: repeatConversation,
      outboundMessageId: "repeat1",
      flowId: "repeat-flow",
      flowToken: "reused-token",
      eventType: "sent",
      eventAt: at(1),
    },
    {
      workspaceId,
      sourceId,
      conversationId: repeatConversation,
      outboundMessageId: "repeat2",
      flowId: "repeat-flow",
      flowToken: "reused-token",
      eventType: "sent",
      eventAt: at(3),
    },
    {
      workspaceId,
      sourceId,
      conversationId: repeatConversation,
      outboundMessageId: "repeat2",
      flowId: "repeat-flow",
      flowToken: "reused-token",
      eventType: "submitted",
      eventAt: at(4),
    },
    {
      workspaceId,
      sourceId,
      conversationId: repeatConversation,
      outboundMessageId: "fallback1",
      flowId: "fallback-flow",
      flowToken: "fallback-token",
      eventType: "sent",
      eventAt: at(6),
    },
    {
      workspaceId,
      sourceId,
      conversationId: repeatConversation,
      outboundMessageId: "fallback2",
      flowId: "fallback-flow",
      flowToken: "fallback-token",
      eventType: "sent",
      eventAt: at(7),
    },
    {
      workspaceId,
      sourceId,
      conversationId: repeatConversation,
      flowId: "fallback-flow",
      flowToken: "fallback-token",
      eventType: "submitted",
      eventAt: at(8),
    },
  ]);
  await Conversion.collection.insertMany([
    {
      workspaceId,
      conversionId: "repeat-sale",
      conversationId: repeatConversation,
      sourceId,
      conversionType: "sale",
      value: 50,
      currency: "USD",
      occurredAt: at(5),
    },
    {
      workspaceId,
      conversionId: "fallback-sale",
      conversationId: repeatConversation,
      sourceId,
      conversionType: "sale",
      value: 50,
      currency: "USD",
      occurredAt: at(9),
    },
  ]);
  const repeated = await getAcquisitionReport({
    workspaceId,
    start: at(1),
    end: new Date("2026-10-01"),
    observationDays: 7,
    now: new Date(),
  });
  assert.equal(
    repeated.flows.find(row => row.flowId === "repeat-flow")!.submitted,
    1,
    "An exact message binding overrides a reused token"
  );
  assert.equal(
    repeated.flows.find(row => row.flowId === "repeat-flow")!.paid,
    1,
    "A reused token cannot double-credit its purchase"
  );
  assert.equal(
    repeated.flows.find(row => row.flowId === "fallback-flow")!.submitted,
    1,
    "Legacy token-only submissions bind once to the latest eligible send"
  );
  assert.equal(
    repeated.flows.find(row => row.flowId === "fallback-flow")!.paid,
    1
  );
  const preciseConversation = String(new mongoose.Types.ObjectId());
  const sent = new Date(at(10).getTime() + 123);
  await ScenarioFlowEvent.collection.insertMany([
    {
      workspaceId,
      sourceId,
      conversationId: preciseConversation,
      outboundMessageId: "precise-send",
      flowId: "precision-flow",
      flowToken: "precision-token",
      eventType: "sent",
      eventAt: sent,
    },
    {
      workspaceId,
      sourceId,
      conversationId: preciseConversation,
      outboundMessageId: "precise-send",
      flowId: "precision-flow",
      flowToken: "precision-token",
      eventType: "submitted",
      eventAt: at(10),
    },
  ]);
  await Conversion.collection.insertOne({
    workspaceId,
    conversionId: "precision-sale",
    conversationId: preciseConversation,
    sourceId,
    conversionType: "sale",
    value: 50,
    currency: "USD",
    occurredAt: new Date(sent.getTime() + 500),
  });
  await Checkpoint.updateOne(
    { workspaceId, stream: "messages_reconciliation" },
    {
      $set: {
        incomplete: false,
        sweepStartedAt: new Date(),
        cursorId: "pending-sweep",
      },
    }
  );
  await projectAcquisitionPage({
    workspaceId,
    stream: "conversions",
    supabase: supabase as never,
  });
  const precision = await getAcquisitionReport({
    workspaceId,
    start: at(1),
    end: new Date("2026-10-01"),
    observationDays: 7,
    now: new Date(),
  });
  assert.equal(
    precision.flows.find(row => row.flowId === "precision-flow")!.submitted,
    1,
    "Provider second precision cannot erase an exact message-bound completion"
  );
  assert.equal(
    precision.flows.find(row => row.flowId === "precision-flow")!.paid,
    1
  );
  assert.equal(
    precision.coverage.status,
    "ready",
    "An unfinished sweep between completed pages preserves previous live coverage"
  );
  await Checkpoint.updateOne(
    { workspaceId, stream: "messages_reconciliation" },
    { $set: { incomplete: true } }
  );
  const partialRepair = await getAcquisitionReport({
    workspaceId,
    start: at(1),
    end: new Date("2026-10-01"),
    observationDays: 7,
    now: new Date(),
  });
  assert.equal(
    partialRepair.coverage.status,
    "backfilling",
    "A partially applied reconciliation page withholds efficiency"
  );
  await Checkpoint.updateOne(
    { workspaceId, stream: "messages_reconciliation" },
    { $set: { incomplete: false } }
  );
  const originalExec = mongoose.Aggregate.prototype.exec;
  let advancedDuringReport = false;
  mongoose.Aggregate.prototype.exec = async function (...args) {
    if (this.model() === ScenarioFlowEvent && !advancedDuringReport) {
      advancedDuringReport = true;
      await Checkpoint.updateOne(
        { workspaceId, stream: "messages_reconciliation" },
        { $inc: { fence: 1 } }
      );
    }
    return originalExec.apply(this, args);
  };
  try {
    const concurrentRepair = await getAcquisitionReport({
      workspaceId,
      start: at(1),
      end: new Date("2026-10-01"),
      observationDays: 7,
      now: new Date(),
    });
    assert.equal(
      concurrentRepair.coverage.status,
      "backfilling",
      "A completed page during aggregation cannot certify a mixed report"
    );
  } finally {
    mongoose.Aggregate.prototype.exec = originalExec;
  }
  const qualificationConversation = new mongoose.Types.ObjectId();
  await Entry.collection.insertOne({
    workspaceId,
    conversationId: String(qualificationConversation),
    entryKey: "qualified-intersection",
    sourceId,
    kind: "organic",
    capturedAt: at(1),
    entryOrder: String(qualificationConversation),
    supersededBy: null,
  });
  await CustomerEvent.collection.insertOne({
    workspaceId,
    conversationId: qualificationConversation,
    type: "stage_changed",
    idempotencyKey: "qualified-intersection-event",
    occurredAt: at(6),
    payload: { stage: "qualified" },
  });
  await Conversion.collection.insertOne({
    workspaceId,
    conversationId: String(qualificationConversation),
    conversionId: "before-qualified",
    conversionType: "sale",
    occurredAt: at(5),
    value: 10,
    currency: "USD",
  });
  const beforeQualification = await getAcquisitionReport({
    workspaceId,
    start: at(1),
    end: new Date("2026-10-01"),
    observationDays: 7,
    now: new Date(),
  });
  const organicBefore = beforeQualification.cohorts.find(
    row => row.kind === "organic"
  )!;
  assert.equal(organicBefore.paid, 1);
  assert.equal(
    organicBefore.qualifiedPaid,
    0,
    "A purchase before qualification cannot improve qualified-to-paid conversion"
  );
  await Conversion.collection.insertOne({
    workspaceId,
    conversationId: String(qualificationConversation),
    conversionId: "after-qualified",
    conversionType: "sale",
    occurredAt: at(7),
    value: 10,
    currency: "USD",
  });
  const afterQualification = await getAcquisitionReport({
    workspaceId,
    start: at(1),
    end: new Date("2026-10-01"),
    observationDays: 7,
    now: new Date(),
  });
  assert.equal(
    afterQualification.cohorts.find(row => row.kind === "organic")!
      .qualifiedPaid,
    1,
    "Only a purchase after qualification belongs to the qualified-to-paid intersection"
  );
  console.log(
    JSON.stringify({
      status: "passed",
      checks: 34,
      entries: 2,
      netRevenue: 270,
      database: mongoose.connection.db!.databaseName,
    })
  );
  await mongoose.connection.db!.dropDatabase();
  await mongoose.disconnect();
}
main().catch(error => {
  console.error(error);
  process.exitCode = 1;
  void mongoose.disconnect();
});
