import LoginPage from "./page";
import type { TeamInviteContext } from "@/lib/auth/team-invite-context";

const redirectMock = jest.fn((path: string) => {
  throw Object.assign(new Error("NEXT_REDIRECT"), { path });
});
const createReadOnlyClientMock = jest.fn();
const resolveTeamInviteContextMock = jest.fn();
const getAccountMergeRedirectPathMock = jest.fn();

jest.mock("next/navigation", () => ({
  redirect: (path: string) => redirectMock(path),
}));

jest.mock("@/lib/supabase/server", () => ({
  createReadOnlyClient: () => createReadOnlyClientMock(),
}));

jest.mock("@/lib/auth/team-invite-context", () => ({
  resolveTeamInviteContext: (
    supabase: unknown,
    token: string
  ): Promise<TeamInviteContext | null> =>
    resolveTeamInviteContextMock(supabase, token),
}));

jest.mock("@/lib/auth/account-merge", () => ({
  getAccountMergeRedirectPath: (...args: unknown[]) =>
    getAccountMergeRedirectPathMock(...args),
}));

jest.mock("./LoginForm", () => ({
  __esModule: true,
  default: () => null,
}));

function createSupabaseForUser(workspaceId: string | null) {
  type WorkspaceQuery = {
    select: jest.Mock;
    eq: jest.Mock;
    order: jest.Mock;
    limit: jest.Mock;
    maybeSingle: jest.Mock;
  };

  const query: WorkspaceQuery = {
    select: jest.fn(),
    eq: jest.fn(),
    order: jest.fn(),
    limit: jest.fn(),
    maybeSingle: jest.fn(),
  };

  query.select.mockImplementation(() => query);
  query.eq.mockImplementation(() => query);
  query.order.mockImplementation(() => query);
  query.limit.mockImplementation(() =>
    Promise.resolve({
      data: workspaceId ? [{ workspace_id: workspaceId }] : [],
      error: null,
    })
  );
  query.maybeSingle.mockResolvedValue({
    data: workspaceId ? { workspace_id: workspaceId } : null,
    error: null,
  });

  return {
    auth: {
      getUser: jest.fn(() =>
        Promise.resolve({
          data: {
            user:
              workspaceId === null
                ? null
                : {
                    id: "user_1",
                    email: "founder@example.com",
                    confirmed_at: "2026-01-01T00:00:00.000Z",
                    email_confirmed_at: "2026-01-01T00:00:00.000Z",
                  },
          },
        })
      ),
    },
    from: jest.fn(() => query),
  };
}

describe("LoginPage", () => {
  beforeEach(() => {
    redirectMock.mockClear();
    createReadOnlyClientMock.mockReset();
    resolveTeamInviteContextMock.mockReset();
    getAccountMergeRedirectPathMock.mockReset();
    resolveTeamInviteContextMock.mockResolvedValue(null);
    getAccountMergeRedirectPathMock.mockResolvedValue(null);
  });

  it("redirects authenticated users directly to their first workspace Airi chat page", async () => {
    createReadOnlyClientMock.mockResolvedValue(createSupabaseForUser("ws_1"));

    await expect(
      LoginPage({ searchParams: Promise.resolve({}) })
    ).rejects.toMatchObject({
      path: "/panel/w/ws_1/airi",
    });
  });

  it("returns an authenticated user to the protected destination that triggered re-authentication", async () => {
    createReadOnlyClientMock.mockResolvedValue(createSupabaseForUser("ws_1"));

    await expect(
      LoginPage({
        searchParams: Promise.resolve({
          next: "/panel/w/ws_1/scenarios?tab=flows",
        }),
      })
    ).rejects.toMatchObject({
      path: "/panel/w/ws_1/scenarios?tab=flows",
    });
  });

  it("keeps invite acceptance as the authenticated login priority", async () => {
    createReadOnlyClientMock.mockResolvedValue(createSupabaseForUser("ws_1"));

    await expect(
      LoginPage({
        searchParams: Promise.resolve({ invite_token: "invite_1" }),
      })
    ).rejects.toMatchObject({
      path: "/auth/joined?token=invite_1",
    });
    expect(getAccountMergeRedirectPathMock).not.toHaveBeenCalled();
  });

  it("prompts authenticated users to merge same-email workspace assets before entering the app", async () => {
    createReadOnlyClientMock.mockResolvedValue(createSupabaseForUser("ws_1"));
    getAccountMergeRedirectPathMock.mockResolvedValue(
      "/auth/merge-assets?next=%2Fpanel%2Fw%2Fws_1%2Fairi%2Fchats"
    );

    await expect(
      LoginPage({ searchParams: Promise.resolve({}) })
    ).rejects.toMatchObject({
      path: "/auth/merge-assets?next=%2Fpanel%2Fw%2Fws_1%2Fairi%2Fchats",
    });
  });

  it("passes invite context to the login form for logged-out invite links", async () => {
    const supabase = createSupabaseForUser(null);
    createReadOnlyClientMock.mockResolvedValue(supabase);
    const inviteContext: TeamInviteContext = {
      status: "valid",
      workspaceId: "ws_1",
      workspaceName: "Support Workspace",
      companyName: "Airi Demo",
      expiresAtIso: "2026-05-15T00:00:00.000Z",
    };
    resolveTeamInviteContextMock.mockResolvedValue(inviteContext);

    const result = await LoginPage({
      searchParams: Promise.resolve({ invite_token: "invite_1" }),
    });

    expect(resolveTeamInviteContextMock).toHaveBeenCalledWith(
      supabase,
      "invite_1"
    );
    expect((result as React.ReactElement).props).toEqual({
      inviteToken: "invite_1",
      inviteContext,
    });
  });

  it("passes the protected destination to the logged-out login form", async () => {
    createReadOnlyClientMock.mockResolvedValue(createSupabaseForUser(null));

    const result = await LoginPage({
      searchParams: Promise.resolve({
        next: "/panel/w/ws_1/scenarios?tab=flows",
      }),
    });

    expect((result as React.ReactElement).props).toEqual({
      inviteToken: undefined,
      inviteContext: null,
      nextPath: "/panel/w/ws_1/scenarios?tab=flows",
    });
  });
});
