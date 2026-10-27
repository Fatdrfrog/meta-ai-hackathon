/**
 * @jest-environment jsdom
 */

import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import { IntegrationsContent } from "./integrations-content";
import { useCompanyLimits } from "@/hooks/use-company-limits";
import { useIntegrations } from "@/hooks/use-integrations";

let mockSearchParams = new URLSearchParams();

jest.mock("@/hooks/use-company-limits", () => ({
  useCompanyLimits: jest.fn(),
}));

jest.mock("@/hooks/use-integrations", () => ({
  useIntegrations: jest.fn(),
}));

jest.mock("next/navigation", () => ({
  usePathname: () => "/panel/w/workspace-1/settings/integrations",
  useSearchParams: () => mockSearchParams,
}));

jest.mock("@/components/integrations/integrations-onboarding", () => ({
  IntegrationsOnboarding: () => <div data-testid="integrations-onboarding" />,
}));

jest.mock("@/components/integrations/integrations-desktop", () => ({
  IntegrationsDesktop: () => <div data-testid="integrations-list" />,
}));

jest.mock("@/components/integrations/integration-details-panel", () => ({
  IntegrationDetailsPanel: (props: {
    selectedIntegrationId?: string | null;
  }) => (
    <div data-testid="integration-details">
      {props.selectedIntegrationId ?? "none"}
    </div>
  ),
}));

jest.mock("@/components/limits/free-plan-upsell", () => ({
  FreePlanUpsell: () => <div data-testid="free-plan-upsell" />,
}));

describe("IntegrationsContent", () => {
  beforeEach(() => {
    mockSearchParams = new URLSearchParams();
    jest.mocked(useCompanyLimits).mockReturnValue({ data: undefined } as never);
    jest.mocked(useIntegrations).mockReturnValue({
      sources: [],
      removedWhatsAppSource: null,
      emailSources: [],
      emailIntegrationEnabled: true,
      emailProviderStatus: "disconnected",
      emailProviderConnected: false,
      hasCompanyWhatsAppInventory: false,
      isLoading: true,
      isError: undefined,
      mutate: jest.fn(),
    });
  });

  it("does not claim connections are disconnected while loading", () => {
    render(<IntegrationsContent workspaceId="workspace-1" />);

    expect(screen.getByRole("status", { name: "loading" })).toBeInTheDocument();
    expect(
      screen.queryByTestId("integrations-onboarding")
    ).not.toBeInTheDocument();
    expect(screen.queryByTestId("integrations-list")).not.toBeInTheDocument();
    expect(screen.queryByTestId("integration-details")).not.toBeInTheDocument();
  });

  it("offers a local refresh without showing false disconnections after a read failure", () => {
    const mutate = jest.fn();
    jest.mocked(useIntegrations).mockReturnValue({
      sources: [],
      removedWhatsAppSource: null,
      isLoading: false,
      isError: new Error("unavailable"),
      mutate,
    } as never);
    render(<IntegrationsContent workspaceId="workspace-1" />);
    expect(screen.getByRole("alert")).toHaveTextContent("loadError");
    expect(screen.queryByTestId("integrations-list")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "retry" }));
    expect(mutate).toHaveBeenCalledTimes(1);
  });

  it("does not auto-select Google Calendar just because it is disconnected", () => {
    jest.mocked(useIntegrations).mockReturnValue({
      sources: [],
      removedWhatsAppSource: null,
      emailSources: [],
      emailIntegrationEnabled: true,
      emailProviderStatus: "disconnected",
      emailProviderConnected: false,
      hasCompanyWhatsAppInventory: false,
      isLoading: false,
      isError: undefined,
      mutate: jest.fn(),
    });

    render(<IntegrationsContent workspaceId="workspace-1" />);

    expect(screen.getByTestId("integration-details")).toHaveTextContent("none");
  });

  it("keeps new onboarding users on the integrations hub without an integration choice", () => {
    mockSearchParams = new URLSearchParams("new=true");
    jest.mocked(useIntegrations).mockReturnValue({
      sources: [],
      removedWhatsAppSource: null,
      emailSources: [],
      emailIntegrationEnabled: true,
      emailProviderStatus: "disconnected",
      emailProviderConnected: false,
      hasCompanyWhatsAppInventory: false,
      isLoading: false,
      isError: undefined,
      mutate: jest.fn(),
    });

    render(<IntegrationsContent workspaceId="workspace-1" />);

    expect(screen.getByTestId("integration-details")).toHaveTextContent("none");
  });

  it("opens Google Calendar when onboarding explicitly selects it", () => {
    mockSearchParams = new URLSearchParams(
      "new=true&integration=google_calendar"
    );
    jest.mocked(useIntegrations).mockReturnValue({
      sources: [],
      removedWhatsAppSource: null,
      emailSources: [],
      emailIntegrationEnabled: true,
      emailProviderStatus: "disconnected",
      emailProviderConnected: false,
      hasCompanyWhatsAppInventory: false,
      isLoading: false,
      isError: undefined,
      mutate: jest.fn(),
    });

    render(<IntegrationsContent workspaceId="workspace-1" />);

    expect(screen.getByTestId("integration-details")).toHaveTextContent(
      "google_calendar"
    );
  });
});
