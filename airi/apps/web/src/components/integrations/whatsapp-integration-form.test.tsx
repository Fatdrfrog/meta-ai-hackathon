/**
 * @jest-environment jsdom
 */

import "@testing-library/jest-dom";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { WhatsAppCredentials } from "@/types/supabase";
import { useTranslations } from "next-intl";
import type { WhatsAppHistorySyncState } from "@icecore/whatsapp/historySyncState";
import {
  shouldUseManualPhoneRegistrationRepair,
  shouldShowPhoneRegistrationRepair,
  WhatsAppIntegrationForm,
  HistorySyncSection,
} from "./whatsapp-integration-form";

function HistoryOnly({ state }: { state: WhatsAppHistorySyncState }) {
  const t = useTranslations("WhatsAppIntegrationForm");
  return (
    <HistorySyncSection
      t={t}
      workspaceId="workspace-1"
      credentials={{
        phone_number_id: "phone-1",
        waba_id: "waba-1",
        coexistence_mode: true,
        embedded_signup_flow: "coexistence",
        history_sync: state,
      }}
    />
  );
}

const mockToastSuccess = jest.fn();
const mockToastError = jest.fn();
const mockToastInfo = jest.fn();
const mockToastWarning = jest.fn();

jest.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => mockToastSuccess(...args),
    error: (...args: unknown[]) => mockToastError(...args),
    info: (...args: unknown[]) => mockToastInfo(...args),
    warning: (...args: unknown[]) => mockToastWarning(...args),
  },
}));

jest.mock("next/navigation", () => ({
  useRouter: () => ({
    refresh: jest.fn(),
  }),
}));

