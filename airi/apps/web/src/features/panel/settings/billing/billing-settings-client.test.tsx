/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import useSWR from "swr";
import { useCompanyLimits } from "@/hooks/use-company-limits";
import { startBillingCheckout } from "@/lib/billing/client-checkout";
import { BillingSettingsClient } from "./billing-settings-client";

jest.mock("swr", () => ({ __esModule: true, default: jest.fn() }));
jest.mock("@/hooks/use-company-limits", () => ({
  useCompanyLimits: jest.fn(),
}));
jest.mock("@/lib/billing/client-checkout", () => ({
  startBillingCheckout: jest.fn(),
}));
jest.mock("next-intl", () => ({
  useLocale: () => "en",
  useTranslations: () => (key: string) => {
    const messages = jest.requireActual(
      "../../../../../messages/settings/billing/en/page.json"
    ).BillingSettings;
    return key.split(".").reduce((value, part) => value[part], messages);
  },
}));
const useSWRMock = useSWR as jest.Mock;
const summary = {
  provider: "paddle",
  billingConfigured: true,
  invoices: [],
  subscription: null,
  paymentMethod: null,
};

describe("BillingSettingsClient", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest
      .mocked(useCompanyLimits)
      .mockReturnValue({ data: { subscriptionType: "free" } } as never);
    useSWRMock.mockReturnValue({
      data: summary,
      isLoading: false,
      mutate: jest.fn(),
    });
  });

  it("does not expose deployment config or actions while checkout is unavailable", () => {
    useSWRMock.mockReturnValue({
      data: {
        ...summary,
        billingConfigured: false,
        missingConfiguration: ["PADDLE_API_KEY"],
      },
      isLoading: false,
    });
    render(
      <BillingSettingsClient workspaceId="workspace-1" canManageBilling />
    );
    expect(screen.getByText("Checkout unavailable")).toBeInTheDocument();
    expect(screen.queryByText(/PADDLE_API_KEY/)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", {
        name: /upgrade|cancel|reactivate|update card/i,
      })
    ).not.toBeInTheDocument();
  });

  it("uses the actual Free plan and offers checkout only for a new subscription", async () => {
    render(
      <BillingSettingsClient workspaceId="workspace-1" canManageBilling />
    );
    expect(screen.getByText("Free plan")).toBeInTheDocument();
    expect(screen.queryByText("Pro plan")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Upgrade to Pro" }));
    await waitFor(() =>
      expect(startBillingCheckout).toHaveBeenCalledWith(
        "workspace-1",
        "monthly"
      )
    );
  });

  it.each(["active", "trialing", "past_due"])(
    "does not start another checkout for an existing %s subscription",
    status => {
      jest
        .mocked(useCompanyLimits)
        .mockReturnValue({ data: { subscriptionType: "pro" } } as never);
      useSWRMock.mockReturnValue({
        data: {
          ...summary,
          subscription: { status, cancel_at_period_end: false },
        },
        isLoading: false,
      });
      render(
        <BillingSettingsClient workspaceId="workspace-1" canManageBilling />
      );
      expect(
        screen.queryByRole("button", { name: /upgrade|update card/i })
      ).not.toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Cancel renewal" })
      ).toBeInTheDocument();
    }
  );

  it("does not offer a Pro checkout to Enterprise", () => {
    jest
      .mocked(useCompanyLimits)
      .mockReturnValue({ data: { subscriptionType: "enterprise" } } as never);
    render(
      <BillingSettingsClient workspaceId="workspace-1" canManageBilling />
    );
    expect(screen.getByText("Enterprise plan")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Upgrade to Pro" })
    ).not.toBeInTheDocument();
  });

  it("keeps members in a read-only view", () => {
    render(<BillingSettingsClient workspaceId="workspace-1" />);
    expect(
      screen.getByText("An admin can manage billing.")
    ).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("offers local refresh after a failed initial load", () => {
    const mutate = jest.fn();
    useSWRMock.mockReturnValue({
      data: undefined,
      error: new Error("unavailable"),
      isLoading: false,
      mutate,
    });
    render(
      <BillingSettingsClient workspaceId="workspace-1" canManageBilling />
    );
    expect(screen.getByText("Could not load billing")).toBeInTheDocument();
    expect(screen.queryByText("No invoices yet.")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(mutate).toHaveBeenCalledTimes(1);
  });

  it("shows plan loading without guessing Free or offering checkout", () => {
    jest
      .mocked(useCompanyLimits)
      .mockReturnValue({ data: undefined, isLoading: true } as never);
    render(
      <BillingSettingsClient workspaceId="workspace-1" canManageBilling />
    );
    expect(
      screen.getByRole("status", { name: "Loading plan" })
    ).toBeInTheDocument();
    expect(screen.queryByText("Free plan")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Upgrade to Pro" })
    ).not.toBeInTheDocument();
  });

  it("refreshes both billing and plan data after a failed plan read", () => {
    const mutateLimits = jest.fn();
    const mutateBilling = jest.fn();
    jest
      .mocked(useCompanyLimits)
      .mockReturnValue({
        data: undefined,
        error: new Error("unavailable"),
        isLoading: false,
        mutate: mutateLimits,
      } as never);
    useSWRMock.mockReturnValue({
      data: summary,
      isLoading: false,
      mutate: mutateBilling,
    });
    render(
      <BillingSettingsClient workspaceId="workspace-1" canManageBilling />
    );
    expect(
      screen.getByText("Could not load the current plan")
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Upgrade to Pro" })
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(mutateLimits).toHaveBeenCalledTimes(1);
    expect(mutateBilling).toHaveBeenCalledTimes(1);
  });

  it("keeps saved data visible after a refresh failure and disables billing actions", () => {
    useSWRMock.mockReturnValue({
      data: summary,
      error: new Error("refresh failed"),
      isLoading: false,
    });
    render(
      <BillingSettingsClient workspaceId="workspace-1" canManageBilling />
    );
    expect(
      screen.getByText("Billing could not be refreshed. Showing saved data.")
    ).toBeInTheDocument();
    expect(screen.getByText("Free plan")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Upgrade to Pro" })
    ).not.toBeInTheDocument();
  });

  it("handles an invalid billing date without crashing", () => {
    useSWRMock.mockReturnValue({
      data: {
        ...summary,
        subscription: { status: "active", current_period_end: "invalid" },
      },
      isLoading: false,
    });
    render(<BillingSettingsClient workspaceId="workspace-1" />);
    expect(screen.getByText("Date unavailable")).toBeInTheDocument();
  });
});
