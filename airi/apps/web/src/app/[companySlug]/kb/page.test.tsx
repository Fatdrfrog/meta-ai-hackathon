const mockAdminFrom = jest.fn();
const mockCompanyEq = jest.fn();
const mockVisitorFrom = jest.fn();
const mockRedirect = jest.fn();
const mockNotFound = jest.fn();

jest.mock("@/components/landing/page-header", () => ({
  LandingPageHeader: () => null,
}));

jest.mock("@/lib/kb/public-kb", () => ({
  getPublicKBWorkspaceIds: async () => ["workspace-1"],
}));

jest.mock("@/lib/kb/public-kb-viewer", () => ({
  getPublicKBHeaderViewer: async () => undefined,
}));

jest.mock("@/i18n/message-loader", () => ({
  getLocaleFromCookie: async () => "en",
}));

jest.mock("next-intl/server", () => ({
  getTranslations: async () => (key: string) =>
    ({
      "navigation.knowledgeBase": "Knowledge Base",
      emptyPublicKb: "No published articles yet.",
    })[key] ?? key,
}));

jest.mock("next/navigation", () => ({
  notFound: (...args: unknown[]) => mockNotFound(...args),
  redirect: (...args: unknown[]) => mockRedirect(...args),
}));

jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: {
    from: (...args: unknown[]) => mockAdminFrom(...args),
  },
}));

// Public KB visitors are usually anonymous: the session client is anon, which
// can read published articles but not companies.
jest.mock("@/lib/supabase/server", () => ({
  createReadOnlyClient: async () => ({
    from: (...args: unknown[]) => mockVisitorFrom(...args),
    auth: { getUser: async () => ({ data: { user: null } }) },
  }),
}));

import { renderToStaticMarkup } from "react-dom/server";
import PublicKBLandingPage from "./page";

function visitorQuery(table: string) {
  const result =
    table === "kb_articles"
      ? { data: [], error: null }
      : {
          data: null,
          error: { code: "42501", message: `permission denied for ${table}` },
        };
  const query: Record<string, unknown> = {};
  for (const method of ["select", "in", "eq", "not", "order", "limit"]) {
    query[method] = () => query;
  }
  query.returns = async () => result;
  query.maybeSingle = async () => result;
  return query;
}

describe("PublicKBLandingPage", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockVisitorFrom.mockImplementation((table: string) => visitorQuery(table));
    mockAdminFrom.mockReturnValue({
      select: () => ({
        eq: (...args: unknown[]) => {
          mockCompanyEq(...args);
          return {
            maybeSingle: async () => ({
              data: { name: "Acme Support", slug: "acme" },
              error: null,
            }),
          };
        },
      }),
    });
  });

  it("titles an empty knowledge base with the company name read on the server", async () => {
    const page = await PublicKBLandingPage({
      params: Promise.resolve({ companySlug: "acme" }),
    });
    const markup = renderToStaticMarkup(page);

    expect(mockAdminFrom).toHaveBeenCalledWith("companies");
    expect(mockCompanyEq).toHaveBeenCalledWith("slug", "acme");
    expect(mockVisitorFrom).not.toHaveBeenCalledWith("companies");
    expect(markup).toContain("Acme Support Knowledge Base");
    expect(mockRedirect).not.toHaveBeenCalled();
    expect(mockNotFound).not.toHaveBeenCalled();
  });
});
