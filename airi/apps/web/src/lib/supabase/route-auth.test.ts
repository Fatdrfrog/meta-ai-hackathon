const mockBearerGetUser = jest.fn();
const mockCookieGetUser = jest.fn();
const mockSupabaseJsCreateClient = jest.fn(
  (_url: string, _key: string, _options: unknown) => ({
    auth: {
      getUser: mockBearerGetUser,
    },
  })
);
const mockCookieCreateClient = jest.fn(async () => ({
  auth: {
    getUser: mockCookieGetUser,
  },
}));

jest.mock("@supabase/supabase-js", () => ({
  createClient: (url: string, key: string, options: unknown) =>
    mockSupabaseJsCreateClient(url, key, options),
}));

jest.mock("./server", () => ({
  createClient: () => mockCookieCreateClient(),
}));

import { getSupabaseRouteAuth, isSupabaseRouteAuthError } from "./route-auth";

describe("getSupabaseRouteAuth", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "sb_publishable_test_fixture_1234567890";
  });

  it("authenticates bearer requests with a token-scoped Supabase client", async () => {
    mockBearerGetUser.mockResolvedValue({
      data: { user: { id: "user-1", email: "user@example.com" } },
      error: null,
    });

    const result = await getSupabaseRouteAuth(
      new Request("http://localhost/api/test", {
        headers: { Authorization: "Bearer access-token" },
      })
    );

    expect(isSupabaseRouteAuthError(result)).toBe(false);
    if (isSupabaseRouteAuthError(result)) return;
    expect(result.authType).toBe("bearer");
    expect(result.user.id).toBe("user-1");
    expect(mockBearerGetUser).toHaveBeenCalledWith("access-token");
    expect(mockSupabaseJsCreateClient).toHaveBeenCalledWith(
      "https://example.supabase.co",
      "sb_publishable_test_fixture_1234567890",
      expect.objectContaining({
        global: {
          headers: {
            Authorization: "Bearer access-token",
          },
        },
      })
    );
    expect(mockCookieCreateClient).not.toHaveBeenCalled();
  });

  it("falls back to the cookie Supabase client when no bearer token is present", async () => {
    mockCookieGetUser.mockResolvedValue({
      data: { user: { id: "cookie-user" } },
      error: null,
    });

    const result = await getSupabaseRouteAuth(
      new Request("http://localhost/api/test")
    );

    expect(isSupabaseRouteAuthError(result)).toBe(false);
    if (isSupabaseRouteAuthError(result)) return;
    expect(result.authType).toBe("cookie");
    expect(result.user.id).toBe("cookie-user");
    expect(mockCookieCreateClient).toHaveBeenCalledTimes(1);
    expect(mockSupabaseJsCreateClient).not.toHaveBeenCalled();
  });

  it("rejects invalid bearer tokens without falling back to cookies", async () => {
    mockBearerGetUser.mockResolvedValue({
      data: { user: null },
      error: new Error("invalid jwt"),
    });

    const result = await getSupabaseRouteAuth(
      new Request("http://localhost/api/test", {
        headers: { Authorization: "Bearer bad-token" },
      })
    );

    expect(isSupabaseRouteAuthError(result)).toBe(true);
    expect(mockCookieCreateClient).not.toHaveBeenCalled();
  });

  it("rejects a privileged public key before constructing a bearer client", async () => {
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "sb_secret_private_fixture";
    await expect(getSupabaseRouteAuth(new Request("http://localhost/api/test", {
      headers: { Authorization: "Bearer access-token" },
    }))).rejects.toThrow("legacy anon JWT");
    expect(mockSupabaseJsCreateClient).not.toHaveBeenCalled();
    expect(mockBearerGetUser).not.toHaveBeenCalled();
  });
});
