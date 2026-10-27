import { createHmac } from "node:crypto";

type Row = Record<string, unknown>;

const mockWebhookLoggerError = jest.fn();
const mockEnqueueCustomerWebhook = jest.fn();
jest.mock("./cross-store-outbox", () => ({
  enqueueCustomerWebhookWithOutbox: (...args: unknown[]) =>
    mockEnqueueCustomerWebhook(...args),
}));
jest.mock("./customer-webhook-config", () => ({
  decryptCustomerWebhookSecret: (secret: string) => secret,
  safeCustomerWebhookFetch: (...args: Parameters<typeof fetch>) =>
    fetch(...args),
}));
const state: {
  subscriptions: Row[];
  logs: Row[];
  nextLogId: number;
  failure: null | { table: string; action: string; error: Row };
} = {
  subscriptions: [],
  logs: [],
  nextLogId: 1,
  failure: null,
};

function rowsForTable(table: string): Row[] {
  if (table === "webhook_subscriptions") return state.subscriptions;
  if (table === "webhook_delivery_logs") return state.logs;
  throw new Error(`Unexpected table ${table}`);
}

class Query {
  private action = "select";
  private values: Row | Row[] | null = null;
  private filters: Array<(row: Row) => boolean> = [];

  constructor(private readonly table: string) {}

  select(): this {
    return this;
  }

  insert(values: Row | Row[]): this {
    this.action = "insert";
    this.values = values;
    return this;
  }

  update(values: Row): this {
    this.action = "update";
    this.values = values;
    return this;
  }

  eq(field: string, value: unknown): this {
    this.filters.push(row => row[field] === value);
    return this;
  }

  is(field: string, value: unknown): this {
    this.filters.push(row => row[field] === value);
    return this;
  }

  contains(field: string, values: unknown[]): this {
    this.filters.push(row => {
      const stored = row[field];
      return (
        Array.isArray(stored) && values.every(value => stored.includes(value))
      );
    });
    return this;
  }

  in(field: string, values: unknown[]): this {
    this.filters.push(row => values.includes(row[field]));
    return this;
  }

  async single(): Promise<{ data: Row | null; error: Row | null }> {
    const result = this.execute();
    if (result.error) return { data: null, error: result.error };
    if (!result.data || result.data.length !== 1) {
      return {
        data: null,
        error: { code: "PGRST116", message: "Expected one row" },
      };
    }
    return { data: result.data[0], error: null };
  }

  async maybeSingle(): Promise<{ data: Row | null; error: Row | null }> {
    const result = this.execute();
    if (result.error) return { data: null, error: result.error };
    if (!result.data || result.data.length > 1) {
      return {
        data: null,
        error: { code: "PGRST116", message: "Expected at most one row" },
      };
    }
    return { data: result.data[0] || null, error: null };
  }

  then<TResult1 = { data: Row[] | null; error: Row | null }, TResult2 = never>(
    onfulfilled?:
      | ((value: {
          data: Row[] | null;
          error: Row | null;
        }) => TResult1 | PromiseLike<TResult1>)
      | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): Promise<TResult1 | TResult2> {
    return Promise.resolve(this.execute()).then(onfulfilled, onrejected);
  }

  private execute(): { data: Row[] | null; error: Row | null } {
    if (
      state.failure?.table === this.table &&
      state.failure.action === this.action
    ) {
      const error = state.failure.error;
      state.failure = null;
      return { data: null, error };
    }

    const rows = rowsForTable(this.table);
    if (this.action === "select") {
      return {
        data: rows.filter(row => this.filters.every(filter => filter(row))),
        error: null,
      };
    }

    if (this.action === "insert") {
      const inserted = (
        Array.isArray(this.values) ? this.values : [this.values]
      ).filter(Boolean) as Row[];
      if (this.table === "webhook_delivery_logs") {
        const duplicate = inserted.some(candidate =>
          rows.some(
            existing => existing.idempotency_key === candidate.idempotency_key
          )
        );
        if (duplicate) {
          return {
            data: null,
            error: { code: "23505", message: "duplicate idempotency key" },
          };
        }
      }
      const created = inserted.map(row => ({
        ...(this.table === "webhook_delivery_logs" && !row.id
          ? { id: `log-${state.nextLogId++}` }
          : {}),
        ...row,
        ...(this.table === "webhook_delivery_logs"
          ? { payload: JSON.parse(JSON.stringify(row.payload)) }
          : {}),
      }));
      rows.push(...created);
      return { data: created, error: null };
    }

    const matched = rows.filter(row =>
      this.filters.every(filter => filter(row))
    );
    for (const row of matched) {
      Object.assign(row, this.values);
    }
    return { data: matched, error: null };
  }
}

