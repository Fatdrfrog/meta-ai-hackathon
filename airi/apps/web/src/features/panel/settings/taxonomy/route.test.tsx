/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import TaxonomySettingsPage from "./route";

jest.mock("next-intl/server", () => ({
  getTranslations: async () => (key: string) => key,
}));
jest.mock("@/components/campaigns/internal-labels-manager", () => ({
  InternalLabelsManager: () => <div>tags</div>,
}));
jest.mock("@/components/settings/taxonomy-manager", () => ({
  TaxonomyManager: () => <button>save taxonomy</button>,
}));
const maybeSingle = jest.fn();
const query = {
  select: jest.fn().mockReturnThis(),
  eq: jest.fn().mockReturnThis(),
  order: jest.fn().mockReturnThis(),
  limit: jest.fn().mockReturnThis(),
  maybeSingle,
};
jest.mock("@/features/panel/shared/workspace", () => ({
  getReadOnlySupabaseContext: async () => ({
    user: { id: "user" },
    supabase: { from: () => query },
  }),
}));

it("blocks editable default topics after a failed settings query", async () => {
  maybeSingle.mockResolvedValue({
    data: null,
    error: { message: "unavailable" },
  });
  render(
    await TaxonomySettingsPage({
      params: Promise.resolve({ workspaceId: "workspace" }),
    })
  );
  expect(screen.getByRole("alert")).toHaveTextContent("taxonomyLoadFailed");
  expect(
    screen.queryByRole("button", { name: "save taxonomy" })
  ).not.toBeInTheDocument();
});
it("allows defaults only after a successful query confirms no taxonomy exists", async () => {
  maybeSingle.mockResolvedValue({ data: null, error: null });
  render(
    await TaxonomySettingsPage({
      params: Promise.resolve({ workspaceId: "workspace" }),
    })
  );
  expect(
    screen.getByRole("button", { name: "save taxonomy" })
  ).toBeInTheDocument();
});
