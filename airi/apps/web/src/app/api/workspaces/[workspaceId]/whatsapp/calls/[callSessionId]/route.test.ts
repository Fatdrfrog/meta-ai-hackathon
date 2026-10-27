const mockRequireScenarioWorkspaceAccess = jest.fn();
const mockConnectDB = jest.fn();
const mockCallSessionFindOne = jest.fn();
const mockCallCommandCreate = jest.fn();
const mockCallCommandUpdateOne = jest.fn();
const mockSignalWithStartWhatsAppCallWorkflow = jest.fn();
const mockSignalWhatsAppCallCommandWorkflow = jest.fn();

jest.mock("@/lib/supabase/workspace-api-access", () => ({
  ...jest.requireActual("@/lib/supabase/workspace-api-access"),
  requireWorkspaceApiAccess: (...args: unknown[]) =>
    mockRequireScenarioWorkspaceAccess(...args),
}));

jest.mock("@/lib/mongoose", () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockConnectDB(...args),
}));

jest.mock("@/models/whatsapp-call-session", () => ({
  __esModule: true,
  default: {
    findOne: (...args: unknown[]) => mockCallSessionFindOne(...args),
  },
}));

jest.mock("@/models/whatsapp-call-command", () => ({
  __esModule: true,
  default: {
    create: (...args: unknown[]) => mockCallCommandCreate(...args),
    updateOne: (...args: unknown[]) => mockCallCommandUpdateOne(...args),
  },
}));

jest.mock("@/lib/temporal/whatsapp-call-client", () => ({
  signalWithStartWhatsAppCallWorkflow: (...args: unknown[]) =>
    mockSignalWithStartWhatsAppCallWorkflow(...args),
  signalWhatsAppCallCommandWorkflow: (...args: unknown[]) =>
    mockSignalWhatsAppCallCommandWorkflow(...args),
}));

import { POST } from "./route";

function buildRequest(body: unknown) {
  return new Request(
    "http://localhost/api/workspaces/workspace-1/whatsapp/calls/session-1",
    {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    }
  );
}

describe("workspace WhatsApp call command route", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockConnectDB.mockResolvedValue(undefined);
    mockRequireScenarioWorkspaceAccess.mockResolvedValue({
      ok: true,
      userId: "user-1",
      accessToken: null,
    });
    mockCallSessionFindOne.mockReturnValue({
      lean: () => ({
        exec: () =>
          Promise.resolve({
            _id: "session-1",
            workspaceId: "workspace-1",
            sourceId: "source-1",
            callId: "wacid.1",
            conversationId: "conversation-1",
            phoneNumberId: "phone-session",
            state: "incoming",
            sessionSdpType: "offer",
            sessionSdp: "v=0\r\no=- 123 456 IN IP4 127.0.0.1",
          }),
      }),
    });
    mockCallCommandCreate.mockResolvedValue({ _id: "command-1" });
    mockCallCommandUpdateOne.mockResolvedValue({ modifiedCount: 1 });
    mockSignalWithStartWhatsAppCallWorkflow.mockResolvedValue({
      workflowId: "whatsapp-call:workspace-1:phone-session:wacid.1",
      taskQueue: "worker-task-queue",
    });
    mockSignalWhatsAppCallCommandWorkflow.mockResolvedValue(undefined);
  });

  it("persists a pending reject command before signaling Temporal", async () => {
    const response = await POST(buildRequest({ action: "reject" }), {
      params: Promise.resolve({
        workspaceId: "workspace-1",
        callSessionId: "session-1",
      }),
    });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      workflowId: "whatsapp-call:workspace-1:phone-session:wacid.1",
      command: {
        id: "command-1",
        action: "reject",
        status: "pending",
      },
      whatsapp_call_session: {
        _id: "session-1",
        state: "incoming",
      },
    });
    expect(mockCallCommandCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-1",
        sourceId: "source-1",
        callSessionId: "session-1",
        callId: "wacid.1",
        action: "reject",
        status: "pending",
        requestedBy: "user-1",
        request: {
          hasSdp: false,
        },
      })
    );
    expect(mockSignalWithStartWhatsAppCallWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-1",
        sourceId: "source-1",
        callSessionId: "session-1",
        callId: "wacid.1",
        conversationId: "conversation-1",
        phoneNumberId: "phone-session",
        state: "incoming",
        sessionSdpType: "offer",
        sessionSdp: "v=0\r\no=- 123 456 IN IP4 127.0.0.1",
      })
    );
    expect(mockSignalWhatsAppCallCommandWorkflow).toHaveBeenCalledWith({
      workflowId: "whatsapp-call:workspace-1:phone-session:wacid.1",
      command: expect.objectContaining({
        commandId: "command-1",
        workspaceId: "workspace-1",
        callSessionId: "session-1",
        callId: "wacid.1",
        action: "reject",
        sdp: null,
      }),
    });
    expect(mockCallCommandCreate.mock.invocationCallOrder[0]).toBeLessThan(
      mockSignalWithStartWhatsAppCallWorkflow.mock.invocationCallOrder[0]
    );
  });

  it("queues accept commands without requiring the browser to provide SDP", async () => {
    const response = await POST(buildRequest({ action: "accept" }), {
      params: Promise.resolve({
        workspaceId: "workspace-1",
        callSessionId: "session-1",
      }),
    });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      command: {
        action: "accept",
        status: "pending",
      },
    });
    expect(mockSignalWhatsAppCallCommandWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        command: expect.objectContaining({
          action: "accept",
          sdp: null,
        }),
      })
    );
  });

  it("marks the command failed when Temporal dispatch fails", async () => {
    mockSignalWhatsAppCallCommandWorkflow.mockRejectedValue(
      new Error("temporal down")
    );

    const response = await POST(buildRequest({ action: "reject" }), {
      params: Promise.resolve({
        workspaceId: "workspace-1",
        callSessionId: "session-1",
      }),
    });

    await expect(response.json()).resolves.toEqual({
      error: "Failed to dispatch WhatsApp call command",
    });
    expect(response.status).toBe(502);
    expect(mockCallCommandUpdateOne).toHaveBeenCalledWith(
      { _id: "command-1" },
      expect.objectContaining({
        $set: expect.objectContaining({
          status: "failed",
          providerError: {
            type: "temporal_dispatch_failed",
            message: "temporal down",
          },
        }),
      })
    );
  });
});
