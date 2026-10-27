/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { WhatsAppConversionsSettings } from "./whatsapp-conversions-settings";
import messages from "../../../messages/settings/integrations/en/page.json";

const mockMutate = jest.fn();
let mockData: Record<string, unknown> | undefined;
let mockError: Error | undefined;
const mockUseSWR = jest.fn();
jest.mock("swr", () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockUseSWR(...args),
}));
jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) =>
    (messages as unknown as Record<string, Record<string, string>>)
      .WhatsAppConversionsSettings[key] || key,
}));

describe("WhatsApp conversion settings", () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });
  beforeEach(() => {
    jest.clearAllMocks();
    mockMutate.mockReset();
    mockError = undefined;
    mockData = {
      enabled: false,
      datasetId: null,
      wabaId: "waba-1",
      hasWebhookSecret: false,
      webhookEnabled: false,
      webhookUrl: "https://airi.chat/api/conversions/events/source-1",
    };
    mockUseSWR.mockImplementation(() => ({
      data: mockData,
      error: mockError,
      isLoading: !mockData && !mockError,
      mutate: mockMutate,
    }));
  });

  it("enables Meta only after the explicit action", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        ...mockData,
        enabled: true,
        datasetId: "dataset-1",
      }),
    });
    render(
      <WhatsAppConversionsSettings
        workspaceId="workspace-1"
        sourceId="source-1"
      />
    );
    expect(fetch).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", { name: "Enable Meta feedback" })
    );
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        "/api/workspaces/workspace-1/sources/source-1/conversions",
        expect.objectContaining({
          method: "PUT",
          body: JSON.stringify({ action: "enable_meta" }),
        })
      )
    );
  });

  it("shows the new webhook secret once without putting it in the shared settings cache", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        ...mockData,
        webhookEnabled: true,
        hasWebhookSecret: true,
        webhookSecret: "one-time-secret",
      }),
    });
    const view = render(
      <WhatsAppConversionsSettings
        workspaceId="workspace-1"
        sourceId="source-1"
      />
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Create webhook secret" })
    );
    expect(await screen.findByLabelText("Webhook secret")).toHaveValue(
      "one-time-secret"
    );
    expect(mockMutate).toHaveBeenCalledWith(
      expect.not.objectContaining({ webhookSecret: expect.anything() }),
      { revalidate: false }
    );
    view.rerender(
      <WhatsAppConversionsSettings
        workspaceId="workspace-1"
        sourceId="source-2"
      />
    );
    expect(
      screen.queryByDisplayValue("one-time-secret")
    ).not.toBeInTheDocument();
  });

  it("shows actionable permission failure and keeps the connection disabled", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      json: async () => ({
        code: "meta_setup_failed",
        error: "private-provider-error",
      }),
    });
    render(
      <WhatsAppConversionsSettings
        workspaceId="workspace-1"
        sourceId="source-1"
      />
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Enable Meta feedback" })
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "whatsapp_business_manage_events"
    );
    expect(
      screen.queryByText("private-provider-error")
    ).not.toBeInTheDocument();
  });

  it("preserves an un-copied secret across Meta changes and failed webhook changes", async () => {
    mockMutate.mockImplementation(async settings => {
      mockData = settings;
    });
    global.fetch = jest.fn().mockImplementation(async (_url, init) => {
      const { action } = JSON.parse(init.body);
      return {
        ok: true,
        json: async () => ({
          ...mockData,
          ...(action === "rotate_webhook_secret"
            ? {
                webhookEnabled: true,
                hasWebhookSecret: true,
                webhookSecret: "one-time-secret",
              }
            : action === "disable_webhook"
              ? { webhookEnabled: false }
              : { enabled: action === "enable_meta" }),
        }),
      };
    });
    render(
      <WhatsAppConversionsSettings
        workspaceId="workspace-1"
        sourceId="source-1"
      />
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Create webhook secret" })
    );
    expect(await screen.findByLabelText("Webhook secret")).toHaveValue(
      "one-time-secret"
    );
    for (const name of ["Enable Meta feedback", "Disable Meta feedback"]) {
      fireEvent.click(screen.getByRole("button", { name }));
      await waitFor(() =>
        expect(
          screen.getByRole("button", { name: "Replace webhook secret" })
        ).toBeEnabled()
      );
      expect(screen.getByLabelText("Webhook secret")).toHaveValue(
        "one-time-secret"
      );
    }
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: false,
      json: async () => ({}),
    });
    fireEvent.click(screen.getByRole("button", { name: "Disable webhook" }));
    await screen.findByRole("alert");
    expect(screen.getByLabelText("Webhook secret")).toHaveValue(
      "one-time-secret"
    );
    fireEvent.click(screen.getByRole("button", { name: "Disable webhook" }));
    await waitFor(() =>
      expect(screen.queryByLabelText("Webhook secret")).not.toBeInTheDocument()
    );
  });

  it("disables changes in preview", () => {
    render(
      <WhatsAppConversionsSettings
        workspaceId="workspace-1"
        sourceId="source-1"
        disabled
      />
    );
    expect(mockUseSWR).toHaveBeenLastCalledWith(null, expect.any(Function));
    expect(
      screen.getByRole("button", { name: "Enable Meta feedback" })
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Create webhook secret" })
    ).toBeDisabled();
  });

  it("has a loading state and a retry action on load errors", () => {
    mockData = undefined;
    const view = render(
      <WhatsAppConversionsSettings
        workspaceId="workspace-1"
        sourceId="source-1"
      />
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "Loading sales settings"
    );
    mockError = new Error("network");
    view.rerender(
      <WhatsAppConversionsSettings
        workspaceId="workspace-1"
        sourceId="source-1"
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(mockMutate).toHaveBeenCalled();
  });
});
