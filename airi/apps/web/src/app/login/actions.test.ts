import { login, resendSignupConfirmation, signup } from "./actions";

const createClientMock = jest.fn();
const checkRateLimitMock = jest.fn();
const redirectMock = jest.fn((path: string, type?: string) => {
  throw Object.assign(new Error("NEXT_REDIRECT"), { path, type });
});
const getPanelEntryRedirectPathMock = jest.fn();
const getWorkspaceIdFromPanelPathMock = jest.fn();

jest.mock("@/lib/supabase/server", () => ({
  createClient: () => createClientMock(),
}));

jest.mock("@icecore/shared/lib/rate-limiter", () => ({
  createRateLimiter: () => null,
  checkRateLimit: (...args: unknown[]) => checkRateLimitMock(...args),
  rateLimitPresets: { auth: {} },
}));

jest.mock("next/headers", () => ({
  headers: () =>
    Promise.resolve({
      get: (name: string) => {
        const values: Record<string, string> = {
          host: "localhost:3000",
        };
        return values[name] ?? null;
      },
    }),
}));

jest.mock("next/navigation", () => ({
  RedirectType: { push: "push", replace: "replace" },
  redirect: (path: string, type?: string) => redirectMock(path, type),
}));

jest.mock("@/features/panel/shared/routing", () => ({
  getPanelEntryRedirectPath: (...args: unknown[]) =>
    getPanelEntryRedirectPathMock(...args),
  getWorkspaceIdFromPanelPath: (path: string) =>
    getWorkspaceIdFromPanelPathMock(path),
}));

jest.mock("@/lib/analytics", () => ({
  trackUserSignIn: jest.fn(),
}));

const captureFunnelEventMock = jest.fn();
jest.mock("@/lib/funnel-analytics", () => ({
  captureFunnelEvent: (...args: unknown[]) => captureFunnelEventMock(...args),
}));

jest.mock("@/lib/tracking-consent-server", () => ({
  readServerTrackingConsent: async () => "pending",
}));

jest.mock("@/lib/auth/account-merge", () => ({
  getAccountMergeRedirectPath: jest.fn(),
}));

jest.mock("@/lib/auth/invite-metadata", () => ({
  hasPendingInviteMetadata: jest.fn(),
}));

jest.mock("@/lib/supabase/company-users", () => ({
  getCompanyIdForWorkspace: jest.fn(),
}));

function createSignupForm(email = "founder@example.com") {
  const formData = new FormData();
  formData.set("email", email);
  formData.set("password", "password123");
  return formData;
}

let dateNowSpy: jest.SpyInstance<number, []> | undefined;

// Pins the sign-in attempt marker (Date.now in base 36).
function mockNow(now: number) {
  dateNowSpy?.mockRestore();
  dateNowSpy = jest.spyOn(Date, "now").mockReturnValue(now);
}

beforeEach(() => {
  jest.clearAllMocks();
  checkRateLimitMock.mockReset().mockResolvedValue({ success: true });
  getPanelEntryRedirectPathMock.mockResolvedValue("/panel/w/ws_1/airi");
  getWorkspaceIdFromPanelPathMock.mockReturnValue("ws_1");
});

afterEach(() => {
  dateNowSpy?.mockRestore();
  dateNowSpy = undefined;
});

