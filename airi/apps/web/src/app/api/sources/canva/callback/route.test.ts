const mockCreateClient = jest.fn();
const mockRequireWorkspaceMembership = jest.fn();
const mockFetch = jest.fn();
const mockSupabaseAdminFrom = jest.fn();

jest.mock("@/lib/supabase/server", () => ({
  createClient: (...args: unknown[]) => mockCreateClient(...args),
}));

jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: {
    from: (...args: unknown[]) => mockSupabaseAdminFrom(...args),
  },
}));

jest.mock("@/lib/supabase/queries", () => ({
  ...jest.requireActual("@/lib/supabase/queries"),
  checkUserWorkspaceAccess: (...args: unknown[]) =>
    mockRequireWorkspaceMembership(...args),
}));

jest.mock("@/lib/crypto", () => ({
  encryptString: (value: string) => ({ encrypted: value }),
}));

import { GET } from "./route";
import { NextRequest } from "next/server";
import { supabaseAuth } from "@/test-support/supabase-auth-test-utils";

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

describe("GET /api/sources/canva/callback", () => {
  const originalEnv = process.env;
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = {
      ...originalEnv,
      CANVA_CLIENT_ID: "OC-test-client",
      CANVA_CLIENT_SECRET: "cnvca-test-secret",
    };
    global.fetch = mockFetch as never;
    mockCreateClient.mockResolvedValue({
      auth: supabaseAuth(),
      from: jest.fn(),
    });
    mockRequireWorkspaceMembership.mockResolvedValue(true);
  });

  afterEach(() => {
    process.env = originalEnv;
    global.fetch = originalFetch;
  });

  it("rejects callbacks that lost the stored redirect URI", async () => {
    const response = await GET(
      requestWithCookies(
        "https://www.airi.chat/api/sources/canva/callback?code=code-1&state=state-1",
        {
          canva_oauth_state: "state-1",
          canva_oauth_verifier: "verifier-1",
          canva_oauth_workspace_id: "workspace-1",
        }
      )
    );

    expect(mockFetch).not.toHaveBeenCalled();
    const location = response.headers.get("location") || "";
    expect(location).toContain("integration=canva");
    expect(location).toContain("error=oauth_failed");
  });

  it("exchanges the authorization code with Basic auth and the original redirect URI", async () => {
    const adminInsert = jest.fn().mockResolvedValue({ error: null });
    const adminUpdate = jest.fn().mockResolvedValue({ error: null });
    const adminSourceMaybeSingle = jest.fn().mockResolvedValue({ data: null });
    const companyUserMaybeSingle = jest.fn().mockResolvedValue({
      data: { workspace_id: "workspace-1" },
    });
    const workspaceMaybeSingle = jest.fn().mockResolvedValue({
      data: { company_id: "company-1" },
    });
    const adminSourceBuilder = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      order: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      maybeSingle: adminSourceMaybeSingle,
      update: adminUpdate,
      insert: adminInsert,
    };
    const sourceBuilder = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      order: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({ data: null }),
      update: jest.fn().mockResolvedValue({ error: null }),
      insert: jest.fn().mockResolvedValue({ error: null }),
    };
    const companyUserBuilder = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: companyUserMaybeSingle,
    };
    const workspaceBuilder = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: workspaceMaybeSingle,
    };
    const from = jest.fn((table: string) =>
      table === "company_users"
        ? companyUserBuilder
        : table === "workspaces"
          ? workspaceBuilder
          : sourceBuilder
    );
    mockSupabaseAdminFrom.mockImplementation((table: string) =>
      table === "sources" ? adminSourceBuilder : sourceBuilder
    );
    mockCreateClient.mockResolvedValue({
      auth: supabaseAuth(),
      from,
    });
    mockFetch.mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({
        access_token: "access-token-1",
        refresh_token: "refresh-token-1",
        expires_in: 14400,
        scope: "brandtemplate:meta:read",
        token_type: "Bearer",
      }),
    });

    const response = await GET(
      requestWithCookies(
        "https://www.airi.chat/api/sources/canva/callback?code=code-1&state=state-1",
        {
          canva_oauth_state: "state-1",
          canva_oauth_verifier: "verifier-1",
          canva_oauth_workspace_id: "workspace-1",
          canva_oauth_redirect_uri:
            "https://www.airi.chat/api/sources/canva/callback",
        }
      )
    );

    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.canva.com/rest/v1/oauth/token",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization:
            "Basic " +
            Buffer.from("OC-test-client:cnvca-test-secret").toString("base64"),
          "Content-Type": "application/x-www-form-urlencoded",
        }),
        body: expect.any(URLSearchParams),
      })
    );
    const body = mockFetch.mock.calls[0][1].body as URLSearchParams;
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("code-1");
    expect(body.get("code_verifier")).toBe("verifier-1");
    expect(body.get("redirect_uri")).toBe(
      "https://www.airi.chat/api/sources/canva/callback"
    );
    expect(from).not.toHaveBeenCalledWith("sources");
    expect(adminInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        company_id: "company-1",
        workspace_id: "workspace-1",
        type: "canva",
        credentials: expect.objectContaining({
          access_token: { encrypted: "access-token-1" },
          refresh_token: { encrypted: "refresh-token-1" },
          scope: "brandtemplate:meta:read",
          token_type: "Bearer",
        }),
      })
    );
    expect(response.headers.get("location")).toContain("success=connected");
  });
});
