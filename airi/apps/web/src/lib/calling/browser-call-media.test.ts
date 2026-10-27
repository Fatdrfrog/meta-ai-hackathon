/**
 * @jest-environment jsdom
 */

import {
  type LiveKitClientModule,
  joinWhatsAppCallMedia,
  requestWhatsAppCallMediaToken,
} from "./browser-call-media";

type FakeHandler = (...args: unknown[]) => void;

class FakeAudioTrack {
  kind = "audio";
  element = document.createElement("audio");
  attach = jest.fn(() => this.element);
  detach = jest.fn(() => [this.element]);
}

class FakeRoom {
  static instances: FakeRoom[] = [];

  canPlaybackAudio = true;
  localParticipant = {
    setMicrophoneEnabled: jest.fn(async () => undefined),
  };
  remoteParticipants = new Map();
  connect = jest.fn(async () => undefined);
  disconnect = jest.fn(async () => undefined);
  startAudio = jest.fn(async () => undefined);
  on = jest.fn((event: string | symbol, handler: FakeHandler) => {
    const existing = this.handlers.get(event) || new Set<FakeHandler>();
    existing.add(handler);
    this.handlers.set(event, existing);
    return this;
  });
  off = jest.fn((event: string | symbol, handler: FakeHandler) => {
    this.handlers.get(event)?.delete(handler);
    return this;
  });
  private handlers = new Map<string | symbol, Set<FakeHandler>>();

  constructor() {
    FakeRoom.instances.push(this);
  }

  emit(event: string, ...args: unknown[]) {
    for (const handler of this.handlers.get(event) || []) {
      handler(...args);
    }
  }
}

function createLiveKitModule(Room = FakeRoom): LiveKitClientModule {
  return {
    Room: Room as unknown as LiveKitClientModule["Room"],
    RoomEvent: {
      AudioPlaybackStatusChanged: "AudioPlaybackStatusChanged",
      Disconnected: "Disconnected",
      Reconnected: "Reconnected",
      Reconnecting: "Reconnecting",
      TrackSubscribed: "TrackSubscribed",
      TrackUnsubscribed: "TrackUnsubscribed",
    },
    Track: {
      Kind: {
        Audio: "audio",
      },
    },
    MediaDeviceFailure: {
      getFailure: jest.fn(),
    },
  };
}

describe("browser WhatsApp call media helpers", () => {
  beforeEach(() => {
    FakeRoom.instances = [];
  });

  it("requests a room-scoped media token for a call session", async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        liveKitUrl: "wss://livekit.example.com",
        roomName: "wa-call-room",
        token: "agent-token",
        identity: "wa-participant-1",
        expiresAt: "2026-02-02T02:45:00.000Z",
      }),
    });

    const result = await requestWhatsAppCallMediaToken({
      workspaceId: "workspace/1",
      callSessionId: "session/1",
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      "/api/workspaces/workspace%2F1/whatsapp/calls/session%2F1/media-token",
      expect.objectContaining({ method: "GET" })
    );
    expect(result).toEqual({
      ok: true,
      liveKitUrl: "wss://livekit.example.com",
      roomName: "wa-call-room",
      token: "agent-token",
      identity: "wa-participant-1",
      expiresAt: "2026-02-02T02:45:00.000Z",
    });
  });

  it("connects to LiveKit, publishes the mic, attaches remote audio, and cleans up", async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        liveKitUrl: "wss://livekit.example.com",
        roomName: "wa-call-room",
        token: "agent-token",
        identity: "wa-participant-1",
        expiresAt: "2026-02-02T02:45:00.000Z",
      }),
    });
    const host = document.createElement("div");
    const loadLiveKitClient = jest.fn(async () => createLiveKitModule());
    const connectionStates: string[] = [];
    const muteStates: boolean[] = [];

    const result = await joinWhatsAppCallMedia({
      workspaceId: "workspace-1",
      callSessionId: "session-1",
      fetchImpl,
      audioElementHost: host,
      loadLiveKitClient,
      onConnectionStateChange: state => connectionStates.push(state),
      onMicrophoneMutedChange: muted => muteStates.push(muted),
    });

    expect(result.ok).toBe(true);
    expect(loadLiveKitClient).toHaveBeenCalledTimes(1);
    const room = FakeRoom.instances[0];
    expect(room.connect).toHaveBeenCalledWith(
      "wss://livekit.example.com",
      "agent-token"
    );
    expect(room.startAudio).toHaveBeenCalledTimes(1);
    expect(room.localParticipant.setMicrophoneEnabled).toHaveBeenCalledWith(
      true
    );
    expect(connectionStates).toContain("connected");
    expect(muteStates).toEqual([false]);

    const track = new FakeAudioTrack();
    room.emit("TrackSubscribed", track);
    expect(track.attach).toHaveBeenCalledTimes(1);
    expect(host.querySelectorAll("audio")).toHaveLength(1);

    room.emit("TrackUnsubscribed", track);
    expect(track.detach).toHaveBeenCalledTimes(1);
    expect(host.querySelectorAll("audio")).toHaveLength(0);

    if (!result.ok) throw new Error("expected LiveKit connection");
    await result.connection.setMicrophoneMuted(true);
    await result.connection.setMicrophoneMuted(false);
    expect(room.localParticipant.setMicrophoneEnabled).toHaveBeenNthCalledWith(
      2,
      false
    );
    expect(room.localParticipant.setMicrophoneEnabled).toHaveBeenNthCalledWith(
      3,
      true
    );
    expect(muteStates).toEqual([false, true, false]);

    await result.connection.disconnect();
    expect(room.disconnect).toHaveBeenCalledTimes(1);
    expect(room.off).toHaveBeenCalled();
    expect(connectionStates.at(-1)).toBe("disconnected");
  });

  it("does not load LiveKit when the media token request fails", async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({
        error: "livekit_not_configured",
      }),
    });
    const loadLiveKitClient = jest.fn(async () => createLiveKitModule());

    const result = await joinWhatsAppCallMedia({
      workspaceId: "workspace-1",
      callSessionId: "session-1",
      fetchImpl,
      loadLiveKitClient,
    });

    expect(result).toEqual({
      ok: false,
      reason: "token_failed",
      error: "livekit_not_configured",
      status: 503,
    });
    expect(loadLiveKitClient).not.toHaveBeenCalled();
  });

  it("disconnects the room and reports permission denial when mic publish fails", async () => {
    class PermissionDeniedRoom extends FakeRoom {
      override localParticipant = {
        setMicrophoneEnabled: jest.fn(async () => {
          throw Object.assign(new Error("denied"), {
            name: "NotAllowedError",
          });
        }),
      };
    }
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        liveKitUrl: "wss://livekit.example.com",
        roomName: "wa-call-room",
        token: "agent-token",
        identity: "wa-participant-1",
        expiresAt: "2026-02-02T02:45:00.000Z",
      }),
    });

    const result = await joinWhatsAppCallMedia({
      workspaceId: "workspace-1",
      callSessionId: "session-1",
      fetchImpl,
      loadLiveKitClient: async () => createLiveKitModule(PermissionDeniedRoom),
    });

    expect(result).toEqual({
      ok: false,
      reason: "permission_denied",
      error: "microphone_permission_denied",
    });
    expect(FakeRoom.instances[0].disconnect).toHaveBeenCalledTimes(1);
  });
});
