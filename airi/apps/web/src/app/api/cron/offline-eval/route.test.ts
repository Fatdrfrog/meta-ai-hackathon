const mockAdminFrom = jest.fn();
const mockInsert = jest.fn();
const mockSnapshotAbortSignal = jest.fn();
const mockCreateSessionClient = jest.fn();
const mockConversationFind = jest.fn();
const mockConversationAggregate = jest.fn();
const mockAggregateOption = jest.fn();
const mockAggregateExec = jest.fn();

jest.mock("@/lib/cron-auth", () => ({
  verifyCronAuth: () => null,
}));

jest.mock("@/lib/mongoose", () => ({
  __esModule: true,
  default: async () => undefined,
}));

jest.mock("@/models/conversation", () => ({
  Conversation: {
    find: (...args: unknown[]) => mockConversationFind(...args),
    aggregate: (...args: unknown[]) => mockConversationAggregate(...args),
  },
  CONVERSATION_OFFLINE_EVAL_INDEX: {
    keys: { createdAt: 1 },
    options: {
      name: "conversations_offline_eval_created_v1",
      partialFilterExpression: {
        "classification.category": { $exists: true },
        "shadow_classification.category": { $exists: true },
      },
    },
  },
}));

jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: {
    from: (...args: unknown[]) => mockAdminFrom(...args),
  },
}));

// Cron requests carry no user session; the session client is anon there and
// anon cannot pass the workspace membership policy on the snapshot table.
jest.mock("@/lib/supabase/server", () => ({
  createClient: (...args: unknown[]) => mockCreateSessionClient(...args),
}));

import { GET } from "./route";

