const mockAppendMessageToConversationById = jest.fn();
const mockConnectDB = jest.fn();
const mockRealtimeTrigger = jest.fn();
const mockTriggerConversationResolved = jest.fn();
const mockConversationFindById = jest.fn();
const mockMessageFindOne = jest.fn();
const mockMessageSave = jest.fn();
let mockMessageSequence = 0;

jest.mock("@/lib/conversation-messages", () => ({
  appendMessageToConversationById: (
    ...args: Parameters<typeof mockAppendMessageToConversationById>
  ) => mockAppendMessageToConversationById(...args),
}));
jest.mock("@/lib/mongoose", () => ({
  __esModule: true,
  default: (...args: Parameters<typeof mockConnectDB>) =>
    mockConnectDB(...args),
}));
jest.mock("@/lib/realtime/server", () => ({
  realtime: {
    trigger: (...args: Parameters<typeof mockRealtimeTrigger>) =>
      mockRealtimeTrigger(...args),
  },
}));
jest.mock("@/lib/webhook-events", () => ({
  triggerConversationResolved: (
    ...args: Parameters<typeof mockTriggerConversationResolved>
  ) => mockTriggerConversationResolved(...args),
}));
jest.mock("@/models/conversation", () => ({
  Conversation: {
    findById: (...args: Parameters<typeof mockConversationFindById>) =>
      mockConversationFindById(...args),
  },
}));
jest.mock("@/models/message", () => ({
  __esModule: true,
  default: Object.assign(
    function MockMessage(
      this: Record<string, unknown>,
      payload: Record<string, unknown>
    ) {
      mockMessageSequence += 1;
      Object.assign(this, payload, {
        _id: payload._id || `message-${mockMessageSequence}`,
      });
      this.save = () => mockMessageSave(this);
    },
    {
      findOne: (...args: Parameters<typeof mockMessageFindOne>) =>
        mockMessageFindOne(...args),
    }
  ),
}));

import {
  forceCloseWidgetCsatTimeout,
  sendWidgetCsatRequest,
  WIDGET_CSAT_REQUEST_TEXT,
} from "./widget-csat";
import { buildDeterministicMongoObjectId } from "./mongo-deterministic-id";
import {
  NON_READY_CLASSIFICATION_CASES,
  readyClassificationFields,
} from "./classifier/classified-conversation-test-utils";

const EXISTING_CLASSIFICATION = {
  category: "Support",
  priority: "medium",
  sentiment: "neutral",
  summary: "Customer needs help",
  action: "Follow up",
  tags: ["customer"],
  confidence: {
    category: 0.9,
    priority: 0.8,
    sentiment: 0.7,
  },
};

function buildForceCloseConversation() {
  return {
    _id: "conversation-1",
    workspaceId: "workspace-1",
    channel: "web_widget",
    status: "in_progress",
    awaiting_csat: true,
    customer_satisfaction_score: null,
    csat_timeout_closed: false,
    createdAt: new Date("2026-05-20T00:00:00.000Z"),
    user: "customer-1",
    ...readyClassificationFields(7, "analysis-revision-7"),
    classification: {
      ...EXISTING_CLASSIFICATION,
      tags: [...EXISTING_CLASSIFICATION.tags],
      confidence: { ...EXISTING_CLASSIFICATION.confidence },
    },
    save: jest.fn().mockResolvedValue(undefined),
  };
}

const NON_CURRENT_CLASSIFICATION_CASES: ReadonlyArray<{
  name: string;
  mutate: (
    conversation: ReturnType<typeof buildForceCloseConversation>
  ) => void;
}> = [
  ...NON_READY_CLASSIFICATION_CASES,
  {
    name: "revision mismatch",
    mutate: conversation => {
      conversation.classification_state.appliedRevision = 6;
    },
  },
  {
    name: "blank analysis id",
    mutate: conversation => {
      conversation.classification_meta.analysis_revision_id = "  ";
    },
  },
  {
    name: "partial root",
    mutate: conversation => {
      delete (conversation as Partial<typeof conversation>).classification_meta;
    },
  },
];

function mockLeanResult(value: unknown) {
  return {
    select: jest.fn().mockReturnThis(),
    lean: jest.fn().mockResolvedValue(value),
  };
}

