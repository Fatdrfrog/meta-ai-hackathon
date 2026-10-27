const mockSignalWithStartAiriConversationExternalEvent = jest.fn();
const mockIsTemporalConfigured = jest.fn();
const mockUserFindById = jest.fn();

jest.mock("@/lib/temporal/client", () => ({
  isTemporalConfigured: (...args: unknown[]) =>
    mockIsTemporalConfigured(...args),
  resolveAiriConversationWorkflowInactiveReason: (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    if (/workflow not found/i.test(message)) return "not_found";
    if (/workflow execution already completed/i.test(message)) {
      return "completed";
    }
    return null;
  },
  signalWithStartAiriConversationExternalEvent: (...args: unknown[]) =>
    mockSignalWithStartAiriConversationExternalEvent(...args),
}));

jest.mock("@/models/user", () => ({
  __esModule: true,
  default: {
    findById: (...args: unknown[]) => mockUserFindById(...args),
  },
}));

jest.mock("@/lib/airi/reply/runtime/reply-logging", () => ({
  airiOrchestrationLogger: {
    info: jest.fn(),
    warn: jest.fn(),
  },
}));

import {
  handleScenarioTimeoutMessageSaved,
  toScenarioTimeoutMessageEvent,
} from "@/lib/airi/scenario/scenario-timeout-events";
import { airiOrchestrationLogger } from "@/lib/airi/reply/runtime/reply-logging";

const mockAiriOrchestrationLogger = airiOrchestrationLogger as jest.Mocked<
  typeof airiOrchestrationLogger
>;

function createUserQuery(isBot: boolean | null) {
  return {
    select: jest.fn().mockReturnValue({
      lean: jest.fn().mockResolvedValue(isBot === null ? null : { isBot }),
    }),
  };
}

describe("scenario timeout message events", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsTemporalConfigured.mockReturnValue(true);
  });

  it("ignores inbound messages because reply ingress already reaches Temporal", async () => {
    await handleScenarioTimeoutMessageSaved({
      messageId: "msg-1",
      conversationId: "conv-1",
      workspaceId: "ws-1",
      channel: "telegram",
      direction: "inbound",
      author: "customer-1",
      text: "Hi",
      date: new Date("2026-03-26T10:00:00.000Z"),
    });

    expect(
      mockSignalWithStartAiriConversationExternalEvent
    ).not.toHaveBeenCalled();
  });

  it("signals Temporal when a human outbound reply is saved", async () => {
    mockUserFindById.mockReturnValue(createUserQuery(false));

    await handleScenarioTimeoutMessageSaved({
      messageId: "msg-2",
      conversationId: "conv-2",
      workspaceId: "ws-2",
      channel: "whatsapp",
      direction: "outbound",
      author: "agent-1",
      text: "Following up",
      date: new Date("2026-03-26T11:00:00.000Z"),
    });

    expect(
      mockSignalWithStartAiriConversationExternalEvent
    ).toHaveBeenCalledWith({
      kind: "human_outbound",
      workspaceId: "ws-2",
      conversationId: "conv-2",
      messageId: "msg-2",
      channel: "whatsapp",
      messageDate: "2026-03-26T11:00:00.000Z",
      enqueuedAt: expect.any(String),
    });
  });

  it("does not treat campaign outbounds as human replies", async () => {
    mockUserFindById.mockReturnValue(createUserQuery(false));

    expect(
      toScenarioTimeoutMessageEvent({
        _id: "6621b4ef4f9c8e0012345678",
        conversation: "6621b4ef4f9c8e0012345679",
        workspaceId: "ws-campaign",
        channel: "whatsapp",
        direction: "outbound",
        author: "whatsapp_business_1",
        origin: { kind: "campaign" },
        text: "[Template: rass1407]",
        date: new Date("2026-07-16T10:00:00.000Z"),
      })
    ).toMatchObject({ originKind: "campaign" });

    await handleScenarioTimeoutMessageSaved({
      messageId: "msg-campaign",
      conversationId: "conv-campaign",
      workspaceId: "ws-campaign",
      channel: "whatsapp",
      direction: "outbound",
      author: "whatsapp_business_1",
      originKind: "campaign",
      text: "[Template: rass1407]",
      date: new Date("2026-07-16T10:00:00.000Z"),
    });

    expect(
      mockSignalWithStartAiriConversationExternalEvent
    ).not.toHaveBeenCalled();
    expect(mockUserFindById).not.toHaveBeenCalled();
  });

  it("preserves scenario state locally when Temporal is unavailable", async () => {
    mockIsTemporalConfigured.mockReturnValue(false);
    mockUserFindById.mockReturnValue(createUserQuery(false));

    await handleScenarioTimeoutMessageSaved({
      messageId: "msg-3",
      conversationId: "conv-3",
      workspaceId: "ws-3",
      channel: "telegram",
      direction: "outbound",
      author: "agent-2",
      text: "Manual reply",
      date: new Date("2026-03-26T12:00:00.000Z"),
    });

    expect(
      mockSignalWithStartAiriConversationExternalEvent
    ).not.toHaveBeenCalled();
  });

  it("preserves scenario state locally when the Temporal signal fails", async () => {
    mockSignalWithStartAiriConversationExternalEvent.mockRejectedValue(
      new Error("workflow not found")
    );
    mockUserFindById.mockReturnValue(createUserQuery(false));

    await handleScenarioTimeoutMessageSaved({
      messageId: "msg-4",
      conversationId: "conv-4",
      workspaceId: "ws-4",
      channel: "whatsapp",
      direction: "outbound",
      author: "agent-3",
      text: "Manual reply",
      date: new Date("2026-03-26T13:00:00.000Z"),
    });

    expect(mockSignalWithStartAiriConversationExternalEvent).toHaveBeenCalled();
  });

  it("treats a completed Temporal workflow as a benign inactive workflow", async () => {
    mockSignalWithStartAiriConversationExternalEvent.mockRejectedValue(
      new Error("workflow execution already completed")
    );
    mockUserFindById.mockReturnValue(createUserQuery(false));

    await handleScenarioTimeoutMessageSaved({
      messageId: "msg-5",
      conversationId: "conv-5",
      workspaceId: "ws-5",
      channel: "whatsapp",
      direction: "outbound",
      author: "agent-4",
      text: "Manual reply",
      date: new Date("2026-03-26T14:00:00.000Z"),
    });

    expect(mockAiriOrchestrationLogger.info).toHaveBeenCalledWith(
      "airi.orchestration.timer_event",
      expect.objectContaining({
        note: "signal_human_outbound_no_active_workflow",
        errorMessage: "workflow execution already completed",
      })
    );
    expect(mockAiriOrchestrationLogger.warn).not.toHaveBeenCalledWith(
      "airi.orchestration.timer_event",
      expect.objectContaining({
        note: "signal_human_outbound_failed",
      })
    );
  });
});
