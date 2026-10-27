import mongoose from "mongoose";
import { REQUEST_LIST_RECENT_MESSAGE_MAX_COUNT } from "./contract";
import {
  isRequestProjectionChangeRelevant,
  readRequestProjectionSource,
  buildRequestProjectionSourcePipeline,
} from "./source-reader";

const collectionNames = {
  conversationCollection: "conversations",
  messageCollection: "messages",
  chatCollection: "chats",
  userCollection: "users",
};

describe("readRequestProjectionSource", () => {
  const conversationId = new mongoose.Types.ObjectId();
  const sourceClusterTime = new mongoose.mongo.Timestamp({ t: 12, i: 3 });
  it.each([
    undefined,
    new mongoose.mongo.Timestamp({ t: 0, i: 0 }),
    "invalid",
    mongoose.mongo.Long.ONE,
  ])("rejects invalid causal boundary %s before reading", async invalid => {
    const session = {
      advanceOperationTime: jest.fn(),
    } as unknown as mongoose.ClientSession;
    const readSnapshot = jest.fn();
    await expect(
      readRequestProjectionSource(
        {
          conversationId,
          session,
          sourceClusterTime: invalid as mongoose.mongo.Timestamp,
        },
        { readSnapshot }
      )
    ).rejects.toThrow(/nonzero BSON Timestamp/i);
    expect(session.advanceOperationTime).not.toHaveBeenCalled();
    expect(readSnapshot).not.toHaveBeenCalled();
  });
  it("assembles the bounded source in one primary-majority read after advancing the session", async () => {
    const order: string[] = [];
    const session = {
      advanceOperationTime: jest.fn(() => {
        order.push("advance");
      }),
    } as unknown as mongoose.ClientSession;
    const source = {
      conversation: { _id: conversationId },
      messages: [],
      users: [],
      chat: null,
      airiWitness: null,
    };
    const readSnapshot = jest.fn(async () => {
      order.push("read");
      return source;
    });
    expect(
      await readRequestProjectionSource(
        { conversationId, session, sourceClusterTime },
        { readSnapshot }
      )
    ).toBe(source);
    expect(order).toEqual(["advance", "read"]);
    expect(readSnapshot).toHaveBeenCalledTimes(1);
    expect(readSnapshot).toHaveBeenCalledWith({
      conversationId,
      session,
      readPreference: "primary",
      readConcern: "majority",
    });
    expect(session.advanceOperationTime).toHaveBeenCalledWith(
      sourceClusterTime
    );
  });
  it("returns a missing conversation and propagates read failures without a partial source", async () => {
    const input = {
      conversationId,
      sourceClusterTime,
      session: {
        advanceOperationTime: jest.fn(),
      } as unknown as mongoose.ClientSession,
    };
    await expect(
      readRequestProjectionSource(input, { readSnapshot: async () => null })
    ).resolves.toBeNull();
    await expect(
      readRequestProjectionSource(input, {
        readSnapshot: async () => {
          throw new Error("source unavailable");
        },
      })
    ).rejects.toThrow("source unavailable");
  });
  it("bounds indexed message, witness, chat, and author lookups without loading the conversation transcript", () => {
    const pipeline = buildRequestProjectionSourcePipeline(conversationId);
    expect(pipeline[0]).toEqual({ $match: { _id: conversationId } });
    const lookups = pipeline.flatMap(stage =>
      "$lookup" in stage ? [stage.$lookup] : []
    );
    expect(lookups).toHaveLength(4);
    const messages = lookups.find(lookup => lookup.as === "messages")!;
    expect(messages).toMatchObject({
      localField: "conversation._id",
      foreignField: "conversation",
      pipeline: expect.arrayContaining([
        { $sort: { date: -1, _id: -1 } },
        { $limit: REQUEST_LIST_RECENT_MESSAGE_MAX_COUNT },
      ]),
    });
    expect(lookups.find(lookup => lookup.as === "airiWitness")).toMatchObject({
      localField: "conversation._id",
      foreignField: "conversation",
      pipeline: expect.arrayContaining([
        { $limit: 1 },
        { $project: { _id: 1 } },
      ]),
    });
    expect(lookups.find(lookup => lookup.as === "users")).toMatchObject({
      foreignField: "_id",
      pipeline: expect.arrayContaining([{ $limit: 3 }]),
    });
    expect(JSON.stringify(pipeline)).not.toContain("transcript");
  });
});

describe("Requests projection change relevance", () => {
  it.each([
    [
      "conversation runtime metadata",
      "conversations",
      {
        updatedFields: {
          "classification_state.status": "ready",
          updatedAt: new Date("2026-08-20T11:00:00.000Z"),
        },
        removedFields: [],
        truncatedArrays: [],
      },
    ],
    [
      "message delivery and analysis metadata",
      "messages",
      {
        updatedFields: {
          delivery: "read",
          "mediaAnalysis.status": "completed",
        },
        removedFields: [],
        truncatedArrays: [],
      },
    ],
    [
      "user integration metadata",
      "users",
      {
        updatedFields: { "whatsapp.verified": true, updatedAt: new Date() },
        removedFields: [],
        truncatedArrays: [],
      },
    ],
    [
      "chat bookkeeping metadata",
      "chats",
      {
        updatedFields: { updatedAt: new Date() },
        removedFields: [],
        truncatedArrays: [],
      },
    ],
  ])("skips %s", (_label, collection, updateDescription) => {
    expect(
      isRequestProjectionChangeRelevant({
        ...collectionNames,
        change: {
          operationType: "update",
          ns: { coll: collection },
          updateDescription,
        },
      })
    ).toBe(false);
  });

  it.each([
    ["conversation nested field", "conversations", "classification.topic"],
    ["message preview field", "messages", "text"],
    ["message routing field", "messages", "conversation"],
    ["user display field", "users", "firstName"],
    ["chat display field", "chats", "title"],
  ])("keeps an update to a %s", (_label, collection, field) => {
    expect(
      isRequestProjectionChangeRelevant({
        ...collectionNames,
        change: {
          operationType: "update",
          ns: { coll: collection },
          updateDescription: {
            updatedFields: { [field]: "changed" },
            removedFields: [],
            truncatedArrays: [],
          },
        },
      })
    ).toBe(true);
  });

  it("keeps removed and truncated fields consumed by the projection", () => {
    expect(
      isRequestProjectionChangeRelevant({
        ...collectionNames,
        change: {
          operationType: "update",
          ns: { coll: "conversations" },
          updateDescription: {
            updatedFields: {},
            removedFields: ["internal_labels.0"],
            truncatedArrays: [{ field: "participants.from", newSize: 0 }],
          },
        },
      })
    ).toBe(true);
  });

  it.each(["insert", "replace", "delete"])(
    "keeps every %s operation",
    operationType => {
      expect(
        isRequestProjectionChangeRelevant({
          ...collectionNames,
          change: {
            operationType,
            ns: { coll: "messages" },
          },
        })
      ).toBe(true);
    }
  );

  it("fails safe when an update has no usable change description", () => {
    expect(
      isRequestProjectionChangeRelevant({
        ...collectionNames,
        change: {
          operationType: "update",
          ns: { coll: "messages" },
        },
      })
    ).toBe(true);
  });
});
