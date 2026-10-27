import {
  buildRealtimeChannelName,
  isRealtimeChannelName,
  isRealtimeEventEnvelope,
  planRealtimeCandidateAckDeadline,
  planRealtimeRotationRetry,
  planRealtimeTokenRefresh,
  type RealtimeEventEnvelope,
  type RealtimeScope,
} from "@icecore/shared/types/realtime";

export const MOBILE_REALTIME_SCOPE_ERROR = "Invalid mobile realtime scope";

export type MobileRealtimeSubscriptionPlan = Readonly<{
  scope: RealtimeScope;
  channelName: string;
  tokenPath: string;
}>;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Object.values(Object.getOwnPropertyDescriptors(value)).every(
    (descriptor) =>
      "value" in descriptor &&
      typeof descriptor.get !== "function" &&
      typeof descriptor.set !== "function",
  );
}

function parseScopeIdentifier(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.trim() !== value
  ) {
    throw new Error(MOBILE_REALTIME_SCOPE_ERROR);
  }
  return value;
}

function createMobileRealtimeTokenParams(
  scope: RealtimeScope,
): URLSearchParams {
  const params = new URLSearchParams({ workspaceId: scope.workspaceId });
  if (scope.kind === "conversation") {
    params.set("conversationId", scope.conversationId);
  }
  return params;
}

export function planMobileRealtimeSubscription(
  scope: unknown,
): MobileRealtimeSubscriptionPlan {
  if (!isPlainRecord(scope)) throw new Error(MOBILE_REALTIME_SCOPE_ERROR);
  const workspaceId = parseScopeIdentifier(scope.workspaceId);
  let parsedScope: RealtimeScope;
  if (scope.kind === "workspace" && Object.keys(scope).length === 2) {
    parsedScope = { kind: "workspace", workspaceId };
  } else if (scope.kind === "conversation" && Object.keys(scope).length === 3) {
    parsedScope = {
      kind: "conversation",
      workspaceId,
      conversationId: parseScopeIdentifier(scope.conversationId),
    };
  } else {
    throw new Error(MOBILE_REALTIME_SCOPE_ERROR);
  }
  const channelName = buildRealtimeChannelName(parsedScope);
  if (!isRealtimeChannelName(channelName)) {
    throw new Error(MOBILE_REALTIME_SCOPE_ERROR);
  }
  return Object.freeze({
    scope: Object.freeze(parsedScope),
    channelName,
    tokenPath: `/api/realtime/token?${createMobileRealtimeTokenParams(parsedScope).toString()}`,
  });
}

type RealtimeUnsubscribe = () => Promise<void>;

type SubscribeParams = {
  scope: RealtimeScope;
  accessToken?: string | null;
  onEvent: (
    eventName: RealtimeEventEnvelope["name"],
    event: RealtimeEventEnvelope,
  ) => void;
};

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

async function getRealtimeToken(
  scope: RealtimeScope,
  accessToken?: string | null,
  signal?: AbortSignal,
) {
  const { mobileConfig } = await import("./config");
  const params = createMobileRealtimeTokenParams(scope);

  const response = await fetch(
    `${mobileConfig.apiBaseUrl}/api/realtime/token?${params.toString()}`,
    {
      headers: accessToken
        ? { Authorization: `Bearer ${accessToken}` }
        : undefined,
      signal,
    },
  );
  const data = await response.json();
  if (!response.ok || !data.token || !data.url) {
    throw new Error(data.error || "Failed to create realtime token");
  }
  return data as { token: string; url: string; expiresAt?: string };
}

