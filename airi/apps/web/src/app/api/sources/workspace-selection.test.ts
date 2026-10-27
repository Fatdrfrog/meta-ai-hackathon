const mockCreateClient = jest.fn();
let mockCookieValues: Record<string, string> = {};

jest.mock("@/lib/supabase/server", () => ({
  createClient: () => mockCreateClient(),
}));
jest.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      mockCookieValues[name] ? { value: mockCookieValues[name] } : undefined,
  }),
}));
jest.mock("@/lib/crypto", () => ({ encryptString: (value: string) => value }));
jest.mock("@/lib/analytics", () => ({ trackSourceConnected: jest.fn() }));
jest.mock("@/lib/posthog/server", () => ({ flushServerPostHog: jest.fn() }));
jest.mock("@/lib/limits/company-limits", () => ({
  ensureCompanyChannelCapacity: async () => ({ allowed: true }),
}));
jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: { from: jest.fn() },
}));
jest.mock("@/lib/whatsapp/qr-code-service", () => ({
  getPhoneNumberDetails: async () => ({
    id: "phone-1",
    display_phone_number: "+15555550100",
    status: "CONNECTED",
  }),
}));

import { NextRequest } from "next/server";
import { GET as instagramConnect } from "./instagram/connect/route";
import { GET as facebookConnect } from "./instagram/connect-facebook/route";
import { GET as instagramCallback } from "./instagram/callback/route";
import { POST as facebookCallback } from "./instagram/facebook-callback/route";
import { POST as instagramSave } from "./instagram/route";
import { GET as legacyConnect } from "./whatsapp/connect/route";
import { GET as sourceList } from "../../sources/route";

let memberships: string[];
let queries: Array<{ table: string; filters: Map<string, unknown> }>;
const savedEnv = { ...process.env };
const savedFetch = global.fetch;

function post(path: string, body: Record<string, unknown>) {
  return new NextRequest(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  global.fetch = jest.fn(
    async () => new Response(JSON.stringify({ data: [] }), { status: 200 })
  );
  memberships = ["workspace-1", "workspace-2"];
  queries = [];
  mockCookieValues = {
    ig_oauth_state: "nonce:workspace-2",
    ig_fb_oauth_state: "nonce:workspace-2",
  };
  process.env.NEXT_PUBLIC_META_APP_ID = "app-1";
  process.env.INSTAGRAM_APP_SECRET = "secret-1";
  process.env.META_APP_SECRET = "secret-1";
  mockCreateClient.mockResolvedValue({
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) },
    from: (table: string) => {
      const filters = new Map<string, unknown>();
      queries.push({ table, filters });
      const rows = () =>
        memberships
          .filter(
            id =>
              !filters.has("workspace_id") || id === filters.get("workspace_id")
          )
          .map(workspace_id => ({ workspace_id, user_id: "user-1" }));
      const single = async () =>
        table === "company_users"
          ? {
              data: rows().length === 1 ? rows()[0] : null,
              error: rows().length > 1 ? { code: "PGRST116" } : null,
            }
          : { data: { company_id: "company-2" }, error: null };
      const query = {
        select: jest.fn().mockReturnThis(),
        eq: jest.fn((key: string, value: unknown): object => {
          filters.set(key, value);
          return query;
        }),
        limit: jest.fn().mockReturnThis(),
        order: jest.fn().mockReturnThis(),
        maybeSingle: single,
        single,
        then: (resolve: (value: unknown) => unknown) =>
          Promise.resolve({
            data: table === "company_users" ? rows() : [],
            error: null,
          }).then(resolve),
      };
      return query;
    },
  });
});
afterAll(() => {
  process.env = savedEnv;
  global.fetch = savedFetch;
});

describe.each([
  { name: "Instagram login", run: instagramConnect, cookie: "ig_oauth_state" },
  { name: "Facebook login", run: facebookConnect, cookie: "ig_fb_oauth_state" },
])("$name workspace selection", ({ run, cookie }) => {
  it("binds OAuth state to the selected second workspace", async () => {
    const response = await run(
      new Request("http://localhost/connect?workspaceId=workspace-2")
    );
    expect(response.status).toBe(307);
    const state = new URL(response.headers.get("location")!).searchParams.get(
      "state"
    );
    expect(state).toMatch(/:workspace-2$/);
    expect(response.headers.get("set-cookie")).toContain(`${cookie}=`);
    expect(queries[0]?.filters.get("workspace_id")).toBe("workspace-2");
  });
  it("rejects inaccessible and ambiguous workspaces before OAuth", async () => {
    expect(
      (
        await run(
          new Request("http://localhost/connect?workspaceId=workspace-3")
        )
      ).status
    ).toBe(403);
    expect((await run(new Request("http://localhost/connect"))).status).toBe(
      400
    );
  });
});

it("returns an Instagram denial to the workspace bound to matched state", async () => {
  const response = await instagramCallback(
    new Request(
      "http://localhost/callback?state=nonce%3Aworkspace-2&error=access_denied&workspaceId=workspace-1"
    )
  );
  expect(response.status).toBe(307);
  expect(response.headers.get("location")).toContain("/panel/w/workspace-2/");
  expect(
    queries
      .find(query => query.table === "company_users")
      ?.filters.get("workspace_id")
  ).toBe("workspace-2");
});

it("validates Instagram callback state before provider or workspace access", async () => {
  const response = await instagramCallback(
    new Request(
      "http://localhost/callback?state=forged%3Aworkspace-1&code=code-1"
    )
  );
  expect(response.status).toBe(400);
  expect(queries).toHaveLength(0);
});

it("binds Facebook callback to matched cookie state instead of supplied workspace", async () => {
  const response = await facebookCallback(
    post("/callback", {
      state: "nonce:workspace-2",
      workspaceId: "workspace-1",
    })
  );
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual(
    expect.objectContaining({
      error: "missing_access_token",
      workspaceId: "workspace-2",
    })
  );
  expect(
    queries
      .find(query => query.table === "company_users")
      ?.filters.get("workspace_id")
  ).toBe("workspace-2");
});

it("denies a callback when membership was revoked after OAuth started", async () => {
  memberships = ["workspace-1"];
  const response = await facebookCallback(
    post("/callback", { state: "nonce:workspace-2", access_token: "token" })
  );
  expect(response.status).toBe(403);
});

describe.each([
  {
    name: "manual Instagram",
    run: (workspaceId?: string) =>
      instagramSave(post("/api/sources/instagram", { workspaceId })),
    success: 400,
  },
  {
    name: "legacy WhatsApp launcher",
    run: (workspaceId?: string) =>
      legacyConnect(
        new Request(
          `http://localhost/connect${workspaceId ? `?workspaceId=${workspaceId}` : ""}`
        )
      ),
    success: 307,
  },
  {
    name: "source listing",
    run: (workspaceId?: string) =>
      sourceList(
        new Request(
          `http://localhost/sources${workspaceId ? `?workspaceId=${workspaceId}` : ""}`
        )
      ),
    success: 200,
  },
])("$name selected workspace", ({ run, success }) => {
  it("uses the selected workspace with multiple memberships", async () => {
    expect((await run("workspace-2")).status).toBe(success);
    expect(
      queries
        .find(query => query.table === "company_users")
        ?.filters.get("workspace_id")
    ).toBe("workspace-2");
  });
  it("rejects non-membership and requires selection for multi-workspace legacy calls", async () => {
    expect((await run("workspace-3")).status).toBe(403);
    expect((await run()).status).toBe(400);
  });
  it("retains unique-workspace legacy requests", async () => {
    memberships = ["workspace-2"];
    expect((await run()).status).toBe(success);
  });
});
