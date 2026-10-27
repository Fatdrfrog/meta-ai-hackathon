import { isRecord, readStringField } from "@icecore/shared/lib/value-utils";

type FetchLike = (
  input: string,
  init?: RequestInit
) => Promise<{
  ok: boolean;
  status?: number;
  json: () => Promise<unknown>;
}>;

type LiveKitEventValue = string | symbol;
type LiveKitEventHandler = (...args: unknown[]) => void;

type LiveKitTrackLike = {
  kind?: string;
  attach?: () => HTMLElement | null | undefined;
  detach?: () => HTMLElement[] | void;
};

type LiveKitTrackPublicationLike = {
  track?: LiveKitTrackLike | null;
};

type LiveKitParticipantLike = {
  getTrackPublications?: () => LiveKitTrackPublicationLike[];
  trackPublications?: Map<unknown, LiveKitTrackPublicationLike>;
};

type LiveKitRoomLike = {
  canPlaybackAudio?: boolean;
  localParticipant: {
    setMicrophoneEnabled: (enabled: boolean) => Promise<unknown> | unknown;
  };
  connect: (url: string, token: string) => Promise<unknown> | unknown;
  disconnect: () => Promise<unknown> | unknown;
  startAudio?: () => Promise<unknown> | unknown;
  on: (
    event: LiveKitEventValue,
    handler: LiveKitEventHandler
  ) => LiveKitRoomLike;
  off: (
    event: LiveKitEventValue,
    handler: LiveKitEventHandler
  ) => LiveKitRoomLike;
  remoteParticipants?: Map<unknown, LiveKitParticipantLike>;
};

export type LiveKitClientModule = {
  Room: new (options?: Record<string, unknown>) => LiveKitRoomLike;
  RoomEvent: Record<string, LiveKitEventValue | undefined>;
  Track: {
    Kind?: {
      Audio?: string;
    };
  };
  MediaDeviceFailure?: {
    getFailure?: (error: unknown) => unknown;
  };
};

export type WhatsAppCallMediaTokenResult =
  | {
      ok: true;
      liveKitUrl: string;
      roomName: string;
      token: string;
      identity: string;
      expiresAt: string;
    }
  | {
      ok: false;
      error: string;
      status?: number | null;
    };

export type WhatsAppCallMediaConnectionState =
  | "connected"
  | "reconnecting"
  | "playback_blocked"
  | "disconnected";

export type WhatsAppCallMediaConnection = {
  roomName: string;
  identity: string;
  expiresAt: string;
  isMicrophoneMuted: () => boolean;
  setMicrophoneMuted: (muted: boolean) => Promise<void>;
  disconnect: () => Promise<void>;
};

export type WhatsAppCallMediaJoinOptions = {
  audioElementHost?: HTMLElement | null;
  fetchImpl?: FetchLike;
  loadLiveKitClient?: () => Promise<LiveKitClientModule>;
  onConnectionStateChange?: (state: WhatsAppCallMediaConnectionState) => void;
  onMicrophoneMutedChange?: (muted: boolean) => void;
};

export type WhatsAppCallMediaJoinResult =
  | {
      ok: true;
      connection: WhatsAppCallMediaConnection;
    }
  | {
      ok: false;
      reason:
        | "token_failed"
        | "client_unavailable"
        | "connection_failed"
        | "permission_denied";
      error: string;
      status?: number | null;
    };

async function defaultLoadLiveKitClient(): Promise<LiveKitClientModule> {
  return import("livekit-client") as Promise<LiveKitClientModule>;
}

function isHTMLElement(value: unknown): value is HTMLElement {
  return typeof HTMLElement !== "undefined" && value instanceof HTMLElement;
}

function isAudioTrack(
  track: LiveKitTrackLike | null | undefined,
  liveKit: LiveKitClientModule
): track is LiveKitTrackLike {
  if (!track) return false;
  const audioKind = liveKit.Track.Kind?.Audio || "audio";
  return track.kind === audioKind || track.kind === "audio";
}

function getPublicationTrack(
  publication: LiveKitTrackPublicationLike
): LiveKitTrackLike | null {
  return publication.track || null;
}

function removeElement(element: HTMLElement) {
  if (element instanceof HTMLMediaElement) {
    element.removeAttribute("src");
    if ("srcObject" in element) {
      (
        element as HTMLMediaElement & {
          srcObject?: MediaStream | null;
        }
      ).srcObject = null;
    }
  }
  element.remove();
}

