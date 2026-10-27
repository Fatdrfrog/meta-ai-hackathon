const mockFindOne = jest.fn();
const mockRecordReceipt = jest.fn();
const mockPersistSent = jest.fn();

jest.mock("@icecore/airi-runtime/bulk-dispatch-activity-dedupe", () => ({
  recordBulkDispatchActivityDedupe: (...args: unknown[]) =>
    mockRecordReceipt(...args),
}));
import { createCampaignTaskProviderAcceptance } from "@icecore/airi-runtime/campaign-task-provider-acceptance";

const recordCampaignTaskProviderAcceptance =
  createCampaignTaskProviderAcceptance({
    taskModel: { findOne: (...args: unknown[]) => mockFindOne(...args) },
    persistCampaignMessageSentWithOutbox: (...args: unknown[]) =>
      mockPersistSent(...args),
  });

const params = {
  taskId: "507f1f77bcf86cd799439011",
  workspaceId: "workspace-1",
  campaignId: "campaign-1",
  sourceId: "source-1",
  phoneNumberId: "phone-1",
  recipient: "77060000001",
  messageId: "wamid.accepted",
};
const task = {
  _id: params.taskId,
  workspaceId: params.workspaceId,
  campaignId: params.campaignId,
  channel: "whatsapp",
  provider: "meta",
  sourceId: params.sourceId,
  recipientPhone: "'+77060000001",
  providerAttemptStartedAt: new Date(),
  providerAttemptSourceId: params.sourceId,
  providerAttemptPhoneNumberId: params.phoneNumberId,
  providerAttemptRecipient: "'+77060000001",
  scenarioId: "507f1f77bcf86cd799439012",
  nodeId: "node-1",
  executionSource: "scenario_schedule",
};

beforeEach(() => {
  jest.clearAllMocks();
  mockFindOne.mockReturnValue({
    select: () => ({ lean: async () => ({ ...task }) }),
  });
  mockRecordReceipt.mockResolvedValue(undefined);
  mockPersistSent.mockResolvedValue({ applied: true, queuedToOutbox: false });
});

it("records exact task acceptance before creating the canonical sent row, preserving stored phone identity", async () => {
  await recordCampaignTaskProviderAcceptance(params);
  expect(mockFindOne).toHaveBeenCalledWith({
    _id: params.taskId,
    workspaceId: params.workspaceId,
    campaignId: params.campaignId,
    channel: "whatsapp",
    provider: "meta",
  });
  expect(mockRecordReceipt).toHaveBeenCalledWith({
    key: `campaign-task:${params.workspaceId}:${params.taskId}`,
    workspaceId: params.workspaceId,
    channel: "whatsapp",
    messageId: params.messageId,
    recipient: task.providerAttemptRecipient,
  });
  expect(mockPersistSent).toHaveBeenCalledWith(
    expect.objectContaining({
      campaignId: params.campaignId,
      messageId: params.messageId,
      recipient: task.providerAttemptRecipient,
      scenarioId: task.scenarioId,
      scenarioNodeId: task.nodeId,
    })
  );
  expect(mockRecordReceipt.mock.invocationCallOrder[0]).toBeLessThan(
    mockPersistSent.mock.invocationCallOrder[0]
  );
});

it.each([
  { _id: "507f1f77bcf86cd799439099" },
  { workspaceId: "other" },
  { campaignId: "other" },
  { channel: "email" },
  { provider: "other" },
  { sourceId: "other" },
  { providerAttemptStartedAt: null },
  { providerAttemptStartedAt: "invalid" },
  { providerAttemptSourceId: "other" },
  { providerAttemptPhoneNumberId: "other" },
  { providerAttemptRecipient: "77060000002" },
  { recipientPhone: "77060000002" },
])(
  "rejects an unmatched callback or missing durable send proof %j",
  async mismatch => {
    mockFindOne.mockReturnValue({
      select: () => ({ lean: async () => ({ ...task, ...mismatch }) }),
    });
    await recordCampaignTaskProviderAcceptance(params);
    expect(mockRecordReceipt).not.toHaveBeenCalled();
    expect(mockPersistSent).not.toHaveBeenCalled();
  }
);

it("does not hide receipt write failure or create a sent row without durable task proof", async () => {
  mockRecordReceipt.mockRejectedValue(new Error("receipt unavailable"));
  await expect(recordCampaignTaskProviderAcceptance(params)).rejects.toThrow(
    "receipt unavailable"
  );
  expect(mockPersistSent).not.toHaveBeenCalled();
});

it("requires canonical ledger ownership or outbox persistence after the receipt", async () => {
  mockPersistSent.mockResolvedValue({ applied: false, queuedToOutbox: false });
  await expect(recordCampaignTaskProviderAcceptance(params)).rejects.toThrow(
    "ledger"
  );
  expect(mockRecordReceipt).toHaveBeenCalledTimes(1);
});
