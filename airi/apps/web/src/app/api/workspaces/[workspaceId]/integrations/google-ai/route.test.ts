/** @jest-environment node */
jest.mock("@/lib/auth/workspace-membership", () => ({
  getAuthenticatedWorkspaceMembership: jest.fn(),
}));
jest.mock("@/lib/google/google-ai-source", () => ({
  ...jest.requireActual("@/lib/google/google-ai-source"),
  validateGoogleAiApiKey: jest.fn(),
}));

import { NextResponse } from "next/server";
import { getAuthenticatedWorkspaceMembership } from "@/lib/auth/workspace-membership";
import {
  GoogleAiConnectionError,
  validateGoogleAiApiKey,
} from "@/lib/google/google-ai-source";
import { decryptString } from "@/lib/crypto";
import { PUT, DELETE } from "./route";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const context = { params: Promise.resolve({ workspaceId }) };
const key = "customer-current-google-key-1234";
const mockAuth = jest.mocked(getAuthenticatedWorkspaceMembership);
const mockValidate = jest.mocked(validateGoogleAiApiKey);
type Row = Record<string, unknown>;

// In-memory persistence boundary applies the production query predicates. A
// missing workspace/type filter would mutate the decoy rows in the tests below.
function database(initial: Row[] = []) {
  const rows = initial;
  let failure: { code: string; message: string } | null = null;
  const from = jest.fn((table: string) => {
    let operation = "read";
    let values: Row = {};
    const filters: Array<[string, unknown]> = [];
    const run = () => {
      if (failure && table === "sources") return { data: null, error: failure };
      if (table === "workspaces")
        return { data: { company_id: "company-1" }, error: null };
      const matching = rows.filter(row =>
        filters.every(([field, value]) =>
          field === "credentials"
            ? JSON.stringify(row[field]) === value
            : row[field] === value
        )
      );
      if (operation === "insert") {
        const row = {
          id: "google-1",
          created_at: "2026-09-17T00:00:00.000Z",
          ...values,
        };
        rows.push(row);
        return { data: row, error: null };
      }
      if (operation === "update")
        matching.forEach(row => Object.assign(row, values));
      if (operation === "delete")
        matching.forEach(row => rows.splice(rows.indexOf(row), 1));
      return {
        data: matching[0] ? structuredClone(matching[0]) : null,
        error: null,
      };
    };
    const query: {
      select: jest.Mock;
      eq: jest.Mock;
      insert: jest.Mock;
      update: jest.Mock;
      delete: jest.Mock;
      maybeSingle: jest.Mock;
      single: jest.Mock;
      then: (
        resolve: (result: ReturnType<typeof run>) => unknown
      ) => Promise<unknown>;
    } = {
      select: jest.fn(() => query),
      eq: jest.fn((field: string, value: unknown) => {
        filters.push([field, value]);
        return query;
      }),
      insert: jest.fn((input: Row) => {
        operation = "insert";
        values = input;
        return query;
      }),
      update: jest.fn((input: Row) => {
        operation = "update";
        values = input;
        return query;
      }),
      delete: jest.fn(() => {
        operation = "delete";
        return query;
      }),
      maybeSingle: jest.fn(async () => run()),
      single: jest.fn(async () => run()),
      then: (resolve: (result: ReturnType<typeof run>) => unknown) =>
        Promise.resolve(run()).then(resolve),
    };
    return query;
  });
  const supabase = { from };
  mockAuth.mockResolvedValue({
    supabase,
    user: { id: "user-1" },
    membership: { role: "admin" },
  } as never);
  return {
    rows,
    from,
    fail: () => {
      failure = { code: "DB_ERROR", message: key };
    },
  };
}

function request(body: unknown = { apiKey: key }) {
  return new Request(
    `https://airi.chat/api/workspaces/${workspaceId}/integrations/google-ai`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }
  );
}

