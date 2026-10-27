/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { render, screen, within } from "@testing-library/react";
import LimitsSettingsPage from "./route";

const mockAccess = jest.fn();
const mockSummaries = jest.fn();
const mockAllowance = jest.fn();
jest.mock("next-intl/server", () => ({
  getLocale: async () => "en",
  getTranslations:
    async () => (key: string, values?: Record<string, string | number>) => {
      const messages = jest.requireActual(
        "../../../../../messages/settings/limits/en/page.json"
      ).LimitsSettings;
      const value: string = key
        .split(".")
        .reduce((current, part) => current[part], messages);
      return value.replace(/\{(\w+)\}/g, (_match, name: string) =>
        String(values?.[name] ?? name)
      );
    },
}));
jest.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: {} }));
jest.mock("@/lib/limits/internal-limits-access", () => ({
  resolveInternalLimitsAccess: (...args: unknown[]) => mockAccess(...args),
}));
jest.mock("@/lib/limits/company-limit-summaries", () => ({
  getCompanyLimitSummaries: (...args: unknown[]) => mockSummaries(...args),
}));
jest.mock("@/lib/ai/workspace-ai-policy", () => ({
  getWorkspaceTextAiAllowance: (...args: unknown[]) => mockAllowance(...args),
}));
jest.mock("next/navigation", () => ({
  redirect: () => {
    throw new Error("redirect");
  },
  notFound: () => {
    throw new Error("not-found");
  },
}));
jest.mock("@/components/ai/workspace-text-ai-allowance", () => ({
  WorkspaceTextAiAllowance: ({
    allowance,
  }: {
    allowance?: { status: string; remainingActions?: number };
  }) => (
    <div>
      {allowance?.status === "available"
        ? `Shared monthly AI: ${allowance.remainingActions} left`
        : "AI usage unavailable"}
    </div>
  ),
}));

const company = (id: string, plan: string) => ({
  company: { id, name: `${plan} company`, slug: plan, createdAt: null },
  workspaces: [
    { id: `${id}-workspace`, name: "Main workspace", createdAt: null },
  ],
  isInternalCompany: false,
  trial: { fullDaysRemaining: 0 },
  snapshot: { missing: false, updatedAt: null },
  limit: {
    subscriptionType: plan,
    integrationConnectionCounts: {},
    conversationLimit: null,
    airiAutoReplyCount: 12,
    airiAutoReplyLimit: plan === "pro" ? null : 100,
    classificationCount: 13,
    classificationLimit: plan === "pro" ? null : 500,
    coachCount: 14,
    coachLimit: plan === "pro" ? null : 500,
    studioChatCount: 15,
    studioChatLimit: plan === "pro" ? null : 500,
  },
});

