import mongoose from "mongoose";

import type { RequestListItemPayload } from "./contract";
import {
  buildProjectedRealtimeEvent,
  buildProjectedRealtimeOutboxInsert,
  buildProjectionTombstone,
  commitProjectedBatch,
  RequestsProjectionLeaseLostError,
  selectAdvancingProjectionRows,
  type ProjectionCommitSession,
} from "./projector";

const conversationId = new mongoose.Types.ObjectId("65f000000000000000000001");
const generation = mongoose.mongo.Long.fromNumber(7);
const clusterTime = new mongoose.mongo.Timestamp({ t: 1_776_000_000, i: 7 });
const sourceWatermark = new mongoose.mongo.Timestamp({ t: 12, i: 3 });
const readStateWatermark = new mongoose.mongo.Timestamp({ t: 11, i: 9 });
const projectedAt = new Date("2026-08-19T04:00:00.000Z");
const lease = {
  ownerToken: "owner-1",
  fence: mongoose.mongo.Long.fromNumber(3),
  claimedAt: new Date("2026-08-19T03:59:00.000Z"),
  expiresAt: new Date("2026-08-19T04:01:00.000Z"),
};
const boundary = {
  resumeTokenDigest: "a".repeat(64),
  generation,
  sourceClusterTime: clusterTime,
};

function liveRow(): RequestListItemPayload {
  return {
    _id: conversationId,
    workspaceId: "workspace-1",
    schemaVersion: 1,
    projectedAt,
    sortAt: projectedAt,
    displayAt: projectedAt,
    status: "open",
    internalLabels: [],
    hasAiriReply: false,
    isBestPractice: false,
    slaDueAt: projectedAt,
    profileSearchText: "customer",
    createdAt: projectedAt,
    recentMessages: [],
    projection: {
      status: "ready",
      generation,
      fence: lease.fence,
      sourceWatermark,
      readStateWatermark,
    },
  } as unknown as RequestListItemPayload;
}

function tombstone() {
  return buildProjectionTombstone({
    conversationId,
    workspaceId: "workspace-1",
    generation,
    projectedAt,
    fence: lease.fence,
    sourceWatermark,
    readStateWatermark,
  });
}

