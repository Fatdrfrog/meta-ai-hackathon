/** @jest-environment jsdom */

import "@testing-library/jest-dom";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { Source } from "@/types/supabase";
import messages from "../../../messages/settings/integrations/en/page.json";
import rootMessages from "../../../messages/en.json";
import { GoogleAIIntegration } from "./google-ai-integration";

const mockMutate = jest.fn().mockResolvedValue(undefined);
const mockRefresh = jest.fn();
const mockUseCompanyLimits = jest.fn();

jest.mock("@/hooks/use-company-limits", () => ({
  useCompanyLimits: (...args: unknown[]) => mockUseCompanyLimits(...args),
}));

jest.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mockRefresh }),
}));
jest.mock("swr", () => ({ useSWRConfig: () => ({ mutate: mockMutate }) }));
jest.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => false }));
jest.mock("sonner", () => ({
  toast: { success: jest.fn(), error: jest.fn() },
}));
jest.mock("next-intl", () => ({
  useLocale: () => "en",
  useTranslations:
    (namespace: string) =>
    (key: string, values: Record<string, unknown> = {}) => {
      const copy =
        namespace === "AppSidebar.limits.textAi"
          ? rootMessages.AppSidebar.limits.textAi
          : (messages as unknown as Record<string, Record<string, unknown>>)
              .GoogleAIIntegration;
      return String(
        key
          .split(".")
          .reduce<unknown>(
            (value, part) =>
              value && typeof value === "object"
                ? (value as Record<string, unknown>)[part]
                : undefined,
            copy
          ) ?? key
      ).replace(/\{(\w+)\}/g, (_, name: string) =>
        String(values[name] ?? `{${name}}`)
      );
    },
}));

const connectedSource = {
  id: "google-source",
  type: "google_ai",
  name: "Google AI",
  workspace_id: "workspace-1",
  company_id: "company-1",
  created_at: "2026-09-17T12:00:00.000Z",
  credentials: {
    has_api_key: true,
    key_label: "****1234",
    connected_at: "2026-09-17T12:00:00.000Z",
    validated_at: "2026-09-17T12:00:00.000Z",
    model_count: 12,
  },
} as Source;

