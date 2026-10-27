/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import messages from "../../../messages/en.json";
import type { WorkspaceTextAiAllowanceStatus } from "@/hooks/use-company-limits";
import { WorkspaceTextAiAllowance } from "./workspace-text-ai-allowance";

jest.mock("next-intl", () => ({
  useLocale: () => "en",
  useTranslations:
    () =>
    (key: string, values: Record<string, unknown> = {}) => {
      const copy = (
        messages.AppSidebar.limits as unknown as {
          textAi: Record<string, string>;
        }
      ).textAi;
      return (copy?.[key] ?? key).replace(/\{(\w+)\}/g, (_, name: string) =>
        String(values[name] ?? `{${name}}`)
      );
    },
}));

const available: WorkspaceTextAiAllowanceStatus = {
  status: "available",
  workspaceId: "workspace-1",
  companyId: "company-1",
  plan: "pro",
  includedActions: 500,
  usedActions: 25,
  remainingActions: 475,
  periodStart: "2026-09-01T00:00:00.000Z",
  resetAt: null,
  allowancePeriod: "lifetime",
  spendLimitReached: false,
  hasCustomerSource: false,
};
const renderAllowance = (
  allowance: WorkspaceTextAiAllowanceStatus | undefined,
  loading = false
) =>
  render(
    <WorkspaceTextAiAllowance
      workspaceId="workspace-1"
      allowance={allowance}
      loading={loading}
    />
  );

describe("workspace lifetime text AI allowance", () => {
  it("shows remaining actions and company-wide sharing without promising a refill", () => {
    renderAllowance(available);
    expect(screen.getByText(/475 of 500/)).toBeInTheDocument();
    expect(
      screen.getByText(/shared across company workspaces/i)
    ).toBeInTheDocument();
    expect(screen.getByText(/does not reset/i)).toBeInTheDocument();
    expect(screen.queryByText(/Oct 1, 2026/)).not.toBeInTheDocument();
  });

  it("shows the connected key as future billing while included actions remain", () => {
    renderAllowance({ ...available, hasCustomerSource: true });
    expect(
      screen.getByText(/Google key will be used after/i)
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/now uses your Google key/i)
    ).not.toBeInTheDocument();
  });

  it("links an exhausted workspace to its Google AI integration", () => {
    renderAllowance({ ...available, usedActions: 500, remainingActions: 0 });
    expect(
      screen.getByText(/included text AI allowance is used up/i)
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Connect Google AI" })
    ).toHaveAttribute(
      "href",
      "/panel/w/workspace-1/settings/integrations?integration=google_ai"
    );
  });

  it("shows customer billing after exhaustion when a source exists", () => {
    renderAllowance({
      ...available,
      usedActions: 500,
      remainingActions: 0,
      hasCustomerSource: true,
    });
    expect(screen.getByText(/now uses your Google key/i)).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("shows the spend stop without erasing unused actions", () => {
    renderAllowance({ ...available, spendLimitReached: true });
    expect(screen.getByText(/475 of 500/)).toBeInTheDocument();
    expect(screen.getByText(/included AI spending limit has been reached/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Connect Google AI" })).toBeInTheDocument();
    expect(screen.queryByText(/allowance is used up/i)).not.toBeInTheDocument();
  });

  it("shows customer billing when spend is exhausted before the action count", () => {
    renderAllowance({ ...available, spendLimitReached: true, hasCustomerSource: true });
    expect(screen.getByText(/now uses your Google key/i)).toBeInTheDocument();
    expect(screen.queryByText(/Google key will be used after/i)).not.toBeInTheDocument();
  });

  it.each([
    undefined,
    { status: "unavailable" } as const,
    { ...available, workspaceId: "other-workspace" },
  ])(
    "does not invent usage when data is missing, unavailable or from another workspace",
    allowance => {
      renderAllowance(allowance);
      expect(
        screen.getByText(/AI usage is temporarily unavailable/i)
      ).toBeInTheDocument();
      expect(screen.queryByText(/of 500/)).not.toBeInTheDocument();
      expect(screen.queryByText(/used up/)).not.toBeInTheDocument();
    }
  );

  it("announces the loading state without a fake balance", () => {
    renderAllowance(undefined, true);
    expect(screen.getByLabelText("Loading AI usage")).toBeInTheDocument();
    expect(screen.queryByText(/of 500/)).not.toBeInTheDocument();
  });
});
