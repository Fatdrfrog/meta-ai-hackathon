/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import { CompanyLimitStatus } from "./company-limit-status";
import messages from "../../../messages/en.json";

const mockUseCompanyLimits = jest.fn();
jest.mock("@/hooks/use-company-limits", () => ({
  useCompanyLimits: () => mockUseCompanyLimits(),
}));
jest.mock("@/components/ui/sidebar", () => ({
  SidebarGroup: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));
jest.mock("next-intl", () => ({
  useLocale: () => "en",
  useTranslations:
    (namespace: string) =>
    (key: string, values: Record<string, unknown> = {}) => {
      const copy = (
        namespace.endsWith("textAi")
          ? messages.AppSidebar.limits.textAi
          : messages.AppSidebar.limits
      ) as Record<string, unknown>;
      return String(copy[key] ?? key).replace(/\{(\w+)\}/g, (_, name: string) =>
        String(values[name])
      );
    },
}));

describe("company limit sidebar", () => {
  it("keeps the existing Free conversation warning", () => {
    mockUseCompanyLimits.mockReturnValue({
      data: {
        subscriptionType: "free",
        exhausted: true,
        conversationsRemaining: 0,
        conversationLimit: 500,
      },
    });
    render(<CompanyLimitStatus workspaceId="workspace-1" />);
    expect(screen.getByText("No conversation limits left")).toBeInTheDocument();
    expect(screen.getByText("0 of 500 left")).toBeInTheDocument();
    expect(screen.queryByText(/text AI actions/)).not.toBeInTheDocument();
  });

  it("shows Pro monthly usage even when conversations are unlimited", () => {
    mockUseCompanyLimits.mockReturnValue({
      data: {
        subscriptionType: "pro",
        exhausted: false,
        textAiAllowance: {
          status: "available",
          workspaceId: "workspace-1",
          companyId: "company-1",
          plan: "pro",
          includedActions: 500,
          usedActions: 50,
          remainingActions: 450,
          resetAt: null, allowancePeriod: "lifetime", spendLimitReached: false,
          hasCustomerSource: false,
        },
      },
    });
    render(<CompanyLimitStatus workspaceId="workspace-1" />);
    expect(
      screen.getByText(/450 of 500 included text AI actions/)
    ).toBeInTheDocument();
    expect(
      screen.queryByText("No conversation limits left")
    ).not.toBeInTheDocument();
  });

  it("does not keep showing stale balances after a failed refresh", () => {
    mockUseCompanyLimits.mockReturnValue({
      error: new Error("unavailable"),
      data: {
        subscriptionType: "pro",
        exhausted: false,
        textAiAllowance: {
          status: "available",
          workspaceId: "workspace-1",
          plan: "pro",
          includedActions: 500,
          remainingActions: 450,
          resetAt: null, allowancePeriod: "lifetime", spendLimitReached: false,
        },
      },
    });
    render(<CompanyLimitStatus workspaceId="workspace-1" />);
    expect(
      screen.getByText(/AI usage is temporarily unavailable/)
    ).toBeInTheDocument();
    expect(screen.queryByText(/450/)).not.toBeInTheDocument();
  });

  it("does not introduce a Pro allowance for Enterprise", () => {
    mockUseCompanyLimits.mockReturnValue({
      data: { subscriptionType: "enterprise", exhausted: false },
    });
    const { container } = render(
      <CompanyLimitStatus workspaceId="workspace-1" />
    );
    expect(container).toBeEmptyDOMElement();
  });
});
