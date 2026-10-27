import mongoose from "mongoose";

import { RequestsProjectionCheckpoint } from "@/models/requests-projection-checkpoint";
import {
  assertReservedProjectionBoundary,
  claimRequestsProjectionCheckpointLease,
  deriveProjectionBackfillBoundaryDigest,
  deriveProjectionResumeTokenDigest,
  finalizeProjectionBoundary,
  MAX_ISSUABLE_GENERATION,
  normalizeRequestsProjectionCheckpoint,
  reserveProjectionBoundary,
  resetRequestsProjectionCheckpointForRebuild,
  requiresFreshRequestsProjectionBackfill,
  RequestsProjectionCheckpointLeaseLostError,
  updateRequestsProjectionCheckpoint,
} from "./checkpoint";

const now = new Date("2026-08-19T00:00:00.000Z");
const lease = {
  ownerToken: "worker-1",
  fence: mongoose.mongo.Long.ONE,
  claimedAt: now,
  expiresAt: new Date(now.getTime() + 60_000),
};

const sourceClusterTime = new mongoose.mongo.Timestamp({ t: 12, i: 3 });
const rawTokenA = { _data: "raw-a" };
const rawTokenB = { _data: "raw-b" };
const digestA = deriveProjectionResumeTokenDigest(rawTokenA);
const digestB = deriveProjectionResumeTokenDigest(rawTokenB);

