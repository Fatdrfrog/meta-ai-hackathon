const mockCreateClient = jest.fn();
const mockRequireWorkspaceMembership = jest.fn();
const mockSupabaseFrom = jest.fn();
const mockGetCompanyIdForWorkspace = jest.fn();
const mockFetch = jest.fn();

jest.mock("@/lib/supabase/server", () => ({
  createClient: (...args: unknown[]) => mockCreateClient(...args),
}));

jest.mock("@/lib/supabase/queries", () => ({
  ...jest.requireActual("@/lib/supabase/queries"),
  checkUserWorkspaceAccess: (...args: unknown[]) =>
    mockRequireWorkspaceMembership(...args),
}));

jest.mock("@/lib/supabase/company-users", () => ({
  getCompanyIdForWorkspace: (...args: unknown[]) =>
    mockGetCompanyIdForWorkspace(...args),
}));

jest.mock("@/lib/crypto", () => ({
  encryptString: (value: string) => ({ encrypted: value }),
}));

import { GET } from "./route";
import { NextRequest } from "next/server";

function requestWithCookies(url: string, cookies: Record<string, string>) {
  const cookieHeader = Object.entries(cookies)
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join("; ");
  return new NextRequest(url, {
    headers: {
      cookie: cookieHeader,
    },
  });
}

describe("GET /api/sources/google-calendar/callback", () => {
  const originalEnv = process.env;
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = {
      ...originalEnv,
      GOOGLE_AUTH_CLIENT_ID: "auth-client-id",
      GOOGLE_AUTH_CLIENT_SECRET: "auth-client-secret",
    };
    global.fetch = mockFetch as never;
    mockCreateClient.mockResolvedValue({
      auth: {
        getUser: jest.fn().mockResolvedValue({
          data: { user: { id: "user-1" } },
        }),
      },
      from: (...args: unknown[]) => mockSupabaseFrom(...args),
    });
    mockRequireWorkspaceMembership.mockResolvedValue(true);
    mockGetCompanyIdForWorkspace.mockResolvedValue("company-1");
  });

  afterEach(() => {
    process.env = originalEnv;
    global.fetch = originalFetch;
  });

  it("exchanges code, stores encrypted tokens, and redirects to Calendar integration", async () => {
    const sourceMaybeSingle = jest.fn().mockResolvedValue({ data: null });
    const insert = jest.fn().mockResolvedValue({ error: null });
    const update = jest.fn().mockResolvedValue({ error: null });
    const sourceBuilder = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      order: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      maybeSingle: sourceMaybeSingle,
      insert,
      update,
    };
    mockSupabaseFrom.mockReturnValue(sourceBuilder);
    mockFetch.mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({
        access_token: "access-token",
        refresh_token: "refresh-token",
        expires_in: 3600,
        scope:
          "https://www.googleapis.com/auth/calendar.freebusy https://www.googleapis.com/auth/calendar.events.owned",
        token_type: "Bearer",
      }),
    });

    const response = await GET(
      requestWithCookies(
        "https://www.airi.chat/api/sources/google-calendar/callback?code=code-1&state=state-1",
        {
          google_calendar_oauth_state: "state-1",
          google_calendar_oauth_workspace_id: "workspace-1",
          google_calendar_oauth_redirect_uri:
            "https://www.airi.chat/api/sources/google-calendar/callback",
        }
      )
    );

    expect(mockFetch).toHaveBeenCalledWith(
      "https://oauth2.googleapis.com/token",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: expect.any(URLSearchParams),
      })
    );
    const body = mockFetch.mock.calls[0][1].body as URLSearchParams;
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("code-1");
    expect(body.get("client_id")).toBe("auth-client-id");
    expect(body.get("client_secret")).toBe("auth-client-secret");
    expect(body.get("redirect_uri")).toBe(
      "https://www.airi.chat/api/sources/google-calendar/callback"
    );
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({
        company_id: "company-1",
        workspace_id: "workspace-1",
        type: "google_calendar",
        name: "Google Calendar",
        credentials: expect.objectContaining({
          access_token: { encrypted: "access-token" },
          refresh_token: { encrypted: "refresh-token" },
          scope:
            "https://www.googleapis.com/auth/calendar.freebusy https://www.googleapis.com/auth/calendar.events.owned",
          token_type: "Bearer",
          calendar_id: "primary",
        }),
      })
    );
    const location = response.headers.get("location") || "";
    expect(location).toContain("integration=google_calendar");
    expect(location).toContain("success=connected");
  });

  it("redirects when Google does not grant booking event-write scope", async () => {
    const sourceMaybeSingle = jest.fn().mockResolvedValue({ data: null });
    const insert = jest.fn().mockResolvedValue({ error: null });
    const sourceBuilder = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      order: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      maybeSingle: sourceMaybeSingle,
      insert,
    };
    mockSupabaseFrom.mockReturnValue(sourceBuilder);
    mockFetch.mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({
        access_token: "access-token",
        refresh_token: "refresh-token",
        expires_in: 3600,
        scope: "https://www.googleapis.com/auth/calendar.freebusy",
        token_type: "Bearer",
      }),
    });

    const response = await GET(
      requestWithCookies(
        "https://www.airi.chat/api/sources/google-calendar/callback?code=code-1&state=state-1",
        {
          google_calendar_oauth_state: "state-1",
          google_calendar_oauth_workspace_id: "workspace-1",
          google_calendar_oauth_redirect_uri:
            "https://www.airi.chat/api/sources/google-calendar/callback",
        }
      )
    );

    expect(insert).not.toHaveBeenCalled();
    const location = response.headers.get("location") || "";
    expect(location).toContain("integration=google_calendar");
    expect(location).toContain("error=booking_scope_denied");
  });

  it("rejects callback state mismatches without exchanging a token", async () => {
    const response = await GET(
      requestWithCookies(
        "https://www.airi.chat/api/sources/google-calendar/callback?code=code-1&state=bad-state",
        {
          google_calendar_oauth_state: "state-1",
          google_calendar_oauth_workspace_id: "workspace-1",
          google_calendar_oauth_redirect_uri:
            "https://www.airi.chat/api/sources/google-calendar/callback",
        }
      )
    );

    expect(mockFetch).not.toHaveBeenCalled();
    const location = response.headers.get("location") || "";
    expect(location).toContain("integration=google_calendar");
    expect(location).toContain("error=oauth_failed");
  });
});