describe("GET /api/cron/offline-eval", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAdminFrom.mockReturnValue({ insert: mockInsert });
    mockInsert.mockReturnValue({ abortSignal: mockSnapshotAbortSignal });
    mockSnapshotAbortSignal.mockResolvedValue({ data: null, error: null });
    mockConversationAggregate.mockReturnValue({ option: mockAggregateOption });
    mockAggregateOption.mockReturnValue({ exec: mockAggregateExec });
    mockAggregateExec.mockResolvedValue([
      {
        _id: {
          workspace_key: "workspace-1::default",
          pred: "Sales",
          gold: "Sales",
        },
        count: 1,
      },
    ]);
  });

  it("stores evaluation snapshots with the server client", async () => {
    const response = await GET(
      new Request("https://www.airi.chat/api/cron/offline-eval")
    );

    expect(response.status).toBe(200);
    expect(mockAdminFrom).toHaveBeenCalledWith("classification_eval_snapshots");
    expect(mockInsert).toHaveBeenCalledWith([
      expect.objectContaining({ workspace_key: "workspace-1::default" }),
    ]);
    expect(mockCreateSessionClient).not.toHaveBeenCalled();
  });

  it("evaluates the complete window with an indexed, time-limited aggregate", async () => {
    const response = await GET(
      new Request("https://www.airi.chat/api/cron/offline-eval")
    );

    expect(response.status).toBe(200);
    expect(mockConversationAggregate).toHaveBeenCalledTimes(1);
    expect(mockConversationFind).not.toHaveBeenCalled();
    expect(mockAggregateOption).toHaveBeenCalledWith(
      expect.objectContaining({
        hint: "conversations_offline_eval_created_v1",
        allowDiskUse: false,
        maxTimeMS: expect.any(Number),
        signal: expect.any(AbortSignal),
      })
    );
    const { maxTimeMS } = mockAggregateOption.mock.calls[0][0];
    expect(maxTimeMS).toBeGreaterThan(0);
    expect(maxTimeMS).toBeLessThanOrEqual(25_000);
  });

  it("does not publish snapshots when the database exceeds its query budget", async () => {
    mockAggregateExec.mockRejectedValue(
      new Error("operation exceeded time limit")
    );

    const response = await GET(
      new Request("https://www.airi.chat/api/cron/offline-eval")
    );

    expect(response.status).toBe(500);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("preserves complete pair counts, taxonomy groups and labels from one-sided empty pairs", async () => {
    mockAggregateExec.mockResolvedValue([
      {
        _id: {
          workspace_key: "workspace-1::default",
          pred: "Sales",
          gold: "Sales",
        },
        count: 2,
      },
      {
        _id: {
          workspace_key: "workspace-1::default",
          pred: "Sales",
          gold: "Support",
        },
        count: 1,
      },
      {
        _id: {
          workspace_key: "workspace-1::default",
          pred: "Support",
          gold: "Sales",
        },
        count: 1,
      },
      {
        _id: { workspace_key: "workspace-1::default", pred: "Other", gold: "" },
        count: 5,
      },
      {
        _id: {
          workspace_key: "workspace-1::custom",
          pred: "Support",
          gold: "Support",
        },
        count: 4,
      },
      {
        _id: { workspace_key: "unknown::default", pred: null, gold: "" },
        count: 3,
      },
    ]);
    const response = await GET(
      new Request("https://www.airi.chat/api/cron/offline-eval")
    );
    const body = await response.json();

    expect(body).toMatchObject({ status: "ok", groups: 3 });
    const main = body.results.find(
      (result: { workspace_key: string }) =>
        result.workspace_key === "workspace-1::default"
    );
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
    expect(main.macro.precision).toBeCloseTo(2 / 9);
    expect(main.macro.recall).toBeCloseTo(2 / 9);
    expect(main.macro.f1).toBeCloseTo(2 / 9);
    expect(body.results).toEqual(
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
              tp: 4,
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
    expect(mockInsert).toHaveBeenCalledTimes(1);
  });

  it("rejects oversized evaluation dimensions before publishing any snapshot", async () => {
    mockAggregateExec.mockResolvedValue(
      Array.from({ length: 10_001 }, (_, i) => ({
        _id: {
          workspace_key: `workspace-${i}::default`,
          pred: "Sales",
          gold: "Sales",
        },
        count: 1,
      }))
    );

    const response = await GET(
      new Request("https://www.airi.chat/api/cron/offline-eval")
    );

    expect(response.status).toBe(500);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("honors a cancelled request without reading or publishing evaluations", async () => {
    const controller = new AbortController();
    controller.abort(new Error("request cancelled"));
    const response = await GET(
      new Request("https://www.airi.chat/api/cron/offline-eval", {
        signal: controller.signal,
      })
    );

    expect(response.status).toBe(500);
    expect(mockConversationFind).not.toHaveBeenCalled();
    expect(mockConversationAggregate).not.toHaveBeenCalled();
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("stores all complete group snapshots in bounded batches", async () => {
    mockAggregateExec.mockResolvedValue(
      Array.from({ length: 201 }, (_, i) => ({
        _id: {
          workspace_key: `workspace-${i}::default`,
          pred: "Sales",
          gold: "Sales",
        },
        count: 1,
      }))
    );
    const response = await GET(
      new Request("https://www.airi.chat/api/cron/offline-eval")
    );

    expect(response.status).toBe(200);
    expect(mockInsert.mock.calls.map(([rows]) => rows.length)).toEqual([
      100, 100, 1,
    ]);
    expect(
      new Set(
        mockInsert.mock.calls.flatMap(([rows]) =>
          rows.map((row: { workspace_key: string }) => row.workspace_key)
        )
      ).size
    ).toBe(201);
    expect(mockSnapshotAbortSignal).toHaveBeenCalledWith(
      mockAggregateOption.mock.calls[0][0].signal
    );
  });

  it("stops later snapshot batches when a request is cancelled during persistence", async () => {
    const controller = new AbortController();
    mockAggregateExec.mockResolvedValue(
      Array.from({ length: 201 }, (_, i) => ({
        _id: {
          workspace_key: `workspace-${i}::default`,
          pred: "Sales",
          gold: "Sales",
        },
        count: 1,
      }))
    );
    mockSnapshotAbortSignal.mockImplementationOnce(async () => {
      controller.abort(new Error("request cancelled"));
      return { data: null, error: null };
    });
    const response = await GET(
      new Request("https://www.airi.chat/api/cron/offline-eval", {
        signal: controller.signal,
      })
    );

    expect(response.status).toBe(500);
    expect(mockInsert).toHaveBeenCalledTimes(1);
  });

  it("keeps the original query deadline through a stalled snapshot write", async () => {
    jest.useFakeTimers();
    try {
      mockAggregateExec.mockImplementationOnce(async () => {
        jest.advanceTimersByTime(20_000);
        return [
          {
            _id: {
              workspace_key: "workspace-1::default",
              pred: "Sales",
              gold: "Sales",
            },
            count: 1,
          },
        ];
      });
      mockSnapshotAbortSignal.mockImplementationOnce(
        () => new Promise(() => {})
      );
      const pending = GET(
        new Request("https://www.airi.chat/api/cron/offline-eval")
      );
      await jest.advanceTimersByTimeAsync(5_000);
      const response = await pending;

      expect(response.status).toBe(500);
      expect(mockInsert).toHaveBeenCalledTimes(1);
      expect(mockSnapshotAbortSignal.mock.calls[0][0].aborted).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  it("retains complete metrics when best-effort snapshot storage is unavailable", async () => {
    mockSnapshotAbortSignal.mockRejectedValueOnce(
      new Error("snapshot table unavailable")
    );
    const response = await GET(
      new Request("https://www.airi.chat/api/cron/offline-eval")
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "ok", groups: 1 });
  });
});
