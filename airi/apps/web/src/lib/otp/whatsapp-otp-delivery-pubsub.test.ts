const mockPublishMessage = jest.fn<Promise<string>, [unknown]>();
const mockTopic = jest.fn<
  { publishMessage: (payload: unknown) => Promise<string> },
  [unknown, unknown]
>(() => ({
  publishMessage: (payload: unknown) => mockPublishMessage(payload),
}));
const mockPubSubCtor = jest.fn<
  { topic: (name: unknown, options: unknown) => ReturnType<typeof mockTopic> },
  [unknown]
>(() => ({
  topic: (name: unknown, options: unknown) => mockTopic(name, options),
}));

jest.mock("@google-cloud/pubsub", () => ({
  PubSub: function PubSub(options: unknown) {
    return mockPubSubCtor(options);
  },
}));

import {
  getWhatsAppOtpPubSubTopic,
  publishWhatsAppOtpDeliveryToPubSub,
} from "./whatsapp-otp-delivery-pubsub";
import { useCleanEnv } from "@/test-support/env-test-utils";

describe("WhatsApp OTP delivery Pub/Sub publisher", () => {
  useCleanEnv([
    "WHATSAPP_OTP_PUBSUB_TOPIC",
    "WHATSAPP_OTP_PUBSUB_PROJECT_ID",
    "GOOGLE_CLOUD_PROJECT",
    "GOOGLE_APPLICATION_CREDENTIALS_JSON",
    "GCP_PROJECT_NUMBER",
    "GCP_SERVICE_ACCOUNT_EMAIL",
    "GCP_WORKLOAD_IDENTITY_POOL_ID",
    "GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID",
  ]);

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.WHATSAPP_OTP_PUBSUB_PROJECT_ID = "project-1";
    mockPublishMessage.mockResolvedValue("pubsub-message-1");
  });

  it("uses the dedicated OTP topic by default", () => {
    expect(getWhatsAppOtpPubSubTopic()).toBe("icecore-whatsapp-otp-delivery");
  });

  it("publishes only delivery identifiers and no OTP code", async () => {
    const result = await publishWhatsAppOtpDeliveryToPubSub({
      workspaceId: "workspace-1",
      challengeId: "challenge-1",
      correlationId: "correlation-1",
      queuedAt: "2026-06-02T10:00:00.000Z",
    });

    expect(result).toEqual({ ok: true, messageId: "pubsub-message-1" });
    expect(mockPubSubCtor).toHaveBeenCalledWith({ projectId: "project-1" });
    expect(mockTopic).toHaveBeenCalledWith("icecore-whatsapp-otp-delivery", {
      messageOrdering: true,
    });
    expect(mockPublishMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        json: expect.objectContaining({
          workspaceId: "workspace-1",
          challengeId: "challenge-1",
          correlationId: "correlation-1",
        }),
        orderingKey: "workspace-1",
      })
    );
    expect(JSON.stringify(mockPublishMessage.mock.calls[0][0])).not.toMatch(
      /\b\d{6}\b/
    );
  });
});
