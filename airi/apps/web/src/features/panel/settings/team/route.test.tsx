/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import TeamSettingsPage from "./route";
import { createSupabaseQueryMock } from "@/test-support/supabase-query-test-utils";

const mockContext = jest.fn();
const mockTeam = jest.fn();
const mockTeamMount = jest.fn();
jest.mock("@/features/panel/shared/workspace", () => ({
  getReadOnlySupabaseContext: () => mockContext(),
}));
jest.mock("next-intl/server", () => ({
  getTranslations: async () => (key: string) => key,
}));
jest.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw new Error(`redirect:${path}`);
  },
}));
jest.mock("@/components/team/team-management-client-page", () => ({
  TeamManagementClientPage: (props: unknown) => {
    const { useEffect } = jest.requireActual<typeof import("react")>("react");
    useEffect(() => {
      mockTeamMount();
    }, []);
    mockTeam(props);
    return <div>Team controls</div>;
  },
}));

const query = (data: unknown, error: unknown = null) =>
  createSupabaseQueryMock({ data, error });
function setup(...queries: ReturnType<typeof query>[]) {
  const from = jest.fn();
  for (const value of queries) from.mockReturnValueOnce(value);
  mockContext.mockResolvedValue({ user: { id: "user-1" }, supabase: { from } });
}
const page = () =>
  TeamSettingsPage({ params: Promise.resolve({ workspaceId: "workspace-1" }) });
beforeEach(() => jest.clearAllMocks());

it("resets pending team actions when the selected workspace changes", async () => {
  setup(query({ role: "admin" }), query([]));
  const view = render(await page());
  setup(query({ role: "admin" }), query([]));
  view.rerender(
    await TeamSettingsPage({
      params: Promise.resolve({ workspaceId: "workspace-2" }),
    })
  );
  expect(mockTeamMount).toHaveBeenCalledTimes(2);
});

it("keeps team controls in a real empty result", async () => {
  setup(query({ role: "admin" }), query([]));
  render(await page());
  expect(screen.getByText("Team controls")).toBeInTheDocument();
  expect(mockTeam).toHaveBeenCalledWith(
    expect.objectContaining({
      initialMembers: [],
      currentRole: "admin",
      currentUserId: "user-1",
    })
  );
});

it("does not turn a membership read failure into an empty team", async () => {
  setup(query(null, { message: "database unavailable" }));
  render(await page());
  expect(screen.getByText("loadError")).toBeInTheDocument();
  expect(mockTeam).not.toHaveBeenCalled();
});

it("does not turn a failed join and failed fallback into an empty team", async () => {
  setup(
    query({ role: "admin" }),
    query(null, { message: "join failed" }),
    query(null, { message: "read failed" })
  );
  render(await page());
  expect(screen.getByText("loadError")).toBeInTheDocument();
  expect(mockTeam).not.toHaveBeenCalled();
});

it("retains the fallback when public profiles cannot be joined", async () => {
  setup(
    query({ role: "manager" }),
    query(null, { message: "join failed" }),
    query([
      { id: "m1", email: "member@example.com", role: "manager", user_id: "u1" },
    ])
  );
  render(await page());
  expect(mockTeam).toHaveBeenCalledWith(
    expect.objectContaining({
      initialMembers: [
        expect.objectContaining({ email: "member@example.com", users: null }),
      ],
    })
  );
});
