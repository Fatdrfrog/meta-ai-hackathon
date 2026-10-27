/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import CustomerApiSettingsPage from "./route";

const mockContext = jest.fn();
const mockMembership = jest.fn();
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
jest.mock("./customer-api-settings", () => ({
  CustomerApiSettings: () => {
    const React = jest.requireActual("react");
    const [pendingSecret, setPendingSecret] = React.useState("");
    return (
      <div data-testid="management">
        <input
          aria-label="Pending secret"
          value={pendingSecret}
          onChange={event => setPendingSecret(event.target.value)}
        />
      </div>
    );
  },
}));

beforeEach(() => {
  const query = {
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    maybeSingle: mockMembership,
  };
  mockContext.mockResolvedValue({
    user: { id: "user-1" },
    supabase: { from: () => query },
  });
  mockMembership.mockResolvedValue({ data: { role: "admin" }, error: null });
});
test.each(["admin", " admin "])("renders controls for %s", async role => {
  mockMembership.mockResolvedValue({ data: { role }, error: null });
  render(
    await CustomerApiSettingsPage({
      params: Promise.resolve({ workspaceId: "workspace-1" }),
    })
  );
  expect(screen.getByTestId("management")).toBeInTheDocument();
});

test("workspace changes remount credential controls and discard pending secrets", async () => {
  const view = render(
    await CustomerApiSettingsPage({
      params: Promise.resolve({ workspaceId: "workspace-1" }),
    })
  );
  fireEvent.change(screen.getByLabelText("Pending secret"), {
    target: { value: "workspace-one-secret" },
  });
  expect(screen.getByLabelText("Pending secret")).toHaveValue(
    "workspace-one-secret"
  );
  view.rerender(
    await CustomerApiSettingsPage({
      params: Promise.resolve({ workspaceId: "workspace-2" }),
    })
  );
  expect(screen.getByLabelText("Pending secret")).toHaveValue("");
});
test.each(["manager", "member", "owner"])(
  "role %s sees an admin-only explanation without key or webhook controls",
  async role => {
    mockMembership.mockResolvedValue({ data: { role }, error: null });
    render(
      await CustomerApiSettingsPage({
        params: Promise.resolve({ workspaceId: "workspace-1" }),
      })
    );
    expect(screen.getByText("adminOnly")).toBeInTheDocument();
    expect(screen.queryByTestId("management")).not.toBeInTheDocument();
  }
);
test("a membership failure is not presented as a valid member state", async () => {
  mockMembership.mockResolvedValue({
    data: null,
    error: { message: "database unavailable" },
  });
  render(
    await CustomerApiSettingsPage({
      params: Promise.resolve({ workspaceId: "workspace-1" }),
    })
  );
  expect(screen.getByText("loadError")).toBeInTheDocument();
  expect(screen.queryByText("adminOnly")).not.toBeInTheDocument();
});
