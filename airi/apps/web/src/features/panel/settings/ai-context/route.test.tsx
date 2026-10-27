/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import AiContextSettingsPage from "./route";
import { getReadOnlySupabaseContext } from "@/features/panel/shared/workspace";

jest.mock("@/features/panel/shared/workspace", () => ({
  getReadOnlySupabaseContext: jest.fn(),
}));
jest.mock("next-intl/server", () => ({
  getTranslations: async () => (key: string) => key,
}));
jest.mock("next/navigation", () => ({ redirect: jest.fn() }));
jest.mock("@/components/settings/ai-context-manager", () => ({
  AiContextManager: ({ initialTags }: { initialTags: string[] }) => (
    <div data-testid="tags">{initialTags.join(",")}</div>
  ),
}));
jest.mock("@/components/settings/airi-qa-manager", () => ({
  AiriQAManager: () => <div>Answers</div>,
}));
jest.mock("@/components/settings/public-url-indexer", () => ({
  PublicUrlIndexer: () => <div>URLs</div>,
}));

function context(data: unknown, error: unknown = null) {
  const query = {
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    single: jest.fn().mockResolvedValue({ data, error }),
  };
  jest.mocked(getReadOnlySupabaseContext).mockResolvedValue({
    user: { id: "user_1" },
    supabase: { from: () => query },
  } as never);
  return query;
}

describe("knowledge settings data", () => {
  it("loads tags through the workspace company relationship used by the existing context API", async () => {
    const query = context({
      workspaces: { companies: { dynamic_context_tags: ["Renewals"] } },
    });
    render(
      await AiContextSettingsPage({
        params: Promise.resolve({ workspaceId: "workspace_1" }),
      })
    );
    expect(screen.getByTestId("tags")).toHaveTextContent("Renewals");
    expect(query.select).toHaveBeenCalledWith(
      "role, workspaces!fk_workspace(companies!workspaces_company_id_fkey(dynamic_context_tags))"
    );
    expect(query.eq).toHaveBeenCalledWith("workspace_id", "workspace_1");
  });

  it("does not allow a failed load to be saved as empty tags", async () => {
    context(null, { message: "unavailable" });
    render(
      await AiContextSettingsPage({
        params: Promise.resolve({ workspaceId: "workspace_1" }),
      })
    );
    expect(screen.getByRole("alert")).toHaveTextContent("loadFailed");
    expect(screen.queryByTestId("tags")).not.toBeInTheDocument();
    expect(screen.getByText("URLs")).toBeInTheDocument();
  });
});
