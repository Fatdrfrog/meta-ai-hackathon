import type { MessageDTO } from "@icecore/shared/types/message";
import {
  buildRealtimeChannelName,
  isRealtimeEventEnvelope,
  planRealtimeCandidateAckDeadline,
  planRealtimeRotationRetry,
  planRealtimeTokenRefresh,
  type RealtimeEventEnvelope,
} from "@icecore/shared/types/realtime";

export interface AiriTypingEvent {
  started?: boolean;
  debouncing?: boolean;
  cooldown?: boolean;
}

export interface AiriThinkingEvent {
  reasoning: string;
  phase?: string;
}

type TokenResponse = {
  token: string;
  url: string;
  expiresAt?: string;
};

type SubscribeParams = {
  workspaceId: string;
  conversationId: string;
  getToken: () => Promise<TokenResponse>;
  onNewMessage: (message: MessageDTO) => void;
  onHydrate?: () => void;
  onAiriTyping?: (data: AiriTypingEvent) => void;
  onAiriThinking?: (data: AiriThinkingEvent) => void;
  onAiriTypingStop?: () => void;
};

function isRetryableRealtimeError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return true;
  }
  const retryable = (error as { retryable?: unknown }).retryable;
  if (retryable === false) {
    return false;
  }
  const status = (error as { status?: unknown }).status;
  if (
    status === 400 ||
    status === 401 ||
    status === 403 ||
    status === 404 ||
    status === 409
  ) {
    return false;
  }
  return true;
}

function toWebSocketUrl(url: string, token: string): string {
  const socketUrl = new URL(url);
  if (socketUrl.protocol === "https:") {
    socketUrl.protocol = "wss:";
  } else if (socketUrl.protocol === "http:") {
    socketUrl.protocol = "ws:";
  }
  socketUrl.searchParams.set("token", token);
  return socketUrl.toString();
}

function getEventData(event: RealtimeEventEnvelope): Record<string, unknown> {
  const payload = event.payload as Record<string, unknown>;
  const data = payload.data;
  return data && typeof data === "object"
    ? (data as Record<string, unknown>)
    : payload;
}

function toMessageDto(data: Record<string, unknown>): MessageDTO | null {
  const rawId = data.id || data._id || data.messageId;
  const rawConversationId = data.conversationId;
  if (typeof rawId !== "string" || typeof rawConversationId !== "string") {
    return null;
  }

  return {
    id: rawId,
    conversationId: rawConversationId,
    text: typeof data.text === "string" ? data.text : "",
    direction: data.direction === "outbound" ? "outbound" : "inbound",
    timestamp:
      typeof data.timestamp === "string"
        ? data.timestamp
        : typeof data.date === "string"
          ? data.date
          : new Date().toISOString(),
    authorName:
      typeof data.authorName === "string" ? data.authorName : undefined,
    authorAvatar:
      typeof data.authorAvatar === "string" ? data.authorAvatar : undefined,
    imageUrl: typeof data.imageUrl === "string" ? data.imageUrl : undefined,
    mediaUrl: typeof data.mediaUrl === "string" ? data.mediaUrl : undefined,
    mediaType:
      typeof data.mediaType === "string"
        ? (data.mediaType as MessageDTO["mediaType"])
        : null,
    mimeType: typeof data.mimeType === "string" ? data.mimeType : null,
    fileName: typeof data.fileName === "string" ? data.fileName : null,
    fileSize: typeof data.fileSize === "number" ? data.fileSize : null,
    audioAnalysis:
      typeof data.audioAnalysis === "string" ? data.audioAnalysis : null,
    actionType:
      data.actionType === "csat_request"
        ? "csat_request"
        : ((data.actionType as null | undefined) ?? null),
  };
}

function handleRealtimeEvent(
  event: RealtimeEventEnvelope,
  params: SubscribeParams,
) {
  const data = getEventData(event);

  if (event.name === "conversation.message.created") {
    const message = toMessageDto(data);
    if (message) {
      params.onNewMessage(message);
    } else {
      params.onHydrate?.();
    }
    return;
  }

  if (event.name === "conversation.message.updated") {
    params.onHydrate?.();
    return;
  }

  if (event.name === "conversation.row.changed") {
    params.onHydrate?.();
    return;
  }

  if (event.name === "widget.csat.changed") {
    params.onHydrate?.();
    return;
  }

  if (event.name === "airi.typing") {
    if (data.started === false) {
      params.onAiriTypingStop?.();
      return;
    }
    if (typeof data.reasoning === "string") {
      params.onAiriThinking?.({
        reasoning: data.reasoning,
        phase: typeof data.phase === "string" ? data.phase : undefined,
      });
    }
    params.onAiriTyping?.(data as AiriTypingEvent);
  }
}

