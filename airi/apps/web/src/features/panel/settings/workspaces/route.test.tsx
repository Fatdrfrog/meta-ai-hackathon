/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import WorkspaceSettings from "./route";
import { createSupabaseQueryMock } from "@/test-support/supabase-query-test-utils";
const mockContext = jest.fn();
const mockCompanyId = jest.fn();
const mockClient = jest.fn();
const mockCreate = jest.fn();
const mockForm = jest.fn();
jest.mock("@/features/panel/shared/workspace", () => ({
  getReadOnlySupabaseContext: () => mockContext(),
}));
jest.mock("@/lib/supabase/company-users", () => ({
  ...jest.requireActual("@/lib/supabase/company-users"),
  getSingleRelation: jest.requireActual("@/lib/supabase/company-users")
    .getSingleRelation,
  getCompanyIdForWorkspace: () => mockCompanyId(),
}));
jest.mock("@/lib/supabase/server", () => ({
  createClient: () => mockClient(),
}));
jest.mock("@/lib/workspaces/create-workspace", () => ({
  createWorkspaceForCompany: (...args: unknown[]) => mockCreate(...args),
}));
jest.mock("next-intl/server", () => ({
  getTranslations: async () => (key: string) => key,
}));
jest.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw new Error(`redirect:${path}`);
  },
}));
jest.mock("./workspace-create-form", () => ({
  WorkspaceCreateForm: (props: unknown) => {
    mockForm(props);
    return <div>Create form</div>;
  },
}));

const query = (data: unknown, error: unknown = null) =>
  createSupabaseQueryMock({ data, error });
function setup(rows: unknown[], readError: unknown = null) {
  const from = jest
    .fn()
    .mockReturnValueOnce(query({ workspace_id: "workspace-1" }))
    .mockReturnValueOnce(query(rows, readError));
  mockContext.mockResolvedValue({ user: { id: "u1" }, supabase: { from } });
}
const page = () =>
  WorkspaceSettings({
    params: Promise.resolve({ workspaceId: "workspace-1" }),
  });
beforeEach(() => {
  jest.clearAllMocks();
  mockCompanyId.mockResolvedValue("company-1");
  mockClient.mockResolvedValue({
    auth: { getUser: async () => ({ data: { user: { id: "u1" } } }) },
  });
  mockCreate.mockResolvedValue({ ok: true, workspace: { id: "new-space" } });
});

it("normalizes joined workspaces and removes duplicate routing actions", async () => {
  const workspace = {
    id: "workspace-1",
    name: "My workspace",
    company_id: "company-1",
  };
  setup([
    { role: "admin", workspaces: [workspace] },
    { role: "admin", workspaces: workspace },
  ]);
  render(await page());
  expect(screen.getAllByText("My workspace")).toHaveLength(1);
  expect(screen.getAllByRole("link")).toHaveLength(1);
  expect(screen.queryByText(/whatsapp/i)).not.toBeInTheDocument();
  expect(screen.getByText("currentWorkspace")).toBeInTheDocument();
  expect(screen.getByText("Create form")).toBeInTheDocument();
});

it("reports read errors without falsely showing no workspaces", async () => {
  setup([], { message: "database unavailable" });
  render(await page());
  expect(screen.getByText("loadError")).toBeInTheDocument();
  expect(screen.queryByText("emptyWorkspaces")).not.toBeInTheDocument();
  expect(mockForm).not.toHaveBeenCalled();
});

it.each(["manager", "member", "owner"])(
  "hides workspace creation for %s without company admin access",
  async role => {
    setup([
      {
        role,
        workspaces: {
          id: "workspace-1",
          name: "Space",
          company_id: "company-1",
        },
      },
    ]);
    render(await page());
    expect(screen.getByText("permissionError")).toBeInTheDocument();
    expect(mockForm).not.toHaveBeenCalled();
  }
);

it("validates trimmed names before workspace creation", async () => {
  setup([
    {
      role: "admin",
      workspaces: { id: "workspace-1", name: "Space", company_id: "company-1" },
    },
  ]);
  render(await page());
  const action = mockForm.mock.calls[0][0].action;
  const data = new FormData();
  data.set("name", "  ");
  await expect(action(data)).rejects.toThrow("createWorkspaceError=invalid");
  expect(mockCreate).not.toHaveBeenCalled();
});

it("distinguishes ended trials from workspace limits during creation", async () => {
  setup([
    {
      role: "admin",
      workspaces: { id: "workspace-1", name: "Space", company_id: "company-1" },
    },
  ]);
  mockCreate.mockResolvedValue({
    ok: false,
    status: 402,
    limit: { trialExpired: true },
  });
  render(await page());
  const action = mockForm.mock.calls[0][0].action;
  const data = new FormData();
  data.set("name", "Valid name");
  await expect(action(data)).rejects.toThrow("createWorkspaceError=trial");
});
