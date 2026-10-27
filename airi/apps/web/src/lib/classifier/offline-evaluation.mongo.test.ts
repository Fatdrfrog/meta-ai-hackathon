import mongoose from "mongoose";
import {
  Conversation,
  CONVERSATION_OFFLINE_EVAL_INDEX,
} from "@/models/conversation";
import {
  buildOfflineEvaluationPipeline,
  summarizeOfflineEvaluation,
  type OfflineEvaluationPair,
} from "./offline-evaluation";

// This suite owns only its explicitly named disposable loopback database.
const uri = process.env.OFFLINE_EVAL_QA_MONGODB_URI;
const local = uri ? new URL(uri) : null;
if (
  local &&
  (local.hostname !== "127.0.0.1" ||
    !local.pathname.startsWith("/airi_offline_eval_qa_"))
) {
  throw new Error(
    "Offline evaluation regression requires its named disposable local database"
  );
}
const suite = uri ? describe : describe.skip;
const since = new Date("2026-10-04T05:00:00.000Z");
const until = new Date("2026-10-11T05:00:00.000Z");
const conversation = (
  pred: string | null,
  gold: string | null,
  fields: Record<string, unknown> = {}
) => ({
  workspaceId: "workspace-1",
  createdAt: since,
  classification: { category: pred },
  shadow_classification: { category: gold },
  ...fields,
});

suite("offline evaluation against actual Mongo", () => {
  beforeAll(async () => {
    await mongoose.connect(uri!, {
      autoIndex: false,
      serverSelectionTimeoutMS: 3000,
    });
    await mongoose.connection.dropDatabase();
    await Conversation.collection.createIndex(
      CONVERSATION_OFFLINE_EVAL_INDEX.keys,
      CONVERSATION_OFFLINE_EVAL_INDEX.options
    );
  });
  beforeEach(async () => {
    await Conversation.collection.deleteMany({});
  });
  afterAll(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });

  const evaluate = () =>
    Conversation.aggregate<OfflineEvaluationPair>(
      buildOfflineEvaluationPipeline(since, until)
    )
      .option({
        hint: CONVERSATION_OFFLINE_EVAL_INDEX.options.name,
        allowDiskUse: false,
        maxTimeMS: 25_000,
      })
      .exec();

  it("preserves metrics and empty groups while excluding missing categories and dates outside the window", async () => {
    await Conversation.collection.insertMany([
      conversation("Sales", "Sales"),
      conversation("Sales", "Sales"),
      conversation("Sales", "Support"),
      conversation("Support", "Sales"),
      conversation("Other", ""),
      conversation(null, "", {
        workspaceId: null,
        classification_meta: { taxonomy_id: "" },
      }),
      conversation("", "", { workspaceId: "" }),
      conversation("Support", "Support", {
        classification_meta: { taxonomy_id: "custom" },
      }),
      conversation("Excluded", "Excluded", {
        createdAt: new Date(since.getTime() - 1),
      }),
      conversation("Excluded", "Excluded", { createdAt: until }),
      conversation("Excluded", "Excluded", {
        createdAt: new Date(until.getTime() + 1),
      }),
      conversation("Excluded", "Excluded", { shadow_classification: {} }),
      conversation("Excluded", "Excluded", { classification: {} }),
    ]);
    const results = summarizeOfflineEvaluation(await evaluate());
    expect(results).toHaveLength(3);
    const main = results.find(
      result => result.workspace_key === "workspace-1::default"
    )!;
    expect(main.labels).toEqual(
      expect.arrayContaining([
        {
          label: "Sales",
          tp: 2,
          fp: 1,
          fn: 1,
          precision: 2 / 3,
          recall: 2 / 3,
          f1: 2 / 3,
        },
        {
          label: "Support",
          tp: 0,
          fp: 1,
          fn: 1,
          precision: 0,
          recall: 0,
          f1: 0,
        },
        { label: "Other", tp: 0, fp: 0, fn: 0, precision: 0, recall: 0, f1: 0 },
      ])
    );
    expect(main.labels).toHaveLength(3);
    expect(main.macro.f1).toBeCloseTo(2 / 9);
    expect(results).toEqual(
      expect.arrayContaining([
        {
          workspace_key: "unknown::default",
          labels: [],
          macro: { precision: 0, recall: 0, f1: 0 },
        },
        {
          workspace_key: "workspace-1::custom",
          labels: [
            {
              label: "Support",
              tp: 1,
              fp: 0,
              fn: 0,
              precision: 1,
              recall: 1,
              f1: 1,
            },
          ],
          macro: { precision: 1, recall: 1, f1: 1 },
        },
      ])
    );
  });

  it("examines only the eligible date range through the canonical partial index", async () => {
    await Conversation.collection.insertMany([
      ...Array.from({ length: 500 }, () =>
        conversation("Sales", "Sales", { createdAt: new Date("2025-01-01") })
      ),
      ...Array.from({ length: 500 }, () =>
        conversation("Sales", "Sales", { shadow_classification: {} })
      ),
      conversation("Sales", "Sales"),
    ]);
    const indexes = await Conversation.collection.indexes();
    expect(indexes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "conversations_offline_eval_created_v1",
          key: { createdAt: 1 },
          partialFilterExpression: {
            "classification.category": { $exists: true },
            "shadow_classification.category": { $exists: true },
          },
        }),
      ])
    );
    const explain = await Conversation.aggregate(
      buildOfflineEvaluationPipeline(since, until)
    )
      .option({ maxTimeMS: 10_000 })
      .explain("executionStats");
    const serialized = JSON.stringify(explain);
    expect(serialized).toContain("conversations_offline_eval_created_v1");
    expect(serialized).not.toContain("COLLSCAN");
    const executionStats =
      explain.executionStats || explain.stages?.[0]?.$cursor?.executionStats;
    expect(executionStats.totalDocsExamined).toBe(1);
  });

  it("counts the entire input window even when conversation count exceeds the output budget", async () => {
    await Conversation.collection.insertMany(
      Array.from({ length: 10_005 }, () => conversation("Sales", "Sales"))
    );
    const pairs = await evaluate();
    expect(pairs).toEqual([
      {
        _id: {
          workspace_key: "workspace-1::default",
          pred: "Sales",
          gold: "Sales",
        },
        count: 10_005,
      },
    ]);
    expect(summarizeOfflineEvaluation(pairs)[0].labels[0].tp).toBe(10_005);
  });

  it("detects dimension overflow instead of treating capped output as a complete evaluation", async () => {
    await Conversation.collection.insertMany(
      Array.from({ length: 10_050 }, (_, i) =>
        conversation(`Label-${i}`, "Sales")
      )
    );
    const pairs = await evaluate();
    expect(pairs).toHaveLength(10_001);
    expect(() => summarizeOfflineEvaluation(pairs)).toThrow("dimension budget");
  });
});
