import mongoose from "mongoose";
import {
  AnalyticsAcquisitionCheckpoint as Checkpoint,
  AnalyticsConversionFact,
} from "@/models/analytics-acquisition";
import { Conversation } from "@/models/conversation";
import Message from "@/models/message";
import * as projector from "./acquisition-projector";

const acquire = projector.acquireAnalyticsRuntimeLease;

describe("renewable acquisition runtime ownership", () => {
  const through = new Date("2026-10-01T00:00:00Z");
  let update: jest.SpyInstance;
  let claim: jest.SpyInstance;
  beforeEach(() => {
    jest.useFakeTimers({ now: new Date("2026-10-02T00:00:00Z") });
    update = jest.spyOn(Checkpoint, "updateOne").mockResolvedValue({
      matchedCount: 1,
      modifiedCount: 1,
    } as never);
    claim = jest.spyOn(Checkpoint, "findOneAndUpdate").mockReturnValue({
      lean: jest
        .fn()
        .mockResolvedValue({ fence: 7, cursorId: "cursor-1", through }),
    } as never);
    jest
      .spyOn(Checkpoint, "exists")
      .mockResolvedValue({ _id: "checkpoint" } as never);
  });
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  test("runtime streams share the checkpoint schema without changing report source authorities", () => {
    const streams = Checkpoint.schema.path("stream").options.enum;
    expect(streams).toEqual(
      expect.arrayContaining(["workspace_discovery", "provider_sync"])
    );
    expect(projector.ACQUISITION_STREAMS).toHaveLength(6);
    expect(projector.ACQUISITION_STREAMS).not.toContain("provider_sync");
  });

  test.each(["workspace_discovery", "provider_sync"] as const)(
    "%s keeps its durable cursor and releases only its fenced ownership",
    async stream => {
      const lease = await acquire({ workspaceId: "w", stream });
      expect(lease?.checkpoint).toEqual({ cursorId: "cursor-1", through });
      expect(claim).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceId: "w", stream }),
        expect.objectContaining({ $inc: { fence: 1 } }),
        expect.objectContaining({
          new: true,
          writeConcern: { w: "majority", j: true },
        })
      );
      await lease!.update({ cursorId: "cursor-2", through });
      await lease!.stop();
      await lease!.stop();
      expect(update).toHaveBeenLastCalledWith(
        expect.objectContaining({
          workspaceId: "w",
          stream,
          owner: expect.any(String),
          fence: 7,
        }),
        { $set: { owner: null, leaseUntil: null } },
        { writeConcern: { w: "majority", j: true } }
      );
      expect(jest.getTimerCount()).toBe(0);
    }
  );

  test("heartbeat renewals do not overlap and stop awaits renewal before releasing", async () => {
    let resolveRenewal!: (result: {
      matchedCount: number;
      modifiedCount: number;
    }) => void;
    const renewal = new Promise<{
      matchedCount: number;
      modifiedCount: number;
    }>(resolve => {
      resolveRenewal = resolve;
    });
    update.mockImplementation(async (_filter, changes) =>
      changes.$set?.leaseUntil instanceof Date
        ? renewal
        : { matchedCount: 1, modifiedCount: 1 }
    );
    const lease = await acquire({ workspaceId: "w", stream: "provider_sync" });
    await jest.advanceTimersByTimeAsync(90_000);
    const renewals = () =>
      update.mock.calls.filter(
        ([, changes]) => changes.$set?.leaseUntil instanceof Date
      );
    expect(renewals()).toHaveLength(1);
    let stopped = false;
    const stopping = lease!.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    resolveRenewal({ matchedCount: 1, modifiedCount: 0 });
    await stopping;
    expect(stopped).toBe(true);
    expect(renewals()[0][0]).toEqual(
      expect.objectContaining({
        owner: expect.any(String),
        fence: 7,
        leaseUntil: { $gt: expect.any(Date) },
      })
    );
    expect(jest.getTimerCount()).toBe(0);
  });

  test("lost renewal cannot write a newer cursor or overwrite another holder", async () => {
    update.mockImplementation(async (_filter, changes) => ({
      matchedCount: changes.$set?.leaseUntil instanceof Date ? 0 : 1,
      modifiedCount: 0,
    }));
    const lease = await acquire({
      workspaceId: "w",
      stream: "workspace_discovery",
    });
    await jest.advanceTimersByTimeAsync(30_000);
    await expect(lease!.assertOwned()).rejects.toThrow(
      "analytics_projection_lease_lost"
    );
    await expect(lease!.update({ cursorId: "unsafe" })).rejects.toThrow(
      "analytics_projection_lease_lost"
    );
    expect(
      update.mock.calls.some(
        ([, changes]) => changes.$set?.cursorId === "unsafe"
      )
    ).toBe(false);
    await lease!.stop();
    expect(update.mock.calls.at(-1)![0]).toEqual(
      expect.objectContaining({ owner: expect.any(String), fence: 7 })
    );
  });

  test("expired ownership fences updates even before the next heartbeat", async () => {
    const lease = await acquire({ workspaceId: "w", stream: "provider_sync" });
    jest.mocked(Checkpoint.exists).mockResolvedValue(null);
    await expect(lease!.update({ cursorId: "unsafe" })).rejects.toThrow(
      "analytics_projection_lease_lost"
    );
    await lease!.stop();
  });

  test("abort cancels renewal and prevents further data updates", async () => {
    const controller = new AbortController();
    const lease = await acquire({
      workspaceId: "w",
      stream: "provider_sync",
      signal: controller.signal,
    });
    controller.abort();
    await jest.advanceTimersByTimeAsync(150_000);
    await expect(lease!.assertOwned()).rejects.toMatchObject({
      name: "AbortError",
    });
    await expect(lease!.update({ cursorId: "unsafe" })).rejects.toMatchObject({
      name: "AbortError",
    });
    await lease!.stop();
    expect(
      update.mock.calls.filter(
        ([, changes]) => changes.$set?.leaseUntil instanceof Date
      )
    ).toHaveLength(0);
  });

  test("busy or already aborted acquisition leaves no heartbeat", async () => {
    claim.mockReturnValue({ lean: jest.fn().mockResolvedValue(null) });
    expect(
      await acquire({ workspaceId: "w", stream: "provider_sync" })
    ).toBeNull();
    const controller = new AbortController();
    controller.abort();
    expect(
      await acquire({
        workspaceId: "w",
        stream: "provider_sync",
        signal: controller.signal,
      })
    ).toBeNull();
    expect(claim).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  test("checkpoint callers cannot replace lease identity or fencing fields", async () => {
    const lease = await acquire({ workspaceId: "w", stream: "provider_sync" });
    await expect(
      lease!.update({ owner: "replacement", fence: 100 })
    ).rejects.toThrow("analytics_checkpoint_fields_invalid");
    await lease!.stop();
  });

  function pauseMessagePage() {
    let release!: (rows: Array<Record<string, unknown>>) => void;
    const rows = new Promise<Array<Record<string, unknown>>>(resolve => {
      release = resolve;
    });
    const query = {
      maxTimeMS: () => query,
      sort: () => query,
      limit: () => query,
      select: () => query,
      lean: () => rows,
    };
    jest.spyOn(Message, "find").mockReturnValue(query as never);
    jest.spyOn(Conversation, "find").mockReturnValue({
      select: () => ({ maxTimeMS: () => ({ lean: async () => [] }) }),
    } as never);
    return release;
  }

  test("acquisition pages renew ownership while one source read exceeds the original lease", async () => {
    const releaseRows = pauseMessagePage();
    const page = projector.projectAcquisitionPage({
      workspaceId: "w",
      stream: "messages",
    });
    await jest.advanceTimersByTimeAsync(150_000);
    expect(
      update.mock.calls.filter(
        ([, changes]) => changes.$set?.leaseUntil instanceof Date
      )
    ).toHaveLength(5);
    releaseRows([]);
    await expect(page).resolves.toEqual({ status: "caught_up", processed: 0 });
    expect(jest.getTimerCount()).toBe(0);
  });

  test("aborted pages release ownership without advancing coverage", async () => {
    const releaseRows = pauseMessagePage();
    const controller = new AbortController();
    const page = projector.projectAcquisitionPage({
      workspaceId: "w",
      stream: "messages",
      signal: controller.signal,
    });
    await jest.advanceTimersByTimeAsync(0);
    controller.abort();
    releaseRows([]);
    await expect(page).rejects.toMatchObject({ name: "AbortError" });
    expect(
      update.mock.calls.some(([, changes]) => "through" in (changes.$set || {}))
    ).toBe(false);
    expect(jest.getTimerCount()).toBe(0);
  });

  function pendingRpc() {
    let attachedSignal: AbortSignal | undefined;
    let resolve!: (result: { data: null; error: { message: string } }) => void;
    const result = new Promise<{ data: null; error: { message: string } }>(
      done => {
        resolve = done;
      }
    );
    const builder = {
      abortSignal(signal: AbortSignal) {
        attachedSignal = signal;
        const cancel = () =>
          resolve({ data: null, error: { message: "cancelled" } });
        if (signal.aborted) cancel();
        else signal.addEventListener("abort", cancel, { once: true });
        return builder;
      },
      then: result.then.bind(result),
    };
    return { builder, signal: () => attachedSignal };
  }

  test.each(["conversions", "conversions_reconciliation"] as const)(
    "pending %s RPC settles on worker cancellation without claiming coverage",
    async stream => {
      const pending = pendingRpc();
      const controller = new AbortController();
      const timeout = jest.spyOn(AbortSignal, "timeout");
      const rpc = jest.fn((_name: string) => pending.builder);
      const page = projector.projectAcquisitionPage({
        workspaceId: "w",
        stream,
        signal: controller.signal,
        supabase: { rpc } as never,
      });
      await jest.advanceTimersByTimeAsync(0);
      expect(pending.signal()).toBeInstanceOf(AbortSignal);
      expect(timeout).toHaveBeenCalledWith(25_000);
      controller.abort();
      await expect(page).rejects.toThrow("analytics_ledger_page_unavailable");
      expect(pending.signal()?.aborted).toBe(true);
      expect(rpc.mock.calls[0][0]).toBe(
        stream === "conversions"
          ? "claim_analytics_conversion_page"
          : "get_analytics_conversion_page"
      );
      expect(
        update.mock.calls.some(
          ([, changes]) => "through" in (changes.$set || {})
        )
      ).toBe(false);
      expect(jest.getTimerCount()).toBe(0);
    }
  );

  test("cancelled acknowledgment leaves durable conversion facts without advancing coverage", async () => {
    const pending = pendingRpc();
    const controller = new AbortController();
    const fact = jest
      .spyOn(AnalyticsConversionFact, "updateOne")
      .mockResolvedValue({ matchedCount: 1, modifiedCount: 1 } as never);
    const rpc = jest.fn(
      (name: string, parameters: { p_claim_token?: string }) => {
        if (name !== "claim_analytics_conversion_page") return pending.builder;
        const response = Promise.resolve({
          data: {
            rows: [
              {
                conversionId: "sale-1",
                conversationId: "conversation-1",
                conversionType: "refund",
                ledgerCreatedAt: through.toISOString(),
                occurredAt: through.toISOString(),
                claimToken: parameters.p_claim_token,
                claimFence: 2,
              },
            ],
            outstanding: true,
          },
          error: null,
        });
        return {
          abortSignal: () => response,
          then: response.then.bind(response),
        };
      }
    );
    const page = projector.projectAcquisitionPage({
      workspaceId: "w",
      stream: "conversions",
      signal: controller.signal,
      supabase: { rpc } as never,
    });
    await jest.advanceTimersByTimeAsync(0);
    expect(fact).toHaveBeenCalledTimes(1);
    expect(pending.signal()).toBeInstanceOf(AbortSignal);
    controller.abort();
    await expect(page).rejects.toThrow(
      "analytics_ledger_acknowledgment_failed"
    );
    expect(
      update.mock.calls.some(([, changes]) => "through" in (changes.$set || {}))
    ).toBe(false);
    expect(jest.getTimerCount()).toBe(0);
  });

  test("conversion RPCs also have a deadline without a parent cancellation signal", async () => {
    const pending = pendingRpc();
    const deadline = new AbortController();
    const timeout = jest
      .spyOn(AbortSignal, "timeout")
      .mockReturnValue(deadline.signal);
    const rpc = jest.fn(() => pending.builder);
    const page = projector.projectAcquisitionPage({
      workspaceId: "w",
      stream: "conversions",
      supabase: { rpc } as never,
    });
    await jest.advanceTimersByTimeAsync(0);
    expect(timeout).toHaveBeenCalledWith(25_000);
    expect(pending.signal()).toBe(deadline.signal);
    deadline.abort();
    await expect(page).rejects.toThrow("analytics_ledger_page_unavailable");
    expect(jest.getTimerCount()).toBe(0);
  });
});

