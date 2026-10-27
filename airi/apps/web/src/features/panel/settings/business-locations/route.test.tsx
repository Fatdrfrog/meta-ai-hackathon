/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import BusinessLocationsSettingsPage from "./route";

const mockContext = jest.fn();
const mockMembership = jest.fn();
const mockFlag = jest.fn();
jest.mock("@/features/panel/shared/workspace", () => ({
  getReadOnlySupabaseContext: () => mockContext(),
}));
jest.mock("@/lib/workspace-feature-flags", () => ({
  isWorkspaceFeatureEnabled: (...args: unknown[]) => mockFlag(...args),
}));
jest.mock("next-intl/server", () => ({
  getTranslations: async () => (key: string) => key,
}));
jest.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw new Error(`redirect:${path}`);
  },
  notFound: () => {
    throw new Error("not-found");
  },
}));
jest.mock(
  "@/components/settings/business-locations/business-locations-manager",
  () => ({
    BusinessLocationsManager: () => {
      const React = jest.requireActual("react");
      const [draft, setDraft] = React.useState("");
      return (
        <div data-testid="offices">
          <input
            aria-label="Office draft"
            value={draft}
            onChange={event => setDraft(event.target.value)}
          />
        </div>
      );
    },
  })
);

const params = (workspaceId = "workspace-1") => ({
  params: Promise.resolve({ workspaceId }),
});

beforeEach(() => {
  jest.clearAllMocks();
  const query = {
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    maybeSingle: mockMembership,
  };
  mockContext.mockResolvedValue({
    user: { id: "user-1" },
    supabase: { from: () => query },
  });
  mockMembership.mockResolvedValue({
    data: { workspace_id: "workspace-1" },
    error: null,
  });
  mockFlag.mockResolvedValue(true);
});

test("renders the offices manager for a member with the flag on", async () => {
  render(await BusinessLocationsSettingsPage(params()));
  expect(screen.getByTestId("offices")).toBeInTheDocument();
  expect(mockFlag).toHaveBeenCalledWith(
    "workspace-1",
    "scenario_location_routing"
  );
});

test("with the flag off, the page redirects to the settings index", async () => {
  mockFlag.mockResolvedValue(false);
  await expect(BusinessLocationsSettingsPage(params())).rejects.toThrow(
    "redirect:/panel/w/workspace-1/settings/integrations"
  );
});

test("a failed flag read counts as off", async () => {
  mockFlag.mockRejectedValue(new Error("flags unavailable"));
  await expect(BusinessLocationsSettingsPage(params())).rejects.toThrow(
    "redirect:/panel/w/workspace-1/settings/integrations"
  );
});

test("a membership failure shows an alert, not the offices", async () => {
  mockMembership.mockResolvedValue({
    data: null,
    error: { message: "database unavailable" },
  });
  render(await BusinessLocationsSettingsPage(params()));
  expect(screen.getByRole("alert")).toHaveTextContent("settingsLoadFailed");
  expect(screen.queryByTestId("offices")).not.toBeInTheDocument();
});

test("a membership failure is shown even with the flag off", async () => {
  mockMembership.mockResolvedValue({
    data: null,
    error: { message: "database unavailable" },
  });
  mockFlag.mockResolvedValue(false);
  render(await BusinessLocationsSettingsPage(params()));
  expect(screen.getByRole("alert")).toHaveTextContent("settingsLoadFailed");
});

test("non-members go to the panel whatever the flag says", async () => {
  mockMembership.mockResolvedValue({ data: null, error: null });
  mockFlag.mockResolvedValue(false);
  await expect(BusinessLocationsSettingsPage(params())).rejects.toThrow(
    /^redirect:\/panel$/
  );
});

test("signed-out visitors go to the login page", async () => {
  mockContext.mockResolvedValue({ user: null, supabase: {} });
  await expect(BusinessLocationsSettingsPage(params())).rejects.toThrow(
    "redirect:/login"
  );
  expect(mockFlag).not.toHaveBeenCalled();
});

test("a workspace change remounts the offices manager and drops its draft", async () => {
  const view = render(await BusinessLocationsSettingsPage(params()));
  fireEvent.change(screen.getByLabelText("Office draft"), {
    target: { value: "Abay office" },
  });
  expect(screen.getByLabelText("Office draft")).toHaveValue("Abay office");
  view.rerender(await BusinessLocationsSettingsPage(params("workspace-2")));
  expect(screen.getByLabelText("Office draft")).toHaveValue("");
});
