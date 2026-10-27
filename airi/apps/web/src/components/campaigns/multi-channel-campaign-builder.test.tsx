/**
 * @jest-environment jsdom
 */

import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { SCENARIO_BULK_TELEGRAM_SUBSCRIBERS_AUDIENCE_SOURCE } from "@icecore/scenario-contracts";
import { useEffect } from "react";
import { toast } from "sonner";
import { MultiChannelCampaignBuilder } from "./multi-channel-campaign-builder";

jest.mock("next-intl", () => ({
  useLocale: () => "en",
  useTranslations: () => (key: string, values?: { count?: number }) =>
    key === "sendToRecipients" && values?.count !== undefined
      ? `${key}:${values.count}`
      : key,
}));

jest.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: jest.fn() }),
}));

jest.mock("@/components/email/email-content-editor", () => ({
  EmailContentEditor: (props: {
    onChange?: (value: { subject: string; markdown: string }) => void;
    value?: { subject: string; markdown: string };
    draftStorageKey?: string;
    idPrefix?: string;
  }) => (
    <div
      data-testid="email-editor"
      data-draft-key={props.draftStorageKey}
      data-id-prefix={props.idPrefix}
    >
      <div data-testid="email-editor-subject">{props.value?.subject || ""}</div>
      <button
        type="button"
        onClick={() =>
          props.onChange?.({
            subject: "Demo event reminder",
            markdown: "- Date: {{eventDate}}\n- Time: {{eventTime}}",
          })
        }
      >
        apply-event-template
      </button>
    </div>
  ),
}));

const mockReadyReadiness = {
  state: "ready",
  checkedAt: "2026-09-16T10:00:00.000Z",
  remainingCapacity: null,
  reasons: [],
};
let mockRecipientLimitMax = 1000;
let mockBatchPlanReadiness: Record<string, unknown> = mockReadyReadiness;
let mockBatchPlanError: Error | null = null;
let mockBatchPlanConfigured = true;
let mockBatchPlanCode: string | undefined;
let mockBatchPlanMessage: string | undefined;
const mockRefreshBatchPlan = jest.fn();

jest.mock("@/lib/campaign/useBulkCampaignBatchPlan", () => ({
  useBulkCampaignBatchPlanPreview: () => ({
    preview: {
      channel: "email",
      configured: mockBatchPlanConfigured,
      code: mockBatchPlanCode,
      error: mockBatchPlanError?.message ?? mockBatchPlanMessage,
      readiness: mockBatchPlanReadiness,
      batchPlan: {
        batchSize: 20,
        delayMs: 334,
        ratePerSecond: 60,
        rateSource: "channel_default",
      },
      recipientLimit: {
        maxRecipients: mockRecipientLimitMax,
        rawLimit: String(mockRecipientLimitMax),
        source: "channel_default",
      },
      whatsappMeta: {
        sourceId: "source-1",
        phoneNumberId: "phone-number-1",
        detailsSource: "meta_phone_details",
      },
    },
    isLoading: false,
    isRefreshing: false,
    refresh: mockRefreshBatchPlan,
    error: mockBatchPlanError,
  }),
}));

const mockOpenCompanyLimits = {
  subscriptionType: "free",
  bulkRecipientLimit: 500,
  bulkRecipientCount: 0,
  bulkRecipientsRemaining: 500,
  bulkRecipientExhausted: false,
};
let mockCompanyLimits: Record<string, unknown> = mockOpenCompanyLimits;
const mockRefreshCompanyLimits = jest.fn();

jest.mock("@/hooks/use-company-limits", () => ({
  useCompanyLimits: () => ({
    data: mockCompanyLimits,
    mutate: mockRefreshCompanyLimits,
  }),
}));

let mockUploadSequence = 0;

type MockCampaignRecipient = {
  phone?: string;
  chatId?: string;
  email?: string;
  name: string;
};

function parseJsonRequestBody(
  call: [RequestInfo | URL, RequestInit?] | undefined
) {
  const body = call?.[1]?.body;
  if (typeof body !== "string") {
    throw new Error("Expected a JSON request body");
  }
  return JSON.parse(body);
}

const mockRecipientPicker = jest.fn((props: Record<string, unknown>) => (
  <div data-testid="recipient-picker">
    {String(props.audienceSource)}:
    {String(
      (props.registeredUsersAudience as { total?: number } | null)?.total ?? 0
    )}
    <button
      type="button"
      onClick={() =>
        (
          props.onRecipientsChange as
            | ((recipients: Array<{ phone: string; name: string }>) => void)
            | undefined
        )?.([{ phone: "77001234567", name: "Dana" }])
      }
    >
      add-recipient
    </button>
    <button
      type="button"
      onClick={() => {
        mockUploadSequence += 1;
        const channel = String(props.channel);
        const recipient =
          channel === "email"
            ? { email: "dana@example.com", name: "Dana" }
            : channel === "telegram"
              ? { chatId: "123456", name: "Dana" }
              : { phone: "77001234567", name: "Dana" };
        (
          props.onUploadedAudienceChange as
            | ((audience: {
                recipients: MockCampaignRecipient[];
                uploadEvidence: {
                  originalFilename: string;
                  selectedAt: string;
                };
              }) => void)
            | undefined
        )?.({
          recipients: [recipient],
          uploadEvidence: {
            originalFilename:
              mockUploadSequence > 1
                ? "analytics-fill-up.csv"
                : "uploaded-audience.csv",
            selectedAt: "2026-07-24T08:00:00.000Z",
          },
        });
      }}
    >
      upload-audience
    </button>
    <button
      type="button"
      onClick={() => {
        mockUploadSequence += 1;
        const channel = String(props.channel);
        const recipients =
          channel === "email"
            ? [
                { email: "dana@example.com", name: "Dana" },
                { email: "aibek@example.com", name: "Aibek" },
              ]
            : channel === "telegram"
              ? [
                  { chatId: "123456", name: "Dana" },
                  { chatId: "654321", name: "Aibek" },
                ]
              : [
                  { phone: "77001234567", name: "Dana" },
                  { phone: "77007654321", name: "Aibek" },
                ];
        (
          props.onUploadedAudienceChange as
            | ((audience: {
                recipients: MockCampaignRecipient[];
                uploadEvidence: {
                  originalFilename: string;
                  selectedAt: string;
                };
              }) => void)
            | undefined
        )?.({
          recipients,
          uploadEvidence: {
            originalFilename: "overflow-audience.csv",
            selectedAt: "2026-07-24T08:00:00.000Z",
          },
        });
      }}
    >
      upload-overflow-audience
    </button>
  </div>
));

jest.mock("./campaign-recipient-picker", () => ({
  CampaignRecipientPicker: (props: Record<string, unknown>) =>
    mockRecipientPicker(props),
}));

const mockDispatchPlanCard = jest.fn((props: Record<string, unknown>) => (
  <div data-testid="dispatch-plan">
    <div id={props.reasonId as string} role="status" data-testid="shared-send-status">
      {(props.sendStatus as { state?: string } | undefined)?.state}
    </div>
    {props.onRefreshReadiness ? (
      <button type="button" onClick={props.onRefreshReadiness as () => void}>
        refresh-readiness
      </button>
    ) : null}
    {props.queuedDispatch ? (
      <button
        type="button"
        onClick={() =>
          (
            props.onDispatchLifecycleChange as
              | ((status: string, operation: null) => void)
              | undefined
          )?.("completed", null)
        }
      >
        complete-plan-dispatch
      </button>
    ) : null}
  </div>
));

// The summary before Send confirms itself unless a test turns that off,
// so send tests only need to click Send.
let mockAutoConfirmSendSummary = true;
const mockSendSummaryDialog = jest.fn(
  (props: {
    summary: Record<string, unknown> | null;
    onConfirm: () => void;
  }) => {
    const { summary, onConfirm } = props;
    useEffect(() => {
      if (summary && mockAutoConfirmSendSummary) onConfirm();
    }, [summary, onConfirm]);
    return summary ? (
      <div data-testid="send-summary">
        <button type="button" onClick={onConfirm}>
          confirm-send-summary
        </button>
      </div>
    ) : null;
  }
);

jest.mock("./bulk-campaign-send-summary-dialog", () => ({
  BulkCampaignSendSummaryDialog: (props: {
    summary: Record<string, unknown> | null;
    onConfirm: () => void;
  }) => mockSendSummaryDialog(props),
}));

const mockTestSendDialog = jest.fn((props: Record<string, unknown>) => (
  <div data-testid="test-send-dialog">{String(props.valuesFrom)}</div>
));

jest.mock("./campaign-test-send-dialog", () => ({
  CampaignTestSendDialog: (props: Record<string, unknown>) =>
    mockTestSendDialog(props),
}));

jest.mock("./campaign-dispatch-plan-card", () => ({
  CampaignDispatchPlanCard: (props: Record<string, unknown>) =>
    mockDispatchPlanCard(props),
}));

type FetchRoute = [
  urlFragment: string,
  respond: (init?: RequestInit) => Response | Promise<Response>,
];

// Answers each fetch with the first route whose fragment the URL contains,
// else with `fallback` (by default an empty JSON body), and installs it as
// global.fetch.
function mockCampaignFetch(
  routes: FetchRoute[],
  fallback: () => Response | Promise<Response> = () => jsonResponse({})
) {
  const fetchMock = jest.fn<
    Promise<Response>,
    [RequestInfo | URL, RequestInit?]
  >(async (input, init) => {
    const url = String(input);
    const route = routes.find(([fragment]) => url.includes(fragment));
    return route ? route[1](init) : fallback();
  });
  global.fetch = fetchMock as jest.Mock;
  return fetchMock;
}

function jsonResponse(body: unknown, status?: number) {
  return {
    ok: true,
    ...(status === undefined ? {} : { status }),
    json: async () => body,
  } as Response;
}

// A catalog with one English template whose body says "Hello".
function templatesResponse(name: string, category = "UTILITY") {
  return jsonResponse({
    templates: [
      {
        name,
        language: "en",
        category,
        components: [{ type: "BODY", text: "Hello" }],
      },
    ],
  });
}

function getPriorFailureSwitch() {
  const trigger = screen.getByRole("button", { name: /recipientFilters/ });
  if (trigger.getAttribute("aria-expanded") === "false")
    fireEvent.click(trigger);
  return screen.getByRole("switch", {
    name: "excludePriorFailedBulkSendsLabel",
  });
}