export function subscribeToConversation(
  params: SubscribeParams,
): (() => void) | null {
  if (!params.workspaceId || !params.conversationId) {
    console.warn("Airi.chat Widget: Cannot subscribe without realtime scope");
    return null;
  }

  let disposed = false;
  type RotationAttempt = Readonly<{
    replacementIntent: boolean;
    priorActiveExpiryMs: number | null;
    generation: number;
  }>;
  type WidgetConnection = {
    socket: WebSocket;
    effectiveExpiresAt: string | null;
    ready: boolean;
    acknowledged: boolean;
    retired: boolean;
    rotationAttempt: RotationAttempt;
    expiryTimer: ReturnType<typeof setTimeout> | null;
    candidateAckTimer: ReturnType<typeof setTimeout> | null;
  };
  let activeSocket: WidgetConnection | null = null;
  let candidateSocket: WidgetConnection | null = null;
  let pendingTokenLoad: RotationAttempt | null = null;
  let reconnectTimer: {
    handle: ReturnType<typeof setTimeout>;
    rotationAttempt: RotationAttempt;
  } | null = null;
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectAttempt = 0;
  let rotationGeneration = 0;
  const channel = buildRealtimeChannelName({
    kind: "conversation",
    workspaceId: params.workspaceId,
    conversationId: params.conversationId,
  });

  const clearReconnectTimer = () => {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer.handle);
      reconnectTimer = null;
    }
  };

  const clearRefreshTimer = () => {
    if (refreshTimer) {
      clearTimeout(refreshTimer);
      refreshTimer = null;
    }
  };

  const closeConnection = (connection: WidgetConnection | null) => {
    if (!connection || connection.retired) return;
    connection.retired = true;
    if (connection.expiryTimer) {
      clearTimeout(connection.expiryTimer);
      connection.expiryTimer = null;
    }
    if (connection.candidateAckTimer) {
      clearTimeout(connection.candidateAckTimer);
      connection.candidateAckTimer = null;
    }
    if (connection.socket.readyState < WebSocket.CLOSING) {
      connection.socket.close();
    }
  };

  const createRotationAttempt = (): RotationAttempt => {
    const priorActiveExpiryMs = activeSocket?.effectiveExpiresAt
      ? Date.parse(activeSocket.effectiveExpiresAt)
      : Number.NaN;
    rotationGeneration += 1;
    return {
      replacementIntent: activeSocket !== null,
      priorActiveExpiryMs: Number.isFinite(priorActiveExpiryMs)
        ? priorActiveExpiryMs
        : null,
      generation: rotationGeneration,
    };
  };

  const scheduleReconnect = (rotationAttempt: RotationAttempt) => {
    if (disposed || reconnectTimer || candidateSocket || pendingTokenLoad) {
      return;
    }
    if (rotationAttempt.generation !== rotationGeneration) return;
    let delay: number;
    if (
      rotationAttempt.replacementIntent &&
      rotationAttempt.priorActiveExpiryMs !== null
    ) {
      const activeExpiresAt = new Date(
        rotationAttempt.priorActiveExpiryMs,
      ).toISOString();
      const retry = planRealtimeRotationRetry(
        activeExpiresAt,
        Date.now(),
        Math.random(),
      );
      if (retry.kind === "invalid") {
        if (activeSocket) return;
        reconnectAttempt = 0;
        scheduleReconnect(createRotationAttempt());
        return;
      }
      delay = retry.delayMs;
    } else {
      delay = Math.min(1000 * 2 ** reconnectAttempt, 15000);
      reconnectAttempt += 1;
    }
    const handle = setTimeout(() => {
      if (reconnectTimer?.handle !== handle) return;
      reconnectTimer = null;
      if (disposed || rotationAttempt.generation !== rotationGeneration) {
        return;
      }
      void connect(rotationAttempt);
    }, delay);
    reconnectTimer = { handle, rotationAttempt };
  };

  const scheduleRetryAfterConnectionLoss = (
    connection: WidgetConnection,
    wasCandidate: boolean,
  ) => {
    if (wasCandidate) {
      scheduleReconnect(connection.rotationAttempt);
      return;
    }
    if (reconnectTimer || pendingTokenLoad || candidateSocket) return;
    scheduleReconnect(createRotationAttempt());
  };

  const scheduleCandidateAckDeadline = (connection: WidgetConnection) => {
    if (connection.candidateAckTimer) {
      clearTimeout(connection.candidateAckTimer);
      connection.candidateAckTimer = null;
    }
    if (
      !connection.rotationAttempt.replacementIntent ||
      candidateSocket !== connection
    ) {
      return;
    }
    const deadlineExpiryMs = [
      activeSocket?.effectiveExpiresAt
        ? Date.parse(activeSocket.effectiveExpiresAt)
        : null,
      connection.rotationAttempt.priorActiveExpiryMs,
      connection.effectiveExpiresAt
        ? Date.parse(connection.effectiveExpiresAt)
        : null,
    ].reduce<number | null>((earliest, expiresAtMs) => {
      if (expiresAtMs === null || !Number.isFinite(expiresAtMs)) {
        return earliest;
      }
      if (earliest === null || expiresAtMs < earliest) {
        return expiresAtMs;
      }
      return earliest;
    }, null);
    if (deadlineExpiryMs === null) return;
    const deadline = planRealtimeCandidateAckDeadline(
      new Date(deadlineExpiryMs).toISOString(),
      Date.now(),
    );
    if (deadline.kind === "invalid") return;
    connection.candidateAckTimer = setTimeout(() => {
      connection.candidateAckTimer = null;
      if (
        disposed ||
        connection.retired ||
        candidateSocket !== connection ||
        connection.rotationAttempt.generation !== rotationGeneration
      ) {
        return;
      }
      candidateSocket = null;
      closeConnection(connection);
      scheduleReconnect(connection.rotationAttempt);
    }, deadline.delayMs);
  };

  const scheduleExpiry = (connection: WidgetConnection) => {
    if (connection.expiryTimer) clearTimeout(connection.expiryTimer);
    if (!connection.effectiveExpiresAt) return;
    const delayMs = Date.parse(connection.effectiveExpiresAt) - Date.now();
    if (!Number.isFinite(delayMs) || delayMs <= 0) {
      const wasCandidate = candidateSocket === connection;
      if (activeSocket === connection) {
        activeSocket = null;
        clearRefreshTimer();
      }
      if (candidateSocket === connection) candidateSocket = null;
      closeConnection(connection);
      scheduleRetryAfterConnectionLoss(connection, wasCandidate);
      return;
    }
    connection.expiryTimer = setTimeout(() => {
      connection.expiryTimer = null;
      if (disposed || connection.retired) return;
      const wasCandidate = candidateSocket === connection;
      if (activeSocket === connection) {
        activeSocket = null;
        clearRefreshTimer();
      }
      if (candidateSocket === connection) candidateSocket = null;
      closeConnection(connection);
      scheduleRetryAfterConnectionLoss(connection, wasCandidate);
    }, delayMs);
  };

  const scheduleRefresh = (connection: WidgetConnection) => {
    clearRefreshTimer();
    if (
      disposed ||
      connection.retired ||
      activeSocket !== connection ||
      !connection.effectiveExpiresAt
    ) {
      return;
    }
    const refresh = planRealtimeTokenRefresh(
      connection.effectiveExpiresAt,
      Date.now(),
    );
    if (refresh.kind === "invalid") return;
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      if (
        disposed ||
        connection.retired ||
        activeSocket !== connection ||
        candidateSocket
      ) {
        return;
      }
      void connect();
    }, refresh.delayMs);
  };

  const promoteIfReady = (connection: WidgetConnection) => {
    if (
      disposed ||
      connection.retired ||
      candidateSocket !== connection ||
      connection.rotationAttempt.generation !== rotationGeneration ||
      !connection.ready ||
      !connection.acknowledged
    ) {
      return;
    }
    const previous = activeSocket;
    clearReconnectTimer();
    if (connection.candidateAckTimer) {
      clearTimeout(connection.candidateAckTimer);
      connection.candidateAckTimer = null;
    }
    candidateSocket = null;
    activeSocket = connection;
    rotationGeneration += 1;
    reconnectAttempt = 0;
    scheduleRefresh(connection);
    if (previous) closeConnection(previous);
  };

  async function connect(rotationAttempt?: RotationAttempt): Promise<void> {
    if (disposed) return;
    if (candidateSocket) return;
    if (pendingTokenLoad) return;
    const loadOwner = rotationAttempt ?? createRotationAttempt();
    if (loadOwner.generation !== rotationGeneration) return;
    pendingTokenLoad = loadOwner;
    try {
      const token = await params.getToken();
      if (pendingTokenLoad !== loadOwner) return;
      if (disposed || candidateSocket) {
        pendingTokenLoad = null;
        return;
      }
      const tokenRefresh = planRealtimeTokenRefresh(
        token.expiresAt,
        Date.now(),
      );
      const connection: WidgetConnection = {
        socket: new WebSocket(toWebSocketUrl(token.url, token.token)),
        effectiveExpiresAt:
          tokenRefresh.kind === "scheduled" ? token.expiresAt! : null,
        ready: false,
        acknowledged: false,
        retired: false,
        rotationAttempt: loadOwner,
        expiryTimer: null,
        candidateAckTimer: null,
      };
      candidateSocket = connection;
      pendingTokenLoad = null;
      scheduleExpiry(connection);
      scheduleCandidateAckDeadline(connection);
      connection.socket.onopen = () => {
        if (disposed || connection.retired) return;
        reconnectAttempt = 0;
        connection.socket.send(
          JSON.stringify({ type: "subscribe", channels: [channel] }),
        );
      };
      connection.socket.onmessage = (message) => {
        if (disposed || connection.retired) return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(String(message.data));
        } catch {
          return;
        }
        if (!parsed || typeof parsed !== "object") return;
        const frame = parsed as {
          type?: unknown;
          channel?: unknown;
          expiresAt?: unknown;
          channels?: unknown;
          event?: unknown;
        };
        if (frame.type === "ready" && typeof frame.expiresAt === "string") {
          const readyRefresh = planRealtimeTokenRefresh(
            frame.expiresAt,
            Date.now(),
          );
          if (readyRefresh.kind === "invalid") return;
          if (
            !connection.effectiveExpiresAt ||
            Date.parse(frame.expiresAt) <
              Date.parse(connection.effectiveExpiresAt)
          ) {
            connection.effectiveExpiresAt = frame.expiresAt;
            scheduleExpiry(connection);
          }
          connection.ready = true;
          if (candidateSocket === connection) {
            scheduleCandidateAckDeadline(connection);
          }
          if (activeSocket === connection) {
            scheduleRefresh(connection);
            if (candidateSocket) {
              scheduleCandidateAckDeadline(candidateSocket);
            }
          }
          promoteIfReady(connection);
          return;
        }
        if (frame.type === "subscribed" && Array.isArray(frame.channels)) {
          connection.acknowledged =
            frame.channels.length === 1 && frame.channels[0] === channel;
          promoteIfReady(connection);
          return;
        }
        if (
          frame.type !== "event" ||
          frame.channel !== channel ||
          activeSocket !== connection
        ) {
          return;
        }
        const event = frame.event;
        if (connection.acknowledged && isRealtimeEventEnvelope(event)) {
          handleRealtimeEvent(event, params);
        }
      };
      connection.socket.onclose = () => {
        if (disposed || connection.retired) return;
        connection.retired = true;
        if (connection.expiryTimer) clearTimeout(connection.expiryTimer);
        if (connection.candidateAckTimer) {
          clearTimeout(connection.candidateAckTimer);
          connection.candidateAckTimer = null;
        }
        const wasCandidate = candidateSocket === connection;
        if (candidateSocket === connection) candidateSocket = null;
        if (activeSocket === connection) {
          activeSocket = null;
          clearRefreshTimer();
        }
        scheduleRetryAfterConnectionLoss(connection, wasCandidate);
      };
      connection.socket.onerror = () => {
        if (connection.socket.readyState < WebSocket.CLOSING) {
          connection.socket.close();
        }
      };
    } catch (error) {
      if (pendingTokenLoad !== loadOwner) return;
      if (pendingTokenLoad === loadOwner) pendingTokenLoad = null;
      if (disposed) return;
      console.error("Airi.chat Widget: Realtime connection failed", error);
      if (!isRetryableRealtimeError(error)) {
        return;
      }
      scheduleReconnect(loadOwner);
    }
  }

  void connect();

  return () => {
    disposed = true;
    rotationGeneration += 1;
    pendingTokenLoad = null;
    clearReconnectTimer();
    clearRefreshTimer();
    const candidate = candidateSocket;
    const active = activeSocket;
    candidateSocket = null;
    activeSocket = null;
    closeConnection(candidate);
    if (active !== candidate) closeConnection(active);
  };
}
