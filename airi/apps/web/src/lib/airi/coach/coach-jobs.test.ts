const mockIsTemporalConfigured = jest.fn();
const mockStartAiriCoachWorkflow = jest.fn();

jest.mock("@/lib/temporal/background-jobs", () => ({
  isTemporalConfigured: (...args: unknown[]) =>
    mockIsTemporalConfigured(...args),
  startAiriCoachWorkflow: (...args: unknown[]) =>
    mockStartAiriCoachWorkflow(...args),
}));

import {
  buildAiriCoachDedupeKey,
  enqueueAiriCoachJob,
  enqueueAiriCoachJobBestEffort,
  type AiriCoachJobPayload,
} from "./coach-jobs";

const payload: AiriCoachJobPayload = {
  workspaceId: "workspace-1",
  conversationId: "conversation-1",
  messageId: "message-1",
  agentId: "agent-1",
};

describe("enqueueAiriCoachJob", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns not_configured without falling back to legacy queues", async () => {
    mockIsTemporalConfigured.mockReturnValue(false);

    await expect(enqueueAiriCoachJob(payload)).resolves.toMatchObject({
      queued: false,
      reason: "not_configured",
      workflowId: buildAiriCoachDedupeKey(payload),
    });
    expect(mockStartAiriCoachWorkflow).not.toHaveBeenCalled();
  });

  it("starts the durable Temporal workflow with a stable workflow id", async () => {
    mockIsTemporalConfigured.mockReturnValue(true);
    mockStartAiriCoachWorkflow.mockResolvedValue({
      workflowId: "airi-coach:workspace-1:conversation-1:message-1",
      duplicate: false,
    });

    await expect(enqueueAiriCoachJob(payload)).resolves.toMatchObject({
      queued: true,
      reason: "queued",
      workflowId: "airi-coach:workspace-1:conversation-1:message-1",
      duplicate: false,
    });
    expect(mockStartAiriCoachWorkflow).toHaveBeenCalledWith(payload);
  });

  it("keeps the old failure shape for reply handlers", async () => {
    mockIsTemporalConfigured.mockReturnValue(true);
    mockStartAiriCoachWorkflow.mockRejectedValue(new Error("Temporal down"));

    await expect(enqueueAiriCoachJob(payload)).resolves.toMatchObject({
      queued: false,
      reason: "publish_failed",
      errorMessage: "Temporal down",
    });
  });
});

describe("enqueueAiriCoachJobBestEffort", () => {
  const flush = () => new Promise(resolve => setImmediate(resolve));
  let warn: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    warn = jest.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it("logs a failed enqueue with the handler's tag", async () => {
    mockIsTemporalConfigured.mockReturnValue(true);
    mockStartAiriCoachWorkflow.mockRejectedValue(new Error("Temporal down"));

    enqueueAiriCoachJobBestEffort(payload, "Reply:Telegram");
    await flush();

    expect(warn).toHaveBeenCalledWith(
      "[Reply:Telegram] Failed to enqueue Airi coach job",
      {
        reason: "publish_failed",
        workspaceId: "workspace-1",
        conversationId: "conversation-1",
        messageId: "message-1",
      }
    );
  });

  it("stays quiet when the job is queued", async () => {
    mockIsTemporalConfigured.mockReturnValue(true);
    mockStartAiriCoachWorkflow.mockResolvedValue({
      workflowId: "airi-coach:workspace-1:conversation-1:message-1",
      duplicate: false,
    });

    enqueueAiriCoachJobBestEffort(payload, "Reply:WhatsApp");
    await flush();

    expect(mockStartAiriCoachWorkflow).toHaveBeenCalledWith(payload);
    expect(warn).not.toHaveBeenCalled();
  });
});
