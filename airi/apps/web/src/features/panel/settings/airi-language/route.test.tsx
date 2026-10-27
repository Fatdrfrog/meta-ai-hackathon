/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import AiriLanguageSettingsPage from "./route";
import { getReadOnlySupabaseContext } from "@/features/panel/shared/workspace";
import { getCompanyIdForWorkspace } from "@/lib/supabase/company-users";

jest.mock("@/features/panel/shared/workspace", () => ({
  getReadOnlySupabaseContext: jest.fn(),
}));
jest.mock("@/lib/supabase/company-users", () => ({
  ...jest.requireActual("@/lib/supabase/company-users"),
  getCompanyIdForWorkspace: jest.fn(),
}));
jest.mock("next-intl/server", () => ({
  getTranslations: async () => (key: string) => key,
}));
jest.mock("next/navigation", () => ({ redirect: jest.fn() }));
jest.mock("@/components/settings/airi-language-selector", () => ({
  AiriLanguageSelector: ({ initialLanguage }: { initialLanguage: string }) => (
    <div data-testid="language">{initialLanguage}</div>
  ),
}));

function context(company: unknown, companyError: unknown = null) {
  const query = {
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    single: jest
      .fn()
      .mockResolvedValueOnce({
        data: { workspace_id: "workspace_1" },
        error: null,
      })
      .mockResolvedValueOnce({ data: company, error: companyError }),
  };
  jest.mocked(getReadOnlySupabaseContext).mockResolvedValue({
    user: { id: "user_1" },
    supabase: { from: () => query },
  } as never);
  jest.mocked(getCompanyIdForWorkspace).mockResolvedValue("company_1");
}

describe("fallback language settings data", () => {
  it("does not render a failed lookup as an editable English fallback", async () => {
    context(null, { message: "unavailable" });
    render(
      await AiriLanguageSettingsPage({
        params: Promise.resolve({ workspaceId: "workspace_1" }),
      })
    );
    expect(screen.getByRole("alert")).toHaveTextContent("loadFailed");
    expect(screen.queryByTestId("language")).not.toBeInTheDocument();
  });

  it("keeps supported saved languages and omits obsolete missing translation keys", async () => {
    context({ airi_language: "uz" });
    render(
      await AiriLanguageSettingsPage({
        params: Promise.resolve({ workspaceId: "workspace_1" }),
      })
    );
    expect(screen.getByTestId("language")).toHaveTextContent("uz");
    expect(screen.queryByText(/uses\./)).not.toBeInTheDocument();
  });

  it("uses English for an unset language and rejects unsupported stored values", async () => {
    context({ airi_language: null });
    const view = render(
      await AiriLanguageSettingsPage({
        params: Promise.resolve({ workspaceId: "workspace_1" }),
      })
    );
    expect(screen.getByTestId("language")).toHaveTextContent("en");
    view.unmount();
    context({ airi_language: "unsupported" });
    render(
      await AiriLanguageSettingsPage({
        params: Promise.resolve({ workspaceId: "workspace_1" }),
      })
    );
    expect(screen.getByRole("alert")).toHaveTextContent("loadFailed");
    expect(screen.queryByTestId("language")).not.toBeInTheDocument();
  });
});
