const mockPublishMessage = jest.fn<Promise<string>, [unknown]>();
const mockResumePublishing = jest.fn();
const mockGetGoogleCloudProjectId = jest.fn();
const mockGetVercelGcpAccessToken = jest.fn();
const mockHasVercelGcpWorkloadIdentityConfig = jest.fn();
const mockInvalidateVercelGcpAccessTokenCache = jest.fn();
const mockParseGoogleServiceAccountJson = jest.fn();
const mockTopic = jest.fn<
  {
    publishMessage: (payload: unknown) => Promise<string>;
    resumePublishing: (key: string) => void;
  },
  [unknown, unknown]
>(() => ({
  publishMessage: (payload: unknown) => mockPublishMessage(payload),
  resumePublishing: (key: string) => mockResumePublishing(key),
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
jest.mock("@/lib/google/gcp-auth", () => ({
  getGoogleCloudProjectId: (...args: unknown[]) =>
    mockGetGoogleCloudProjectId(...args),
  getVercelGcpAccessToken: (...args: unknown[]) =>
    mockGetVercelGcpAccessToken(...args),
  hasVercelGcpWorkloadIdentityConfig: (...args: unknown[]) =>
    mockHasVercelGcpWorkloadIdentityConfig(...args),
  invalidateVercelGcpAccessTokenCache: (...args: unknown[]) =>
    mockInvalidateVercelGcpAccessTokenCache(...args),
  parseGoogleServiceAccountJson: (...args: unknown[]) =>
    mockParseGoogleServiceAccountJson(...args),
}));

import { publishGooglePubSubJsonMessage } from "./pubsub-json-publisher";
import { useCleanEnv } from "@/test-support/env-test-utils";

describe("Google Pub/Sub JSON publisher", () => {
  useCleanEnv([
    "CUSTOM_PUBSUB_PROJECT_ID",
    "GOOGLE_APPLICATION_CREDENTIALS_JSON",
    "GCP_PROJECT_NUMBER",
    "GCP_SERVICE_ACCOUNT_EMAIL",
    "GCP_WORKLOAD_IDENTITY_POOL_ID",
    "GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID",
  ]);

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.CUSTOM_PUBSUB_PROJECT_ID = "project-1";
    mockGetGoogleCloudProjectId.mockReturnValue("project-1");
    mockHasVercelGcpWorkloadIdentityConfig.mockReturnValue(false);
    mockParseGoogleServiceAccountJson.mockReturnValue(undefined);
    mockPublishMessage.mockResolvedValue("message-1");
  });

  it("publishes ordered JSON messages with shared client fallback", async () => {
    const result = await publishGooglePubSubJsonMessage({
      projectIdEnvName: "CUSTOM_PUBSUB_PROJECT_ID",
      topic: "topic-1",
      message: { hello: "world" },
      orderingKey: "order-1",
      attributes: { kind: "test" },
    });

    expect(result).toEqual({ ok: true, messageId: "message-1" });
    expect(mockPubSubCtor).toHaveBeenCalledWith({ projectId: "project-1" });
    expect(mockTopic).toHaveBeenCalledWith("topic-1", {
      messageOrdering: true,
    });
    expect(mockPublishMessage).toHaveBeenCalledWith({
      json: { hello: "world" },
      orderingKey: "order-1",
      attributes: { kind: "test" },
    });
  });

  it("does not start a publish after its signal is aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("projection claim lost"));

    await expect(
      publishGooglePubSubJsonMessage({
        projectIdEnvName: "CUSTOM_PUBSUB_PROJECT_ID",
        topic: "topic-1",
        message: { hello: "world" },
        orderingKey: "order-1",
        signal: controller.signal,
      })
    ).rejects.toThrow("projection claim lost");
    expect(mockPubSubCtor).not.toHaveBeenCalled();
    expect(mockPublishMessage).not.toHaveBeenCalled();
  });

  it("reuses the publisher client and topic across consecutive hot-path events", async () => {
    mockGetGoogleCloudProjectId.mockReturnValue("reuse-test-project");
    const input = {
      projectIdEnvName: "CUSTOM_PUBSUB_PROJECT_ID",
      topic: "reuse-topic",
      message: {},
      orderingKey: "workspace:conversation",
    };
    await publishGooglePubSubJsonMessage(input);
    await publishGooglePubSubJsonMessage(input);
    expect(mockPubSubCtor).toHaveBeenCalledTimes(1);
    expect(mockTopic).toHaveBeenCalledTimes(1);
    expect(mockPublishMessage).toHaveBeenCalledTimes(2);
  });

  it("resumes a failed ordering key so the next durable retry can publish", async () => {
    mockGetGoogleCloudProjectId.mockReturnValue("retry-test-project");
    const input = {
      projectIdEnvName: "CUSTOM_PUBSUB_PROJECT_ID",
      topic: "retry-topic",
      message: {},
      orderingKey: "workspace:conversation",
    };
    mockPublishMessage.mockRejectedValueOnce(new Error("broker unavailable"));
    await expect(publishGooglePubSubJsonMessage(input)).rejects.toThrow(
      "broker unavailable"
    );
    expect(mockResumePublishing).toHaveBeenCalledWith(input.orderingKey);
    await expect(publishGooglePubSubJsonMessage(input)).resolves.toEqual({
      ok: true,
      messageId: "message-1",
    });
    expect(mockPubSubCtor).toHaveBeenCalledTimes(1);
  });

  it("refreshes the Vercel federation token once after Pub/Sub rejects it", async () => {
    mockHasVercelGcpWorkloadIdentityConfig.mockReturnValue(true);
    mockGetVercelGcpAccessToken
      .mockResolvedValueOnce("stale-token")
      .mockResolvedValueOnce("fresh-token");
    const originalFetch = global.fetch;
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: async () => "expired",
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ messageIds: ["message-2"] }),
      });
    global.fetch = fetchMock as typeof global.fetch;

    try {
      await expect(
        publishGooglePubSubJsonMessage({
          projectIdEnvName: "CUSTOM_PUBSUB_PROJECT_ID",
          topic: "topic-1",
          message: { hello: "world" },
          orderingKey: "order-1",
        })
      ).resolves.toEqual({ ok: true, messageId: "message-2" });
    } finally {
      global.fetch = originalFetch;
    }

    expect(mockInvalidateVercelGcpAccessTokenCache).toHaveBeenCalledTimes(1);
    expect(mockGetVercelGcpAccessToken).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer stale-token",
        }),
      })
    );
    expect(fetchMock.mock.calls[1]?.[1]).toEqual(
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer fresh-token",
        }),
      })
    );
  });
});