jest.mock("next-intl", () => ({
  useTranslations: (namespace: string) => {
    if (namespace === "WhatsAppHistorySync") {
      const catalog = require("../../../messages/en.json").WhatsAppHistorySync;
      return (key: string, values?: Record<string, string | number>) => {
        if (key === "savedCount") return `${values?.count} messages available`;
        return Object.entries(values ?? {}).reduce(
          (text, [name, value]) =>
            text
              .replace(
                new RegExp(
                  `\\{${name}, plural, one \\{([^}]*)\\} other \\{([^}]*)\\}\\}`
                ),
                (_, one: string, other: string) =>
                  (value === 1 ? one : other).replace(/#/g, String(value))
              )
              .replace(`{${name}}`, String(value)),
          catalog[key] ?? key
        );
      };
    }
    const messages: Record<string, string> = {
      "WhatsAppIntegrationForm.historyTitle": "Chat history",
      "WhatsAppIntegrationForm.historyDescription":
        "Import recent chat history.",
      "WhatsAppIntegrationForm.historyUnavailable":
        "Available only for Business app coexistence numbers.",
      "WhatsAppIntegrationForm.historyConnect": "Connect history",
      "WhatsAppIntegrationForm.historyConnecting": "Connecting...",
      "WhatsAppIntegrationForm.historyConnected": "History requested",
      "WhatsAppIntegrationForm.historyRequested":
        "WhatsApp history sync requested.",
      "WhatsAppIntegrationForm.historyRequestedAt": "Requested {date}",
      "WhatsAppIntegrationForm.historyLoading": "Checking status...",
      "WhatsAppIntegrationForm.historyProgress":
        "Import in progress: {progress}%",
      "WhatsAppIntegrationForm.historyProgressAria":
        "History import progress {progress}%",
      "WhatsAppIntegrationForm.historyLastWebhookAt": "Last update {date}",
      "WhatsAppIntegrationForm.historyCompleted": "History imported",
      "WhatsAppIntegrationForm.historyCompletedAt": "Import completed {date}",
      "WhatsAppIntegrationForm.historyDeclined":
        "History sharing was declined in the WhatsApp Business app.",
      "WhatsAppIntegrationForm.historyDeclinedButton": "Sharing declined",
      "WhatsAppIntegrationForm.historyErrorStatus":
        "History import needs attention: {error}",
      "WhatsAppIntegrationForm.historyFailedButton": "Import failed",
      "WhatsAppIntegrationForm.historyUnknownError": "Unknown Meta error",
      "WhatsAppIntegrationForm.historyFailed":
        "Failed to request WhatsApp history sync",
      "WhatsAppIntegrationForm.historyRetry": "Try again",
      "WhatsAppIntegrationForm.marketingMessagesTitle": "Marketing campaigns",
      "WhatsAppIntegrationForm.marketingMessagesDescription":
        "Finish Marketing Messages setup in Meta so bulk campaigns use Meta’s marketing delivery path.",
      "WhatsAppIntegrationForm.marketingMessagesReadyDescription":
        "Marketing campaign sends use Meta Marketing Messages for this number.",
      "WhatsAppIntegrationForm.marketingMessagesAction":
        "Open WhatsApp Manager",
      "WhatsAppIntegrationForm.marketingMessagesStatusReady":
        "Ready for campaigns",
      "WhatsAppIntegrationForm.marketingMessagesStatusNotReady": "Not set up",
      "WhatsAppIntegrationForm.marketingMessagesStatusUnknown":
        "Not checked yet",
      "WhatsAppIntegrationForm.marketingMessagesCheckStatus": "Refresh status",
      "WhatsAppIntegrationForm.marketingMessagesChecking": "Refreshing...",
      "WhatsAppIntegrationForm.marketingMessagesCheckSuccess":
        "Marketing campaign status saved.",
      "WhatsAppIntegrationForm.marketingMessagesCheckFailed":
        "Failed to refresh marketing campaign status",
      "WhatsAppIntegrationForm.marketingMessagesAdvanced":
        "Advanced billing options",
      "WhatsAppIntegrationForm.marketingMessagesMaxPriceStatus":
        "Agreement: {status}",
      "WhatsAppIntegrationForm.marketingMessagesMaxPriceHint":
        "Optional Meta max-price agreement for Business Manager billing.",
      "WhatsAppIntegrationForm.marketingMessagesSignerNameLabel": "Signer name",
      "WhatsAppIntegrationForm.marketingMessagesSignerNamePlaceholder":
        "Jane Doe",
      "WhatsAppIntegrationForm.marketingMessagesSignerEmailLabel":
        "Signer email",
      "WhatsAppIntegrationForm.marketingMessagesSignerEmailPlaceholder":
        "admin@example.com",
      "WhatsAppIntegrationForm.marketingMessagesEnrollMaxPrice":
        "Send max-price agreement",
      "WhatsAppIntegrationForm.marketingMessagesEnrollingMaxPrice":
        "Sending...",
      "WhatsAppIntegrationForm.marketingMessagesEnrollMaxPriceSuccess":
        "Agreement email sent",
      "WhatsAppIntegrationForm.marketingMessagesEnrollMaxPriceFailed":
        "Failed to send max-price agreement",
      "WhatsAppIntegrationForm.marketingMessagesEnrollMaxPriceMissingBusiness":
        "Business ID is missing. Reconnect WhatsApp to enroll.",
      "WhatsAppIntegrationForm.setupStatusLabel": "WhatsApp setup status",
      "WhatsAppIntegrationForm.accountHealthTitle": "Meta account health",
      "WhatsAppIntegrationForm.accountHealthDescription":
        "Shows whether Meta can currently send and receive for this number.",
      "WhatsAppIntegrationForm.accountHealthCheck": "Refresh status",
      "WhatsAppIntegrationForm.accountHealthChecking": "Refreshing...",
      "WhatsAppIntegrationForm.accountHealthCheckSuccess":
        "Meta status refreshed.",
      "WhatsAppIntegrationForm.accountHealthCheckDeferred":
        "A recent Meta status is still being used. Try again shortly.",
      "WhatsAppIntegrationForm.accountHealthCheckRateLimited":
        "Meta is rate-limiting status checks. Showing the last known status.",
      "WhatsAppIntegrationForm.accountHealthCheckFailed":
        "Failed to refresh Meta status",
      "WhatsAppIntegrationForm.accountHealthOpenMeta": "Open Meta",
      "WhatsAppIntegrationForm.accountHealthStatusHealthy": "Usable",
      "WhatsAppIntegrationForm.accountHealthStatusWarning": "Needs attention",
      "WhatsAppIntegrationForm.accountHealthStatusReconnecting": "Reconnecting",
      "WhatsAppIntegrationForm.accountHealthStatusDisconnected": "Disconnected",
      "WhatsAppIntegrationForm.accountHealthStatusRestricted": "Restricted",
      "WhatsAppIntegrationForm.accountHealthStatusDisabled": "Disabled",
      "WhatsAppIntegrationForm.accountHealthStatusPaymentRequired":
        "Payment required",
      "WhatsAppIntegrationForm.accountHealthStatusInaccessible":
        "Phone inaccessible",
      "WhatsAppIntegrationForm.accountHealthStatusUnknown": "Status unknown",
      "WhatsAppIntegrationForm.phoneRegistrationTitle": "Phone registration",
      "WhatsAppIntegrationForm.phoneRegistrationDescription":
        "Enter the two-step verification PIN.",
      "WhatsAppIntegrationForm.phoneRegistrationManualTitle":
        "Finish setup in Meta",
      "WhatsAppIntegrationForm.phoneRegistrationManualDescription":
        "Set two-step verification in Meta, then refresh.",
      "WhatsAppIntegrationForm.phoneRegistrationStatus": "{status}",
      "WhatsAppIntegrationForm.phoneRegistrationStatusReady": "Ready",
      "WhatsAppIntegrationForm.phoneRegistrationStatusPinRequired":
        "PIN required",
      "WhatsAppIntegrationForm.phoneRegistrationStatusManual": "Finish in Meta",
      "WhatsAppIntegrationForm.phoneRegistrationStatusNeedsAttention":
        "Needs attention",
      "WhatsAppIntegrationForm.phoneRegistrationStatusUnknown":
        "Status unknown",
      "WhatsAppIntegrationForm.phoneRegistrationPinLabel": "6-digit PIN",
      "WhatsAppIntegrationForm.phoneRegistrationPinHelp":
        "Store this PIN safely. We send it to Meta for registration and do not store it.",
      "WhatsAppIntegrationForm.phoneRegistrationAction":
        "Register phone number",
      "WhatsAppIntegrationForm.phoneRegistrationOpenMeta": "Open Meta settings",
      "WhatsAppIntegrationForm.phoneRegistrationRegistering": "Registering...",
      "WhatsAppIntegrationForm.phoneRegistrationSuccess":
        "Phone registration completed.",
      "WhatsAppIntegrationForm.phoneRegistrationFailed":
        "Failed to register phone number",
      "WhatsAppIntegrationForm.phoneRegistrationPinInvalid":
        "Enter a valid 6-digit PIN.",
      "WhatsAppIntegrationForm.voicemailTitle": "Voicemail announcement",
      "WhatsAppIntegrationForm.voicemailStatusEnabled": "Enabled",
      "WhatsAppIntegrationForm.voicemailStatusUploaded": "Media ready",
      "WhatsAppIntegrationForm.voicemailStatusMissing": "No announcement",
      "WhatsAppIntegrationForm.voicemailDescription":
        "Upload an OGG/Opus audio file.",
      "WhatsAppIntegrationForm.voicemailCurrentMediaId": "Media ID: {mediaId}",
      "WhatsAppIntegrationForm.voicemailFileLabel":
        "Voicemail announcement file",
      "WhatsAppIntegrationForm.voicemailChooseFile": "Choose OGG file",
      "WhatsAppIntegrationForm.voicemailUploadAction": "Upload announcement",
      "WhatsAppIntegrationForm.voicemailUploading": "Uploading...",
      "WhatsAppIntegrationForm.voicemailUploadSuccess":
        "Voicemail announcement uploaded and applied.",
      "WhatsAppIntegrationForm.voicemailUploadSaved":
        "Voicemail announcement uploaded.",
      "WhatsAppIntegrationForm.voicemailUploadFailed":
        "Failed to upload voicemail announcement",
      "WhatsAppIntegrationForm.voicemailFileRequired":
        "Choose an OGG voicemail announcement first.",
      "WhatsAppIntegrationForm.voicemailFileTypeInvalid":
        "Use an audio/ogg .ogg file encoded with OPUS.",
      "WhatsAppIntegrationForm.webhookTitle": "Meta webhooks",
      "WhatsAppIntegrationForm.webhookDescription":
        "Required Meta webhook fields are missing.",
      "WhatsAppIntegrationForm.webhookMissingFields": "Missing: {fields}",
      "WhatsAppIntegrationForm.webhookRecheck": "Recheck setup",
      "WhatsAppIntegrationForm.webhookRechecking": "Checking...",
      "WhatsAppIntegrationForm.webhookRecheckSuccess": "Setup rechecked.",
      "WhatsAppIntegrationForm.webhookRecheckFailed": "Failed to recheck setup",
      "WhatsAppIntegrationForm.lifecycleTitle": "Meta status",
      "WhatsAppIntegrationForm.lifecycleDescription":
        "Latest account events from Meta.",
      "WhatsAppIntegrationForm.lifecycleStatus": "{events}",
      "WhatsAppIntegrationForm.unknownStatus": "unknown",
      "WhatsAppIntegrationForm.historyIdle": "Not requested",
      "WhatsAppIntegrationForm.historyStaleShort": "No history received",
      "WhatsAppIntegrationForm.manualUpdate": "Update token",
      "WhatsAppIntegrationForm.cancelUpdate": "Cancel",
    };

    return (key: string, values?: Record<string, string>) => {
      const template = messages[`${namespace}.${key}`] ?? key;
      if (!values) return template;
      return Object.entries(values).reduce(
        (text, [name, value]) => text.replace(`{${name}}`, value),
        template
      );
    };
  },
}));

describe("WhatsAppIntegrationForm marketing messages onboarding", () => {
  const originalFetch = global.fetch;

  const baseCredentials = {
    phone_number_id: "phone-number-id",
    waba_id: "waba-1",
    business_id: "business-1",
    access_token: "token",
    token_expires_at: "2026-06-30T00:00:00.000Z",
    marketing_messages_onboarding_last_checked_at: "2026-07-21T00:00:00.000Z",
  } satisfies WhatsAppCredentials;

  beforeEach(() => {
    // Keep unrelated background status hydration pending unless a test
    // explicitly supplies a response. This avoids post-test state updates.
    global.fetch = jest
      .fn()
      .mockImplementation(() => new Promise(() => undefined));
  });

  it("preserves distinct settings sections without duplicate React keys", () => {
    const consoleError = jest
      .spyOn(console, "error")
      .mockImplementation(() => {});
    try {
      render(
        <WhatsAppIntegrationForm
          credentialsProps={baseCredentials}
          workspaceId="workspace-1"
        />
      );
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  it("shows Meta account health warnings without hiding setup actions", () => {
    render(
      <WhatsAppIntegrationForm
        credentialsProps={{
          ...baseCredentials,
          payment_configuration_status: "missing",
        }}
        workspaceId="workspace-1"
      />
    );

    const setupStatus = screen.getByRole("region", {
      name: "WhatsApp setup status",
    });

    expect(setupStatus).toContainElement(
      screen.getByText("Meta account health")
    );
    expect(setupStatus).toContainElement(screen.getByText("Payment required"));
    expect(setupStatus).toContainElement(
      screen.getByText("Payment setup required")
    );
    expect(
      screen.getAllByRole("button", { name: "Refresh status" }).length
    ).toBeGreaterThan(0);
    expect(screen.getByText("Chat history")).toBeInTheDocument();
  });

  it("refreshes normalized Meta account health through onboarding status", async () => {
    const fetchMock = global.fetch as jest.Mock;
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        connected: true,
        status: {
          account_health: {
            state: "restricted",
            lastCheckedAt: "2026-06-22T10:00:00.000Z",
            reasons: [
              {
                code: "waba_restricted",
                title: "WhatsApp account restricted",
                message: "Meta reports an account quality restriction.",
                source: "account_alerts",
              },
            ],
          },
        },
        meta_refresh: {
          requested: true,
          performed: true,
          outcome: "succeeded",
        },
      }),
    });

    render(
      <WhatsAppIntegrationForm
        credentialsProps={{
          ...baseCredentials,
          marketing_messages_onboarding_last_checked_at:
            "2026-07-21T00:00:00.000Z",
        }}
        workspaceId="workspace-1"
      />
    );

    fireEvent.click(
      screen.getAllByRole("button", { name: "Refresh status" })[0]
    );

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/whatsapp/onboarding?workspaceId=workspace-1&refresh=1"
      )
    );
    expect(await screen.findByText("Restricted")).toBeInTheDocument();
    expect(
      await screen.findByText("WhatsApp account restricted")
    ).toBeInTheDocument();
    expect(mockToastSuccess).toHaveBeenCalledWith("Meta status refreshed.");
  });

  it("does not claim success when Meta refresh is suppressed", async () => {
    const fetchMock = global.fetch as jest.Mock;
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 429,
      json: async () => ({
        connected: true,
        status: {
          account_health: {
            state: "warning",
            reasons: [],
          },
        },
        meta_refresh: {
          requested: true,
          performed: false,
          outcome: "minimum_interval",
        },
        error: "Meta diagnostics were checked too recently.",
      }),
    });

    render(
      <WhatsAppIntegrationForm
        credentialsProps={baseCredentials}
        workspaceId="workspace-1"
      />
    );

    fireEvent.click(
      screen.getAllByRole("button", { name: "Refresh status" })[0]
    );

    await waitFor(() =>
      expect(mockToastInfo).toHaveBeenCalledWith(
        "A recent Meta status is still being used. Try again shortly."
      )
    );
    expect(mockToastSuccess).not.toHaveBeenCalled();
    expect(mockToastError).not.toHaveBeenCalled();
  });

  it("shows last-known status without success when Meta rate-limits a refresh", async () => {
    const fetchMock = global.fetch as jest.Mock;
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 429,
      json: async () => ({
        connected: true,
        status: {
          account_health: {
            state: "warning",
            reasons: [],
          },
        },
        meta_refresh: {
          requested: true,
          performed: true,
          outcome: "rate_limited",
          cooldown_until: "2026-08-03T12:05:00.000Z",
        },
        error: "Meta rate-limited the diagnostics refresh.",
      }),
    });

    render(
      <WhatsAppIntegrationForm
        credentialsProps={baseCredentials}
        workspaceId="workspace-1"
      />
    );

    fireEvent.click(
      screen.getAllByRole("button", { name: "Refresh status" })[0]
    );

    await waitFor(() =>
      expect(mockToastWarning).toHaveBeenCalledWith(
        "Meta is rate-limiting status checks. Showing the last known status."
      )
    );
    expect(mockToastSuccess).not.toHaveBeenCalled();
    expect(mockToastError).not.toHaveBeenCalled();
  });

  it("nudges connected WhatsApp accounts that have not enabled Marketing Messages API", () => {
    render(
      <WhatsAppIntegrationForm
        credentialsProps={{
          ...baseCredentials,
          marketing_messages_onboarding_status: "ELIGIBLE",
          marketing_messages_onboarding_last_checked_at:
            "2026-07-21T00:00:00.000Z",
        }}
        workspaceId="workspace-1"
      />
    );

    expect(
      screen.getByRole("region", { name: "WhatsApp setup status" })
    ).toBeInTheDocument();
    expect(screen.getByText("Marketing campaigns")).toBeInTheDocument();
    expect(screen.getByText("Not set up")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Open WhatsApp Manager" })
    ).toHaveAttribute(
      "href",
      "https://business.facebook.com/wa/manage/home/?business_id=business-1&waba_id=waba-1"
    );
    expect(
      screen.queryByRole("button", { name: "Send max-price agreement" })
    ).not.toBeInTheDocument();
  });

  it("shows ready marketing status from persisted credentials without raw Meta codes", () => {
    render(
      <WhatsAppIntegrationForm
        credentialsProps={
          {
            ...baseCredentials,
            marketing_messages_onboarding_status: "ONBOARDED",
            marketing_messages_enabled: true,
            marketing_messages_onboarding_last_checked_at:
              "2026-07-21T00:00:00.000Z",
          } as WhatsAppCredentials
        }
        workspaceId="workspace-1"
      />
    );

    expect(screen.getByText("Marketing campaigns")).toBeInTheDocument();
    expect(screen.getByText("Ready for campaigns")).toBeInTheDocument();
    expect(screen.queryByText("ONBOARDED")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Advanced billing options" })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Send max-price agreement" })
    ).not.toBeInTheDocument();
  });

  it("does not automatically retry a failed marketing check after rerenders", async () => {
    const fetchMock = global.fetch as jest.Mock;
    fetchMock.mockRejectedValueOnce(new Error("Unavailable"));
    const credentials = {
      ...baseCredentials,
      marketing_messages_onboarding_last_checked_at: undefined,
    };
    const { rerender } = render(
      <WhatsAppIntegrationForm
        credentialsProps={credentials}
        workspaceId="workspace-1"
      />
    );
    await act(async () => {});
    rerender(
      <WhatsAppIntegrationForm
        credentialsProps={{ ...credentials }}
        workspaceId="workspace-1"
      />
    );
    await act(async () => {});
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(
      screen.getAllByRole("button", { name: "Refresh status" })[1]
    ).toBeEnabled();
  });

  it("shows the returned marketing status immediately without waiting for refreshed props", async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: {
          marketing_messages: {
            marketing_messages_enabled: true,
            marketing_messages_onboarding_status: "ONBOARDED",
          },
        },
      }),
    });
    render(
      <WhatsAppIntegrationForm
        credentialsProps={baseCredentials}
        workspaceId="workspace-1"
      />
    );
    fireEvent.click(
      screen.getAllByRole("button", { name: "Refresh status" })[1]
    );
    expect(await screen.findByText("Ready for campaigns")).toBeInTheDocument();
  });

  it("does not confirm an empty marketing status response as a successful check", async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({}),
    });
    render(
      <WhatsAppIntegrationForm
        credentialsProps={baseCredentials}
        workspaceId="workspace-1"
      />
    );
    fireEvent.click(
      screen.getAllByRole("button", { name: "Refresh status" })[1]
    );
    await waitFor(() =>
      expect(mockToastError).toHaveBeenCalledWith(
        "Failed to refresh marketing campaign status"
      )
    );
    expect(mockToastSuccess).not.toHaveBeenCalled();
  });

  it("does not apply a previous phone's manual marketing response to a replacement phone", async () => {
    let complete: (value: unknown) => void = () => {};
    (global.fetch as jest.Mock).mockImplementationOnce(
      () =>
        new Promise(resolve => {
          complete = resolve;
        })
    );
    const { rerender } = render(
      <WhatsAppIntegrationForm
        credentialsProps={baseCredentials}
        workspaceId="workspace-1"
      />
    );
    fireEvent.click(
      screen.getAllByRole("button", { name: "Refresh status" })[1]
    );
    rerender(
      <WhatsAppIntegrationForm
        credentialsProps={{
          ...baseCredentials,
          phone_number_id: "replacement-phone",
        }}
        workspaceId="workspace-1"
      />
    );
    await act(async () => {
      complete({
        ok: true,
        json: async () => ({
          data: {
            marketing_messages: {
              marketing_messages_enabled: true,
              marketing_messages_onboarding_status: "ONBOARDED",
            },
          },
        }),
      });
    });
    expect(screen.queryByText("Ready for campaigns")).not.toBeInTheDocument();
  });

  it("does not apply a previous phone's account health response to a replacement phone", async () => {
    let complete: (value: unknown) => void = () => {};
    (global.fetch as jest.Mock).mockImplementationOnce(
      () =>
        new Promise(resolve => {
          complete = resolve;
        })
    );
    const { rerender } = render(
      <WhatsAppIntegrationForm
        credentialsProps={baseCredentials}
        workspaceId="workspace-1"
      />
    );
    fireEvent.click(
      screen.getAllByRole("button", { name: "Refresh status" })[0]
    );
    rerender(
      <WhatsAppIntegrationForm
        credentialsProps={{
          ...baseCredentials,
          phone_number_id: "replacement-phone",
          payment_configuration_status: "missing",
        }}
        workspaceId="workspace-1"
      />
    );
    await act(async () => {
      complete({
        ok: true,
        json: async () => ({
          connected: true,
          status: {
            account_health: { state: "healthy", reasons: [] },
          },
        }),
      });
    });
    expect(screen.getByText("Payment required")).toBeInTheDocument();
  });

  it("does not claim legacy provider completion as a verified import", async () => {
    const fetchMock = global.fetch as jest.Mock;
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: {
          history_sync: {
            requested_at: "2026-06-06T10:00:00.000Z",
            completed_at: "2026-06-06T10:05:00.000Z",
            status: "completed",
            last_progress: 100,
            processed_count_total: 13,
            skipped_count_total: 2,
            webhook_count: 4,
          },
        },
      }),
    });

    render(
      <WhatsAppIntegrationForm
        credentialsProps={{
          ...baseCredentials,
          coexistence_mode: true,
          embedded_signup_flow: "coexistence",
          history_sync: {
            requested_at: "2026-06-06T10:00:00.000Z",
            completed_at: "2026-06-06T10:05:00.000Z",
            status: "completed",
            last_progress: 100,
            processed_count_total: 13,
            skipped_count_total: 2,
            webhook_count: 4,
          },
        }}
        workspaceId="workspace-1"
      />
    );

    expect(await screen.findByText("Chat history")).toBeInTheDocument();
    expect(screen.getByText("Previous history transfer")).toBeInTheDocument();
    expect(screen.queryByText("13 messages available")).not.toBeInTheDocument();
    expect(screen.queryByText("Processed: 13")).not.toBeInTheDocument();
    expect(screen.queryByText("Skipped: 2")).not.toBeInTheDocument();
    expect(screen.queryByText("Webhooks: 4")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "History imported" })
    ).not.toBeInTheDocument();
  });

  it("shows provider completion with saved and pending messages until persistence finishes", async () => {
    let state: WhatsAppHistorySyncState = {
      session_id: "new-session",
      session_started_at: new Date().toISOString(),
      requested_at: new Date().toISOString(),
      status: "in_progress",
      request_state: "accepted",
      last_progress: 100,
      counts_verified: true,
      received_count_total: 20,
      synchronized_count_total: 12,
      pending_count_total: 8,
      pending_chunk_count_total: 1,
    };
    (global.fetch as jest.Mock).mockImplementation(async () => ({
      ok: true,
      json: async () => ({
        data: { history_sync: state, history_sync_can_request: false },
      }),
    }));
    render(<HistoryOnly state={state} />);
    expect(
      await screen.findByText("Saving WhatsApp history")
    ).toBeInTheDocument();
    expect(screen.getByText(/12 messages available/)).toBeInTheDocument();
    expect(screen.getByText("WhatsApp transfer: 100%")).toBeInTheDocument();
    expect(screen.queryByText("History saved")).not.toBeInTheDocument();
    state = {
      ...state,
      status: "completed",
      synchronized_count_total: 20,
      pending_count_total: 0,
      pending_chunk_count_total: 0,
    };
    const refresh = screen.getByRole("button", { name: "Refresh status" });
    await waitFor(() => expect(refresh).toBeEnabled());
    fireEvent.click(refresh);
    expect(await screen.findByText("History saved")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Connect history" })
    ).not.toBeInTheDocument();
  });

  it("preserves an ambiguous accepted request without a success toast or repeat POST", async () => {
    let state: WhatsAppHistorySyncState = {
      session_id: "new-session",
      session_started_at: new Date().toISOString(),
    };
    const fetchMock = global.fetch as jest.Mock;
    fetchMock.mockImplementation(
      async (_url: string, options?: RequestInit) => {
        const post = options?.method === "POST";
        if (post)
          state = {
            ...state,
            request_state: "unknown",
            request_attempted_at: new Date().toISOString(),
          };
        return {
          ok: !post,
          json: async () => ({
            error: post ? "Request outcome is being checked." : undefined,
            data: {
              history_sync: state,
              history_sync_can_request: !state.request_state,
            },
          }),
        };
      }
    );
    render(<HistoryOnly state={state} />);
    const connect = await screen.findByRole("button", {
      name: "Connect history",
    });
    await waitFor(() => expect(connect).toBeEnabled());
    const range = screen.getByRole("spinbutton", {
      name: "History range (days)",
    });
    expect(range).toHaveValue(30);
    fireEvent.change(range, { target: { value: "181" } });
    expect(connect).toBeDisabled();
    fireEvent.change(range, { target: { value: "90" } });
    fireEvent.click(connect);
    expect(
      await screen.findByText("Checking history request")
    ).toBeInTheDocument();
    expect(mockToastSuccess).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("button", { name: "Connect history" })
    ).not.toBeInTheDocument();
    const refresh = screen.getByRole("button", { name: "Refresh status" });
    await waitFor(() => expect(refresh).toBeEnabled());
    fireEvent.click(refresh);
    await waitFor(() => expect(refresh).toBeEnabled());
    expect(
      fetchMock.mock.calls.filter(([, options]) => options?.method === "POST")
    ).toHaveLength(1);
    const [, request] = fetchMock.mock.calls.find(
      ([, options]) => options?.method === "POST"
    );
    expect(JSON.parse(request.body).rangeValue).toBe(90);
  });

  it("shows preserved paused history with a status refresh and no duplicate request action", async () => {
    const state: WhatsAppHistorySyncState = {
      status: "paused",
      request_state: "accepted",
      requested_at: new Date().toISOString(),
    };
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({
        data: { history_sync: state, history_sync_can_request: false },
      }),
    });
    render(<HistoryOnly state={state} />);
    expect(
      await screen.findByText("History import paused")
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Received history is preserved/)
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Connect history" })
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Refresh status" })
    ).toBeInTheDocument();
  });

  it("tells the owner when the plan kept part of a finished history import out", async () => {
    const state: WhatsAppHistorySyncState = {
      session_id: "new-session",
      session_started_at: new Date().toISOString(),
      requested_at: new Date().toISOString(),
      request_state: "accepted",
      status: "completed",
      last_progress: 100,
      counts_verified: true,
      received_count_total: 801,
      synchronized_count_total: 500,
      skipped_count_total: 301,
      plan_skipped_count_total: 300,
      pending_count_total: 0,
      failed_count_total: 0,
      pending_chunk_count_total: 0,
      failed_chunk_count_total: 0,
    };
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({
        data: { history_sync: state, history_sync_can_request: false },
      }),
    });
    render(<HistoryOnly state={state} />);
    expect(
      await screen.findByText("Some chats weren't imported")
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Upgrade, then contact support to import them\./)
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "500 messages available · 300 messages not imported because of your plan"
      )
    ).toBeInTheDocument();
    expect(screen.queryByText("History saved")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Connect history" })
    ).not.toBeInTheDocument();
  });

  it("shows stale WhatsApp history requests in settings without an active progress bar", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-06-07T00:00:00.000Z"));
    const fetchMock = global.fetch as jest.Mock;
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: {
          history_sync: {
            requested_at: "2026-05-02T15:59:47.701Z",
            request_id: "782F6722D44E038636",
            range_days: 180,
          },
        },
      }),
    });

    render(
      <WhatsAppIntegrationForm
        credentialsProps={{
          ...baseCredentials,
          coexistence_mode: true,
          embedded_signup_flow: "coexistence",
          history_sync: {
            requested_at: "2026-05-02T15:59:47.701Z",
            request_id: "782F6722D44E038636",
            range_days: 180,
          },
        }}
        workspaceId="workspace-1"
      />
    );

    expect(await screen.findByText("Chat history")).toBeInTheDocument();
    expect(
      await screen.findByText("History has not updated")
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Try again" })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Connect history" })
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Processed: 0")).not.toBeInTheDocument();
    expect(
      screen.queryByLabelText("History import progress 0%")
    ).not.toBeInTheDocument();
  });

  it("checks Marketing Messages onboarding status through the local API", async () => {
    const fetchMock = global.fetch as jest.Mock;
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        success: true,
        data: {
          marketing_messages: {
            marketing_messages_enabled: false,
            marketing_messages_onboarding_status: "ELIGIBLE",
          },
        },
      }),
    });

    render(
      <WhatsAppIntegrationForm
        credentialsProps={{
          ...baseCredentials,
          marketing_messages_onboarding_last_checked_at:
            "2026-07-21T00:00:00.000Z",
        }}
        workspaceId="workspace-1"
      />
    );

    fireEvent.click(
      screen.getAllByRole("button", { name: "Refresh status" })[1]
    );

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/whatsapp/mm-eligibility?workspaceId=workspace-1"
      )
    );
  });

  it("sends max-price agreement enrollment at the Business Manager level", async () => {
    const fetchMock = global.fetch as jest.Mock;
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: {
          businessId: "business-1",
          agreement: {
            status: "pending",
            signer_name: "Jane Doe",
            signer_email: "jane@example.com",
          },
        },
      }),
    });

    render(
      <WhatsAppIntegrationForm
        credentialsProps={
          {
            ...baseCredentials,
            marketing_messages_onboarding_status: "ONBOARDED",
            marketing_messages_enabled: true,
            marketing_messages_onboarding_last_checked_at:
              "2026-07-21T00:00:00.000Z",
          } as WhatsAppCredentials
        }
        workspaceId="workspace-1"
      />
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Advanced billing options" })
    );

    fireEvent.change(screen.getByLabelText("Signer name"), {
      target: { value: "Jane Doe" },
    });
    fireEvent.change(screen.getByLabelText("Signer email"), {
      target: { value: "jane@example.com" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Send max-price agreement" })
    );

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/whatsapp/max-price-agreement",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            workspaceId: "workspace-1",
            signerName: "Jane Doe",
            signerEmail: "jane@example.com",
          }),
        })
      )
    );
    expect(await screen.findByText("Agreement: PENDING")).toBeInTheDocument();
  });

  it("shows phone registration repair for unregistered connected phones", () => {
    expect(
      shouldShowPhoneRegistrationRepair({
        ...baseCredentials,
        phone_registered: false,
        phone_registration_status: "NOT_VERIFIED",
        platform_type: "NOT_APPLICABLE",
      })
    ).toBe(true);
  });

  it("keeps connected setup actions in one grouped status surface", () => {
    render(
      <WhatsAppIntegrationForm
        credentialsProps={{
          ...baseCredentials,
          coexistence_mode: true,
          embedded_signup_flow: "coexistence",
          phone_registered: false,
          phone_registration_status: "NOT_VERIFIED",
          marketing_messages_onboarding_last_checked_at:
            "2026-07-21T00:00:00.000Z",
        }}
        workspaceId="workspace-1"
      />
    );

    const setupStatus = screen.getByRole("region", {
      name: "WhatsApp setup status",
    });

    expect(setupStatus).toContainElement(screen.getByText("Chat history"));
    expect(setupStatus).toContainElement(
      screen.getByText("Finish setup in Meta")
    );
    expect(setupStatus).toContainElement(
      screen.getByText("Marketing campaigns")
    );
    expect(
      screen.getByRole("button", { name: "Update token" })
    ).toHaveAttribute("aria-expanded", "false");
  });

  it("hides raw Meta lifecycle event internals from the setup surface", () => {
    render(
      <WhatsAppIntegrationForm
        credentialsProps={
          {
            ...baseCredentials,
            whatsapp_lifecycle_events: {
              account_alerts: {
                field: "account_alerts",
                receivedAt: "2026-06-21T09:00:00.000Z",
                event: "ACCOUNT_RESTRICTED",
              },
              security: {
                field: "security",
                receivedAt: "2026-06-21T09:01:00.000Z",
                event: "PIN_ENABLED",
              },
            },
          } as WhatsAppCredentials
        }
        workspaceId="workspace-1"
      />
    );

    expect(screen.queryByText("Meta status")).not.toBeInTheDocument();
    expect(
      screen.queryByText(
        "account alerts: ACCOUNT RESTRICTED, security: PIN ENABLED"
      )
    ).not.toBeInTheDocument();
  });

  it("keeps registration repair visible when stored coexistence details contradict a failed registration", () => {
    expect(
      shouldShowPhoneRegistrationRepair({
        ...baseCredentials,
        phone_registered: false,
        phone_registration_status: "UNVERIFIED",
        platform_type: "CLOUD_API",
        is_on_biz_app: true,
      })
    ).toBe(true);
  });

  it("keeps confirmed coexistence phones out of the manual registration repair", () => {
    expect(
      shouldShowPhoneRegistrationRepair({
        ...baseCredentials,
        phone_registered: true,
        phone_registration_status: "VERIFIED",
        platform_type: "CLOUD_API",
        is_on_biz_app: true,
      })
    ).toBe(false);
  });

  it.each(["REGISTERED", "CONNECTED"])(
    "hides repair for a phone with recorded registration success and %s status",
    phone_registration_status => {
      expect(
        shouldShowPhoneRegistrationRepair({
          ...baseCredentials,
          phone_registered: true,
          phone_registration_status,
          platform_type: "CLOUD_API",
          is_on_biz_app: false,
        })
      ).toBe(false);
    }
  );

  it("uses manual Meta setup for coexistence phone registration", () => {
    const fetchMock = global.fetch as jest.Mock;
    fetchMock.mockReturnValueOnce(new Promise(() => {}));
    const credentials = {
      ...baseCredentials,
      phone_registered: false,
      phone_registration_status: "NOT_VERIFIED",
      coexistence_mode: true,
    } satisfies WhatsAppCredentials;

    expect(shouldUseManualPhoneRegistrationRepair(credentials)).toBe(true);

    render(
      <WhatsAppIntegrationForm
        credentialsProps={credentials}
        workspaceId="workspace-1"
      />
    );

    expect(screen.getByText("Finish setup in Meta")).toBeInTheDocument();
    expect(screen.queryByLabelText("6-digit PIN")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Register phone number" })
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Open Meta settings" })
    ).toHaveAttribute(
      "href",
      "https://business.facebook.com/wa/manage/home/?business_id=business-1&waba_id=waba-1"
    );
  });

  it("shows missing Meta webhook fields and retries automatic setup", async () => {
    const fetchMock = global.fetch as jest.Mock;
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true, warnings: [] }),
    });

    render(
      <WhatsAppIntegrationForm
        credentialsProps={{
          ...baseCredentials,
          webhook_missing_required_fields: [
            "messages",
            "account_update",
            "calls",
            "history",
          ],
        }}
        workspaceId="workspace-1"
      />
    );

    expect(screen.getByText("Meta webhooks")).toBeInTheDocument();
    expect(
      screen.getByText("Missing: messages, account_update, calls +1")
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Recheck setup" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/whatsapp/onboarding",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          workspaceId: "workspace-1",
          action: "auto_enable_defaults",
          force: true,
          trigger: "onboarding_action",
        }),
      })
    );
  });

  it("offers PIN repair after a verified Cloud API phone failed registration", async () => {
    const fetchMock = global.fetch as jest.Mock;
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true }),
    });

    render(
      <WhatsAppIntegrationForm
        credentialsProps={{
          ...baseCredentials,
          phone_registered: false,
          phone_registration_status: "VERIFIED",
          phone_registration_error: "Registration rejected",
          coexistence_mode: true,
          embedded_signup_flow: "cloud_api",
          is_on_biz_app: false,
          platform_type: "CLOUD_API",
        }}
        workspaceId="workspace-1"
      />
    );

    fireEvent.change(screen.getByLabelText("6-digit PIN"), {
      target: { value: "123456" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Register phone number" })
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/whatsapp/onboarding",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          workspaceId: "workspace-1",
          action: "register_phone",
          pin: "123456",
        }),
      })
    );
  });

  it("uploads a voicemail announcement through the onboarding endpoint", async () => {
    const fetchMock = global.fetch as jest.Mock;
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        success: true,
        upload: { id: "media-vm-1" },
        status: { calls_voicemail_enabled: true },
      }),
    });

    render(
      <WhatsAppIntegrationForm
        credentialsProps={baseCredentials}
        workspaceId="workspace-1"
      />
    );

    const file = new File([new Uint8Array([1, 2, 3])], "announcement.ogg", {
      type: "audio/ogg",
    });
    fireEvent.change(screen.getByLabelText("Voicemail announcement file"), {
      target: { files: [file] },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Upload announcement" })
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [
      string,
      RequestInit & { body: FormData },
    ];
    expect(url).toBe("/api/whatsapp/onboarding");
    expect(init.method).toBe("POST");
    expect(init.body).toBeInstanceOf(FormData);
    expect(init.body.get("workspaceId")).toBe("workspace-1");
    expect(init.body.get("action")).toBe("upload_voicemail_announcement");
    expect(init.body.get("file")).toBe(file);
  });
});
