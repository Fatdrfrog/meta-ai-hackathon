const mockDispatchWebhookEvent = jest.fn();
const mockTriggerWebhookEvent = jest.fn();

jest.mock("./webhooks", () => ({
  WEBHOOK_EVENTS: {
    CONVERSATION_CREATED: "conversation.created",
    CONVERSATION_UPDATED: "conversation.updated",
    CONVERSATION_RESOLVED: "conversation.resolved",
    CONVERSATION_REOPENED: "conversation.reopened",
    MESSAGE_RECEIVED: "message.received",
    MESSAGE_SENT: "message.sent",
    CLASSIFICATION_COMPLETED: "classification.completed",
    CSAT_SUBMITTED: "csat.submitted",
    CSAT_LOW: "csat.low",
    SLA_BREACH: "sla.breach",
  },
  dispatchWebhookEvent: (...args: unknown[]) =>
    mockDispatchWebhookEvent(...args),
  triggerWebhookEvent: (...args: unknown[]) => mockTriggerWebhookEvent(...args),
}));

import {
  triggerClassificationCompletedStrict,
  type ClassificationEventData,
} from "./webhook-events";

const data: ClassificationEventData = {
  conversation_id: "507f1f77bcf86cd799439011",
  analysis_revision_id: "analysis-revision-1",
  source_revision: 7,
  category: "billing",
  priority: "high",
  sentiment: "negative",
  summary: "Customer asks about an invoice.",
  confidence: 0.73,
  completed_at: "2026-08-10T06:06:03.645Z",
};

describe("classification webhook events", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDispatchWebhookEvent.mockResolvedValue(undefined);
    mockTriggerWebhookEvent.mockResolvedValue(undefined);
  });

  it("dispatches the strict event with real workspace and persisted identity/time", async () => {
    await triggerClassificationCompletedStrict("workspace-1", data);

    expect(mockDispatchWebhookEvent).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      eventType: "classification.completed",
      resourceId: "analysis-revision-1",
      timestamp: "2026-08-10T06:06:03.645Z",
      data,
    });
  });

  it("does not hide strict delivery failures", async () => {
    mockDispatchWebhookEvent.mockRejectedValue(new Error("delivery failed"));

    await expect(
      triggerClassificationCompletedStrict("workspace-1", data)
    ).rejects.toThrow("delivery failed");
  });
});
