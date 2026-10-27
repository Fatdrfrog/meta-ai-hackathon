/**
 * @jest-environment jsdom
 */

import type { CampaignOperationStatusResponse } from "@/lib/campaign/campaign-operations-contracts";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ReactElement } from "react";
import { SWRConfig } from "swr";
import { CampaignHistory } from "./campaign-history";
import type { RealtimeEventEnvelope } from "@icecore/shared/types/realtime";

const mockRealtimeHandlers = new Map<
  string,
  (event: RealtimeEventEnvelope) => void
>();
const mockRealtimeChannel = {
  bind: jest.fn(
    (name: string, handler: (event: RealtimeEventEnvelope) => void) =>
      mockRealtimeHandlers.set(name, handler)
  ),
  unbind: jest.fn((name: string) => mockRealtimeHandlers.delete(name)),
};
let mockRealtimeConnected = false;
jest.mock("@/hooks/use-realtime", () => ({
  useRealtime: () => ({
    channel: mockRealtimeChannel,
    isConnected: mockRealtimeConnected,
  }),
}));

const mockSpendSummary = jest.fn();
jest.mock("@/components/analytics/whatsapp-spend-summary", () => ({
  WhatsAppSpendSummary: (props: unknown) => {
    mockSpendSummary(props);
    return <div data-testid="whatsapp-spend-summary" />;
  },
}));

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    key === "operations.retry.cooldown" ||
    key === "operations.retry.successSkippedRecent" ||
    key === "costStatus.unpricedMessages"
      ? `${key} ${JSON.stringify(values)}`
      : key,
  useFormatter: () => ({ dateTime: (date: Date) => date.toISOString() }),
}));

function renderWithSWR(ui: ReactElement) {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      {ui}
    </SWRConfig>
  );
}

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const CAMPAIGN_ID = "22222222-2222-4222-8222-222222222222";

type OperationOverrides = Partial<
  Omit<
    CampaignOperationStatusResponse,
    "progress" | "delivery" | "providerCircuit" | "retry"
  >
> & {
  progress?: Partial<CampaignOperationStatusResponse["progress"]>;
  delivery?: Partial<CampaignOperationStatusResponse["delivery"]>;
  providerCircuit?: Partial<CampaignOperationStatusResponse["providerCircuit"]>;
  retry?: Partial<CampaignOperationStatusResponse["retry"]>;
};

function buildOperation(
  overrides: OperationOverrides = {}
): CampaignOperationStatusResponse {
  const { progress, delivery, providerCircuit, retry, ...operationOverrides } =
    overrides;
  return {
    campaignId: CAMPAIGN_ID,
    status: "running",
    requestedAt: "2026-07-24T08:00:00.000Z",
    scheduledAt: null,
    dispatchExpiresAt: "2026-07-25T08:00:00.000Z",
    startedAt: "2026-07-24T08:00:01.000Z",
    progressAt: "2026-07-24T08:00:02.000Z",
    finishedAt: null,
    cancelledAt: null,
    expiredAt: null,
    totalRecipients: 10,
    canCancel: true,
    paused: false,
    ...operationOverrides,
    progress: {
      processed: 4,
      accepted: 3,
      attempted: 4,
      notAttempted: 6,
      successful: 3,
      failed: 1,
      ...progress,
    },
    delivery: {
      pending: 1,
      accepted: 3,
      delivered: 2,
      read: 1,
      failed: 1,
      ...delivery,
    },
    stopReason: null,
    providerCircuit: {
      state: "closed",
      provider: null,
      code: null,
      openedAt: null,
      failureCount: 0,
      requiresAcknowledgement: false,
      ...providerCircuit,
    },
    retry: {
      ofCampaignId: null,
      kind: null,
      failedRecipientCount: 0,
      available: false,
      ...retry,
    },
  };
}

function buildCampaign(overrides: Record<string, unknown> = {}) {
  return {
    id: CAMPAIGN_ID,
    name: "Summer campaign",
    channel: "whatsapp",
    template_name: "summer",
    template_language: "en",
    total_recipients: 999,
    successful_sends: 998,
    failed_sends: 1,
    sent_at: "2026-07-24T08:00:00.000Z",
    estimated_cost: null,
    delivery_rate: 99.9,
    read_rate: 99.8,
    reply_rate: null,
    replied_count: null,
    cost_per_reply: null,
    users: null,
    messages: [],
    failure_summary: null,
    operation: buildOperation(),
    ...overrides,
  };
}

function buildHistoryResponse(
  campaigns: Array<ReturnType<typeof buildCampaign>>
) {
  return {
    campaigns,
    hasEmailCampaigns: false,
    pagination: {
      page: 1,
      limit: 20,
      total: campaigns.length,
      pages: campaigns.length > 0 ? 1 : 0,
    },
  };
}

function jsonResponse(
  payload: unknown,
  options: { ok?: boolean; status?: number } = {}
) {
  return {
    ok: options.ok ?? true,
    status: options.status ?? (options.ok === false ? 500 : 200),
    json: async () => payload,
  } as Response;
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(resolver => {
    resolve = resolver;
  });
  return { promise, resolve };
}

