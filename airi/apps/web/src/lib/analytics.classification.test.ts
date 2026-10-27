const mockGetPostHogClient = jest.fn();

jest.mock("./posthog/server", () => ({
  getPostHogClient: (...args: unknown[]) => mockGetPostHogClient(...args),
}));

import { trackConversationClassificationCompleted } from "./analytics";

const input = {
  analysisRevisionId: "analysis-revision-1",
  conversationId: "507f1f77bcf86cd799439011",
  sourceRevision: 7,
  completedAt: new Date("2026-08-10T06:06:03.645Z"),
  workspaceId: "workspace-1",
  effectInputs: {
    companyId: "company-1",
    source: {
      id: "source-1",
      type: "whatsapp",
    },
    predictedCategoryConfidence: 0.73,
    processingTimeMs: 1_234,
    provider: "vertex",
    model: "gemini-2.5-flash",
    ragSummary: null,
  },
} as const;

describe("trackConversationClassificationCompleted", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("completes as a disabled no-op when server PostHog is not configured", async () => {
    mockGetPostHogClient.mockReturnValue(null);

    await expect(
      trackConversationClassificationCompleted(input)
    ).resolves.toEqual({ status: "disabled" });
  });

  it("captures the immutable classification event and stable insert identity", async () => {
    const capture = jest.fn();
    const flush = jest.fn().mockResolvedValue(undefined);
    mockGetPostHogClient.mockReturnValue({ capture, flush });

    await expect(
      trackConversationClassificationCompleted(input)
    ).resolves.toEqual({ status: "accepted" });

    expect(capture).toHaveBeenCalledWith({
      distinctId: "company-1",
      event: "message_classified",
      groups: { company: "company-1" },
      properties: {
        $insert_id: "analysis-revision-1",
        $process_person_profile: false,
        ai_model_used: "gemini-2.5-flash",
        ai_provider: "vertex",
        analysis_revision_id: "analysis-revision-1",
        classification_confidence: 0.73,
        company_id: "company-1",
        completed_at: "2026-08-10T06:06:03.645Z",
        conversation_id: "507f1f77bcf86cd799439011",
        processing_time_ms: 1_234,
        source_id: "source-1",
        source_revision: 7,
        source_type: "whatsapp",
        workspace_id: "workspace-1",
      },
    });
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it("omits absent optional source properties", async () => {
    const capture = jest.fn();
    const flush = jest.fn().mockResolvedValue(undefined);
    mockGetPostHogClient.mockReturnValue({ capture, flush });

    await trackConversationClassificationCompleted({
      ...input,
      effectInputs: {
        ...input.effectInputs,
        source: { id: null, type: null },
      },
    });

    const properties = capture.mock.calls[0][0].properties;
    expect(properties).not.toHaveProperty("source_id");
    expect(properties).not.toHaveProperty("source_type");
  });

  it("does not resolve until the PostHog flush resolves", async () => {
    let releaseFlush!: () => void;
    const flush = jest.fn(
      () =>
        new Promise<void>(resolve => {
          releaseFlush = resolve;
        })
    );
    mockGetPostHogClient.mockReturnValue({ capture: jest.fn(), flush });

    let settled = false;
    const result = trackConversationClassificationCompleted(input).finally(
      () => {
        settled = true;
      }
    );
    await Promise.resolve();

    expect(settled).toBe(false);
    releaseFlush();
    await expect(result).resolves.toEqual({ status: "accepted" });
  });

  it.each([
    [
      "capture",
      {
        capture: jest.fn(() => {
          throw new Error("capture failed");
        }),
        flush: jest.fn(),
      },
    ],
    [
      "flush",
      {
        capture: jest.fn(),
        flush: jest.fn().mockRejectedValue(new Error("flush failed")),
      },
    ],
  ])("rejects a %s failure", async (_label, client) => {
    mockGetPostHogClient.mockReturnValue(client);

    await expect(
      trackConversationClassificationCompleted(input)
    ).rejects.toThrow(/failed/);
  });
});
