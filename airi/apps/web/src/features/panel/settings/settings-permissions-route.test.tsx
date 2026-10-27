import {
  Children,
  isValidElement,
  type ReactNode,
  type ReactElement,
} from "react";
const mockContext = jest.fn();
jest.mock("@/features/panel/shared/workspace", () => ({
  getReadOnlySupabaseContext: () => mockContext(),
}));
jest.mock("next-intl/server", () => ({
  getTranslations: async () => (key: string) => key,
}));
jest.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw new Error(path);
  },
  notFound: () => {
    throw new Error("not-found");
  },
}));
jest.mock("@/lib/workspace-feature-flags", () => ({
  isWorkspaceFeatureEnabled: async () => true,
}));
jest.mock("@/components/settings/airi-language-selector", () => ({
  AiriLanguageSelector: () => null,
}));
jest.mock("@/components/settings/ai-context-manager", () => ({
  AiContextManager: () => null,
}));
jest.mock("@/components/settings/airi-qa-manager", () => ({
  AiriQAManager: () => null,
}));
jest.mock("@/components/settings/public-url-indexer", () => ({
  PublicUrlIndexer: () => null,
}));
jest.mock("./ltv-config/components/ltv-config-form", () => ({
  LTVConfigForm: () => null,
}));
jest.mock(
  "@/components/settings/business-locations/business-locations-manager",
  () => ({ BusinessLocationsManager: () => null })
);
import LanguageSettings from "./airi-language/route";
import ContextSettings from "./ai-context/route";
import OfficesSettings from "./business-locations/route";
import LtvSettings from "./ltv-config/route";
function findProps(
  node: ReactNode,
  property: string
): Record<string, unknown> | null {
  return findControl(node, property)?.props ?? null;
}
function findControl(
  node: ReactNode,
  property: string
): ReactElement<Record<string, unknown>> | null {
  for (const child of Children.toArray(node)) {
    if (!isValidElement<Record<string, unknown>>(child)) continue;
    if (property in child.props) return child;
    const found = findControl(child.props.children as ReactNode, property);
    if (found) return found;
  }
  return null;
}
beforeEach(() => jest.clearAllMocks());
it.each([
  ["admin", false],
  ["manager", true],
  ["member", true],
  ["owner", true],
] as const)(
  "passes server-verified permissions to settings controls for %s",
  async (role, companyReadonly) => {
    const supabase = {
      from: jest.fn((table: string) => {
        const data =
          table === "company_users"
            ? {
                workspace_id: "workspace-1",
                role,
                workspaces: { companies: { dynamic_context_tags: ["Sales"] } },
              }
            : table === "workspaces"
              ? {
                  company_id: "company-1",
                  ltv_base_value: 100,
                  ltv_currency: "USD",
                }
              : { airi_language: "en" };
        return {
          select: jest.fn().mockReturnThis(),
          eq: jest.fn().mockReturnThis(),
          single: jest.fn().mockResolvedValue({ data, error: null }),
          maybeSingle: jest.fn().mockResolvedValue({ data, error: null }),
        };
      }),
    };
    mockContext.mockResolvedValue({ supabase, user: { id: "user-1" } });
    const params = Promise.resolve({ workspaceId: "workspace-1" });
    expect(
      findProps(await LanguageSettings({ params }), "initialLanguage")?.readOnly
    ).toBe(companyReadonly);
    // Even equal saved languages must discard an unsaved draft from another workspace.
    expect(
      findControl(await LanguageSettings({ params }), "initialLanguage")?.key
    ).toContain("workspace-1");
    expect(
      findProps(await ContextSettings({ params }), "initialTags")?.readOnly
    ).toBe(companyReadonly);
    // Workspace settings have no read-only mode: every member edits them.
    for (const props of [
      findProps(await LtvSettings({ params }), "initialValues"),
      findProps(await OfficesSettings({ params }), "workspaceId"),
    ]) {
      expect(props).not.toBeNull();
      expect(props).not.toHaveProperty("readOnly");
    }
  }
);
