/**
 * @jest-environment jsdom
 */

import { act, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { SWRConfig } from "swr";
import type { BulkCampaignHealthResponse } from "@/lib/analytics/bulk-analytics-campaign-health-contract";
import type { CampaignOperationStatusResponse } from "@/lib/campaign/campaign-operations-contracts";
import { BulkCampaignHealth } from "./bulk-campaign-health";

jest.mock("next-intl", () => {
  const t = Object.assign((key: string) => key, { has: () => true });
  return { useLocale: () => "en", useTranslations: () => t };
});

const recipients = {
  planned: 2,
  attempted: 1,
  accepted: 1,
  delivered: 0,
  read: 0,
  failed: 0,
  awaitingReceipts: 1,
  uncertain: 0,
  untouched: 1,
};
const attempts = {
  accepted: 1,
  delivered: 0,
  read: 0,
  failed: 0,
  awaitingReceipts: 1,
  uncertain: 0,
};

function operation(
  status: CampaignOperationStatusResponse["status"]
): CampaignOperationStatusResponse {
  return {
    campaignId: "campaign-1",
    status,
    requestedAt: "2026-10-07T08:00:00.000Z",
    scheduledAt: null,
    dispatchExpiresAt: null,
    startedAt: "2026-10-07T08:00:01.000Z",
    progressAt: "2026-10-07T08:00:02.000Z",
    finishedAt: null,
    cancelledAt: null,
    expiredAt: null,
    totalRecipients: 2,
    progress: {
      processed: 1,
      accepted: 1,
      attempted: 1,
      notAttempted: 1,
      successful: 1,
      failed: 0,
    },
    delivery: { pending: 1, accepted: 1, delivered: 0, read: 0, failed: 0 },
    stopReason: null,
    providerCircuit: {
      state: "closed",
      provider: null,
      code: null,
      openedAt: null,
      failureCount: 0,
      requiresAcknowledgement: false,
    },
    retry: {
      ofCampaignId: null,
      kind: null,
      failedRecipientCount: 0,
      available: false,
    },
    canCancel: true,
    paused: false,
  };
}

function healthResponse(
  status: CampaignOperationStatusResponse["status"]
): BulkCampaignHealthResponse {
  return {
    observedAt: "2026-10-07T08:00:03.000Z",
    family: {
      rootCampaignId: "campaign-1",
      campaignIds: ["campaign-1"],
      campaigns: [
        {
          id: "campaign-1",
          name: "Fall sale",
          status: "sending",
          totalRecipients: 2,
          operation: operation(status),
        },
      ],
    },
    recipients,
    attempts,
    observed: { recipients, attempts },
    errors: [],
    coverage: {
      complete: true,
      reasons: [],
      scannedRows: 1,
      rowLimit: 1000,
      retainedSince: null,
    },
  };
}

function renderHealth(status: CampaignOperationStatusResponse["status"]) {
  const fetchMock = jest.fn(async () => ({
    ok: true,
    json: async () => healthResponse(status),
  }));
  global.fetch = fetchMock as unknown as typeof fetch;
  const wrapper = ({ children }: { children: ReactNode }) => (
    <SWRConfig value={{ provider: () => new Map() }}>{children}</SWRConfig>
  );
  render(
    <BulkCampaignHealth
      workspaceId="workspace-1"
      campaignIds={["campaign-1"]}
      onFilterError={jest.fn()}
    />,
    { wrapper }
  );
  return fetchMock;
}

describe("BulkCampaignHealth", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it("keeps refreshing while the campaign is still sending", async () => {
    const fetchMock = renderHealth("running");

    expect(await screen.findByText("Fall sale")).toBeTruthy();
    expect(screen.getByText("operations.status.running")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(() => jest.advanceTimersByTimeAsync(31_000));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("stops refreshing once the campaign has finished", async () => {
    const fetchMock = renderHealth("completed");

    expect(await screen.findByText("operations.status.completed")).toBeTruthy();

    await act(() => jest.advanceTimersByTimeAsync(31_000));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
