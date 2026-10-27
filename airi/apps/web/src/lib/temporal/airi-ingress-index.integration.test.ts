import { randomUUID } from "node:crypto";
import mongoose from "mongoose";

jest.mock("@/lib/mongoose", () => ({ __esModule: true, default: jest.fn() }));
jest.mock("@/lib/conversions/confirmed-payment-runtime", () => ({}));
jest.mock("@/lib/airi/scenario/timer-recovery/recover", () => ({
  replanRemappedPostActionTimer: jest.fn(),
}));

import AiriTurnContext, {
  AIRI_TIMER_REPLAN_INGRESS_UNIQUE_INDEX,
} from "@/models/airi-turn-context";
import {
  enqueueTimerReplanIngress,
  processTimerReplanIngressKeys,
} from "@/lib/airi/scenario/timer-recovery/ingress";
import {
  persistAiriConversationIngressIntent,
  type AiriTurnContextDocument,
} from "./airi-turn-context";

const fixtureUri = process.env.MONGO_COST_TEST_URI;
const suite = fixtureUri ? describe : describe.skip;

suite("indexed Airi ingress persistence (real Mongo)", () => {
  const now = new Date("2026-10-11T06:00:00Z");
  const document = {
    turnContextId: "ingress-index-conversation",
    ingressKey: "airi-ingress:index-fixture",
    ingressKind: "conversation_turn",
    ingressStatus: "pending",
    ingressAttempts: 0,
    ingressNextRetryAt: now,
    workspaceId: "index-fixture-workspace",
    conversationId: "index-fixture-conversation",
    messageId: "index-fixture-message",
    messageDate: now,
    enqueuedAt: now,
    expiresAt: null,
  } as AiriTurnContextDocument;

  beforeAll(async () => {
    const uri = new URL(fixtureUri!);
    expect(uri.protocol).toBe("mongodb:");
    expect(["127.0.0.1", "localhost", "[::1]"]).toContain(uri.hostname);
    expect(uri.port).toBe("27277");
    expect(uri.username).toBe("");
    expect(uri.password).toBe("");
    expect(uri.pathname).toBe("/airi_mongo_index_cost_tests");
    expect(uri.searchParams.get("replicaSet")).toBe("airiCostTests");
    uri.pathname = `/airi_ingress_index_${randomUUID().replaceAll("-", "")}`;
    await mongoose.connect(uri.toString(), {
      autoIndex: false,
      autoCreate: false,
      serverSelectionTimeoutMS: 5_000,
    });
    await AiriTurnContext.collection.createIndex(
      AIRI_TIMER_REPLAN_INGRESS_UNIQUE_INDEX.keys,
      AIRI_TIMER_REPLAN_INGRESS_UNIQUE_INDEX.options
    );
  });

  afterAll(async () => {
    if (mongoose.connection.readyState !== 1) return;
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    await AiriTurnContext.collection.deleteMany({});
    await AiriTurnContext.collection.insertMany(
      Array.from({ length: 250 }, (_, index) => ({
        turnContextId: `ordinary:${index}`,
        workspaceId: "other-workspace",
        conversationId: `other-conversation:${index}`,
        messageId: `other-message:${index}`,
      }))
    );
  });
  afterEach(() => jest.restoreAllMocks());

  async function expectIndexed(filter: Record<string, unknown>) {
    const plan = await AiriTurnContext.collection
      .find(filter)
      .maxTimeMS(5_000)
      .explain("executionStats");
    expect(JSON.stringify(plan.queryPlanner.winningPlan)).toContain(
      '"indexName":"airi_timer_replan_ingress_unique"'
    );
    expect(plan.executionStats.totalDocsExamined).toBeLessThanOrEqual(1);
  }

  it("uses the partial index while concurrent conversation upserts preserve one pending intent", async () => {
    const write = jest.spyOn(AiriTurnContext, "findOneAndUpdate");
    const stored = await Promise.all(
      Array.from({ length: 4 }, () =>
        persistAiriConversationIngressIntent(document)
      )
    );
    expect(new Set(stored.map(row => String(row._id))).size).toBe(1);
    expect(stored[0]).toMatchObject(document);
    expect(
      await AiriTurnContext.countDocuments({ ingressKey: document.ingressKey })
    ).toBe(1);
    await expectIndexed(write.mock.calls[0][0]!);
  });

  it("adopts a legacy attempt without overwriting its original identity or enqueue time", async () => {
    const createdAt = new Date("2026-10-01T00:00:00Z");
    const legacy = { ...document };
    delete legacy.ingressKind;
    await AiriTurnContext.collection.insertOne({
      ...legacy,
      ingressStatus: "failed",
      createdAt,
    });
    const write = jest.spyOn(AiriTurnContext, "findOneAndUpdate");
    const stored = await persistAiriConversationIngressIntent(document);

    expect(stored).toMatchObject({
      ingressKey: document.ingressKey,
      ingressKind: "conversation_turn",
      ingressStatus: "pending",
      enqueuedAt: createdAt,
      expiresAt: null,
    });
    expect(write).toHaveBeenCalledTimes(2);
    await expectIndexed(write.mock.calls[1][0]!);
  });

  it("preserves timer identity and uses the partial index for targeted claim and terminal recovery", async () => {
    const params = {
      workspaceId: "index-fixture-workspace",
      conversationId: "index-fixture-conversation",
      expectedScenarioId: "index-fixture-scenario",
      expectedConditionNodeId: "index-fixture-condition",
      expectedSourceActionNodeId: "index-fixture-action",
      anchorId: "index-fixture-message",
      messageDate: now,
      enqueuedAt: now,
    };
    const write = jest.spyOn(AiriTurnContext, "findOneAndUpdate");
    const first = await enqueueTimerReplanIngress(params);
    const retry = await enqueueTimerReplanIngress({
      ...params,
      enqueuedAt: new Date(now.getTime() + 60_000),
    });
    expect(String(retry._id)).toBe(String(first._id));
    expect(retry.timerReplanIngress?.enqueuedAt).toEqual(now);
    await expectIndexed(write.mock.calls[0][0]!);
    await AiriTurnContext.updateOne(
      { _id: first._id },
      { $set: { ingressStatus: "signaled" } }
    );
    write.mockClear();
    const read = jest.spyOn(AiriTurnContext, "find");
    const result = await processTimerReplanIngressKeys({
      ingressKeys: [first.ingressKey, "timer-replan-ingress:missing"],
      now,
    });
    expect(result.results).toEqual([
      {
        ingressKey: first.ingressKey,
        conversationId: "index-fixture-conversation",
        status: "signaled",
      },
    ]);
    await expectIndexed(write.mock.calls[0][0]!);
    await expectIndexed(read.mock.calls[0][0]!);
  });
});