describe("login", () => {
  it("returns to the protected destination after password re-authentication", async () => {
    const user = {
      id: "user-1",
      email: "founder@example.com",
      user_metadata: {},
    };
    const signInWithPasswordMock = jest.fn().mockResolvedValue({ error: null });
    const getUserMock = jest.fn().mockResolvedValue({ data: { user } });
    const supabase = {
      auth: {
        signInWithPassword: signInWithPasswordMock,
        getUser: getUserMock,
      },
    };
    createClientMock.mockResolvedValue(supabase);

    const formData = createSignupForm();
    formData.set("next", "/panel/w/ws_1/scenarios?tab=flows");

    await expect(login(formData)).rejects.toMatchObject({
      path: "/panel/w/ws_1/scenarios?tab=flows",
    });

    expect(signInWithPasswordMock).toHaveBeenCalledWith({
      email: "founder@example.com",
      password: "password123",
    });
    expect(getUserMock).toHaveBeenCalledTimes(1);
    expect(signInWithPasswordMock.mock.invocationCallOrder[0]).toBeLessThan(
      getUserMock.mock.invocationCallOrder[0]
    );
    expect(getPanelEntryRedirectPathMock).toHaveBeenCalledWith(supabase, user);
  });

  it("does not route into the panel when sign-in produces no authenticated user", async () => {
    mockNow(1_000_000);
    const signInWithPasswordMock = jest.fn().mockResolvedValue({ error: null });
    const getUserMock = jest.fn().mockResolvedValue({ data: { user: null } });
    createClientMock.mockResolvedValue({
      auth: {
        signInWithPassword: signInWithPasswordMock,
        getUser: getUserMock,
      },
    });

    await expect(login(createSignupForm())).rejects.toMatchObject({
      path: "/login?error=unknown&attempt=lfls",
      type: "replace",
    });

    expect(signInWithPasswordMock).toHaveBeenCalledWith({
      email: "founder@example.com",
      password: "password123",
    });
    expect(getUserMock).toHaveBeenCalledTimes(1);
    expect(getPanelEntryRedirectPathMock).not.toHaveBeenCalled();
  });

  describe("when Supabase rejects the password sign-in", () => {
    function mockSignInError(error: {
      code?: string;
      status?: number;
      message: string;
    }) {
      const getUserMock = jest.fn();
      createClientMock.mockResolvedValue({
        auth: {
          signInWithPassword: jest.fn().mockResolvedValue({ error }),
          getUser: getUserMock,
        },
      });
      return { getUserMock };
    }

    const invalidCredentials = {
      code: "invalid_credentials",
      status: 400,
      message: "Invalid login credentials",
    };

    it("sends a translated error code instead of Supabase's English message", async () => {
      mockNow(1_000_000);
      const { getUserMock } = mockSignInError(invalidCredentials);

      await expect(login(createSignupForm())).rejects.toMatchObject({
        path: "/login?error=invalid_credentials&attempt=lfls",
        type: "replace",
      });

      expect(getUserMock).not.toHaveBeenCalled();
      expect(getPanelEntryRedirectPathMock).not.toHaveBeenCalled();
    });

    it("marks every failed attempt so a repeat failure lands on a new URL", async () => {
      mockSignInError(invalidCredentials);
      const attemptOf = async (now: number) => {
        mockNow(now);
        const redirected = await login(createSignupForm()).catch(
          (error: { path: string }) => error.path
        );
        return new URLSearchParams(String(redirected).split("?")[1]).get(
          "attempt"
        );
      };

      const firstAttempt = await attemptOf(1_000_000);
      const secondAttempt = await attemptOf(1_004_000);

      expect(firstAttempt).toBeTruthy();
      expect(secondAttempt).toBeTruthy();
      expect(secondAttempt).not.toBe(firstAttempt);
    });

    it("keeps the invite and return path through a failed sign-in", async () => {
      mockNow(1_000_000);
      mockSignInError(invalidCredentials);

      const formData = createSignupForm("client@example.com");
      formData.set("invite_token", "invite_1");
      formData.set("next", "/panel/w/ws_1/kb");

      await expect(login(formData)).rejects.toMatchObject({
        path: "/login?error=invalid_credentials&attempt=lfls&invite_token=invite_1&email=client%40example.com&next=%2Fpanel%2Fw%2Fws_1%2Fkb",
      });
    });

    it("sends an unconfirmed email to the resend step instead of a sign-in error", async () => {
      mockSignInError({
        code: "email_not_confirmed",
        status: 400,
        message: "Email not confirmed",
      });

      await expect(
        login(createSignupForm("new@example.com"))
      ).rejects.toMatchObject({
        path: "/login?tab=signup&signup=email_not_confirmed&email=new%40example.com",
        type: "replace",
      });
    });

    it("reports Supabase's sign-in rate limit as its own code", async () => {
      mockNow(1_000_000);
      mockSignInError({
        code: "over_request_rate_limit",
        status: 429,
        message: "Request rate limit reached",
      });

      await expect(login(createSignupForm())).rejects.toMatchObject({
        path: "/login?error=rate_limited&attempt=lfls",
      });
    });

    it("falls back to a generic code when Supabase is unreachable", async () => {
      mockNow(1_000_000);
      mockSignInError({ status: 0, message: "fetch failed" });

      await expect(login(createSignupForm())).rejects.toMatchObject({
        path: "/login?error=unknown&attempt=lfls",
      });
    });
  });
});

