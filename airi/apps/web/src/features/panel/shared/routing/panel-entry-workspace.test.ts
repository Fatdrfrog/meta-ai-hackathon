import {
  getPanelEntryRedirectPath,
  getPanelEntryWorkspaceId,
} from "./panel-entry-workspace";

type QueryResponse<T> = { data: T };
type QueryMock = {
  select: jest.Mock;
  eq: jest.Mock;
  order: jest.Mock;
  maybeSingle: jest.Mock;
  limit: jest.Mock;
};

function createSupabaseMock({
  maybeSingleResponses = [],
  listResponses = [],
}: {
  maybeSingleResponses?: Array<QueryResponse<unknown>>;
  listResponses?: Array<QueryResponse<unknown[]>>;
}) {
  return {
    from: jest.fn(() => {
      const query: QueryMock = {
        select: jest.fn(),
        eq: jest.fn(),
        order: jest.fn(),
        maybeSingle: jest.fn(() =>
          Promise.resolve(maybeSingleResponses.shift() ?? { data: null })
        ),
        limit: jest.fn(() =>
          Promise.resolve(listResponses.shift() ?? { data: [] })
        ),
      };
      query.select.mockReturnValue(query);
      query.eq.mockReturnValue(query);
      query.order.mockReturnValue(query);

      return query;
    }),
  };
}

const workspaceLast = "11111111-1111-4111-8111-111111111111";
const workspaceLegacy = "22222222-2222-4222-8222-222222222222";
const workspaceFirst = "33333333-3333-4333-8333-333333333333";

describe("getPanelEntryRedirectPath", () => {
  it("uses the saved last visited page when the user still has access", async () => {
    const supabase = createSupabaseMock({
      maybeSingleResponses: [
        {
          data: {
            last_visited_path: `/panel/w/${workspaceLast}/requests?conversation=abc`,
            last_visited_workspace_id: workspaceLast,
          },
        },
        { data: { user_id: "user-1" } },
      ],
    });

    await expect(
      getPanelEntryRedirectPath(
        supabase as never,
        {
          id: "user-1",
          user_metadata: { last_workspace_id: workspaceLegacy },
        } as never
      )
    ).resolves.toBe(`/panel/w/${workspaceLast}/requests?conversation=abc`);
  });

  it("falls back to legacy last workspace when saved page access is missing", async () => {
    const supabase = createSupabaseMock({
      maybeSingleResponses: [
        {
          data: {
            last_visited_path: `/panel/w/${workspaceLast}/requests`,
            last_visited_workspace_id: workspaceLast,
          },
        },
        { data: null },
        { data: { user_id: "user-1" } },
      ],
    });

    await expect(
      getPanelEntryRedirectPath(
        supabase as never,
        {
          id: "user-1",
          user_metadata: { last_workspace_id: workspaceLegacy },
        } as never
      )
    ).resolves.toBe(`/panel/w/${workspaceLegacy}/airi`);
  });

  it("falls back to the first workspace when saved and legacy state are missing", async () => {
    const supabase = createSupabaseMock({
      maybeSingleResponses: [{ data: null }],
      listResponses: [{ data: [{ workspace_id: workspaceFirst }] }],
    });

    await expect(
      getPanelEntryRedirectPath(
        supabase as never,
        {
          id: "user-1",
          user_metadata: {},
        } as never
      )
    ).resolves.toBe(`/panel/w/${workspaceFirst}/airi`);
  });

  it("returns null when the user has no workspaces", async () => {
    const supabase = createSupabaseMock({
      listResponses: [{ data: [] }],
    });

    await expect(
      getPanelEntryRedirectPath(
        supabase as never,
        {
          id: "user-1",
          user_metadata: {},
        } as never
      )
    ).resolves.toBeNull();
  });

  it("keeps the workspace-id compatibility helper", async () => {
    const supabase = createSupabaseMock({
      maybeSingleResponses: [
        {
          data: {
            last_visited_path: `/panel/w/${workspaceLast}/settings/team`,
            last_visited_workspace_id: workspaceLast,
          },
        },
        { data: { user_id: "user-1" } },
      ],
    });

    await expect(
      getPanelEntryWorkspaceId(
        supabase as never,
        {
          id: "user-1",
          user_metadata: {},
        } as never
      )
    ).resolves.toBe(workspaceLast);
  });
});
