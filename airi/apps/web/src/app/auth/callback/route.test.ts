const exchangeCodeForSessionMock = jest.fn();
const authGetUserMock = jest.fn();
const getUserCompanyMock = jest.fn();
const getAccountMergeRedirectPathMock = jest.fn();

jest.mock("@/lib/supabase/server", () => ({
  createClient: jest.fn(async () => ({
    auth: {
      exchangeCodeForSession: (...args: unknown[]) =>
        exchangeCodeForSessionMock(...args),
      getUser: (...args: unknown[]) => authGetUserMock(...args),
    },
  })),
}));

jest.mock("@/lib/supabase/queries", () => ({
  getUserCompany: (...args: unknown[]) => getUserCompanyMock(...args),
}));

jest.mock("@/lib/auth/account-merge", () => ({
  getAccountMergeRedirectPath: (...args: unknown[]) =>
    getAccountMergeRedirectPathMock(...args),
}));

jest.mock("@/lib/auth/invite-processor", () => ({
  processInvite: jest.fn(),
}));

jest.mock("@/lib/analytics", () => ({
  setCompanyProperties: jest.fn(),
  trackUserSignIn: jest.fn(),
}));

const getPanelEntryRedirectPathMock = jest.fn();
jest.mock("@/features/panel/shared/routing", () => ({
  ...jest.requireActual("@/features/panel/shared/routing"),
  getPanelEntryRedirectPath: (...args: unknown[]) =>
    getPanelEntryRedirectPathMock(...args),
}));

const captureAuthCallbackFunnelEventMock = jest.fn();
jest.mock("@/lib/auth/auth-funnel-events", () => ({
  captureAuthCallbackFunnelEvent: (...args: unknown[]) =>
    captureAuthCallbackFunnelEventMock(...args),
}));

jest.mock("@/lib/tracking-consent-server", () => ({
  readServerTrackingConsent: async () => "granted",
}));

import { createTeamInviteToken } from "@/lib/auth/team-invite-link";
import { PENDING_TEAM_INVITE_COOKIE_NAME } from "@/lib/auth/pending-invite-cookie";
import { processInvite } from "@/lib/auth/invite-processor";
import { setCompanyProperties, trackUserSignIn } from "@/lib/analytics";
import { GET } from "./route";

const processInviteMock = processInvite as jest.MockedFunction<
  typeof processInvite
>;

