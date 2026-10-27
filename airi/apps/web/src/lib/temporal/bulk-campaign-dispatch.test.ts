const mockWorkflowStart = jest.fn();
const mockCancel = jest.fn();
const mockQuery = jest.fn();
const mockSignal = jest.fn();
const mockGetHandle = jest.fn((_workflowId: string) => ({
  cancel: mockCancel,
  query: mockQuery,
  signal: mockSignal,
}));

jest.mock("./client", () => ({
  getTemporalClient: () => ({
    workflow: {
      start: (...args: unknown[]) => mockWorkflowStart(...args),
      getHandle: (workflowId: string) => mockGetHandle(workflowId),
    },
  }),
  getTemporalWebClientConfig: () => ({ taskQueue: "campaigns" }),
}));

import {
  BulkCampaignPauseUnsupportedError,
  cancelBulkCampaignDispatchWorkflow,
  signalBulkCampaignDispatchPause,
  startBulkCampaignDispatchWorkflow,
} from "./bulk-campaign-dispatch";
import { loadTemporalClientSdk } from "./sdk";

const { WorkflowNotFoundError } = loadTemporalClientSdk();

describe("bulk campaign Temporal client", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockWorkflowStart.mockResolvedValue({ workflowId: "started-handle" });
  });

  it("rejects reuse of a closed workflow id so recovery cannot resend a campaign", async () => {
    await startBulkCampaignDispatchWorkflow({
      lifecycleManaged: true,
      workspaceId: "workspace-1",
      campaignId: "campaign-1",
      requestedAt: "2026-07-24T10:00:00.000Z",
      dispatchExpiresAt: "2026-07-24T10:15:00.000Z",
      scheduledAt: null,
      batchPlan: {
        batchSize: 20,
        delayMs: 250,
        ratePerSecond: 80,
        rateSource: "meta_default_throughput",
        throughputLevel: "STANDARD",
      },
      items: [],
    });

    expect(mockWorkflowStart).toHaveBeenCalledWith(
      "bulkCampaignDispatchWorkflow",
      expect.objectContaining({
        workflowId: "bulk-campaign-dispatch:workspace-1:campaign-1",
        workflowIdReusePolicy: "REJECT_DUPLICATE",
      })
    );
  });
});

describe("cancelBulkCampaignDispatchWorkflow", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCancel.mockResolvedValue(undefined);
  });

  it("cancels the exact workflow handle", async () => {
    await expect(
      cancelBulkCampaignDispatchWorkflow("bulk-campaign:persisted")
    ).resolves.toEqual({ outcome: "cancelled" });

    expect(mockGetHandle).toHaveBeenCalledWith("bulk-campaign:persisted");
    expect(mockCancel).toHaveBeenCalledTimes(1);
  });

  it.each(["Workflow not found", "Workflow execution already completed"])(
    "treats a typed Temporal not-found error as already closed: %s",
    async message => {
      mockCancel.mockRejectedValue(
        new WorkflowNotFoundError(message, "bulk-campaign:persisted", undefined)
      );

      await expect(
        cancelBulkCampaignDispatchWorkflow("bulk-campaign:persisted")
      ).resolves.toEqual({ outcome: "already_closed" });
    }
  );

  it("does not mistake a transport error with a spoofed name for Temporal not-found", async () => {
    const error = new Error("connection refused");
    error.name = "WorkflowNotFoundError";
    mockCancel.mockRejectedValue(error);

    await expect(
      cancelBulkCampaignDispatchWorkflow("bulk-campaign:persisted")
    ).rejects.toBe(error);
  });

  it("rethrows transport failures for route-level healing responses", async () => {
    mockCancel.mockRejectedValue(new Error("connection refused"));

    await expect(
      cancelBulkCampaignDispatchWorkflow("bulk-campaign:persisted")
    ).rejects.toThrow("connection refused");
  });
});

describe("signalBulkCampaignDispatchPause", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockQuery.mockResolvedValueOnce(true).mockResolvedValueOnce(true);
    mockSignal.mockResolvedValue(undefined);
  });

  it("queries pause-wait support before signaling", async () => {
    await expect(
      signalBulkCampaignDispatchPause({
        workflowId: "bulk-campaign:persisted",
        paused: true,
      })
    ).resolves.toEqual({ paused: true });

    expect(mockQuery.mock.invocationCallOrder[0]).toBeLessThan(
      mockSignal.mock.invocationCallOrder[0]
    );
    expect(mockQuery).toHaveBeenNthCalledWith(
      1,
      "bulkCampaignDispatchPauseWaitSupported"
    );
    expect(mockSignal).toHaveBeenCalledWith("bulkCampaignDispatchPause", true);
    expect(mockQuery).toHaveBeenNthCalledWith(2, "bulkCampaignDispatchPaused");
  });

  it("does not signal when pause-wait is unsupported", async () => {
    mockQuery.mockReset();
    mockQuery.mockResolvedValueOnce(false);

    await expect(
      signalBulkCampaignDispatchPause({
        workflowId: "bulk-campaign:persisted",
        paused: true,
      })
    ).rejects.toBeInstanceOf(BulkCampaignPauseUnsupportedError);
    expect(mockSignal).not.toHaveBeenCalled();
  });

  it("treats a missing pause-wait query as unsupported before any signal", async () => {
    mockQuery.mockReset();
    const missing = Object.assign(new Error("missing"), {
      name: "QueryNotRegisteredError",
    });
    mockQuery.mockRejectedValueOnce(missing);

    await expect(
      signalBulkCampaignDispatchPause({
        workflowId: "bulk-campaign:persisted",
        paused: true,
      })
    ).rejects.toBe(missing);
    expect(mockSignal).not.toHaveBeenCalled();
  });
});