describe("GoogleAIIntegration", () => {
  const originalFetch = global.fetch;
  let fetchMock: jest.Mock;
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseCompanyLimits.mockReturnValue({ data: undefined, isLoading: false });
    fetchMock = jest.fn();
    global.fetch = fetchMock;
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("submits a trimmed workspace key through a keyboard-accessible form and clears it on success", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, source: connectedSource }),
    });
    render(<GoogleAIIntegration workspaceId="workspace-1" />);
    const input = screen.getByLabelText("API key");
    expect(input).toHaveAttribute("type", "password");
    expect(input).toHaveAttribute("maxlength", "4096");
    expect(
      screen.getByRole("link", { name: /Google AI Studio/ })
    ).toHaveAttribute("href", "https://aistudio.google.com/api-keys");
    fireEvent.change(input, { target: { value: "  customer-key-1234  " } });
    fireEvent.submit(input.closest("form")!);
    await waitFor(() => expect(input).toHaveValue(""));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/workspaces/workspace-1/integrations/google-ai",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: "customer-key-1234" }),
      }
    );
    expect(mockMutate).toHaveBeenCalledWith(
      "/api/workspaces/workspace-1/integrations"
    );
    expect(mockMutate).toHaveBeenCalledWith(
      "/api/workspaces/workspace-1/limits"
    );
    expect(screen.getByRole("status")).toHaveTextContent(/connected/i);
  });

  it("keeps the stored key out of the form and replaces it only with a new key", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, source: connectedSource }),
    });
    render(
      <GoogleAIIntegration workspaceId="workspace-1" source={connectedSource} />
    );
    expect(screen.getByLabelText("API key")).toHaveValue("");
    expect(screen.getByText("****1234")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Replace key" }));
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("API key"), {
      target: { value: "replacement-key" },
    });
    fireEvent.submit(screen.getByLabelText("API key").closest("form")!);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      apiKey: "replacement-key",
    });
  });

  it("maps provider failures to accessible safe feedback and retains the existing connection", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      json: async () => ({
        code: "INVALID_API_KEY",
        error: "private-customer-key",
      }),
    });
    render(
      <GoogleAIIntegration workspaceId="workspace-1" source={connectedSource} />
    );
    fireEvent.change(screen.getByLabelText("API key"), {
      target: { value: "private-customer-key" },
    });
    fireEvent.submit(screen.getByLabelText("API key").closest("form")!);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /valid Google AI API key/i
    );
    expect(screen.getByRole("alert")).not.toHaveTextContent(
      "private-customer-key"
    );
    expect(screen.getByText("****1234")).toBeInTheDocument();
    expect(mockMutate).not.toHaveBeenCalled();
  });

  it("blocks duplicate requests while validating a key", async () => {
    let finish!: (value: unknown) => void;
    fetchMock.mockReturnValue(
      new Promise(resolve => {
        finish = resolve;
      })
    );
    render(<GoogleAIIntegration workspaceId="workspace-1" />);
    const input = screen.getByLabelText("API key");
    fireEvent.change(input, { target: { value: "test-key" } });
    fireEvent.submit(input.closest("form")!);
    fireEvent.submit(input.closest("form")!);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(input).toBeDisabled();
    finish({
      ok: false,
      json: async () => ({ code: "GOOGLE_AI_UNAVAILABLE" }),
    });
    await screen.findByRole("alert");
  });

  it("requires confirmation before disconnecting and refreshes the source list", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ success: true }),
    });
    render(
      <GoogleAIIntegration workspaceId="workspace-1" source={connectedSource} />
    );
    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    expect(fetchMock).not.toHaveBeenCalled();
    const dialog = screen.getByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Disconnect" }));
    await waitFor(() =>
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument()
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/workspaces/workspace-1/integrations/google-ai",
      { method: "DELETE" }
    );
    expect(mockMutate).toHaveBeenCalledWith(
      "/api/workspaces/workspace-1/integrations"
    );
  });

  it("prevents mutations in landing preview, including direct form submission", () => {
    render(
      <GoogleAIIntegration
        workspaceId="landing-preview"
        source={connectedSource}
        connectionActionsDisabled
      />
    );
    const input = screen.getByLabelText("API key");
    expect(input).toBeDisabled();
    expect(screen.getByRole("button", { name: "Disconnect" })).toBeDisabled();
    fireEvent.change(input, { target: { value: "not-submitted" } });
    fireEvent.submit(input.closest("form")!);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockUseCompanyLimits).toHaveBeenCalledWith(null);
  });

  it("shows Pro's remaining shared allowance before using a connected key", () => {
    mockUseCompanyLimits.mockReturnValue({
      data: {
        subscriptionType: "pro",
        textAiAllowance: {
          status: "available",
          workspaceId: "workspace-1",
          companyId: "company-1",
          plan: "pro",
          includedActions: 500,
          usedActions: 50,
          remainingActions: 450,
          periodStart: "2026-09-01T00:00:00.000Z",
          resetAt: null, allowancePeriod: "lifetime", spendLimitReached: false,
          hasCustomerSource: true,
        },
      },
    });
    render(
      <GoogleAIIntegration workspaceId="workspace-1" source={connectedSource} />
    );
    expect(screen.getByText(/450 of 500/)).toBeInTheDocument();
    expect(
      screen.getByText(/Google key will be used after/i)
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /image and video generation always requires your own key/i
      )
    ).toBeInTheDocument();
  });

  it("shows unavailable usage when the monthly balance cannot be loaded", () => {
    mockUseCompanyLimits.mockReturnValue({
      data: {
        subscriptionType: "pro",
        textAiAllowance: { status: "unavailable" },
      },
    });
    render(<GoogleAIIntegration workspaceId="workspace-1" />);
    expect(
      screen.getByText(/AI usage is temporarily unavailable/i)
    ).toBeInTheDocument();
    expect(screen.queryByText(/of 500/)).not.toBeInTheDocument();
  });

  it("allows cancelling a disconnect without changing the connection", () => {
    render(
      <GoogleAIIntegration workspaceId="workspace-1" source={connectedSource} />
    );
    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    fireEvent.click(
      within(screen.getByRole("alertdialog")).getByRole("button", {
        name: "Cancel",
      })
    );
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByText("****1234")).toBeInTheDocument();
  });

  it("keeps failed disconnect feedback in the confirmation dialog", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ code: "SOURCE_DELETE_FAILED" }),
    });
    render(
      <GoogleAIIntegration workspaceId="workspace-1" source={connectedSource} />
    );
    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    const dialog = screen.getByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Disconnect" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      /could not disconnect/i
    );
    expect(mockMutate).not.toHaveBeenCalled();
    expect(screen.getByText("****1234")).toBeInTheDocument();
  });

  it.each([
    [
      409,
      { code: "SOURCE_SAVE_CONFLICT" },
      /connection changed while the key was being checked/i,
    ],
    [401, { error: "private-response" }, /sign in again/i],
    [403, { error: "private-response" }, /do not have access/i],
    [200, { source: connectedSource }, /could not be updated/i],
  ])(
    "handles status %s without trusting raw server errors or malformed success",
    async (status, payload, expected) => {
      fetchMock.mockResolvedValue({
        ok: status === 200,
        status,
        json: async () => payload,
      });
      render(<GoogleAIIntegration workspaceId="workspace-1" />);
      fireEvent.change(screen.getByLabelText("API key"), {
        target: { value: "customer-key" },
      });
      fireEvent.submit(screen.getByLabelText("API key").closest("form")!);
      expect(await screen.findByRole("alert")).toHaveTextContent(expected);
      expect(screen.getByRole("alert")).not.toHaveTextContent(
        "private-response"
      );
      expect(screen.getByLabelText("API key")).toHaveValue("customer-key");
      expect(mockMutate).not.toHaveBeenCalled();
    }
  );
});