describe("Google AI source mutations", () => {
  const oldSecret = process.env.ENCRYPTION_SECRET;
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ENCRYPTION_SECRET = "local-test-encryption-only";
    mockValidate.mockResolvedValue({ modelCount: 5 });
  });
  afterAll(() => {
    if (oldSecret === undefined) delete process.env.ENCRYPTION_SECRET;
    else process.env.ENCRYPTION_SECRET = oldSecret;
  });

  it("encrypts a validated key and returns only public connection metadata", async () => {
    const db = database();
    const response = await PUT(request({ apiKey: ` ${key} ` }), context);
    expect(response.status).toBe(200);
    expect(db.rows).toHaveLength(1);
    const stored = db.rows[0].credentials as {
      api_key: Parameters<typeof decryptString>[0];
    };
    expect(decryptString(stored.api_key)).toBe(key);
    expect(JSON.stringify(db.rows)).not.toContain(key);
    const body = await response.json();
    expect(body.source.credentials).toMatchObject({
      has_api_key: true,
      key_label: "****1234",
      model_count: 5,
    });
    expect(body.source.credentials.api_key).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("ciphertext");
    expect(mockValidate).toHaveBeenCalledWith(key);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("replaces the same source and preserves its original connection time", async () => {
    const created = "2026-08-01T00:00:00.000Z";
    const other = {
      id: "decoy",
      workspace_id: "other",
      type: "google_ai",
      credentials: { api_key: "other-private" },
    };
    const db = database([
      other,
      {
        id: "existing",
        workspace_id: workspaceId,
        type: "google_ai",
        credentials: { connected_at: created },
      },
    ]);
    const response = await PUT(request(), context);
    expect(response.status).toBe(200);
    expect(db.rows).toHaveLength(2);
    expect((await response.json()).source).toMatchObject({
      id: "existing",
      credentials: { connected_at: created },
    });
    expect(db.rows[0]).toEqual(other);
  });

  it.each([401, 403])(
    "does not contact Google or storage without access (%s)",
    async status => {
      const db = database();
      mockAuth.mockResolvedValue({
        error: NextResponse.json({ error: "denied" }, { status }),
      });
      expect((await PUT(request(), context)).status).toBe(status);
      expect((await DELETE(request(), context)).status).toBe(status);
      expect(mockValidate).not.toHaveBeenCalled();
      expect(db.from).not.toHaveBeenCalled();
    }
  );

  it("preserves a working source when replacement validation fails", async () => {
    const existing = {
      id: "existing",
      workspace_id: workspaceId,
      type: "google_ai",
      credentials: { marker: "keep" },
    };
    const db = database([existing]);
    mockValidate.mockRejectedValue(
      new GoogleAiConnectionError("GOOGLE_AI_ACCESS_DENIED")
    );
    const response = await PUT(request(), context);
    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe("GOOGLE_AI_ACCESS_DENIED");
    expect(db.rows).toEqual([existing]);
  });

  it("does not let an older slow key replacement overwrite a newer successful save", async () => {
    const db = database([
      {
        id: "existing",
        workspace_id: workspaceId,
        type: "google_ai",
        credentials: { marker: "original" },
      },
    ]);
    let finishOlder!: (result: { modelCount: number }) => void;
    let olderStarted!: () => void;
    const started = new Promise<void>(resolve => {
      olderStarted = resolve;
    });
    mockValidate.mockImplementationOnce(() => {
      olderStarted();
      return new Promise(resolve => {
        finishOlder = resolve;
      });
    });
    const older = PUT(request({ apiKey: "older-customer-key" }), context);
    await started;
    expect((await PUT(request(), context)).status).toBe(200);
    finishOlder({ modelCount: 1 });
    expect((await older).status).toBe(409);
    const stored = db.rows[0].credentials as {
      api_key: Parameters<typeof decryptString>[0];
    };
    expect(decryptString(stored.api_key)).toBe(key);
  });

  it("does not restore a disconnected source when validation completes later", async () => {
    const db = database([
      {
        id: "existing",
        workspace_id: workspaceId,
        type: "google_ai",
        credentials: {},
      },
    ]);
    let finish!: (result: { modelCount: number }) => void;
    let validationStarted!: () => void;
    const started = new Promise<void>(resolve => {
      validationStarted = resolve;
    });
    mockValidate.mockImplementationOnce(() => {
      validationStarted();
      return new Promise(resolve => {
        finish = resolve;
      });
    });
    const save = PUT(request(), context);
    await started;
    expect((await DELETE(request(), context)).status).toBe(200);
    finish({ modelCount: 1 });
    expect((await save).status).toBe(409);
    expect(db.rows).toHaveLength(0);
  });

  it.each([
    null,
    [],
    {},
    { apiKey: 123 },
    { apiKey: "" },
    { apiKey: "a\nb" },
    { apiKey: "x".repeat(4097) },
  ])("rejects invalid input without validation (%j)", async body => {
    const db = database();
    expect((await PUT(request(body), context)).status).toBe(400);
    expect(mockValidate).not.toHaveBeenCalled();
    expect(db.rows).toEqual([]);
  });

  it("rejects malformed and oversized JSON", async () => {
    database();
    const malformed = new Request("https://airi.chat", {
      method: "PUT",
      body: "{",
    });
    expect((await PUT(malformed, context)).status).toBe(400);
    expect(
      (await PUT(request({ apiKey: "x".repeat(9000) }), context)).status
    ).toBe(413);
    expect(mockValidate).not.toHaveBeenCalled();
  });

  it("fails closed without encryption and never exposes provider or database errors", async () => {
    const db = database();
    delete process.env.ENCRYPTION_SECRET;
    expect((await (await PUT(request(), context)).json()).code).toBe(
      "ENCRYPTION_UNAVAILABLE"
    );
    expect(db.rows).toHaveLength(0);
    process.env.ENCRYPTION_SECRET = "local-test";
    db.fail();
    const body = await (await PUT(request(), context)).json();
    expect(body.code).toBe("SOURCE_SAVE_FAILED");
    expect(JSON.stringify(body)).not.toContain(key);
  });

  it("disconnects only this workspace's Google AI source, idempotently", async () => {
    const keep = [
      { id: "other", workspace_id: "other", type: "google_ai" },
      { id: "calendar", workspace_id: workspaceId, type: "google_calendar" },
    ];
    const db = database([
      ...keep,
      { id: "delete", workspace_id: workspaceId, type: "google_ai" },
    ]);
    expect((await DELETE(request(), context)).status).toBe(200);
    expect(db.rows).toEqual(keep);
    expect((await DELETE(request(), context)).status).toBe(200);
    expect(mockValidate).not.toHaveBeenCalled();
  });
});