describe("GET /auth/callback", () => {
  const previousSecret = process.env.TEAM_INVITE_LINK_SECRET;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.TEAM_INVITE_LINK_SECRET = "test-invite-secret";
    exchangeCodeForSessionMock.mockResolvedValue({
      data: {
        user: {
          id: "user-1",
          email: "client@example.com",
          user_metadata: {},
        },
      },
      error: null,
    });
    authGetUserMock.mockResolvedValue({
      data: {
        user: {
          id: "user-1",
          email: "client@example.com",
          user_metadata: {},
        },
      },
    });
    getUserCompanyMock.mockResolvedValue(null);
    getAccountMergeRedirectPathMock.mockResolvedValue(null);
    getPanelEntryRedirectPathMock.mockResolvedValue(null);
    processInviteMock.mockResolvedValue({
      success: true,
      alreadyProcessed: false,
    });
  });

  afterEach(() => {
    process.env.TEAM_INVITE_LINK_SECRET = previousSecret;
  });

  it("records the funnel step for a self-signup heading to setup", async () => {
    getUserCompanyMock.mockResolvedValue(null);
    getAccountMergeRedirectPathMock.mockResolvedValue(null);

    const response = await GET(
      new Request("https://www.airi.chat/auth/callback?code=code-1")
    );

    expect(response.headers.get("location")).toBe(
      "https://www.airi.chat/onboarding"
    );
    expect(captureAuthCallbackFunnelEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: "user-1" }),
      "pkce"
    );
  });

  it("sends a returning user to their workspace and records the sign-in", async () => {
    getUserCompanyMock.mockResolvedValue({
      company_id: "company-1",
      workspaces: { id: "workspace-1" },
      companies: { name: "Acme", slug: "acme", airi_language: "ru" },
    });

    const response = await GET(
      new Request("https://www.airi.chat/auth/callback?code=auth-code")
    );

    expect(response.headers.get("location")).toBe(
      "https://www.airi.chat/panel/w/workspace-1/airi"
    );
    expect(captureAuthCallbackFunnelEventMock).not.toHaveBeenCalled();
    expect(trackUserSignIn).toHaveBeenCalledWith(
      "user-1",
      "company-1",
      "workspace-1",
      "oauth",
      "client@example.com",
      { consent: "granted" }
    );
    const companyProperties = (setCompanyProperties as jest.Mock).mock
      .calls[0][1];
    expect(companyProperties).toEqual(
      expect.objectContaining({ company_name: "Acme", airi_language: "ru" })
    );
    expect(companyProperties).not.toHaveProperty("language");
  });

  it("recovers an invite redirect from the pending invite cookie when magic-link next is missing", async () => {
    const { token } = createTeamInviteToken({
      companyId: "11111111-1111-4111-8111-111111111111",
      workspaceId: "22222222-2222-4222-8222-222222222222",
      inviterId: "33333333-3333-4333-8333-333333333333",
    });

    const response = await GET(
      new Request("https://www.airi.chat/auth/callback?code=auth-code", {
        headers: {
          cookie: `${PENDING_TEAM_INVITE_COOKIE_NAME}=${encodeURIComponent(token)}`,
        },
      })
    );

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      `https://www.airi.chat/auth/joined?token=${encodeURIComponent(token)}`
    );
  });

  it("sends already accepted invite users to the workspace instead of setup", async () => {
    exchangeCodeForSessionMock.mockResolvedValue({
      data: {
        user: {
          id: "user-1",
          email: "client@example.com",
          user_metadata: {
            company_id: "company-1",
            workspace_id: "workspace-1",
          },
          app_metadata: { providers: ["email"] },
        },
      },
      error: null,
    });
    authGetUserMock.mockResolvedValue({
      data: {
        user: {
          id: "user-1",
          email: "client@example.com",
          user_metadata: {
            company_id: "company-1",
            workspace_id: "workspace-1",
          },
          app_metadata: { providers: ["email"] },
        },
      },
    });
    processInviteMock.mockResolvedValue({
      success: true,
      workspaceId: "workspace-1",
      alreadyProcessed: true,
    });

    const response = await GET(
      new Request("https://www.airi.chat/auth/callback?code=auth-code")
    );

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      "https://www.airi.chat/panel/w/workspace-1/airi"
    );
  });

  it("checks account merge before following an arbitrary next path", async () => {
    getUserCompanyMock.mockResolvedValue({
      company_id: "company-1",
      workspaces: { id: "workspace-1" },
      companies: { name: "Acme", slug: "acme" },
    });
    getAccountMergeRedirectPathMock.mockResolvedValue(
      "/auth/merge-assets?next=%2Fpanel%2Fw%2Fworkspace-1%2Frequests"
    );

    const response = await GET(
      new Request(
        "https://www.airi.chat/auth/callback?code=auth-code&next=%2Fpanel%2Fw%2Fworkspace-1%2Frequests"
      )
    );

    expect(response.status).toBe(307);
    expect(getAccountMergeRedirectPathMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: "user-1" }),
      "/panel/w/workspace-1/requests",
      expect.any(Object)
    );
    expect(response.headers.get("location")).toBe(
      "https://www.airi.chat/auth/merge-assets?next=%2Fpanel%2Fw%2Fworkspace-1%2Frequests"
    );
  });

  it("sends Google invite users to the workspace after linking access", async () => {
    exchangeCodeForSessionMock.mockResolvedValue({
      data: {
        user: {
          id: "user-1",
          email: "client@example.com",
          user_metadata: {
            company_id: "company-1",
            workspace_id: "workspace-1",
          },
          app_metadata: { providers: ["email", "google"] },
        },
      },
      error: null,
    });
    authGetUserMock.mockResolvedValue({
      data: {
        user: {
          id: "user-1",
          email: "client@example.com",
          user_metadata: {
            company_id: "company-1",
            workspace_id: "workspace-1",
          },
          app_metadata: { providers: ["email", "google"] },
        },
      },
    });
    processInviteMock.mockResolvedValue({
      success: true,
      workspaceId: "workspace-1",
      alreadyProcessed: false,
    });

    const response = await GET(
      new Request("https://www.airi.chat/auth/callback?code=auth-code")
    );

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      "https://www.airi.chat/panel/w/workspace-1/airi"
    );
  });

  it("keeps email-only new invite users on the profile setup step", async () => {
    exchangeCodeForSessionMock.mockResolvedValue({
      data: {
        user: {
          id: "user-1",
          email: "client@example.com",
          user_metadata: {
            company_id: "company-1",
            workspace_id: "workspace-1",
          },
          app_metadata: { providers: ["email"] },
        },
      },
      error: null,
    });
    authGetUserMock.mockResolvedValue({
      data: {
        user: {
          id: "user-1",
          email: "client@example.com",
          user_metadata: {
            company_id: "company-1",
            workspace_id: "workspace-1",
          },
          app_metadata: { providers: ["email"] },
        },
      },
    });
    processInviteMock.mockResolvedValue({
      success: true,
      workspaceId: "workspace-1",
      alreadyProcessed: false,
    });

    const response = await GET(
      new Request("https://www.airi.chat/auth/callback?code=auth-code")
    );

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      "https://www.airi.chat/auth/complete-invite?workspaceId=workspace-1"
    );
  });
});
