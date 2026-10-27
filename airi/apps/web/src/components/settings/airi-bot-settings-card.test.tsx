/**
 * @jest-environment jsdom
 */

import "@testing-library/jest-dom";
import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AiriBotSettingsCard } from "./airi-bot-settings-card";

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) => {
    if (key === "botSettings.coverage") {
      return `${values?.enabled}/${values?.total} enabled`;
    }
    return key;
  },
}));

jest.mock("sonner", () => ({
  toast: {
    error: jest.fn(),
    success: jest.fn(),
  },
}));

jest.mock("@/components/settings/airi-manager-guard-card", () => ({
  AiriManagerGuardCard: () => <div data-testid="manager-guard" />,
}));

jest.mock("@/hooks/use-company-limits", () => ({
  useCompanyLimits: () => ({ data: { subscriptionType: "pro" } }),
}));

jest.mock("@/components/ui/alert", () => ({
  Alert: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDescription: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  AlertTitle: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

jest.mock("@/components/ui/button", () => ({
  Button: ({ children, ...props }: React.ComponentProps<"button">) => (
    <button {...props}>{children}</button>
  ),
}));

jest.mock("@/components/ui/card", () => ({
  Card: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CardContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  CardDescription: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  CardHeader: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  CardTitle: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

jest.mock("@/components/ui/input", () => ({
  Input: (props: React.ComponentProps<"input">) => <input {...props} />,
}));

jest.mock("@/components/ui/label", () => ({
  Label: ({ children }: { children: React.ReactNode }) => (
    <label>{children}</label>
  ),
}));

jest.mock("@/components/ui/select", () => ({
  Select: ({
    children,
    value,
  }: {
    children: React.ReactNode;
    value?: string;
  }) => (
    <div data-value={value} role="listbox">
      {children}
    </div>
  ),
  SelectContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  SelectItem: ({
    children,
    value,
  }: {
    children: React.ReactNode;
    value: string;
  }) => <div data-value={value}>{children}</div>,
  SelectTrigger: ({ children }: { children: React.ReactNode }) => (
    <button type="button">{children}</button>
  ),
  SelectValue: () => <span />,
}));

jest.mock("@/components/ui/switch", () => ({
  Switch: ({
    checked,
    disabled,
    onCheckedChange,
  }: {
    checked: boolean;
    disabled?: boolean;
    onCheckedChange: (checked: boolean) => void;
  }) => (
    <button
      disabled={disabled}
      type="button"
      onClick={() => onCheckedChange(!checked)}
    >
      {checked ? "on" : "off"}
    </button>
  ),
}));

describe("AiriBotSettingsCard", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("allows enabling all conversations when the default is already enabled but some conversations are off", async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          defaultBotEnabled: true,
          defaultScenariosEnabled: false,
          defaultCoachEnabled: true,
          retrievalQueryMode: "adaptive",
          includeRecentConversationInRetrievalContext: true,
          sendKbArticleLinksToUserChannels: false,
          languageBias: "none",
          totalConversations: 3,
          enabledConversations: 2,
          scenariosEnabledConversations: 0,
          coachEnabledConversations: 3,
          publishedKbArticlesCount: 0,
          shouldShowOnboardingHint: false,
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          defaultBotEnabled: true,
          defaultScenariosEnabled: false,
          defaultCoachEnabled: true,
          retrievalQueryMode: "adaptive",
          includeRecentConversationInRetrievalContext: true,
          sendKbArticleLinksToUserChannels: false,
          languageBias: "none",
          totalConversations: 3,
          enabledConversations: 3,
          scenariosEnabledConversations: 0,
          coachEnabledConversations: 3,
        }),
      });
    global.fetch = fetchMock as jest.Mock;

    render(<AiriBotSettingsCard workspaceId="workspace_1" />);

    expect(await screen.findByText("2/3 enabled")).toBeInTheDocument();
    const enableAllButton = screen.getByRole("button", {
      name: "botSettings.enableButton",
    });
    expect(enableAllButton).not.toBeDisabled();

    fireEvent.click(enableAllButton);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/workspaces/workspace_1/airi-bot",
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({ enabled: true, applyToExisting: true }),
        })
      );
    });
  });
  it("shows failed loads with retry and no rollout controls", async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue({
        ok: false,
        json: async () => ({ error: "unavailable" }),
      });
    render(<AiriBotSettingsCard workspaceId="workspace_1" />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "botSettings.loadFailed"
    );
    expect(
      screen.queryByRole("button", { name: "botSettings.enableButton" })
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "retry" })).toBeInTheDocument();
  });

  it("allows repairing mixed scenario coverage even when its new-chat default is already on", async () => {
    const settings = {
      success: true,
      defaultBotEnabled: true,
      defaultScenariosEnabled: true,
      defaultCoachEnabled: true,
      totalConversations: 3,
      enabledConversations: 3,
      scenariosEnabledConversations: 1,
      coachEnabledConversations: 3,
    };
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => settings })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ...settings, scenariosEnabledConversations: 3 }),
      });
    render(<AiriBotSettingsCard workspaceId="workspace_1" />);
    fireEvent.click(
      await screen.findByRole("button", { name: "botSettings.enableButton" })
    );
    await waitFor(() =>
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/workspaces/workspace_1/airi-bot",
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({
            scenariosEnabled: true,
            applyScenariosToExisting: true,
          }),
        })
      )
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "botSettings.enableButton" })
      ).not.toBeInTheDocument()
    );
  });

  it("does not falsely mark a failed rollout as enabled", async () => {
    const settings = {
      success: true,
      defaultBotEnabled: false,
      defaultScenariosEnabled: false,
      defaultCoachEnabled: false,
      totalConversations: 3,
      enabledConversations: 0,
      scenariosEnabledConversations: 0,
      coachEnabledConversations: 0,
    };
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => settings })
      .mockResolvedValueOnce({
        ok: false,
        json: async () => ({ error: "unavailable" }),
      });
    render(<AiriBotSettingsCard workspaceId="workspace_1" />);
    fireEvent.click(
      await screen.findByRole("button", { name: "botSettings.enableButton" })
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "botSettings.enableButton" })
      ).not.toBeDisabled()
    );
    expect(screen.getByText("0/3 enabled")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "botSettings.enabledButton" })
    ).not.toBeInTheDocument();
  });
});
