const mockRequireScenarioWorkspaceAccess = jest.fn();
const mockConnectDB = jest.fn();
const mockCallSessionFindOne = jest.fn();

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

import { GET } from "./route";

function buildRequest() {
  return new Request(
    "http://localhost/api/workspaces/workspace-1/whatsapp/calls/session-1/media-token",
    { method: "GET" }
  );
}

function buildParams() {
  return {
    params: Promise.resolve({
      workspaceId: "workspace-1",
      callSessionId: "session-1",
    }),
  };
}

function mockLiveKitEnv() {
  process.env.LIVEKIT_URL = "wss://livekit.example.com";
  process.env.LIVEKIT_API_KEY = "api-key-1";
  process.env.LIVEKIT_API_SECRET = "secret-1";
  process.env.LIVEKIT_MEDIA_TOKEN_TTL_SECONDS = "300";
}

describe("workspace WhatsApp call media token route", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(Date, "now").mockReturnValue(1_770_000_000_000);
    delete process.env.LIVEKIT_URL;
    delete process.env.LIVEKIT_API_KEY;
    delete process.env.LIVEKIT_API_SECRET;
    delete process.env.LIVEKIT_MEDIA_TOKEN_TTL_SECONDS;
    mockConnectDB.mockResolvedValue(undefined);
    mockRequireScenarioWorkspaceAccess.mockResolvedValue({
      ok: true,
      userId: "user-1",
      accessToken: null,
    });
    mockCallSessionFindOne.mockReturnValue({
      select: () => ({
        lean: () => ({
          exec: () =>
            Promise.resolve({
              _id: "session-1",
              workspaceId: "workspace-1",
              callId: "wacid.1",
              state: "active",
            }),
        }),
      }),
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("mints a room-scoped LiveKit token for an active call", async () => {
    mockLiveKitEnv();

    const response = await GET(buildRequest(), buildParams());
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(mockRequireScenarioWorkspaceAccess).toHaveBeenCalledWith(
      "workspace-1"
    );
    expect(mockCallSessionFindOne).toHaveBeenCalledWith({
      _id: "session-1",
      workspaceId: "workspace-1",
    });
    expect(data).toEqual({
      success: true,
      liveKitUrl: "wss://livekit.example.com",
      roomName: expect.stringMatching(/^wa-call-[a-f0-9]{32}$/),
      token: expect.any(String),
      identity: expect.stringMatching(/^wa-participant-[a-f0-9]{32}$/),
      expiresAt: "2026-02-02T02:45:00.000Z",
    });
    expect(data.roomName).not.toContain("wacid");
    expect(data.identity).not.toContain("user-1");
  });

  it("returns 503 when LiveKit calling is not configured", async () => {
    const response = await GET(buildRequest(), buildParams());

    await expect(response.json()).resolves.toEqual({
      error: "WhatsApp call media is not configured",
    });
    expect(response.status).toBe(503);
    expect(mockConnectDB).not.toHaveBeenCalled();
  });

  it("rejects terminal call sessions", async () => {
    mockLiveKitEnv();
    mockCallSessionFindOne.mockReturnValueOnce({
      select: () => ({
        lean: () => ({
          exec: () =>
            Promise.resolve({
              _id: "session-1",
              workspaceId: "workspace-1",
              callId: "wacid.1",
              state: "terminated",
            }),
        }),
      }),
    });

    const response = await GET(buildRequest(), buildParams());

    await expect(response.json()).resolves.toEqual({
      error: "Call session has ended",
    });
    expect(response.status).toBe(409);
  });

  it("returns the workspace access response when authorization fails", async () => {
    mockRequireScenarioWorkspaceAccess.mockResolvedValueOnce({
      ok: false,
      response: Response.json({ error: "Unauthorized" }, { status: 401 }),
    });
    mockLiveKitEnv();

    const response = await GET(buildRequest(), buildParams());

    await expect(response.json()).resolves.toEqual({ error: "Unauthorized" });
    expect(response.status).toBe(401);
    expect(mockConnectDB).not.toHaveBeenCalled();
  });
});