describe("keyset cursors keep full source precision", () => {
  type Row = Record<string, unknown>;
  let checkpoint: Row;
  beforeEach(() => {
    checkpoint = { fence: 0, cursorAt: null, cursorId: null, through: null };
    jest.spyOn(Checkpoint, "findOneAndUpdate").mockImplementation(((
      _filter: unknown,
      update: { $set: Row }
    ) => {
      Object.assign(checkpoint, update.$set);
      checkpoint.fence = Number(checkpoint.fence) + 1;
      return { lean: async () => ({ ...checkpoint }) };
    }) as never);
    jest.spyOn(Checkpoint, "updateOne").mockImplementation((async (
      _filter: unknown,
      update: { $set?: Row }
    ) => {
      if (update.$set) Object.assign(checkpoint, update.$set);
      return { matchedCount: 1, modifiedCount: 1 };
    }) as never);
    jest
      .spyOn(Checkpoint, "exists")
      .mockResolvedValue({ _id: "checkpoint" } as never);
  });
  afterEach(() => jest.restoreAllMocks());

  test("more than one page of rows sharing one updatedAt advances to caught_up", async () => {
    // A bulk write gave 1,200 rows the same millisecond; one later row follows.
    const bulkAt = new Date("2026-06-08T12:49:14.228Z");
    const id = (index: number) =>
      new mongoose.Types.ObjectId(index.toString(16).padStart(24, "0"));
    const rows: Row[] = [
      ...Array.from({ length: 1_200 }, (_, index) => ({
        _id: id(index + 1),
        workspaceId: "w",
        updatedAt: bulkAt,
        direction: "outbound",
      })),
      {
        _id: id(5_000),
        workspaceId: "w",
        updatedAt: new Date("2026-06-08T12:49:15.001Z"),
        direction: "outbound",
      },
    ];
    const reads: Row[] = [];
    jest.spyOn(Message, "find").mockImplementation(((filter: Row) => {
      reads.push(filter);
      const through = (filter.updatedAt as { $lte: Date }).$lte;
      const [later, same] = (filter.$or as Row[] | undefined) ?? [];
      const after = (later?.updatedAt as { $gt: Date } | undefined)?.$gt;
      const afterId = (same?._id as { $gt: mongoose.Types.ObjectId })?.$gt;
      let limit = Infinity;
      const query = {
        sort: () => query,
        limit: (value: number) => ((limit = value), query),
        select: () => query,
        maxTimeMS: () => query,
        lean: async () =>
          rows
            .filter(row => {
              const at = (row.updatedAt as Date).getTime();
              if (at > through.getTime()) return false;
              if (!after) return true;
              return (
                at > after.getTime() ||
                (at === after.getTime() && String(row._id) > String(afterId))
              );
            })
            .slice(0, limit),
      };
      return query;
    }) as never);
    jest.spyOn(Conversation, "find").mockReturnValue({
      select: () => ({ maxTimeMS: () => ({ lean: async () => [] }) }),
    } as never);
    const now = new Date("2026-10-05T00:00:00Z");
    const statuses: string[] = [];
    for (let page = 0; page < 5; page++) {
      const result = await projector.projectAcquisitionPage({
        workspaceId: "w",
        stream: "messages",
        now,
      });
      statuses.push(`${result.status}:${result.processed}`);
      if (result.status === "caught_up") break;
    }
    expect(statuses).toEqual([
      "backfilling:500",
      "backfilling:500",
      "caught_up:201",
    ]);
    // The stored cursor keeps the milliseconds the second page needs.
    expect(reads[1].$or).toEqual([
      { updatedAt: { $gt: bulkAt, $lte: now } },
      { updatedAt: bulkAt, _id: { $gt: id(500) } },
    ]);
    expect(checkpoint).toMatchObject({
      cursorAt: new Date("2026-06-08T12:49:15.001Z"),
      cursorId: String(id(5_000)),
      through: now,
    });
  });

  test("ledger reconciliation resumes from the exact microsecond instant", async () => {
    // One Postgres transaction stamps every row with the same microsecond now().
    const createdAt = "2026-06-08T12:49:14.228123+00:00";
    // Epoch microseconds stay exact integers well below Number.MAX_SAFE_INTEGER.
    const micros = (value: string) => {
      const [, fraction = ""] = /\.(\d+)/.exec(value) ?? [];
      return (
        Date.parse(value.replace(/\.\d+/, "")) * 1000 +
        Number(fraction.padEnd(6, "0").slice(0, 6))
      );
    };
    const ledger = Array.from({ length: 30 }, (_, index) => ({
      conversionId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      conversationId: `conversation-${index}`,
      conversionType: "lead",
      ledgerCreatedAt: createdAt,
      occurredAt: createdAt,
    }));
    const calls: Row[] = [];
    const rpc = jest.fn((_name: string, parameters: Row) => {
      calls.push(parameters);
      const afterAt = parameters.p_after_at as string | null;
      const page = ledger
        .filter(
          row =>
            !afterAt ||
            micros(row.ledgerCreatedAt) > micros(afterAt) ||
            (micros(row.ledgerCreatedAt) === micros(afterAt) &&
              row.conversionId > String(parameters.p_after_id))
        )
        .slice(0, Number(parameters.p_limit));
      const response = Promise.resolve({ data: page, error: null });
      return { abortSignal: () => response };
    });
    jest
      .spyOn(AnalyticsConversionFact, "updateOne")
      .mockResolvedValue({ matchedCount: 1, modifiedCount: 1 } as never);
    const statuses: string[] = [];
    for (let page = 0; page < 4; page++) {
      const result = await projector.projectAcquisitionPage({
        workspaceId: "w",
        stream: "conversions_reconciliation",
        batchSize: 25,
        now: new Date("2026-10-05T00:00:00Z"),
        supabase: { rpc } as never,
      });
      statuses.push(`${result.status}:${result.processed}`);
      if (result.status === "caught_up") break;
    }
    expect(statuses).toEqual(["backfilling:25", "caught_up:5"]);
    expect(calls[1]).toMatchObject({
      p_after_at: createdAt,
      p_after_id: ledger[24].conversionId,
    });
    expect(checkpoint).toMatchObject({
      cursorAt: null,
      cursorAtExact: null,
      cursorId: null,
    });
  });
});
