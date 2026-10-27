const mockEnrichReferral = jest.fn();
jest.mock("../whatsapp/referral-enrichment-store", () => ({enrichStoredWhatsAppReferral: (...args: unknown[]) => mockEnrichReferral(...args)}));
const mockPersistIntent = jest.fn();
const mockSignal = jest.fn();
const mockClaim = jest.fn();
const mockFinish = jest.fn();
const mockAppend = jest.fn();
const mockEnqueueMedia = jest.fn();
const mockMessageFind = jest.fn();
const mockMessageFindById = jest.fn();
const mockMessageUpdate = jest.fn();
const mockContextFind = jest.fn();
const mockCapacity = jest.fn();
jest.mock("@/lib/limits/company-runtime-capacity", () => ({ admitCompanyConversationIngress: (...args: unknown[]) => mockCapacity(...args) }));

jest.mock("@/lib/mongoose", () => ({ __esModule: true, default: jest.fn() }));
jest.mock("@/lib/temporal/client", () => ({
  signalAiriConversationTurn: (...args: unknown[]) => mockSignal(...args),
}));
jest.mock("@/lib/conversation-messages", () => ({
  appendMessageToConversationById: (...args: unknown[]) => mockAppend(...args),
}));
jest.mock("@/lib/media/conversation-media-analysis-jobs", () => ({
  enqueueConversationMediaAnalysis: (...args: unknown[]) =>
    mockEnqueueMedia(...args),
}));
jest.mock("./airi-ingress-lease", () => ({
  claimAiriIngress: (...args: unknown[]) => mockClaim(...args),
  finishAiriIngressClaim: (...args: unknown[]) => mockFinish(...args),
  getAiriIngressRetryDate: (now: Date) => new Date(now.getTime() + 30_000),
}));
jest.mock("./airi-turn-context", () => ({
  persistAiriConversationIngressIntent: (...args: unknown[]) =>
    mockPersistIntent(...args),
  buildStoredAiriConversationTurnSignal: (
    context: Record<string, unknown>
  ) => ({
    workspaceId: context.workspaceId,
    conversationId: context.conversationId,
    messageId: context.messageId,
    turnContextId: context.turnContextId,
    messageDate: (context.messageDate as Date).toISOString(),
    enqueuedAt: (context.enqueuedAt as Date).toISOString(),
  }),
}));
function query(result: unknown) {
  const chain = {
    select: () => chain,
    sort: () => chain,
    limit: () => chain,
    hint: () => chain,
    lean: async () => result,
  };
  return chain;
}
jest.mock("@/models/message", () => ({
  __esModule: true,
  MESSAGE_AIRI_INGRESS_PENDING_INDEX: {
    options: { name: "message_airi_ingress_pending" },
  },
  default: {
    find: (...args: unknown[]) => query(mockMessageFind(...args)),
    findById: (...args: unknown[]) => query(mockMessageFindById(...args)),
    updateOne: (...args: unknown[]) => mockMessageUpdate(...args),
  },
}));
jest.mock("@/models/airi-turn-context", () => ({
  ...jest.requireActual("@/models/airi-turn-context"),
  __esModule: true,
  default: { find: (...args: unknown[]) => query(mockContextFind(...args)) },
}));

import {
  dispatchPersistedAiriConversationIngress,
  materializeAiriMessageIngress,
  processAiriConversationIngressQueue,
} from "./airi-conversation-ingress";
import type { AiriTurnContextDocument } from "./airi-turn-context";

const now = new Date("2026-09-09T12:00:00Z");
const intent = {
  _id: "context-1",
  turnContextId: "turn-1",
  ingressKey: "ingress-1",
  ingressKind: "conversation_turn",
  ingressStatus: "pending",
  ingressAttempts: 0,
  workspaceId: "workspace-1",
  conversationId: "conversation-1",
  messageId: "message-1",
  sourceId: "source-1",
  channel: "telegram",
  messageDate: now,
  enqueuedAt: now,
} as unknown as AiriTurnContextDocument;
const message = {
  _id: "message-1",
  workspaceId: "workspace-1",
  conversation: "conversation-1",
  direction: "inbound",
  date: now,
  airiIngressIntent: intent,
};