describe("MultiChannelCampaignBuilder", () => {
  // The template catalog is cached per workspace (an SWR key), so a test that
  // loads templates needs a workspaceId that no other test uses.
  afterEach(() => jest.useRealTimers());

  beforeEach(() => {
    jest.clearAllMocks();
    mockUploadSequence = 0;
    mockAutoConfirmSendSummary = true;
    mockRecipientLimitMax = 1000;
    mockBatchPlanReadiness = mockReadyReadiness;
    mockBatchPlanError = null;
    mockBatchPlanConfigured = true;
    mockBatchPlanCode = undefined;
    mockBatchPlanMessage = undefined;
    mockCompanyLimits = mockOpenCompanyLimits;
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: jest.fn().mockImplementation(() => ({
        matches: false,
        media: "",
        onchange: null,
        addEventListener: jest.fn(),
        removeEventListener: jest.fn(),
        addListener: jest.fn(),
        removeListener: jest.fn(),
        dispatchEvent: jest.fn(),
      })),
    });
    HTMLElement.prototype.scrollIntoView = jest.fn();
    global.ResizeObserver = class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({ templates: [] }),
    })) as jest.Mock;
  });

  it("reports a failed plan check once and restores recipient warnings after recovery", async () => {
    mockBatchPlanError = new Error("HTTP 503");
    const props = {
      workspaceId: "workspace-plan-error",
      emailEnabled: false,
      lockedChannel: "whatsapp" as const,
    };
    const { rerender } = render(<MultiChannelCampaignBuilder {...props} />);
    await waitFor(() =>
      expect(mockRecipientPicker).toHaveBeenLastCalledWith(
        expect.objectContaining({ showRecipientLimitAlerts: false })
      )
    );
    expect(mockDispatchPlanCard).toHaveBeenLastCalledWith(
      expect.objectContaining({
        previewError: true,
        onRefreshPreview: mockRefreshBatchPlan,
      })
    );
    mockBatchPlanError = null;
    rerender(<MultiChannelCampaignBuilder {...props} />);
    expect(mockRecipientPicker).toHaveBeenLastCalledWith(
      expect.objectContaining({ showRecipientLimitAlerts: true })
    );
    expect(mockDispatchPlanCard).toHaveBeenLastCalledWith(
      expect.objectContaining({ previewError: false })
    );
  });

  it("tells the readiness notice why the recipient check failed", async () => {
    mockCampaignFetch([
      [
        "/api/whatsapp/templates",
        () => templatesResponse("marketing_readiness", "MARKETING"),
      ],
      [
        "/api/campaigns/recipient-eligibility",
        () =>
          ({
            ok: false,
            status: 503,
            json: async () => ({
              state: "blocked",
              error: { code: "meta_rate_limited" },
              retryAfterSeconds: 60,
            }),
          }) as Response,
      ],
    ]);
    render(
      <MultiChannelCampaignBuilder
        workspaceId="00000000-0000-4000-8000-000000000911"
        emailEnabled={false}
        lockedChannel="whatsapp"
      />
    );
    fireEvent.click(await screen.findByRole("combobox", { name: "template" }));
    fireEvent.click(
      await screen.findByRole("option", { name: /marketing_readiness/ })
    );
    fireEvent.click(screen.getByText("add-recipient"));

    await waitFor(() =>
      expect(mockDispatchPlanCard).toHaveBeenLastCalledWith(
        expect.objectContaining({
          readinessError: true,
          readinessErrorCode: "meta_rate_limited",
          retryAt: expect.any(Number),
          onRefreshReadiness: expect.any(Function),
          messageSelected: true,
          allExcluded: false,
        })
      )
    );
    const send = screen.getByRole("button", {
      name: "sendToRecipients:1",
    }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    // Send says why it is disabled, like the scenario node does.
    const reason = screen.getByTestId("shared-send-status");
    expect(reason.textContent).toBe("unavailable");
    expect(send.getAttribute("aria-describedby")).toBe(reason.id);
  });

  it("says a missing WhatsApp number once, and a failed lookup as a failed check", async () => {
    mockBatchPlanConfigured = false;
    const props = {
      workspaceId: "00000000-0000-4000-8000-000000000916",
      emailEnabled: false,
      lockedChannel: "whatsapp" as const,
    };
    const { rerender } = render(<MultiChannelCampaignBuilder {...props} />);

    // The same states, classified like the scenario bulk node.
    const card = mockDispatchPlanCard.mock.calls.at(-1)?.[0];
    expect(card).toMatchObject({
      readinessError: true,
      readinessErrorCode: "plan_unavailable",
      reasonId: expect.any(String),
    });
    const send = screen.getByRole("button", {
      name: "sendToRecipients:0",
    }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    // The notice's reason line is the only place that says it.
    expect(
      screen.queryByTestId("bulk-campaign-send-blocked-reason")
    ).toBeNull();

    mockBatchPlanError = new Error("Unauthorized");
    rerender(<MultiChannelCampaignBuilder {...props} />);
    expect(mockDispatchPlanCard.mock.calls.at(-1)?.[0]).toMatchObject({
      readinessError: true,
      readinessErrorCode: undefined,
    });
  });

  it("points Send at the notice when the WhatsApp number isn't set up", async () => {
    mockBatchPlanConfigured = false;
    mockCampaignFetch([
      [
        "/api/whatsapp/templates",
        () => templatesResponse("marketing_unconfigured", "MARKETING"),
      ],
    ]);
    render(
      <MultiChannelCampaignBuilder
        workspaceId="00000000-0000-4000-8000-000000000913"
        emailEnabled={false}
        lockedChannel="whatsapp"
      />
    );
    fireEvent.click(await screen.findByRole("combobox", { name: "template" }));
    fireEvent.click(
      await screen.findByRole("option", { name: /marketing_unconfigured/ })
    );
    fireEvent.click(screen.getByText("add-recipient"));

    const send = (await screen.findByRole("button", {
      name: "sendToRecipients:1",
    })) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    const card = mockDispatchPlanCard.mock.calls.at(-1)?.[0];
    expect(card?.readinessErrorCode).toBe("plan_unavailable");
    expect(send.getAttribute("aria-describedby")).toBe(card?.reasonId);
    expect(
      screen.queryByTestId("bulk-campaign-send-blocked-reason")
    ).toBeNull();
  });

  it("shows a send-time Meta throttle in the page's language and locks Refresh while sending", async () => {
    let answerSend: (response: Response) => void = () => undefined;
    const sendResponse = new Promise<Response>(resolve => {
      answerSend = resolve;
    });
    mockCampaignFetch([
      ["/api/whatsapp/templates", () => templatesResponse("utility_throttled")],
      [
        "/api/campaigns/recipient-eligibility",
        () =>
          jsonResponse(
            {
              state: "ready",
              evaluatedAt: "2026-10-05T12:00:00.000Z",
              requestedTotal: 1,
              acceptedTotal: 1,
              uniqueRecipients: { requested: 1, accepted: 1 },
              skippedByReason: {},
              warnings: { missingMarketingConsent: 0 },
              allExcluded: false,
              readiness: mockReadyReadiness,
            },
            200
          ),
      ],
      ["/api/campaigns/bulk-send", () => sendResponse],
    ]);
    render(
      <MultiChannelCampaignBuilder
        workspaceId="00000000-0000-4000-8000-000000000914"
        emailEnabled={false}
        lockedChannel="whatsapp"
      />
    );
    fireEvent.change(screen.getByLabelText("campaignName"), {
      target: { value: "Throttled send" },
    });
    fireEvent.click(await screen.findByRole("combobox", { name: "template" }));
    fireEvent.click(
      await screen.findByRole("option", { name: /utility_throttled/ })
    );
    fireEvent.click(screen.getByText("add-recipient"));
    await waitFor(() =>
      expect(
        (
          screen.getByRole("button", {
            name: "sendToRecipients:1",
          }) as HTMLButtonElement
        ).disabled
      ).toBe(false)
    );
    expect(mockDispatchPlanCard.mock.calls.at(-1)?.[0]).toMatchObject({
      refreshDisabled: false,
    });

    fireEvent.click(screen.getByRole("button", { name: "sendToRecipients:1" }));
    await waitFor(() =>
      expect(mockDispatchPlanCard.mock.calls.at(-1)?.[0]).toMatchObject({
        refreshDisabled: true,
      })
    );
    await act(async () => {
      answerSend({
        ok: false,
        status: 503,
        json: async () => ({
          ok: false,
          disposition: "blocked",
          code: "meta_rate_limited",
          message: "Bulk campaign eligibility failed: meta_rate_limited",
        }),
      } as Response);
    });

    expect(
      await screen.findByText("readiness.errors.meta_rate_limited")
    ).toBeTruthy();
    expect(
      screen.queryByText("Bulk campaign eligibility failed: meta_rate_limited")
    ).toBeNull();
  });

  it("names the recipients with missing template variables in the page's language", async () => {
    const toastError = jest.spyOn(toast, "error").mockImplementation(() => "");
    const fetchMock = mockCampaignFetch([
      [
        "/api/whatsapp/templates",
        () =>
          jsonResponse({
            templates: [
              {
                name: "utility_update",
                language: "en",
                category: "UTILITY",
                components: [{ type: "BODY", text: "Hello {{1}}" }],
              },
            ],
          }),
      ],
      [
        "/api/campaigns/recipient-eligibility",
        () =>
          jsonResponse({
            requestedTotal: 1,
            eligibleTotal: 1,
            readiness: mockReadyReadiness,
          }),
      ],
    ]);

    render(
      <MultiChannelCampaignBuilder
        workspaceId="00000000-0000-4000-8000-000000000915"
        emailEnabled={false}
        lockedChannel="whatsapp"
      />
    );

    fireEvent.change(screen.getByLabelText("campaignName"), {
      target: { value: "Utility update" },
    });
    fireEvent.click(await screen.findByRole("combobox", { name: "template" }));
    fireEvent.click(
      await screen.findByRole("option", { name: /utility_update/ })
    );
    fireEvent.click(screen.getByText("add-recipient"));
    act(() => {
      (
        mockRecipientPicker.mock.calls.at(-1)?.[0].onVariableConfigsChange as (
          configs: Record<string, unknown>
        ) => void
      )({ "1": { mode: "custom", customValue: "" } });
    });

    const send = await screen.findByRole("button", {
      name: "sendToRecipients:1",
    });
    await waitFor(() =>
      expect((send as HTMLButtonElement).disabled).toBe(false)
    );
    fireEvent.click(send);

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        "toast.templateVariablesMissing\n77001234567: {{1}}"
      )
    );
    expect(
      fetchMock.mock.calls.some(([url]) =>
        String(url).includes("/api/campaigns/bulk-send")
      )
    ).toBe(false);
    toastError.mockRestore();
  });

  it("keeps Analytics fill-up unavailable without repeating a failed plan check and restores it after recovery", async () => {
    const rawNetworkError = "HTTP 503: upstream connection failed";
    mockBatchPlanError = new Error(rawNetworkError);
    mockRecipientLimitMax = 0;
    global.fetch = jest.fn(async input => {
      const url = String(input);
      if (url.includes("/analytics/bulk/audience-preview")) {
        return {
          ok: true,
          json: async () => ({
            available: true,
            total: 1,
            eligibleTotal: 1,
            readiness: mockReadyReadiness,
            excludedOptIn: 0,
            capped: false,
            maxRecipients: 1000,
          }),
        } as Response;
      }
      return {
        ok: true,
        json: async () => ({ templates: [] }),
      } as Response;
    }) as jest.Mock;
    const props = {
      workspaceId: "workspace-analytics-plan-error",
      emailEnabled: false,
      lockedChannel: "whatsapp" as const,
      recipientSource: {
        type: "bulk_analytics" as const,
        filters: { days: 30 },
        previewCount: 1,
      },
    };
    const { rerender } = render(<MultiChannelCampaignBuilder {...props} />);
    await screen.findByRole("button", { name: "sendToRecipients:1" });
    expect(screen.queryByTestId("recipient-picker")).toBeNull();
    expect(screen.queryByText(rawNetworkError)).toBeNull();
    expect(screen.queryByText("analyticsFillUpLimitUnavailable")).toBeNull();
    expect(
      (
        screen.getByRole("button", {
          name: "sendToRecipients:1",
        }) as HTMLButtonElement
      ).disabled
    ).toBe(true);
    expect(mockDispatchPlanCard).toHaveBeenLastCalledWith(
      expect.objectContaining({ previewError: true })
    );

    mockBatchPlanError = null;
    rerender(<MultiChannelCampaignBuilder {...props} />);
    expect(screen.getByText("analyticsFillUpLimitUnavailable")).toBeTruthy();
    expect(screen.queryByTestId("recipient-picker")).toBeNull();

    mockRecipientLimitMax = 1000;
    rerender(<MultiChannelCampaignBuilder {...props} />);
    expect(await screen.findByTestId("recipient-picker")).toBeTruthy();
    expect(screen.queryByText("analyticsFillUpLimitUnavailable")).toBeNull();
    expect(screen.queryByText(rawNetworkError)).toBeNull();
    expect(mockRecipientPicker).toHaveBeenLastCalledWith(
      expect.objectContaining({ showRecipientLimitAlerts: true })
    );
  });

  it.each(["blocked", "missing", "ready"])(
    "uses %s readiness with the prior-failure toggle off and keeps consent warning informational",
    async readinessState => {
      const cooldown = {
        ...mockReadyReadiness,
        state: "blocked",
        reasons: [
          {
            code: "contact_frequency_limit",
            affectedRecipientCount: 1,
            eligibleRecipientCount: 0,
            nextEligibleAt: "2026-09-17T10:00:00.000Z",
          },
        ],
      };
      const previewReadiness =
        readinessState === "missing"
          ? undefined
          : readinessState === "blocked"
            ? {
                ...mockReadyReadiness,
                state: "blocked",
                reasons: [
                  { code: "meta_sender_restricted", providerCode: "131048" },
                ],
              }
            : mockReadyReadiness;
      const fetchMock = mockCampaignFetch([
        [
          "/api/whatsapp/templates",
          () => templatesResponse("marketing_readiness", "MARKETING"),
        ],
        [
          "/api/campaigns/recipient-eligibility",
          () =>
            jsonResponse({
              requestedTotal: 1,
              eligibleTotal: 1,
              marketingOptInWarningCount: 1,
              readiness: previewReadiness,
            }),
        ],
        [
          "/api/campaigns/bulk-send",
          () =>
            ({
              ok: false,
              status: 409,
              json: async () => ({
                code: "campaign_contact_cooldown",
                error: "Local cooldown",
                readiness: cooldown,
              }),
            }) as Response,
        ],
      ]);
      const builderProps = {
        workspaceId: `00000000-0000-4000-8000-00000000090${readinessState === "ready" ? 1 : readinessState === "blocked" ? 2 : 3}`,
        emailEnabled: false,
        lockedChannel: "whatsapp" as const,
      };
      const { rerender } = render(
        <MultiChannelCampaignBuilder {...builderProps} />
      );
      fireEvent.change(screen.getByLabelText("campaignName"), {
        target: { value: "Readiness check" },
      });
      fireEvent.click(
        await screen.findByRole("combobox", { name: "template" })
      );
      fireEvent.click(
        await screen.findByRole("option", { name: /marketing_readiness/ })
      );
      fireEvent.click(screen.getByText("add-recipient"));
      expect(
        await screen.findByText("marketingOptInWarningInline")
      ).toBeTruthy();
      expect(screen.queryByText("marketingTemplateConsentNotice")).toBeNull();
      expect(screen.getByText("Hello")).toBeTruthy();
      expect(screen.queryByText("BODY:")).toBeNull();
      expect(screen.queryByText("templatePreview")).toBeNull();
      expect(
        screen.getByTestId("bulk-campaign-send-panel").className
      ).not.toContain("max-xl:sticky");
      expect(screen.queryByText(/Excluded automatically if not/)).toBeNull();
      const send = screen.getByRole("button", {
        name: "sendToRecipients:1",
      }) as HTMLButtonElement;
      expect(getPriorFailureSwitch().getAttribute("aria-checked")).toBe(
        "false"
      );
      await waitFor(() =>
        expect(send.disabled).toBe(readinessState !== "ready")
      );
      if (readinessState !== "ready") {
        fireEvent.click(send);
        expect(
          fetchMock.mock.calls.some(([url]) =>
            String(url).includes("/bulk-send")
          )
        ).toBe(false);
        return;
      }
      mockBatchPlanReadiness = {
        ...mockReadyReadiness,
        state: "blocked",
        reasons: [{ code: "meta_business_limit" }],
      };
      rerender(<MultiChannelCampaignBuilder {...builderProps} />);
      await waitFor(() => expect(send.disabled).toBe(true));
      expect(mockDispatchPlanCard).toHaveBeenLastCalledWith(
        expect.objectContaining({ readiness: mockBatchPlanReadiness })
      );
      mockBatchPlanReadiness = mockReadyReadiness;
      rerender(<MultiChannelCampaignBuilder {...builderProps} />);
      await waitFor(() => expect(send.disabled).toBe(false));
      fireEvent.click(send);
      await waitFor(() =>
        expect(mockDispatchPlanCard).toHaveBeenLastCalledWith(
          expect.objectContaining({ readiness: cooldown })
        )
      );
      expect(send.disabled).toBe(true);
      expect(
        screen.getByTestId("bulk-campaign-send-panel").className
      ).not.toContain("max-xl:sticky");
      expect(
        screen.getByTestId("bulk-campaign-send-action").className
      ).not.toContain("max-xl:sticky");
      fireEvent.click(
        screen.getByRole("button", { name: "refresh-readiness" })
      );
      await waitFor(() => expect(send.disabled).toBe(false));
      expect(mockRefreshBatchPlan).toHaveBeenCalledTimes(1);
      expect(
        fetchMock.mock.calls.filter(([url]) =>
          String(url).includes("/bulk-send")
        )
      ).toHaveLength(1);
    }
  );

  it.each([
    "newer-ready",
    "older-ready",
    "missing-evaluation",
    "failed",
    "old-merged-meta",
    "legacy-rejection",
  ])(
    "rechecks a send-time contact hold at its deadline and handles a %s response",
    async outcome => {
      jest.useFakeTimers({ now: new Date("2026-09-19T15:00:00Z") });
      const rejection = {
        ...mockReadyReadiness,
        checkedAt:
          outcome === "old-merged-meta"
            ? "2026-09-19T14:00:00Z"
            : "2026-09-19T15:00:00Z",
        state: "blocked",
        reasons: [
          {
            code: "contact_frequency_limit",
            affectedRecipientCount: 1,
            eligibleRecipientCount: 0,
            nextEligibleAt: "2026-09-19T15:00:05Z",
          },
        ],
      };
      let previewCount = 0;
      let finishDeadlineCheck!: (response: Response) => void;
      const previewPayload = (readiness: unknown, evaluatedAt?: string) => ({
        requestedTotal: 1,
        eligibleTotal: 1,
        marketingOptInWarningCount: 0,
        readiness,
        evaluatedAt,
      });
      mockCampaignFetch([
        [
          "/api/whatsapp/templates",
          () => templatesResponse("deadline_marketing", "MARKETING"),
        ],
        [
          "/api/campaigns/recipient-eligibility",
          () => {
            previewCount++;
            if (previewCount === 1)
              return {
                ok: true,
                json: async () =>
                  previewPayload(mockReadyReadiness, "2026-09-19T14:59:00Z"),
              } as Response;
            if (previewCount === 2)
              return {
                ok: true,
                json: async () =>
                  previewPayload(rejection, "2026-09-19T15:00:01Z"),
              } as Response;
            return new Promise<Response>(resolve => {
              finishDeadlineCheck = resolve;
            });
          },
        ],
        [
          "/api/campaigns/bulk-send",
          () =>
            ({
              ok: false,
              status: 409,
              json: async () => ({
                code: "campaign_contact_cooldown",
                error: "Local cooldown",
                readiness: rejection,
                evaluatedAt:
                  outcome === "legacy-rejection"
                    ? undefined
                    : "2026-09-19T15:00:00Z",
              }),
            }) as Response,
        ],
      ]);
      render(
        <MultiChannelCampaignBuilder
          workspaceId={`00000000-0000-4000-8000-00000000094${["newer-ready", "older-ready", "missing-evaluation", "failed", "old-merged-meta", "legacy-rejection"].indexOf(outcome) + 1}`}
          emailEnabled={false}
          lockedChannel="whatsapp"
        />
      );
      fireEvent.change(screen.getByLabelText("campaignName"), {
        target: { value: "Contact deadline" },
      });
      fireEvent.click(
        await screen.findByRole("combobox", { name: "template" })
      );
      fireEvent.click(
        await screen.findByRole("option", { name: /deadline_marketing/ })
      );
      fireEvent.click(screen.getByText("add-recipient"));
      const send = screen.getByRole("button", {
        name: "sendToRecipients:1",
      }) as HTMLButtonElement;
      await waitFor(() => expect(send.disabled).toBe(false));
      fireEvent.click(send);
      await waitFor(() => expect(send.disabled).toBe(true));
      await waitFor(() => expect(previewCount).toBe(2));
      await act(async () => {
        await jest.advanceTimersByTimeAsync(5_000);
      });
      expect(previewCount).toBe(3);
      expect(send.disabled).toBe(true);
      await act(async () => {
        finishDeadlineCheck({
          ok: outcome !== "failed",
          status: outcome === "failed" ? 503 : 200,
          json: async () =>
            outcome === "failed"
              ? { error: "Temporarily unavailable" }
              : previewPayload(
                  outcome === "missing-evaluation"
                    ? {
                        ...mockReadyReadiness,
                        checkedAt: "2026-09-19T15:00:06Z",
                      }
                    : mockReadyReadiness,
                  outcome === "newer-ready" || outcome === "legacy-rejection"
                    ? "2026-09-19T15:00:06Z"
                    : outcome === "missing-evaluation"
                      ? undefined
                      : "2026-09-19T14:59:00Z"
                ),
        } as Response);
      });
      await waitFor(() =>
        expect(send.disabled).toBe(outcome !== "newer-ready")
      );
      expect(
        (global.fetch as jest.Mock).mock.calls.filter(([url]) =>
          String(url).includes("/bulk-send")
        )
      ).toHaveLength(1);
    }
  );

  it.each([false, true])(
    "sends permitted service text when template business readiness is blocked: %s",
    async businessBlocked => {
      if (businessBlocked)
        mockBatchPlanReadiness = {
          ...mockReadyReadiness,
          state: "blocked",
          reasons: [{ code: "meta_business_limit" }],
        };
      const fetchMock = mockCampaignFetch(
        [
          [
            "/feature-flags",
            () =>
              jsonResponse({
                flags: { whatsapp_service_bulk: true },
              }),
          ],
          [
            "/api/campaigns/bulk-send",
            () =>
              jsonResponse(
                {
                  queued: true,
                  total: 1,
                  campaignId: "service-campaign",
                  dispatchId: "service-campaign",
                  status: "queued",
                },
                200
              ),
          ],
        ],
        () => jsonResponse({ templates: [] })
      );

      render(
        <MultiChannelCampaignBuilder
          workspaceId={
            businessBlocked
              ? "00000000-0000-4000-8000-000000000912"
              : "00000000-0000-4000-8000-000000000001"
          }
          emailEnabled={false}
          lockedChannel="whatsapp"
        />
      );

      const excludePriorFailures = getPriorFailureSwitch();
      fireEvent.click(excludePriorFailures);
      const serviceTextButton = await screen.findByRole("button", {
        name: "whatsappServiceText",
      });
      fireEvent.click(serviceTextButton);
      expect(serviceTextButton.getAttribute("aria-pressed")).toBe("true");
      expect(mockDispatchPlanCard).toHaveBeenLastCalledWith(
        expect.objectContaining({
          showReadiness: false,
          onRefreshReadiness: undefined,
        })
      );
      expect(
        screen.queryByRole("switch", {
          name: "excludePriorFailedBulkSendsLabel",
        })
      ).toBeNull();
      fireEvent.change(screen.getByLabelText("campaignName"), {
        target: { value: "Service follow-up" },
      });
      fireEvent.change(screen.getByLabelText("messageText"), {
        target: { value: "Thanks for contacting us." },
      });
      fireEvent.click(screen.getByText("add-recipient"));
      fireEvent.click(screen.getByRole("button", { name: /sendToRecipients/ }));

      await waitFor(() =>
        expect(fetchMock).toHaveBeenCalledWith(
          "/api/campaigns/bulk-send",
          expect.any(Object)
        )
      );
      const bulkSendCall = fetchMock.mock.calls.find(([url]) =>
        String(url).includes("/api/campaigns/bulk-send")
      );
      expect(parseJsonRequestBody(bulkSendCall)).toEqual(
        expect.objectContaining({
          channel: "whatsapp",
          whatsappMessageType: "service_text",
          messageText: "Thanks for contacting us.",
          audience: {
            kind: "inline",
            recipients: [expect.objectContaining({ phone: "77001234567" })],
          },
        })
      );
      expect(parseJsonRequestBody(bulkSendCall)).not.toHaveProperty(
        "excludePriorFailedBulkSends"
      );
    }
  );

  it("excludes prior failed WhatsApp template recipients in the eligibility preview and send request", async () => {
    const fetchMock = mockCampaignFetch([
      ["/api/whatsapp/templates", () => templatesResponse("utility_update")],
      [
        "/api/campaigns/recipient-eligibility",
        () =>
          jsonResponse({
            requestedTotal: 2,
            readiness: mockReadyReadiness,
            eligibleTotal: 1,
            skippedOptIn: 0,
            skippedPhones: [],
            skippedPriorFailed: 1,
            marketingOptInWarningCount: 0,
            marketingOptInWarningPhones: [],
          }),
      ],
      [
        "/api/campaigns/bulk-send",
        () =>
          jsonResponse(
            {
              queued: true,
              total: 1,
              status: "queued",
            },
            200
          ),
      ],
    ]);

    render(
      <MultiChannelCampaignBuilder
        workspaceId="00000000-0000-4000-8000-000000000002"
        emailEnabled={false}
        lockedChannel="whatsapp"
      />
    );

    fireEvent.change(screen.getByLabelText("campaignName"), {
      target: { value: "Utility update" },
    });
    fireEvent.click(await screen.findByRole("combobox", { name: "template" }));
    fireEvent.click(
      await screen.findByRole("option", { name: /utility_update/ })
    );
    fireEvent.click(screen.getByText("add-recipient"));

    const excludePriorFailures = getPriorFailureSwitch();
    expect(excludePriorFailures.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(excludePriorFailures);

    await waitFor(() => {
      const eligibilityCall = [...fetchMock.mock.calls]
        .reverse()
        .find(([url]) =>
          String(url).includes("/api/campaigns/recipient-eligibility")
        );
      expect(parseJsonRequestBody(eligibilityCall)).toMatchObject({
        workspaceId: "00000000-0000-4000-8000-000000000002",
        channel: "whatsapp",
        messageIntent: {
          kind: "whatsapp_template",
          sourceId: "source-1",
          templateName: "utility_update",
          language: "en",
        },
        audience: {
          kind: "inline",
          recipients: [expect.objectContaining({ phone: "77001234567" })],
        },
        recipientPolicy: {
          version: 1,
          excludePriorFailedBulkSends: true,
        },
        provenance: { kind: "ad_hoc" },
        excludePriorFailedBulkSends: true,
      });
      expect(parseJsonRequestBody(eligibilityCall)).not.toHaveProperty(
        "templateCategory"
      );
    });
    // The filter reads its excluded count from the same recipient check.
    expect(
      await screen.findByText("priorFailedBulkSendsExcludedInline")
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "sendToRecipients:1" })
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "sendToRecipients:1" }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/campaigns/bulk-send",
        expect.any(Object)
      )
    );
    const bulkSendCall = fetchMock.mock.calls.find(([url]) =>
      String(url).includes("/api/campaigns/bulk-send")
    );
    expect(parseJsonRequestBody(bulkSendCall)).toMatchObject({
      recipientPolicy: {
        version: 1,
        excludePriorFailedBulkSends: true,
      },
    });
  });

  it.each([false, true])(
    "does not submit while eligibility is unresolved with prior-failure exclusion %s",
    async excludePriorFailures => {
      let resolveEligibility: ((response: Response) => void) | undefined;
      const eligibilityResponse = new Promise<Response>(resolve => {
        resolveEligibility = resolve;
      });
      const fetchMock = mockCampaignFetch([
        ["/api/whatsapp/templates", () => templatesResponse("utility_update")],
        ["/api/campaigns/recipient-eligibility", () => eligibilityResponse],
        [
          "/api/campaigns/bulk-send",
          () => jsonResponse({ queued: true, total: 1, status: "queued" }, 200),
        ],
      ]);

      render(
        <MultiChannelCampaignBuilder
          workspaceId={`workspace-prior-preview-loading-${excludePriorFailures}`}
          emailEnabled={false}
          lockedChannel="whatsapp"
        />
      );

      fireEvent.change(screen.getByLabelText("campaignName"), {
        target: { value: "Utility update" },
      });
      fireEvent.click(
        await screen.findByRole("combobox", { name: "template" })
      );
      fireEvent.click(
        await screen.findByRole("option", { name: /utility_update/ })
      );
      fireEvent.click(screen.getByText("add-recipient"));
      if (excludePriorFailures) {
        fireEvent.click(getPriorFailureSwitch());
      }

      await waitFor(() =>
        expect(
          fetchMock.mock.calls.some(([url]) =>
            String(url).includes("/api/campaigns/recipient-eligibility")
          )
        ).toBe(true)
      );
      const unresolvedSendButton = screen.getByRole("button", {
        name: /sendToRecipients/,
      }) as HTMLButtonElement;
      expect(unresolvedSendButton.disabled).toBe(true);
      fireEvent.click(unresolvedSendButton);
      expect(
        fetchMock.mock.calls.some(([url]) =>
          String(url).includes("/api/campaigns/bulk-send")
        )
      ).toBe(false);

      await act(async () => {
        resolveEligibility?.({
          ok: true,
          json: async () => ({
            requestedTotal: 1,
            readiness: mockReadyReadiness,
            eligibleTotal: 1,
            skippedOptIn: 0,
            skippedPriorFailed: 0,
          }),
        } as Response);
        await eligibilityResponse;
      });

      await waitFor(() =>
        expect(
          (
            screen.getByRole("button", {
              name: "sendToRecipients:1",
            }) as HTMLButtonElement
          ).disabled
        ).toBe(false)
      );
    }
  );

  it("uses the builder-local prior-failed exclusion in Analytics preview and send requests", async () => {
    const fetchMock = mockCampaignFetch([
      ["/api/whatsapp/templates", () => templatesResponse("analytics_offer")],
      [
        "/analytics/bulk/audience-preview",
        () =>
          jsonResponse({
            available: true,
            total: 2,
            readiness: mockReadyReadiness,
            eligibleTotal: 1,
            excludedOptIn: 0,
            skippedPriorFailed: 1,
            capped: false,
            maxRecipients: 1000,
          }),
      ],
      [
        "/api/campaigns/bulk-send",
        () => jsonResponse({ queued: true, total: 1, status: "queued" }),
      ],
    ]);

    render(
      <MultiChannelCampaignBuilder
        workspaceId="00000000-0000-4000-8000-000000000003"
        emailEnabled={false}
        lockedChannel="whatsapp"
        recipientSource={{
          type: "bulk_analytics",
          filters: { days: 30 },
          previewCount: 2,
        }}
      />
    );

    fireEvent.change(screen.getByLabelText("campaignName"), {
      target: { value: "Analytics update" },
    });
    fireEvent.click(await screen.findByRole("combobox", { name: "template" }));
    fireEvent.click(
      await screen.findByRole("option", { name: /analytics_offer/ })
    );
    const excludePriorFailures = getPriorFailureSwitch();
    fireEvent.click(excludePriorFailures);

    await waitFor(() => {
      const hookPreviewUrl = String(
        fetchMock.mock.calls.find(([url]) =>
          String(url).includes("excludePriorFailedBulkSends=1")
        )?.[0]
      );
      expect(hookPreviewUrl).toContain(
        "analytics/bulk/audience-preview?days=30"
      );
      expect(hookPreviewUrl).toContain("sourceId=source-1");
      expect(hookPreviewUrl).toContain("templateName=analytics_offer");
      expect(hookPreviewUrl).toContain("language=en");
      expect(hookPreviewUrl).not.toContain("templateCategory=");
      expect(hookPreviewUrl).not.toContain("maxRecipients=");
    });
    await waitFor(() => {
      const listingPreviewUrl = String(
        fetchMock.mock.calls.find(
          ([url]) =>
            String(url).includes(
              "analytics/bulk/audience-preview?days=30&sourceId=source-1"
            ) && !String(url).includes("excludePriorFailedBulkSends=1")
        )?.[0]
      );
      expect(listingPreviewUrl).toContain("templateCategory=UTILITY");
    });
    fireEvent.click(
      await screen.findByRole("button", { name: "sendToRecipients:1" })
    );

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/campaigns/bulk-send",
        expect.any(Object)
      )
    );
    const bulkSendCall = fetchMock.mock.calls.find(([url]) =>
      String(url).includes("/api/campaigns/bulk-send")
    );
    expect(parseJsonRequestBody(bulkSendCall)).toMatchObject({
      recipientPolicy: {
        version: 1,
        excludePriorFailedBulkSends: true,
      },
    });
  });

  it("uses the server-merged Analytics fill-up preview before enabling send", async () => {
    const fetchMock = mockCampaignFetch([
      ["/api/whatsapp/templates", () => templatesResponse("analytics_offer")],
      [
        "/analytics/bulk/audience-preview",
        init => {
          const combined = init?.method === "POST";
          return {
            ok: true,
            json: async () => ({
              available: true,
              total: 2,
              readiness: mockReadyReadiness,
              eligibleTotal: combined ? 2 : 1,
              excludedOptIn: 0,
              skippedPriorFailed: 1,
              capped: false,
              maxRecipients: 1000,
            }),
          } as Response;
        },
      ],
      [
        "/api/campaigns/bulk-send",
        () => jsonResponse({ queued: true, total: 2, status: "queued" }),
      ],
    ]);

    render(
      <MultiChannelCampaignBuilder
        workspaceId="workspace-analytics-fill-up-prior-failures"
        emailEnabled={false}
        lockedChannel="whatsapp"
        recipientSource={{
          type: "bulk_analytics",
          filters: { days: 30 },
          previewCount: 2,
        }}
      />
    );

    fireEvent.change(screen.getByLabelText("campaignName"), {
      target: { value: "Analytics fill-up" },
    });
    fireEvent.click(await screen.findByRole("combobox", { name: "template" }));
    fireEvent.click(
      await screen.findByRole("option", { name: /analytics_offer/ })
    );
    fireEvent.click(getPriorFailureSwitch());
    fireEvent.click(screen.getByText("upload-audience"));

    await waitFor(() => {
      const combinedCall = fetchMock.mock.calls.find(
        ([url, init]) =>
          String(url).includes("/analytics/bulk/audience-preview") &&
          init?.method === "POST"
      );
      expect(String(combinedCall?.[0])).toContain(
        "excludePriorFailedBulkSends=1"
      );
      expect(String(combinedCall?.[0])).not.toContain("maxRecipients=");
      expect(parseJsonRequestBody(combinedCall)).toEqual({
        fillUpRecipients: [expect.objectContaining({ phone: "77001234567" })],
      });
    });
    expect(
      await screen.findByRole("button", { name: "sendToRecipients:2" })
    ).toBeTruthy();
  });

  it("retains Analytics fill-up for authoritative eligibility at submit", async () => {
    mockRecipientLimitMax = 2;
    const fetchMock = mockCampaignFetch([
      ["/api/whatsapp/templates", () => templatesResponse("analytics_offer")],
      [
        "/analytics/bulk/audience-preview",
        () =>
          jsonResponse({
            available: true,
            total: 2,
            readiness: mockReadyReadiness,
            eligibleTotal: 1,
            excludedOptIn: 0,
            skippedPriorFailed: 1,
            capped: false,
            maxRecipients: 2,
          }),
      ],
      [
        "/api/campaigns/bulk-send",
        () => jsonResponse({ queued: true, total: 1, status: "queued" }, 200),
      ],
    ]);

    render(
      <MultiChannelCampaignBuilder
        workspaceId="00000000-0000-4000-8000-000000000004"
        emailEnabled={false}
        lockedChannel="whatsapp"
        recipientSource={{
          type: "bulk_analytics",
          filters: { days: 30 },
          previewCount: 2,
        }}
      />
    );

    fireEvent.change(screen.getByLabelText("campaignName"), {
      target: { value: "Capacity boundary" },
    });
    fireEvent.click(await screen.findByRole("combobox", { name: "template" }));
    fireEvent.click(
      await screen.findByRole("option", { name: /analytics_offer/ })
    );
    await waitFor(() =>
      expect(mockRecipientPicker).toHaveBeenLastCalledWith(
        expect.objectContaining({ recipientLimit: 49_999 })
      )
    );
    fireEvent.click(await screen.findByText("upload-audience"));
    await waitFor(() =>
      expect(mockRecipientPicker).toHaveBeenLastCalledWith(
        expect.objectContaining({
          recipients: [expect.objectContaining({ phone: "77001234567" })],
        })
      )
    );
    fireEvent.click(getPriorFailureSwitch());
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([url, init]) =>
            String(url).includes("/analytics/bulk/audience-preview") &&
            String(url).includes("maxRecipients=2") &&
            !String(url).includes("excludePriorFailedBulkSends=1") &&
            init?.method !== "POST"
        )
      ).toBe(true);
      expect(
        fetchMock.mock.calls.some(([url]) =>
          String(url).includes("excludePriorFailedBulkSends=1")
        )
      ).toBe(true);
    });
    expect(
      await screen.findByRole("button", { name: "sendToRecipients:1" })
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "sendToRecipients:1" }));

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([url]) =>
          String(url).includes("/api/campaigns/bulk-send")
        )
      ).toBe(true)
    );
    const bulkSendCall = fetchMock.mock.calls.find(([url]) =>
      String(url).includes("/api/campaigns/bulk-send")
    );
    expect(parseJsonRequestBody(bulkSendCall)).toMatchObject({
      audience: {
        kind: "analytics_with_fill_up",
        fillUpRecipients: [expect.objectContaining({ phone: "77001234567" })],
      },
    });
    expect(parseJsonRequestBody(bulkSendCall)).not.toHaveProperty(
      "audienceUploadEvidence"
    );
  });

  it("caps the Analytics fill-up picker at the inline request limit", async () => {
    mockRecipientLimitMax = 100_000;
    global.fetch = jest.fn(async input => {
      const url = String(input);
      if (url.includes("/analytics/bulk/audience-preview")) {
        return {
          ok: true,
          json: async () => ({
            available: true,
            total: 0,
            readiness: mockReadyReadiness,
            eligibleTotal: 0,
            excludedOptIn: 0,
            capped: false,
            maxRecipients: 50_000,
          }),
        } as Response;
      }
      if (url.includes("/api/whatsapp/templates")) {
        return {
          ok: true,
          json: async () => ({ templates: [] }),
        } as Response;
      }
      return { ok: true, json: async () => ({}) } as Response;
    }) as jest.Mock;

    render(
      <MultiChannelCampaignBuilder
        workspaceId="workspace-analytics-inline-cap"
        emailEnabled={false}
        lockedChannel="whatsapp"
        recipientSource={{
          type: "bulk_analytics",
          filters: { days: 30 },
          previewCount: 0,
        }}
      />
    );

    await waitFor(() =>
      expect(mockRecipientPicker).toHaveBeenLastCalledWith(
        expect.objectContaining({ recipientLimit: 50_000 })
      )
    );
    expect(
      (global.fetch as jest.Mock).mock.calls.some(([url]) =>
        String(url).includes("maxRecipients=50000")
      )
    ).toBe(true);
  });

  it("shows the remaining bulk campaign allowance near the send controls", () => {
    render(
      <MultiChannelCampaignBuilder
        workspaceId="workspace-1"
        emailEnabled
        lockedChannel="email"
      />
    );

    expect(screen.getByText("bulkLimit.freeRemaining")).toBeTruthy();
  });

  it("keeps email content controls visible and passes registered-user audiences to the picker", () => {
    render(
      <MultiChannelCampaignBuilder
        workspaceId="workspace-1"
        emailEnabled
        lockedChannel="email"
        registeredUsersAudience={{
          enabled: true,
          total: 12,
          totalAuthUsers: 12,
          skippedUnconfirmed: 0,
          skippedInvalidEmail: 0,
          skippedAnonymous: 0,
          skippedDuplicate: 0,
          preview: [],
        }}
      />
    );

    expect(screen.getAllByText("stepMessage").length).toBeGreaterThan(0);
    expect(
      screen
        .getAllByTestId("campaign-flow-step")
        .map(step => step.getAttribute("data-step"))
    ).toEqual(["1", "2", "3", "4"]);
    expect(screen.getByTestId("email-editor")).toBeTruthy();
    expect(screen.getByTestId("recipient-picker").textContent).toContain(
      "manual:12"
    );
    expect(mockRecipientPicker).toHaveBeenCalledWith(
      expect.objectContaining({
        audienceSource: "manual",
        registeredUsersAudience: expect.objectContaining({ total: 12 }),
      })
    );
  });

  it("does not show a local Calendar nudge for event-oriented campaigns", () => {
    render(
      <MultiChannelCampaignBuilder
        workspaceId="workspace-1"
        emailEnabled
        lockedChannel="email"
      />
    );

    fireEvent.click(screen.getByText("apply-event-template"));

    expect(screen.queryByText("googleCalendarNudgeTitle")).toBeNull();
  });

  it("keeps separate email editor content for each language tab", () => {
    render(
      <MultiChannelCampaignBuilder
        workspaceId="workspace-1"
        emailEnabled
        lockedChannel="email"
      />
    );

    expect(screen.getByTestId("email-editor-subject").textContent).toBe(
      "Update from {{company}}"
    );
    expect(
      screen.getByTestId("email-editor").getAttribute("data-draft-key")
    ).toBe("bulk-campaign-email-draft:workspace-1:en");

    fireEvent.click(screen.getByRole("tab", { name: /RU Russian/i }));
    expect(screen.getByTestId("email-editor-subject").textContent).toBe("");
    expect(
      screen.getByTestId("email-editor").getAttribute("data-draft-key")
    ).toBe("bulk-campaign-email-draft:workspace-1:ru");

    fireEvent.click(screen.getByText("apply-event-template"));
    expect(screen.getByTestId("email-editor-subject").textContent).toBe(
      "Demo event reminder"
    );

    fireEvent.click(screen.getByRole("tab", { name: /EN English/i }));
    expect(screen.getByTestId("email-editor-subject").textContent).toBe(
      "Update from {{company}}"
    );

    fireEvent.click(screen.getByRole("tab", { name: /RU Russian ready/i }));
    expect(screen.getByTestId("email-editor-subject").textContent).toBe(
      "Demo event reminder"
    );
  });

  it("prefills an Airi WhatsApp bulk draft and selects a matching approved template", async () => {
    global.fetch = jest.fn(async (url: string) => {
      if (url.includes("/api/whatsapp/templates")) {
        return {
          ok: true,
          json: async () => ({
            templates: [
              {
                name: "pricing_lead_win_back",
                language: "en",
                category: "MARKETING",
                components: [
                  {
                    type: "BODY",
                    text: "Hi {{1}}, want help choosing the right plan?",
                  },
                ],
              },
            ],
          }),
        } as Response;
      }
      return {
        ok: true,
        json: async () => ({}),
      } as Response;
    }) as jest.Mock;

    render(
      <MultiChannelCampaignBuilder
        workspaceId="workspace-1"
        emailEnabled={false}
        lockedChannel="whatsapp"
        initialDraft={{
          id: "airi-bulk:pricing-lead-win-back",
          workspaceId: "workspace-1",
          title: "Pricing lead win-back",
          channel: "whatsapp",
          campaignName: "Pricing lead win-back",
          goal: "Recover warm leads.",
          angle: "Helpful follow-up",
          recipientSourceSummary: "Warm WhatsApp leads",
          templateSelection: {
            name: "pricing_lead_win_back",
            language: "en",
            category: "MARKETING",
          },
          templateReadiness: "needs_template_approval",
        }}
      />
    );

    expect(screen.getByDisplayValue("Pricing lead win-back")).toBeTruthy();
    expect(screen.getByText("airiDraft.title")).toBeTruthy();
    await waitFor(() =>
      expect(document.body.textContent).toContain("pricing_lead_win_back")
    );
    expect(screen.getAllByText("Warm WhatsApp leads")[0]).toBeTruthy();
  });

  it("doesn't say an Airi draft's template needs approval when Meta can't load templates", async () => {
    global.fetch = jest.fn(async (url: string) => {
      if (url.includes("/api/whatsapp/templates")) {
        return {
          ok: false,
          status: 429,
          json: async () => ({
            error: "Meta temporarily limited WhatsApp template requests.",
            code: "WHATSAPP_TEMPLATES_RATE_LIMITED",
            retryAt: "2099-10-06T13:00:00.000Z",
          }),
        } as Response;
      }
      return { ok: true, json: async () => ({}) } as Response;
    }) as jest.Mock;

    render(
      <MultiChannelCampaignBuilder
        workspaceId="workspace-draft-catalog-limited"
        emailEnabled={false}
        lockedChannel="whatsapp"
        initialDraft={{
          id: "airi-bulk:catalog-limited",
          workspaceId: "workspace-draft-catalog-limited",
          title: "Catalog limited",
          channel: "whatsapp",
          campaignName: "Catalog limited",
          goal: "Recover warm leads.",
          angle: "Helpful follow-up",
          recipientSourceSummary: "Warm WhatsApp leads",
          templateSelection: {
            name: "pricing_lead_win_back",
            language: "en",
            category: "MARKETING",
          },
          templateReadiness: "needs_template_approval",
        }}
      />
    );

    expect(await screen.findByText("templatesUnavailable")).toBeTruthy();
    expect(screen.getByText("airiDraft.title")).toBeTruthy();
    expect(screen.queryByText("airiDraft.templateNeedsApproval")).toBeNull();
  });

  it("doesn't say an Airi draft's template needs approval when only a stale saved catalog lacks it", async () => {
    global.fetch = jest.fn(async (url: string) => {
      if (url.includes("/api/whatsapp/templates")) {
        return {
          ok: true,
          json: async () => ({
            templates: [
              {
                id: "tpl-other",
                name: "other_offer",
                language: "en",
                status: "APPROVED",
                category: "MARKETING",
                components: [{ type: "BODY", text: "Hello" }],
              },
            ],
            catalog: {
              source: "cache",
              stale: true,
              fetchedAt: "2026-10-06T10:00:00.000Z",
              wabaId: "waba-1",
              refreshOutcome: "cooldown",
              retryAt: "2099-10-06T13:00:00.000Z",
            },
          }),
        } as Response;
      }
      return { ok: true, json: async () => ({}) } as Response;
    }) as jest.Mock;

    render(
      <MultiChannelCampaignBuilder
        workspaceId="workspace-draft-catalog-stale"
        emailEnabled={false}
        lockedChannel="whatsapp"
        initialDraft={{
          id: "airi-bulk:catalog-stale",
          workspaceId: "workspace-draft-catalog-stale",
          title: "Catalog stale",
          channel: "whatsapp",
          campaignName: "Catalog stale",
          goal: "Recover warm leads.",
          angle: "Helpful follow-up",
          recipientSourceSummary: "Warm WhatsApp leads",
          templateSelection: {
            name: "pricing_lead_win_back",
            language: "en",
            category: "MARKETING",
          },
          templateReadiness: "needs_template_approval",
        }}
      />
    );

    // The draft line names the unchecked template; only the template step
    // says the list is saved.
    await waitFor(() =>
      expect(screen.getByText("airiDraft.templateUnverified")).toBeTruthy()
    );
    expect(screen.getAllByText("savedTemplatesWarning")).toHaveLength(1);
    expect(screen.getByText("airiDraft.title")).toBeTruthy();
    expect(screen.queryByText("airiDraft.templateNeedsApproval")).toBeNull();
    expect(screen.queryByText("airiDraft.selectApprovedTemplate")).toBeNull();
  });

  it("says templates can't load, not that none exist, when a stale saved catalog is empty", async () => {
    global.fetch = jest.fn(async (url: string) => {
      if (url.includes("/api/whatsapp/templates")) {
        return {
          ok: true,
          json: async () => ({
            templates: [],
            catalog: {
              source: "cache",
              stale: true,
              fetchedAt: "2026-10-06T10:00:00.000Z",
              wabaId: "waba-1",
              refreshOutcome: "cooldown",
              retryAt: "2099-10-06T13:00:00.000Z",
            },
          }),
        } as Response;
      }
      return { ok: true, json: async () => ({}) } as Response;
    }) as jest.Mock;

    render(
      <MultiChannelCampaignBuilder
        workspaceId="workspace-draft-catalog-stale-empty"
        emailEnabled={false}
        lockedChannel="whatsapp"
      />
    );

    await waitFor(() =>
      expect(screen.getByText("templatesUnavailable")).toBeTruthy()
    );
    expect(screen.queryByText("noTemplates")).toBeNull();
  });

  it("resets prior-failure exclusion when a different initial draft is loaded", async () => {
    global.fetch = jest.fn(async (url: string) => {
      if (url.includes("/api/whatsapp/templates")) {
        return {
          ok: true,
          json: async () => ({
            templates: [
              {
                name: "draft_template",
                language: "en",
                category: "UTILITY",
                components: [{ type: "BODY", text: "Hello" }],
              },
            ],
          }),
        } as Response;
      }
      return { ok: true, json: async () => ({}) } as Response;
    }) as jest.Mock;
    const firstDraft = {
      id: "airi-bulk:first-draft",
      workspaceId: "workspace-draft-reset",
      title: "First draft",
      channel: "whatsapp" as const,
      campaignName: "First draft",
      goal: "Reach the first audience.",
      angle: "Direct",
      recipientSourceSummary: "First audience",
      templateSelection: {
        name: "draft_template",
        language: "en",
        category: "UTILITY" as const,
      },
      templateReadiness: "select_approved_template" as const,
    };
    const { rerender } = render(
      <MultiChannelCampaignBuilder
        workspaceId="workspace-draft-reset"
        emailEnabled={false}
        lockedChannel="whatsapp"
        initialDraft={firstDraft}
      />
    );
    await waitFor(() =>
      expect(document.body.textContent).toContain("draft_template")
    );
    const exclusionSwitch = getPriorFailureSwitch();
    fireEvent.click(exclusionSwitch);
    expect(exclusionSwitch.getAttribute("aria-checked")).toBe("true");

    rerender(
      <MultiChannelCampaignBuilder
        workspaceId="workspace-draft-reset"
        emailEnabled={false}
        lockedChannel="whatsapp"
        initialDraft={{
          ...firstDraft,
          id: "airi-bulk:second-draft",
          title: "Second draft",
          campaignName: "Second draft",
          recipientSourceSummary: "Second audience",
        }}
      />
    );

    expect(getPriorFailureSwitch().getAttribute("aria-checked")).toBe("false");
  });

  it("shows account health but keeps send disabled without a message readiness check", async () => {
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (url.includes("/api/whatsapp/onboarding")) {
        return {
          ok: true,
          json: async () => ({
            connected: true,
            status: {
              account_health: {
                state: "payment_required",
                reasons: [
                  {
                    code: "payment_required",
                    title: "Payment setup required",
                    message:
                      "Meta may reject sends until billing is configured.",
                    source: "payment_configuration_update",
                  },
                ],
              },
            },
          }),
        } as Response;
      }
      return {
        ok: true,
        json: async () => ({ templates: [] }),
      } as Response;
    }) as jest.Mock;

    render(
      <MultiChannelCampaignBuilder
        workspaceId="workspace-health"
        emailEnabled={false}
        lockedChannel="whatsapp"
      />
    );

    expect(
      await screen.findByText("connectionDetails")
    ).toBeTruthy();
    expect(screen.getByText(/Payment setup required/)).toBeTruthy();
    expect(
      screen.getByTestId("bulk-campaign-send-panel").className
    ).not.toContain("max-xl:sticky");

    fireEvent.click(screen.getByText("add-recipient"));

    await waitFor(() =>
      expect(
        (
          screen.getByRole("button", {
            name: /sendToRecipients/,
          }) as HTMLButtonElement
        ).disabled
      ).toBe(true)
    );
    expect(
      screen.getByRole("button", { name: /sendToRecipients/ }).className
    ).toContain("[&_.btn-push-front]:whitespace-normal");
  });

  it.each(["ready", "blocked"] as const)(
    "keeps inbound silence diagnostic separate from %s sending readiness",
    async readinessState => {
      const inboundSilentSince = "2026-10-17 15:06 UTC";
      const inboundReason = {
        code: "inbound_silent",
        title: "No incoming WhatsApp messages",
        message: `airi.chat has not received any messages for this number since ${inboundSilentSince}, which is unusual for it. Send a test message to the number; if it does not arrive, reconnect WhatsApp.`,
        source: "inbound_liveness",
      };
      const readiness = {
        ...mockReadyReadiness,
        state: readinessState,
        reasons:
          readinessState === "blocked"
            ? [{ code: "meta_sender_restricted" }]
            : [],
      };
      mockBatchPlanReadiness = readiness;

      async function renderWithHealth(state: "healthy" | "warning") {
        mockCampaignFetch([
          [
            "/api/whatsapp/onboarding",
            () => jsonResponse({
              connected: true,
              status: {
                account_health: {
                  state,
                  reasons: state === "warning" ? [inboundReason] : [],
                  lastCheckedAt: "2026-10-19T08:00:00.000Z",
                },
              },
            }),
          ],
          ["/api/whatsapp/templates", () => templatesResponse("inbound_diagnostic")],
          [
            "/api/campaigns/recipient-eligibility",
            () => jsonResponse({
              state: "ready",
              evaluatedAt: "2026-10-19T08:00:00.000Z",
              requestedTotal: 1,
              acceptedTotal: 1,
              uniqueRecipients: { requested: 1, accepted: 1 },
              skippedByReason: {},
              warnings: { missingMarketingConsent: 0 },
              allExcluded: false,
              readiness,
            }),
          ],
        ]);
        const view = render(
          <MultiChannelCampaignBuilder
            workspaceId={`workspace-inbound-${readinessState}-${state}`}
            emailEnabled={false}
            lockedChannel="whatsapp"
          />
        );
        fireEvent.click(await screen.findByRole("combobox", { name: "template" }));
        fireEvent.click(await screen.findByRole("option", { name: /inbound_diagnostic/ }));
        fireEvent.click(screen.getByText("add-recipient"));
        await waitFor(() => expect(
          screen.getByTestId("shared-send-status").textContent
        ).toBe(readinessState));
        return view;
      }

      const healthyView = await renderWithHealth("healthy");
      const healthySendDisabled = (
        screen.getByRole("button", { name: /sendToRecipients/ }) as HTMLButtonElement
      ).disabled;
      expect(healthySendDisabled).toBe(readinessState === "blocked");
      healthyView.unmount();

      await renderWithHealth("warning");
      const connectionDetails = await screen.findByRole("button", {
        name: "connectionDetails",
      });
      expect(connectionDetails.getAttribute("aria-expanded")).toBe("false");
      expect(screen.queryByText("inboundActivityDescription")).toBeNull();
      expect(document.body.textContent).not.toContain(inboundReason.title);
      expect(document.body.textContent).not.toContain(inboundReason.message);
      expect(document.body.textContent).not.toContain(inboundSilentSince);
      expect(document.body.textContent).not.toContain("reconnect WhatsApp");
      expect(
        (screen.getByRole("button", { name: /sendToRecipients/ }) as HTMLButtonElement).disabled
      ).toBe(healthySendDisabled);

      fireEvent.click(connectionDetails);
      expect(connectionDetails.getAttribute("aria-expanded")).toBe("true");
      expect(screen.getByText("inboundActivityDescription")).toBeTruthy();
      expect(document.body.textContent).not.toContain(inboundReason.title);
      expect(document.body.textContent).not.toContain(inboundSilentSince);
      expect(document.body.textContent).not.toContain("reconnect WhatsApp");
      expect(screen.getByTestId("shared-send-status").textContent).toBe(readinessState);
      expect(
        (screen.getByRole("button", { name: /sendToRecipients/ }) as HTMLButtonElement).disabled
      ).toBe(healthySendDisabled);
    }
  );

  it("sends manual upload evidence and retains queued dispatch identity and overlap", async () => {
    const fetchMock = mockCampaignFetch(
      [
        [
          "/api/campaigns/bulk-send",
          () =>
            jsonResponse(
              {
                queued: true,
                total: 1,
                campaignId: "campaign-1",
                dispatchId: "dispatch-1",
                workflowId: "workflow-1",
                status: "queued",
                audience: {
                  fingerprint: "a".repeat(64),
                  requestedTotal: 1,
                  queuedTotal: 1,
                  skippedOptIn: 0,
                  overlap: {
                    kind: "high",
                    intersectionCount: 10,
                    candidateCount: 12,
                    ratio: 10 / 12,
                  },
                },
              },
              200
            ),
        ],
      ],
      () => jsonResponse({ templates: [] })
    );

    render(
      <MultiChannelCampaignBuilder
        workspaceId="00000000-0000-4000-8000-000000000005"
        emailEnabled
        lockedChannel="email"
      />
    );

    fireEvent.change(screen.getByLabelText("campaignName"), {
      target: { value: "Evidence campaign" },
    });
    fireEvent.click(screen.getByText("upload-audience"));
    fireEvent.click(screen.getByRole("button", { name: /sendToRecipients/ }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/campaigns/bulk-send",
        expect.any(Object)
      )
    );
    const bulkSendCall = fetchMock.mock.calls.find(([url]) =>
      String(url).includes("/api/campaigns/bulk-send")
    );
    const body = parseJsonRequestBody(bulkSendCall);
    expect(body.audience.uploadEvidence).toEqual({
      originalFilename: "uploaded-audience.csv",
      selectedAt: "2026-07-24T08:00:00.000Z",
    });
    await waitFor(() =>
      expect(mockDispatchPlanCard).toHaveBeenLastCalledWith(
        expect.objectContaining({
          workspaceId: "00000000-0000-4000-8000-000000000005",
          queuedDispatch: expect.objectContaining({
            campaignId: "campaign-1",
            dispatchId: "dispatch-1",
            workflowId: "workflow-1",
            status: "queued",
            audienceFingerprint: "a".repeat(64),
            overlap: expect.objectContaining({
              intersectionCount: 10,
              candidateCount: 12,
            }),
          }),
        })
      )
    );
    expect(
      (
        screen.getByRole("button", {
          name: /sendToRecipients/,
        }) as HTMLButtonElement
      ).disabled
    ).toBe(true);

    fireEvent.click(screen.getByText("complete-plan-dispatch"));
    fireEvent.click(screen.getByText("upload-audience"));
    await waitFor(() =>
      expect(
        (
          screen.getByRole("button", {
            name: /sendToRecipients/,
          }) as HTMLButtonElement
        ).disabled
      ).toBe(false)
    );
  });

  it("requires a second explicit send for recent overlap and invalidates confirmation when the audience changes", async () => {
    const firstFingerprint = "b".repeat(64);
    const revisedFingerprint = "c".repeat(64);
    let sendAttempts = 0;
    const fetchMock = mockCampaignFetch(
      [
        [
          "/api/campaigns/bulk-send",
          () => {
            sendAttempts += 1;
            if (sendAttempts <= 2) {
              return {
                ok: false,
                status: 409,
                json: async () => ({
                  error: "Confirm recent audience reuse",
                  code: "bulk_campaign_recent_audience_confirmation_required",
                  audience: {
                    fingerprint:
                      sendAttempts === 1
                        ? firstFingerprint
                        : revisedFingerprint,
                    overlap: {
                      kind: "high",
                      intersectionCount: 10,
                      candidateCount: 12,
                      ratio: 10 / 12,
                    },
                  },
                  audienceConfirmation: { required: true, confirmed: false },
                }),
              } as Response;
            }
            return {
              ok: true,
              status: 200,
              json: async () => ({
                queued: true,
                total: 1,
                campaignId: "campaign-confirmed",
                dispatchId: "campaign-confirmed",
                status: "queued",
              }),
            } as Response;
          },
        ],
      ],
      () => jsonResponse({ templates: [] })
    );

    render(
      <MultiChannelCampaignBuilder
        workspaceId="00000000-0000-4000-8000-000000000006"
        emailEnabled
        lockedChannel="email"
      />
    );
    fireEvent.change(screen.getByLabelText("campaignName"), {
      target: { value: "Repeat audience" },
    });
    fireEvent.click(screen.getByText("upload-audience"));
    fireEvent.click(screen.getByRole("button", { name: /sendToRecipients/ }));

    expect(await screen.findByText("recentAudienceOverlap")).toBeTruthy();
    expect(sendAttempts).toBe(1);

    fireEvent.click(screen.getByText("upload-audience"));
    expect(screen.queryByText("recentAudienceOverlap")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /sendToRecipients/ }));
    await waitFor(() => expect(sendAttempts).toBe(2));
    expect(await screen.findByText("recentAudienceOverlap")).toBeTruthy();
    const revisedAudienceBody = parseJsonRequestBody(
      fetchMock.mock.calls.filter(([url]) =>
        String(url).includes("/api/campaigns/bulk-send")
      )[1]
    );
    expect(revisedAudienceBody.audienceConfirmationFingerprint).toBeUndefined();

    fireEvent.click(screen.getByRole("button", { name: "sendAgain" }));
    await waitFor(() => expect(sendAttempts).toBe(3));
    const confirmedBody = parseJsonRequestBody(
      fetchMock.mock.calls.filter(([url]) =>
        String(url).includes("/api/campaigns/bulk-send")
      )[2]
    );
    expect(confirmedBody.audienceConfirmationFingerprint).toBe(
      revisedFingerprint
    );
  });

  it("ignores a late overlap confirmation response after the audience changes", async () => {
    let resolveBulkSend: ((response: Response) => void) | null = null;
    const pendingBulkSend = new Promise<Response>(resolve => {
      resolveBulkSend = resolve;
    });
    const fetchMock = mockCampaignFetch(
      [["/api/campaigns/bulk-send", () => pendingBulkSend]],
      () => jsonResponse({ templates: [] })
    );

    render(
      <MultiChannelCampaignBuilder
        workspaceId="00000000-0000-4000-8000-000000000007"
        emailEnabled
        lockedChannel="email"
      />
    );
    fireEvent.change(screen.getByLabelText("campaignName"), {
      target: { value: "Changed audience" },
    });
    fireEvent.click(screen.getByText("upload-audience"));
    fireEvent.click(screen.getByRole("button", { name: /sendToRecipients/ }));

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.filter(([url]) =>
          String(url).includes("/api/campaigns/bulk-send")
        )
      ).toHaveLength(1)
    );

    fireEvent.click(screen.getByText("upload-audience"));
    await act(async () => {
      resolveBulkSend?.({
        ok: false,
        status: 409,
        json: async () => ({
          error: "Confirm recent audience reuse",
          code: "bulk_campaign_recent_audience_confirmation_required",
          audience: {
            fingerprint: "d".repeat(64),
            overlap: {
              kind: "high",
              intersectionCount: 10,
              candidateCount: 12,
              ratio: 10 / 12,
            },
          },
          audienceConfirmation: { required: true, confirmed: false },
        }),
      } as Response);
      await pendingBulkSend;
    });

    await waitFor(() =>
      expect(
        (
          screen.getByRole("button", {
            name: /sendToRecipients/,
          }) as HTMLButtonElement
        ).disabled
      ).toBe(false)
    );
    expect(screen.queryByText("recentAudienceOverlap")).toBeNull();
    expect(screen.queryByRole("button", { name: "sendAgain" })).toBeNull();
  });

  it("records a queued dispatch without clearing a newer audience draft", async () => {
    let resolveBulkSend: ((response: Response) => void) | null = null;
    const pendingBulkSend = new Promise<Response>(resolve => {
      resolveBulkSend = resolve;
    });
    const fetchMock = mockCampaignFetch(
      [["/api/campaigns/bulk-send", () => pendingBulkSend]],
      () => jsonResponse({ templates: [] })
    );

    render(
      <MultiChannelCampaignBuilder
        workspaceId="00000000-0000-4000-8000-000000000008"
        emailEnabled
        lockedChannel="email"
      />
    );
    fireEvent.change(screen.getByLabelText("campaignName"), {
      target: { value: "Keep this newer draft" },
    });
    fireEvent.click(screen.getByText("upload-audience"));
    fireEvent.click(screen.getByRole("button", { name: /sendToRecipients/ }));

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.filter(([url]) =>
          String(url).includes("/api/campaigns/bulk-send")
        )
      ).toHaveLength(1)
    );

    fireEvent.click(screen.getByText("upload-audience"));
    await act(async () => {
      resolveBulkSend?.({
        ok: true,
        status: 200,
        json: async () => ({
          queued: true,
          total: 1,
          campaignId: "campaign-late-success",
          dispatchId: "dispatch-late-success",
          status: "queued",
        }),
      } as Response);
      await pendingBulkSend;
    });

    await waitFor(() =>
      expect(mockDispatchPlanCard).toHaveBeenLastCalledWith(
        expect.objectContaining({
          queuedDispatch: expect.objectContaining({
            campaignId: "campaign-late-success",
            dispatchId: "dispatch-late-success",
            status: "queued",
          }),
        })
      )
    );
    expect(
      (screen.getByLabelText("campaignName") as HTMLInputElement).value
    ).toBe("Keep this newer draft");
    expect(mockRecipientPicker).toHaveBeenLastCalledWith(
      expect.objectContaining({
        audienceUploadEvidence: expect.objectContaining({
          originalFilename: "analytics-fill-up.csv",
        }),
      })
    );
  });

  it("rejects an old manual picker callback after a channel round trip", async () => {
    render(
      <MultiChannelCampaignBuilder
        workspaceId="workspace-channel-owner"
        emailEnabled
      />
    );

    await waitFor(() =>
      expect(mockRecipientPicker).toHaveBeenLastCalledWith(
        expect.objectContaining({ channel: "whatsapp" })
      )
    );
    const oldPickerProps = mockRecipientPicker.mock.calls.at(-1)?.[0] as {
      onUploadedAudienceChange?: (audience: {
        recipients: MockCampaignRecipient[];
        uploadEvidence: {
          originalFilename: string;
          selectedAt: string;
        };
      }) => void;
    };

    fireEvent.click(screen.getByRole("combobox", { name: "channel" }));
    fireEvent.click(
      await screen.findByRole("option", { name: "emailCampaigns" })
    );
    await waitFor(() =>
      expect(mockRecipientPicker).toHaveBeenLastCalledWith(
        expect.objectContaining({ channel: "email", recipients: [] })
      )
    );

    fireEvent.click(screen.getByRole("combobox", { name: "channel" }));
    fireEvent.click(
      await screen.findByRole("option", { name: "whatsappTemplates" })
    );
    await waitFor(() =>
      expect(mockRecipientPicker).toHaveBeenLastCalledWith(
        expect.objectContaining({ channel: "whatsapp", recipients: [] })
      )
    );

    act(() => {
      oldPickerProps.onUploadedAudienceChange?.({
        recipients: [{ phone: "77001112233", name: "Old WhatsApp row" }],
        uploadEvidence: {
          originalFilename: "old-whatsapp.csv",
          selectedAt: "2026-07-24T08:00:00.000Z",
        },
      });
    });

    await waitFor(() =>
      expect(mockRecipientPicker).toHaveBeenLastCalledWith(
        expect.objectContaining({
          channel: "whatsapp",
          recipients: [],
          audienceUploadEvidence: null,
        })
      )
    );
  });

  it("does not carry a manual audience into another workspace", async () => {
    const view = render(
      <MultiChannelCampaignBuilder
        workspaceId="workspace-a"
        emailEnabled
        lockedChannel="email"
      />
    );

    fireEvent.click(screen.getByText("upload-audience"));
    await waitFor(() =>
      expect(mockRecipientPicker).toHaveBeenLastCalledWith(
        expect.objectContaining({
          channel: "email",
          recipients: [expect.objectContaining({ email: "dana@example.com" })],
        })
      )
    );

    view.rerender(
      <MultiChannelCampaignBuilder
        workspaceId="workspace-b"
        emailEnabled
        lockedChannel="email"
      />
    );

    await waitFor(() =>
      expect(mockRecipientPicker).toHaveBeenLastCalledWith(
        expect.objectContaining({
          channel: "email",
          recipients: [],
          audienceUploadEvidence: null,
        })
      )
    );
  });

  it("keeps manual and Analytics fill-up upload evidence independent", async () => {
    const fetchMock = mockCampaignFetch(
      [
        ["/api/whatsapp/templates", () => templatesResponse("analytics_offer")],
        [
          "/analytics/bulk/audience-preview",
          () =>
            jsonResponse({
              available: true,
              total: 1,
              readiness: mockReadyReadiness,
              eligibleTotal: 1,
              excludedOptIn: 0,
              capped: false,
              maxRecipients: 1000,
            }),
        ],
        [
          "/api/campaigns/bulk-send",
          () =>
            jsonResponse(
              {
                queued: true,
                total: 2,
                campaignId: "analytics-campaign",
                dispatchId: "analytics-campaign",
                status: "queued",
              },
              200
            ),
        ],
      ],
      () => jsonResponse({})
    );
    const initialDraft = {
      id: "airi-bulk:analytics",
      workspaceId: "00000000-0000-4000-8000-000000000009",
      title: "Analytics audience",
      channel: "whatsapp" as const,
      campaignName: "Analytics audience",
      goal: "Reach selected cohort.",
      angle: "Direct",
      recipientSourceSummary: "Analytics cohort",
      templateSelection: {
        name: "analytics_offer",
        language: "en",
        category: "UTILITY" as const,
      },
      templateReadiness: "select_approved_template" as const,
    };
    const { rerender } = render(
      <MultiChannelCampaignBuilder
        workspaceId="00000000-0000-4000-8000-000000000009"
        emailEnabled={false}
        lockedChannel="whatsapp"
        initialDraft={initialDraft}
      />
    );

    await waitFor(() =>
      expect(mockRecipientPicker).toHaveBeenCalledWith(
        expect.objectContaining({ recipientLimit: 50_000 })
      )
    );
    fireEvent.click(screen.getByText("upload-audience"));

    rerender(
      <MultiChannelCampaignBuilder
        workspaceId="00000000-0000-4000-8000-000000000009"
        emailEnabled={false}
        lockedChannel="whatsapp"
        initialDraft={initialDraft}
        recipientSource={{
          type: "bulk_analytics",
          filters: { days: 30 },
          previewCount: 1,
        }}
      />
    );

    await waitFor(() =>
      expect(mockRecipientPicker).toHaveBeenCalledWith(
        expect.objectContaining({ recipientLimit: 49_999 })
      )
    );
    fireEvent.click(screen.getByRole("combobox", { name: "template" }));
    fireEvent.click(
      await screen.findByRole("option", { name: /analytics_offer/ })
    );
    fireEvent.click(screen.getByText("upload-audience"));
    const sendButton = screen.getByRole("button", {
      name: /sendToRecipients/,
    }) as HTMLButtonElement;
    await waitFor(() => expect(sendButton.disabled).toBe(false));
    fireEvent.click(sendButton);

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/campaigns/bulk-send",
        expect.any(Object)
      )
    );
    const bulkSendCall = fetchMock.mock.calls.find(([url]) =>
      String(url).includes("/api/campaigns/bulk-send")
    );
    const body = parseJsonRequestBody(bulkSendCall);
    expect(body.audience).not.toHaveProperty("uploadEvidence");
    expect(body).not.toHaveProperty("audienceUploadEvidence");
    expect(body.audience.fillUpRecipients).toEqual([
      expect.objectContaining({ phone: "77001234567" }),
    ]);
  });

  it("rejects an old analytics fill-up callback after the filter owner changes", async () => {
    mockCampaignFetch(
      [
        [
          "/analytics/bulk/audience-preview",
          () =>
            jsonResponse({
              available: true,
              total: 1,
              readiness: mockReadyReadiness,
              eligibleTotal: 1,
              excludedOptIn: 0,
              capped: false,
              maxRecipients: 1000,
            }),
        ],
      ],
      () => jsonResponse({ templates: [] })
    );
    const { rerender } = render(
      <MultiChannelCampaignBuilder
        workspaceId="workspace-fill-up-owner"
        emailEnabled={false}
        lockedChannel="whatsapp"
        recipientSource={{
          type: "bulk_analytics",
          filters: { days: 30 },
          previewCount: 1,
        }}
      />
    );

    await waitFor(() =>
      expect(mockRecipientPicker).toHaveBeenLastCalledWith(
        expect.objectContaining({ channel: "whatsapp", compact: true })
      )
    );
    const oldPickerProps = mockRecipientPicker.mock.calls.at(-1)?.[0] as {
      onUploadedAudienceChange?: (audience: {
        recipients: MockCampaignRecipient[];
        uploadEvidence: {
          originalFilename: string;
          selectedAt: string;
        };
      }) => void;
    };

    rerender(
      <MultiChannelCampaignBuilder
        workspaceId="workspace-fill-up-owner"
        emailEnabled={false}
        lockedChannel="whatsapp"
        recipientSource={{
          type: "bulk_analytics",
          filters: { days: 60 },
          previewCount: 1,
        }}
      />
    );
    await waitFor(() =>
      expect(mockRecipientPicker).toHaveBeenLastCalledWith(
        expect.objectContaining({
          recipients: [],
          audienceUploadEvidence: null,
        })
      )
    );

    act(() => {
      oldPickerProps.onUploadedAudienceChange?.({
        recipients: [{ phone: "77004445566", name: "Old filter row" }],
        uploadEvidence: {
          originalFilename: "old-filter.csv",
          selectedAt: "2026-07-24T08:00:00.000Z",
        },
      });
    });

    await waitFor(() =>
      expect(mockRecipientPicker).toHaveBeenLastCalledWith(
        expect.objectContaining({
          recipients: [],
          audienceUploadEvidence: null,
        })
      )
    );
  });

  it("submits the Telegram known-subscriber audience from the builder", async () => {
    const fetchMock = jest.fn<
      Promise<Response>,
      [RequestInfo | URL, RequestInit?]
    >(async input => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;

      if (
        url.includes(
          "/api/workspaces/00000000-0000-4000-8000-000000000010/integrations"
        )
      ) {
        return {
          ok: true,
          json: async () => ({
            sources: [
              {
                id: "telegram-source-1",
                type: "telegram",
                name: "Telegram main",
                credentials: { bot_username: "airi_bot" },
              },
            ],
          }),
        } as Response;
      }

      if (url.includes("/api/sources/telegram/telegram-source-1/subscribers")) {
        return {
          ok: true,
          json: async () => ({
            total: 3,
            subscribers: [],
            latestImport: null,
          }),
        } as Response;
      }

      if (url.includes("/api/campaigns/bulk-send")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            queued: true,
            total: 3,
            requestedTotal: 3,
            status: "queued",
          }),
        } as Response;
      }

      return {
        ok: true,
        json: async () => ({ templates: [] }),
      } as Response;
    }) as jest.Mock;
    global.fetch = fetchMock;

    render(
      <MultiChannelCampaignBuilder
        workspaceId="00000000-0000-4000-8000-000000000010"
        emailEnabled={false}
        lockedChannel="telegram"
      />
    );

    fireEvent.change(screen.getByLabelText("campaignName"), {
      target: { value: "Telegram known subscribers" },
    });
    fireEvent.change(screen.getByLabelText("messageText"), {
      target: { value: "Hello {{name}}" },
    });
    expect(
      await screen.findByText("telegramAudience.subscriberCount")
    ).toBeTruthy();
    // Only the total is used, so one row is enough.
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/sources/telegram/telegram-source-1/subscribers?workspaceId=00000000-0000-4000-8000-000000000010&limit=1"
    );
    expect(screen.getByText("telegramAudience.rateHint")).toBeTruthy();
    await waitFor(() =>
      expect(mockRecipientPicker).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceIds: ["telegram-source-1"],
        })
      )
    );
    fireEvent.click(
      screen.getByRole("button", { name: "telegramAudience.known" })
    );
    fireEvent.click(screen.getByRole("button", { name: /sendToRecipients/ }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/campaigns/bulk-send",
        expect.any(Object)
      )
    );
    const bulkSendCall = fetchMock.mock.calls.find(([url]) =>
      String(url).includes("/api/campaigns/bulk-send")
    );
    const body = parseJsonRequestBody(bulkSendCall);
    expect(body).toEqual(
      expect.objectContaining({
        channel: "telegram",
        messageText: "Hello {{name}}",
        audience: {
          kind: SCENARIO_BULK_TELEGRAM_SUBSCRIBERS_AUDIENCE_SOURCE,
          sourceId: "telegram-source-1",
        },
      })
    );
  });

  it("rejects an old Telegram picker callback after a bot round trip", async () => {
    mockCampaignFetch(
      [
        [
          "/integrations",
          () =>
            jsonResponse({
              sources: [
                {
                  id: "telegram-source-a",
                  type: "telegram",
                  name: "Telegram A",
                  credentials: { bot_username: "airi_a_bot" },
                },
                {
                  id: "telegram-source-b",
                  type: "telegram",
                  name: "Telegram B",
                  credentials: { bot_username: "airi_b_bot" },
                },
              ],
            }),
        ],
        [
          "/subscribers",
          () => jsonResponse({ total: 0, subscribers: [], latestImport: null }),
        ],
      ],
      () => jsonResponse({ templates: [] })
    );

    render(
      <MultiChannelCampaignBuilder
        workspaceId="workspace-telegram-owner"
        emailEnabled={false}
        lockedChannel="telegram"
      />
    );

    await waitFor(() =>
      expect(mockRecipientPicker).toHaveBeenLastCalledWith(
        expect.objectContaining({
          channel: "telegram",
          sourceIds: ["telegram-source-a"],
        })
      )
    );
    const oldPickerProps = mockRecipientPicker.mock.calls.at(-1)?.[0] as {
      onUploadedAudienceChange?: (audience: {
        recipients: MockCampaignRecipient[];
        uploadEvidence: {
          originalFilename: string;
          selectedAt: string;
        };
      }) => void;
    };

    fireEvent.click(screen.getByRole("combobox"));
    fireEvent.click(await screen.findByRole("option", { name: "@airi_b_bot" }));
    await waitFor(() =>
      expect(mockRecipientPicker).toHaveBeenLastCalledWith(
        expect.objectContaining({ sourceIds: ["telegram-source-b"] })
      )
    );

    fireEvent.click(screen.getByRole("combobox"));
    fireEvent.click(await screen.findByRole("option", { name: "@airi_a_bot" }));
    await waitFor(() =>
      expect(mockRecipientPicker).toHaveBeenLastCalledWith(
        expect.objectContaining({
          sourceIds: ["telegram-source-a"],
          recipients: [],
        })
      )
    );

    act(() => {
      oldPickerProps.onUploadedAudienceChange?.({
        recipients: [{ chatId: "stale-chat", name: "Stale A row" }],
        uploadEvidence: {
          originalFilename: "stale-a.csv",
          selectedAt: "2026-08-08T08:00:00.000Z",
        },
      });
    });

    await waitFor(() =>
      expect(mockRecipientPicker).toHaveBeenLastCalledWith(
        expect.objectContaining({
          sourceIds: ["telegram-source-a"],
          recipients: [],
          audienceUploadEvidence: null,
        })
      )
    );
  });

  it("scopes WhatsApp recipient picking to the selected number", async () => {
    render(
      <MultiChannelCampaignBuilder
        workspaceId="00000000-0000-4000-8000-000000000801"
        emailEnabled={false}
        lockedChannel="whatsapp"
      />
    );

    expect(await screen.findByLabelText("whatsappNumber")).toBeTruthy();
    await waitFor(() =>
      expect(mockRecipientPicker).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: "whatsapp",
          sourceIds: ["source-1"],
        })
      )
    );
    expect(screen.queryByRole("option", { name: "instagram" })).toBeNull();
  });

  it("defaults the shared prior-failure control off", () => {
    render(
      <MultiChannelCampaignBuilder
        workspaceId="00000000-0000-4000-8000-000000000701"
        emailEnabled={false}
        lockedChannel="whatsapp"
      />
    );

    expect(
      screen.getByTestId("prior-failed-recipient-exclusion-control")
    ).toBeTruthy();
    expect(getPriorFailureSwitch().getAttribute("aria-checked")).toBe("false");
  });

  it("hides and clears effective policy on Telegram and email", async () => {
    render(
      <MultiChannelCampaignBuilder
        workspaceId="workspace-channel-policy"
        emailEnabled
      />
    );

    fireEvent.click(getPriorFailureSwitch());
    expect(getPriorFailureSwitch().getAttribute("aria-checked")).toBe("true");

    fireEvent.click(screen.getByRole("combobox", { name: "channel" }));
    fireEvent.click(
      await screen.findByRole("option", { name: "telegramMessages" })
    );
    expect(
      screen.queryByTestId("prior-failed-recipient-exclusion-control")
    ).toBeNull();

    fireEvent.click(screen.getByRole("combobox", { name: "channel" }));
    fireEvent.click(
      await screen.findByRole("option", { name: "emailCampaigns" })
    );
    expect(
      screen.queryByTestId("prior-failed-recipient-exclusion-control")
    ).toBeNull();

    fireEvent.click(screen.getByRole("combobox", { name: "channel" }));
    fireEvent.click(
      await screen.findByRole("option", { name: "whatsappTemplates" })
    );
    expect(getPriorFailureSwitch().getAttribute("aria-checked")).toBe("false");
  });

  it("passes canonical audience, policy, and ad_hoc provenance on send", async () => {
    const fetchMock = mockCampaignFetch([
      ["/api/whatsapp/templates", () => templatesResponse("utility_update")],
      [
        "/api/campaigns/recipient-eligibility",
        () =>
          jsonResponse(
            {
              state: "ready",
              evaluatedAt: "2026-08-24T12:00:00.000Z",
              requestedTotal: 1,
              acceptedTotal: 1,
              uniqueRecipients: { requested: 1, accepted: 1 },
              skippedByReason: {},
              warnings: { missingMarketingConsent: 0 },
              allExcluded: false,
              readiness: mockReadyReadiness,
              eligibleTotal: 1,
              skippedPriorFailed: 0,
            },
            200
          ),
      ],
      [
        "/api/campaigns/bulk-send",
        () =>
          jsonResponse(
            {
              ok: true,
              outcome: {
                disposition: "queued",
                evaluatedAt: "2026-08-24T12:00:00.000Z",
                lifecycleStatus: "queued",
                requestedTotal: 1,
                acceptedTotal: 1,
                queuedTotal: 1,
                uniqueRecipients: { requested: 1, accepted: 1, queued: 1 },
                skippedByReason: { prior_failure: 0 },
                warnings: { missingMarketingConsent: 0 },
                campaignId: "campaign-canonical",
                dispatchId: "dispatch-canonical",
              },
              queued: true,
              total: 1,
              status: "queued",
              campaignId: "campaign-canonical",
              dispatchId: "dispatch-canonical",
            },
            200
          ),
      ],
    ]);

    render(
      <MultiChannelCampaignBuilder
        workspaceId="00000000-0000-4000-8000-000000000702"
        emailEnabled={false}
        lockedChannel="whatsapp"
      />
    );

    fireEvent.change(screen.getByLabelText("campaignName"), {
      target: { value: "Canonical send" },
    });
    fireEvent.click(await screen.findByRole("combobox", { name: "template" }));
    fireEvent.click(
      await screen.findByRole("option", { name: /utility_update/ })
    );
    fireEvent.click(screen.getByText("add-recipient"));
    fireEvent.click(getPriorFailureSwitch());
    await waitFor(() =>
      expect(
        (
          screen.getByRole("button", {
            name: "sendToRecipients:1",
          }) as HTMLButtonElement
        ).disabled
      ).toBe(false)
    );
    fireEvent.click(screen.getByRole("button", { name: "sendToRecipients:1" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/campaigns/bulk-send",
        expect.any(Object)
      )
    );
    expect(
      parseJsonRequestBody(
        fetchMock.mock.calls.find(([url]) =>
          String(url).includes("/api/campaigns/bulk-send")
        )
      )
    ).toEqual(
      expect.objectContaining({
        audience: {
          kind: "inline",
          recipients: [expect.objectContaining({ phone: "77001234567" })],
        },
        recipientPolicy: {
          version: 1,
          excludePriorFailedBulkSends: true,
        },
        provenance: { kind: "ad_hoc" },
      })
    );
    await waitFor(() =>
      expect(getPriorFailureSwitch().getAttribute("aria-checked")).toBe("false")
    );
    expect(screen.queryByTestId("bulk-campaign-outcome-summary")).toBeNull();
  });

  it("resets policy after queued completion but not after a blocked send", async () => {
    const fetchMock = mockCampaignFetch([
      ["/api/whatsapp/templates", () => templatesResponse("utility_update")],
      [
        "/api/campaigns/recipient-eligibility",
        () =>
          jsonResponse(
            {
              state: "ready",
              evaluatedAt: "2026-08-24T12:00:00.000Z",
              requestedTotal: 1,
              acceptedTotal: 1,
              uniqueRecipients: { requested: 1, accepted: 1 },
              skippedByReason: {},
              warnings: { missingMarketingConsent: 0 },
              allExcluded: false,
              readiness: mockReadyReadiness,
              eligibleTotal: 1,
            },
            200
          ),
      ],
      [
        "/api/campaigns/bulk-send",
        () =>
          ({
            ok: false,
            status: 400,
            json: async () => ({
              ok: false,
              disposition: "blocked",
              code: "bulk_campaign_request_failed",
              message: "Blocked",
            }),
          }) as Response,
      ],
    ]);

    render(
      <MultiChannelCampaignBuilder
        workspaceId="00000000-0000-4000-8000-000000000703"
        emailEnabled={false}
        lockedChannel="whatsapp"
      />
    );

    fireEvent.change(screen.getByLabelText("campaignName"), {
      target: { value: "Blocked send" },
    });
    fireEvent.click(await screen.findByRole("combobox", { name: "template" }));
    fireEvent.click(
      await screen.findByRole("option", { name: /utility_update/ })
    );
    fireEvent.click(screen.getByText("add-recipient"));
    fireEvent.click(getPriorFailureSwitch());
    await waitFor(() =>
      expect(
        (
          screen.getByRole("button", {
            name: "sendToRecipients:1",
          }) as HTMLButtonElement
        ).disabled
      ).toBe(false)
    );
    fireEvent.click(screen.getByRole("button", { name: "sendToRecipients:1" }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/campaigns/bulk-send",
        expect.any(Object)
      )
    );
    expect(getPriorFailureSwitch().getAttribute("aria-checked")).toBe("true");
  });

  it("sends Analytics fill-up as one discriminated audience with ad_hoc provenance", async () => {
    const fetchMock = mockCampaignFetch(
      [
        ["/api/whatsapp/templates", () => templatesResponse("analytics_offer")],
        [
          "/analytics/bulk/audience-preview",
          () =>
            jsonResponse({
              available: true,
              total: 1,
              readiness: mockReadyReadiness,
              eligibleTotal: 1,
              excludedOptIn: 0,
              capped: false,
              maxRecipients: 1000,
            }),
        ],
        [
          "/api/campaigns/bulk-send",
          () =>
            jsonResponse(
              {
                queued: true,
                total: 2,
                campaignId: "analytics-campaign",
                dispatchId: "analytics-campaign",
                status: "queued",
              },
              200
            ),
        ],
      ],
      () => jsonResponse({})
    );
    const initialDraft = {
      id: "airi-bulk:analytics-canonical",
      workspaceId: "00000000-0000-4000-8000-000000000704",
      title: "Analytics audience",
      channel: "whatsapp" as const,
      campaignName: "Analytics fill-up canonical",
      goal: "Reach selected cohort.",
      angle: "Direct",
      recipientSourceSummary: "Analytics cohort",
      templateSelection: {
        name: "analytics_offer",
        language: "en",
        category: "UTILITY" as const,
      },
      templateReadiness: "select_approved_template" as const,
    };
    const { rerender } = render(
      <MultiChannelCampaignBuilder
        workspaceId="00000000-0000-4000-8000-000000000704"
        emailEnabled={false}
        lockedChannel="whatsapp"
        initialDraft={initialDraft}
      />
    );

    await waitFor(() =>
      expect(mockRecipientPicker).toHaveBeenCalledWith(
        expect.objectContaining({ recipientLimit: 50_000 })
      )
    );
    fireEvent.click(screen.getByText("upload-audience"));

    rerender(
      <MultiChannelCampaignBuilder
        workspaceId="00000000-0000-4000-8000-000000000704"
        emailEnabled={false}
        lockedChannel="whatsapp"
        initialDraft={initialDraft}
        recipientSource={{
          type: "bulk_analytics",
          filters: { days: 30 },
          previewCount: 1,
        }}
      />
    );

    await waitFor(() =>
      expect(mockRecipientPicker).toHaveBeenCalledWith(
        expect.objectContaining({ recipientLimit: 49_999 })
      )
    );
    fireEvent.click(screen.getByRole("combobox", { name: "template" }));
    fireEvent.click(
      await screen.findByRole("option", { name: /analytics_offer/ })
    );
    fireEvent.click(screen.getByText("upload-audience"));
    const sendButton = screen.getByRole("button", {
      name: /sendToRecipients/,
    }) as HTMLButtonElement;
    await waitFor(() => expect(sendButton.disabled).toBe(false));
    fireEvent.click(sendButton);

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/campaigns/bulk-send",
        expect.any(Object)
      )
    );
    const body = parseJsonRequestBody(
      fetchMock.mock.calls.find(([url]) =>
        String(url).includes("/api/campaigns/bulk-send")
      )
    );
    expect(body.audience?.kind).toBe("analytics_with_fill_up");
    expect(body.audience?.analytics?.filters).toEqual(
      expect.objectContaining({ days: 30 })
    );
    expect(body.audience?.fillUpRecipients).toEqual([
      expect.objectContaining({ phone: "77001234567" }),
    ]);
    expect(body.recipientPolicy).toEqual({
      version: 1,
      excludePriorFailedBulkSends: false,
    });
    expect(body.provenance).toEqual({ kind: "ad_hoc" });
    expect(body).not.toHaveProperty("analyticsAudience");
    expect(body).not.toHaveProperty("registeredUsersAudience");
    expect(body).not.toHaveProperty("registeredBusinessPhonesAudience");
    expect(body).not.toHaveProperty("telegramSubscribersAudience");
    expect(body).not.toHaveProperty("audienceUploadEvidence");
    expect(body).not.toHaveProperty("recipients");
  });

  it("asks to queue leftover recipients when the attached list exceeds the daily cap", async () => {
    mockRecipientLimitMax = 1;
    const fetchMock = mockCampaignFetch(
      [
        [
          "/api/campaigns/bulk-send",
          () =>
            jsonResponse(
              {
                queued: true,
                total: 2,
                campaignId: "overflow-campaign",
                dispatchId: "overflow-campaign",
                status: "queued",
              },
              200
            ),
        ],
      ],
      () => jsonResponse({ templates: [] })
    );

    render(
      <MultiChannelCampaignBuilder
        workspaceId="00000000-0000-4000-8000-000000000804"
        emailEnabled
        lockedChannel="email"
      />
    );

    fireEvent.change(screen.getByLabelText("campaignName"), {
      target: { value: "Overflow queue campaign" },
    });
    fireEvent.click(screen.getByText("upload-overflow-audience"));
    mockAutoConfirmSendSummary = false;
    fireEvent.click(screen.getByRole("button", { name: /sendToRecipients/ }));

    // The summary says the list runs over the daily limit; nothing is sent yet.
    expect(await screen.findByTestId("send-summary")).toBeTruthy();
    expect(mockSendSummaryDialog).toHaveBeenLastCalledWith(
      expect.objectContaining({
        summary: expect.objectContaining({
          recipientCount: 2,
          overflowPlan: expect.objectContaining({
            exceedsDailyLimit: true,
            dailyLimit: 1,
          }),
        }),
      })
    );
    expect(screen.queryByText("overflowQueue.title")).toBeNull();
    expect(
      fetchMock.mock.calls.some(([url]) =>
        String(url).includes("/api/campaigns/bulk-send")
      )
    ).toBe(false);

    fireEvent.click(screen.getByText("confirm-send-summary"));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/campaigns/bulk-send",
        expect.any(Object)
      )
    );
    const body = parseJsonRequestBody(
      fetchMock.mock.calls.find(([url]) =>
        String(url).includes("/api/campaigns/bulk-send")
      )
    );
    expect(body.overflowQueueConfirmed).toBe(true);
    expect(body.audience?.recipients).toHaveLength(2);
  });

  describe("summary before Send", () => {
    it("shows who gets the message and who is left out, and sends only after confirming", async () => {
      const fetchMock = mockCampaignFetch([
        ["/api/whatsapp/templates", () => templatesResponse("spring_summary")],
        [
          "/api/campaigns/recipient-eligibility",
          () =>
            jsonResponse(
              {
                state: "ready",
                evaluatedAt: "2026-10-05T12:00:00.000Z",
                requestedTotal: 3,
                acceptedTotal: 1,
                uniqueRecipients: { requested: 3, accepted: 1 },
                skippedByReason: { marketing_opt_out: 1, prior_failure: 1 },
                warnings: { missingMarketingConsent: 0 },
                allExcluded: false,
                readiness: mockReadyReadiness,
              },
              200
            ),
        ],
        [
          "/api/campaigns/bulk-send",
          () =>
            jsonResponse(
              {
                queued: true,
                total: 1,
                campaignId: "summary-campaign",
                dispatchId: "summary-campaign",
                status: "queued",
              },
              200
            ),
        ],
      ]);
      mockAutoConfirmSendSummary = false;
      render(
        <MultiChannelCampaignBuilder
          workspaceId="00000000-0000-4000-8000-000000000392"
          emailEnabled={false}
          lockedChannel="whatsapp"
        />
      );
      fireEvent.change(screen.getByLabelText("campaignName"), {
        target: { value: "Summary send" },
      });
      fireEvent.click(
        await screen.findByRole("combobox", { name: "template" })
      );
      fireEvent.click(
        await screen.findByRole("option", { name: /spring_summary/ })
      );
      fireEvent.click(screen.getByText("add-recipient"));
      const send = await screen.findByRole("button", {
        name: "sendToRecipients:1",
      });
      await waitFor(() =>
        expect((send as HTMLButtonElement).disabled).toBe(false)
      );
      fireEvent.click(send);

      expect(await screen.findByTestId("send-summary")).toBeTruthy();
      expect(mockSendSummaryDialog).toHaveBeenLastCalledWith(
        expect.objectContaining({
          summary: {
            message: "spring_summary",
            sender: expect.any(String),
            recipientCount: 1,
            skippedByReason: { marketing_opt_out: 1, prior_failure: 1 },
            overflowPlan: expect.objectContaining({ exceedsDailyLimit: false }),
          },
        })
      );
      expect(
        fetchMock.mock.calls.some(([url]) =>
          String(url).includes("/api/campaigns/bulk-send")
        )
      ).toBe(false);

      fireEvent.click(screen.getByText("confirm-send-summary"));
      await waitFor(() =>
        expect(
          fetchMock.mock.calls.filter(([url]) =>
            String(url).includes("/api/campaigns/bulk-send")
          )
        ).toHaveLength(1)
      );
      await waitFor(() =>
        expect(screen.queryByTestId("send-summary")).toBeNull()
      );
    });

    it("asks again for the next send after one is confirmed", async () => {
      mockCampaignFetch([
        [
          "/api/campaigns/bulk-send",
          () =>
            ({
              ok: false,
              status: 503,
              json: async () => ({
                ok: false,
                disposition: "failed",
                code: "bulk_campaign_request_failed",
                message: "Temporary failure",
              }),
            }) as Response,
        ],
      ]);
      mockAutoConfirmSendSummary = false;
      render(
        <MultiChannelCampaignBuilder
          workspaceId="00000000-0000-4000-8000-000000000393"
          emailEnabled
          lockedChannel="email"
        />
      );
      fireEvent.change(screen.getByLabelText("campaignName"), {
        target: { value: "Email summary" },
      });
      fireEvent.click(screen.getByText("upload-audience"));
      fireEvent.click(screen.getByRole("button", { name: /sendToRecipients/ }));
      fireEvent.click(await screen.findByText("confirm-send-summary"));
      expect(
        await screen.findByTestId("bulk-campaign-send-error")
      ).toBeTruthy();

      mockSendSummaryDialog.mockClear();
      fireEvent.click(screen.getByRole("button", { name: /sendToRecipients/ }));
      expect(await screen.findByTestId("send-summary")).toBeTruthy();
      expect(mockSendSummaryDialog).toHaveBeenLastCalledWith(
        expect.objectContaining({
          summary: expect.objectContaining({ recipientCount: 1 }),
        })
      );
    });
  });

  describe("test to self", () => {
    it("offers a test of the chosen template with the first recipient's values", async () => {
      mockCampaignFetch([
        [
          "/api/whatsapp/templates",
          () =>
            jsonResponse({
              templates: [
                {
                  name: "order_ready",
                  language: "ru",
                  category: "UTILITY",
                  components: [{ type: "BODY", text: "Hi {{1}}" }],
                },
              ],
            }),
        ],
      ]);
      render(
        <MultiChannelCampaignBuilder
          workspaceId="workspace-p21-test-send"
          emailEnabled={false}
          lockedChannel="whatsapp"
        />
      );
      expect(screen.queryByTestId("test-send-dialog")).toBeNull();

      fireEvent.click(
        await screen.findByRole("combobox", { name: "template" })
      );
      fireEvent.click(
        await screen.findByRole("option", { name: /order_ready/ })
      );

      expect(await screen.findByTestId("test-send-dialog")).toBeTruthy();
      expect(mockTestSendDialog).toHaveBeenLastCalledWith(
        expect.objectContaining({
          workspaceId: "workspace-p21-test-send",
          sourceId: "source-1",
          template: expect.objectContaining({
            name: "order_ready",
            language: "ru",
          }),
          valuesFrom: "sample",
          recipientName: undefined,
        })
      );

      fireEvent.click(screen.getByText("add-recipient"));
      await waitFor(() =>
        expect(mockTestSendDialog).toHaveBeenLastCalledWith(
          expect.objectContaining({
            valuesFrom: "recipient",
            recipientName: "Dana",
            variables: { "1": "Dana" },
          })
        )
      );
    });
  });

  describe("first-send blocked states", () => {
    it("replaces the separate no-number messages with one Connect WhatsApp panel", async () => {
      mockBatchPlanConfigured = false;
      mockBatchPlanCode = "whatsapp_not_connected";
      mockBatchPlanMessage =
        "WhatsApp credentials are incomplete for this workspace.";
      mockCampaignFetch([
        [
          "/api/whatsapp/templates",
          () =>
            ({
              ok: false,
              status: 409,
              json: async () => ({ requiresWhatsAppConnection: true }),
            }) as Response,
        ],
      ]);
      render(
        <MultiChannelCampaignBuilder
          workspaceId="workspace-p1b-not-connected"
          emailEnabled={false}
          lockedChannel="whatsapp"
        />
      );

      const panel = await screen.findByTestId("bulk-campaign-connect-whatsapp");
      expect(
        within(panel)
          .getByRole("link", { name: "connectWhatsApp.action" })
          .getAttribute("href")
      ).toBe(
        "/panel/w/workspace-p1b-not-connected/settings/integrations?integration=whatsapp"
      );
      expect(await screen.findByText("templatesAfterConnect")).toBeTruthy();
      expect(screen.queryByText("createTemplate")).toBeNull();
      expect(
        screen.queryByText(
          "WhatsApp credentials are incomplete for this workspace."
        )
      ).toBeNull();
      expect(mockRecipientPicker).toHaveBeenLastCalledWith(
        expect.objectContaining({
          recipientLimitState: expect.objectContaining({ error: null }),
        })
      );
    });

    it("keeps the panel away from a number that is only missing credentials", async () => {
      mockBatchPlanConfigured = false;
      mockBatchPlanCode = "whatsapp_credentials_incomplete";
      render(
        <MultiChannelCampaignBuilder
          workspaceId="workspace-p1b-credentials"
          emailEnabled={false}
          lockedChannel="whatsapp"
        />
      );
      expect(
        await screen.findByTestId("bulk-campaign-no-templates")
      ).toBeTruthy();
      expect(screen.queryByTestId("bulk-campaign-connect-whatsapp")).toBeNull();
      expect(mockDispatchPlanCard).toHaveBeenLastCalledWith(
        expect.objectContaining({
          workspaceId: "workspace-p1b-credentials",
          readinessErrorCode: "plan_unavailable",
        })
      );
    });

    it("offers to create a template and lists ones waiting for Meta review", async () => {
      const fetchMock = mockCampaignFetch([
        [
          "status=PENDING",
          () =>
            jsonResponse({
              templates: [
                {
                  name: "spring_offer",
                  language: "ru",
                  category: "MARKETING",
                  status: "PENDING",
                  components: [{ type: "BODY", text: "Hi" }],
                },
              ],
            }),
        ],
        ["/api/whatsapp/templates", () => jsonResponse({ templates: [] })],
      ]);
      render(
        <MultiChannelCampaignBuilder
          workspaceId="workspace-p1b-pending"
          emailEnabled={false}
          lockedChannel="whatsapp"
        />
      );

      const empty = await screen.findByTestId("bulk-campaign-no-templates");
      expect(within(empty).getByText("noTemplates")).toBeTruthy();
      expect(await within(empty).findByText("spring_offer (ru)")).toBeTruthy();
      expect(within(empty).getByText("pendingTemplates.title")).toBeTruthy();
      expect(
        within(empty)
          .getByRole("link", { name: "createTemplate" })
          .getAttribute("href")
      ).toBe(
        "/panel/w/workspace-p1b-pending/messengers/whatsapp-templates?create=1"
      );

      fetchMock.mockClear();
      fireEvent.click(
        within(empty).getByRole("button", { name: "refreshTemplates" })
      );
      await waitFor(() =>
        expect(
          fetchMock.mock.calls.some(
            ([url]) =>
              String(url).includes("status=APPROVED") &&
              String(url).includes("_refresh=")
          )
        ).toBe(true)
      );
      // Only the approved read goes to Meta; the rest reread the catalog.
      await waitFor(() =>
        expect(
          fetchMock.mock.calls.some(
            ([url]) =>
              String(url).includes("status=PENDING") &&
              !String(url).includes("_refresh=")
          )
        ).toBe(true)
      );
      expect(
        fetchMock.mock.calls.filter(([url]) =>
          String(url).includes("_refresh=")
        )
      ).toHaveLength(1);
    });

    it("says when Check again can't reach Meta", async () => {
      const toastError = jest
        .spyOn(toast, "error")
        .mockImplementation(() => "");
      let failRefresh = false;
      mockCampaignFetch([
        [
          "_refresh=",
          () =>
            failRefresh
              ? ({
                  ok: false,
                  status: 503,
                  json: async () => ({ error: "Meta unavailable" }),
                } as Response)
              : jsonResponse({ templates: [] }),
        ],
        ["/api/whatsapp/templates", () => jsonResponse({ templates: [] })],
      ]);
      render(
        <MultiChannelCampaignBuilder
          workspaceId="workspace-p1b-recheck-failed"
          emailEnabled={false}
          lockedChannel="whatsapp"
        />
      );
      const empty = await screen.findByTestId("bulk-campaign-no-templates");
      failRefresh = true;
      fireEvent.click(
        within(empty).getByRole("button", { name: "refreshTemplates" })
      );
      await waitFor(() =>
        expect(toastError).toHaveBeenCalledWith("templatesUnavailable")
      );
      toastError.mockRestore();
    });

    it("keeps a template in Meta review out of the approved choices", async () => {
      mockCampaignFetch([
        [
          "status=PENDING",
          () =>
            jsonResponse({
              templates: [
                {
                  name: "spring_offer",
                  language: "ru",
                  category: "MARKETING",
                  status: "PENDING",
                },
                {
                  name: "utility_update",
                  language: "en",
                  category: "UTILITY",
                  status: "PENDING",
                },
              ],
            }),
        ],
        ["/api/whatsapp/templates", () => templatesResponse("utility_update")],
      ]);
      render(
        <MultiChannelCampaignBuilder
          workspaceId="workspace-p1b-pending-options"
          emailEnabled={false}
          lockedChannel="whatsapp"
        />
      );

      expect(await screen.findByText("pendingTemplates.hint")).toBeTruthy();
      fireEvent.click(
        await screen.findByRole("combobox", { name: "template" })
      );
      const pending = await screen.findByRole("option", {
        name: /spring_offer/,
      });
      expect(pending.getAttribute("aria-disabled")).toBe("true");
      // An approved template is never listed again as pending.
      expect(
        screen.getAllByRole("option", { name: /utility_update/ })
      ).toHaveLength(1);
      expect(
        screen
          .getByRole("option", { name: /utility_update/ })
          .getAttribute("aria-disabled")
      ).not.toBe("true");
    });

    it.each([
      { bulkRecipientExhausted: true },
      { conversationExhausted: true },
      { trialExpired: true },
    ])("unifies plan status and disabled Send for %o", async limitFlags => {
      mockCompanyLimits = {
        ...mockOpenCompanyLimits,
        bulkRecipientCount: 500,
        bulkRecipientsRemaining: 0,
        ...limitFlags,
      };
      mockCampaignFetch([
        ["/api/whatsapp/templates", () => templatesResponse("utility_limit")],
        [
          "/api/campaigns/recipient-eligibility",
          () =>
            jsonResponse(
              {
                state: "ready",
                evaluatedAt: "2026-10-05T12:00:00.000Z",
                requestedTotal: 1,
                acceptedTotal: 1,
                uniqueRecipients: { requested: 1, accepted: 1 },
                skippedByReason: {},
                warnings: { missingMarketingConsent: 0 },
                allExcluded: false,
                readiness: mockReadyReadiness,
              },
              200
            ),
        ],
      ]);
      render(
        <MultiChannelCampaignBuilder
          workspaceId="workspace-p1b-plan-limit"
          emailEnabled={false}
          lockedChannel="whatsapp"
        />
      );
      fireEvent.click(
        await screen.findByRole("combobox", { name: "template" })
      );
      fireEvent.click(
        await screen.findByRole("option", { name: /utility_limit/ })
      );
      fireEvent.click(screen.getByText("add-recipient"));

      const send = await screen.findByRole("button", {
        name: "sendUnavailable",
      });
      expect((send as HTMLButtonElement).disabled).toBe(true);
      const reason = document.getElementById(
        send.getAttribute("aria-describedby") || ""
      );
      expect(reason?.getAttribute("role")).toBe("status");
      expect(reason?.textContent).toBe("plan_blocked");
      expect(screen.getAllByTestId("shared-send-status")).toHaveLength(1);
      const firstStep = screen.getAllByTestId("campaign-flow-step")[0];
      expect(
        reason!.compareDocumentPosition(firstStep) & Node.DOCUMENT_POSITION_FOLLOWING
      ).toBeTruthy();
      expect(send.getAttribute("data-variant")).toBe("secondary");
      expect(screen.queryByText("bulkLimit.freeExhausted")).toBeNull();
      fireEvent.submit(send.closest("form")!);
      await waitFor(() => expect(mockDispatchPlanCard).toHaveBeenCalledWith(expect.objectContaining({
        sendStatus: expect.objectContaining({ state: "plan_blocked", blocked: true }),
      })));
      expect((global.fetch as jest.Mock).mock.calls.some(([url]) => String(url).includes("/api/campaigns/bulk-send"))).toBe(false);
      expect(
        screen.queryByTestId("bulk-campaign-send-blocked-reason")
      ).toBeNull();
    });

    it("explains a plan-limit refusal next to Send with an upgrade action", async () => {
      mockCampaignFetch([
        ["/api/whatsapp/templates", () => templatesResponse("utility_refused")],
        [
          "/api/campaigns/recipient-eligibility",
          () =>
            jsonResponse(
              {
                state: "ready",
                evaluatedAt: "2026-10-05T12:00:00.000Z",
                requestedTotal: 1,
                acceptedTotal: 1,
                uniqueRecipients: { requested: 1, accepted: 1 },
                skippedByReason: {},
                warnings: { missingMarketingConsent: 0 },
                allExcluded: false,
                readiness: mockReadyReadiness,
              },
              200
            ),
        ],
        [
          "/api/campaigns/bulk-send",
          () =>
            ({
              ok: false,
              status: 402,
              json: async () => ({
                ok: false,
                disposition: "blocked",
                code: "company_bulk_campaign_limit_exceeded",
                message:
                  "Company bulk campaign limit exceeded. Free plans include 2 bulk campaigns.",
              }),
            }) as Response,
        ],
      ]);
      render(
        <MultiChannelCampaignBuilder
          workspaceId="00000000-0000-4000-8000-000000000390"
          emailEnabled={false}
          lockedChannel="whatsapp"
        />
      );
      fireEvent.change(screen.getByLabelText("campaignName"), {
        target: { value: "Refused send" },
      });
      fireEvent.click(
        await screen.findByRole("combobox", { name: "template" })
      );
      fireEvent.click(
        await screen.findByRole("option", { name: /utility_refused/ })
      );
      fireEvent.click(screen.getByText("add-recipient"));
      const send = screen.getByRole("button", { name: "sendToRecipients:1" });
      await waitFor(() =>
        expect((send as HTMLButtonElement).disabled).toBe(false)
      );
      fireEvent.click(send);

      const error = await screen.findByTestId("bulk-campaign-send-error");
      expect(
        within(screen.getByTestId("bulk-campaign-send-panel")).getByTestId(
          "bulk-campaign-send-error"
        )
      ).toBe(error);
      expect(within(error).getByText("bulkLimit.blocked")).toBeTruthy();
      expect(
        within(error).getByRole("button", { name: "bulkLimit.upgrade" })
      ).toBeTruthy();
      expect(screen.queryByText(/Company bulk campaign limit/)).toBeNull();
      expect(mockRefreshCompanyLimits).toHaveBeenCalled();
      expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalled();
    });

    it("shows form validation in the page's language", async () => {
      mockCampaignFetch([
        ["/api/whatsapp/templates", () => templatesResponse("utility_form")],
      ]);
      const { container } = render(
        <MultiChannelCampaignBuilder
          workspaceId="workspace-p1b-validation"
          emailEnabled={false}
          lockedChannel="whatsapp"
        />
      );
      await screen.findByRole("combobox", { name: "template" });
      fireEvent.submit(container.querySelector("form") as HTMLFormElement);

      expect(
        await screen.findByText("validationMessages.campaignNameRequired")
      ).toBeTruthy();
      expect(
        screen.getByText("validationMessages.templateRequired")
      ).toBeTruthy();
      expect(screen.queryByText("Campaign name is required")).toBeNull();
    });
  });
});