export async function subscribeToRealtimeScope({
  scope,
  accessToken,
  onEvent,
}: SubscribeParams): Promise<RealtimeUnsubscribe> {
  const plan = planMobileRealtimeSubscription(scope);
  let disposed = false;
  type MobileRotationAttempt = Readonly<{
    replacementIntent: boolean;
    priorActiveExpiryMs: number | null;
    generation: number;
  }>;
  type MobileConnection = {
    socket: WebSocket;
    effectiveExpiresAt: string;
    ready: boolean;
    acknowledged: boolean;
    retired: boolean;
    rotationAttempt: MobileRotationAttempt;
    expiryTimer: ReturnType<typeof setTimeout> | null;
    candidateAckTimer: ReturnType<typeof setTimeout> | null;
  };
  type MobileTokenLoadAttempt = {
    rotationAttempt: MobileRotationAttempt;
    abortController: AbortController;
  };
  let activeSocket: MobileConnection | null = null;
  let candidateSocket: MobileConnection | null = null;
  let tokenLoadAttempt: MobileTokenLoadAttempt | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectRotationAttempt: MobileRotationAttempt | null = null;
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectAttempt = 0;
  let nextRotationGeneration = 1;
  const channelName = plan.channelName;

  const connectionExpiryMs = (connection: MobileConnection | null) => {
    if (!connection) return null;
    const expiresAtMs = Date.parse(connection.effectiveExpiresAt);
    return Number.isFinite(expiresAtMs) ? expiresAtMs : null;
  };

  const createRotationAttempt = (
    priorActive: MobileConnection | null,
  ): MobileRotationAttempt =>
    Object.freeze({
      replacementIntent: priorActive !== null,
      priorActiveExpiryMs: connectionExpiryMs(priorActive),
      generation: nextRotationGeneration++,
    });

  const earliestRotationExpiryMs = (
    rotationAttempt: MobileRotationAttempt,
    connection?: MobileConnection | null,
  ) => {
    const expiries = [
      rotationAttempt.priorActiveExpiryMs,
      connectionExpiryMs(activeSocket),
      connectionExpiryMs(connection ?? null),
    ].filter((expiresAtMs): expiresAtMs is number => expiresAtMs !== null);
    return expiries.length > 0 ? Math.min(...expiries) : null;
  };

  const clearReconnectTimer = () => {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    reconnectRotationAttempt = null;
  };

  const clearRefreshTimer = () => {
    if (refreshTimer) {
      clearTimeout(refreshTimer);
      refreshTimer = null;
    }
  };

  const closeConnection = (connection: MobileConnection | null) => {
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

  const scheduleReconnect = (rotationAttempt: MobileRotationAttempt) => {
    if (disposed || reconnectTimer || candidateSocket || tokenLoadAttempt) {
      return;
    }
    let reconnectOwner = rotationAttempt;
    let delay: number;
    const retryExpiresAtMs = earliestRotationExpiryMs(rotationAttempt);
    if (rotationAttempt.replacementIntent && retryExpiresAtMs !== null) {
      const retry = planRealtimeRotationRetry(
        new Date(retryExpiresAtMs).toISOString(),
        Date.now(),
        Math.random(),
      );
      if (retry.kind === "scheduled") {
        delay = retry.delayMs;
      } else {
        if (activeSocket) return;
        reconnectOwner = createRotationAttempt(null);
        delay = Math.min(1000 * 2 ** reconnectAttempt, 15000);
        reconnectAttempt += 1;
      }
    } else {
      delay = Math.min(1000 * 2 ** reconnectAttempt, 15000);
      reconnectAttempt += 1;
    }
    reconnectRotationAttempt = reconnectOwner;
    reconnectTimer = setTimeout(() => {
      if (reconnectRotationAttempt?.generation !== reconnectOwner.generation) {
        return;
      }
      reconnectTimer = null;
      reconnectRotationAttempt = null;
      void connect(reconnectOwner);
    }, delay);
  };

  const scheduleCandidateAckDeadline = (connection: MobileConnection) => {
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
    const deadlineExpiresAtMs = earliestRotationExpiryMs(
      connection.rotationAttempt,
      connection,
    );
    if (deadlineExpiresAtMs === null) return;
    const deadline = planRealtimeCandidateAckDeadline(
      new Date(deadlineExpiresAtMs).toISOString(),
      Date.now(),
    );
    if (deadline.kind === "invalid") return;
    connection.candidateAckTimer = setTimeout(() => {
      connection.candidateAckTimer = null;
      if (disposed || connection.retired || candidateSocket !== connection) {
        return;
      }
      candidateSocket = null;
      closeConnection(connection);
      scheduleReconnect(connection.rotationAttempt);
    }, deadline.delayMs);
  };

  const scheduleExpiry = (connection: MobileConnection) => {
    if (connection.expiryTimer) clearTimeout(connection.expiryTimer);
    const delayMs = Date.parse(connection.effectiveExpiresAt) - Date.now();
    if (!Number.isFinite(delayMs) || delayMs <= 0) {
      const wasCandidate = candidateSocket === connection;
      const wasActive = activeSocket === connection;
      if (wasActive) {
        activeSocket = null;
        clearRefreshTimer();
      }
      if (wasCandidate) candidateSocket = null;
      closeConnection(connection);
      scheduleReconnect(
        wasCandidate ? connection.rotationAttempt : createRotationAttempt(null),
      );
      return;
    }
    connection.expiryTimer = setTimeout(() => {
      connection.expiryTimer = null;
      if (connection.retired || disposed) return;
      const wasCandidate = candidateSocket === connection;
      const wasActive = activeSocket === connection;
      if (wasActive) {
        activeSocket = null;
        clearRefreshTimer();
      }
      if (wasCandidate) candidateSocket = null;
      closeConnection(connection);
      scheduleReconnect(
        wasCandidate ? connection.rotationAttempt : createRotationAttempt(null),
      );
    }, delayMs);
  };

  const scheduleRefresh = (connection: MobileConnection) => {
    clearRefreshTimer();
    if (disposed || connection.retired || activeSocket !== connection) return;
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
      void connect(createRotationAttempt(connection));
    }, refresh.delayMs);
  };

  const promoteIfReady = (connection: MobileConnection) => {
    if (
      disposed ||
      connection.retired ||
      candidateSocket !== connection ||
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
    reconnectAttempt = 0;
    scheduleRefresh(connection);
    if (previous) closeConnection(previous);
  };

  async function connect(
    rotationAttempt: MobileRotationAttempt,
  ): Promise<void> {
    if (disposed || candidateSocket || tokenLoadAttempt) return;
    const attempt: MobileTokenLoadAttempt = {
      rotationAttempt,
      abortController: new AbortController(),
    };
    tokenLoadAttempt = attempt;
    try {
      const token = await getRealtimeToken(
        plan.scope,
        accessToken,
        attempt.abortController.signal,
      );
      if (
        disposed ||
        tokenLoadAttempt !== attempt ||
        attempt.abortController.signal.aborted ||
        candidateSocket
      ) {
        return;
      }
      const refresh = planRealtimeTokenRefresh(token.expiresAt, Date.now());
      if (refresh.kind === "invalid") {
        throw new Error("Invalid realtime token expiry");
      }
      const connection: MobileConnection = {
        socket: new WebSocket(toWebSocketUrl(token.url, token.token)),
        effectiveExpiresAt: token.expiresAt!,
        ready: false,
        acknowledged: false,
        retired: false,
        rotationAttempt: attempt.rotationAttempt,
        expiryTimer: null,
        candidateAckTimer: null,
      };
      candidateSocket = connection;
      tokenLoadAttempt = null;
      scheduleExpiry(connection);
      scheduleCandidateAckDeadline(connection);
      connection.socket.onopen = () => {
        if (disposed || connection.retired) return;
        reconnectAttempt = 0;
        connection.socket.send(
          JSON.stringify({ type: "subscribe", channels: [channelName] }),
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
          const readyPlan = planRealtimeTokenRefresh(
            frame.expiresAt,
            Date.now(),
          );
          if (readyPlan.kind === "invalid") return;
          if (
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
            frame.channels.length === 1 && frame.channels[0] === channelName;
          promoteIfReady(connection);
          return;
        }
        if (
          frame.type !== "event" ||
          frame.channel !== channelName ||
          activeSocket !== connection
        ) {
          return;
        }
        const event = frame.event;
        if (connection.acknowledged && isRealtimeEventEnvelope(event)) {
          onEvent(event.name, event);
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
        const wasActive = activeSocket === connection;
        if (wasCandidate) candidateSocket = null;
        if (wasActive) {
          activeSocket = null;
          clearRefreshTimer();
        }
        scheduleReconnect(
          wasCandidate
            ? connection.rotationAttempt
            : createRotationAttempt(null),
        );
      };
      connection.socket.onerror = () => {
        if (connection.socket.readyState < WebSocket.CLOSING) {
          connection.socket.close();
        }
      };
    } catch {
      if (
        disposed ||
        tokenLoadAttempt !== attempt ||
        attempt.abortController.signal.aborted
      ) {
        return;
      }
      tokenLoadAttempt = null;
      scheduleReconnect(attempt.rotationAttempt);
    } finally {
      if (tokenLoadAttempt === attempt) tokenLoadAttempt = null;
    }
  }

  void connect(createRotationAttempt(null));

  return async () => {
    disposed = true;
    clearReconnectTimer();
    clearRefreshTimer();
    const loading = tokenLoadAttempt;
    tokenLoadAttempt = null;
    loading?.abortController.abort();
    const candidate = candidateSocket;
    const active = activeSocket;
    candidateSocket = null;
    activeSocket = null;
    closeConnection(candidate);
    if (active !== candidate) closeConnection(active);
  };
}
