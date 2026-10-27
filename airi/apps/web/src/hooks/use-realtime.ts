"use client";

import {
  buildRealtimeChannelName,
  isRealtimeChannelName,
  isRealtimeEventEnvelope,
  planRealtimeCandidateAckDeadline,
  planRealtimeRotationRetry,
  planRealtimeTokenRefresh,
  REALTIME_CLIENT_CONTRACT_HEADER,
  REALTIME_DASHBOARD_CLIENT_CONTRACT_V1,
  type RealtimeEventEnvelope,
  type RealtimeEventName,
  type RealtimeScope,
} from "@icecore/shared/types/realtime";
import {
  parseRequestsRealtimeCommitAckV1,
  parseRequestsRealtimePresenceClientFrameV1,
  parseRequestsRealtimePresenceServerFrameV1,
  parseRequestsRealtimeReadyServerFrameV1,
  parseRequestsRealtimeSubscriptionClientFrameV1,
  parseRequestsRealtimeSubscriptionServerFrameV1,
  type RequestsRealtimeCommitAckV1,
  type RequestsRealtimePresenceClientFrameV1,
  type RequestsRealtimePresenceServerFrameV1,
  type RequestsRealtimeReadyServerFrameV1,
  type RequestsRealtimeSubscriptionServerFrameV1,
} from "@icecore/shared/types/requests-realtime";
import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { useOptionalAuth } from "@/lib/auth/auth-context";
import { hasExactKeys } from "@icecore/shared/lib/value-utils";

type RealtimeHandler = (event: RealtimeEventEnvelope) => void;

export type RealtimeChannelAdapter = {
  bind: (eventName: RealtimeEventName, handler: RealtimeHandler) => void;
  unbind: (eventName: RealtimeEventName, handler: RealtimeHandler) => void;
};

export type RealtimeLegacySnapshotV1 = {
  channel: RealtimeChannelAdapter | null;
  isConnected: boolean;
};

export const REALTIME_CONTROL_BUFFER_MAX_BYTES = 64 * 1_024;

export type RealtimeLoadedTokenV1 =
  | Readonly<{
      kind: "legacy";
      token: string;
      url: string;
      expiresAt: string;
    }>
  | Readonly<{
      kind: "requests";
      token: string;
      url: string;
      expiresAt: string;
      workspaceId: string;
      grantId: string;
    }>;

export type RealtimeRotationReasonV1 = "expiry" | "stale" | "manual";

export type RealtimeRotationEventV1 = Readonly<{
  reason: RealtimeRotationReasonV1;
  phase: "requested" | "loading" | "connecting" | "promoted" | "failed";
  desiredChannelCount: number;
  acknowledgedChannelCount: number;
  tokenKind: "legacy" | "requests" | null;
}>;

export type RealtimeRawEventReceiptV1 = Readonly<{
  channel: string;
  event: RealtimeEventEnvelope;
  receivedAtMonotonicMs: number;
  connectionEpoch: number;
}>;

export type RealtimeServerControlFrameV1 =
  | Readonly<{ type: "ready"; connectionId: string; expiresAt: string }>
  | Readonly<{
      type: "subscribed" | "unsubscribed";
      channels: readonly string[];
    }>
  | RequestsRealtimeReadyServerFrameV1
  | RequestsRealtimeSubscriptionServerFrameV1
  | RequestsRealtimePresenceServerFrameV1;

export type RealtimeServerControlReceiptV1 = Readonly<{
  frame: RealtimeServerControlFrameV1;
  receivedAtMonotonicMs: number;
  connectionEpoch: number;
}>;

export type RealtimeControllerOptionsV1 = Readonly<{
  channels: readonly string[];
  loadToken(input: { signal: AbortSignal }): Promise<RealtimeLoadedTokenV1>;
  onRawEvent?(receipt: RealtimeRawEventReceiptV1): void;
  onServerControl?(receipt: RealtimeServerControlReceiptV1): void;
  onRotation?(event: RealtimeRotationEventV1): void;
}>;

export type RealtimeRotationRequestResultV1 =
  | { kind: "started" }
  | { kind: "in_flight" }
  | { kind: "not_ready" }
  | { kind: "disposed" };

export type RealtimeControlSendResultV1 =
  | { kind: "sent" }
  | {
      kind:
        | "not_ready"
        | "stale_epoch"
        | "invalid"
        | "oversize"
        | "backpressure";
    };

export type RealtimeControlCapacityResultV1 =
  | { kind: "sendable"; frameBytes: number }
  | { kind: "oversize" }
  | { kind: "backpressure" };

export function evaluateRealtimeControlCapacityV1(_input: {
  serializedFrame: string;
  bufferedAmount: number;
}): RealtimeControlCapacityResultV1 {
  const frameBytes = new TextEncoder().encode(
    _input.serializedFrame
  ).byteLength;
  if (frameBytes > 4_096) return { kind: "oversize" };
  if (
    !Number.isFinite(_input.bufferedAmount) ||
    _input.bufferedAmount < 0 ||
    _input.bufferedAmount + frameBytes > REALTIME_CONTROL_BUFFER_MAX_BYTES
  ) {
    return { kind: "backpressure" };
  }
  return { kind: "sendable", frameBytes };
}

export type RealtimeControllerSnapshotV1 = {
  channel: RealtimeChannelAdapter | null;
  isConnected: boolean;
  connectionEpoch: number | null;
  acknowledgedChannels: readonly string[];
  effectiveExpiresAt: string | null;
  gatewayInstanceId: string | null;
  requestRotation(
    reason: RealtimeRotationReasonV1
  ): RealtimeRotationRequestResultV1;
  sendControlFrame(
    frame: RequestsRealtimePresenceClientFrameV1 | RequestsRealtimeCommitAckV1,
    expectedConnectionEpoch: number
  ): RealtimeControlSendResultV1;
};