describe("signup", () => {
  it("routes Supabase's obfuscated existing-account signup response back to sign-in", async () => {
    const signUpMock = jest.fn().mockResolvedValue({
      data: {
        user: {
          email: "founder@example.com",
          identities: [],
        },
        session: null,
      },
      error: null,
    });
    createClientMock.mockResolvedValue({
      auth: {
        signUp: signUpMock,
      },
    });

    await expect(signup(createSignupForm())).rejects.toMatchObject({
      path: "/login?signup=existing&email=founder%40example.com",
    });

    expect(signUpMock).toHaveBeenCalledWith({
      email: "founder@example.com",
      password: "password123",
      options: {
        emailRedirectTo: "http://localhost:3000/auth/callback",
      },
    });
  });

  it("keeps real new signups on the pending verification screen", async () => {
    createClientMock.mockResolvedValue({
      auth: {
        signUp: jest.fn().mockResolvedValue({
          data: {
            user: {
              email: "new@example.com",
              identities: [{ id: "identity-1" }],
            },
            session: null,
          },
          error: null,
        }),
      },
    });

    await expect(
      signup(createSignupForm("new@example.com"))
    ).rejects.toMatchObject({
      path: "/login?tab=signup&signup=pending&email=new%40example.com&message=Check+email+to+continue+sign+in+process",
    });
  });

  it("counts a new signup as an account created, and only a new one", async () => {
    const signUpMock = jest.fn().mockResolvedValueOnce({
      data: {
        user: {
          id: "user-new",
          email: "new@example.com",
          identities: [{ id: "identity-1" }],
        },
        session: null,
      },
      error: null,
    });
    createClientMock.mockResolvedValue({ auth: { signUp: signUpMock } });

    await expect(
      signup(createSignupForm("new@example.com"))
    ).rejects.toMatchObject({ path: expect.stringContaining("signup=pending") });
    expect(captureFunnelEventMock).toHaveBeenCalledWith({
      event: "account_created",
      userId: "user-new",
      properties: { method: "email", invited: false },
      insertId: "account_created:user-new",
    });

    captureFunnelEventMock.mockClear();
    signUpMock.mockResolvedValueOnce({
      data: {
        user: { id: "user-old", email: "old@example.com", identities: [] },
        session: null,
      },
      error: null,
    });
    await expect(
      signup(createSignupForm("old@example.com"))
    ).rejects.toMatchObject({ path: expect.stringContaining("signup=existing") });
    expect(captureFunnelEventMock).not.toHaveBeenCalled();
  });

  it("continues immediately when Supabase returns an autoconfirmed session", async () => {
    createClientMock.mockResolvedValue({
      auth: {
        signUp: jest.fn().mockResolvedValue({
          data: {
            user: {
              email: "new@example.com",
              identities: [{ id: "identity-1" }],
            },
            session: { access_token: "token" },
          },
          error: null,
        }),
      },
    });

    await expect(
      signup(createSignupForm("new@example.com"))
    ).rejects.toMatchObject({
      path: "/onboarding",
    });
  });

  it("sends an invited account's signup to the emailed link instead of password sign-in", async () => {
    // For an invited, unconfirmed account Supabase keeps the real account,
    // empties identities, drops the new password and only resends the email.
    createClientMock.mockResolvedValue({
      auth: {
        signUp: jest.fn().mockResolvedValue({
          data: {
            user: {
              email: "client@example.com",
              identities: [],
              created_at: "2026-09-28T11:36:29.784695Z",
              invited_at: "2026-09-28T11:52:30.322015Z",
              confirmation_sent_at: "2026-09-28T13:31:44.5231Z",
            },
            session: null,
          },
          error: null,
        }),
      },
    });

    const formData = createSignupForm("client@example.com");
    formData.set("invite_token", "invite_1");

    await expect(signup(formData)).rejects.toMatchObject({
      path: "/login?tab=signup&signup=unconfirmed&email=client%40example.com&invite_token=invite_1",
    });
  });

  it("treats a repeated signup for an unfinished account as unconfirmed", async () => {
    createClientMock.mockResolvedValue({
      auth: {
        signUp: jest.fn().mockResolvedValue({
          data: {
            user: {
              email: "new@example.com",
              identities: [{ id: "identity-1" }],
              created_at: "2026-09-28T10:00:00Z",
              confirmation_sent_at: "2026-09-28T10:05:00Z",
            },
            session: null,
          },
          error: null,
        }),
      },
    });

    await expect(
      signup(createSignupForm("new@example.com"))
    ).rejects.toMatchObject({
      path: "/login?tab=signup&signup=unconfirmed&email=new%40example.com",
    });
  });

  it("keeps the obfuscated confirmed-account response on sign-in even for a once-invited account", async () => {
    const stampedAt = "2026-09-28T13:31:44.5231Z";
    createClientMock.mockResolvedValue({
      auth: {
        signUp: jest.fn().mockResolvedValue({
          data: {
            user: {
              email: "founder@example.com",
              identities: [],
              created_at: stampedAt,
              confirmation_sent_at: stampedAt,
              invited_at: "2026-05-01T07:42:56Z",
            },
            session: null,
          },
          error: null,
        }),
      },
    });

    await expect(signup(createSignupForm())).rejects.toMatchObject({
      path: "/login?signup=existing&email=founder%40example.com",
    });
  });

  it("keeps a brand-new signup pending when the email goes out in the same request", async () => {
    createClientMock.mockResolvedValue({
      auth: {
        signUp: jest.fn().mockResolvedValue({
          data: {
            user: {
              email: "new@example.com",
              identities: [{ id: "identity-1" }],
              created_at: "2026-09-28T13:31:44.100Z",
              confirmation_sent_at: "2026-09-28T13:31:45.300Z",
            },
            session: null,
          },
          error: null,
        }),
      },
    });

    await expect(
      signup(createSignupForm("new@example.com"))
    ).rejects.toMatchObject({
      path: "/login?tab=signup&signup=pending&email=new%40example.com&message=Check+email+to+continue+sign+in+process",
    });
  });

  it("shows the inbox step instead of Supabase's raw email cooldown error", async () => {
    createClientMock.mockResolvedValue({
      auth: {
        signUp: jest.fn().mockResolvedValue({
          data: { user: null, session: null },
          error: {
            code: "over_email_send_rate_limit",
            status: 429,
            message:
              "For security purposes, you can only request this after 31 seconds.",
          },
        }),
      },
    });

    const formData = createSignupForm("client@example.com");
    formData.set("invite_token", "invite_1");

    await expect(signup(formData)).rejects.toMatchObject({
      path: "/login?tab=signup&signup=recently_sent&email=client%40example.com&retry_after=31&invite_token=invite_1",
    });
  });

  it("keeps the typed email when Supabase rejects the signup", async () => {
    mockNow(1_000_000);
    createClientMock.mockResolvedValue({
      auth: {
        signUp: jest.fn().mockResolvedValue({
          data: { user: null, session: null },
          error: {
            code: "weak_password",
            status: 422,
            message: "Password should be at least 6 characters.",
          },
        }),
      },
    });

    await expect(signup(createSignupForm())).rejects.toMatchObject({
      path: "/login?tab=signup&signup_error=weak_password&attempt=lfls&email=founder%40example.com",
      type: "replace",
    });
  });

  it("preserves the invalid email, invite and safe destination without calling Auth", async () => {
    mockNow(1_000_000);
    const formData = createSignupForm("  invalid-address  ");
    formData.set("invite_token", "invite_1");
    formData.set("next", "/panel/w/ws_1/kb");

    await expect(signup(formData)).rejects.toMatchObject({
      path: "/login?tab=signup&signup_error=invalid_email&attempt=lfls&email=invalid-address&invite_token=invite_1&next=%2Fpanel%2Fw%2Fws_1%2Fkb",
    });
    expect(createClientMock).not.toHaveBeenCalled();
  });

  it("preserves the email when the application rate limiter rejects a signup", async () => {
    mockNow(1_000_000);
    checkRateLimitMock.mockResolvedValue({ success: false });

    await expect(signup(createSignupForm())).rejects.toMatchObject({
      path: "/login?tab=signup&signup_error=rate_limited&attempt=lfls&email=founder%40example.com",
    });
    expect(createClientMock).not.toHaveBeenCalled();
  });

  it.each([
    [
      { code: "email_address_invalid", message: "provider email detail" },
      "invalid_email",
    ],
    [
      {
        code: "over_request_rate_limit",
        status: 429,
        message: "provider rate detail",
      },
      "rate_limited",
    ],
    [
      { code: "signup_disabled", message: "provider signup detail" },
      "signup_disabled",
    ],
    [
      {
        code: "unexpected_failure",
        status: 500,
        message: "private database detail",
      },
      "unknown",
    ],
  ])(
    "returns only a safe code for provider failure %j",
    async (error, errorCode) => {
      mockNow(1_000_000);
      createClientMock.mockResolvedValue({
        auth: {
          signUp: jest
            .fn()
            .mockResolvedValue({ data: { user: null, session: null }, error }),
        },
      });
      const formData = createSignupForm("  client@example.com  ");
      formData.set("invite_token", "invite_1");
      formData.set("next", "/panel/w/ws_1/kb");

      await expect(signup(formData)).rejects.toMatchObject({
        path: `/login?tab=signup&signup_error=${errorCode}&attempt=lfls&email=client%40example.com&invite_token=invite_1&next=%2Fpanel%2Fw%2Fws_1%2Fkb`,
      });
    }
  );

  it.each([
    "https://outside.example/path",
    "//outside.example/path",
    "/\\outside.example/path",
  ])("drops an unsafe signup continuation %s", async nextPath => {
    mockNow(1_000_000);
    const formData = createSignupForm("invalid-address");
    formData.set("next", nextPath);
    await expect(signup(formData)).rejects.toMatchObject({
      path: "/login?tab=signup&signup_error=invalid_email&attempt=lfls&email=invalid-address",
    });
  });

  it.each(["rate limit", "client", "provider"])(
    "returns a safe failure when the %s request throws",
    async boundary => {
      mockNow(1_000_000);
      const error = new Error("private network details");
      createClientMock.mockResolvedValue({
        auth: { signUp: jest.fn().mockRejectedValue(error) },
      });
      if (boundary === "client") createClientMock.mockRejectedValueOnce(error);
      if (boundary === "rate limit")
        checkRateLimitMock.mockRejectedValueOnce(error);

      await expect(signup(createSignupForm())).rejects.toMatchObject({
        path: "/login?tab=signup&signup_error=unknown&attempt=lfls&email=founder%40example.com",
      });
    }
  );
});