describe("durable conversation ingress", () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockMessageFind.mockReturnValue([]);
    mockMessageFindById.mockReturnValue(message);
    mockContextFind.mockReturnValue([]);
    mockPersistIntent.mockImplementation(async value => value);
    mockClaim.mockResolvedValue({
      ...intent,
      ingressAttempts: 1,
      ingressLeaseToken: "lease-1",
    });
    mockFinish.mockResolvedValue(true);
    mockEnqueueMedia.mockResolvedValue({
      queued: false,
      reason: "unsupported_media",
    });
    mockSignal.mockResolvedValue({
      workflowHandle: { workflowId: "workflow-1" },
      workflowId: "workflow-1",
      turnContextId: "turn-1",
      taskQueue: "queue-1",
      alreadySignaled: false,
    });
  });

  it("keeps accepted messages queued when the company's dispatch share is exhausted", async () => {
    mockCapacity.mockRejectedValue(new Error("company capacity exhausted"));
    await expect(dispatchPersistedAiriConversationIngress(intent, { now })).rejects.toThrow("company capacity exhausted");
    expect(mockSignal).not.toHaveBeenCalled();
    expect(mockEnqueueMedia).not.toHaveBeenCalled();
    expect(mockFinish).toHaveBeenCalledWith(expect.objectContaining({ update: expect.objectContaining({ $set: expect.objectContaining({ ingressStatus: "pending", expiresAt: null }) }) }));
  });

  it("preserves a capacity retry timestamp from another runtime module", async () => {
    const retryAt = now.getTime() + 90_000;
    const error = Object.assign(new Error("Company capacity unavailable"), {
      code: "COMPANY_RUNTIME_CAPACITY_DEFERRED",
      reason: "unavailable",
      retryAt,
    });
    mockCapacity.mockRejectedValue(error);
    await expect(
      dispatchPersistedAiriConversationIngress(intent, { now })
    ).rejects.toBe(error);
    expect(mockSignal).not.toHaveBeenCalled();
    expect(mockEnqueueMedia).not.toHaveBeenCalled();
    expect(mockFinish).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          $set: expect.objectContaining({
            ingressStatus: "pending",
            ingressNextRetryAt: new Date(retryAt),
            expiresAt: null,
          }),
        }),
      })
    );
  });

  it("keeps the message intent when the queue write fails", async () => {
    mockPersistIntent.mockRejectedValue(new Error("database unavailable"));
    await expect(materializeAiriMessageIngress(message)).rejects.toThrow(
      "database unavailable"
    );
    expect(mockMessageUpdate).not.toHaveBeenCalled();
    expect(mockSignal).not.toHaveBeenCalled();
  });

  it("cannot materialize a message that was not committed", async () => {
    mockMessageFindById.mockReturnValue(null);
    await expect(
      materializeAiriMessageIngress({
        ...message,
        airiIngressIntent: undefined,
      })
    ).rejects.toThrow("message is missing");
    expect(mockPersistIntent).not.toHaveBeenCalled();
  });

  it("rejects an intent belonging to another conversation", async () => {
    await expect(
      materializeAiriMessageIngress({
        ...message,
        airiIngressIntent: { ...intent, conversationId: "conversation-2" },
      })
    ).rejects.toThrow("does not belong");
    expect(mockPersistIntent).not.toHaveBeenCalled();
    expect(mockMessageUpdate).not.toHaveBeenCalled();
  });

  it("removes the bootstrap marker only after preserving an already accepted context", async () => {
    mockPersistIntent.mockResolvedValue({
      ...intent,
      ingressStatus: "signaled",
    });
    const stored = await materializeAiriMessageIngress(message);
    expect(stored?.ingressStatus).toBe("signaled");
    expect(mockMessageUpdate).toHaveBeenCalledWith(
      { _id: message._id, "airiIngressIntent.ingressKey": intent.ingressKey },
      { $unset: { airiIngressIntent: "" } }
    );
  });

  it("recovers a committed message without another provider delivery", async () => {
    mockMessageFind.mockReturnValue([message]);
    mockContextFind.mockReturnValue([intent]);
    const result = await processAiriConversationIngressQueue({ now, limit: 5 });
    expect(result.signaled).toBe(1);
    expect(mockPersistIntent).toHaveBeenCalledWith(intent);
    expect(mockAppend).toHaveBeenCalledWith(
      "conversation-1",
      "message-1",
      expect.objectContaining({ direction: "inbound", lastMessageAt: now })
    );
    expect(mockSignal).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: "message-1",
        turnContextId: "turn-1",
        messageDate: now.toISOString(),
        enqueuedAt: now.toISOString(),
      })
    );
  });

  it("reschedules a failed signal and retries the same stable turn", async () => {
    mockSignal.mockRejectedValueOnce(new Error("Temporal unavailable"));
    await expect(
      dispatchPersistedAiriConversationIngress(intent, { now })
    ).rejects.toThrow("Temporal unavailable");
    expect(mockFinish).toHaveBeenLastCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          $set: expect.objectContaining({
            ingressStatus: "pending",
            ingressLastError: "Temporal unavailable",
            ingressNextRetryAt: new Date(now.getTime() + 30_000),
            expiresAt: null,
          }),
        }),
      })
    );
    await dispatchPersistedAiriConversationIngress(intent, {
      now: new Date(now.getTime() + 60_000),
    });
    expect(mockSignal.mock.calls[1][0]).toEqual(mockSignal.mock.calls[0][0]);
  });

  it("does not send while another attempt owns the lease", async () => {
    mockClaim.mockResolvedValue(null);
    await expect(
      dispatchPersistedAiriConversationIngress(intent, { now })
    ).rejects.toThrow("pending");
    expect(mockSignal).not.toHaveBeenCalled();
    expect(mockFinish).not.toHaveBeenCalled();
  });

  it("claims an exact context through the string-only ingress-key index", async () => {
    await dispatchPersistedAiriConversationIngress(intent, { now });

    expect(mockClaim).toHaveBeenCalledWith({
      filter: {
        ingressKey: { $eq: "ingress-1", $type: "string" },
        ingressKind: "conversation_turn",
        ingressStatus: "pending",
      },
      now,
    });
  });

  it.each([undefined, null, ""])(
    "refuses to claim a context with ingress key %p",
    async ingressKey => {
      await expect(
        dispatchPersistedAiriConversationIngress(
          { ...intent, ingressKey },
          { now }
        )
      ).rejects.toThrow("requires a durable intent");
      expect(mockClaim).not.toHaveBeenCalled();
      expect(mockSignal).not.toHaveBeenCalled();
    }
  );

  it("does not repeat a turn already accepted by Temporal", async () => {
    const result = await dispatchPersistedAiriConversationIngress(
      { ...intent, ingressStatus: "signaled", ingressWorkflowId: "workflow-1" },
      { now }
    );
    expect(result.alreadySignaled).toBe(true);
    expect(mockClaim).not.toHaveBeenCalled();
    expect(mockSignal).not.toHaveBeenCalled();
  });

  it("does not expire unfinished execution when the worker starts before ingress acknowledgment", async () => {
    const stored: Record<string, unknown> = { ...intent, expiresAt: null };
    mockSignal.mockImplementation(async () => {
      // The worker claims preparation as soon as the signal is accepted.
      stored.turnPreparation = { status: "preparing", attemptToken: "attempt-1" };
      stored.expiresAt = null;
      return { workflowId: "workflow-1" };
    });
    mockFinish.mockImplementation(async ({ update }) => {
      Object.assign(stored, update.$set);
      return true;
    });
    await dispatchPersistedAiriConversationIngress(intent, { now });
    expect(stored.ingressStatus).toBe("signaled");
    expect(stored.expiresAt).toBeNull();
  });

  it("leaves one failed item retryable while progressing other pending work", async () => {
    mockContextFind.mockReturnValue([
      intent,
      { ...intent, ingressKey: "ingress-2" },
    ]);
    mockSignal.mockRejectedValueOnce(new Error("Temporary failure"));
    const result = await processAiriConversationIngressQueue({ now });
    expect(result).toEqual(
      expect.objectContaining({ signaled: 1, retryScheduled: 1 })
    );
  });

  it("keeps WhatsApp media pending until analysis completes without signaling Airi early", async () => {
    mockClaim.mockResolvedValue({...intent, channel: "whatsapp", ingressAttempts: 1, ingressLeaseToken: "lease"});
    mockMessageFindById.mockReturnValue({...message, mediaType: "audio"});
    mockEnqueueMedia.mockResolvedValue({queued: true, reason: "queued"});
    await expect(dispatchPersistedAiriConversationIngress(intent)).rejects.toThrow("awaits media analysis");
    expect(mockSignal).not.toHaveBeenCalled();
    expect(mockEnqueueMedia).toHaveBeenCalledWith(expect.objectContaining({triggerAiriAfterAnalysis: true}));
    expect(mockFinish).toHaveBeenCalledWith(expect.objectContaining({update: expect.objectContaining({$set: expect.objectContaining({ingressStatus: "pending"})})}));
    mockEnqueueMedia.mockResolvedValue({queued: false, reason: "already_complete"});
    await dispatchPersistedAiriConversationIngress(intent);
    expect(mockSignal).toHaveBeenCalledTimes(1);
  });

  it("restores media analysis before handing a recovered message to Airi", async () => {
    mockMessageFindById.mockReturnValue({ ...message, mediaType: "voice" });
    mockEnqueueMedia.mockResolvedValue({ queued: true, reason: "queued" });
    await dispatchPersistedAiriConversationIngress(intent, { now });
    expect(mockEnqueueMedia).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: "message-1", mediaType: "voice" })
    );
    expect(mockEnqueueMedia.mock.invocationCallOrder[0]).toBeLessThan(
      mockSignal.mock.invocationCallOrder[0]
    );
  });

  it("retains the pending turn when media orchestration could not be accepted", async () => {
    mockMessageFindById.mockReturnValue({ ...message, mediaType: "video" });
    mockEnqueueMedia.mockResolvedValue({
      queued: false,
      reason: "publish_failed",
    });
    await expect(
      dispatchPersistedAiriConversationIngress(intent, { now })
    ).rejects.toThrow("media analysis");
    expect(mockSignal).not.toHaveBeenCalled();
    expect(mockFinish).toHaveBeenLastCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          $set: expect.objectContaining({ ingressStatus: "pending" }),
        }),
      })
    );
  });
});