const mockSupabaseFrom = jest.fn((table: string) => new Query(table));

jest.mock("./supabase/admin", () => ({
  supabaseAdmin: {
    from: (...args: [string]) => mockSupabaseFrom(...args),
  },
}));

jest.mock("@icecore/shared/lib/logger", () => ({
  createLogger: () => ({
    error: (...args: unknown[]) => mockWebhookLoggerError(...args),
  }),
}));

import {
  dispatchWebhookEvent,
  triggerWebhookEvent,
  queueCustomerWebhookEvent,
  snapshotWebhookSubscriptionIds,
  listActiveWebhookEventTypes,
  WEBHOOK_EVENTS,
} from "./webhooks";

const completedAt = "2026-08-10T06:06:03.645Z";
const classificationData = {
  conversation_id: "507f1f77bcf86cd799439011",
  analysis_revision_id: "analysis-revision-1",
  source_revision: 7,
  category: "billing",
  priority: "high",
  sentiment: "negative",
  summary: "Customer asks about an invoice.",
  confidence: 0.73,
  completed_at: completedAt,
};
const classificationPayload = {
  event: WEBHOOK_EVENTS.CLASSIFICATION_COMPLETED,
  timestamp: completedAt,
  workspace_id: "workspace-1",
  data: classificationData,
};

function addSubscription(overrides: Row = {}): Row {
  const subscription = {
    id: `webhook-${state.subscriptions.length + 1}`,
    workspace_id: "workspace-1",
    url: "https://customer.example/webhooks",
    secret: "whsec_test",
    events: [WEBHOOK_EVENTS.CLASSIFICATION_COMPLETED],
    headers: {},
    is_active: true,
    ...overrides,
  };
  state.subscriptions.push(subscription);
  return subscription;
}

function addDeliveryLog(overrides: Row = {}): Row {
  const log = {
    id: `log-${state.nextLogId++}`,
    webhook_id: "webhook-1",
    event_type: WEBHOOK_EVENTS.CLASSIFICATION_COMPLETED,
    payload: classificationPayload,
    response_status: 503,
    response_body: "unavailable",
    error_message: null,
    attempt_number: 1,
    delivered_at: null,
    next_retry_at: null,
    idempotency_key: "webhook-1:classification.completed:analysis-revision-1",
    ...overrides,
  };
  state.logs.push(log);
  return log;
}

function dispatchClassification() {
  return dispatchWebhookEvent({
    workspaceId: "workspace-1",
    eventType: WEBHOOK_EVENTS.CLASSIFICATION_COMPLETED,
    resourceId: "analysis-revision-1",
    timestamp: completedAt,
    data: classificationData,
  });
}

function mockResponse(status: number, body = "ok"): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
  } as Response;
}