describe("resendSignupConfirmation", () => {
  it("returns Supabase's email cooldown so the form can count down", async () => {
    createClientMock.mockResolvedValue({
      auth: {
        resend: jest.fn().mockResolvedValue({
          error: {
            code: "over_email_send_rate_limit",
            status: 429,
            message:
              "For security purposes, you can only request this after 42 seconds.",
          },
        }),
      },
    });

    await expect(
      resendSignupConfirmation("client@example.com")
    ).resolves.toEqual({
      success: false,
      errorCode: "rate_limited",
      retryAfterSeconds: 42,
    });
  });

  it.each([
    [
      undefined,
      "/panel/w/ws_1/kb?tab=articles",
      "http://localhost:3000/auth/callback?next=%2Fpanel%2Fw%2Fws_1%2Fkb%3Ftab%3Darticles",
    ],
    [
      "invite_1",
      "/panel/w/ws_1/kb",
      "http://localhost:3000/auth/callback?next=%2Fauth%2Fjoined%3Ftoken%3Dinvite_1",
    ],
    [
      undefined,
      "https://outside.example/path",
      "http://localhost:3000/auth/callback",
    ],
    [
      undefined,
      "//outside.example/path",
      "http://localhost:3000/auth/callback",
    ],
    [
      undefined,
      "/\\outside.example/path",
      "http://localhost:3000/auth/callback",
    ],
  ])(
    "keeps only the allowed resend continuation for invite %s and next %s",
    async (invite, next, callback) => {
      const resendMock = jest.fn().mockResolvedValue({ error: null });
      createClientMock.mockResolvedValue({ auth: { resend: resendMock } });

      await expect(
        resendSignupConfirmation("  client@example.com  ", invite, next)
      ).resolves.toEqual({ success: true });
      expect(resendMock).toHaveBeenCalledWith({
        type: "signup",
        email: "client@example.com",
        options: { emailRedirectTo: callback },
      });
    }
  );

  it.each(["", "invalid-address"])(
    "rejects invalid resend email %s before Auth",
    async email => {
      await expect(resendSignupConfirmation(email)).resolves.toEqual({
        success: false,
        errorCode: "invalid_email",
      });
      expect(createClientMock).not.toHaveBeenCalled();
    }
  );

  it("reports a safe error when resend is rate limited by the application", async () => {
    checkRateLimitMock.mockResolvedValue({ success: false });
    await expect(
      resendSignupConfirmation("client@example.com")
    ).resolves.toEqual({ success: false, errorCode: "rate_limited" });
    expect(createClientMock).not.toHaveBeenCalled();
  });

  it("does not expose unexpected provider details from resend", async () => {
    createClientMock.mockResolvedValue({
      auth: {
        resend: jest
          .fn()
          .mockResolvedValue({
            error: {
              code: "unexpected_failure",
              message: "private database detail",
            },
          }),
      },
    });
    await expect(
      resendSignupConfirmation("client@example.com")
    ).resolves.toEqual({ success: false, errorCode: "unknown" });
  });

  it.each(["rate limit", "client", "provider"])(
    "returns a safe resend failure when the %s request throws",
    async boundary => {
      const error = new Error("private network details");
      createClientMock.mockResolvedValue({
        auth: { resend: jest.fn().mockRejectedValue(error) },
      });
      if (boundary === "client") createClientMock.mockRejectedValueOnce(error);
      if (boundary === "rate limit")
        checkRateLimitMock.mockRejectedValueOnce(error);
      await expect(
        resendSignupConfirmation("client@example.com")
      ).resolves.toEqual({ success: false, errorCode: "unknown" });
    }
  );
});
