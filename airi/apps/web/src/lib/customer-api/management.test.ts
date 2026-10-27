import { createHash } from "node:crypto";

const mockRequireAdmin = jest.fn();
const mockFrom = jest.fn();
const mockRpc = jest.fn();
const mockValidateUrl = jest.fn();
const mockEncryptSecret = jest.fn((secret: string) => `encrypted:${secret}`);

jest.mock("./access", () => ({
  requireCustomerApiAdmin: (...args: unknown[]) => mockRequireAdmin(...args),
}));
jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: {
    from: (...args: unknown[]) => mockFrom(...args),
    rpc: (...args: unknown[]) => mockRpc(...args),
  },
}));
jest.mock("@/lib/customer-webhook-config", () => ({
  CustomerWebhookUrlError: class CustomerWebhookUrlError extends Error {},
  validateCustomerWebhookUrl: (...args: unknown[]) => mockValidateUrl(...args),
  encryptCustomerWebhookSecret: (secret: string) => mockEncryptSecret(secret),
}));

import {
  createCustomerApiKey,
  createCustomerWebhook,
  disableCustomerWebhook,
  listCustomerApiKeys,
  listCustomerWebhookDeliveries,
  listCustomerWebhooks,
  revokeCustomerApiKey,
  updateCustomerWebhook,
} from "./management";
import { CustomerWebhookUrlError } from "@/lib/customer-webhook-config";

const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const OTHER_WORKSPACE = "22222222-2222-4222-8222-222222222222";
const KEY_ID = "33333333-3333-4333-8333-333333333333";
const WEBHOOK_ID = "44444444-4444-4444-8444-444444444444";
type Row = Record<string, unknown>;
let tables: Record<string, Row[]>;
let queries: Array<{
  table: string;
  filters: Array<[string, unknown]>;
  limit?: number;
}>;

type MutationInput = {
  input_actor_id: string;
  input_workspace_id: string;
  input_kind: "api_key" | "webhook";
  input_action: "create" | "revoke" | "update" | "disable";
  input_credential_id: string | null;
  input_data: Row;
};

// Models only the RPC boundary. Real authorization locks and concurrent quotas
// are verified against disposable PostgreSQL in supabase/tests.
function mockMutation(_name: string, input: MutationInput) {
  const key = input.input_kind === "api_key";
  const rows = tables[key ? "api_keys" : "webhook_subscriptions"];
  const row = rows.find(
    item =>
      item.id === input.input_credential_id &&
      item.workspace_id === input.input_workspace_id
  );
  if (input.input_action !== "create" && !row)
    return { data: null, error: { code: "P0002" } };
  if (
    input.input_action === "create" ||
    (input.input_action === "update" &&
      input.input_data.is_active &&
      !row?.is_active)
  ) {
    const count = rows.filter(
      item => item.workspace_id === input.input_workspace_id && item.is_active
    ).length;
    if (count >= (key ? 100 : 20))
      return { data: null, error: { code: "54000" } };
  }
  if (
    "expected_url" in input.input_data &&
    input.input_data.expected_url !== row?.url
  )
    return { data: null, error: { code: "40001" } };
  const values = { ...input.input_data };
  delete values.expected_url;
  if (input.input_action === "create") {
    const created = {
      id: key ? KEY_ID : WEBHOOK_ID,
      workspace_id: input.input_workspace_id,
      created_by: input.input_actor_id,
      created_at: "2026-10-03T00:00:00Z",
      last_used_at: null,
      last_triggered_at: null,
      is_active: true,
      ...(key ? { rate_limit_per_minute: 60 } : { headers: {} }),
      ...values,
    };
    rows.push(created);
    return { data: created, error: null };
  }
  Object.assign(
    row!,
    input.input_action === "update" ? values : { is_active: false }
  );
  return { data: row, error: null };
}

