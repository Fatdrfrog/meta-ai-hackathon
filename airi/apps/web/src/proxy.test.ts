import { AuthClient } from "@supabase/supabase-js";
import { NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";
import middleware, {
  applyInternalRedirectPath,
  getLoginRedirectPath,
  getCanonicalPanelPathWithDecodedQuery,
  isCustomerKnowledgeBasePath,
} from "./proxy";

// Regression: customers' help centers (test workspaces, shop FAQs, an AI
// prompt) were indexed as airi.chat pages.
describe("customer knowledge bases on airi.chat", () => {
  const airiRequest = (path: string, host = "www.airi.chat") =>
    new NextRequest(`https://${host}${path}`, { headers: { host } });

  it.each(["/test12/kb", "/acme/kb/article-1", "/airichat-clone/kb/a"])(
    "keeps %s out of airi.chat search results",
    async path => {
      expect(isCustomerKnowledgeBasePath(path)).toBe(true);
      const response = await middleware(airiRequest(path));

      expect(response.headers.get("x-robots-tag")).toBe("noindex, follow");
    }
  );

  it.each(["/airichat/kb", "/airichat/kb/article-1", "/about", "/", "/kb-guide"])(
    "leaves %s indexable",
    async path => {
      expect(isCustomerKnowledgeBasePath(path)).toBe(false);
      const response = await middleware(airiRequest(path));

      expect(response.headers.get("x-robots-tag")).toBeNull();
    }
  );

  it("leaves a customer knowledge base path on another host to that host", async () => {
    const response = await middleware(airiRequest("/test12/kb", "help.example.com"));

    expect(response.headers.get("x-robots-tag")).toBeNull();
  });
});

// Regression: a ru-RU visitor got the English UI, ran Chrome's translator on
// it, and React crashed on the translated text ("This page couldn't load").
describe("browser language on app pages", () => {
  const RU = "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7";

  function browserRequest(
    path: string,
    {
      acceptLanguage = RU,
      cookie,
      clientRouter = false,
    }: { acceptLanguage?: string; cookie?: string; clientRouter?: boolean } = {}
  ) {
    // Fetch Metadata as Chrome sends it. Next strips its own `rsc` header
    // before the proxy runs, so router fetches carry only these.
    const headers: Record<string, string> = {
      host: "airi.chat",
      "accept-language": acceptLanguage,
      "sec-fetch-mode": clientRouter ? "cors" : "navigate",
      "sec-fetch-dest": clientRouter ? "empty" : "document",
    };
    if (cookie) headers.cookie = `NEXT_LOCALE=${cookie}`;
    return new NextRequest(`https://airi.chat${path}`, { headers });
  }

  it.each([
    "/login",
    "/login?tab=signup",
    "/setup",
    "/onboarding",
    "/auth/confirmed",
  ])("renders %s in the browser's language for the session", async path => {
    const response = await middleware(browserRequest(path));

    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(response.headers.get("x-middleware-request-cookie")).toContain(
      "NEXT_LOCALE=ru"
    );
    const cookie = response.cookies.get("NEXT_LOCALE");
    expect(cookie?.value).toBe("ru");
    expect(cookie?.maxAge).toBeUndefined();
  });

  it("maps a Kazakh browser to the kz interface", async () => {
    const response = await middleware(
      browserRequest("/login", { acceptLanguage: "kk-KZ,kk;q=0.9,ru;q=0.8" })
    );

    expect(response.cookies.get("NEXT_LOCALE")?.value).toBe("kz");
  });

  it.each(["/", "/about", "/whatsapp-marketing-delivery", "/airichat/kb"])(
    "leaves indexed public page %s on the default locale",
    async path => {
      const response = await middleware(browserRequest(path));

      expect(response.cookies.get("NEXT_LOCALE")).toBeUndefined();
      expect(response.headers.get("x-middleware-request-cookie")).toBeNull();
    }
  );

  it.each([
    ["an explicit choice", "en"],
    ["an earlier seed", "kz"],
  ])("never overrides %s", async (_label, cookie) => {
    const response = await middleware(browserRequest("/login", { cookie }));

    expect(response.cookies.get("NEXT_LOCALE")).toBeUndefined();
    expect(response.headers.get("x-middleware-request-cookie")).toBeNull();
  });

  it("replaces a cookie that is no longer an interface locale", async () => {
    const response = await middleware(
      browserRequest("/login", { cookie: "uz" })
    );

    expect(response.cookies.get("NEXT_LOCALE")?.value).toBe("ru");
  });

  it("sets nothing for English or unsupported browsers", async () => {
    for (const acceptLanguage of ["en-US,en;q=0.9", "de-DE,de;q=0.9"]) {
      const response = await middleware(
        browserRequest("/login", { acceptLanguage })
      );
      expect(response.cookies.get("NEXT_LOCALE")).toBeUndefined();
    }
  });

  it("turns a client-side navigation into a full page load before seeding", async () => {
    // The landing page's <Link> to /login keeps the English root layout; a
    // non-RSC answer makes Next's router reload the page instead.
    const response = await middleware(
      browserRequest("/login?tab=signup", { clientRouter: true })
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("content-type")).toBeNull();
    expect(response.cookies.get("NEXT_LOCALE")).toBeUndefined();
  });

  it("treats a request without Fetch Metadata as a page load", async () => {
    const response = await middleware(
      new NextRequest("https://airi.chat/login", {
        headers: { host: "airi.chat", "accept-language": RU },
      })
    );

    expect(response.status).toBe(200);
    expect(response.cookies.get("NEXT_LOCALE")?.value).toBe("ru");
  });

  it("lets client-side navigation through once the locale is set", async () => {
    const response = await middleware(
      browserRequest("/login", { cookie: "ru", clientRouter: true })
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });
});

describe("panel proxy redirect helpers", () => {
  it("keeps saved panel query strings in URL search", () => {
    const url = new URL("http://localhost:3000/panel");

    applyInternalRedirectPath(
      url,
      "/panel/w/41b51d55-697c-4455-875a-9a7238bdf272/requests?conversation=69c911ae76ef2996119dac84"
    );

    expect(url.pathname).toBe(
      "/panel/w/41b51d55-697c-4455-875a-9a7238bdf272/requests"
    );
    expect(url.search).toBe("?conversation=69c911ae76ef2996119dac84");
    expect(url.toString()).toBe(
      "http://localhost:3000/panel/w/41b51d55-697c-4455-875a-9a7238bdf272/requests?conversation=69c911ae76ef2996119dac84"
    );
  });

  it("canonicalizes panel paths where a saved query was encoded into pathname", () => {
    expect(
      getCanonicalPanelPathWithDecodedQuery(
        "/panel/w/41b51d55-697c-4455-875a-9a7238bdf272/requests%3Fconversation=69c911ae76ef2996119dac84"
      )
    ).toEqual({
      pathname: "/panel/w/41b51d55-697c-4455-875a-9a7238bdf272/requests",
      search: "?conversation=69c911ae76ef2996119dac84",
    });
  });

  it("ignores encoded query markers outside panel routes", () => {
    expect(getCanonicalPanelPathWithDecodedQuery("/login%3Fnext=/panel")).toBe(
      null
    );
  });

  it("preserves the protected destination when redirecting to login", () => {
    expect(
      getLoginRedirectPath("/panel/w/workspace-1/scenarios", "?tab=flows")
    ).toBe("/login?next=%2Fpanel%2Fw%2Fworkspace-1%2Fscenarios%3Ftab%3Dflows");
  });

  it("does not turn an invalid destination into an open redirect", () => {
    expect(getLoginRedirectPath("//evil.example")).toBe("/login");
  });
});

describe("panel proxy session verification", () => {
  const authCookie = "sb-fixture-auth-token";
  const workspaceId = "41b51d55-697c-4455-875a-9a7238bdf272";
  const requestsPath = `/panel/w/${workspaceId}/requests`;
  const user = {
    id: "verified-user",
    aud: "authenticated",
    role: "authenticated",
    email: "fixture@example.test",
    email_confirmed_at: "2026-01-01T00:00:00.000Z",
    created_at: "2026-01-01T00:00:00.000Z",
    app_metadata: { provider: "email", providers: ["email"] },
    user_metadata: {},
    identities: [],
  };
  const originalUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const originalKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  let membership: "allowed" | "denied" | "error";
  let rejectUser: boolean;
  let unavailableUserReads: number;
  let rejectRefresh: boolean;
  let getUser: jest.SpyInstance;
  let network: { url: URL; authorization: string | null }[];
  let rotatedSession: ReturnType<typeof session>;
  let onNavigationRead: (() => void) | undefined;
  let onUserRead: (() => void) | undefined;

  function session(expired = false) {
    const expiresAt = Math.floor(Date.now() / 1000) + (expired ? -60 : 3600);
    const encode = (value: unknown) =>
      Buffer.from(JSON.stringify(value)).toString("base64url");
    return {
      access_token: `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ sub: user.id, exp: expiresAt })}.fixture-signature`,
      refresh_token: expired ? "expired-session-refresh" : "rotated-refresh",
      expires_at: expiresAt,
      expires_in: 3600,
      token_type: "bearer",
      user,
    };
  }

  function request(
    path = requestsPath,
    auth: "valid" | "expired" | "none" = "valid"
  ) {
    const req = new NextRequest(`https://airi.chat${path}`, {
      headers: { host: "airi.chat", "x-user-id": "untrusted-user" },
    });
    if (auth !== "none") {
      req.cookies.set(
        authCookie,
        `base64-${Buffer.from(JSON.stringify(session(auth === "expired"))).toString("base64url")}`
      );
    }
    return req;
  }

  beforeEach(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fixture.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "sb_publishable_test_fixture_1234567890";
    membership = "allowed";
    rejectUser = false;
    unavailableUserReads = 0;
    rejectRefresh = false;
    network = [];
    rotatedSession = session();
    onNavigationRead = undefined;
    onUserRead = undefined;
    // Keep the real SDK, cookie adapter, proxy and session helper. Only the
    // Auth/PostgREST HTTP boundary is synthetic; the getUser spy calls through.
    getUser = jest.spyOn(AuthClient.prototype, "getUser");
    jest.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const outgoing = new Request(input, init);
      const url = new URL(outgoing.url);
      network.push({
        url,
        authorization: outgoing.headers.get("authorization"),
      });
      if (url.origin !== "https://fixture.supabase.co") {
        throw new Error(`Unexpected test network origin: ${url.origin}`);
      }
      if (url.pathname === "/auth/v1/user") {
        onUserRead?.();
        if (unavailableUserReads > 0) {
          unavailableUserReads -= 1;
          return Response.json(
            { message: "Service Unavailable" },
            { status: 503 }
          );
        }
        return rejectUser
          ? Response.json(
              { code: "bad_jwt", message: "Invalid JWT" },
              { status: 401 }
            )
          : Response.json(user);
      }
      if (url.pathname === "/auth/v1/token") {
        expect(url.searchParams.get("grant_type")).toBe("refresh_token");
        return rejectRefresh
          ? Response.json(
              {
                code: "refresh_token_not_found",
                message: "Invalid Refresh Token",
              },
              { status: 400 }
            )
          : Response.json(rotatedSession);
      }
      if (url.pathname === "/rest/v1/user_navigation_state") {
        onNavigationRead?.();
        return Response.json({
          last_visited_path: `${requestsPath}?conversation=synthetic-1`,
          last_visited_workspace_id: workspaceId,
        });
      }
      if (url.pathname === "/rest/v1/company_users") {
        if (membership === "error") {
          return Response.json(
            { code: "42501", message: "Permission denied" },
            { status: 403 }
          );
        }
        if (membership === "denied") return Response.json([]);
        return Response.json([{ user_id: user.id, workspace_id: workspaceId }]);
      }
      throw new Error(`Unexpected test endpoint: ${url.pathname}`);
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (originalUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    else process.env.NEXT_PUBLIC_SUPABASE_URL = originalUrl;
    if (originalKey === undefined)
      delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    else process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = originalKey;
  });

  it("verifies the panel request once and authorizes the verified user", async () => {
    const response = await middleware(request());

    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(getUser).toHaveBeenCalledTimes(1);
    expect(
      network.filter(call => call.url.pathname === "/auth/v1/user")
    ).toHaveLength(1);
    const access = network.find(
      call => call.url.pathname === "/rest/v1/company_users"
    );
    expect(access?.url.searchParams.get("user_id")).toBe("eq.verified-user");
    expect(access?.url.searchParams.get("workspace_id")).toBe(
      `eq.${workspaceId}`
    );
    expect(response.headers.get("cache-control")).toBeNull();
  });

  it("renders the panel in the browser's language alongside the session cookies", async () => {
    const valid = request();
    const req = new NextRequest(valid.url, {
      headers: {
        host: "airi.chat",
        "accept-language": "ru-RU,ru;q=0.9",
        cookie: valid.headers.get("cookie") ?? "",
      },
    });
    const response = await middleware(req);

    expect(response.headers.get("x-middleware-next")).toBe("1");
    const forwarded = response.headers.get("x-middleware-request-cookie");
    expect(forwarded).toContain("NEXT_LOCALE=ru");
    expect(forwarded).toContain(authCookie);
    expect(response.cookies.get("NEXT_LOCALE")?.value).toBe("ru");
  });

  it("keeps the seeded language on the redirect to login", async () => {
    rejectUser = true;
    const req = new NextRequest(`https://airi.chat${requestsPath}`, {
      headers: { host: "airi.chat", "accept-language": "ru-RU,ru;q=0.9" },
    });
    const response = await middleware(req);

    expect(response.headers.get("location")).toContain("/login?next=");
    expect(response.cookies.get("NEXT_LOCALE")?.value).toBe("ru");
  });

  it("forwards refreshed cookies and cache headers to the browser and downstream request", async () => {
    const req = request(requestsPath, "expired");
    const oldCookie = req.cookies.get(authCookie)?.value;
    const response = await middleware(req);

    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(getUser).toHaveBeenCalledTimes(1);
    expect(
      network.filter(call => call.url.pathname === "/auth/v1/token")
    ).toHaveLength(1);
    expect(response.cookies.get(authCookie)?.value).not.toBe(oldCookie);
    expect(response.cookies.get(authCookie)?.value).toBe(
      req.cookies.get(authCookie)?.value
    );
    expect(response.headers.get("x-middleware-request-cookie")).toContain(
      authCookie
    );
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("expires")).toBe("0");
    expect(response.headers.get("pragma")).toBe("no-cache");
    expect(
      network.find(call => call.url.pathname === "/rest/v1/company_users")
        ?.authorization
    ).toBe(`Bearer ${rotatedSession.access_token}`);
  });

  it.each(["denied", "error"] as const)(
    "keeps refreshed cookies and headers when workspace membership is %s",
    async outcome => {
      membership = outcome;
      const req = request(requestsPath, "expired");
      const response = await middleware(req);

      expect(response.headers.get("location")).toBe("https://airi.chat/panel");
      expect(getUser).toHaveBeenCalledTimes(1);
      expect(response.cookies.get(authCookie)?.value).toBe(
        req.cookies.get(authCookie)?.value
      );
      expect(response.headers.get("cache-control")).toContain("no-store");
      expect(response.headers.get("expires")).toBe("0");
      expect(response.headers.get("pragma")).toBe("no-cache");
    }
  );

  it.each(["none", "valid"] as const)(
    "redirects unauthenticated %s sessions without trusting identity headers",
    async auth => {
      rejectUser = true;
      const response = await middleware(
        request(`${requestsPath}?conversation=synthetic-1`, auth)
      );

      expect(response.headers.get("location")).toBe(
        `https://airi.chat/login?next=${encodeURIComponent(`${requestsPath}?conversation=synthetic-1`)}`
      );
      expect(getUser).toHaveBeenCalledTimes(1);
      expect(network.some(call => call.url.pathname.startsWith("/rest/"))).toBe(
        false
      );
    }
  );

  it("asks the auth server once more after a transient failure, then authorizes", async () => {
    unavailableUserReads = 1;
    const response = await middleware(request());

    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(getUser).toHaveBeenCalledTimes(2);
    expect(
      network.filter(call => call.url.pathname === "/rest/v1/company_users")
    ).toHaveLength(1);
  });

  it("sends a visitor to login after a second transient failure, without asking again", async () => {
    unavailableUserReads = 2;
    const response = await middleware(request());

    expect(response.headers.get("location")).toBe(
      `https://airi.chat/login?next=${encodeURIComponent(requestsPath)}`
    );
    expect(getUser).toHaveBeenCalledTimes(2);
    expect(network.some(call => call.url.pathname.startsWith("/rest/"))).toBe(
      false
    );
  });

  it("returns session-clearing cookies when an expired session cannot be refreshed", async () => {
    // The SDK logs this expected refresh failure while emitting initial state.
    jest.spyOn(console, "error").mockImplementation(error => {
      if (
        !(error instanceof Error) ||
        error.message !== "Invalid Refresh Token"
      ) {
        throw error;
      }
    });
    rejectRefresh = true;
    const response = await middleware(request(requestsPath, "expired"));

    expect(response.headers.get("location")).toBe(
      `https://airi.chat/login?next=${encodeURIComponent(requestsPath)}`
    );
    expect(response.cookies.get(authCookie)).toMatchObject({
      value: "",
      maxAge: 0,
    });
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(getUser).toHaveBeenCalledTimes(1);
  });

  it.each(["valid", "expired", "none"] as const)(
    "refreshes team API %s sessions without panel redirects or membership checks",
    async auth => {
      const response = await middleware(request("/api/team/invite", auth));

      expect(response.headers.get("x-middleware-next")).toBe("1");
      expect(response.headers.get("location")).toBeNull();
      expect(getUser).toHaveBeenCalledTimes(1);
      expect(network.some(call => call.url.pathname.startsWith("/rest/"))).toBe(
        false
      );
      if (auth === "expired") {
        expect(response.cookies.get(authCookie)?.value).toContain("base64-");
        expect(response.headers.get("cache-control")).toContain("no-store");
      }
    }
  );

  it.each(["/", "/login", "/acme/kb/article", "/api/requests"])(
    "skips session work for public path %s",
    async path => {
      const response = await middleware(request(path));
      expect(response.headers.get("x-middleware-next")).toBe("1");
      expect(getUser).not.toHaveBeenCalled();
      expect(network).toHaveLength(0);
    }
  );

  it("preserves canonical panel redirects and refreshed cookies", async () => {
    const response = await middleware(
      request(`${requestsPath}%3Fconversation=synthetic-1`, "expired")
    );
    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe(
      `https://airi.chat${requestsPath}?conversation=synthetic-1`
    );
    expect(response.cookies.get(authCookie)?.value).toContain("base64-");
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(getUser).toHaveBeenCalledTimes(1);
  });

  it("reuses the verified client for the saved panel entry destination", async () => {
    const response = await middleware(request("/panel", "expired"));
    expect(response.headers.get("location")).toBe(
      `https://airi.chat${requestsPath}?conversation=synthetic-1`
    );
    expect(response.cookies.get(authCookie)?.value).toContain("base64-");
    expect(getUser).toHaveBeenCalledTimes(1);
  });

  it("returns the latest cookies if panel entry queries refresh the session after verification", async () => {
    let now = Date.now();
    jest.spyOn(Date, "now").mockImplementation(() => now);
    const req = request("/panel");
    const originalCookie = req.cookies.get(authCookie)?.value;
    onNavigationRead = () => {
      // A slow first query lets the verified access token expire before the
      // membership query. The same client's SDK refreshes it for that query.
      now += 2 * 60 * 60 * 1000;
      rotatedSession = session();
    };

    const response = await middleware(req);

    expect(response.headers.get("location")).toBe(
      `https://airi.chat${requestsPath}?conversation=synthetic-1`
    );
    expect(response.cookies.get(authCookie)?.value).toBe(
      req.cookies.get(authCookie)?.value
    );
    expect(response.cookies.get(authCookie)?.value).not.toBe(originalCookie);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(getUser).toHaveBeenCalledTimes(1);
    expect(
      network.filter(call => call.url.pathname === "/auth/v1/token")
    ).toHaveLength(1);
  });

  it("keeps updateSession's response-only contract for existing callers", async () => {
    const response = await updateSession(request(requestsPath, "expired"));
    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(response.cookies.get(authCookie)?.value).toContain("base64-");
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(getUser).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["normal panel response", requestsPath, 200, false],
    ["panel entry redirect", "/panel", 307, false],
    ["panel response with old cookie chunks", requestsPath, 200, true],
  ] as const)(
    "retains the SDK's original cache headers after two refreshes for a %s",
    async (_scenario, path, status, chunked) => {
      let now = Date.now();
      jest.spyOn(Date, "now").mockImplementation(() => now);
      const req = request(path, "expired");
      if (chunked) {
        const originalCookie = req.cookies.get(authCookie)!.value;
        req.cookies.delete(authCookie);
        req.cookies.set(`${authCookie}.0`, originalCookie.slice(0, 60));
        req.cookies.set(`${authCookie}.1`, originalCookie.slice(60));
      }
      onUserRead = () => {
        // getUser has refreshed once. Expire that token before the panel's
        // next query so this same SDK client performs a second refresh.
        now += 2 * 60 * 60 * 1000;
        rotatedSession = session();
      };

      const response = await middleware(req);

      expect(response.status).toBe(status);
      expect(getUser).toHaveBeenCalledTimes(1);
      expect(
        network.filter(call => call.url.pathname === "/auth/v1/token")
      ).toHaveLength(2);
      const cookie = response.cookies.get(authCookie)?.value;
      expect(cookie).toBe(req.cookies.get(authCookie)?.value);
      expect(
        JSON.parse(
          Buffer.from(cookie!.slice("base64-".length), "base64url").toString()
        ).access_token
      ).toBe(rotatedSession.access_token);
      if (chunked) {
        expect(response.cookies.get(`${authCookie}.0`)).toMatchObject({
          value: "",
          maxAge: 0,
        });
        expect(response.cookies.get(`${authCookie}.1`)).toMatchObject({
          value: "",
          maxAge: 0,
        });
      }
      expect(response.headers.get("cache-control")).toBe(
        "private, no-cache, no-store, must-revalidate, max-age=0"
      );
      expect(response.headers.get("expires")).toBe("0");
      expect(response.headers.get("pragma")).toBe("no-cache");
    }
  );
});
