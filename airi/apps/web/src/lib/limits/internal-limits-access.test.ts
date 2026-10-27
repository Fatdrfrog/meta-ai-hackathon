const mockCreateClient = jest.fn();
const mockSupabaseAdminFrom = jest.fn();

jest.mock("@/lib/supabase/server", () => ({
  createClient: (...args: unknown[]) => mockCreateClient(...args),
}));

jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: {
    from: (...args: unknown[]) => mockSupabaseAdminFrom(...args),
  },
}));

import {
  canAccessInternalLimits,
  resolveInternalLimitsAccess,
} from "./internal-limits-access";
import { createSupabaseQueryMock } from "@/test-support/supabase-query-test-utils";

const createMembershipQuery = (data: unknown) =>
  createSupabaseQueryMock({ data, error: null });
const createWorkspaceQuery = createMembershipQuery;

describe("resolveInternalLimitsAccess", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCreateClient.mockResolvedValue({
      auth: {
        getUser: jest.fn(async () => ({
          data: {
            user: { id: "user-1", app_metadata: { platform_role: "admin" } },
          },
        })),
      },
      from: jest.fn(() => createMembershipQuery({ role: "admin" })),
    });
    mockSupabaseAdminFrom.mockReturnValue(
      createWorkspaceQuery({
        company_id: "company-airi",
        companies: { id: "company-airi", name: "Airi.chat", slug: "airichat" },
      })
    );
  });

  it("allows platform admins with exact workspace membership", async () => {
    const access = await resolveInternalLimitsAccess("workspace-1");

    expect(access).toEqual({
      ok: true,
      companyId: "company-airi",
      role: "admin",
      userId: "user-1",
      workspaceId: "workspace-1",
    });
    await expect(canAccessInternalLimits("workspace-1")).resolves.toBe(true);
  });

  it("denies workspace managers without platform authority before reading cross-company data", async () => {
    const membershipQuery = createMembershipQuery({ role: "manager" });
    mockCreateClient.mockResolvedValue({
      auth: {
        getUser: jest.fn(async () => ({
          data: { user: { id: "user-1" } },
        })),
      },
      from: jest.fn(() => membershipQuery),
    });

    const access = await resolveInternalLimitsAccess("workspace-1");

    expect(access).toEqual({
      ok: false,
      status: 403,
      error: "Forbidden",
    });
    expect(mockSupabaseAdminFrom).not.toHaveBeenCalled();
  });

  it("allows platform admins regardless of company name", async () => {
    mockSupabaseAdminFrom.mockReturnValue(
      createWorkspaceQuery({
        company_id: "company-other",
        companies: {
          id: "company-other",
          name: "Other Company",
          slug: "other-company",
        },
      })
    );

    const access = await resolveInternalLimitsAccess("workspace-2");

    expect(access).toMatchObject({ ok: true, companyId: "company-other" });
  });

  it("keeps platform authority separate from the manager workspace role", async () => {
    const client = await mockCreateClient();
    client.from.mockReturnValue(createMembershipQuery({ role: "manager" }));
    await expect(
      resolveInternalLimitsAccess("workspace-1")
    ).resolves.toMatchObject({
      ok: true,
      role: "manager",
    });
  });

  it.each([undefined, { platform_role: "member" }])(
    "denies workspace admins in a company named airi.chat without trusted platform authority (%s)",
    async appMetadata => {
      mockCreateClient.mockResolvedValue({
        auth: {
          getUser: jest.fn(async () => ({
            data: {
              user: {
                id: "user-1",
                app_metadata: appMetadata,
                user_metadata: { platform_role: "admin" },
              },
            },
          })),
        },
        from: jest.fn(() => createMembershipQuery({ role: "admin" })),
      });

      await expect(
        resolveInternalLimitsAccess("workspace-1")
      ).resolves.toMatchObject({
        ok: false,
        status: 403,
      });
      expect(mockSupabaseAdminFrom).not.toHaveBeenCalled();
    }
  );

  it("denies a platform admin without membership in the selected workspace", async () => {
    const client = await mockCreateClient();
    client.from.mockReturnValue(createMembershipQuery(null));
    await expect(
      resolveInternalLimitsAccess("another-workspace")
    ).resolves.toMatchObject({
      ok: false,
      status: 403,
    });
    expect(mockSupabaseAdminFrom).not.toHaveBeenCalled();
  });
});