function mockQuery(table: string) {
  let operation = "select";
  let values: Row = {};
  let head = false;
  const ordering: Array<{
    field: string;
    ascending: boolean;
    nullsFirst: boolean;
  }> = [];
  const state = {
    table,
    filters: [] as Array<[string, unknown]>,
    limit: undefined as number | undefined,
  };
  queries.push(state);
  const execute = () => {
    const filtered = () =>
      tables[table].filter(row =>
        state.filters.every(([field, value]) => row[field] === value)
      );
    let rows: Row[];
    if (operation === "insert") {
      const row = {
        id: table === "api_keys" ? KEY_ID : WEBHOOK_ID,
        created_at: "2026-10-03T00:00:00Z",
        last_used_at: null,
        last_triggered_at: null,
        ...values,
      };
      tables[table].push(row);
      rows = [row];
    } else {
      rows = filtered();
      if (operation === "update")
        rows.forEach(row => Object.assign(row, values));
    }
    rows.sort((left, right) => {
      for (const { field, ascending, nullsFirst } of ordering) {
        const leftNull = left[field] === null || left[field] === undefined;
        const rightNull = right[field] === null || right[field] === undefined;
        if (leftNull !== rightNull) return leftNull === nullsFirst ? -1 : 1;
        const comparison = String(left[field] ?? "").localeCompare(
          String(right[field] ?? "")
        );
        if (comparison) return ascending ? comparison : -comparison;
      }
      return 0;
    });
    return {
      data: head ? null : rows.slice(0, state.limit),
      count: rows.length,
      error: null,
    };
  };
  const builder: {
    select: jest.Mock;
    eq: jest.Mock;
    order: jest.Mock;
    limit: jest.Mock;
    insert: jest.Mock;
    update: jest.Mock;
    single: jest.Mock;
    maybeSingle: jest.Mock;
    then: (
      resolve: (value: ReturnType<typeof execute>) => unknown,
      reject?: (error: unknown) => unknown
    ) => Promise<unknown>;
  } = {
    select: jest.fn((_columns: string, options?: { head?: boolean }) => {
      head = options?.head ?? false;
      return builder;
    }),
    eq: jest.fn((field: string, value: unknown) => {
      state.filters.push([field, value]);
      return builder;
    }),
    order: jest.fn(
      (
        field: string,
        options: { ascending: boolean; nullsFirst?: boolean }
      ) => {
        ordering.push({
          field,
          ascending: options.ascending,
          nullsFirst: options.nullsFirst ?? !options.ascending,
        });
        return builder;
      }
    ),
    limit: jest.fn((limit: number) => {
      state.limit = limit;
      return builder;
    }),
    insert: jest.fn((input: Row) => {
      operation = "insert";
      values = input;
      return builder;
    }),
    update: jest.fn((input: Row) => {
      operation = "update";
      values = input;
      return builder;
    }),
    single: jest.fn(async () => {
      const result = execute();
      return { ...result, data: result.data?.[0] || null };
    }),
    maybeSingle: jest.fn(async () => {
      const result = execute();
      return { ...result, data: result.data?.[0] || null };
    }),
    then: (
      resolve: (value: ReturnType<typeof execute>) => unknown,
      reject?: (error: unknown) => unknown
    ) => Promise.resolve(execute()).then(resolve, reject),
  };
  return builder;
}

