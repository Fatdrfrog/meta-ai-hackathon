const mockSignalWithStart = jest.fn();

jest.mock("@/lib/temporal/client", () => ({
  getTemporalClient: () => ({
    workflow: {
      signalWithStart: (...args: unknown[]) => mockSignalWithStart(...args),
    },
  }),
  getTemporalWebClientConfig: () => ({
    taskQueue: "worker-task-queue",
  }),
}));

import {
  WHATSAPP_CALL_COMMAND_SIGNAL,
  WHATSAPP_CALL_SESSION_EVENT_SIGNAL,
  WHATSAPP_CALL_WORKFLOW,
} from "@icecore/temporal";
import {
  buildWhatsAppCallCommandSignal,
  buildWhatsAppCallSessionSignal,
  signalWithStartWhatsAppCallWorkflow,
} from "./whatsapp-call-client";

describe("WhatsApp call Temporal client", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSignalWithStart.mockResolvedValue({
      workflowId: "whatsapp-call:workspace-1:phone-1:wacid.1",
    });
  });

  it("builds compact call session signals from durable session state", () => {
    const signal = buildWhatsAppCallSessionSignal({
      workspaceId: "workspace-1",
      sourceId: "source-1",
      callSessionId: "session-1",
      callId: "wacid.1",
      conversationId: "conversation-1",
      phoneNumberId: "phone-1",
      state: "incoming",
      sessionSdp: "v=0",
      sessionSdpType: "offer",
      receivedAt: "2026-06-19T10:00:00.000Z",
    });

    expect(signal).toEqual({
      contractVersion: 1,
      workspaceId: "workspace-1",
      sourceId: "source-1",
      callSessionId: "session-1",
      callId: "wacid.1",
      conversationId: "conversation-1",
      phoneNumberId: "phone-1",
      state: "incoming",
      sessionSdp: "v=0",
      sessionSdpType: "offer",
      receivedAt: "2026-06-19T10:00:00.000Z",
    });
  });

  it("signals with start using one workflow id per workspace phone and call", async () => {
    const result = await signalWithStartWhatsAppCallWorkflow({
      workspaceId: "workspace-1",
      sourceId: "source-1",
      callSessionId: "session-1",
      callId: "wacid.1",
      conversationId: "conversation-1",
      phoneNumberId: "phone-1",
      state: "incoming",
      sessionSdp: "v=0",
      sessionSdpType: "offer",
      receivedAt: "2026-06-19T10:00:00.000Z",
    });

    expect(result).toEqual({
      workflowId: "whatsapp-call:workspace-1:phone-1:wacid.1",
      taskQueue: "worker-task-queue",
    });
    expect(mockSignalWithStart).toHaveBeenCalledWith(
      WHATSAPP_CALL_WORKFLOW,
      expect.objectContaining({
        workflowId: "whatsapp-call:workspace-1:phone-1:wacid.1",
        taskQueue: "worker-task-queue",
        signal: WHATSAPP_CALL_SESSION_EVENT_SIGNAL,
        signalArgs: [
          expect.objectContaining({
            callSessionId: "session-1",
            callId: "wacid.1",
            state: "incoming",
          }),
        ],
        args: [
          expect.objectContaining({
            contractVersion: 1,
            workflowId: "whatsapp-call:workspace-1:phone-1:wacid.1",
            initialSession: expect.objectContaining({
              callSessionId: "session-1",
            }),
          }),
        ],
      })
    );
  });

  it("builds command signals for serialized provider commands", () => {
    const signal = buildWhatsAppCallCommandSignal({
      commandId: "command-1",
      workspaceId: "workspace-1",
      callSessionId: "session-1",
      callId: "wacid.1",
      action: "terminate",
      requestedAt: "2026-06-19T10:00:01.000Z",
    });

    expect(signal).toEqual({
      contractVersion: 1,
      commandId: "command-1",
      workspaceId: "workspace-1",
      callSessionId: "session-1",
      callId: "wacid.1",
      action: "terminate",
      sdp: null,
      requestedAt: "2026-06-19T10:00:01.000Z",
    });
    expect(WHATSAPP_CALL_COMMAND_SIGNAL).toBe("whatsapp.call.command");
  });
});
