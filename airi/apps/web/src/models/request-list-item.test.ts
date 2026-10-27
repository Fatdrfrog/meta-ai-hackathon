import mongoose from "mongoose";

import {
  RequestListItem,
  REQUEST_LIST_ITEM_UNREAD_ORDERED_INDEX_KEYS,
  REQUEST_LIST_ITEM_UNREAD_ORDERED_INDEX_NAME,
  REQUEST_LIST_ITEM_UNREAD_ORDERED_PARTIAL_FILTER,
} from "./request-list-item";

const now = new Date("2026-08-15T00:00:00.000Z");
const sourceWatermark = new mongoose.mongo.Timestamp({ t: 12, i: 3 });
const readStateWatermark = new mongoose.mongo.Timestamp({ t: 11, i: 9 });

function readyDocument() {
  const generation = mongoose.mongo.Long.fromNumber(1);
  return {
    _id: new mongoose.Types.ObjectId(),
    workspaceId: "workspace-1",
    schemaVersion: 1 as const,
    projectedAt: now,
    deletedAt: null,
    sortAt: now,
    displayAt: now,
    channel: "whatsapp",
    status: "open",
    category: null,
    internalLabels: [],
    unreadGeneration: null,
    hasAiriReply: false,
    isBestPractice: false,
    customerSatisfactionScore: null,
    slaDueAt: now,
    hasChurnRisk: false,
    churnRank: null,
    profileSearchText: "customer",
    phoneDigits: null,
    createdAt: now,
    lastInboundAt: null,
    sourceId: null,
    businessConnectionId: null,
    rename: null,
    subject: null,
    participants: { from: [], to: [] },
    recentMessages: [],
    instagram: null,
    projection: {
      status: "ready" as const,
      generation,
      fence: generation,
      sourceWatermark,
      readStateWatermark,
    },
  };
}

function validationDetails(error: unknown): string {
  if (!(error instanceof mongoose.Error.ValidationError)) return String(error);
  return [
    String(error),
    ...Object.values(error.errors).flatMap(item => [
      String(item),
      String((item as { reason?: unknown }).reason || ""),
    ]),
  ].join(" ");
}

describe("RequestListItem", () => {
  it("declares optional unread ordering with the exact ready int64 predicate", () => {
    expect(REQUEST_LIST_ITEM_UNREAD_ORDERED_INDEX_KEYS).toEqual({
      workspaceId: 1,
      sortAt: -1,
      _id: -1,
    });
    expect(Object.entries(REQUEST_LIST_ITEM_UNREAD_ORDERED_INDEX_KEYS)).toEqual([
      ["workspaceId", 1],
      ["sortAt", -1],
      ["_id", -1],
    ]);
    expect(REQUEST_LIST_ITEM_UNREAD_ORDERED_INDEX_NAME).toBe(
      "requests_projection_unread_ordered_v1"
    );
    expect(REQUEST_LIST_ITEM_UNREAD_ORDERED_PARTIAL_FILTER).toEqual({
      deletedAt: null,
      "projection.status": "ready",
      unreadGeneration: { $type: "long" },
    });
    expect(RequestListItem.schema.indexes()).toEqual(
      expect.arrayContaining([
        [
          { workspaceId: 1, sortAt: -1, _id: -1 },
          expect.objectContaining({
            name: "requests_projection_unread_ordered_v1",
            partialFilterExpression: {
              deletedAt: null,
              "projection.status": "ready",
              unreadGeneration: { $type: "long" },
            },
          }),
        ],
      ])
    );
    expect(RequestListItem.schema.options.autoIndex).toBe(false);
  });

  it("accepts one bounded ready projection row with BSON Long state", () => {
    expect(new RequestListItem(readyDocument()).validateSync()).toBeUndefined();
  });

  it("normalizes bigint projection values to exact BSON Long values", () => {
    const document = new RequestListItem({
      ...readyDocument(),
      projection: {
        ...readyDocument().projection,
        generation: BigInt(9),
      },
    });

    expect(document.validateSync()).toBeUndefined();
    expect(document.projection.generation).toBeInstanceOf(mongoose.mongo.Long);
    expect(document.projection.generation.toString()).toBe("9");
  });

  it.each([7, "7"])("rejects non-int64 projection generation %p", invalid => {
    const document = new RequestListItem({
      ...readyDocument(),
      projection: {
        ...readyDocument().projection,
        generation: invalid,
      },
    });

    expect(
      document.validateSync()?.errors["projection.generation"]
    ).toBeDefined();
  });

  it.each([
    ["sourceWatermark", undefined],
    ["sourceWatermark", "0000000c00000003"],
    ["sourceWatermark", 12],
    ["sourceWatermark", mongoose.mongo.Long.fromNumber(12)],
    ["readStateWatermark", undefined],
    ["readStateWatermark", "0000000b00000009"],
    ["readStateWatermark", 11],
    ["readStateWatermark", mongoose.mongo.Long.fromNumber(11)],
  ])("rejects invalid native Timestamp field %s=%p", (field, invalid) => {
    const projection = {
      ...readyDocument().projection,
      [field]: invalid,
    };
    if (invalid === undefined)
      delete projection[field as keyof typeof projection];

    let error: unknown;
    try {
      error = new RequestListItem({
        ...readyDocument(),
        projection,
      }).validateSync();
    } catch (caught) {
      error = caught;
    }

    expect(validationDetails(error)).toMatch(
      new RegExp(`${field}.*BSON Timestamp`, "i")
    );
  });

  it("rejects more than two message previews", () => {
    const document = new RequestListItem({
      ...readyDocument(),
      recentMessages: [{ text: "1" }, { text: "2" }, { text: "3" }],
    });

    expect(document.validateSync()?.errors.recentMessages).toBeDefined();
  });

  it("keeps the serving document free of the superseded row-level control plane", () => {
    expect(RequestListItem.collection.collectionName).toBe(
      "request_list_items"
    );
    expect(RequestListItem.schema.path("projection.status")).toBeDefined();
    expect(
      RequestListItem.schema.path("projection.sourceWatermark")?.options
        .required
    ).toBeTruthy();
    expect(
      RequestListItem.schema.path("projection.readStateWatermark")?.options
        .required
    ).toBeTruthy();
    expect(
      RequestListItem.schema.path("projection.processingGeneration")
    ).toBeUndefined();
    expect(RequestListItem.schema.path("projection.lease")).toBeUndefined();
    expect(RequestListItem.schema.path("projection.error")).toBeUndefined();
    expect(
      RequestListItem.schema.path("projection.requestedGeneration")
    ).toBeUndefined();
    expect(
      RequestListItem.schema.path("projection.appliedGeneration")
    ).toBeUndefined();
    expect(RequestListItem.schema.path("projectionGeneration")).toBeUndefined();
    expect(RequestListItem.schema.path("conversationKey")).toBeUndefined();
    expect(RequestListItem.schema.path("dependencyUserKeys")).toBeUndefined();
    expect(RequestListItem.schema.path("dependencyChatKey")).toBeUndefined();
    expect(
      RequestListItem.schema.path("derivedOutputIncarnationId")
    ).toBeUndefined();
    expect(RequestListItem.schema.path("workspaceId")).toBeDefined();
  });
});
