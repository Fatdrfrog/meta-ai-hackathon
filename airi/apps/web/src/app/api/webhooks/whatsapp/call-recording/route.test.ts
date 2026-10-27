const mockConnectDB = jest.fn();
const mockUpdateOne = jest.fn();

jest.mock("@/lib/mongoose", () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockConnectDB(...args),
}));

jest.mock("@/models/whatsapp-call-recording", () => ({
  __esModule: true,
  default: {
    updateOne: (...args: unknown[]) => mockUpdateOne(...args),
  },
}));

import { POST } from "./route";

describe("POST /api/webhooks/whatsapp/call-recording", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = {
      ...originalEnv,
      WHATSAPP_CALL_RECORDING_WEBHOOK_SECRET: "recording-secret",
    };
    mockConnectDB.mockResolvedValue(undefined);
    mockUpdateOne.mockReturnValue({
      exec: jest.fn().mockResolvedValue({
        acknowledged: true,
        matchedCount: 1,
        modifiedCount: 1,
      }),
    });
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("marks a matching call recording transcript as completed", async () => {
    const response = await POST(
      new Request(
        "https://www.airi.chat/api/webhooks/whatsapp/call-recording",
        {
          method: "POST",
          headers: {
            "x-airi-webhook-secret": "recording-secret",
          },
          body: JSON.stringify({
            workspaceId: "workspace-1",
            callSessionId: "64c13ab08edf48a008793cab",
            callId: "wacid.1",
            idempotencyKey: "row-1",
            status: "completed",
            recordingObjectPath: "gs://bucket/call.webm",
            transcriptTextPath: "gs://bucket/call.transcript.json",
            transcriptionRequestId: "transcription-1",
            completedAt: "2026-06-19T12:00:00.000Z",
          }),
        }
      ) as never
    );

    await expect(response.json()).resolves.toEqual({
      ok: true,
      matched: true,
      transcriptStatus: "completed",
    });
    expect(response.status).toBe(200);
    expect(mockUpdateOne).toHaveBeenCalledWith(
      {
        workspaceId: "workspace-1",
        callSessionId: "64c13ab08edf48a008793cab",
        callId: "wacid.1",
        bigQueryExportRowId: "row-1",
      },
      {
        $set: expect.objectContaining({
          recordingObjectPath: "gs://bucket/call.webm",
          transcriptStatus: "completed",
          transcriptTextPath: "gs://bucket/call.transcript.json",
          transcriptionRequestId: "transcription-1",
          transcriptionLastError: null,
          transcriptCompletedAt: new Date("2026-06-19T12:00:00.000Z"),
        }),
      }
    );
  });

  it("marks a matching call recording transcript as failed", async () => {
    const response = await POST(
      new Request(
        "https://www.airi.chat/api/webhooks/whatsapp/call-recording",
        {
          method: "POST",
          headers: {
            "x-airi-webhook-secret": "recording-secret",
          },
          body: JSON.stringify({
            workspaceId: "workspace-1",
            callSessionId: "64c13ab08edf48a008793cab",
            callId: "wacid.1",
            idempotencyKey: "row-1",
            status: "failed",
            transcriptionRequestId: "transcription-1",
            errorMessage: "Speech service timed out",
            completedAt: "2026-06-19T12:01:00.000Z",
          }),
        }
      ) as never
    );

    expect(response.status).toBe(200);
    expect(mockUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-1",
        callSessionId: "64c13ab08edf48a008793cab",
        callId: "wacid.1",
        bigQueryExportRowId: "row-1",
      }),
      {
        $set: expect.objectContaining({
          transcriptStatus: "failed",
          transcriptionRequestId: "transcription-1",
          transcriptionLastError: "Speech service timed out",
          transcriptCompletedAt: new Date("2026-06-19T12:01:00.000Z"),
        }),
      }
    );
  });

  it("rejects callbacks without the shared recording secret", async () => {
    const response = await POST(
      new Request(
        "https://www.airi.chat/api/webhooks/whatsapp/call-recording",
        {
          method: "POST",
          headers: {
            "x-airi-webhook-secret": "wrong-secret",
          },
          body: JSON.stringify({
            workspaceId: "workspace-1",
            callSessionId: "64c13ab08edf48a008793cab",
            callId: "wacid.1",
            status: "completed",
          }),
        }
      ) as never
    );

    expect(response.status).toBe(401);
    expect(mockConnectDB).not.toHaveBeenCalled();
    expect(mockUpdateOne).not.toHaveBeenCalled();
  });

  it("returns 404 when no recording matches the callback identity", async () => {
    mockUpdateOne.mockReturnValue({
      exec: jest.fn().mockResolvedValue({
        acknowledged: true,
        matchedCount: 0,
        modifiedCount: 0,
      }),
    });

    const response = await POST(
      new Request(
        "https://www.airi.chat/api/webhooks/whatsapp/call-recording",
        {
          method: "POST",
          headers: {
            "x-airi-webhook-secret": "recording-secret",
          },
          body: JSON.stringify({
            workspaceId: "workspace-1",
            callSessionId: "64c13ab08edf48a008793cab",
            callId: "wacid.1",
            idempotencyKey: "row-1",
            status: "completed",
          }),
        }
      ) as never
    );

    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: "Call recording not found",
    });
    expect(response.status).toBe(404);
  });
});