describe("durable customer event admission", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    state.subscriptions = [];
    mockEnqueueCustomerWebhook.mockReset().mockResolvedValue(undefined);
  });

  it("durably queues immutable facts without querying subscribers or doing HTTP", async () => {
    await queueCustomerWebhookEvent({
      workspaceId: "workspace-1",
      eventType: WEBHOOK_EVENTS.MESSAGE_RECEIVED,
      resourceId: "wamid.incoming",
      timestamp: completedAt,
      data: { text: "Hello" },
    });
    expect(mockSupabaseFrom).not.toHaveBeenCalled();
    expect(mockEnqueueCustomerWebhook).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      eventType: "message.received",
      resourceId: "wamid.incoming",
      timestamp: completedAt,
      data: { text: "Hello" },
    });
  });

  it("propagates queue persistence failures to owners with a recovery boundary", async () => {
    mockEnqueueCustomerWebhook.mockRejectedValueOnce(
      new Error("Mongo unavailable")
    );
    await expect(
      queueCustomerWebhookEvent({
        workspaceId: "workspace-1",
        eventType: WEBHOOK_EVENTS.MESSAGE_RECEIVED,
        resourceId: "wamid.incoming",
        timestamp: completedAt,
        data: {},
      })
    ).rejects.toThrow("Mongo unavailable");
  });

  it("snapshots only active subscriptions matching the workspace and event", async () => {
    addSubscription({ id: "our-active" });
    addSubscription({ id: "other-tenant", workspace_id: "workspace-2" });
    addSubscription({ id: "inactive", is_active: false });
    addSubscription({ id: "other-event", events: ["message.sent"] });
    await expect(
      snapshotWebhookSubscriptionIds({
        workspaceId: "workspace-1",
        eventType: WEBHOOK_EVENTS.CLASSIFICATION_COMPLETED,
      })
    ).resolves.toEqual(["our-active"]);
  });

  it("lists active subscription event types per workspace in one query", async () => {
    addSubscription({ id: "our-active" });
    addSubscription({ id: "our-status", events: ["message.status_updated"] });
    addSubscription({
      id: "inactive",
      is_active: false,
      events: ["message.sent"],
    });
    addSubscription({ workspace_id: "workspace-2", events: ["message.sent"] });
    addSubscription({ workspace_id: "workspace-3", events: ["message.sent"] });
    mockSupabaseFrom.mockClear();

    const subscribed = await listActiveWebhookEventTypes([
      "workspace-1",
      "workspace-2",
      "workspace-1",
      "",
    ]);

    expect(mockSupabaseFrom).toHaveBeenCalledTimes(1);
    expect(
      Object.fromEntries(
        [...subscribed].map(([workspaceId, events]) => [
          workspaceId,
          [...events].sort(),
        ])
      )
    ).toEqual({
      "workspace-1": [
        WEBHOOK_EVENTS.CLASSIFICATION_COMPLETED,
        WEBHOOK_EVENTS.MESSAGE_STATUS_UPDATED,
      ],
      "workspace-2": [WEBHOOK_EVENTS.MESSAGE_SENT],
    });
  });

  it("reports a failed subscription listing instead of an empty one", async () => {
    addSubscription({ id: "our-active" });
    state.failure = {
      table: "webhook_subscriptions",
      action: "select",
      error: { code: "57014", message: "canceling statement" },
    };
    await expect(listActiveWebhookEventTypes(["workspace-1"])).rejects.toThrow(
      "Webhook subscription query failed (57014)"
    );
  });

  it("reads at most 40 workspaces per query", async () => {
    mockSupabaseFrom.mockClear();
    const ids = Array.from({ length: 100 }, (_, index) => `workspace-${index}`);
    await listActiveWebhookEventTypes(ids);
    expect(mockSupabaseFrom).toHaveBeenCalledTimes(3);
  });

  it("fails a listing that may have hit the response row ceiling", async () => {
    for (let index = 0; index < 1_000; index += 1)
      addSubscription({ id: `many-${index}`, events: ["message.sent"] });
    await expect(listActiveWebhookEventTypes(["workspace-1"])).rejects.toThrow(
      "Webhook subscription listing may be truncated"
    );
  });

  it("keys subscribed event types by lowercase workspace id", async () => {
    addSubscription({ workspace_id: "Workspace-9", events: ["message.sent"] });
    const subscribed = await listActiveWebhookEventTypes(["Workspace-9"]);
    expect([...subscribed.keys()]).toEqual(["workspace-9"]);
  });

  it("skips the query when there are no workspaces to check", async () => {
    mockSupabaseFrom.mockClear();
    await expect(listActiveWebhookEventTypes([])).resolves.toEqual(new Map());
    expect(mockSupabaseFrom).not.toHaveBeenCalled();
  });
});

