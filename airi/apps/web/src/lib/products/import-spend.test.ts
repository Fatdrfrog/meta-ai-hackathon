/** @jest-environment node */

const mockAllowance = jest.fn();
let mockCompany: {
  data: unknown;
  error: { message: string } | null;
} = { data: null, error: null };
const mockWorkspaceFilters: unknown[] = [];

class MockPolicyUnavailableError extends Error {
  readonly code = "workspace_ai_policy_unavailable";
}

jest.mock("@/lib/ai/workspace-ai-policy", () => ({
  getWorkspaceTextAiAllowance: (...args: unknown[]) => mockAllowance(...args),
  WorkspaceAiPolicyUnavailableError: MockPolicyUnavailableError,
}));
jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: {
    from: (table: string) => ({
      select: (columns: string) => ({
        eq: (column: string, value: unknown) => {
          mockWorkspaceFilters.push({ table, columns, column, value });
          return { maybeSingle: async () => mockCompany };
        },
      }),
    }),
  },
}));

import { productImportSpend } from "./import-spend";

const NOW = new Date("2026-10-30T12:00:00.000Z");
const company = (subscription_type: string | null, trial_ends_at: unknown) => ({
  data: { companies: { subscription_type, trial_ends_at } },
  error: null,
});

beforeEach(() => {
  jest.spyOn(Date, "now").mockReturnValue(NOW.getTime());
  mockWorkspaceFilters.length = 0;
  mockAllowance.mockReset().mockResolvedValue({
    includedActions: 100,
    remainingActions: 97,
    spendLimitReached: false,
  });
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("productImportSpend.allowance", () => {
  it("says the trial ended for a free company the ledger won't admit", async () => {
    // The trial ended yesterday, or never started: the ledger refuses every
    // new action, though the projection shows actions left.
    for (const ends of ["2026-10-29T12:00:00+00:00", null]) {
      mockCompany = company("free", ends);
      expect(await productImportSpend.allowance("workspace-1")).toEqual({
        includedActions: 100,
        remainingActions: 97,
        spendLimitReached: false,
        spendRemainingMicros: null,
        trialEnded: true,
      });
    }
    // A company with no plan set is on the free plan.
    mockCompany = company(null, "2026-10-30T12:00:00.000Z");
    expect((await productImportSpend.allowance("workspace-1")).trialEnded).toBe(
      true
    );
    expect(mockWorkspaceFilters.at(-1)).toEqual({
      table: "workspaces",
      columns:
        "companies!workspaces_company_id_fkey(subscription_type, trial_ends_at)",
      column: "id",
      value: "workspace-1",
    });
  });

  it("lets a running trial, and every paid plan, start", async () => {
    mockCompany = company("free", "2026-11-05T00:00:00+00:00");
    expect((await productImportSpend.allowance("workspace-1")).trialEnded).toBe(
      false
    );
    for (const plan of ["pro", "enterprise"]) {
      mockCompany = company(plan, null);
      expect(
        (await productImportSpend.allowance("workspace-1")).trialEnded
      ).toBe(false);
    }
    // Joined as a list, the way PostgREST may embed it.
    mockCompany = {
      data: { companies: [{ subscription_type: "pro", trial_ends_at: null }] },
      error: null,
    };
    expect((await productImportSpend.allowance("workspace-1")).trialEnded).toBe(
      false
    );
  });

  it("says the spend left is unknown, never zero, since this copy's allowance doesn't report it", async () => {
    mockCompany = company("pro", null);
    mockAllowance.mockResolvedValue({
      includedActions: 500,
      remainingActions: 480,
      spendLimitReached: false,
    });
    expect(await productImportSpend.allowance("workspace-1")).toEqual({
      includedActions: 500,
      remainingActions: 480,
      spendLimitReached: false,
      spendRemainingMicros: null,
      trialEnded: false,
    });
  });

  it("can't be checked when the company can't be read, so the import retries", async () => {
    mockCompany = { data: null, error: { message: "connection reset" } };
    await expect(
      productImportSpend.allowance("workspace-1")
    ).rejects.toBeInstanceOf(MockPolicyUnavailableError);

    mockCompany = { data: { companies: null }, error: null };
    await expect(
      productImportSpend.allowance("workspace-1")
    ).rejects.toMatchObject({ code: "workspace_ai_policy_unavailable" });
  });
});