describe("widget-csat handlers", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockMessageSequence = 0;
    mockMessageSave.mockReset();
    mockMessageSave.mockImplementation(async message => message);
    mockAppendMessageToConversationById.mockReset();
    mockConnectDB.mockResolvedValue(undefined);
    mockRealtimeTrigger.mockResolvedValue(undefined);
    mockTriggerConversationResolved.mockResolvedValue(undefined);
    mockAppendMessageToConversationById.mockResolvedValue({ appended: true });
  });

  it("repairs the canonical link before a retry acknowledges an existing CSAT message", async () => {
    mockConversationFindById.mockResolvedValue({
      _id: "conversation-1",
      workspaceId: "workspace-1",
      channel: "web_widget",
      awaiting_csat: true,
      customer_satisfaction_score: null,
    });
    mockMessageFindOne.mockReturnValue(mockLeanResult({ _id: "message-1" }));
    mockAppendMessageToConversationById.mockResolvedValueOnce({
      appended: false,
    });

    await expect(
      sendWidgetCsatRequest({
        workspaceId: "workspace-1",
        conversationId: "conversation-1",
      })
    ).resolves.toEqual({
      ok: true,
      skipped: true,
      reason: "csat_already_sent",
      messageId: "message-1",
    });
    expect(mockAppendMessageToConversationById).toHaveBeenCalledWith(
      "conversation-1",
      "message-1",
      expect.objectContaining({
        direction: "outbound",
        set: { awaiting_csat: true },
      })
    );
    expect(mockRealtimeTrigger).not.toHaveBeenCalled();
  });

  it("publishes a recovered CSAT message when canonical append commits it", async () => {
    const messageDate = new Date("2026-08-10T00:00:00.000Z");
    mockConversationFindById.mockResolvedValue({
      _id: "conversation-1",
      workspaceId: "workspace-1",
      channel: "web_widget",
      awaiting_csat: true,
      customer_satisfaction_score: null,
    });
    mockMessageFindOne.mockReturnValue(
      mockLeanResult({
        _id: "message-1",
        date: messageDate,
        text: WIDGET_CSAT_REQUEST_TEXT,
      })
    );
    mockAppendMessageToConversationById.mockResolvedValueOnce({
      appended: true,
    });

    await expect(
      sendWidgetCsatRequest({
        workspaceId: "workspace-1",
        conversationId: "conversation-1",
      })
    ).resolves.toEqual({ ok: true, messageId: "message-1" });

    expect(mockRealtimeTrigger).toHaveBeenCalledWith(
      "conversation-conversation-1",
      "message.new",
      expect.objectContaining({
        id: "message-1",
        timestamp: messageDate.toISOString(),
      })
    );
  });

  it("keeps an existing CSAT message retryable when canonical append fails", async () => {
    const appendError = new Error("append unavailable");
    mockConversationFindById.mockResolvedValue({
      _id: "conversation-1",
      workspaceId: "workspace-1",
      channel: "web_widget",
      awaiting_csat: true,
      customer_satisfaction_score: null,
    });
    mockMessageFindOne.mockReturnValue(mockLeanResult({ _id: "message-1" }));
    mockAppendMessageToConversationById.mockRejectedValueOnce(appendError);

    await expect(
      sendWidgetCsatRequest({
        workspaceId: "workspace-1",
        conversationId: "conversation-1",
      })
    ).rejects.toBe(appendError);
  });

  it("atomically links a new CSAT request and its awaiting state", async () => {
    const staleSave = jest.fn();
    const deterministicMessageId = buildDeterministicMongoObjectId(
      "widget-csat-request",
      "conversation-1"
    );
    mockConversationFindById.mockResolvedValue({
      _id: "conversation-1",
      workspaceId: "workspace-1",
      channel: "web_widget",
      awaiting_csat: false,
      customer_satisfaction_score: null,
      save: staleSave,
    });
    mockMessageFindOne.mockReturnValue(mockLeanResult(null));

    await expect(
      sendWidgetCsatRequest({
        workspaceId: "workspace-1",
        conversationId: "conversation-1",
        ensureAwaiting: true,
      })
    ).resolves.toEqual({ ok: true, messageId: deterministicMessageId });

    expect(mockAppendMessageToConversationById).toHaveBeenCalledWith(
      "conversation-1",
      deterministicMessageId,
      expect.objectContaining({
        direction: "outbound",
        set: { awaiting_csat: true },
      })
    );
    expect(staleSave).not.toHaveBeenCalled();
  });

  it("uses one stable persisted identity when concurrent attempts both pre-check empty", async () => {
    mockConversationFindById.mockResolvedValue({
      _id: "conversation-1",
      workspaceId: "workspace-1",
      channel: "web_widget",
      awaiting_csat: true,
      customer_satisfaction_score: null,
    });

    let findAttempt = 0;
    let winningMessage: Record<string, unknown> | null = null;
    mockMessageFindOne.mockImplementation(() => {
      findAttempt += 1;
      return mockLeanResult(findAttempt <= 2 ? null : winningMessage);
    });

    let rejectFirstSave: ((error: Error) => void) | undefined;
    mockMessageSave
      .mockImplementationOnce(
        () =>
          new Promise((_, reject) => {
            rejectFirstSave = reject;
          })
      )
      .mockImplementationOnce(async message => {
        winningMessage = message;
        rejectFirstSave?.(
          Object.assign(new Error("duplicate deterministic message id"), {
            code: 11000,
          })
        );
        return message;
      });
    mockAppendMessageToConversationById
      .mockResolvedValueOnce({ appended: true })
      .mockResolvedValueOnce({ appended: false });

    const results = await Promise.all([
      sendWidgetCsatRequest({
        workspaceId: "workspace-1",
        conversationId: "CONVERSATION-1",
      }),
      sendWidgetCsatRequest({
        workspaceId: "workspace-1",
        conversationId: "CONVERSATION-1",
      }),
    ]);
    const deterministicMessageId = buildDeterministicMongoObjectId(
      "widget-csat-request",
      "conversation-1"
    );

    expect(mockMessageSave).toHaveBeenCalledTimes(2);
    expect(winningMessage).toEqual(
      expect.objectContaining({
        _id: deterministicMessageId,
      })
    );
    expect(mockAppendMessageToConversationById).toHaveBeenCalledTimes(2);
    expect(
      mockAppendMessageToConversationById.mock.calls.map(call => call[1])
    ).toEqual([deterministicMessageId, deterministicMessageId]);
    expect(results).toEqual(
      expect.arrayContaining([
        { ok: true, messageId: deterministicMessageId },
        {
          ok: true,
          skipped: true,
          reason: "csat_already_sent",
          messageId: deterministicMessageId,
        },
      ])
    );
  });

  it("force-closes with the real previous status preserved", async () => {
    const save = jest.fn().mockResolvedValue(undefined);
    mockConversationFindById.mockResolvedValue({
      _id: "conversation-1",
      workspaceId: "workspace-1",
      channel: "web_widget",
      status: "in_progress",
      awaiting_csat: true,
      customer_satisfaction_score: null,
      csat_timeout_closed: false,
      createdAt: new Date("2026-05-20T00:00:00.000Z"),
      user: "customer-1",
      classification: { priority: "medium" },
      save,
    });

    await expect(
      forceCloseWidgetCsatTimeout({
        workspaceId: "workspace-1",
        conversationId: "conversation-1",
      })
    ).resolves.toEqual({
      ok: true,
      forceClosed: true,
    });

    expect(save).toHaveBeenCalled();
    // Customer webhooks keep receiving conversation.resolved for timeout closes.
    expect(mockTriggerConversationResolved).toHaveBeenCalledWith(
      "workspace-1",
      expect.objectContaining({
        conversation_id: "conversation-1",
        status: "closed",
        previous_status: "in_progress",
        resolution_kind: "timeout",
      })
    );
    const legacyPayload = mockTriggerConversationResolved.mock.calls[0]?.[1];
    expect(Object.hasOwn(legacyPayload, "classification")).toBe(false);
    expect(legacyPayload.resolution_time_seconds).toBeUndefined();
    expect(JSON.parse(JSON.stringify(legacyPayload))).not.toHaveProperty(
      "resolution_time_seconds"
    );
    expect(mockRealtimeTrigger).toHaveBeenCalledWith(
      "conversation-conversation-1",
      "conversation-updated",
      {
        workspaceId: "workspace-1",
        status: "closed",
        awaiting_csat: false,
        csat_timeout_closed: true,
      }
    );
  });

  it("keeps the complete classification for an exact current-ready timeout", async () => {
    const conversation = buildForceCloseConversation();
    mockConversationFindById.mockResolvedValue(conversation);

    await expect(
      forceCloseWidgetCsatTimeout({
        workspaceId: "workspace-1",
        conversationId: "conversation-1",
      })
    ).resolves.toEqual({ ok: true, forceClosed: true });

    expect(mockTriggerConversationResolved).toHaveBeenCalledTimes(1);
    expect(mockTriggerConversationResolved.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        conversation_id: "conversation-1",
        status: "closed",
        previous_status: "in_progress",
        channel: "web_widget",
        customer_phone: "customer-1",
        classification: EXISTING_CLASSIFICATION,
        created_at: "2026-05-20T00:00:00.000Z",
      })
    );
  });

  it.each(NON_CURRENT_CLASSIFICATION_CASES)(
    "omits the classification own property for a $name timeout root",
    async ({ mutate }) => {
      const conversation = buildForceCloseConversation();
      mutate(conversation);
      mockConversationFindById.mockResolvedValue(conversation);

      await forceCloseWidgetCsatTimeout({
        workspaceId: "workspace-1",
        conversationId: "conversation-1",
      });

      const payload = mockTriggerConversationResolved.mock.calls[0]?.[1];
      expect(payload).toEqual(
        expect.objectContaining({
          conversation_id: "conversation-1",
          status: "closed",
          previous_status: "in_progress",
          channel: "web_widget",
          customer_phone: "customer-1",
          created_at: "2026-05-20T00:00:00.000Z",
        })
      );
      expect(Object.hasOwn(payload, "classification")).toBe(false);
    }
  );

  it("does not await the best-effort resolved webhook", async () => {
    mockConversationFindById.mockResolvedValue(buildForceCloseConversation());
    mockTriggerConversationResolved.mockReturnValue(
      new Promise<never>(() => undefined)
    );

    await expect(
      forceCloseWidgetCsatTimeout({
        workspaceId: "workspace-1",
        conversationId: "conversation-1",
      })
    ).resolves.toEqual({ ok: true, forceClosed: true });
  });
});
