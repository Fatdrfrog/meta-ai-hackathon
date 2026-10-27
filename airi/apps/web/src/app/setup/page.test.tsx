import SetupPage from "./page";

const redirectMock = jest.fn((path: string) => {
  throw Object.assign(new Error("NEXT_REDIRECT"), { path });
});
const createReadOnlyClientMock = jest.fn();
const hasCompletedProfileMock = jest.fn();

jest.mock("next/navigation", () => ({
  redirect: (path: string) => redirectMock(path),
}));

jest.mock("@/lib/supabase/server", () => ({
  createReadOnlyClient: () => createReadOnlyClientMock(),
}));

jest.mock("../onboarding/setup-router", () => ({
  hasCompletedProfile: (metadata: unknown) => hasCompletedProfileMock(metadata),
}));

jest.mock("./setup-wizard", () => ({
  SetupWizard: () => null,
}));

type SetupUserOptions = {
  firstWorkspaceId?: string;
  ownedRequestedWorkspaceId?: string;
  metadata?: Record<string, unknown>;
};

function createSupabaseForUser({
  firstWorkspaceId,
  ownedRequestedWorkspaceId,
  metadata = {},
}: SetupUserOptions) {
  const query = {
    select: jest.fn(),
    eq: jest.fn(),
    order: jest.fn(),
    limit: jest.fn(),
    maybeSingle: jest.fn(),
  };

  query.select.mockReturnValue(query);
  query.eq.mockReturnValue(query);
  query.order.mockReturnValue(query);
  query.limit.mockResolvedValue({
    data: firstWorkspaceId ? [{ workspace_id: firstWorkspaceId }] : [],
    error: null,
  });
  query.maybeSingle.mockResolvedValue({
    data: ownedRequestedWorkspaceId
      ? { workspace_id: ownedRequestedWorkspaceId }
      : null,
    error: null,
  });

  return {
    auth: {
      getUser: jest.fn().mockResolvedValue({
        data: {
          user: {
            id: "user-1",
            email: "founder@example.com",
            user_metadata: metadata,
          },
        },
      }),
    },
    from: jest.fn().mockReturnValue(query),
    query,
  };
}

describe("SetupPage", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("renders an owned training shortcut at the product step without redirecting to Airi", async () => {
    hasCompletedProfileMock.mockReturnValue(true);
    createReadOnlyClientMock.mockResolvedValue(
      createSupabaseForUser({
        firstWorkspaceId: "workspace-1",
        ownedRequestedWorkspaceId: "workspace-1",
      })
    );

    const result = await SetupPage({
      searchParams: Promise.resolve({
        step: "train",
        workspaceId: "workspace-1",
      }),
    });

    expect((result as React.ReactElement).props).toEqual({
      initialFullName: "founder",
      initialWorkspaceId: "workspace-1",
      initialStep: "product",
      requiresProfile: false,
      requiresWorkspace: false,
    });
    expect(redirectMock).not.toHaveBeenCalled();
  });

  it("does not use an unowned requested workspace as the training tenant", async () => {
    hasCompletedProfileMock.mockReturnValue(true);
    createReadOnlyClientMock.mockResolvedValue(
      createSupabaseForUser({ firstWorkspaceId: "workspace-owned" })
    );

    await expect(
      SetupPage({
        searchParams: Promise.resolve({
          step: "train",
          workspaceId: "workspace-foreign",
        }),
      })
    ).rejects.toMatchObject({ path: "/onboarding" });

    expect(redirectMock).not.toHaveBeenCalledWith(
      expect.stringContaining("workspace-foreign")
    );
  });

  it("keeps plain completed setup visits on the onboarding redirect", async () => {
    hasCompletedProfileMock.mockReturnValue(true);
    createReadOnlyClientMock.mockResolvedValue(
      createSupabaseForUser({ firstWorkspaceId: "workspace-1" })
    );

    await expect(
      SetupPage({ searchParams: Promise.resolve({}) })
    ).rejects.toMatchObject({ path: "/onboarding" });
  });

  it("keeps pending invitation processing ahead of setup routing", async () => {
    hasCompletedProfileMock.mockReturnValue(true);
    const supabase = createSupabaseForUser({
      firstWorkspaceId: "workspace-1",
      metadata: {
        company_id: "company-invite",
        workspace_id: "workspace-invite",
      },
    });
    createReadOnlyClientMock.mockResolvedValue(supabase);

    await expect(
      SetupPage({
        searchParams: Promise.resolve({
          step: "train",
          workspaceId: "workspace-1",
        }),
      })
    ).rejects.toMatchObject({ path: "/auth/confirm/process-invite" });

    expect(supabase.from).not.toHaveBeenCalled();
  });

  it("passes an existing owned workspace through missing-profile setup", async () => {
    hasCompletedProfileMock.mockReturnValue(false);
    createReadOnlyClientMock.mockResolvedValue(
      createSupabaseForUser({ firstWorkspaceId: "workspace-1" })
    );

    const result = await SetupPage({ searchParams: Promise.resolve({}) });

    expect((result as React.ReactElement).props).toEqual({
      initialFullName: "founder",
      initialWorkspaceId: "workspace-1",
      initialStep: "required",
      requiresProfile: true,
      requiresWorkspace: false,
    });
  });
});
