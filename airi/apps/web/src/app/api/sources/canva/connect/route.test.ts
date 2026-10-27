const mockCreateClient = jest.fn();
const mockRequireWorkspaceMembership = jest.fn();

jest.mock("@/lib/supabase/server", () => ({
  createClient: (...args: unknown[]) => mockCreateClient(...args),
}));

jest.mock("@/lib/supabase/queries", () => ({
  ...jest.requireActual("@/lib/supabase/queries"),
  checkUserWorkspaceAccess: (...args: unknown[]) =>
    mockRequireWorkspaceMembership(...args),
}));

import { GET } from "./route";

describe("GET /api/sources/canva/connect", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = {
      ...originalEnv,
      CANVA_CLIENT_ID: "OC-test-client",
      CANVA_REDIRECT_URI: "https://www.airi.chat/api/sources/canva/callback",
      NODE_ENV: "test",
    };
    mockCreateClient.mockResolvedValue({
      auth: {
        getSession: async () => ({ data: { session: null } }),
        getUser: jest.fn().mockResolvedValue({
          data: { user: { id: "user-1" } },
        }),
      },
    });
    mockRequireWorkspaceMembership.mockResolvedValue(true);
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("redirects to Canva OAuth with server-generated PKCE and state", async () => {
    const response = await GET(
      new Request(
        "https://www.airi.chat/api/sources/canva/connect?workspaceId=workspace-1"
      ) as never
    );
    const location = response.headers.get("location");
    expect(location).toBeTruthy();

    const authUrl = new URL(location!);
    expect(authUrl.origin + authUrl.pathname).toBe(
      "https://www.canva.com/api/oauth/authorize"
    );
    expect(authUrl.searchParams.get("client_id")).toBe("OC-test-client");
    expect(authUrl.searchParams.get("redirect_uri")).toBe(
      "https://www.airi.chat/api/sources/canva/callback"
    );
    expect(authUrl.searchParams.get("response_type")).toBe("code");
    expect(authUrl.searchParams.get("scope")).toBe("brandtemplate:meta:read");
    expect(authUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authUrl.searchParams.get("code_challenge")).toMatch(
      /^[A-Za-z0-9_-]{43,128}$/
    );
    expect(authUrl.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]{24,}$/);

    const setCookie = response.headers.get("set-cookie") || "";
    expect(setCookie).toContain("canva_oauth_state=");
    expect(setCookie).toContain("canva_oauth_verifier=");
    expect(setCookie).toContain("canva_oauth_workspace_id=workspace-1");
    expect(setCookie).toContain(
      "canva_oauth_redirect_uri=https%3A%2F%2Fwww.airi.chat%2Fapi%2Fsources%2Fcanva%2Fcallback"
    );
    expect(setCookie).toContain("HttpOnly");
  });
});
