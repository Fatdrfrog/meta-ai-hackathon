const mockMessageFindOne = jest.fn();
const mockMessageUpdateOne = jest.fn();
const mockIsTemporalConfigured = jest.fn();
const mockStartConversationMediaAnalysisWorkflow = jest.fn();
const mockSignalConversationMediaAnalysisAiriTriggerWorkflow = jest.fn();

jest.mock("@/models/message", () => ({
  __esModule: true,
  default: {
    findOne: (...args: unknown[]) => mockMessageFindOne(...args),
    updateOne: (...args: unknown[]) => mockMessageUpdateOne(...args),
  },
}));

jest.mock("@/lib/temporal/conversation-media-analysis", () => ({
  isTemporalConfigured: (...args: unknown[]) =>
    mockIsTemporalConfigured(...args),
  startConversationMediaAnalysisWorkflow: (...args: unknown[]) =>
    mockStartConversationMediaAnalysisWorkflow(...args),
  signalConversationMediaAnalysisAiriTriggerWorkflow: (...args: unknown[]) =>
    mockSignalConversationMediaAnalysisAiriTriggerWorkflow(...args),
}));

import {
  buildConversationMediaAnalysisJobKey,
  enqueueConversationMediaAnalysis,
} from "./conversation-media-analysis-jobs";

function mockMessageLookup(message: Record<string, unknown> | null) {
  mockMessageFindOne.mockReturnValue({
    select: jest.fn().mockReturnValue({
      lean: jest.fn().mockResolvedValue(message),
    }),
  });
}

describe("enqueueConversationMediaAnalysis", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsTemporalConfigured.mockReturnValue(true);
    mockStartConversationMediaAnalysisWorkflow.mockResolvedValue({
      workflowId:
        "conversation-media-analysis:workspace-1:conversation-1:message-1:video",
      taskQueue: "airi-media",
      duplicate: false,
    });
    mockSignalConversationMediaAnalysisAiriTriggerWorkflow.mockResolvedValue({
      workflowId:
        "conversation-media-analysis:workspace-1:conversation-1:message-1:video",
    });
  });

  it("signals an already-active workflow when Airi is waiting for media", async () => {
    const workflowId =
      "conversation-media-analysis:workspace-1:conversation-1:message-1:video";
    mockMessageLookup({
      _id: "message-1",
      mediaType: "video",
      mediaAnalysis: { status: "submitted", workflowId },
    });

    await expect(
      enqueueConversationMediaAnalysis({
        workspaceId: "workspace-1",
        conversationId: "conversation-1",
        messageId: "message-1",
        mediaType: "video",
        triggerAiriAfterAnalysis: true,
      })
    ).resolves.toMatchObject({
      queued: false,
      reason: "already_active",
      workflowId,
    });

    expect(
      mockSignalConversationMediaAnalysisAiriTriggerWorkflow
    ).toHaveBeenCalledWith({ workflowId });
  });

  it("uses a persisted message snapshot without repeating the Mongo lookup", async () => {
    mockMessageUpdateOne.mockResolvedValue({ modifiedCount: 1 });

    await enqueueConversationMediaAnalysis({
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      messageId: "message-1",
      mediaType: "video",
      sourceId: "source-1",
      triggerAiriAfterAnalysis: true,
      messageState: {
        mediaType: "video",
        mediaAnalysis: null,
      },
    });

    expect(mockMessageFindOne).not.toHaveBeenCalled();
    expect(mockStartConversationMediaAnalysisWorkflow).toHaveBeenCalledTimes(1);
  });

  it("skips messages that already have an active or completed media workflow", async () => {
    mockMessageLookup({
      _id: "message-1",
      mediaType: "video",
      mediaAnalysis: {
        status: "queued",
        workflowId:
          "conversation-media-analysis:workspace-1:conversation-1:message-1:video",
      },
    });

    await expect(
      enqueueConversationMediaAnalysis({
        workspaceId: "workspace-1",
        conversationId: "conversation-1",
        messageId: "message-1",
        mediaType: "video",
      })
    ).resolves.toMatchObject({
      queued: false,
      reason: "already_active",
      workflowId:
        "conversation-media-analysis:workspace-1:conversation-1:message-1:video",
    });

    expect(mockStartConversationMediaAnalysisWorkflow).not.toHaveBeenCalled();
    expect(mockMessageUpdateOne).not.toHaveBeenCalled();
  });

  it("starts one deterministic workflow, forwards Airi deferral, and records enqueue timings", async () => {
    mockMessageLookup({
      _id: "message-1",
      mediaType: "video",
      mediaAnalysis: null,
    });
    mockMessageUpdateOne.mockResolvedValue({ modifiedCount: 1 });

    const result = await enqueueConversationMediaAnalysis({
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      messageId: "message-1",
      mediaType: "video",
      sourceId: "source-1",
      triggerAiriAfterAnalysis: true,
    });

    expect(result).toMatchObject({
      queued: true,
      reason: "queued",
      workflowId:
        "conversation-media-analysis:workspace-1:conversation-1:message-1:video",
      duplicate: false,
    });
    expect(
      (
        result as typeof result & {
          timings?: Record<string, number>;
        }
      ).timings
    ).toEqual({
      totalMs: expect.any(Number),
      messageLookupMs: expect.any(Number),
      workflowStartMs: expect.any(Number),
      statusWriteMs: expect.any(Number),
    });

    expect(mockStartConversationMediaAnalysisWorkflow).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      messageId: "message-1",
      mediaType: "video",
      sourceId: "source-1",
      triggerAiriAfterAnalysis: true,
    });
    expect(mockMessageUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: "message-1",
        workspaceId: "workspace-1",
        conversation: "conversation-1",
        $or: expect.not.arrayContaining([
          {
            "mediaAnalysis.workflowId":
              "conversation-media-analysis:workspace-1:conversation-1:message-1:video",
          },
        ]),
      }),
      expect.objectContaining({
        $set: expect.objectContaining({
          "mediaAnalysis.status": "queued",
          "mediaAnalysis.workflowId":
            "conversation-media-analysis:workspace-1:conversation-1:message-1:video",
          "mediaAnalysis.kind": "video",
          "mediaAnalysis.sourceId": "source-1",
        }),
      })
    );
  });

  it("keeps Temporal ownership when the enqueue status cache write fails", async () => {
    mockMessageLookup({
      _id: "message-1",
      mediaType: "video",
      mediaAnalysis: null,
    });
    mockMessageUpdateOne.mockRejectedValueOnce(
      new Error("Mongo status write unavailable")
    );

    await expect(
      enqueueConversationMediaAnalysis({
        workspaceId: "workspace-1",
        conversationId: "conversation-1",
        messageId: "message-1",
        mediaType: "video",
        triggerAiriAfterAnalysis: true,
      })
    ).resolves.toMatchObject({
      queued: true,
      reason: "queued",
      workflowId:
        "conversation-media-analysis:workspace-1:conversation-1:message-1:video",
      errorMessage: "Mongo status write unavailable",
    });

    expect(mockStartConversationMediaAnalysisWorkflow).toHaveBeenCalledTimes(1);
    expect(mockMessageUpdateOne).toHaveBeenCalledTimes(1);
  });

  it("builds the same key as the Temporal workflow id", () => {
    expect(
      buildConversationMediaAnalysisJobKey({
        workspaceId: "workspace-1",
        conversationId: "conversation-1",
        messageId: "message-1",
        mediaType: "voice",
      })
    ).toBe(
      "conversation-media-analysis:workspace-1:conversation-1:message-1:voice"
    );
  });
});