function installFetchMock(
  implementation: (...args: Parameters<typeof fetch>) => Promise<Response>
) {
  const fetchMock = jest.fn(implementation);
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("CampaignHistory", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.useRealTimers();
  });

  it("shows provider rejection reasons for failed bulk campaigns", async () => {
    global.fetch = jest.fn(
      async () =>
        ({
          ok: true,
          json: async () => ({
            campaigns: [
              {
                id: "campaign-1",
                name: "EduDemo test",
                channel: "whatsapp",
                template_name: "test1",
                template_language: "kk",
                total_recipients: 6,
                successful_sends: 0,
                failed_sends: 6,
                sent_at: "2026-06-08T09:36:49.234683+00:00",
                estimated_cost: null,
                reply_rate: 25.5,
                replied_count: 0,
                cost_per_reply: null,
                failure_summary: {
                  failedCount: 6,
                  topReason: "Business eligibility payment issue",
                  topErrorCode: 131042,
                  reasons: [
                    {
                      reason: "Business eligibility payment issue",
                      count: 6,
                      errorCode: 131042,
                    },
                  ],
                },
                messages: [
                  {
                    id: "message-1",
                    recipient: "77077778624",
                    provider: "meta",
                    status: "failed",
                    error_code: 131042,
                    error_message: "Business eligibility payment issue",
                    updated_at: "2026-06-08T09:36:50.234683+00:00",
                  },
                ],
              },
            ],
            pagination: { page: 1, limit: 20, total: 1, pages: 1 },
          }),
        }) as Response
    ) as jest.Mock;

    renderWithSWR(<CampaignHistory workspaceId="workspace-1" />);

    expect(
      await screen.findAllByText("Business eligibility payment issue")
    ).toHaveLength(1);
    expect(screen.getByText("failureSummary.allFailed")).toBeTruthy();
    expect(screen.getAllByText("131042").length).toBeGreaterThan(0);
    expect(
      screen.getAllByRole("columnheader").map(header => header.textContent)
    ).toEqual(["campaign", "channel", "results", "sentAt", "actions"]);
    const historyTable = screen.getByRole("table");
    expect(historyTable.className).toContain("min-w-[20rem]");
    expect(historyTable.parentElement?.parentElement?.className).toContain(
      "overflow-x-auto"
    );
    expect(screen.queryByText("templateMessage")).toBeNull();
    expect(screen.queryByText("acceptedRate")).toBeNull();
    expect(screen.queryByText("deliveryRate")).toBeNull();
    expect(screen.queryByText("readRate")).toBeNull();
    expect(screen.queryByText("openRate")).toBeNull();
    expect(screen.queryByText("clickRate")).toBeNull();
    expect(screen.queryByText("unsubscribeRate")).toBeNull();
    expect(screen.queryByText("77077778624")).toBeNull();
    expect(screen.queryByText("meta")).toBeNull();
    expect(screen.queryByText("details.recipientEvents")).toBeNull();

    const detailsButton = screen.getByRole("button", {
      name: "details.showDeliveryDetails",
    });
    expect(detailsButton.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(detailsButton);

    expect(
      await screen.findAllByText("Business eligibility payment issue")
    ).toHaveLength(2);
    expect(detailsButton.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("details.recipientEvents")).toBeTruthy();
    expect(screen.getByText("details.metrics.recipients")).toBeTruthy();
    expect(screen.getByText("details.metrics.accepted")).toBeTruthy();
    expect(screen.getByText("details.metrics.failed")).toBeTruthy();
    expect(screen.getByText("details.metrics.replyRate")).toBeTruthy();
    expect(screen.getByText("25.5%")).toBeTruthy();
    expect(screen.getByText("77077778624")).toBeTruthy();
    expect(screen.getByText("meta")).toBeTruthy();
    expect(screen.getAllByRole("table")).toHaveLength(1);
  });

  it("calls onViewAnalytics for WhatsApp campaigns", async () => {
    const onViewAnalytics = jest.fn();
    global.fetch = jest.fn(
      async () =>
        ({
          ok: true,
          json: async () => ({
            campaigns: [
              {
                id: "campaign-wa-1",
                name: "WA promo",
                channel: "whatsapp",
                template_name: "promo",
                template_language: "en",
                total_recipients: 10,
                successful_sends: 10,
                failed_sends: 0,
                sent_at: "2026-06-08T09:36:49.234683+00:00",
                estimated_cost: 1.5,
                reply_rate: 40,
                replied_count: 4,
                cost_per_reply: 0.375,
                messages: [],
              },
            ],
            pagination: { page: 1, limit: 20, total: 1, pages: 1 },
          }),
        }) as Response
    ) as jest.Mock;

    renderWithSWR(
      <CampaignHistory
        workspaceId="workspace-1"
        onViewAnalytics={onViewAnalytics}
      />
    );

    expect(await screen.findByText("results")).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", { name: "details.showDeliveryDetails" })
    );
    expect(screen.getByText("details.metrics.replyRate")).toBeTruthy();
    expect(screen.getByText("details.metrics.costPerReply")).toBeTruthy();
    expect(screen.getByText("40.0%")).toBeTruthy();
    expect(screen.getByText("$0.38")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "viewAnalytics" }));
    expect(onViewAnalytics).toHaveBeenCalledWith("campaign-wa-1");
  });

  it.each([
    ["not_priced", 239, 'costStatus.unpricedMessages {"count":239}'],
    ["not_priced", null, "costStatus.notPricedDetail"],
    ["not_tracked", null, "costStatus.notTracked"],
  ])(
    "explains a %s WhatsApp cost instead of a bare dash",
    async (costStatus, unpricedCount, detail) => {
      global.fetch = jest.fn(
        async () =>
          ({
            ok: true,
            json: async () =>
              buildHistoryResponse([
                buildCampaign({
                  operation: null,
                  estimated_cost: null,
                  cost_per_reply: null,
                  cost_status: costStatus,
                  unpriced_message_count: unpricedCount,
                }),
              ]),
          }) as Response
      ) as jest.Mock;

      renderWithSWR(<CampaignHistory workspaceId={WORKSPACE_ID} />);
      fireEvent.click(
        await screen.findByRole("button", {
          name: "details.showDeliveryDetails",
        })
      );

      const cost = screen.getByText("details.metrics.cost").parentElement!;
      expect(within(cost).getByText("costStatus.notPriced")).toBeTruthy();
      expect(within(cost).getByText(detail)).toBeTruthy();
      const costPerReply = screen.getByText(
        "details.metrics.costPerReply"
      ).parentElement!;
      expect(
        within(costPerReply).getByText("costStatus.notPriced")
      ).toBeTruthy();
      expect(screen.getByText("costStatus.explanation")).toBeTruthy();
      expect(within(cost).queryByText("-")).toBeNull();
    }
  );

  it("shows Meta's account spend once for workspaces with WhatsApp campaigns", async () => {
    global.fetch = jest.fn(
      async () =>
        ({
          ok: true,
          json: async () =>
            buildHistoryResponse([
              buildCampaign({ operation: null, cost_status: "reported" }),
            ]),
        }) as Response
    ) as jest.Mock;

    renderWithSWR(<CampaignHistory workspaceId={WORKSPACE_ID} />);

    expect(await screen.findByTestId("whatsapp-spend-summary")).toBeTruthy();
    expect(mockSpendSummary).toHaveBeenLastCalledWith(
      expect.objectContaining({
        workspaceId: WORKSPACE_ID,
        period: { days: 30 },
      })
    );
  });

  it("shows email metric columns when workspace has email campaigns", async () => {
    global.fetch = jest.fn(
      async () =>
        ({
          ok: true,
          json: async () => ({
            campaigns: [
              {
                id: "campaign-1",
                name: "Welcome email",
                channel: "email",
                template_name: "welcome",
                total_recipients: 10,
                successful_sends: 10,
                failed_sends: 0,
                sent_at: "2026-06-08T09:36:49.234683+00:00",
                estimated_cost: null,
                open_rate: 40,
                click_rate: 12,
                unsubscribe_rate: 1,
                messages: [],
              },
            ],
            hasEmailCampaigns: true,
            pagination: { page: 1, limit: 20, total: 1, pages: 1 },
          }),
        }) as Response
    ) as jest.Mock;

    renderWithSWR(<CampaignHistory workspaceId="workspace-1" />);

    expect(await screen.findByText("results")).toBeTruthy();
    expect(screen.queryByText("details.metrics.openRate")).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "details.showDeliveryDetails" })
    );

    expect(screen.getByText("details.metrics.openRate")).toBeTruthy();
    expect(screen.getByText("details.metrics.clickRate")).toBeTruthy();
    expect(screen.getByText("details.metrics.unsubscribeRate")).toBeTruthy();
    expect(screen.getByText("details.metrics.bounceRate")).toBeTruthy();
    expect(screen.getByText("40.0%")).toBeTruthy();
    expect(screen.getByText("12.0%")).toBeTruthy();
    expect(screen.queryByTestId("whatsapp-spend-summary")).toBeNull();
  });

  it("renders operation aggregates from the single history response without per-row status requests", async () => {
    const fetchMock = installFetchMock(async () =>
      jsonResponse(buildHistoryResponse([buildCampaign()]))
    );

    renderWithSWR(<CampaignHistory workspaceId={WORKSPACE_ID} />);

    expect(await screen.findByText("operations.status.running")).toBeTruthy();
    expect(screen.getByText("4 / 10")).toBeTruthy();
    expect(screen.getByText("summary.accepted")).toBeTruthy();
    // Delivery buckets are exclusive; the screen shows a funnel (2 + 1 read).
    expect(
      screen.getByText("operations.delivery.delivered").parentElement?.textContent
    ).toContain("3");
    expect(screen.queryByText("operations.delivery.read")).toBeNull();
    expect(screen.queryByText("operations.delivery.pending")).toBeNull();
    expect(screen.queryByText("99.9%")).toBeNull();
    const detailsToggle = screen.getByRole("button", {
      name: "details.showDeliveryDetails",
    });
    fireEvent.click(detailsToggle);
    const detailsPanel = document.getElementById(
      detailsToggle.getAttribute("aria-controls") || ""
    );
    if (!detailsPanel) throw new Error("Expanded delivery details are missing");
    const details = within(detailsPanel);
    expect(
      details.getByText("operations.delivery.accepted").parentElement
        ?.textContent
    ).toContain("6");
    expect(
      details.getByText("operations.delivery.delivered").parentElement
        ?.textContent
    ).toContain("3");
    expect(
      details.getByText("operations.delivery.read").parentElement?.textContent
    ).toContain("1");
    expect(
      details.getByText("operations.delivery.failed").parentElement?.textContent
    ).toContain("1");
    expect(
      details.getByText("operations.delivery.pending").parentElement?.textContent
    ).toContain("1");
    expect(screen.getByText("operations.remaining")).toBeTruthy();
    expect(screen.queryByText("operations.notAttempted")).toBeNull();
    expect(screen.queryByText("failureSummary.allFailed")).toBeNull();
    expect(screen.queryByText("failureSummary.someFailed")).toBeNull();
    expect(screen.queryByText("details.description")).toBeNull();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      `/api/campaigns/history?workspaceId=${WORKSPACE_ID}`
    );
    expect(
      fetchMock.mock.calls.some(([input]) => String(input).includes("/status"))
    ).toBe(false);
  });

  it("shows a stopped run's progress as messages sent, not the skipped batch", async () => {
    installFetchMock(async () =>
      jsonResponse(
        buildHistoryResponse([
          buildCampaign({
            operation: buildOperation({
              status: "running",
              totalRecipients: 500,
              progress: { processed: 40, attempted: 20, notAttempted: 480 },
            }),
          }),
        ])
      )
    );

    renderWithSWR(<CampaignHistory workspaceId={WORKSPACE_ID} />);

    expect(await screen.findByText("20 / 500")).toBeTruthy();
    expect(screen.queryByText("40 / 500")).toBeNull();
  });

  it("keeps failed totals visible after completion even without a failure reason", async () => {
    installFetchMock(async () =>
      jsonResponse(
        buildHistoryResponse([
          buildCampaign({
            operation: buildOperation({
              status: "completed",
              canCancel: false,
            }),
          }),
        ])
      )
    );
    renderWithSWR(<CampaignHistory workspaceId={WORKSPACE_ID} />);

    expect(await screen.findByText("operations.status.completed")).toBeTruthy();
    expect(screen.getByText("summary.failed")).toBeTruthy();
    expect(screen.queryByText("details.title")).toBeNull();
  });

  it("does not show campaign failure alerts while the bulk is still running", async () => {
    installFetchMock(async () =>
      jsonResponse(
        buildHistoryResponse([
          buildCampaign({
            failure_summary: {
              failedCount: 1,
              topReason: "Business eligibility payment issue",
              topErrorCode: 131042,
              reasons: [
                {
                  reason: "Business eligibility payment issue",
                  count: 1,
                  errorCode: 131042,
                },
              ],
            },
          }),
        ])
      )
    );

    renderWithSWR(<CampaignHistory workspaceId={WORKSPACE_ID} />);

    expect(await screen.findByText("operations.status.running")).toBeTruthy();
    expect(screen.getByText("operations.remaining")).toBeTruthy();
    expect(screen.getByText("4 / 10")).toBeTruthy();
    expect(screen.queryByText("operations.notAttempted")).toBeNull();
    expect(screen.queryByText("failureSummary.allFailed")).toBeNull();
    expect(screen.queryByText("failureSummary.someFailed")).toBeNull();
    expect(screen.queryByText("Business eligibility payment issue")).toBeNull();
  });

  it("shows leftover-queue and failure reasons after the campaign finishes", async () => {
    installFetchMock(async () =>
      jsonResponse(
        buildHistoryResponse([
          buildCampaign({
            failure_summary: {
              failedCount: 1,
              topReason: "Business eligibility payment issue",
              topErrorCode: 131042,
              reasons: [
                {
                  reason: "Business eligibility payment issue",
                  count: 1,
                  errorCode: 131042,
                },
              ],
            },
            operation: buildOperation({
              status: "completed",
              canCancel: false,
              finishedAt: "2026-07-24T08:00:10.000Z",
              progress: {
                processed: 4,
                accepted: 3,
                attempted: 4,
                notAttempted: 6,
                successful: 3,
                failed: 1,
              },
            }),
          }),
        ])
      )
    );

    renderWithSWR(<CampaignHistory workspaceId={WORKSPACE_ID} />);

    expect(await screen.findByText("operations.status.completed")).toBeTruthy();
    expect(screen.getByText("operations.notAttempted")).toBeTruthy();
    expect(screen.queryByText("operations.remaining")).toBeNull();
    expect(screen.getByText("failureSummary.someFailed")).toBeTruthy();
    expect(screen.getByText("Business eligibility payment issue")).toBeTruthy();
  });

  it("keeps a slower delivery recovery poll after dispatch completes", async () => {
    jest.useFakeTimers();
    let historyRequests = 0;
    const activeCampaign = buildCampaign();
    const terminalCampaign = buildCampaign({
      operation: buildOperation({
        status: "completed",
        canCancel: false,
        finishedAt: "2026-07-24T08:00:10.000Z",
        progress: {
          processed: 10,
          accepted: 9,
          attempted: 10,
          notAttempted: 0,
          successful: 9,
          failed: 1,
        },
      }),
    });
    installFetchMock(async input => {
      if (
        String(input) !== `/api/campaigns/history?workspaceId=${WORKSPACE_ID}`
      ) {
        throw new Error(`Unexpected request: ${String(input)}`);
      }
      historyRequests += 1;
      return jsonResponse(
        buildHistoryResponse([
          historyRequests === 1 ? activeCampaign : terminalCampaign,
        ])
      );
    });

    renderWithSWR(<CampaignHistory workspaceId={WORKSPACE_ID} />);
    await act(flushMicrotasks);

    expect(screen.getByText("operations.status.running")).toBeTruthy();
    expect(historyRequests).toBe(1);

    await act(async () => {
      jest.advanceTimersByTime(2_000);
      await flushMicrotasks();
    });

    expect(historyRequests).toBe(2);
    expect(screen.getByText("operations.status.completed")).toBeTruthy();

    await act(async () => {
      jest.advanceTimersByTime(6_000);
      await flushMicrotasks();
    });

    expect(historyRequests).toBe(2);

    await act(async () => {
      jest.advanceTimersByTime(30_000);
      await flushMicrotasks();
    });

    expect(historyRequests).toBe(3);
  });

  it("refreshes completed campaign details from coalesced delivery events", async () => {
    jest.useFakeTimers();
    let delivered = false;
    const fetchMock = installFetchMock(async () =>
      jsonResponse(
        buildHistoryResponse([
          buildCampaign({
            operation: buildOperation({
              status: "completed",
              canCancel: false,
              delivery: { failed: delivered ? 1 : 0 },
            }),
            messages: [
              {
                id: "message-1",
                status: delivered ? "failed" : "sent",
                error_message: delivered ? "Spam Rate limit hit" : null,
              },
            ],
          }),
        ])
      )
    );
    renderWithSWR(<CampaignHistory workspaceId={WORKSPACE_ID} />);
    await act(flushMicrotasks);
    fireEvent.click(
      screen.getByRole("button", { name: "details.showDeliveryDetails" })
    );
    expect(screen.getByText("sent")).toBeTruthy();
    delivered = true;
    const handler = mockRealtimeHandlers.get("campaign.delivery.changed")!;
    await act(async () => {
      for (let index = 0; index < 84; index++)
        handler({
          eventId: `event-${index}`,
          version: 1,
          name: "campaign.delivery.changed",
          createdAt: "2026-09-15T10:55:00.000Z",
          dedupeKey: `campaign-status-${index}`,
          workspaceId: WORKSPACE_ID,
          payload: { campaignId: CAMPAIGN_ID },
        });
      jest.advanceTimersByTime(500);
      await flushMicrotasks();
    });
    expect(screen.getByText("Spam Rate limit hit")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(mockRealtimeChannel.bind).toHaveBeenCalledTimes(1);
  });

  it("catches up after realtime reconnect and keeps cached rows on a failed refresh", async () => {
    let failedRefresh = false;
    const fetchMock = installFetchMock(async () =>
      failedRefresh
        ? jsonResponse({ error: "offline" }, { ok: false, status: 503 })
        : jsonResponse(
            buildHistoryResponse([
              buildCampaign({
                operation: buildOperation({
                  status: "completed",
                  canCancel: false,
                }),
              }),
            ])
          )
    );
    const provider = new Map();
    const ui = () => (
      <SWRConfig value={{ provider: () => provider, dedupingInterval: 0 }}>
        <CampaignHistory workspaceId={WORKSPACE_ID} />
      </SWRConfig>
    );
    const view = render(ui());
    expect(await screen.findByText("operations.status.completed")).toBeTruthy();
    failedRefresh = true;
    mockRealtimeConnected = true;
    view.rerender(ui());
    expect(await screen.findByText("refreshError")).toBeTruthy();
    expect(screen.getByText("operations.status.completed")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    failedRefresh = false;
    mockRealtimeConnected = false;
    view.rerender(ui());
    mockRealtimeConnected = true;
    view.rerender(ui());
    await waitFor(() => expect(screen.queryByText("refreshError")).toBeNull());
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("recovers after more than three transient failures without another event", async () => {
    jest.useFakeTimers();
    let failuresRemaining = 0;
    const fetchMock = installFetchMock(async () =>
      failuresRemaining-- > 0
        ? jsonResponse({ error: "offline" }, { ok: false, status: 503 })
        : jsonResponse(
            buildHistoryResponse([
              buildCampaign({
                operation: buildOperation({
                  status: "completed",
                  canCancel: false,
                }),
              }),
            ])
          )
    );
    renderWithSWR(<CampaignHistory workspaceId={WORKSPACE_ID} />);
    await act(flushMicrotasks);
    failuresRemaining = 4;
    await act(async () => {
      mockRealtimeHandlers.get("campaign.delivery.changed")!({
        eventId: "event-1",
        version: 1,
        name: "campaign.delivery.changed",
        workspaceId: WORKSPACE_ID,
        payload: { campaignId: CAMPAIGN_ID },
        createdAt: "2026-09-15T10:55:00.000Z",
        dedupeKey: "campaign-status-1",
      });
      jest.advanceTimersByTime(500);
      await flushMicrotasks();
    });
    for (const delay of [5_000, 10_000, 20_000]) {
      expect(screen.getByText("refreshError")).toBeTruthy();
      await act(async () => {
        jest.advanceTimersByTime(delay);
        await flushMicrotasks();
      });
    }
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(screen.getByText("refreshError")).toBeTruthy();
    await act(async () => {
      jest.advanceTimersByTime(30_000);
      await flushMicrotasks();
    });
    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(screen.queryByText("refreshError")).toBeNull();
    expect(screen.getByText("operations.status.completed")).toBeTruthy();
  });

  it("does not retry a transient failure after the history unmounts", async () => {
    jest.useFakeTimers();
    const fetchMock = installFetchMock(async () =>
      jsonResponse({ error: "offline" }, { ok: false, status: 503 })
    );
    const view = renderWithSWR(<CampaignHistory workspaceId={WORKSPACE_ID} />);
    await act(flushMicrotasks);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    view.unmount();
    await act(async () => {
      jest.advanceTimersByTime(60_000);
      await flushMicrotasks();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("shows local suppression separately from a Meta delivery failure", async () => {
    installFetchMock(async () =>
      jsonResponse(
        buildHistoryResponse([
          buildCampaign({
            operation: buildOperation({
              status: "completed",
              canCancel: false,
            }),
            failure_summary: {
              failedCount: 1,
              topReason: "contact_frequency_limit",
            },
            messages: [
              {
                id: "message-1",
                provider: "meta",
                status: "failed",
                error_message: "contact_frequency_limit",
              },
            ],
          }),
        ])
      )
    );
    renderWithSWR(<CampaignHistory workspaceId={WORKSPACE_ID} />);
    expect(
      await screen.findByText("failureSummary.localCooldown")
    ).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "details.showDeliveryDetails" })
    );
    expect(screen.getByText("details.localSuppression")).toBeTruthy();
    expect(screen.getByText("airi.chat")).toBeTruthy();
    expect(screen.queryByText("meta")).toBeNull();
    expect(screen.queryByText("contact_frequency_limit")).toBeNull();
  });

  it("shows the contact cooldown time without creating a second retry request", async () => {
    const nextEligibleAt = new Date(Date.now() + 86_400_000).toISOString();
    const fetchMock = installFetchMock(async (_input, init) =>
      init?.method === "POST"
        ? jsonResponse(
            {
              code: "retry_contact_cooldown",
              cooldown: {
                blockedRecipientCount: 84,
                eligibleRecipientCount: 0,
                nextEligibleAt,
              },
            },
            { ok: false, status: 409 }
          )
        : jsonResponse(
            buildHistoryResponse([
              buildCampaign({
                operation: buildOperation({
                  status: "completed",
                  canCancel: false,
                  retry: { available: true, failedRecipientCount: 84 },
                }),
              }),
            ])
          )
    );
    renderWithSWR(<CampaignHistory workspaceId={WORKSPACE_ID} />);
    const button = await screen.findByRole("button", {
      name: "operations.retry.action",
    });
    fireEvent.click(button);
    expect(
      await screen.findByText(
        new RegExp(
          `operations.retry.cooldown.*${nextEligibleAt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`
        )
      )
    ).toBeTruthy();
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(button);
    expect(
      fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")
    ).toHaveLength(1);
    expect(screen.queryByText("operations.retry.success")).toBeNull();
  });

  it("says how many recently contacted recipients a queued retry left out", async () => {
    installFetchMock(async (_input, init) =>
      init?.method === "POST"
        ? jsonResponse({
            queued: true,
            skippedRecentContact: 2,
            campaignId: "66666666-6666-4666-8666-666666666666",
            status: "queued",
          })
        : jsonResponse(
            buildHistoryResponse([
              buildCampaign({
                operation: buildOperation({
                  status: "completed",
                  canCancel: false,
                  retry: { available: true, failedRecipientCount: 5 },
                }),
              }),
            ])
          )
    );
    renderWithSWR(<CampaignHistory workspaceId={WORKSPACE_ID} />);
    fireEvent.click(
      await screen.findByRole("button", { name: "operations.retry.action" })
    );
    expect(
      await screen.findByText(
        'operations.retry.successSkippedRecent {"count":2}'
      )
    ).toBeTruthy();
    expect(screen.queryByText("operations.retry.success")).toBeNull();
  });

  it("cancels an active row restored from history with the strict body and refreshes that history key", async () => {
    const cancelResponse = createDeferred<Response>();
    let historyRequests = 0;
    const fetchMock = installFetchMock(async (input, init) => {
      const url = String(input);
      if (url === `/api/campaigns/history?workspaceId=${WORKSPACE_ID}`) {
        historyRequests += 1;
        const operation =
          historyRequests > 1
            ? buildOperation({
                status: "cancelled",
                canCancel: false,
                cancelledAt: "2026-07-24T08:00:03.000Z",
              })
            : buildOperation();
        return jsonResponse(
          buildHistoryResponse([buildCampaign({ operation })])
        );
      }
      if (url === `/api/campaigns/${CAMPAIGN_ID}/cancel`) {
        expect(init?.method).toBe("POST");
        expect(JSON.parse(String(init?.body))).toEqual({
          workspaceId: WORKSPACE_ID,
        });
        expect(String(init?.body)).not.toContain("recipient");
        return cancelResponse.promise;
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    renderWithSWR(<CampaignHistory workspaceId={WORKSPACE_ID} />);
    const cancelButton = await screen.findByRole("button", {
      name: "operations.cancel.action",
    });

    fireEvent.click(cancelButton);
    await waitFor(() =>
      expect(cancelButton.getAttribute("disabled")).not.toBeNull()
    );
    expect(
      screen.getByRole("button", { name: "operations.cancel.pending" })
    ).toBeTruthy();

    cancelResponse.resolve(
      jsonResponse({
        campaignId: CAMPAIGN_ID,
        status: "cancelled",
        outcome: "cancelled",
        temporalCancellation: "cancelled",
      })
    );

    expect(await screen.findByText("operations.cancel.success")).toBeTruthy();
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.filter(
          ([input]) =>
            String(input) ===
            `/api/campaigns/history?workspaceId=${WORKSPACE_ID}`
        )
      ).toHaveLength(2)
    );
    expect(
      screen.queryByRole("button", { name: "operations.cancel.action" })
    ).toBeNull();
  });

  it("pauses an active history row then offers resume", async () => {
    let historyRequests = 0;
    const fetchMock = installFetchMock(async (input, init) => {
      const url = String(input);
      if (url === `/api/campaigns/history?workspaceId=${WORKSPACE_ID}`) {
        historyRequests += 1;
        return jsonResponse(
          buildHistoryResponse([
            buildCampaign({
              operation: buildOperation({
                paused: historyRequests > 1,
              }),
            }),
          ])
        );
      }
      if (url === `/api/campaigns/${CAMPAIGN_ID}/pause`) {
        expect(init?.method).toBe("POST");
        expect(JSON.parse(String(init?.body))).toEqual({
          workspaceId: WORKSPACE_ID,
          paused: true,
        });
        return jsonResponse({
          campaignId: CAMPAIGN_ID,
          status: "running",
          paused: true,
          outcome: "paused",
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    renderWithSWR(<CampaignHistory workspaceId={WORKSPACE_ID} />);
    fireEvent.click(
      await screen.findByRole("button", { name: "operations.pause.action" })
    );

    expect(await screen.findByText("operations.pause.success")).toBeTruthy();
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.filter(
          ([input]) =>
            String(input) ===
            `/api/campaigns/history?workspaceId=${WORKSPACE_ID}`
        )
      ).toHaveLength(2)
    );
    expect(
      screen.getByRole("button", { name: "operations.pause.resume" })
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "operations.cancel.action" })
    ).toBeTruthy();
  });

  it("refreshes and warns when cancellation is local despite a 502 Temporal response", async () => {
    let historyRequests = 0;
    installFetchMock(async (input, init) => {
      const url = String(input);
      if (url === `/api/campaigns/history?workspaceId=${WORKSPACE_ID}`) {
        historyRequests += 1;
        return jsonResponse(
          buildHistoryResponse([
            buildCampaign({
              operation: buildOperation(
                historyRequests === 1
                  ? {}
                  : {
                      status: "cancelled",
                      canCancel: false,
                      cancelledAt: "2026-07-24T08:00:03.000Z",
                    }
              ),
            }),
          ])
        );
      }
      expect(url).toBe(`/api/campaigns/${CAMPAIGN_ID}/cancel`);
      expect(JSON.parse(String(init?.body))).toEqual({
        workspaceId: WORKSPACE_ID,
      });
      return jsonResponse(
        {
          campaignId: CAMPAIGN_ID,
          status: "cancelled",
          code: "temporal_cancel_failed",
          error:
            "Campaign was cancelled locally, but workflow cancellation could not be confirmed.",
        },
        { ok: false, status: 502 }
      );
    });

    renderWithSWR(<CampaignHistory workspaceId={WORKSPACE_ID} />);
    fireEvent.click(
      await screen.findByRole("button", {
        name: "operations.cancel.action",
      })
    );

    expect(
      await screen.findByText("operations.cancel.localWarning")
    ).toBeTruthy();
    await waitFor(() => expect(historyRequests).toBe(2));
  });

  it("shows row-scoped cancellation errors and restores the action", async () => {
    installFetchMock(async input => {
      const url = String(input);
      if (url === `/api/campaigns/history?workspaceId=${WORKSPACE_ID}`) {
        return jsonResponse(buildHistoryResponse([buildCampaign()]));
      }
      return jsonResponse(
        { code: "campaign_cancel_failed", error: "Provider unavailable" },
        { ok: false, status: 503 }
      );
    });

    renderWithSWR(<CampaignHistory workspaceId={WORKSPACE_ID} />);
    const cancelButton = await screen.findByRole("button", {
      name: "operations.cancel.action",
    });
    fireEvent.click(cancelButton);

    expect(await screen.findByText("Provider unavailable")).toBeTruthy();
    expect(cancelButton.getAttribute("disabled")).toBeNull();
  });

  it("offers failed-only retry solely from a terminal operation aggregate and sends no audience data", async () => {
    const retryableId = "33333333-3333-4333-8333-333333333333";
    let historyRequests = 0;
    installFetchMock(async (input, init) => {
      const url = String(input);
      if (url === `/api/campaigns/history?workspaceId=${WORKSPACE_ID}`) {
        historyRequests += 1;
        return jsonResponse(
          buildHistoryResponse([
            buildCampaign({
              id: "44444444-4444-4444-8444-444444444444",
              name: "Bounced only",
              operation: buildOperation({
                campaignId: "44444444-4444-4444-8444-444444444444",
                status: "completed",
                canCancel: false,
                delivery: { failed: 8 },
                retry: { available: false, failedRecipientCount: 0 },
              }),
            }),
            buildCampaign({
              id: "55555555-5555-4555-8555-555555555555",
              name: "Active but inconsistent",
              operation: buildOperation({
                campaignId: "55555555-5555-4555-8555-555555555555",
                status: "running",
                retry: { available: true, failedRecipientCount: 3 },
              }),
            }),
            buildCampaign({
              id: retryableId,
              name: "Retryable failures",
              operation: buildOperation({
                campaignId: retryableId,
                status: "failed",
                canCancel: false,
                retry: {
                  available: historyRequests === 1,
                  failedRecipientCount: 3,
                  kind: "failed_only",
                },
              }),
            }),
          ])
        );
      }
      expect(url).toBe(`/api/campaigns/${retryableId}/retry`);
      expect(init?.method).toBe("POST");
      const body = JSON.parse(String(init?.body));
      expect(body).toEqual({
        workspaceId: WORKSPACE_ID,
        providerCircuitAcknowledged: false,
      });
      expect(Object.keys(body).sort()).toEqual([
        "providerCircuitAcknowledged",
        "workspaceId",
      ]);
      expect(String(init?.body)).not.toMatch(
        /recipient|snapshot|fingerprint|workflow/i
      );
      return jsonResponse({
        queued: true,
        campaignId: "66666666-6666-4666-8666-666666666666",
        status: "queued",
      });
    });

    renderWithSWR(<CampaignHistory workspaceId={WORKSPACE_ID} />);

    const retryButtons = await screen.findAllByRole("button", {
      name: "operations.retry.action",
    });
    expect(retryButtons).toHaveLength(1);
    fireEvent.click(retryButtons[0]!);

    expect(await screen.findByText("operations.retry.success")).toBeTruthy();
    await waitFor(() => expect(historyRequests).toBe(2));
  });

  it("requires explicit provider-circuit acknowledgement before retry and clears it after refresh", async () => {
    let historyRequests = 0;
    const fetchMock = installFetchMock(async (input, init) => {
      const url = String(input);
      if (url === `/api/campaigns/history?workspaceId=${WORKSPACE_ID}`) {
        historyRequests += 1;
        return jsonResponse(
          buildHistoryResponse([
            buildCampaign({
              operation: buildOperation({
                status: "failed",
                canCancel: false,
                providerCircuit: {
                  state: "open",
                  provider: "meta",
                  code: "131042",
                  openedAt: "2026-07-24T08:00:03.000Z",
                  failureCount: 6,
                  requiresAcknowledgement: true,
                },
                retry: {
                  available: true,
                  failedRecipientCount: 6,
                  kind: "failed_only",
                },
              }),
            }),
          ])
        );
      }
      expect(url).toBe(`/api/campaigns/${CAMPAIGN_ID}/retry`);
      expect(JSON.parse(String(init?.body))).toEqual({
        workspaceId: WORKSPACE_ID,
        providerCircuitAcknowledged: true,
      });
      return jsonResponse({
        queued: true,
        campaignId: "77777777-7777-4777-8777-777777777777",
        status: "queued",
      });
    });

    renderWithSWR(<CampaignHistory workspaceId={WORKSPACE_ID} />);

    expect(
      await screen.findByText("operations.retry.circuitWarning")
    ).toBeTruthy();
    expect(screen.getByText("meta")).toBeTruthy();
    expect(screen.getByText("131042")).toBeTruthy();
    expect(
      screen.getByText("operations.retry.failureCount").parentElement
        ?.textContent
    ).toContain("6");

    const retryButton = screen.getByRole("button", {
      name: "operations.retry.action",
    });
    expect(retryButton.getAttribute("disabled")).not.toBeNull();
    fireEvent.click(retryButton);
    expect(
      fetchMock.mock.calls.some(
        ([input]) => String(input) === `/api/campaigns/${CAMPAIGN_ID}/retry`
      )
    ).toBe(false);

    const acknowledgement = screen.getByRole("checkbox", {
      name: "operations.retry.acknowledgeCircuit",
    });
    fireEvent.click(acknowledgement);
    expect((acknowledgement as HTMLInputElement).checked).toBe(true);
    fireEvent.click(retryButton);

    expect(await screen.findByText("operations.retry.success")).toBeTruthy();
    await waitFor(() => expect(historyRequests).toBe(2));
    expect(
      (
        screen.getByRole("checkbox", {
          name: "operations.retry.acknowledgeCircuit",
        }) as HTMLInputElement
      ).checked
    ).toBe(false);
  });

  it("shows retry pending and row-scoped API errors without refreshing history", async () => {
    const retryResponse = createDeferred<Response>();
    let historyRequests = 0;
    installFetchMock(async input => {
      const url = String(input);
      if (url === `/api/campaigns/history?workspaceId=${WORKSPACE_ID}`) {
        historyRequests += 1;
        return jsonResponse(
          buildHistoryResponse([
            buildCampaign({
              operation: buildOperation({
                status: "failed",
                canCancel: false,
                retry: {
                  available: true,
                  failedRecipientCount: 1,
                  kind: "failed_only",
                },
              }),
            }),
          ])
        );
      }
      return retryResponse.promise;
    });

    renderWithSWR(<CampaignHistory workspaceId={WORKSPACE_ID} />);
    const retryButton = await screen.findByRole("button", {
      name: "operations.retry.action",
    });
    fireEvent.click(retryButton);

    await waitFor(() =>
      expect(retryButton.getAttribute("disabled")).not.toBeNull()
    );
    expect(
      screen.getByRole("button", { name: "operations.retry.pending" })
    ).toBeTruthy();

    retryResponse.resolve(
      jsonResponse(
        { code: "retry_consent_changed", error: "Consent changed" },
        { ok: false, status: 409 }
      )
    );

    expect(await screen.findByText("Consent changed")).toBeTruthy();
    expect(retryButton.getAttribute("disabled")).toBeNull();
    expect(historyRequests).toBe(1);
  });
});
beforeEach(() => {
  mockRealtimeHandlers.clear();
  mockRealtimeChannel.bind.mockClear();
  mockRealtimeChannel.unbind.mockClear();
  mockRealtimeConnected = false;
});