export type RealtimeControllerDependenciesV1 = Readonly<{
  createWebSocket(url: string, protocols: string[]): WebSocket;
  monotonicNow(): number;
  wallNow(): number;
  random(): number;
  setTimeout(
    callback: () => void,
    delayMs: number
  ): ReturnType<typeof setTimeout>;
  clearTimeout(handle: ReturnType<typeof setTimeout>): void;
  setInterval(
    callback: () => void,
    delayMs: number
  ): ReturnType<typeof setInterval>;
  clearInterval(handle: ReturnType<typeof setInterval>): void;
}>;

export type RealtimeControllerV1 = {
  start(): void;
  dispose(): void;
  subscribe(listener: () => void): () => void;
  getSnapshot(): RealtimeControllerSnapshotV1;
};

const REALTIME_OPEN = 1;
const REALTIME_CLOSING = 2;
const EXACT_ISO_INSTANT_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function isPlainDataRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Object.values(Object.getOwnPropertyDescriptors(value)).every(
    descriptor =>
      "value" in descriptor &&
      typeof descriptor.get !== "function" &&
      typeof descriptor.set !== "function"
  );
}

function parseNonBlankString(value: unknown, fail: () => never): string {
  if (typeof value !== "string" || value.trim().length === 0) return fail();
  return value;
}

function parseExactPattern(
  value: unknown,
  pattern: RegExp,
  fail: () => never
): string {
  const parsed = parseNonBlankString(value, fail);
  return pattern.test(parsed) ? parsed : fail();
}

function parseExactIsoInstant(value: unknown, fail: () => never): string {
  const parsed = parseExactPattern(value, EXACT_ISO_INSTANT_PATTERN, fail);
  const timestamp = Date.parse(parsed);
  if (
    !Number.isFinite(timestamp) ||
    new Date(timestamp).toISOString() !== parsed
  )
    return fail();
  return parsed;
}

function decodedUrlComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function parseRealtimeEndpoint(
  value: unknown,
  token: string,
  fail: () => never
): string {
  const parsed = parseNonBlankString(value, fail);
  let url: URL;
  try {
    url = new URL(parsed);
  } catch {
    return fail();
  }
  if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) return fail();
  if (
    url.username.length > 0 ||
    url.password.length > 0 ||
    [url.pathname, url.search, url.hash].some(component =>
      decodedUrlComponent(component).includes(token)
    )
  ) {
    return fail();
  }
  return parsed;
}

type ControllerReadyIdentity = Readonly<{
  connectionId: string;
  expiresAt: string;
  gatewayInstanceId: string | null;
}>;

type ControllerSubscriptionIdentity = Readonly<{
  type: "subscribed" | "unsubscribed";
  channels: readonly string[];
  connectionId: string | null;
  subscriptionEpoch: number | null;
  grantId: string | null;
}>;

type ControllerConnection = {
  socket: WebSocket;
  epoch: number;
  token: RealtimeLoadedTokenV1;
  ready: ControllerReadyIdentity | null;
  subscription: ControllerSubscriptionIdentity | null;
  effectiveExpiresAt: string;
  expiryTimer: ReturnType<typeof setTimeout> | null;
  candidateAckTimer: ReturnType<typeof setTimeout> | null;
  heartbeatTimer: ReturnType<typeof setInterval> | null;
  lastFrameAtWallMs: number;
  retired: boolean;
};

type ControllerAttempt = {
  reason: RealtimeRotationReasonV1 | null;
  abortController: AbortController;
  connection: ControllerConnection | null;
};

function channelsEqual(
  left: readonly string[],
  right: readonly string[]
): boolean {
  return (
    left.length === right.length &&
    left.every((channel, index) => channel === right[index])
  );
}

function areRealtimeSnapshotsEquivalent(
  current: RealtimeControllerSnapshotV1,
  next: RealtimeControllerSnapshotV1
): boolean {
  return (
    current === next ||
    (current.channel === next.channel &&
      current.isConnected === next.isConnected &&
      current.connectionEpoch === next.connectionEpoch &&
      current.effectiveExpiresAt === next.effectiveExpiresAt &&
      current.gatewayInstanceId === next.gatewayInstanceId &&
      current.requestRotation === next.requestRotation &&
      current.sendControlFrame === next.sendControlFrame &&
      channelsEqual(current.acknowledgedChannels, next.acknowledgedChannels))
  );
}

function parseLegacyServerControl(
  value: unknown
): RealtimeServerControlFrameV1 | null {
  if (!isPlainDataRecord(value) || typeof value.type !== "string") return null;
  const fail = (): never => {
    throw new Error("Invalid legacy realtime server control");
  };
  try {
    if (value.type === "ready") {
      if (!hasExactKeys(value, ["type", "connectionId", "expiresAt"]))
        return null;
      return {
        type: "ready",
        connectionId: parseNonBlankString(value.connectionId, fail),
        expiresAt: parseExactIsoInstant(value.expiresAt, fail),
      };
    }
    if (value.type === "subscribed" || value.type === "unsubscribed") {
      if (!hasExactKeys(value, ["type", "channels"])) return null;
      if (
        !Array.isArray(value.channels) ||
        !value.channels.every(isRealtimeChannelName) ||
        new Set(value.channels).size !== value.channels.length
      ) {
        return null;
      }
      return { type: value.type, channels: [...value.channels] };
    }
  } catch {
    return null;
  }
  return null;
}