function attachAudioTrack(input: {
  track: LiveKitTrackLike;
  liveKit: LiveKitClientModule;
  audioElementHost?: HTMLElement | null;
  attachedAudioElements: Map<LiveKitTrackLike, Set<HTMLElement>>;
}) {
  if (!isAudioTrack(input.track, input.liveKit) || !input.track.attach) {
    return;
  }

  const element = input.track.attach();
  if (!isHTMLElement(element)) {
    return;
  }

  if (element instanceof HTMLAudioElement) {
    element.autoplay = true;
    element.controls = false;
  }
  element.setAttribute("data-whatsapp-call-audio", "true");

  if (
    input.audioElementHost &&
    element.parentElement !== input.audioElementHost
  ) {
    input.audioElementHost.appendChild(element);
  }

  const tracked =
    input.attachedAudioElements.get(input.track) || new Set<HTMLElement>();
  tracked.add(element);
  input.attachedAudioElements.set(input.track, tracked);
}

function detachAudioTrack(
  track: LiveKitTrackLike,
  attachedAudioElements: Map<LiveKitTrackLike, Set<HTMLElement>>
) {
  const elements = new Set<HTMLElement>();
  const tracked = attachedAudioElements.get(track);
  if (tracked) {
    for (const element of tracked) {
      elements.add(element);
    }
  }

  const detached = track.detach?.();
  if (Array.isArray(detached)) {
    for (const element of detached) {
      if (isHTMLElement(element)) {
        elements.add(element);
      }
    }
  }

  for (const element of elements) {
    removeElement(element);
  }
  attachedAudioElements.delete(track);
}

function attachExistingAudioTracks(input: {
  room: LiveKitRoomLike;
  liveKit: LiveKitClientModule;
  audioElementHost?: HTMLElement | null;
  attachedAudioElements: Map<LiveKitTrackLike, Set<HTMLElement>>;
}) {
  for (const participant of input.room.remoteParticipants?.values() || []) {
    const publications = participant.getTrackPublications
      ? participant.getTrackPublications()
      : Array.from(participant.trackPublications?.values() || []);
    for (const publication of publications) {
      const track = getPublicationTrack(publication);
      if (!track) continue;
      attachAudioTrack({
        track,
        liveKit: input.liveKit,
        audioElementHost: input.audioElementHost,
        attachedAudioElements: input.attachedAudioElements,
      });
    }
  }
}

function classifyMediaJoinError(
  error: unknown,
  liveKit: LiveKitClientModule
): {
  reason: "connection_failed" | "permission_denied";
  error: string;
} {
  const failure = String(
    liveKit.MediaDeviceFailure?.getFailure?.(error) || ""
  ).toLowerCase();
  const errorName =
    error && typeof error === "object" && "name" in error
      ? String((error as { name?: unknown }).name || "").toLowerCase()
      : "";

  if (
    failure.includes("permission") ||
    failure.includes("denied") ||
    errorName.includes("notallowed") ||
    errorName.includes("permissiondenied")
  ) {
    return {
      reason: "permission_denied",
      error: "microphone_permission_denied",
    };
  }

  if (failure.includes("notfound") || errorName.includes("notfound")) {
    return {
      reason: "connection_failed",
      error: "microphone_not_found",
    };
  }

  if (failure.includes("inuse") || errorName.includes("notreadable")) {
    return {
      reason: "connection_failed",
      error: "microphone_unavailable",
    };
  }

  return {
    reason: "connection_failed",
    error:
      error instanceof Error && error.message
        ? error.message
        : "browser_media_connection_failed",
  };
}

export async function requestWhatsAppCallMediaToken(input: {
  workspaceId: string;
  callSessionId: string;
  fetchImpl?: FetchLike;
}): Promise<WhatsAppCallMediaTokenResult> {
  const fetchImpl = input.fetchImpl || fetch;
  const response = await fetchImpl(
    `/api/workspaces/${encodeURIComponent(
      input.workspaceId
    )}/whatsapp/calls/${encodeURIComponent(input.callSessionId)}/media-token`,
    { method: "GET" }
  );
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    return {
      ok: false,
      error: isRecord(payload) ? readStringField(payload, "error") : "",
      status: "status" in response ? Number(response.status) : null,
    };
  }

  if (!isRecord(payload)) {
    return { ok: false, error: "invalid_media_token_response" };
  }

  const liveKitUrl = readStringField(payload, "liveKitUrl");
  const roomName = readStringField(payload, "roomName");
  const token = readStringField(payload, "token");
  const identity = readStringField(payload, "identity");
  const expiresAt = readStringField(payload, "expiresAt");
  if (!liveKitUrl || !roomName || !token || !identity || !expiresAt) {
    return { ok: false, error: "invalid_media_token_response" };
  }

  return {
    ok: true,
    liveKitUrl,
    roomName,
    token,
    identity,
    expiresAt,
  };
}

