const mockCreateClient = jest.fn();
const mockConversation = jest.fn();
const mockInsert = jest.fn();
const mockCacheSet = jest.fn();
const mockCacheDel = jest.fn();
const mockTrigger = jest.fn();

jest.mock("@/lib/supabase/server", () => ({
  createClient: () => mockCreateClient(),
}));
jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: {
    from: () => ({ insert: (...args: unknown[]) => mockInsert(...args) }),
  },
}));
jest.mock("@/lib/mongoose", () => ({
  __esModule: true,
  default: jest.fn(async () => undefined),
}));
jest.mock("@/models/conversation", () => ({
  Conversation: {
    findById: (...args: unknown[]) => mockConversation(...args),
    findByIdAndUpdate: jest.fn(async () => undefined),
  },
}));
jest.mock("@/lib/cache", () => ({
  buildCacheKey: (prefix: string, parts: string[]) =>
    `${prefix}:${parts.join(":")}`,
  cache: {
    set: (...args: unknown[]) => mockCacheSet(...args),
    del: (...args: unknown[]) => mockCacheDel(...args),
  },
}));
jest.mock("@/lib/realtime/server", () => ({
  realtime: { trigger: (...args: unknown[]) => mockTrigger(...args) },
}));

import { NextRequest } from "next/server";
import { POST as event } from "./event/route";
import { POST as feedback } from "./feedback/route";
import {
  POST as revenue,
  GET as listRevenue,
} from "../revenue/attribute/route";

const conversationId = "507f1f77bcf86cd799439011";
let memberships: string[];
let resourceWorkspace: string | undefined;
let queries: Array<{ table: string; filters: Map<string, unknown> }>;

function readResource() {
  const value = { workspaceId: resourceWorkspace };
  const query = {
    select: jest.fn().mockReturnThis(),
    lean: jest.fn(async () => value),
    then: (resolve: (value: unknown) => unknown) =>
      Promise.resolve(value).then(resolve),
  };
  return query;
}

function request(url: string, body: Record<string, unknown>) {
  return new NextRequest(`http://localhost${url}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  memberships = ["workspace-1", "workspace-2"];
  resourceWorkspace = "workspace-2";
  queries = [];
  mockConversation.mockImplementation(readResource);
  mockInsert.mockResolvedValue({ error: null });
  mockCreateClient.mockResolvedValue({
    auth: {
      getUser: async () => ({
        data: { user: { id: "user-1", email: "teammate@example.com" } },
      }),
    },
    from: (table: string) => {
      const filters = new Map<string, unknown>();
      queries.push({ table, filters });
      const rows = () =>
        memberships
          .filter(
            id =>
              !filters.has("workspace_id") || id === filters.get("workspace_id")
          )
          .map(workspace_id => ({
            workspace_id,
            user_id: "user-1",
            email: "teammate@example.com",
          }));
      const single = async () =>
        table === "company_users"
          ? {
              data: rows().length === 1 ? rows()[0] : null,
              error: rows().length > 1 ? { code: "PGRST116" } : null,
            }
          : { data: { id: "attribution-1" }, error: null };
      const query = {
        select: jest.fn().mockReturnThis(),
        eq: jest.fn((key: string, value: unknown): object => {
          filters.set(key, value);
          return query;
        }),
        limit: jest.fn().mockReturnThis(),
        order: jest.fn().mockReturnThis(),
        insert: jest.fn((value: unknown): object => {
          mockInsert(value);
          return query;
        }),
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

const routes = [
  {
    name: "Airi event",
    run: () =>
      event(
        request("/api/airi/event", { type: "suggestion_shown", conversationId })
      ),
  },
  {
    name: "Airi feedback",
    run: () =>
      feedback(
        request("/api/airi/feedback", {
          suggestionId: "tip-1",
          conversationId,
          feedback: "helpful",
        })
      ),
  },
  {
    name: "revenue attribution",
    run: () =>
      revenue(
        request("/api/revenue/attribute", {
          conversationId,
          outcomeType: "upsell",
          revenueAmount: "12",
          confidence: "confirmed",
        })
      ),
  },
];

describe.each(routes)("$name resource workspace access", ({ run }) => {
  it("works in the resource's workspace with multiple company memberships", async () => {
    const response = await run();
    expect(response.status).toBe(200);
    expect(
      queries
        .find(query => query.table === "company_users")
        ?.filters.get("workspace_id")
    ).toBe("workspace-2");
  });

  it("rejects a forged resource belonging to an inaccessible workspace before writes", async () => {
    resourceWorkspace = "workspace-3";
    const response = await run();
    expect(response.status).toBe(403);
    expect(mockInsert).not.toHaveBeenCalled();
    expect(mockCacheSet).not.toHaveBeenCalled();
    expect(mockCacheDel).not.toHaveBeenCalled();
    expect(mockTrigger).not.toHaveBeenCalled();
  });

  it("fails closed when a resource has no owning workspace", async () => {
    resourceWorkspace = undefined;
    const response = await run();
    expect(response.status).toBe(404);
    expect(mockInsert).not.toHaveBeenCalled();
    expect(mockTrigger).not.toHaveBeenCalled();
  });
});

it("lists attribution for an explicit selected workspace with multiple memberships", async () => {
  const response = await listRevenue(
    new NextRequest(
      "http://localhost/api/revenue/attribute?workspaceId=workspace-2"
    )
  );
  expect(response.status).toBe(200);
  expect(
    queries
      .find(query => query.table === "revenue_attributions")
      ?.filters.get("workspace_id")
  ).toBe("workspace-2");
});

it("lists attribution using the conversation owner instead of the first membership", async () => {
  const response = await listRevenue(
    new NextRequest(
      `http://localhost/api/revenue/attribute?conversationId=${conversationId}`
    )
  );
  expect(response.status).toBe(200);
  expect(
    queries
      .find(query => query.table === "revenue_attributions")
      ?.filters.get("workspace_id")
  ).toBe("workspace-2");
});

it("rejects ambiguous attribution listing and retains the unique membership fallback", async () => {
  expect(
    (
      await listRevenue(
        new NextRequest("http://localhost/api/revenue/attribute")
      )
    ).status
  ).toBe(400);
  memberships = ["workspace-1"];
  expect(
    (
      await listRevenue(
        new NextRequest("http://localhost/api/revenue/attribute")
      )
    ).status
  ).toBe(200);
});

it("does not let a selected workspace relabel a conversation from another workspace", async () => {
  const response = await event(
    request("/api/airi/event", {
      type: "suggestion_shown",
      conversationId,
      workspaceId: "workspace-1",
    })
  );
  expect(response.status).toBe(403);
  expect(mockCacheSet).not.toHaveBeenCalled();
});

it.each(["suggestion_shown", "dismissed", "send_cleared"])(
  "acknowledges a %s coach event without writing the shared cache",
  async type => {
    const response = await event(
      request("/api/airi/event", { type, conversationId })
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(mockCacheSet).not.toHaveBeenCalled();
    expect(mockCacheDel).not.toHaveBeenCalled();
  }
);