function checkpointDocument(overrides: Record<string, unknown> = {}) {
  return {
    _id: "requests-read-model:v2",
    schemaVersion: 2,
    state: "ready",
    fence: lease.fence,
    lease,
    resumeToken: { _data: "prior" },
    clusterTime: sourceClusterTime,
    backfillAfterId: null,
    projectedCount: 0,
    activatedAt: now,
    error: { code: null, message: null, at: null },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/** The in-flight reservation at generation 101 for raw token A. */
function sequenceBoundary() {
  return {
    resumeTokenDigest: digestA,
    generation: mongoose.mongo.Long.fromNumber(101),
    sourceClusterTime,
  };
}

/** A sequence_v2 checkpoint holding `boundary` in flight. */
function reservedCheckpoint(
  boundary: ReturnType<typeof sequenceBoundary>,
  overrides: Record<string, unknown> = {}
) {
  return checkpointDocument({
    generationMode: "sequence_v2",
    lastProjectionGeneration: boundary.generation,
    inFlightBoundary: boundary,
    generationTransitionReceipt: { schemaVersion: 1 },
    ...overrides,
  });
}

function sequenceCheckpoint(lastProjectionGeneration: mongoose.mongo.Long) {
  return checkpointDocument({
    generationMode: "sequence_v2",
    lastProjectionGeneration,
    inFlightBoundary: null,
    generationTransitionReceipt: { schemaVersion: 1 },
  }) as Record<string, unknown>;
}

function mockStoredCheckpoint(document: unknown) {
  return jest
    .spyOn(RequestsProjectionCheckpoint.collection, "findOne")
    .mockResolvedValue(document as never);
}

function mockUpdateResult(result: Record<string, unknown>) {
  return jest
    .spyOn(RequestsProjectionCheckpoint.collection, "updateOne")
    .mockResolvedValue({ acknowledged: true, ...result } as never);
}

/** Serves `state` from findOne and applies each update's $set to it. */
function mockStatefulCheckpoint(state: Record<string, unknown>) {
  jest
    .spyOn(RequestsProjectionCheckpoint.collection, "findOne")
    .mockImplementation(async () => state as never);
  return jest
    .spyOn(RequestsProjectionCheckpoint.collection, "updateOne")
    .mockImplementation(async (_filter, update) => {
      Object.assign(
        state,
        (update as { $set?: Record<string, unknown> }).$set || {}
      );
      return { acknowledged: true, matchedCount: 1 } as never;
    });
}

function changeStreamProgress(resumeToken: Record<string, unknown>) {
  return {
    kind: "change_stream_v1" as const,
    resumeToken,
    clusterTime: sourceClusterTime,
  };
}

function transactionSession() {
  return {
    withTransaction: jest.fn(async (work: () => Promise<void>) => work()),
    endSession: jest.fn(async () => undefined),
  } as unknown as mongoose.ClientSession;
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe("requests projection checkpoint lease", () => {
  it("starts fresh only for absent, initializing, or failed checkpoints", () => {
    expect(requiresFreshRequestsProjectionBackfill(null)).toBe(true);
    expect(
      requiresFreshRequestsProjectionBackfill({ state: "initializing" })
    ).toBe(true);
    expect(requiresFreshRequestsProjectionBackfill({ state: "failed" })).toBe(
      true
    );
    expect(
      requiresFreshRequestsProjectionBackfill({ state: "backfilling" })
    ).toBe(false);
    expect(
      requiresFreshRequestsProjectionBackfill({ state: "catching_up" })
    ).toBe(false);
    expect(requiresFreshRequestsProjectionBackfill({ state: "ready" })).toBe(
      false
    );
  });

  it("claims the singleton with one atomic fence-and-lease pipeline", async () => {
    const updateOne = mockUpdateResult({ matchedCount: 1 });
    const findOneAndUpdate = jest
      .spyOn(RequestsProjectionCheckpoint.collection, "findOneAndUpdate")
      .mockResolvedValue({
        _id: "requests-read-model:v2",
        schemaVersion: 2,
        state: "initializing",
        fence: mongoose.mongo.Long.ONE,
        lease,
        projectedCount: 0,
        error: { code: null, message: null, at: null },
        createdAt: now,
        updatedAt: now,
      } as never);

    await expect(
      claimRequestsProjectionCheckpointLease({
        ownerToken: "worker-1",
        now,
        leaseMs: 60_000,
      })
    ).resolves.toEqual(lease);

    expect(updateOne).not.toHaveBeenCalled();

    const [, update] = findOneAndUpdate.mock.calls[0] || [];
    expect(Array.isArray(update)).toBe(true);
    expect(update).toEqual([
      {
        $set: expect.objectContaining({
          fence: expect.objectContaining({ $add: expect.any(Array) }),
          lease: expect.objectContaining({
            ownerToken: "worker-1",
            fence: expect.objectContaining({ $add: expect.any(Array) }),
          }),
        }),
      },
    ]);
  });

  it("can reset the absolute projected count under the live lease", async () => {
    const updateOne = mockUpdateResult({ matchedCount: 1 });

    await updateRequestsProjectionCheckpoint({
      lease,
      state: "initializing",
      projectedCount: 0,
      resumeToken: null,
      clusterTime: null,
      backfillAfterId: null,
      activatedAt: null,
      error: null,
      now,
    });

    expect(updateOne.mock.calls[0]?.[1]).toEqual({
      $set: expect.objectContaining({
        state: "initializing",
        projectedCount: 0,
        resumeToken: null,
        clusterTime: null,
        backfillAfterId: null,
        activatedAt: null,
      }),
    });
  });

  it("rejects checkpoint progress after the lease has been lost", async () => {
    mockUpdateResult({ matchedCount: 0 });

    await expect(
      updateRequestsProjectionCheckpoint({
        lease,
        state: "catching_up",
        now,
      })
    ).rejects.toBeInstanceOf(RequestsProjectionCheckpointLeaseLostError);
  });

  it("normalizes absent generation fields without mutating the legacy checkpoint", () => {
    const legacy = checkpointDocument();

    const normalized = normalizeRequestsProjectionCheckpoint(legacy as never);

    expect(normalized.generationMode).toBe("cluster_time_v1");
    expect(normalized.lastProjectionGeneration.toString()).toBe("0");
    expect(normalized.inFlightBoundary).toBeNull();
    expect(legacy).not.toHaveProperty("generationMode");
    expect(legacy).not.toHaveProperty("lastProjectionGeneration");
    expect(legacy).not.toHaveProperty("inFlightBoundary");
  });

  it.each([
    ["lower", 100],
    ["higher", 102],
  ])(
    "rejects an in-flight generation %s than the durable sequence counter",
    (_label, boundaryGeneration) => {
      expect(() =>
        normalizeRequestsProjectionCheckpoint(
          checkpointDocument({
            generationMode: "sequence_v2",
            lastProjectionGeneration: mongoose.mongo.Long.fromNumber(101),
            inFlightBoundary: {
              resumeTokenDigest: digestA,
              generation: mongoose.mongo.Long.fromNumber(boundaryGeneration),
              sourceClusterTime,
            },
            generationTransitionReceipt: { schemaVersion: 1 },
          }) as never
        )
      ).toThrow(/counter|generation|boundary|corrupt/i);
    }
  );

  it("derives one canonical raw-token digest independent of key order and BSON-type distinct", () => {
    const left = {
      b: mongoose.mongo.Long.fromString("7"),
      a: 1,
    };
    const reordered = {
      a: 1,
      b: mongoose.mongo.Long.fromString("7"),
    };

    expect(deriveProjectionResumeTokenDigest(left)).toBe(
      "3e498d7cbcb638630ee3df415c66f3e72310fe246a0f37124385f8bf8ab8d9e7"
    );
    expect(deriveProjectionResumeTokenDigest(reordered)).toBe(
      deriveProjectionResumeTokenDigest(left)
    );
    expect(deriveProjectionResumeTokenDigest({ a: 1, b: 7 })).not.toBe(
      deriveProjectionResumeTokenDigest(left)
    );
    expect(deriveProjectionResumeTokenDigest({ a: 2, b: left.b })).not.toBe(
      deriveProjectionResumeTokenDigest(left)
    );
  });

  it("domain-separates synthetic backfill page reservations", () => {
    const first = deriveProjectionBackfillBoundaryDigest({
      sourceClusterTime,
      backfillAfterId: null,
    });
    const next = deriveProjectionBackfillBoundaryDigest({
      sourceClusterTime,
      backfillAfterId: new mongoose.Types.ObjectId("65f000000000000000000001"),
    });

    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(next).toMatch(/^[a-f0-9]{64}$/);
    expect(first).not.toBe(next);
    expect(first).not.toBe(deriveProjectionResumeTokenDigest({ page: null }));
  });

  it("preserves exact legacy checkpoint writes without sequence-field mutations", async () => {
    const session = transactionSession();
    jest.spyOn(mongoose, "startSession").mockResolvedValue(session);
    mockStoredCheckpoint(checkpointDocument());
    const updateOne = mockUpdateResult({ matchedCount: 1 });
    const legacyGeneration = mongoose.mongo.Long.fromNumber(77);

    const boundary = await reserveProjectionBoundary({
      lease,
      resumeTokenDigest: digestA,
      sourceClusterTime,
      legacyGeneration,
      now,
    });
    await assertReservedProjectionBoundary({
      lease,
      boundary,
      session,
      now,
    });
    await finalizeProjectionBoundary({
      lease,
      boundary,
      progress: changeStreamProgress(rawTokenA),
      projectedCountIncrement: 1,
      session,
      now,
    });

    expect(boundary.generation.toString()).toBe("77");
    expect(updateOne).toHaveBeenCalledTimes(1);
    const serializedUpdate = JSON.stringify(updateOne.mock.calls[0]?.[1]);
    expect(serializedUpdate).not.toContain("generationMode");
    expect(serializedUpdate).not.toContain("lastProjectionGeneration");
    expect(serializedUpdate).not.toContain("inFlightBoundary");
  });

  it("advances an equal persisted touch time by exactly one millisecond", async () => {
    const session = transactionSession();
    const boundary = sequenceBoundary();
    mockStoredCheckpoint(reservedCheckpoint(boundary, { updatedAt: now }));
    const updateOne = jest
      .spyOn(RequestsProjectionCheckpoint.collection, "updateOne")
      .mockImplementation(async (_filter, update) => {
        const nextUpdatedAt = (update as { $set: { updatedAt: Date } }).$set
          .updatedAt;
        return {
          acknowledged: true,
          matchedCount: 1,
          modifiedCount: nextUpdatedAt.getTime() === now.getTime() ? 0 : 1,
        } as never;
      });

    await expect(
      assertReservedProjectionBoundary({
        lease,
        boundary,
        session,
        now,
      })
    ).resolves.toBe("sequence_v2");

    expect(updateOne).toHaveBeenCalledWith(
      expect.objectContaining({ updatedAt: now }),
      { $set: { updatedAt: new Date(now.getTime() + 1) } },
      { session }
    );
  });

  it("rejects a sequence touch that matched but did not modify", async () => {
    const session = transactionSession();
    const boundary = sequenceBoundary();
    mockStoredCheckpoint(reservedCheckpoint(boundary, { updatedAt: now }));
    mockUpdateResult({ matchedCount: 1, modifiedCount: 0 });

    await expect(
      assertReservedProjectionBoundary({
        lease,
        boundary,
        session,
        now,
      })
    ).rejects.toBeInstanceOf(RequestsProjectionCheckpointLeaseLostError);
  });

  it("write-CASes the prior touch time and rejects a stale concurrent match", async () => {
    const session = transactionSession();
    const priorUpdatedAt = new Date(now.getTime() - 1_000);
    const boundary = sequenceBoundary();
    mockStoredCheckpoint(
      reservedCheckpoint(boundary, { updatedAt: priorUpdatedAt })
    );
    const updateOne = mockUpdateResult({ matchedCount: 0, modifiedCount: 0 });

    await expect(
      assertReservedProjectionBoundary({
        lease,
        boundary,
        session,
        now,
      })
    ).rejects.toBeInstanceOf(RequestsProjectionCheckpointLeaseLostError);

    expect(updateOne).toHaveBeenCalledWith(
      expect.objectContaining({
        generationMode: "sequence_v2",
        lastProjectionGeneration: boundary.generation,
        updatedAt: priorUpdatedAt,
        "inFlightBoundary.resumeTokenDigest": boundary.resumeTokenDigest,
        "inFlightBoundary.generation": boundary.generation,
        "inFlightBoundary.sourceClusterTime": boundary.sourceClusterTime,
      }),
      { $set: { updatedAt: now } },
      { session }
    );
  });

  it.each([
    ["missing", undefined],
    ["invalid", new Date(Number.NaN)],
  ])(
    "rejects a %s persisted sequence touch time",
    async (_label, updatedAt) => {
      const session = transactionSession();
      const boundary = sequenceBoundary();
      mockStoredCheckpoint(reservedCheckpoint(boundary, { updatedAt }));
      const updateOne = mockUpdateResult({ matchedCount: 1, modifiedCount: 1 });

      await expect(
        assertReservedProjectionBoundary({
          lease,
          boundary,
          session,
          now,
        })
      ).rejects.toThrow(/updatedAt|valid Date/i);
      expect(updateOne).not.toHaveBeenCalled();
    }
  );

  it("fails closed when the next sequence touch time overflows Date", async () => {
    const session = transactionSession();
    const maximumDate = new Date(8_640_000_000_000_000);
    const boundary = sequenceBoundary();
    mockStoredCheckpoint(
      reservedCheckpoint(boundary, { updatedAt: maximumDate })
    );
    const updateOne = mockUpdateResult({ matchedCount: 1, modifiedCount: 1 });

    await expect(
      assertReservedProjectionBoundary({
        lease,
        boundary,
        session,
        now: maximumDate,
      })
    ).rejects.toThrow(/overflow|valid Date/i);
    expect(updateOne).not.toHaveBeenCalled();
  });

  it("allocates distinct generations, resumes one exact boundary, and rejects occupied corruption", async () => {
    const session = transactionSession();
    jest.spyOn(mongoose, "startSession").mockResolvedValue(session);
    const updateOne = mockStatefulCheckpoint(
      sequenceCheckpoint(mongoose.mongo.Long.fromNumber(100))
    );
    const reserve = (
      resumeTokenDigest: string,
      clusterTime = sourceClusterTime
    ) =>
      reserveProjectionBoundary({
        lease,
        resumeTokenDigest,
        sourceClusterTime: clusterTime,
        legacyGeneration: mongoose.mongo.Long.fromNumber(77),
        now,
      });

    const first = await reserve(digestA);
    const resumed = await reserve(digestA);

    expect(first.generation.toString()).toBe("101");
    expect(resumed).toEqual(first);
    expect(updateOne).toHaveBeenCalledTimes(1);
    await expect(
      reserve(digestA, new mongoose.mongo.Timestamp({ t: 12, i: 4 }))
    ).rejects.toThrow(/corrupt|source/i);
    await expect(reserve(digestB)).rejects.toThrow(/occupied|boundary/i);

    await finalizeProjectionBoundary({
      lease,
      boundary: first,
      progress: changeStreamProgress(rawTokenA),
      projectedCountIncrement: 0,
      session,
      now,
    });
    const second = await reserve(digestB);

    expect(second.generation.toString()).toBe("102");
  });

  it("burns the last issuable generation and rejects exhaustion without another write", async () => {
    const session = transactionSession();
    jest.spyOn(mongoose, "startSession").mockResolvedValue(session);
    const updateOne = mockStatefulCheckpoint(
      sequenceCheckpoint(
        mongoose.mongo.Long.fromBigInt(MAX_ISSUABLE_GENERATION - BigInt(1))
      )
    );

    const last = await reserveProjectionBoundary({
      lease,
      resumeTokenDigest: digestA,
      sourceClusterTime,
      legacyGeneration: mongoose.mongo.Long.ONE,
      now,
    });
    expect(last.generation.toBigInt()).toBe(MAX_ISSUABLE_GENERATION);
    await finalizeProjectionBoundary({
      lease,
      boundary: last,
      progress: changeStreamProgress(rawTokenA),
      projectedCountIncrement: 0,
      session,
      now,
    });
    const writesBeforeExhaustion = updateOne.mock.calls.length;

    await expect(
      reserveProjectionBoundary({
        lease,
        resumeTokenDigest: digestB,
        sourceClusterTime,
        legacyGeneration: mongoose.mongo.Long.ONE,
        now,
      })
    ).rejects.toThrow(/headroom|exhaust/i);
    expect(updateOne).toHaveBeenCalledTimes(writesBeforeExhaustion);
  });

  it("rejects a reused stored reservation inside signed Int64 headroom", () => {
    const corruptGeneration = mongoose.mongo.Long.fromBigInt(
      MAX_ISSUABLE_GENERATION + BigInt(1)
    );

    expect(() =>
      normalizeRequestsProjectionCheckpoint(
        checkpointDocument({
          generationMode: "sequence_v2",
          lastProjectionGeneration: corruptGeneration,
          inFlightBoundary: {
            resumeTokenDigest: digestA,
            generation: corruptGeneration,
            sourceClusterTime,
          },
          generationTransitionReceipt: { schemaVersion: 1 },
        }) as never
      )
    ).toThrow(/generation|headroom|corrupt/i);
  });

  it("refuses to finalize a reservation with a different raw change token", async () => {
    const session = transactionSession();
    const boundary = sequenceBoundary();
    mockStoredCheckpoint(reservedCheckpoint(boundary));
    const updateOne = mockUpdateResult({ matchedCount: 1 });

    await expect(
      finalizeProjectionBoundary({
        lease,
        boundary,
        progress: changeStreamProgress(rawTokenB),
        projectedCountIncrement: 0,
        session,
        now,
      })
    ).rejects.toThrow(/digest|token|boundary/i);
    expect(updateOne).not.toHaveBeenCalled();
  });

  it("abandons only the exact sequence reservation while preserving counter, raw checkpoint, and receipts", async () => {
    const session = transactionSession();
    const boundary = sequenceBoundary();
    mockStoredCheckpoint(
      reservedCheckpoint(boundary, {
        state: "failed",
        watermarkMigrationCompletedAt: now,
        watermarkMigrationReceipt: { schemaVersion: 1 },
      })
    );
    const updateOne = mockUpdateResult({ matchedCount: 1 });

    await resetRequestsProjectionCheckpointForRebuild({
      lease,
      expectedBoundary: boundary,
      session,
      now,
    });

    const [filter, update] = updateOne.mock.calls[0] || [];
    expect(filter).toEqual(
      expect.objectContaining({
        "inFlightBoundary.resumeTokenDigest": digestA,
        "inFlightBoundary.generation": boundary.generation,
        "inFlightBoundary.sourceClusterTime": sourceClusterTime,
      })
    );
    expect(update).toEqual({
      $set: expect.objectContaining({
        state: "initializing",
        inFlightBoundary: null,
        backfillAfterId: null,
        projectedCount: 0,
      }),
    });
    const serializedUpdate = JSON.stringify(update);
    expect(serializedUpdate).not.toContain("resumeToken");
    expect(serializedUpdate).not.toContain("clusterTime");
    expect(serializedUpdate).not.toContain("lastProjectionGeneration");
    expect(serializedUpdate).not.toContain("Receipt");
  });
});