export async function joinWhatsAppCallMedia(
  input: {
    workspaceId: string;
    callSessionId: string;
  } & WhatsAppCallMediaJoinOptions
): Promise<WhatsAppCallMediaJoinResult> {
  const token = await requestWhatsAppCallMediaToken({
    workspaceId: input.workspaceId,
    callSessionId: input.callSessionId,
    fetchImpl: input.fetchImpl,
  });
  if (!token.ok) {
    return {
      ok: false,
      reason: "token_failed",
      error: token.error,
      status: token.status,
    };
  }

  let liveKit: LiveKitClientModule;
  try {
    liveKit = await (input.loadLiveKitClient || defaultLoadLiveKitClient)();
  } catch {
    return {
      ok: false,
      reason: "client_unavailable",
      error: "browser_media_client_unavailable",
    };
  }

  const room = new liveKit.Room();
  const listeners: Array<{
    event: LiveKitEventValue;
    handler: LiveKitEventHandler;
  }> = [];
  const attachedAudioElements = new Map<LiveKitTrackLike, Set<HTMLElement>>();
  let disconnected = false;
  let microphoneMuted = false;

  const emitConnectionState = (state: WhatsAppCallMediaConnectionState) => {
    input.onConnectionStateChange?.(state);
  };

  const removeListeners = () => {
    for (const listener of listeners.splice(0)) {
      room.off(listener.event, listener.handler);
    }
  };

  const cleanupAudio = () => {
    for (const track of Array.from(attachedAudioElements.keys())) {
      detachAudioTrack(track, attachedAudioElements);
    }
  };

  const cleanup = async (options?: {
    disconnectRoom?: boolean;
    emitDisconnected?: boolean;
  }) => {
    if (disconnected) return;
    disconnected = true;
    removeListeners();
    cleanupAudio();
    if (options?.disconnectRoom !== false) {
      await Promise.resolve(room.disconnect()).catch(() => undefined);
    }
    if (options?.emitDisconnected !== false) {
      emitConnectionState("disconnected");
    }
  };

  const addListener = (eventName: string, handler: LiveKitEventHandler) => {
    const event = liveKit.RoomEvent[eventName];
    if (!event) return;
    room.on(event, handler);
    listeners.push({ event, handler });
  };

  addListener("TrackSubscribed", track => {
    attachAudioTrack({
      track: track as LiveKitTrackLike,
      liveKit,
      audioElementHost: input.audioElementHost,
      attachedAudioElements,
    });
  });
  addListener("TrackUnsubscribed", track => {
    detachAudioTrack(track as LiveKitTrackLike, attachedAudioElements);
  });
  addListener("Reconnecting", () => {
    emitConnectionState("reconnecting");
  });
  addListener("Reconnected", () => {
    emitConnectionState(
      room.canPlaybackAudio === false ? "playback_blocked" : "connected"
    );
  });
  addListener("AudioPlaybackStatusChanged", () => {
    emitConnectionState(
      room.canPlaybackAudio === false ? "playback_blocked" : "connected"
    );
  });
  addListener("Disconnected", () => {
    void cleanup({ disconnectRoom: false });
  });

  try {
    await Promise.resolve(room.connect(token.liveKitUrl, token.token));
    attachExistingAudioTracks({
      room,
      liveKit,
      audioElementHost: input.audioElementHost,
      attachedAudioElements,
    });

    let playbackBlocked = false;
    if (room.startAudio) {
      try {
        await Promise.resolve(room.startAudio());
      } catch {
        playbackBlocked = true;
      }
    }

    await Promise.resolve(room.localParticipant.setMicrophoneEnabled(true));
    microphoneMuted = false;
    input.onMicrophoneMutedChange?.(false);
    emitConnectionState(
      playbackBlocked || room.canPlaybackAudio === false
        ? "playback_blocked"
        : "connected"
    );

    const connection: WhatsAppCallMediaConnection = {
      roomName: token.roomName,
      identity: token.identity,
      expiresAt: token.expiresAt,
      isMicrophoneMuted: () => microphoneMuted,
      setMicrophoneMuted: async muted => {
        if (disconnected) return;
        await Promise.resolve(
          room.localParticipant.setMicrophoneEnabled(!muted)
        );
        microphoneMuted = muted;
        input.onMicrophoneMutedChange?.(muted);
      },
      disconnect: async () => {
        await cleanup();
      },
    };

    return {
      ok: true,
      connection,
    };
  } catch (error) {
    const classified = classifyMediaJoinError(error, liveKit);
    await cleanup({ emitDisconnected: false });
    return {
      ok: false,
      reason: classified.reason,
      error: classified.error,
    };
  }
}
