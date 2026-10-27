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
import { NextRequest } from "next/server";

describe("GET /api/sources/google-calendar/connect", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = {
      ...originalEnv,
      GOOGLE_AUTH_CLIENT_ID: "auth-client-id",
      NEXT_PUBLIC_APP_URL: "",
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

  it("starts OAuth with the shared Google auth client id", async () => {
    const response = await GET(
      new NextRequest(
        "http://localhost:3000/api/sources/google-calendar/connect?workspaceId=workspace-1"
      )
    );

    expect(response.status).toBe(307);
    const location = new URL(response.headers.get("location") || "");
    expect(location.origin).toBe("https://accounts.google.com");
    expect(location.searchParams.get("client_id")).toBe("auth-client-id");
    expect(location.searchParams.get("redirect_uri")).toBe(
      "http://localhost:3000/api/sources/google-calendar/callback"
    );
    expect(location.searchParams.get("scope")?.split(/\s+/).sort()).toEqual(
      [
        "https://www.googleapis.com/auth/calendar.freebusy",
        "https://www.googleapis.com/auth/calendar.events.owned",
      ].sort()
    );
    expect(location.searchParams.get("include_granted_scopes")).toBe("true");
    expect(location.searchParams.get("prompt")).toBe("consent");
  });
});