function request(body: unknown, url = "https://airi.chat/api/settings") {
  return new Request(url, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

const keyInput = {
  name: "Backend",
  permissions: {
    read: true,
    write: true,
    conversations: true,
    analytics: true,
  },
};
const webhookInput = {
  url: "https://events.example.com/webhook",
  events: ["message.received", "message.status_updated"],
  description: "CRM",
};

describe("customer API management", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    tables = {
      api_keys: [],
      webhook_subscriptions: [],
      webhook_delivery_logs: [],
    };
    queries = [];
    mockFrom.mockImplementation(mockQuery);
    mockRpc.mockImplementation(mockMutation);
    mockRequireAdmin.mockResolvedValue({ ok: true, userId: "admin-a" });
    mockValidateUrl.mockImplementation(async (url: string) => url);
  });

  it.each([
    () => listCustomerApiKeys(WORKSPACE),
    () => createCustomerApiKey(request(keyInput), WORKSPACE),
    () => revokeCustomerApiKey(WORKSPACE, KEY_ID),
    () => listCustomerWebhooks(WORKSPACE),
    () => createCustomerWebhook(request(webhookInput), WORKSPACE),
    () =>
      updateCustomerWebhook(
        request({ rotate_secret: true }),
        WORKSPACE,
        WEBHOOK_ID
      ),
    () => disableCustomerWebhook(WORKSPACE, WEBHOOK_ID),
    () =>
      listCustomerWebhookDeliveries(
        new Request("https://airi.chat"),
        WORKSPACE,
        WEBHOOK_ID
      ),
  ])(
    "rejects unauthorized administrators before accessing tables",
    async action => {
      mockRequireAdmin.mockResolvedValue({
        ok: false,
        response: new Response(null, { status: 403 }),
      });
      expect((await action()).status).toBe(403);
      expect(mockFrom).not.toHaveBeenCalled();
      expect(mockRpc).not.toHaveBeenCalled();
    }
  );

  it("returns a generated API secret once, persists only its hash, and scopes lists", async () => {
    const response = await createCustomerApiKey(request(keyInput), WORKSPACE);
    expect(response.status).toBe(201);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = await response.json();
    expect(body.secret).toMatch(/^sk_[a-f0-9]{64}$/);
    expect(tables.api_keys[0]).toMatchObject({
      workspace_id: WORKSPACE,
      created_by: "admin-a",
      rate_limit_per_minute: 60,
      key_hash: createHash("sha256").update(body.secret).digest("hex"),
    });
    expect(body.apiKey).not.toHaveProperty("key_hash");
    expect(mockFrom).not.toHaveBeenCalled();
    expect(mockRpc).toHaveBeenCalledWith("mutate_customer_api_credential", {
      input_actor_id: "admin-a",
      input_workspace_id: WORKSPACE,
      input_kind: "api_key",
      input_action: "create",
      input_credential_id: null,
      input_data: {
        name: keyInput.name,
        permissions: keyInput.permissions,
        expires_at: null,
        key_prefix: body.secret.slice(0, 11),
        key_hash: createHash("sha256").update(body.secret).digest("hex"),
      },
    });
    expect(JSON.stringify(tables.api_keys)).not.toContain(`"${body.secret}"`);
    tables.api_keys.push({
      id: "foreign",
      workspace_id: OTHER_WORKSPACE,
      secret: "private",
    });
    const list = await (await listCustomerApiKeys(WORKSPACE)).json();
    expect(list.apiKeys).toHaveLength(1);
    expect(list).not.toHaveProperty("secret");
    expect(list.apiKeys[0]).not.toHaveProperty("key_hash");
    expect(list.apiKeys[0]).not.toHaveProperty("workspace_id");
  });

  it.each([
    { ...keyInput, permissions: { ...keyInput.permissions, admin: true } },
    { ...keyInput, workspace_id: OTHER_WORKSPACE },
    { ...keyInput, expires_at: "2020-01-01T00:00:00Z" },
    { ...keyInput, permissions: { read: false, write: false } },
    { ...keyInput, rate_limit_per_minute: 100000 },
  ])("rejects unsafe key settings", async input => {
    expect((await createCustomerApiKey(request(input), WORKSPACE)).status).toBe(
      400
    );
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it("revokes only a key in the current workspace", async () => {
    tables.api_keys.push({
      id: KEY_ID,
      workspace_id: OTHER_WORKSPACE,
      is_active: true,
    });
    expect((await revokeCustomerApiKey(WORKSPACE, KEY_ID)).status).toBe(404);
    expect(tables.api_keys[0].is_active).toBe(true);
    tables.api_keys[0].workspace_id = WORKSPACE;
    expect((await revokeCustomerApiKey(WORKSPACE, KEY_ID)).status).toBe(200);
    expect(tables.api_keys[0].is_active).toBe(false);
  });

  it("bounds key counts and result sets", async () => {
    tables.api_keys = Array.from({ length: 105 }, (_, id) => ({
      id,
      workspace_id: WORKSPACE,
      is_active: true,
    }));
    expect(
      (await createCustomerApiKey(request(keyInput), WORKSPACE)).status
    ).toBe(409);
    expect(
      (await (await listCustomerApiKeys(WORKSPACE)).json()).apiKeys
    ).toHaveLength(100);
  });

  it("keeps active credentials visible when newer revoked keys and disabled webhooks fill the list", async () => {
    tables.api_keys = Array.from({ length: 105 }, (_, id) => ({
      id: `revoked-${id}`,
      workspace_id: WORKSPACE,
      is_active: false,
      url: webhookInput.url,
      created_at: "2026-10-03T00:00:00Z",
    }));
    tables.api_keys.push({
      id: KEY_ID,
      workspace_id: WORKSPACE,
      is_active: true,
      created_at: "2025-01-01T00:00:00Z",
    });
    tables.api_keys.push(
      ...Array.from({ length: 105 }, (_, id) => ({
        id: `null-${id}`,
        workspace_id: WORKSPACE,
        is_active: null,
      }))
    );
    const keys = await (await listCustomerApiKeys(WORKSPACE)).json();
    expect(keys.apiKeys).toHaveLength(100);
    expect(keys.apiKeys[0]).toMatchObject({ id: KEY_ID, is_active: true });
    expect(mockFrom.mock.results.at(-1)?.value.order).toHaveBeenCalledWith(
      "is_active",
      { ascending: false, nullsFirst: false }
    );

    tables.webhook_subscriptions = Array.from({ length: 25 }, (_, id) => ({
      id: `disabled-${id}`,
      workspace_id: WORKSPACE,
      is_active: false,
      created_at: "2026-10-03T00:00:00Z",
    }));
    tables.webhook_subscriptions.push({
      id: WEBHOOK_ID,
      workspace_id: WORKSPACE,
      is_active: true,
      created_at: "2025-01-01T00:00:00Z",
    });
    tables.webhook_subscriptions.push(
      ...Array.from({ length: 25 }, (_, id) => ({
        id: `null-${id}`,
        workspace_id: WORKSPACE,
        is_active: null,
      }))
    );
    const webhooks = await (await listCustomerWebhooks(WORKSPACE)).json();
    expect(webhooks.webhooks).toHaveLength(20);
    expect(webhooks.webhooks[0]).toMatchObject({
      id: WEBHOOK_ID,
      is_active: true,
    });
    expect(mockFrom.mock.results.at(-1)?.value.order).toHaveBeenCalledWith(
      "is_active",
      { ascending: false, nullsFirst: false }
    );
  });

  it("stores encrypted webhook secrets and lists only public configuration", async () => {
    const response = await createCustomerWebhook(
      request(webhookInput),
      WORKSPACE
    );
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.secret).toMatch(/^whsec_[a-f0-9]{64}$/);
    expect(tables.webhook_subscriptions[0].secret).toBe(
      `encrypted:${body.secret}`
    );
    expect(body.webhook).not.toHaveProperty("secret");
    expect(mockValidateUrl).toHaveBeenCalledWith(webhookInput.url);
    Object.assign(tables.webhook_subscriptions[0], {
      total_deliveries: 1,
      successful_deliveries: 0,
      failed_deliveries: 1,
    });
    const list = await (await listCustomerWebhooks(WORKSPACE)).json();
    expect(list.webhooks).toHaveLength(1);
    expect(list.webhooks[0]).not.toHaveProperty("secret");
    expect(list.webhooks[0]).not.toHaveProperty("headers");
    expect(list.webhooks[0]).not.toHaveProperty("total_deliveries");
    expect(list.webhooks[0]).not.toHaveProperty("successful_deliveries");
    expect(list.webhooks[0]).not.toHaveProperty("failed_deliveries");
    expect(list.supportedEvents).toContain("message.status_updated");
    expect(list.supportedEvents).not.toContain("conversation.created");
  });

  it.each([
    { ...webhookInput, events: ["*"] },
    { ...webhookInput, events: ["coaching.tip_generated"] },
    { ...webhookInput, events: [] },
    { ...webhookInput, headers: { Authorization: "attacker" } },
    { ...webhookInput, secret: "attacker" },
  ])("rejects unsupported webhook configuration", async input => {
    expect(
      (await createCustomerWebhook(request(input), WORKSPACE)).status
    ).toBe(400);
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it("rotates a signing secret once and tenant-scopes updates", async () => {
    tables.webhook_subscriptions.push({
      id: WEBHOOK_ID,
      workspace_id: OTHER_WORKSPACE,
      secret: "old",
      is_active: false,
      url: webhookInput.url,
    });
    expect(
      (
        await updateCustomerWebhook(
          request({ rotate_secret: true }),
          WORKSPACE,
          WEBHOOK_ID
        )
      ).status
    ).toBe(404);
    expect(mockEncryptSecret).not.toHaveBeenCalled();
    tables.webhook_subscriptions[0].workspace_id = WORKSPACE;
    const body = await (
      await updateCustomerWebhook(
        request({ rotate_secret: true, is_active: true }),
        WORKSPACE,
        WEBHOOK_ID
      )
    ).json();
    expect(tables.webhook_subscriptions[0].secret).toBe(
      `encrypted:${body.secret}`
    );
    expect(body.webhook).not.toHaveProperty("secret");
    expect(mockValidateUrl).toHaveBeenCalledWith(webhookInput.url);
    const disabled = await (
      await disableCustomerWebhook(WORKSPACE, WEBHOOK_ID)
    ).json();
    expect(disabled).not.toHaveProperty("secret");
    expect(tables.webhook_subscriptions[0].is_active).toBe(false);
  });

  it("limits webhook creation and re-enabling", async () => {
    tables.webhook_subscriptions = Array.from({ length: 20 }, (_, id) => ({
      id,
      workspace_id: WORKSPACE,
      is_active: true,
    }));
    expect(
      (await createCustomerWebhook(request(webhookInput), WORKSPACE)).status
    ).toBe(409);
    tables.webhook_subscriptions.push({
      id: WEBHOOK_ID,
      workspace_id: WORKSPACE,
      is_active: false,
    });
    expect(
      (
        await updateCustomerWebhook(
          request({ is_active: true }),
          WORKSPACE,
          WEBHOOK_ID
        )
      ).status
    ).toBe(409);
  });

  it("checks webhook workspace ownership before reading bounded delivery metadata", async () => {
    tables.webhook_subscriptions.push({
      id: WEBHOOK_ID,
      workspace_id: OTHER_WORKSPACE,
    });
    tables.webhook_delivery_logs.push({
      id: "log-a",
      webhook_id: WEBHOOK_ID,
      event_type: "message.sent",
      payload: { text: "private" },
      response_body: "private",
    });
    const req = new Request("https://airi.chat/deliveries?limit=5");
    expect(
      (await listCustomerWebhookDeliveries(req, WORKSPACE, WEBHOOK_ID)).status
    ).toBe(404);
    expect(queries.some(query => query.table === "webhook_delivery_logs")).toBe(
      false
    );
    tables.webhook_subscriptions[0].workspace_id = WORKSPACE;
    const body = await (
      await listCustomerWebhookDeliveries(req, WORKSPACE, WEBHOOK_ID)
    ).json();
    expect(body.deliveries).toHaveLength(1);
    expect(body.deliveries[0]).not.toHaveProperty("payload");
    expect(body.deliveries[0]).not.toHaveProperty("response_body");
    expect(queries.at(-1)?.limit).toBe(5);
  });

  it.each(["0", "101", "no", "1.5"])(
    "rejects invalid delivery limit %s",
    async limit => {
      expect(
        (
          await listCustomerWebhookDeliveries(
            new Request(`https://airi.chat/?limit=${limit}`),
            WORKSPACE,
            WEBHOOK_ID
          )
        ).status
      ).toBe(400);
      expect(mockFrom).not.toHaveBeenCalled();
    }
  );

  it("limits JSON body size before parsing or database work", async () => {
    expect(
      (
        await createCustomerApiKey(
          request({ ...keyInput, name: "x".repeat(17000) }),
          WORKSPACE
        )
      ).status
    ).toBe(413);
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it("does not disclose database error details", async () => {
    mockFrom.mockImplementation(() => {
      throw new Error("secret=credential database failure");
    });
    const response = await listCustomerApiKeys(WORKSPACE);
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("credential");
  });

  it("rechecks membership after an authorized request finishes reading a slow body", async () => {
    let finishBody!: (value: string) => void;
    let bodyStarted!: () => void;
    const bodyReady = new Promise<void>(resolve => {
      bodyStarted = resolve;
    });
    const body = new ReadableStream({
      async start(controller) {
        bodyStarted();
        const json = await new Promise<string>(resolve => {
          finishBody = resolve;
        });
        controller.enqueue(new TextEncoder().encode(json));
        controller.close();
      },
    });
    const slowRequest = new Request("https://airi.chat/api/settings", {
      method: "POST",
      body,
      // Node requires duplex for streamed request bodies.
      duplex: "half",
    } as RequestInit);
    const responsePromise = createCustomerApiKey(slowRequest, WORKSPACE);
    await bodyReady;
    mockRpc.mockResolvedValue({
      data: null,
      error: { code: "42501", message: "private details" },
    });
    finishBody(JSON.stringify(keyInput));
    const response = await responsePromise;
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: "Workspace admin access required",
    });
    expect(tables.api_keys).toEqual([]);
    expect(mockFrom).not.toHaveBeenCalled();
    expect(mockRpc).toHaveBeenCalledTimes(1);
  });

  it.each([
    () => createCustomerApiKey(request(keyInput), WORKSPACE),
    () => revokeCustomerApiKey(WORKSPACE, KEY_ID),
    () => createCustomerWebhook(request(webhookInput), WORKSPACE),
    () =>
      updateCustomerWebhook(
        request({ rotate_secret: true }),
        WORKSPACE,
        WEBHOOK_ID
      ),
    () => disableCustomerWebhook(WORKSPACE, WEBHOOK_ID),
  ])(
    "never returns one-time secrets after a transactional authorization denial",
    async action => {
      tables.webhook_subscriptions.push({
        id: WEBHOOK_ID,
        workspace_id: WORKSPACE,
        url: webhookInput.url,
      });
      mockRpc.mockResolvedValue({ data: null, error: { code: "42501" } });
      const response = await action();
      expect(response.status).toBe(403);
      expect(await response.json()).not.toHaveProperty("secret");
      expect(mockRpc).toHaveBeenCalledTimes(1);
    }
  );

  it.each([{ is_active: true }, { rotate_secret: true }])(
    "does not use a stale endpoint during activation or rotation: %o",
    async input => {
      tables.webhook_subscriptions.push({
        id: WEBHOOK_ID,
        workspace_id: WORKSPACE,
        url: webhookInput.url,
        is_active: false,
      });
      mockValidateUrl.mockImplementation(async (url: string) => {
        tables.webhook_subscriptions[0].url =
          "https://changed.example.com/webhook";
        return url;
      });
      const response = await updateCustomerWebhook(
        request(input),
        WORKSPACE,
        WEBHOOK_ID
      );
      expect(response.status).toBe(409);
      expect(tables.webhook_subscriptions[0]).toMatchObject({
        url: "https://changed.example.com/webhook",
        is_active: false,
      });
      expect(mockRpc.mock.calls[0][1].input_data).toMatchObject({
        expected_url: webhookInput.url,
      });
      expect(mockRpc.mock.calls[0][1].input_data).not.toHaveProperty("url");
    }
  );

  it.each([{ is_active: true }, { rotate_secret: true }])(
    "rejects unsafe legacy endpoints during activation or rotation: %o",
    async input => {
      tables.webhook_subscriptions.push({
        id: WEBHOOK_ID,
        workspace_id: WORKSPACE,
        url: "https://127.0.0.1/webhook",
        is_active: false,
        secret: "old",
      });
      mockValidateUrl.mockRejectedValue(
        new CustomerWebhookUrlError("Enter a public webhook URL")
      );
      const response = await updateCustomerWebhook(
        request(input),
        WORKSPACE,
        WEBHOOK_ID
      );
      expect(response.status).toBe(400);
      expect(await response.json()).not.toHaveProperty("secret");
      expect(mockRpc).not.toHaveBeenCalled();
      expect(tables.webhook_subscriptions[0]).toMatchObject({
        is_active: false,
        secret: "old",
      });
    }
  );

  it("maps only known RPC errors and hides arbitrary database details", async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { code: "XX000", message: "secret=credential" },
    });
    const response = await createCustomerApiKey(request(keyInput), WORKSPACE);
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("credential");
  });
});
