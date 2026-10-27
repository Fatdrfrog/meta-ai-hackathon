import mongoose from "mongoose";
import {
  REQUEST_LIST_ROW_MAX_BYTES,
  assertRequestListItemPayload,
  encodeRequestDependencyKey,
  type RequestListItemPayload,
} from "./contract";

const objectId = new mongoose.Types.ObjectId();
const now = new Date("2026-08-15T00:00:00.000Z");
const one = mongoose.mongo.Long.fromNumber(1);
const two = mongoose.mongo.Long.fromNumber(2);
const sourceWatermark = new mongoose.mongo.Timestamp({ t: 12, i: 3 });
const readStateWatermark = new mongoose.mongo.Timestamp({ t: 11, i: 9 });

function readyRow(): RequestListItemPayload {
  return {
    _id: objectId,
    workspaceId: "workspace-1",
    schemaVersion: 1,
    projectedAt: now,
    deletedAt: null,
    sortAt: now,
    displayAt: now,
    channel: null,
    status: "open",
    category: null,
    internalLabels: [],
    unreadGeneration: null,
    hasAiriReply: false,
    isBestPractice: false,
    customerSatisfactionScore: null,
    slaDueAt: now,
    profileSearchText: "",
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
      status: "ready",
      generation: one,
      fence: one,
      sourceWatermark,
      readStateWatermark,
    },
  };
}

function serialize(value: unknown): string {
  return JSON.stringify(value, (_key, item) =>
    typeof item === "bigint" ? item.toString() : item
  );
}

describe("Requests projection contract", () => {
  it("accepts a minimal ready row and a bounded tombstone", () => {
    expect(assertRequestListItemPayload(readyRow())).toMatchObject({
      _id: objectId,
      projection: { status: "ready" },
    });

    expect(
      assertRequestListItemPayload({
        _id: objectId,
        workspaceId: "workspace-1",
        schemaVersion: 1,
        projectedAt: now,
        deletedAt: now,
        projection: {
          status: "ready",
          generation: two,
          fence: two,
          sourceWatermark,
          readStateWatermark,
        },
      })
    ).toMatchObject({
      deletedAt: now,
      projection: {
        status: "ready",
        sourceWatermark,
        readStateWatermark,
      },
    });
  });

  it.each([
    ["missing", undefined],
    ["string", "0000000c00000003"],
    ["number", 12],
    ["ordinary BSON Long", mongoose.mongo.Long.fromNumber(12)],
  ])("rejects a %s source watermark", (_label, invalid) => {
    const projection = { ...readyRow().projection } as Record<string, unknown>;
    if (invalid === undefined) delete projection.sourceWatermark;
    else projection.sourceWatermark = invalid;

    expect(() =>
      assertRequestListItemPayload({
        ...readyRow(),
        projection,
      } as never)
    ).toThrow(/sourceWatermark.*BSON Timestamp/i);
  });

  it.each([
    ["missing", undefined],
    ["string", "0000000b00000009"],
    ["number", 11],
    ["ordinary BSON Long", mongoose.mongo.Long.fromNumber(11)],
  ])("rejects a %s read-state watermark", (_label, invalid) => {
    const projection = { ...readyRow().projection } as Record<string, unknown>;
    if (invalid === undefined) delete projection.readStateWatermark;
    else projection.readStateWatermark = invalid;

    expect(() =>
      assertRequestListItemPayload({
        ...readyRow(),
        projection,
      } as never)
    ).toThrow(/readStateWatermark.*BSON Timestamp/i);
  });

  it("keeps tombstones closed to live display fields", () => {
    expect(() =>
      assertRequestListItemPayload({
        _id: objectId,
        workspaceId: "workspace-1",
        schemaVersion: 1,
        projectedAt: now,
        deletedAt: now,
        status: "open",
        projection: {
          status: "ready",
          generation: two,
          fence: two,
          sourceWatermark,
          readStateWatermark,
        },
      } as never)
    ).toThrow(/tombstone contains live fields: status/i);
  });

  it("rejects non-ready or extended projection state", () => {
    expect(() =>
      assertRequestListItemPayload({
        ...readyRow(),
        projection: {
          ...readyRow().projection,
          processingGeneration: one,
        } as never,
      } as never)
    ).toThrow(/unsupported fields/i);

    expect(() =>
      assertRequestListItemPayload({
        ...readyRow(),
        projection: {
          ...readyRow().projection,
          status: "processing",
        } as never,
      })
    ).toThrow(/must be ready/i);
  });

  it("accepts a serialized payload at the byte cap and rejects one byte over it", () => {
    const base = readyRow();
    const withoutSearchText = serialize({ ...base, profileSearchText: "" });
    const emptyBytes = Buffer.byteLength(withoutSearchText, "utf8");
    const multibyteText = "é";
    const multibyteBytes = Buffer.byteLength(multibyteText, "utf8");
    const remaining = REQUEST_LIST_ROW_MAX_BYTES - emptyBytes;
    const exactText =
      multibyteText.repeat(Math.floor(remaining / multibyteBytes)) +
      "a".repeat(remaining % multibyteBytes);
    const atCap = { ...base, profileSearchText: exactText };

    expect(Buffer.byteLength(serialize(atCap), "utf8")).toBe(
      REQUEST_LIST_ROW_MAX_BYTES
    );
    expect(assertRequestListItemPayload(atCap)).toBe(atCap);
    expect(() =>
      assertRequestListItemPayload({
        ...atCap,
        profileSearchText: `${exactText}a`,
      })
    ).toThrow(/16384 UTF-8 bytes/i);
  });

  it("encodes mixed dependency identities as distinct fixed-width keys", () => {
    const objectId = new mongoose.Types.ObjectId("65f000000000000000000001");
    const keys = [
      encodeRequestDependencyKey(objectId),
      encodeRequestDependencyKey(123),
      encodeRequestDependencyKey("123"),
    ];

    expect(keys.map(key => Buffer.byteLength(key, "utf8"))).toEqual([
      66, 66, 66,
    ]);
    expect(new Set(keys).size).toBe(3);
    expect(keys[0]).toMatch(/^o:[a-f0-9]{64}$/);
    expect(keys[1]).toMatch(/^n:[a-f0-9]{64}$/);
    expect(keys[2]).toMatch(/^s:[a-f0-9]{64}$/);
  });
});