describe("internal company limits monthly AI cells", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAccess.mockResolvedValue({ ok: true });
    mockSummaries.mockResolvedValue({
      companies: [company("one", "pro"), company("two", "free")],
      generatedAt: null,
      rowLimit: 500,
      truncated: false,
    });
    mockAllowance.mockResolvedValue({
      companyId: "one",
      plan: "pro",
      remainingActions: 475,
    });
  });

  it("replaces Pro's four unlimited AI cells with the shared monthly allowance", async () => {
    render(
      await LimitsSettingsPage({
        params: Promise.resolve({ workspaceId: "admin-workspace" }),
      })
    );
    const proRow = screen.getByText("pro company").closest("tr")!;
    expect(
      within(proRow).getByText("Shared monthly AI: 475 left")
    ).toBeInTheDocument();
    expect(
      within(proRow).queryByText("12 / unlimited")
    ).not.toBeInTheDocument();
    const freeRow = screen.getByText("free company").closest("tr")!;
    expect(within(freeRow).getByText("12 / 100")).toBeInTheDocument();
    expect(mockAllowance).toHaveBeenCalledTimes(1);
    expect(mockAllowance).toHaveBeenCalledWith("one-workspace");
  });

  it("keeps an unavailable monthly read explicit", async () => {
    mockAllowance.mockRejectedValue(new Error("database unavailable"));
    render(
      await LimitsSettingsPage({
        params: Promise.resolve({ workspaceId: "admin-workspace" }),
      })
    );
    expect(screen.getByText("AI usage unavailable")).toBeInTheDocument();
  });

  it("does not read company AI state before internal-admin authorization", async () => {
    mockAccess.mockResolvedValue({ ok: false, status: 403 });
    await expect(
      LimitsSettingsPage({
        params: Promise.resolve({ workspaceId: "admin-workspace" }),
      })
    ).rejects.toThrow("not-found");
    expect(mockAllowance).not.toHaveBeenCalled();
    expect(mockSummaries).not.toHaveBeenCalled();
  });

  it("shows unavailable usage without inventing zero counts for a missing snapshot", async () => {
    mockSummaries.mockResolvedValue({
      companies: [
        {
          ...company("missing", "free"),
          snapshot: { missing: true, updatedAt: null },
        },
      ],
      generatedAt: null,
      rowLimit: 500,
      truncated: false,
    });
    render(
      await LimitsSettingsPage({
        params: Promise.resolve({ workspaceId: "admin-workspace" }),
      })
    );
    const row = screen.getByText("free company").closest("tr")!;
    expect(within(row).getAllByText("Unavailable").length).toBeGreaterThan(1);
    expect(within(row).queryByText("12 / 100")).not.toBeInTheDocument();
  });

  it("leaves WhatsApp numbers out of the connections-per-integration figure", async () => {
    const pro = company("numbers", "pro");
    mockSummaries.mockResolvedValue({
      companies: [
        {
          ...pro,
          limit: {
            ...pro.limit,
            whatsappNumberCount: 2,
            whatsappNumberLimit: 3,
            whatsappNumbersRemaining: 1,
            integrationConnectionLimit: 1,
            integrationConnectionCounts: { whatsapp: 2, telegram: 1 },
          },
        },
      ],
      generatedAt: null,
      rowLimit: 500,
      truncated: false,
    });
    render(
      await LimitsSettingsPage({
        params: Promise.resolve({ workspaceId: "admin-workspace" }),
      })
    );

    const quota = (label: string) =>
      screen.getByText(label, { selector: "dt" }).closest("div")!;
    expect(
      within(quota("WhatsApp numbers")).getByText("2 / 3")
    ).toBeInTheDocument();
    expect(
      within(quota("Connections per integration")).getByText("1 / 1")
    ).toBeInTheDocument();
  });

  it("does not count a Free plan with no trial end as an active trial", async () => {
    render(
      await LimitsSettingsPage({
        params: Promise.resolve({ workspaceId: "admin-workspace" }),
        searchParams: Promise.resolve({ status: "active_trial" }),
      })
    );
    expect(screen.queryByText("free company")).not.toBeInTheDocument();
    expect(
      screen.getByText("No companies match these filters.")
    ).toBeInTheDocument();
  });

  it("preserves a known workspace limit even when usage snapshots are missing", async () => {
    const missing = company("missing", "free");
    mockSummaries.mockResolvedValue({
      companies: [
        {
          ...missing,
          snapshot: { missing: true, updatedAt: null },
          limit: { ...missing.limit, workspaceExhausted: true },
        },
      ],
      generatedAt: null,
      rowLimit: 500,
      truncated: false,
    });
    render(
      await LimitsSettingsPage({
        params: Promise.resolve({ workspaceId: "admin-workspace" }),
        searchParams: Promise.resolve({ status: "exhausted" }),
      })
    );
    expect(screen.getByText("free company")).toBeInTheDocument();
    expect(
      screen.getByText("At a limit", { selector: '[data-slot="badge"]' })
    ).toBeInTheDocument();
  });

  it("includes Pro without customer AI in the limit filter when its live allowance is exhausted", async () => {
    mockAllowance.mockResolvedValue({
      companyId: "one",
      plan: "pro",
      remainingActions: 0,
      hasCustomerSource: false,
    });
    render(
      await LimitsSettingsPage({
        params: Promise.resolve({ workspaceId: "admin-workspace" }),
        searchParams: Promise.resolve({ status: "exhausted" }),
      })
    );
    expect(screen.getByText("pro company")).toBeInTheDocument();
    expect(screen.queryByText("free company")).not.toBeInTheDocument();
  });

  it("does not mark Pro as blocked by the platform allowance when customer AI can continue", async () => {
    mockAllowance.mockResolvedValue({
      companyId: "one",
      plan: "pro",
      remainingActions: 0,
      hasCustomerSource: true,
    });
    render(
      await LimitsSettingsPage({
        params: Promise.resolve({ workspaceId: "admin-workspace" }),
        searchParams: Promise.resolve({ status: "exhausted" }),
      })
    );
    expect(screen.queryByText("pro company")).not.toBeInTheDocument();
  });
});
