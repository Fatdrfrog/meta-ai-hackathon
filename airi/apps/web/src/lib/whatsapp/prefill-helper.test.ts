const mockGetUser = jest.fn();
const mockFrom = jest.fn();
const mockSelect = jest.fn();
const mockGetCompanyIdForWorkspace = jest.fn();

jest.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    auth: { getUser: (...args: unknown[]) => mockGetUser(...args) },
    from: (...args: unknown[]) => mockFrom(...args),
  }),
}));

jest.mock("@/lib/supabase/company-users", () => ({
  getCompanyIdForWorkspace: (...args: unknown[]) =>
    mockGetCompanyIdForWorkspace(...args),
}));

import { getBusinessPrefillData } from "./prefill-helper";

// A subset of the columns production public.companies has (no industry).
const COMPANY_COLUMNS = new Set(["id", "name", "slug", "business_context"]);

describe("getBusinessPrefillData", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetUser.mockResolvedValue({
      data: {
        user: {
          email: "owner@acme.test",
          user_metadata: { phone: "+77010000000" },
        },
      },
    });
    mockGetCompanyIdForWorkspace.mockResolvedValue("company-1");
    mockFrom.mockReturnValue({
      select: (columns: string) => {
        mockSelect(columns);
        // PostgREST fails the whole read when any selected column is missing.
        const missing = columns
          .split(",")
          .map(column => column.trim())
          .some(column => !COMPANY_COLUMNS.has(column));
        return {
          eq: () => ({
            single: async () =>
              missing
                ? {
                    data: null,
                    error: {
                      code: "42703",
                      message: "column companies.industry does not exist",
                    },
                  }
                : { data: { name: "Acme" }, error: null },
          }),
        };
      },
    });
  });

  it("prefills the business name from existing company columns only", async () => {
    await expect(getBusinessPrefillData("workspace-1")).resolves.toEqual({
      businessName: "Acme",
      preferredDisplayName: "Acme Support",
      businessEmail: "owner@acme.test",
      businessPhone: "+77010000000",
    });

    expect(mockGetCompanyIdForWorkspace).toHaveBeenCalledWith(
      expect.anything(),
      "workspace-1"
    );
    expect(mockFrom).toHaveBeenCalledWith("companies");
    expect(mockSelect).toHaveBeenCalledWith("name");
  });

  it("returns nothing for a signed-out visitor", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } });

    await expect(getBusinessPrefillData("workspace-1")).resolves.toEqual({});
    expect(mockFrom).not.toHaveBeenCalled();
  });
});