describe("strict webhook delivery core", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2026-08-10T06:07:00.000Z"));
    jest.clearAllMocks();
    mockEnqueueCustomerWebhook.mockReset().mockResolvedValue(undefined);
    state.subscriptions = [];
    state.logs = [];
    state.nextLogId = 1;
    state.failure = null;
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it("queues the legacy wrapper without waiting for customer HTTP", async () => {
    addSubscription({ events: [WEBHOOK_EVENTS.CONVERSATION_UPDATED] });
    jest.spyOn(global, "fetch").mockResolvedValue(mockResponse(200));

    await expect(
      triggerWebhookEvent(
        "workspace-1",
        WEBHOOK_EVENTS.CONVERSATION_UPDATED,
        "conversation-1",
        { conversation_id: "conversation-1" }
      )
    ).resolves.toBeUndefined();

    expect(state.logs).toHaveLength(0);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(mockEnqueueCustomerWebhook).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: WEBHOOK_EVENTS.CONVERSATION_UPDATED,
        workspaceId: "workspace-1",
      })
    );

    mockEnqueueCustomerWebhook.mockRejectedValueOnce(new Error("queue failed"));
    await expect(
      triggerWebhookEvent(
        "workspace-1",
        WEBHOOK_EVENTS.CONVERSATION_UPDATED,
        "conversation-2",
        { conversation_id: "conversation-2" }
      )
    ).resolves.toBeUndefined();
    expect(mockWebhookLoggerError).toHaveBeenCalledTimes(1);
  });

  it("preserves JSON serialization for non-plain payload values", async () => {
    addSubscription({ events: [WEBHOOK_EVENTS.CONVERSATION_UPDATED] });
    const fetchSpy = jest
      .spyOn(global, "fetch")
      .mockResolvedValue(mockResponse(200));

    await dispatchWebhookEvent({
      workspaceId: "workspace-1",
      eventType: WEBHOOK_EVENTS.CONVERSATION_UPDATED,
      resourceId: "conversation-1",
      timestamp: completedAt,
      data: { occurred_at: new Date("2026-08-10T06:05:00.000Z") },
    });

    expect(JSON.parse(String(fetchSpy.mock.calls[0][1]?.body))).toEqual(
      expect.objectContaining({
        data: { occurred_at: "2026-08-10T06:05:00.000Z" },
      })
    );
  });

  it("uses the real workspace, persisted time, stable key, and reserved headers", async () => {
    addSubscription({
      headers: {
        "X-Customer": "kept",
        "Content-Type": "text/plain",
        "content-type": "also evil",
        "User-Agent": "evil",
        "x-airi.chat-signature": "evil",
        "X-Airi.chat-Idempotency-Key": "evil",
        "X-Airi.chat-Event": "evil",
      },
    });
    const fetchSpy = jest
      .spyOn(global, "fetch")
      .mockResolvedValue(mockResponse(200));

    await expect(dispatchClassification()).resolves.toBeUndefined();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://customer.example/webhooks");
    expect(JSON.parse(String(init?.body))).toEqual(classificationPayload);
    expect(init?.headers).toEqual(
      expect.objectContaining({
        "Content-Type": "application/json",
        "User-Agent": "Airi.chat-Webhooks/1.0",
        "X-Customer": "kept",
        "X-Airi.chat-Event": "classification.completed",
        "X-Airi.chat-Timestamp": completedAt,
        "X-Airi.chat-Delivery-Attempt": "1",
        "X-Airi.chat-Idempotency-Key":
          "webhook-1:classification.completed:analysis-revision-1",
        "X-Airi.chat-Signature": expect.any(String),
      })
    );
    const normalizedHeaders = Object.fromEntries(
      Object.entries(init?.headers as Record<string, string>).map(
        ([name, value]) => [name.toLowerCase(), value]
      )
    );
    expect(normalizedHeaders["content-type"]).toBe("application/json");
    expect(normalizedHeaders["x-airi.chat-signature"]).not.toBe("evil");
    expect(normalizedHeaders["x-airi.chat-signature"]).toBe(
      createHmac("sha256", "whsec_test")
        .update(String(init?.body))
        .digest("hex")
    );
    expect(init?.redirect).toBe("error");
    expect(
      Object.keys(init?.headers as Record<string, string>).filter(
        name => name.toLowerCase() === "content-type"
      )
    ).toHaveLength(1);
    expect(
      Object.keys(init?.headers as Record<string, string>).filter(
        name => name.toLowerCase() === "x-airi.chat-signature"
      )
    ).toHaveLength(1);
    expect(state.logs[0]).toEqual(
      expect.objectContaining({
        attempt_number: 1,
        delivered_at: expect.any(String),
        idempotency_key:
          "webhook-1:classification.completed:analysis-revision-1",
        payload: classificationPayload,
      })
    );
  });

  it("cannot dispatch a foreign tenant subscription ID from a frozen payload", async () => {
    addSubscription({
      id: "foreign-subscription",
      workspace_id: "workspace-2",
    });
    const fetchSpy = jest.spyOn(global, "fetch");
    await dispatchWebhookEvent({
      workspaceId: "workspace-1",
      eventType: WEBHOOK_EVENTS.CLASSIFICATION_COMPLETED,
      resourceId: "analysis-revision-1",
      timestamp: completedAt,
      data: classificationData,
      subscriptionIds: ["foreign-subscription"],
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(state.logs).toHaveLength(0);
  });

  it("treats an exact successful log as complete without HTTP", async () => {
    addSubscription();
    addDeliveryLog({
      response_status: 200,
      response_body: "ok",
      delivered_at: "2026-08-10T06:06:04.000Z",
    });
    const fetchSpy = jest.spyOn(global, "fetch");

    await expect(dispatchClassification()).resolves.toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("claims a failed log with the next monotonic attempt", async () => {
    addSubscription();
    const log = addDeliveryLog();
    const fetchSpy = jest
      .spyOn(global, "fetch")
      .mockResolvedValue(mockResponse(200));

    await expect(dispatchClassification()).resolves.toBeUndefined();

    expect(log.attempt_number).toBe(2);
    expect(log.delivered_at).toEqual(expect.any(String));
    expect(fetchSpy.mock.calls[0][1]?.headers).toEqual(
      expect.objectContaining({ "X-Airi.chat-Delivery-Attempt": "2" })
    );
  });

  it("lets only one concurrent reservation send HTTP", async () => {
    addSubscription();
    let releaseResponse!: () => void;
    const fetchSpy = jest.spyOn(global, "fetch").mockImplementation(
      () =>
        new Promise<Response>(resolve => {
          releaseResponse = () => resolve(mockResponse(200));
        })
    );

    const winner = dispatchClassification();
    await Promise.resolve();
    await Promise.resolve();
    const contender = dispatchClassification();

    await expect(contender).rejects.toThrow(/reservation/i);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    releaseResponse();
    await expect(winner).resolves.toBeUndefined();
  });

  it("does not steal a live reservation", async () => {
    addSubscription();
    const log = addDeliveryLog({
      response_status: null,
      response_body: null,
      error_message: null,
      next_retry_at: "2026-08-10T06:07:30.000Z",
    });
    const fetchSpy = jest.spyOn(global, "fetch");

    await expect(dispatchClassification()).rejects.toThrow(/reservation/i);
    expect(log.attempt_number).toBe(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("keeps response, log, and query errors strict", async () => {
    addSubscription();
    jest.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => {
        throw new Error("body read failed");
      },
    } as unknown as Response);

    await expect(dispatchClassification()).rejects.toThrow("body read failed");
    expect(state.logs[0].error_message).toBe("body read failed");

    state.logs = [];
    state.failure = {
      table: "webhook_delivery_logs",
      action: "insert",
      error: { code: "XX001", message: "insert failed" },
    };
    await expect(dispatchClassification()).rejects.toThrow("insert failed");

    state.failure = {
      table: "webhook_subscriptions",
      action: "select",
      error: { code: "XX001", message: "subscription query failed" },
    };
    await expect(dispatchClassification()).rejects.toThrow(
      "subscription query failed"
    );
  });

  it("attempts and awaits every subscription before throwing aggregate failure", async () => {
    addSubscription({ id: "webhook-1" });
    addSubscription({
      id: "webhook-2",
      url: "https://customer-two.example/webhooks",
    });
    let releaseSecond!: () => void;
    let markBothStarted!: () => void;
    const bothStarted = new Promise<void>(resolve => {
      markBothStarted = resolve;
    });
    const fetchSpy = jest
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(mockResponse(503, "unavailable"))
      .mockImplementationOnce(
        () =>
          new Promise<Response>(resolve => {
            markBothStarted();
            releaseSecond = () => resolve(mockResponse(200));
          })
      );

    let settled = false;
    const delivery = dispatchClassification().finally(() => {
      settled = true;
    });
    await bothStarted;

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(settled).toBe(false);
    releaseSecond();
    await expect(delivery).rejects.toThrow(/1 webhook delivery failed/i);
    expect(state.logs).toHaveLength(2);
  });

  it("isolates a malformed subscription while attempting valid subscriptions", async () => {
    addSubscription({
      id: "webhook-malformed",
      headers: { "X-Customer": 42 },
    });
    addSubscription({
      id: "webhook-valid",
      url: "https://customer-valid.example/webhooks",
    });
    const fetchSpy = jest
      .spyOn(global, "fetch")
      .mockResolvedValue(mockResponse(200));

    await expect(dispatchClassification()).rejects.toThrow(
      /1 webhook delivery failed/i
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][0]).toBe(
      "https://customer-valid.example/webhooks"
    );
    expect(state.logs).toEqual([
      expect.objectContaining({ webhook_id: "webhook-valid" }),
    ]);
  });

  it("allows attempt six without a subscription-side write", async () => {
    const subscription = addSubscription();
    const subscriptionBefore = { ...subscription };
    const log = addDeliveryLog({ attempt_number: 5 });
    jest.spyOn(global, "fetch").mockResolvedValue(mockResponse(200));

    await expect(dispatchClassification()).resolves.toBeUndefined();

    expect(log.attempt_number).toBe(6);
    expect(subscription).toEqual(subscriptionBefore);
  });
});
