import mongoose from "mongoose";

import {
  REQUESTS_PROJECTION_CHECKPOINT_ID,
  RequestsProjectionCheckpoint,
} from "./requests-projection-checkpoint";

const now = new Date("2026-08-19T00:00:00.000Z");

describe("RequestsProjectionCheckpoint", () => {
  it("accepts the singleton string id and BSON Long fence", () => {
    const document = new RequestsProjectionCheckpoint({
      _id: REQUESTS_PROJECTION_CHECKPOINT_ID,
      schemaVersion: 2,
      state: "initializing",
      fence: mongoose.mongo.Long.ZERO,
      lease: null,
      resumeToken: null,
      clusterTime: null,
      backfillAfterId: null,
      projectedCount: 0,
      activatedAt: null,
      error: { code: null, message: null, at: null },
      createdAt: now,
      updatedAt: now,
    });

    expect(document.validateSync()).toBeUndefined();
    expect(document._id).toBe(REQUESTS_PROJECTION_CHECKPOINT_ID);
  });

  it("normalizes bigint checkpoint fences to exact BSON Long values", () => {
    const document = new RequestsProjectionCheckpoint({
      _id: REQUESTS_PROJECTION_CHECKPOINT_ID,
      schemaVersion: 2,
      state: "initializing",
      fence: BigInt(4),
      lease: null,
      projectedCount: 0,
      error: { code: null, message: null, at: null },
      createdAt: now,
      updatedAt: now,
    });

    expect(document.validateSync()).toBeUndefined();
    expect(document.fence).toBeInstanceOf(mongoose.mongo.Long);
    expect(document.fence.toString()).toBe("4");
  });

  it.each([1, "1"])("rejects the non-int64 fence %p", fence => {
    const document = new RequestsProjectionCheckpoint({
      _id: REQUESTS_PROJECTION_CHECKPOINT_ID,
      schemaVersion: 2,
      state: "initializing",
      fence,
      lease: null,
      projectedCount: 0,
      error: { code: null, message: null, at: null },
      createdAt: now,
      updatedAt: now,
    });

    expect(document.validateSync()?.errors.fence).toBeDefined();
  });

  it("accepts the additive dual-mode generation and operator receipt storage", () => {
    const document = new RequestsProjectionCheckpoint({
      _id: REQUESTS_PROJECTION_CHECKPOINT_ID,
      schemaVersion: 2,
      state: "ready",
      fence: mongoose.mongo.Long.ONE,
      lease: null,
      resumeToken: { _data: "raw-token" },
      clusterTime: new mongoose.mongo.Timestamp({ t: 12, i: 3 }),
      backfillAfterId: null,
      projectedCount: 1,
      activatedAt: now,
      generationMode: "sequence_v2",
      lastProjectionGeneration: mongoose.mongo.Long.fromNumber(101),
      inFlightBoundary: {
        resumeTokenDigest:
          "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        generation: mongoose.mongo.Long.fromNumber(102),
        sourceClusterTime: new mongoose.mongo.Timestamp({ t: 12, i: 4 }),
      },
      watermarkMigrationCompletedAt: now,
      watermarkMigrationProgress: { afterId: "65f000000000000000000001" },
      watermarkMigrationReceipt: { receiptVersion: 1 },
      provisionReceipt: { receiptVersion: 1 },
      generationTransitionReceipt: { receiptVersion: 1 },
      error: { code: null, message: null, at: null },
      createdAt: now,
      updatedAt: now,
    });

    expect(document.validateSync()).toBeUndefined();
    expect(document.inFlightBoundary?.generation.toString()).toBe("102");
  });

  it.each([
    ["invalid mode", { generationMode: "future_v3" }],
    ["non-Long counter", { lastProjectionGeneration: 101 }],
    [
      "non-Long reservation generation",
      {
        inFlightBoundary: {
          resumeTokenDigest:
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
          generation: 102,
          sourceClusterTime: new mongoose.mongo.Timestamp({ t: 12, i: 4 }),
        },
      },
    ],
    [
      "non-Timestamp reservation source",
      {
        inFlightBoundary: {
          resumeTokenDigest:
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
          generation: mongoose.mongo.Long.fromNumber(102),
          sourceClusterTime: { t: 12, i: 4 },
        },
      },
    ],
    [
      "malformed reservation digest",
      {
        inFlightBoundary: {
          resumeTokenDigest: "not-a-digest",
          generation: mongoose.mongo.Long.fromNumber(102),
          sourceClusterTime: new mongoose.mongo.Timestamp({ t: 12, i: 4 }),
        },
      },
    ],
  ])("rejects %s", (_label, invalid) => {
    const document = new RequestsProjectionCheckpoint({
      _id: REQUESTS_PROJECTION_CHECKPOINT_ID,
      schemaVersion: 2,
      state: "ready",
      fence: mongoose.mongo.Long.ONE,
      lease: null,
      projectedCount: 0,
      error: { code: null, message: null, at: null },
      createdAt: now,
      updatedAt: now,
      ...invalid,
    });

    expect(document.validateSync()).toBeDefined();
  });

  it("rejects unknown reservation members", () => {
    let document: InstanceType<typeof RequestsProjectionCheckpoint> | null =
      null;
    let constructionError: unknown = null;
    try {
      document = new RequestsProjectionCheckpoint({
        _id: REQUESTS_PROJECTION_CHECKPOINT_ID,
        schemaVersion: 2,
        state: "ready",
        fence: mongoose.mongo.Long.ONE,
        lease: null,
        projectedCount: 0,
        inFlightBoundary: {
          resumeTokenDigest:
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
          generation: mongoose.mongo.Long.fromNumber(102),
          sourceClusterTime: new mongoose.mongo.Timestamp({ t: 12, i: 4 }),
          unexpected: true,
        },
        error: { code: null, message: null, at: null },
        createdAt: now,
        updatedAt: now,
      });
    } catch (error) {
      constructionError = error;
    }

    expect(
      constructionError || document?.validateSync()?.errors.inFlightBoundary
    ).toBeDefined();
  });
});
