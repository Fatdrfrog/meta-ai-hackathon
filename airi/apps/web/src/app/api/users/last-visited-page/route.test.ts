const mockCreateClient = jest.fn();
const mockLoggerError = jest.fn();

jest.mock("@/lib/supabase/server", () => ({
  createClient: (...args: unknown[]) => mockCreateClient(...args),
}));

jest.mock("@/lib/logger", () => ({
  logger: {
    error: (...args: unknown[]) => mockLoggerError(...args),
  },
}));

import { POST } from "./route";

const workspaceId = "11111111-1111-4111-8111-111111111111";

function jsonRequest(body: unknown) {
  return new Request("http://localhost/api/users/last-visited-page", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }) as never;
}

function createMembershipQuery(data: unknown, error: unknown = null) {
  return {
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    maybeSingle: jest.fn().mockResolvedValue({ data, error }),
  };
}

describe("POST /api/users/last-visited-page", () => {
  const upsert = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();

    const membershipQuery = createMembershipQuery({ user_id: "user-1" });

    mockCreateClient.mockResolvedValue({
      auth: {
        getUser: jest.fn().mockResolvedValue({
          data: { user: { id: "user-1" } },
          error: null,
        }),
      },
      from: jest.fn((table: string) => {
        if (table === "company_users") return membershipQuery;
        if (table === "user_navigation_state") {
          return {
            upsert: upsert.mockResolvedValue({ error: null }),
          };
        }
        throw new Error(`Unexpected table: ${table}`);
      }),
    });
  });

  it("returns 401 when unauthenticated", async () => {
    mockCreateClient.mockResolvedValue({
      auth: {
        getUser: jest.fn().mockResolvedValue({
          data: { user: null },
          error: null,
        }),
      },
    });

    const response = await POST(
      jsonRequest({
        href: `https://airi.chat/panel/w/${workspaceId}/requests`,
      })
    );

    expect(response.status).toBe(401);
    expect(upsert).not.toHaveBeenCalled();
  });

  it("does not write invalid origins or paths", async () => {
    const response = await POST(
      jsonRequest({
        href: `https://evil.test/panel/w/${workspaceId}/requests`,
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      stored: false,
      reason: "invalid_origin",
    });
    expect(upsert).not.toHaveBeenCalled();
  });

  it("returns 403 when the user is not a workspace member", async () => {
    const membershipQuery = createMembershipQuery(null);
    mockCreateClient.mockResolvedValue({
      auth: {
        getUser: jest.fn().mockResolvedValue({
          data: { user: { id: "user-1" } },
          error: null,
        }),
      },
      from: jest.fn((table: string) => {
        if (table === "company_users") return membershipQuery;
        if (table === "user_navigation_state") return { upsert };
        throw new Error(`Unexpected table: ${table}`);
      }),
    });

    const response = await POST(
      jsonRequest({
        href: `https://airi.chat/panel/w/${workspaceId}/requests`,
      })
    );

    expect(response.status).toBe(403);
    expect(upsert).not.toHaveBeenCalled();
  });

  it("upserts normalized last visited state for valid member routes", async () => {
    const response = await POST(
      jsonRequest({
        href: `https://www.airi.chat/panel/w/${workspaceId}/requests?utm=x&conversation=c1&message=m2`,
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      stored: true,
      path: `/panel/w/${workspaceId}/requests?conversation=c1&message=m2`,
    });
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: "user-1",
        last_visited_path: `/panel/w/${workspaceId}/requests?conversation=c1&message=m2`,
        last_visited_workspace_id: workspaceId,
        last_visited_at: expect.any(String),
        updated_at: expect.any(String),
      }),
      { onConflict: "user_id" }
    );
  });

  it("accepts path payloads so localhost/dev sessions can persist navigation", async () => {
    const response = await POST(
      jsonRequest({
        path: `/panel/w/${workspaceId}/requests?conversation=c1&message=m2`,
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      stored: true,
      path: `/panel/w/${workspaceId}/requests?conversation=c1&message=m2`,
    });
  });
});