function parseRequestsServerControl(
  value: unknown
): RealtimeServerControlFrameV1 | null {
  if (!isPlainDataRecord(value)) return null;
  try {
    if (value.type === "ready") {
      return parseRequestsRealtimeReadyServerFrameV1(value);
    }
    if (value.type === "subscribed" || value.type === "unsubscribed") {
      return parseRequestsRealtimeSubscriptionServerFrameV1(value);
    }
    if (value.type === "requests_presence_ack") {
      return parseRequestsRealtimePresenceServerFrameV1(value);
    }
  } catch {
    return null;
  }
  return null;
}

function createRealtimeController(input: {
  options: RealtimeControllerOptionsV1;
  channel: RealtimeChannelAdapter;
  dependencies?: Partial<RealtimeControllerDependenciesV1>;
  deliverNamedEvent?(event: RealtimeEventEnvelope): void;
  enableLegacyReconnect?: boolean;
  enableLegacyHeartbeat?: boolean;
  enableLegacyRefresh?: boolean;
}): RealtimeControllerV1 {
  const desiredChannels = Object.freeze([...input.options.channels]);
  if (
    desiredChannels.length === 0 ||
    new Set(desiredChannels).size !== desiredChannels.length ||
    !desiredChannels.every(isRealtimeChannelName)
  ) {
    throw new Error("Invalid realtime controller channels");
  }
  const defaults: RealtimeControllerDependenciesV1 = {
    createWebSocket: (url, protocols) => new WebSocket(url, protocols),
    monotonicNow: () => performance.now(),
    wallNow: () => Date.now(),
    random: () => Math.random(),
    setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimeout: handle => clearTimeout(handle),
    setInterval: (callback, delayMs) => setInterval(callback, delayMs),
    clearInterval: handle => clearInterval(handle),
  };
  const dependencies = { ...defaults, ...input.dependencies };
  const listeners = new Set<() => void>();
  const loadControllers = new Set<AbortController>();
  let active: ControllerConnection | null = null;
  let pending: ControllerAttempt | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let legacyRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectAttempt = 0;
  let nextEpoch = 1;
  let started = false;
  let disposed = false;

  const requestRotation = (
    reason: RealtimeRotationReasonV1
  ): RealtimeRotationRequestResultV1 => {
    if (disposed) return { kind: "disposed" };
    if (pending) return { kind: "in_flight" };
    if (!active) return { kind: "not_ready" };
    if (effectiveExpiry(active) <= dependencies.wallNow()) {
      failConnection(active);
      return { kind: "not_ready" };
    }
    beginAttempt(reason);
    return { kind: "started" };
  };

  const sendControlFrame = (
    frame: RequestsRealtimePresenceClientFrameV1 | RequestsRealtimeCommitAckV1,
    expectedConnectionEpoch: number
  ): RealtimeControlSendResultV1 => {
    const connection = active;
    if (
      !connection ||
      connection.retired ||
      connection.socket.readyState !== REALTIME_OPEN ||
      connection.token.kind !== "requests" ||
      !connection.ready ||
      !connection.subscription ||
      connection.subscription.type !== "subscribed"
    ) {
      return { kind: "not_ready" };
    }
    if (effectiveExpiry(connection) <= dependencies.wallNow()) {
      failConnection(connection);
      return { kind: "not_ready" };
    }
    if (connection.epoch !== expectedConnectionEpoch)
      return { kind: "stale_epoch" };

    let parsed:
      | RequestsRealtimePresenceClientFrameV1
      | RequestsRealtimeCommitAckV1;
    try {
      if ("type" in frame && frame.type === "requests_presence") {
        const presence = parseRequestsRealtimePresenceClientFrameV1(frame);
        if (
          presence.connectionId !== connection.ready.connectionId ||
          presence.subscriptionEpoch !==
            connection.subscription.subscriptionEpoch ||
          presence.grantId !== connection.token.grantId ||
          presence.grantId !== connection.subscription.grantId
        ) {
          return { kind: "invalid" };
        }
        parsed = presence;
      } else {
        parsed = parseRequestsRealtimeCommitAckV1(frame);
      }
    } catch {
      return { kind: "invalid" };
    }

    let serializedFrame: string;
    try {
      serializedFrame = JSON.stringify(parsed);
    } catch {
      return { kind: "invalid" };
    }
    const capacity = evaluateRealtimeControlCapacityV1({
      serializedFrame,
      bufferedAmount: connection.socket.bufferedAmount,
    });
    if (capacity.kind !== "sendable") return capacity;
    try {
      connection.socket.send(serializedFrame);
      return { kind: "sent" };
    } catch {
      return { kind: "not_ready" };
    }
  };

  let snapshot: RealtimeControllerSnapshotV1 = buildSnapshot();

  function buildSnapshot(): RealtimeControllerSnapshotV1 {
    const acknowledgedChannels = active?.subscription
      ? Object.freeze([...active.subscription.channels])
      : Object.freeze([] as string[]);
    return {
      channel: input.channel,
      isConnected: Boolean(
        active && !active.retired && active.socket.readyState === REALTIME_OPEN
      ),
      connectionEpoch: active?.epoch ?? null,
      acknowledgedChannels,
      effectiveExpiresAt: active?.effectiveExpiresAt ?? null,
      gatewayInstanceId: active?.ready?.gatewayInstanceId ?? null,
      requestRotation,
      sendControlFrame,
    };
  }

  function publishSnapshot(): void {
    const next = buildSnapshot();
    if (areRealtimeSnapshotsEquivalent(snapshot, next)) return;
    snapshot = next;
    listeners.forEach(listener => listener());
  }

  function emitRotation(
    attempt: ControllerAttempt,
    phase: RealtimeRotationEventV1["phase"],
    tokenKind: "legacy" | "requests" | null = attempt.connection?.token.kind ??
      null
  ): void {
    if (!attempt.reason) return;
    try {
      input.options.onRotation?.({
        reason: attempt.reason,
        phase,
        desiredChannelCount: desiredChannels.length,
        acknowledgedChannelCount:
          attempt.connection?.subscription?.channels.length ?? 0,
        tokenKind,
      });
    } catch {
      // A passive observer cannot alter connection ownership.
    }
  }

  function clearConnectionTimers(connection: ControllerConnection): void {
    if (connection.expiryTimer) {
      dependencies.clearTimeout(connection.expiryTimer);
      connection.expiryTimer = null;
    }
    if (connection.candidateAckTimer) {
      dependencies.clearTimeout(connection.candidateAckTimer);
      connection.candidateAckTimer = null;
    }
    if (connection.heartbeatTimer) {
      dependencies.clearInterval(connection.heartbeatTimer);
      connection.heartbeatTimer = null;
    }
  }

  function clearLegacyRefreshTimer(): void {
    if (!legacyRefreshTimer) return;
    dependencies.clearTimeout(legacyRefreshTimer);
    legacyRefreshTimer = null;
  }

  function scheduleLegacyRefresh(
    connection: ControllerConnection,
    retry = false
  ): void {
    clearLegacyRefreshTimer();
    if (
      !input.enableLegacyRefresh ||
      active !== connection ||
      connection.retired ||
      connection.token.kind !== "legacy"
    ) {
      return;
    }
    const plan = retry
      ? planRealtimeRotationRetry(
          connection.effectiveExpiresAt,
          dependencies.wallNow(),
          dependencies.random()
        )
      : planRealtimeTokenRefresh(
          connection.effectiveExpiresAt,
          dependencies.wallNow()
        );
    if (plan.kind === "invalid") return;
    legacyRefreshTimer = dependencies.setTimeout(() => {
      legacyRefreshTimer = null;
      if (disposed || active !== connection || connection.retired) return;
      requestRotation("expiry");
    }, plan.delayMs);
  }

  function closeRetiredConnection(connection: ControllerConnection): void {
    if (connection.retired) return;
    connection.retired = true;
    clearConnectionTimers(connection);
    if (connection.socket.readyState < REALTIME_CLOSING) {
      try {
        connection.socket.close();
      } catch {
        // Cleanup is best-effort and the retired callbacks are already inert.
      }
    }
  }

  function scheduleReconnect(error?: unknown): void {
    if (
      disposed ||
      !input.enableLegacyReconnect ||
      reconnectTimer ||
      active ||
      pending
    ) {
      return;
    }
    reconnectAttempt += 1;
    const delay = error
      ? getRealtimeTokenRetryDelayMs(error, reconnectAttempt)
      : getRealtimeReconnectDelayMs(reconnectAttempt);
    if (delay == null) return;
    reconnectTimer = dependencies.setTimeout(() => {
      reconnectTimer = null;
      if (!disposed && !active && !pending) beginAttempt(null);
    }, delay);
  }

  function failAttempt(attempt: ControllerAttempt, error?: unknown): void {
    if (pending !== attempt) return;
    pending = null;
    attempt.abortController.abort();
    loadControllers.delete(attempt.abortController);
    if (attempt.connection) closeRetiredConnection(attempt.connection);
    emitRotation(attempt, "failed");
    if (!active) {
      scheduleReconnect(error);
    } else if (attempt.reason === "expiry") {
      scheduleLegacyRefresh(active, true);
    }
  }

  function handleConnectionClosed(connection: ControllerConnection): void {
    if (connection.retired || disposed) return;
    connection.retired = true;
    clearConnectionTimers(connection);
    if (pending?.connection === connection) {
      const attempt = pending;
      pending = null;
      attempt.abortController.abort();
      loadControllers.delete(attempt.abortController);
      emitRotation(attempt, "failed");
      if (!active) {
        scheduleReconnect();
      } else if (attempt.reason === "expiry") {
        scheduleLegacyRefresh(active, true);
      }
      return;
    }
    if (active === connection) {
      clearLegacyRefreshTimer();
      active = null;
      publishSnapshot();
      scheduleReconnect();
    }
  }

  function failConnection(connection: ControllerConnection): void {
    if (connection.retired) return;
    if (pending?.connection === connection) {
      failAttempt(pending);
      return;
    }
    closeRetiredConnection(connection);
    if (active === connection) {
      clearLegacyRefreshTimer();
      active = null;
      publishSnapshot();
      scheduleReconnect();
    }
  }

  function effectiveExpiry(connection: ControllerConnection): number {
    return Date.parse(connection.effectiveExpiresAt);
  }

  function scheduleExpiry(connection: ControllerConnection): void {
    if (connection.expiryTimer) {
      dependencies.clearTimeout(connection.expiryTimer);
      connection.expiryTimer = null;
    }
    const delayMs = effectiveExpiry(connection) - dependencies.wallNow();
    if (delayMs <= 0) {
      failConnection(connection);
      return;
    }
    connection.expiryTimer = dependencies.setTimeout(() => {
      connection.expiryTimer = null;
      if (!connection.retired) failConnection(connection);
    }, delayMs);
  }

  function scheduleCandidateAckDeadline(
    connection: ControllerConnection,
    deadlineOwner = active
  ): void {
    if (connection.candidateAckTimer) {
      dependencies.clearTimeout(connection.candidateAckTimer);
      connection.candidateAckTimer = null;
    }
    if (
      !input.enableLegacyRefresh ||
      connection.token.kind !== "legacy" ||
      pending?.connection !== connection ||
      pending.reason !== "expiry"
    ) {
      return;
    }
    const deadline = planRealtimeCandidateAckDeadline(
      deadlineOwner?.effectiveExpiresAt ?? connection.effectiveExpiresAt,
      dependencies.wallNow()
    );
    if (deadline.kind === "invalid") return;
    connection.candidateAckTimer = dependencies.setTimeout(() => {
      connection.candidateAckTimer = null;
      if (
        disposed ||
        connection.retired ||
        pending?.connection !== connection
      ) {
        return;
      }
      failConnection(connection);
    }, deadline.delayMs);
  }

  function startHeartbeat(connection: ControllerConnection): void {
    if (!input.enableLegacyHeartbeat || connection.heartbeatTimer) return;
    connection.heartbeatTimer = dependencies.setInterval(() => {
      if (active !== connection || connection.retired) return;
      if (
        connection.socket.readyState !== REALTIME_OPEN ||
        isRealtimeConnectionStale(
          connection.lastFrameAtWallMs,
          dependencies.wallNow()
        )
      ) {
        failConnection(connection);
        return;
      }
      try {
        connection.socket.send(JSON.stringify({ type: "ping" }));
      } catch {
        failConnection(connection);
      }
    }, REALTIME_HEARTBEAT_INTERVAL_MS);
  }

  function canPromote(connection: ControllerConnection): boolean {
    const subscription = connection.subscription;
    if (
      !connection.ready ||
      !subscription ||
      subscription.type !== "subscribed" ||
      !channelsEqual(subscription.channels, desiredChannels)
    ) {
      return false;
    }
    if (connection.token.kind === "legacy") return true;
    return (
      subscription.connectionId === connection.ready.connectionId &&
      subscription.grantId === connection.token.grantId &&
      subscription.subscriptionEpoch !== null
    );
  }

  function promoteIfReady(connection: ControllerConnection): void {
    const attempt = pending;
    if (
      !attempt ||
      attempt.connection !== connection ||
      connection.retired ||
      !canPromote(connection)
    ) {
      return;
    }
    const previous = active;
    pending = null;
    attempt.abortController.abort();
    loadControllers.delete(attempt.abortController);
    if (connection.candidateAckTimer) {
      dependencies.clearTimeout(connection.candidateAckTimer);
      connection.candidateAckTimer = null;
    }
    active = connection;
    reconnectAttempt = 0;
    startHeartbeat(connection);
    scheduleLegacyRefresh(connection);
    publishSnapshot();
    emitRotation(attempt, "promoted");
    if (previous) closeRetiredConnection(previous);
  }

  function updateReady(
    connection: ControllerConnection,
    frame: Extract<RealtimeServerControlFrameV1, { type: "ready" }>
  ): boolean {
    const expiresAtMs = Date.parse(frame.expiresAt);
    if (expiresAtMs <= dependencies.wallNow()) {
      failConnection(connection);
      return false;
    }
    const nextReady: ControllerReadyIdentity = {
      connectionId: frame.connectionId,
      expiresAt: frame.expiresAt,
      gatewayInstanceId:
        "gatewayInstanceId" in frame ? frame.gatewayInstanceId : null,
    };
    if (
      connection.ready &&
      (connection.ready.connectionId !== nextReady.connectionId ||
        connection.ready.gatewayInstanceId !== nextReady.gatewayInstanceId)
    ) {
      return false;
    }
    connection.ready = nextReady;
    if (expiresAtMs < Date.parse(connection.effectiveExpiresAt)) {
      connection.effectiveExpiresAt = frame.expiresAt;
      scheduleExpiry(connection);
    }
    if (active === connection) {
      scheduleLegacyRefresh(connection);
      if (pending?.connection) {
        scheduleCandidateAckDeadline(pending.connection, connection);
      }
      publishSnapshot();
    }
    promoteIfReady(connection);
    return true;
  }

  function updateSubscription(
    connection: ControllerConnection,
    frame: Extract<
      RealtimeServerControlFrameV1,
      { type: "subscribed" | "unsubscribed" }
    >
  ): boolean {
    const next: ControllerSubscriptionIdentity = {
      type: frame.type,
      channels: Object.freeze([...frame.channels]),
      connectionId: "connectionId" in frame ? frame.connectionId : null,
      subscriptionEpoch:
        "subscriptionEpoch" in frame ? frame.subscriptionEpoch : null,
      grantId: "grantId" in frame ? frame.grantId : null,
    };
    if (
      connection.token.kind === "requests" &&
      (!connection.ready ||
        next.grantId !== connection.token.grantId ||
        next.connectionId !== connection.ready.connectionId)
    ) {
      return false;
    }
    connection.subscription = next;
    if (active === connection) publishSnapshot();
    promoteIfReady(connection);
    return true;
  }

  function handleServerControl(
    connection: ControllerConnection,
    frame: RealtimeServerControlFrameV1,
    receivedAtMonotonicMs: number
  ): void {
    const accepted =
      frame.type === "ready"
        ? updateReady(connection, frame)
        : frame.type === "subscribed" || frame.type === "unsubscribed"
          ? updateSubscription(connection, frame)
          : frame.type === "requests_presence_ack" &&
            connection.token.kind === "requests" &&
            Boolean(
              connection.ready &&
                connection.subscription?.type === "subscribed" &&
                frame.connectionId === connection.ready.connectionId &&
                frame.subscriptionEpoch ===
                  connection.subscription.subscriptionEpoch &&
                frame.grantId === connection.token.grantId &&
                frame.grantId === connection.subscription.grantId
            );
    if (!accepted) return;
    try {
      input.options.onServerControl?.({
        frame,
        receivedAtMonotonicMs,
        connectionEpoch: connection.epoch,
      });
    } catch {
      // A passive observer cannot alter connection ownership.
    }
  }

  function deliverEvent(
    connection: ControllerConnection,
    parsed: Record<string, unknown>,
    receivedAtMonotonicMs: number
  ): void {
    if (active !== connection || connection.retired) return;
    if (!hasExactKeys(parsed, ["type", "channel", "event"])) return;
    if (parsed.type !== "event" || typeof parsed.channel !== "string") return;
    if (!connection.subscription?.channels.includes(parsed.channel)) return;
    if (!isRealtimeEventEnvelope(parsed.event)) return;
    const event = input.options.onRawEvent
      ? Object.freeze({
          ...parsed.event,
          payload: Object.freeze({ ...parsed.event.payload }),
        })
      : parsed.event;
    try {
      input.options.onRawEvent?.({
        channel: parsed.channel,
        event,
        receivedAtMonotonicMs,
        connectionEpoch: connection.epoch,
      });
    } catch {
      // Raw observers cannot suppress the existing named-handler path.
    }
    try {
      input.deliverNamedEvent?.(event);
    } catch {
      // Preserve socket delivery even when a consumer handler throws.
    }
  }

  function installSocketHandlers(connection: ControllerConnection): void {
    const socket = connection.socket;
    socket.onopen = () => {
      if (connection.retired || pending?.connection !== connection) return;
      connection.lastFrameAtWallMs = dependencies.wallNow();
      try {
        const subscribeFrame =
          connection.token.kind === "requests"
            ? parseRequestsRealtimeSubscriptionClientFrameV1({
                type: "subscribe",
                schemaVersion: 1,
                workspaceId: connection.token.workspaceId,
                grantId: connection.token.grantId,
                channels: [...desiredChannels],
              })
            : { type: "subscribe" as const, channels: [...desiredChannels] };
        socket.send(JSON.stringify(subscribeFrame));
      } catch {
        failConnection(connection);
      }
    };
    socket.onmessage = event => {
      const receivedAtMonotonicMs = dependencies.monotonicNow();
      if (
        connection.retired ||
        (active !== connection && pending?.connection !== connection)
      ) {
        return;
      }
      const receivedAtWallMs = dependencies.wallNow();
      if (effectiveExpiry(connection) <= receivedAtWallMs) {
        failConnection(connection);
        return;
      }
      connection.lastFrameAtWallMs = receivedAtWallMs;
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (!isPlainDataRecord(parsed)) return;
      if (parsed.type === "pong" && hasExactKeys(parsed, ["type"])) return;
      if (parsed.type === "event") {
        deliverEvent(connection, parsed, receivedAtMonotonicMs);
        return;
      }
      const control =
        connection.token.kind === "requests"
          ? parseRequestsServerControl(parsed)
          : parseLegacyServerControl(parsed);
      if (control)
        handleServerControl(connection, control, receivedAtMonotonicMs);
    };
    socket.onclose = () => handleConnectionClosed(connection);
    socket.onerror = () => failConnection(connection);
  }

  function beginAttempt(reason: RealtimeRotationReasonV1 | null): void {
    if (disposed || pending) return;
    const abortController = new AbortController();
    const attempt: ControllerAttempt = {
      reason,
      abortController,
      connection: null,
    };
    pending = attempt;
    loadControllers.add(abortController);
    emitRotation(attempt, "requested");
    emitRotation(attempt, "loading");
    void (async () => {
      try {
        const loaded = await input.options.loadToken({
          signal: abortController.signal,
        });
        if (disposed || pending !== attempt || abortController.signal.aborted)
          return;
        const token = parseRealtimeLoadedTokenV1(
          loaded,
          dependencies.wallNow()
        );
        abortController.abort();
        loadControllers.delete(abortController);
        const socket = dependencies.createWebSocket(toWebSocketUrl(token.url), [
          "airi-realtime",
          toRealtimeTokenSubprotocol(token.token),
        ]);
        if (disposed || pending !== attempt) {
          try {
            socket.close();
          } catch {
            // The abandoned socket has no installed callbacks.
          }
          return;
        }
        const connection: ControllerConnection = {
          socket,
          epoch: nextEpoch,
          token,
          ready: null,
          subscription: null,
          effectiveExpiresAt: token.expiresAt,
          expiryTimer: null,
          candidateAckTimer: null,
          heartbeatTimer: null,
          lastFrameAtWallMs: dependencies.wallNow(),
          retired: false,
        };
        nextEpoch += 1;
        attempt.connection = connection;
        installSocketHandlers(connection);
        scheduleExpiry(connection);
        scheduleCandidateAckDeadline(connection);
        emitRotation(attempt, "connecting", token.kind);
      } catch (error) {
        failAttempt(attempt, error);
      }
    })();
  }

  return {
    start() {
      if (started || disposed) return;
      started = true;
      beginAttempt(null);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (reconnectTimer) {
        dependencies.clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      clearLegacyRefreshTimer();
      loadControllers.forEach(controller => controller.abort());
      loadControllers.clear();
      const pendingConnection = pending?.connection ?? null;
      pending = null;
      if (pendingConnection) closeRetiredConnection(pendingConnection);
      if (active) closeRetiredConnection(active);
      active = null;
      publishSnapshot();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot() {
      return snapshot;
    },
  };
}

export function parseRealtimeLoadedTokenV1(
  value: unknown,
  nowMs = Date.now()
): RealtimeLoadedTokenV1 {
  const fail = (): never => {
    throw new Error("Invalid realtime loaded token");
  };
  const record = isPlainDataRecord(value) ? value : fail();
  const kind: "legacy" | "requests" =
    record.kind === "legacy" || record.kind === "requests"
      ? record.kind
      : fail();
  const expectedKeys =
    kind === "legacy"
      ? ["kind", "token", "url", "expiresAt"]
      : ["kind", "token", "url", "expiresAt", "workspaceId", "grantId"];
  if (!hasExactKeys(record, expectedKeys)) fail();
  const token = parseNonBlankString(record.token, fail);
  const url = parseRealtimeEndpoint(record.url, token, fail);
  const expiresAt = parseExactIsoInstant(record.expiresAt, fail);
  if (!Number.isFinite(nowMs) || Date.parse(expiresAt) <= nowMs) fail();
  if (kind === "legacy") {
    return Object.freeze({ kind, token, url, expiresAt });
  }
  const workspaceId = parseExactPattern(
    record.workspaceId,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    fail
  );
  const grantId = parseExactPattern(record.grantId, /^[0-9a-f]{32}$/, fail);
  return Object.freeze({
    kind,
    token,
    url,
    expiresAt,
    workspaceId,
    grantId,
  });
}

export function createRealtimeControllerV1(input: {
  options: RealtimeControllerOptionsV1;
  channel: RealtimeChannelAdapter;
  dependencies?: Partial<RealtimeControllerDependenciesV1>;
  deliverNamedEvent?(event: RealtimeEventEnvelope): void;
  enableLegacyReconnect?: boolean;
  enableLegacyHeartbeat?: boolean;
  enableLegacyRefresh?: boolean;
}): RealtimeControllerV1 {
  return createRealtimeController(input);
}

type RealtimeTokenPayload = {
  token?: string;
  url?: string;
  expiresAt?: string;
};

type RealtimeTokenErrorPayload = {
  error?: string;
  code?: string;
};

export class RealtimeTokenRequestError extends Error {
  status: number;
  code: string | null;

  constructor(status: number, code?: string | null) {
    super(`Realtime token failed: ${status}`);
    this.status = status;
    this.code = code || null;
  }
}

function createSnapshotStore() {
  const requestRotation = (): RealtimeRotationRequestResultV1 => ({
    kind: "not_ready",
  });
  const sendControlFrame = (): RealtimeControlSendResultV1 => ({
    kind: "not_ready",
  });
  let snapshot: RealtimeControllerSnapshotV1 = {
    channel: null,
    isConnected: false,
    connectionEpoch: null,
    acknowledgedChannels: Object.freeze([] as string[]),
    effectiveExpiresAt: null,
    gatewayInstanceId: null,
    requestRotation,
    sendControlFrame,
  };
  const listeners = new Set<() => void>();
  return {
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => snapshot,
    setSnapshot: (next: RealtimeControllerSnapshotV1) => {
      if (areRealtimeSnapshotsEquivalent(snapshot, next)) return;
      snapshot = next;
      listeners.forEach(listener => listener());
    },
  };
}

function resetSnapshotStore(store: ReturnType<typeof createSnapshotStore>) {
  store.setSnapshot({
    ...store.getSnapshot(),
    channel: null,
    isConnected: false,
    connectionEpoch: null,
    acknowledgedChannels: Object.freeze([] as string[]),
    effectiveExpiresAt: null,
    gatewayInstanceId: null,
  });
}

type SharedLegacyController = {
  controller: RealtimeControllerV1;
  consumers: Set<(event: RealtimeEventEnvelope) => void>;
};
// Authenticated default consumers share only an exact session and scope.
// Custom loaders retain independent ownership of their token and controller.
const sharedLegacyControllers = new Map<string, SharedLegacyController>();

function acquireLegacyController(
  key: string,
  create: (
    deliver: (event: RealtimeEventEnvelope) => void
  ) => RealtimeControllerV1,
  consumer: (event: RealtimeEventEnvelope) => void
) {
  let shared = sharedLegacyControllers.get(key);
  if (!shared) {
    const consumers = new Set<(event: RealtimeEventEnvelope) => void>();
    shared = {
      consumers,
      controller: create(event => {
        consumers.forEach(deliver => {
          try {
            deliver(event);
          } catch {
            // Preserve the controller's containment of consumer failures.
          }
        });
      }),
    };
    sharedLegacyControllers.set(key, shared);
  }
  shared.consumers.add(consumer);
  const owner = shared;
  let released = false;
  return {
    controller: owner.controller,
    release() {
      if (released) return;
      released = true;
      owner.consumers.delete(consumer);
      if (owner.consumers.size === 0) {
        sharedLegacyControllers.delete(key);
        owner.controller.dispose();
      }
    },
  };
}

const REALTIME_TOKEN_SUBPROTOCOL_PREFIX = "airi-realtime-token.";
const REALTIME_HEARTBEAT_INTERVAL_MS = 25_000;
const REALTIME_STALE_CONNECTION_MS = 55_000;
const REALTIME_AUTH_TOKEN_RETRY_ATTEMPTS = 6;

function getTokenUrl(scope: RealtimeScope): string {
  const params = new URLSearchParams({ workspaceId: scope.workspaceId });
  if (scope.kind === "conversation") {
    params.set("conversationId", scope.conversationId);
  }
  return `/api/realtime/token?${params.toString()}`;
}

export function toWebSocketUrl(endpointUrl: string): string {
  const url = new URL(endpointUrl);
  if (url.protocol === "https:") {
    url.protocol = "wss:";
  } else if (url.protocol === "http:") {
    url.protocol = "ws:";
  } else if (url.protocol !== "wss:" && url.protocol !== "ws:") {
    throw new Error("Unsupported realtime gateway protocol");
  }
  return url.toString();
}

export function toRealtimeTokenSubprotocol(token: string): string {
  return `${REALTIME_TOKEN_SUBPROTOCOL_PREFIX}${token}`;
}

export function isUsableRealtimeTokenPayload(payload: {
  token?: string | null;
  url?: string | null;
}): boolean {
  return Boolean(payload.token?.trim() && payload.url?.trim());
}

export function getRealtimeReconnectDelayMs(attempt: number): number {
  const normalizedAttempt = Math.max(1, Math.floor(attempt));
  return Math.min(1000 * 2 ** (normalizedAttempt - 1), 15000);
}

export function getRealtimeTokenRetryDelayMs(
  error: unknown,
  attempt: number
): number | null {
  if (error instanceof RealtimeTokenRequestError) {
    if (error.code === "realtime_gateway_not_configured") {
      return null;
    }
    if (
      (error.status === 401 || error.status === 403) &&
      attempt > REALTIME_AUTH_TOKEN_RETRY_ATTEMPTS
    ) {
      return null;
    }
  }

  return getRealtimeReconnectDelayMs(attempt);
}

export function isRealtimeConnectionStale(
  lastFrameAt: number,
  now = Date.now(),
  staleAfterMs = REALTIME_STALE_CONNECTION_MS
): boolean {
  return now - lastFrameAt > staleAfterMs;
}

async function fetchRealtimeTokenPayload(
  scope: RealtimeScope,
  signal?: AbortSignal
): Promise<RealtimeTokenPayload> {
  const tokenResponse = await fetch(getTokenUrl(scope), {
    cache: "no-store",
    headers: {
      [REALTIME_CLIENT_CONTRACT_HEADER]: REALTIME_DASHBOARD_CLIENT_CONTRACT_V1,
    },
    signal,
  });
  if (!tokenResponse.ok) {
    let code: string | null = null;
    try {
      const payload = (await tokenResponse.json()) as RealtimeTokenErrorPayload;
      code = typeof payload.code === "string" ? payload.code : null;
    } catch {
      code = null;
    }
    throw new RealtimeTokenRequestError(tokenResponse.status, code);
  }
  return (await tokenResponse.json()) as RealtimeTokenPayload;
}

export function useRealtime(
  scope: RealtimeScope | null | undefined,
  options: RealtimeControllerOptionsV1
): RealtimeControllerSnapshotV1;
export function useRealtime(
  scope?: RealtimeScope | null
): RealtimeLegacySnapshotV1;
export function useRealtime(
  scope?: RealtimeScope | null,
  customOptions?: RealtimeControllerOptionsV1
): RealtimeLegacySnapshotV1 | RealtimeControllerSnapshotV1 {
  const optionalAuth = useOptionalAuth();
  const auth = customOptions ? undefined : optionalAuth;
  const hasAuthProvider = auth !== undefined;
  const authLoading = auth?.loading ?? false;
  const userId = auth?.user?.id;
  const accessToken = auth?.session?.access_token;
  const store = useMemo(() => createSnapshotStore(), []);
  const handlersRef = useRef(
    new Map<RealtimeEventName, Set<RealtimeHandler>>()
  );
  const scopeKind = scope?.kind;
  const workspaceId = scope?.workspaceId ?? "";
  const conversationId =
    scope?.kind === "conversation" ? scope.conversationId : "";

  const channel = useMemo<RealtimeChannelAdapter>(
    () => ({
      bind: (eventName, handler) => {
        const handlers = handlersRef.current.get(eventName) || new Set();
        handlers.add(handler);
        handlersRef.current.set(eventName, handlers);
      },
      unbind: (eventName, handler) => {
        const handlers = handlersRef.current.get(eventName);
        if (!handlers) return;
        handlers.delete(handler);
        if (handlers.size === 0) handlersRef.current.delete(eventName);
      },
    }),
    []
  );

  useEffect(() => {
    // Callers can pass inline objects; only scope values own the subscription.
    const scope: RealtimeScope | null = scopeKind
      ? scopeKind === "workspace"
        ? { kind: scopeKind, workspaceId }
        : { kind: scopeKind, workspaceId, conversationId }
      : null;
    const channelName = scope ? buildRealtimeChannelName(scope) : null;
    if (
      !customOptions &&
      (!scope ||
        !channelName ||
        (hasAuthProvider && (authLoading || !userId || !accessToken)))
    ) {
      resetSnapshotStore(store);
      return undefined;
    }

    const controllerOptions: RealtimeControllerOptionsV1 = customOptions || {
      channels: [channelName!],
      async loadToken({ signal }) {
        const tokenPayload = await fetchRealtimeTokenPayload(scope!, signal);
        if (!isUsableRealtimeTokenPayload(tokenPayload)) {
          throw new Error("Invalid realtime token payload");
        }
        return parseRealtimeLoadedTokenV1({
          kind: "legacy",
          token: tokenPayload.token?.trim() || "",
          url: tokenPayload.url?.trim() || "",
          expiresAt: tokenPayload.expiresAt?.trim() || "",
        });
      },
    };
    const deliverNamedEvent = (event: RealtimeEventEnvelope) => {
      const handlers = handlersRef.current.get(event.name);
      handlers?.forEach(handler => handler(event));
    };
    const createController = (deliver: typeof deliverNamedEvent) =>
      createRealtimeControllerV1({
        options: controllerOptions,
        channel,
        enableLegacyReconnect: !customOptions,
        enableLegacyHeartbeat: !customOptions,
        enableLegacyRefresh: !customOptions,
        deliverNamedEvent: deliver,
      });
    const lease =
      !customOptions && userId && accessToken
        ? acquireLegacyController(
            JSON.stringify([userId, accessToken, channelName]),
            createController,
            deliverNamedEvent
          )
        : null;
    const controller = lease?.controller || createController(deliverNamedEvent);
    const publishSnapshot = () => {
      const snapshot = controller.getSnapshot();
      store.setSnapshot({
        ...snapshot,
        channel: snapshot.channel ? channel : null,
      });
    };
    const unsubscribe = controller.subscribe(publishSnapshot);
    publishSnapshot();
    controller.start();

    return () => {
      unsubscribe();
      if (lease) lease.release();
      else controller.dispose();
      resetSnapshotStore(store);
    };
  }, [
    accessToken,
    authLoading,
    channel,
    conversationId,
    customOptions,
    hasAuthProvider,
    scopeKind,
    store,
    userId,
    workspaceId,
  ]);

  const snapshot = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot
  );

  if (customOptions) return snapshot;
  return { channel: snapshot.channel, isConnected: snapshot.isConnected };
}