describe("simple requests projector", () => {
  it.each([false, true])(
    "publishes only committed outbox identities after the transaction (abort=%s)",
    async abort => {
      const order: string[] = [];
      const publishCommittedEvents = jest.fn(() => {
        order.push("publish");
      });
      const row = liveRow();
      const enqueue = jest.fn(
        async (_input: { events: unknown[] }) => undefined
      );
      const result = commitProjectedBatch(
        { lease, rows: [row], boundary, progress: null, realtimeEnabled: true },
        {
          startSession: async () => ({
            withTransaction: async work => {
              const value = await work();
              if (abort) throw new Error("commit failed");
              order.push("commit");
              return value;
            },
            endSession: async () => {
              order.push("end");
            },
          }),
          assertBoundary: async () => "cluster_time_v1",
          replaceRows: async ({ rows }) => rows,
          enqueue,
          finalizeBoundary: async () => lease,
          publishCommittedEvents,
        }
      );
      if (abort) {
        await expect(result).rejects.toThrow("commit failed");
        expect(publishCommittedEvents).not.toHaveBeenCalled();
      } else {
        await result;
        expect(order).toEqual(["commit", "end", "publish"]);
        expect(publishCommittedEvents).toHaveBeenCalledWith(
          enqueue.mock.calls[0][0].events
        );
      }
    }
  );

  it("builds a compact tombstone with no legacy display payload", () => {
    const row = tombstone();

    expect(row.deletedAt).toEqual(projectedAt);
    expect(row.projection).toMatchObject({
      status: "ready",
      generation,
      sourceWatermark,
      readStateWatermark,
    });
    expect(row).not.toHaveProperty("recentMessages");
    expect(row).not.toHaveProperty("profileSearchText");
  });

  it("creates deterministic generic realtime identities for live and removed rows", () => {
    const first = buildProjectedRealtimeEvent(liveRow());
    const second = buildProjectedRealtimeEvent(liveRow());
    const removed = buildProjectedRealtimeEvent(tombstone());

    expect(first.eventId).toBe(second.eventId);
    expect(first.eventId).toMatch(/^requests-row:v3:[a-f0-9]{64}$/);
    expect(first.payload.changeType).toBe("updated");
    expect(removed.payload.changeType).toBe("removed");
  });

  it("builds a replayable outbox insert without relying on Mongoose defaults", () => {
    const event = buildProjectedRealtimeEvent(liveRow());
    const insert = buildProjectedRealtimeOutboxInsert(event);

    expect(insert).toMatchObject({
      eventId: event.eventId,
      status: "pending",
      attempts: 0,
      messageId: null,
      publishedAt: null,
      replayLeaseId: null,
      replayLeaseExpiresAt: null,
      nextAttemptAt: projectedAt,
    });
    expect(insert.event).not.toHaveProperty("channel");
    expect(insert.createdAt).toEqual(projectedAt);
    expect(insert.updatedAt).toEqual(projectedAt);
  });

  it("advances only missing or lower-generation rows", () => {
    const missing = liveRow();
    const lower = {
      ...liveRow(),
      _id: new mongoose.Types.ObjectId("65f000000000000000000002"),
    };
    const equal = {
      ...liveRow(),
      _id: new mongoose.Types.ObjectId("65f000000000000000000003"),
    };
    const greater = {
      ...liveRow(),
      _id: new mongoose.Types.ObjectId("65f000000000000000000004"),
    };

    expect(
      selectAdvancingProjectionRows(
        [missing, lower, equal, greater],
        [
          {
            _id: lower._id,
            projection: { generation: mongoose.mongo.Long.fromNumber(6) },
          },
          {
            _id: equal._id,
            projection: { generation },
          },
          {
            _id: greater._id,
            projection: { generation: mongoose.mongo.Long.fromNumber(8) },
          },
        ],
        "sequence_v2"
      ).map(row => row._id.toHexString())
    ).toEqual([missing._id.toHexString(), lower._id.toHexString()]);
  });

  it("commits both distinct legacy raw changes at one cluster time", async () => {
    type GenerationMode = "cluster_time_v1" | "sequence_v2";
    const secondReadStateWatermark = new mongoose.mongo.Timestamp({
      t: 11,
      i: 10,
    });
    const first = liveRow();
    const second = {
      ...liveRow(),
      projection: {
        ...liveRow().projection,
        readStateWatermark: secondReadStateWatermark,
      },
    };
    const state: { persisted: RequestListItemPayload | null } = {
      persisted: null,
    };
    const enqueue = jest.fn(async (_input: unknown) => undefined);
    const finalizeBoundary = jest.fn(async (_input: unknown) => lease);
    const dependencies = {
      startSession: async () => ({
        withTransaction: async <T>(work: () => Promise<T>): Promise<T> =>
          work(),
        endSession: async () => undefined,
      }),
      assertBoundary: async () => "cluster_time_v1" as const,
      replaceRows: async (input: {
        rows: RequestListItemPayload[];
        session: ProjectionCommitSession;
        generationMode: GenerationMode;
      }) => {
        const selected = selectAdvancingProjectionRows(
          input.rows,
          state.persisted
            ? [
                {
                  _id: state.persisted._id,
                  projection: {
                    generation: state.persisted.projection.generation,
                  },
                },
              ]
            : [],
          input.generationMode
        );
        if (selected[0]) state.persisted = selected[0];
        return selected;
      },
      enqueue,
      finalizeBoundary,
    } as unknown as Parameters<typeof commitProjectedBatch>[1];

    for (const [row, token, digest] of [
      [first, { _data: "raw-a" }, "a".repeat(64)],
      [second, { _data: "raw-b" }, "b".repeat(64)],
    ] as const) {
      await commitProjectedBatch(
        {
          lease,
          rows: [row],
          boundary: {
            resumeTokenDigest: digest,
            generation,
            sourceClusterTime: clusterTime,
          },
          progress: {
            kind: "change_stream_v1",
            resumeToken: token,
            clusterTime,
          },
          realtimeEnabled: true,
        },
        dependencies
      );
    }

    expect(state.persisted?.projection.readStateWatermark.toBigInt()).toBe(
      secondReadStateWatermark.toBigInt()
    );
    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(finalizeBoundary).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        progress: expect.objectContaining({
          resumeToken: { _data: "raw-b" },
        }),
        projectedCountIncrement: 1,
      })
    );
  });

  it("aborts the whole batch before writes when the checkpoint lease is stale", async () => {
    const replaceRows = jest.fn();
    const enqueue = jest.fn();
    const advance = jest.fn();
    const transaction = async <T>(work: () => Promise<T>): Promise<T> => work();

    await expect(
      commitProjectedBatch(
        {
          lease,
          rows: [liveRow()],
          boundary,
          progress: {
            kind: "change_stream_v1",
            resumeToken: { _data: "token" },
            clusterTime,
          },
          realtimeEnabled: true,
        },
        {
          startSession: async () => ({
            withTransaction: transaction,
            endSession: async () => undefined,
          }),
          replaceRows: async input => {
            await replaceRows(input);
            return input.rows;
          },
          enqueue,
          assertBoundary: async () => {
            throw new RequestsProjectionLeaseLostError();
          },
          finalizeBoundary: advance,
        }
      )
    ).rejects.toBeInstanceOf(RequestsProjectionLeaseLostError);

    expect(replaceRows).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    expect(advance).not.toHaveBeenCalled();
  });

  it("replays the transaction body on retry and ends the session after the commit", async () => {
    const order: string[] = [];
    let attempts = 0;
    const session: ProjectionCommitSession = {
      withTransaction: async <T>(work: () => Promise<T>): Promise<T> => {
        order.push("transaction:start");
        attempts += 1;
        await work();
        order.push("transaction:retry");
        const result = await work();
        order.push("transaction:commit");
        return result;
      },
      endSession: async () => void order.push("session:end"),
    };

    const result = await commitProjectedBatch(
      {
        lease,
        rows: [liveRow()],
        boundary,
        progress: {
          kind: "change_stream_v1",
          resumeToken: { _data: "token" },
          clusterTime,
        },
        realtimeEnabled: true,
      },
      {
        startSession: async () => session,
        replaceRows: async ({ rows }) => {
          order.push("rows");
          return rows;
        },
        enqueue: async () => void order.push("realtime"),
        assertBoundary: async () => {
          order.push("assert");
          return "sequence_v2";
        },
        finalizeBoundary: async () => {
          order.push("checkpoint");
          return lease;
        },
      }
    );

    expect(attempts).toBe(1);
    expect(result).toEqual({ lease });
    expect(order).toEqual([
      "transaction:start",
      "assert",
      "rows",
      "realtime",
      "checkpoint",
      "transaction:retry",
      "assert",
      "rows",
      "realtime",
      "checkpoint",
      "transaction:commit",
      "session:end",
    ]);
  });

  it("ends the session once when the transaction aborts", async () => {
    const failure = new Error("transaction aborted");
    const endSession = jest.fn(async () => undefined);

    await expect(
      commitProjectedBatch(
        {
          lease,
          rows: [liveRow()],
          boundary,
          progress: null,
          realtimeEnabled: true,
        },
        {
          startSession: async () => ({
            withTransaction: async () => {
              throw failure;
            },
            endSession,
          }),
          replaceRows: async ({ rows }) => rows,
          enqueue: async () => undefined,
          assertBoundary: async () => "sequence_v2",
          finalizeBoundary: async () => lease,
        }
      )
    ).rejects.toBe(failure);

    expect(endSession).toHaveBeenCalledTimes(1);
  });
});
