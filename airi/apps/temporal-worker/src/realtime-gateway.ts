import { airiWorkerLogger } from "@icecore/airi-runtime/logging";
import {
  classifyRealtimeClientContract,
  isRealtimeClientFrame,
  parseRealtimeChannelName,
  REALTIME_DASHBOARD_CLIENT_CONTRACT_V1,
  realtimeScopeCanSubscribe,
  type RealtimeClientContractTelemetryLabel,
  type RealtimeScope,
} from "@icecore/shared/types/realtime";
import http from "node:http";
import { randomUUID } from "node:crypto";
import type { Duplex } from "node:stream";
import { TextDecoder } from "node:util";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import {
  connectRealtimeValkeyClient,
  createRealtimeValkeyClient,
} from "./realtime-valkey.js";
import {
  getScopeFromClaims,
  verifyRealtimeToken,
  type RealtimeTokenClaims,
} from "./realtime-token.js";

const DEFAULT_PORT = 8080;
const REALTIME_TOKEN_SUBPROTOCOL_PREFIX = "airi-realtime-token.";
const REALTIME_GATEWAY_MAX_PAYLOAD_BYTES = 64 * 1024;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

export type GatewayTokenTransport = "subprotocol" | "query" | "missing";

export type GatewaySubscriberEpochState = {
  readiness: "not_ready" | "ready";
  epoch: number;
};

export type GatewaySubscriberEpochController = {
  read(): Readonly<GatewaySubscriberEpochState>;
  markReady(): Readonly<GatewaySubscriberEpochState>;
  markNotReady(): Readonly<GatewaySubscriberEpochState>;
};

export type GatewayTimeoutHandle = {
  unref?: () => void;
};

export type GatewayTimerScheduler = {
  schedule(callback: () => void, delayMs: number): GatewayTimeoutHandle;
  cancel(handle: GatewayTimeoutHandle): void;
};

export type GatewaySubscriber = {
  readonly isOpen?: boolean;
  readonly isReady?: boolean;
  connect(): Promise<unknown>;
  subscribe(
    channel: string,
    listener: (message: string, channel: string) => void,
  ): Promise<unknown>;
  unsubscribe(channel: string): Promise<unknown>;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  close?(): Promise<unknown>;
};

export type RealtimeGatewayLogger = {
  info(event: string, metadata?: Record<string, unknown>): void;
  warn(event: string, metadata?: Record<string, unknown>): void;
  error(
    event: string,
    error: unknown,
    metadata?: Record<string, unknown>,
  ): void;
};

export type RealtimeGatewayServerHandle = {
  readonly port: number;
  readonly url: string;
  readonly clientsByChannel: ReadonlyMap<string, ReadonlySet<WebSocket>>;
  readonly channelsByClient: ReadonlyMap<WebSocket, ReadonlySet<string>>;
  readSubscriberState(): Readonly<GatewaySubscriberEpochState>;
  close(): Promise<void>;
};

export type RealtimeGatewayServerOptions = {
  subscriber: GatewaySubscriber;
  verifyToken(token: string): RealtimeTokenClaims;
  logger?: RealtimeGatewayLogger;
  port?: number;
  host?: string;
  now?: () => number;
  timerScheduler?: GatewayTimerScheduler;
};

type RealtimeClientStats = {
  openedAt: number;
  scopeKind: RealtimeScope["kind"];
  tokenSource: "dashboard" | "mobile" | "widget" | null;
  tokenTransport: GatewayTokenTransport;
  clientContract: RealtimeClientContractTelemetryLabel;
  subscribedChannelCount: number;
  clientFrameCount: number;
  subscribeCount: number;
  unsubscribeCount: number;
  forwardedEventCount: number;
};

function classifyGatewayTokenSource(
  value: unknown,
): RealtimeClientStats["tokenSource"] {
  return value === "dashboard" || value === "mobile" || value === "widget"
    ? value
    : null;
}

type BackendChannelState = {
  generation: number;
  reservations: Map<WebSocket, number>;
};

type BackendChannelCoordinator = {
  confirmedGeneration: number | null;
  physicalSubscribed: boolean;
  operationGeneration: number | null;
  operation: Promise<void> | null;
  listener: (message: string, channel: string) => void;
};

type BackendChannelReservation = {
  channel: string;
  client: WebSocket;
  state: BackendChannelState;
  released: boolean;
};

class SubscriberEpochLostError extends Error {}

function rawDataToBuffer(data: RawData): Buffer {
  if (Array.isArray(data)) return Buffer.concat(data);
  if (Buffer.isBuffer(data)) return data;
  return Buffer.from(data);
}

const defaultTimerScheduler: GatewayTimerScheduler = {
  schedule(callback, delayMs) {
    return setTimeout(callback, delayMs);
  },
  cancel(handle) {
    clearTimeout(handle as NodeJS.Timeout);
  },
};

export function createGatewaySubscriberEpochController(): GatewaySubscriberEpochController {
  let state: GatewaySubscriberEpochState = {
    readiness: "not_ready",
    epoch: 0,
  };
  const read = () => ({ ...state });
  return {
    read,
    markReady() {
      if (state.readiness === "not_ready") {
        if (state.epoch >= Number.MAX_SAFE_INTEGER) return read();
        state = { readiness: "ready", epoch: state.epoch + 1 };
      }
      return read();
    },
    markNotReady() {
      if (state.readiness === "ready") {
        state = { readiness: "not_ready", epoch: state.epoch };
      }
      return read();
    },
  };
}

export function scheduleSignedExpiry(
  socket: Pick<WebSocket, "close">,
  expiresAtSeconds: number,
  options: {
    now?: () => number;
    timerScheduler?: GatewayTimerScheduler;
  } = {},
): () => void {
  const now = options.now || Date.now;
  const scheduler = options.timerScheduler || defaultTimerScheduler;
  const deadlineMs = expiresAtSeconds * 1_000;
  let active = true;
  let handle: GatewayTimeoutHandle | null = null;

  const expire = () => {
    if (!active) return;
    active = false;
    socket.close(1008, "token_expired");
  };
  const schedule = () => {
    const remaining = Math.max(0, deadlineMs - now());
    if (remaining > MAX_TIMER_DELAY_MS) {
      handle = scheduler.schedule(schedule, MAX_TIMER_DELAY_MS);
    } else {
      handle = scheduler.schedule(expire, remaining);
    }
    handle.unref?.();
  };
  schedule();
  return () => {
    if (!active) return;
    active = false;
    if (handle) scheduler.cancel(handle);
  };
}

export async function startRealtimeGatewayServer(
  options: RealtimeGatewayServerOptions,
): Promise<RealtimeGatewayServerHandle> {
  const logger = options.logger || airiWorkerLogger;
  const now = options.now || Date.now;
  const host = options.host || "0.0.0.0";
  const port = options.port ?? DEFAULT_PORT;
  const subscriber = options.subscriber;

  const clientsByChannel = new Map<string, Set<WebSocket>>();
  const channelsByClient = new Map<WebSocket, Set<string>>();
  const scopeByClient = new Map<WebSocket, RealtimeScope>();
  const clientStatsByClient = new Map<WebSocket, RealtimeClientStats>();
  const backendChannels = new Map<string, BackendChannelState>();
  const backendCoordinatorsByChannel = new Map<
    string,
    BackendChannelCoordinator
  >();
  const expiryCleanupByClient = new WeakMap<WebSocket, () => void>();
  const cleanupByClient = new WeakMap<WebSocket, Promise<void>>();
  const pendingCleanups = new Set<Promise<void>>();
  const pendingControls = new Set<Promise<void>>();

  let backendGeneration = 0;
  let readinessAttempt = 0;
  let readinessInFlight: {
    attempt: number;
    promise: Promise<void>;
  } | null = null;
  let closing = false;

  const subscriberEpoch = createGatewaySubscriberEpochController();

  function currentBackendState(channel: string): BackendChannelState {
    const existing = backendChannels.get(channel);
    if (existing?.generation === backendGeneration) return existing;
    const state: BackendChannelState = {
      generation: backendGeneration,
      reservations: new Map(),
    };
    backendChannels.set(channel, state);
    return state;
  }

  function deleteIdleBackendState(
    channel: string,
    state: BackendChannelState,
  ): void {
    const coordinator = backendCoordinatorsByChannel.get(channel);
    if (
      backendChannels.get(channel) === state &&
      !coordinator?.physicalSubscribed &&
      !coordinator?.operation &&
      state.reservations.size === 0 &&
      !clientsByChannel.has(channel)
    ) {
      backendChannels.delete(channel);
      if (coordinator) backendCoordinatorsByChannel.delete(channel);
    }
  }

  function deliverBrokerMessage(
    channel: string,
    message: string,
    generation: number,
    backendState: BackendChannelState,
  ): void {
    if (
      generation !== backendGeneration ||
      backendState.generation !== generation
    ) {
      return;
    }
    const startedAt = now();
    const clients = Array.from(clientsByChannel.get(channel) || []);
    let deliveredCount = 0;

    for (const client of clients) {
      if (
        !scopeByClient.has(client) ||
        !channelsByClient.get(client)?.size ||
        client.readyState !== WebSocket.OPEN
      ) {
        continue;
      }
      client.send(message);
      deliveredCount += 1;
      const stats = clientStatsByClient.get(client);
      if (stats) stats.forwardedEventCount += 1;
    }
    logger.info("airi.realtime.gateway", {
      note: "broker_delivery",
      deliveredCount,
      droppedCount: clients.length - deliveredCount,
      durationMs: Math.max(0, now() - startedAt),
    });
  }

  function backendCoordinatorForChannel(
    channel: string,
  ): BackendChannelCoordinator {
    const existing = backendCoordinatorsByChannel.get(channel);
    if (existing) return existing;
    const listener = (message: string, reportedChannel: string) => {
      if (reportedChannel && reportedChannel !== channel) return;
      const state = backendChannels.get(channel);
      const generation = backendGeneration;
      if (!state || state.generation !== generation) return;
      deliverBrokerMessage(channel, message, generation, state);
    };
    const coordinator: BackendChannelCoordinator = {
      confirmedGeneration: null,
      physicalSubscribed: false,
      operationGeneration: null,
      operation: null,
      listener,
    };
    backendCoordinatorsByChannel.set(channel, coordinator);
    return coordinator;
  }

  async function ensureBackendSubscribed(
    channel: string,
    capturedGeneration: number,
  ): Promise<void> {
    if (closing || capturedGeneration !== backendGeneration) {
      throw new SubscriberEpochLostError();
    }
    const state = currentBackendState(channel);
    const coordinator = backendCoordinatorForChannel(channel);
    if (
      coordinator.confirmedGeneration === capturedGeneration &&
      !coordinator.operation
    ) {
      return;
    }
    if (coordinator.operation) {
      const operation = coordinator.operation;
      const operationGeneration = coordinator.operationGeneration;
      try {
        await operation;
      } catch (error) {
        if (operationGeneration === capturedGeneration) throw error;
      }
      if (closing || capturedGeneration !== backendGeneration) {
        throw new SubscriberEpochLostError();
      }
      return ensureBackendSubscribed(channel, capturedGeneration);
    }

    const operation = Promise.resolve()
      .then(() => {
        if (closing) throw new SubscriberEpochLostError();
        return subscriber.subscribe(channel, coordinator.listener);
      })
      .then(() => {
        if (closing) throw new SubscriberEpochLostError();
        coordinator.physicalSubscribed = true;
        if (capturedGeneration !== backendGeneration) {
          throw new SubscriberEpochLostError();
        }
        coordinator.confirmedGeneration = capturedGeneration;
      });
    coordinator.operationGeneration = capturedGeneration;
    coordinator.operation = operation;
    try {
      await operation;
    } finally {
      if (coordinator.operation === operation) {
        coordinator.operation = null;
        coordinator.operationGeneration = null;
      }
      deleteIdleBackendState(channel, state);
    }
  }

  async function maybeUnsubscribeBackend(channel: string): Promise<void> {
    const state = backendChannels.get(channel);
    if (closing) {
      if (
        !clientsByChannel.get(channel)?.size &&
        !state?.reservations.size &&
        !backendCoordinatorsByChannel.get(channel)?.operation
      ) {
        backendChannels.delete(channel);
        backendCoordinatorsByChannel.delete(channel);
      }
      return;
    }
    if (clientsByChannel.get(channel)?.size) return;
    if (state?.reservations.size) return;
    const coordinator = backendCoordinatorsByChannel.get(channel);
    if (!coordinator) {
      if (state) deleteIdleBackendState(channel, state);
      return;
    }
    if (coordinator.operation) {
      await coordinator.operation.catch(() => undefined);
      return maybeUnsubscribeBackend(channel);
    }
    if (!coordinator.physicalSubscribed) {
      coordinator.confirmedGeneration = null;
      if (state) deleteIdleBackendState(channel, state);
      return;
    }

    const operationGeneration = backendGeneration;
    const operation = Promise.resolve()
      .then(() => subscriber.unsubscribe(channel))
      .then(
        () => {
          coordinator.physicalSubscribed = false;
          coordinator.confirmedGeneration = null;
          const currentState = backendChannels.get(channel);
          if (
            !clientsByChannel.get(channel)?.size &&
            !currentState?.reservations.size
          ) {
            backendCoordinatorsByChannel.delete(channel);
          }
        },
        () => {
          if (!closing) {
            logger.warn("airi.realtime.gateway", {
              note: "backend_subscription",
              outcome: "unsubscribe_failed",
              reason: "backend_unavailable",
            });
          }
        },
      );
    coordinator.operationGeneration = operationGeneration;
    coordinator.operation = operation;
    try {
      await operation;
    } finally {
      if (coordinator.operation === operation) {
        coordinator.operation = null;
        coordinator.operationGeneration = null;
      }
      const currentState = backendChannels.get(channel);
      if (currentState) deleteIdleBackendState(channel, currentState);
    }
  }

  function reserveBackendChannel(
    client: WebSocket,
    channel: string,
    capturedGeneration: number,
  ): BackendChannelReservation {
    if (closing || capturedGeneration !== backendGeneration) {
      throw new SubscriberEpochLostError();
    }
    const state = currentBackendState(channel);
    state.reservations.set(client, (state.reservations.get(client) || 0) + 1);
    return {
      channel,
      client,
      state,
      released: false,
    };
  }

  async function releaseBackendReservation(
    reservation: BackendChannelReservation,
  ): Promise<void> {
    if (reservation.released) return;
    reservation.released = true;
    const count = reservation.state.reservations.get(reservation.client) || 0;
    if (count <= 1) {
      reservation.state.reservations.delete(reservation.client);
    } else {
      reservation.state.reservations.set(reservation.client, count - 1);
    }
    if (backendChannels.get(reservation.channel) === reservation.state) {
      await maybeUnsubscribeBackend(reservation.channel);
      deleteIdleBackendState(reservation.channel, reservation.state);
    }
  }

  function attachClientToChannel(client: WebSocket, channel: string): void {
    let clients = clientsByChannel.get(channel);
    if (!clients) {
      clients = new Set();
      clientsByChannel.set(channel, clients);
    }
    clients.add(client);
    channelsByClient.get(client)?.add(channel);
  }

  async function detachClientFromChannel(
    client: WebSocket,
    channel: string,
  ): Promise<void> {
    const clients = clientsByChannel.get(channel);
    clients?.delete(client);
    channelsByClient.get(client)?.delete(channel);
    if (clients && clients.size === 0) clientsByChannel.delete(channel);
    if (!clientsByChannel.has(channel)) await maybeUnsubscribeBackend(channel);
  }

  function logConnectionClosed(stats: RealtimeClientStats): void {
    logger.info("airi.realtime.gateway", {
      note: "connection_closed",
      scopeKind: stats.scopeKind,
      tokenSource: stats.tokenSource,
      tokenTransport: stats.tokenTransport,
      clientContract: stats.clientContract,
      subscribedChannelCount: stats.subscribedChannelCount,
      clientFrameCount: stats.clientFrameCount,
      subscribeCount: stats.subscribeCount,
      unsubscribeCount: stats.unsubscribeCount,
      forwardedEventCount: stats.forwardedEventCount,
      durationMs: Math.max(0, now() - stats.openedAt),
    });
  }

  function cleanupClient(client: WebSocket): Promise<void> {
    const existing = cleanupByClient.get(client);
    if (existing) return existing;
    const cleanup = Promise.resolve().then(async () => {
      expiryCleanupByClient.get(client)?.();
      expiryCleanupByClient.delete(client);
      scopeByClient.delete(client);
      const channels = Array.from(channelsByClient.get(client) || []);
      channelsByClient.delete(client);
      await Promise.all(
        channels.map((channel) => detachClientFromChannel(client, channel)),
      );
      const stats = clientStatsByClient.get(client);
      clientStatsByClient.delete(client);
      if (stats) {
        stats.subscribedChannelCount = channels.length;
        logConnectionClosed(stats);
      }
    });
    cleanupByClient.set(client, cleanup);
    pendingCleanups.add(cleanup);
    void cleanup.finally(() => pendingCleanups.delete(cleanup));
    return cleanup;
  }

  function loseSubscriberEpoch(): void {
    if (closing) return;
    readinessAttempt += 1;
    backendGeneration += 1;
    subscriberEpoch.markNotReady();
  }

  async function waitForBackendOperations(): Promise<void> {
    while (true) {
      const operations = Array.from(backendCoordinatorsByChannel.values())
        .map((coordinator) => coordinator.operation)
        .filter((operation): operation is Promise<void> => Boolean(operation));
      if (operations.length === 0) return;
      await Promise.all(
        operations.map((operation) => operation.catch(() => undefined)),
      );
    }
  }

  function occupiedChannels(): string[] {
    const channels = new Set<string>();
    for (const [channel, clients] of clientsByChannel) {
      if (
        [...clients].some(
          (client) =>
            client.readyState === WebSocket.OPEN &&
            scopeByClient.has(client) &&
            channelsByClient.get(client)?.has(channel),
        )
      ) {
        channels.add(channel);
      }
    }
    for (const [channel, state] of backendChannels) {
      if (
        state.generation === backendGeneration &&
        [...state.reservations.keys()].some(
          (client) =>
            client.readyState === WebSocket.OPEN && scopeByClient.has(client),
        )
      ) {
        channels.add(channel);
      }
    }
    return [...channels];
  }

  // Readiness re-establishes every occupied channel on the current subscriber
  // generation before /readyz reports ready again.
  function beginReadiness(): void {
    if (closing || subscriberEpoch.read().readiness === "ready") return;
    const attempt = readinessAttempt;
    if (readinessInFlight?.attempt === attempt) return;
    const staleReadiness = readinessInFlight?.promise;
    const capturedGeneration = backendGeneration;
    const isCurrentAttempt = () =>
      !closing &&
      attempt === readinessAttempt &&
      capturedGeneration === backendGeneration &&
      subscriber.isReady !== false &&
      subscriberEpoch.read().readiness === "not_ready";
    const operation = (async () => {
      await staleReadiness?.catch(() => undefined);
      if (!isCurrentAttempt()) return;
      await waitForBackendOperations();
      if (!isCurrentAttempt()) return;
      await Promise.all(
        occupiedChannels().map((channel) =>
          ensureBackendSubscribed(channel, capturedGeneration),
        ),
      );
      if (!isCurrentAttempt()) return;
      subscriberEpoch.markReady();
    })();
    readinessInFlight = { attempt, promise: operation };
    void operation
      .catch(() => {
        if (!isCurrentAttempt()) return;
        logger.warn("airi.realtime.gateway", {
          note: "subscriber_readiness",
          outcome: "resubscribe_failed",
        });
      })
      .finally(() => {
        if (readinessInFlight?.promise === operation) {
          readinessInFlight = null;
        }
      });
  }

  async function handleClientFrame(
    client: WebSocket,
    data: RawData,
  ): Promise<void> {
    const scope = scopeByClient.get(client);
    if (!scope) return;
    const ownedChannels = channelsByClient.get(client);
    if (!ownedChannels) return;
    const capturedGeneration = backendGeneration;
    const isCurrent = () =>
      !closing &&
      client.readyState === WebSocket.OPEN &&
      scopeByClient.get(client) === scope &&
      channelsByClient.get(client) === ownedChannels &&
      capturedGeneration === backendGeneration;
    const stats = clientStatsByClient.get(client);
    if (stats) stats.clientFrameCount += 1;
    let raw: string;
    try {
      raw = new TextDecoder("utf-8", { fatal: true }).decode(
        rawDataToBuffer(data),
      );
    } catch {
      client.close(1007);
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      sendFrame(client, {
        type: "error",
        code: "server_error",
        message: "Realtime frame failed",
      });
      return;
    }
    if (!isRealtimeClientFrame(parsed)) {
      sendFrame(client, {
        type: "error",
        code: "invalid_frame",
        message: "Invalid realtime frame",
      });
      return;
    }
    if (parsed.type === "ping") {
      sendFrame(client, { type: "pong" });
      return;
    }

    const allowedChannels = parsed.channels.filter((channel) =>
      realtimeScopeCanSubscribe(channel, scope),
    );
    const rejectedCount = parsed.channels.length - allowedChannels.length;
    if (rejectedCount > 0) {
      sendFrame(client, {
        type: "error",
        code: "forbidden_channel",
        message: "One or more channels are outside token scope",
      });
    }
    if (parsed.type === "subscribe") {
      for (const channel of allowedChannels) {
        const reservation = reserveBackendChannel(
          client,
          channel,
          capturedGeneration,
        );
        try {
          await ensureBackendSubscribed(channel, capturedGeneration);
        } catch (error) {
          await releaseBackendReservation(reservation);
          throw error;
        }
        if (!isCurrent()) {
          await releaseBackendReservation(reservation);
          return;
        }
        attachClientToChannel(client, channel);
        await releaseBackendReservation(reservation);
      }
      if (!isCurrent()) return;
      if (stats) stats.subscribeCount += 1;
      if (allowedChannels.length > 0) {
        sendFrame(client, { type: "subscribed", channels: allowedChannels });
      }
    } else {
      await Promise.all(
        allowedChannels.map((channel) =>
          detachClientFromChannel(client, channel),
        ),
      );
      if (!isCurrent()) return;
      if (stats) stats.unsubscribeCount += 1;
      if (allowedChannels.length > 0) {
        sendFrame(client, { type: "unsubscribed", channels: allowedChannels });
      }
    }
    logger.info("airi.realtime.gateway", {
      note: "subscription_changed",
      scopeKind: scope.kind,
      tokenSource: stats?.tokenSource || null,
      requestedChannelCount: parsed.channels.length,
      authorizedChannelCount: allowedChannels.length,
      rejectedChannelCount: rejectedCount,
      ...summarizeRealtimeChannels(parsed.channels),
      outcome: "acknowledged",
    });
  }

  function installClient(
    client: WebSocket,
    claims: RealtimeTokenClaims,
    scope: RealtimeScope,
    tokenTransport: GatewayTokenTransport,
  ): void {
    const stats: RealtimeClientStats = {
      openedAt: now(),
      scopeKind: scope.kind,
      tokenSource: classifyGatewayTokenSource(claims.source),
      tokenTransport,
      clientContract: classifyRealtimeClientContract(
        claims.clientContract === REALTIME_DASHBOARD_CLIENT_CONTRACT_V1
          ? claims.clientContract
          : undefined,
      ),
      subscribedChannelCount: 0,
      clientFrameCount: 0,
      subscribeCount: 0,
      unsubscribeCount: 0,
      forwardedEventCount: 0,
    };
    channelsByClient.set(client, new Set());
    scopeByClient.set(client, scope);
    clientStatsByClient.set(client, stats);
    client.on("error", () => undefined);
    client.once("close", () => {
      void cleanupClient(client);
    });
    expiryCleanupByClient.set(
      client,
      scheduleSignedExpiry(client, claims.exp, {
        now,
        timerScheduler: options.timerScheduler,
      }),
    );
    logger.info("airi.realtime.gateway", {
      note: "connection_opened",
      scopeKind: stats.scopeKind,
      tokenSource: stats.tokenSource,
      tokenTransport: stats.tokenTransport,
      clientContract: stats.clientContract,
      outcome: "accepted",
    });
    sendFrame(client, {
      type: "ready",
      connectionId: randomUUID(),
      expiresAt: new Date(claims.exp * 1_000).toISOString(),
    });
    client.on("message", (data) => {
      if (closing) return;
      const control = handleClientFrame(client, data)
        .catch(() => {
          if (closing) return;
          logger.warn("airi.realtime.gateway", {
            note: "client_frame_failed",
            scopeKind: scope.kind,
            reason: "server_error",
            outcome: "error",
          });
          sendFrame(client, {
            type: "error",
            code: "server_error",
            message: "Realtime frame failed",
          });
        })
        .finally(() => pendingControls.delete(control));
      pendingControls.add(control);
    });
  }

  const server = http.createServer((request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    if (
      request.method === "GET" &&
      (url.pathname === "/readyz" || url.pathname === "/healthz")
    ) {
      const ready = subscriberEpoch.read().readiness === "ready";
      response.statusCode = url.pathname === "/readyz" && !ready ? 503 : 200;
      response.setHeader("Content-Type", "application/json; charset=utf-8");
      response.end(
        JSON.stringify({
          ok: response.statusCode === 200,
          subscriberReady: ready,
          channels: clientsByChannel.size,
          clients: channelsByClient.size,
        }),
      );
      return;
    }
    response.statusCode = 404;
    response.end("Not found");
  });
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: REALTIME_GATEWAY_MAX_PAYLOAD_BYTES,
  });

  server.on("upgrade", (request, socket, head) => {
    if (closing) {
      rejectUpgrade(socket, 503);
      return;
    }
    const tokenTransport = getTokenTransport(request);
    const token = getTokenFromRequest(request);
    if (!token) {
      logger.warn("airi.realtime.gateway", {
        note: "upgrade_rejected",
        reason: "missing_token",
        tokenTransport,
      });
      rejectUpgrade(socket, 401);
      return;
    }
    let claims: RealtimeTokenClaims;
    let scope: RealtimeScope;
    try {
      claims = options.verifyToken(token);
      scope = getScopeFromClaims(claims);
    } catch {
      logger.warn("airi.realtime.gateway", {
        note: "upgrade_rejected",
        reason: "invalid_token",
        tokenTransport,
      });
      rejectUpgrade(socket, 401);
      return;
    }

    try {
      wss.handleUpgrade(request, socket, head, (client) => {
        installClient(client, claims, scope, tokenTransport);
      });
    } catch {
      rejectUpgrade(socket, 401);
    }
  });

  subscriber.on("reconnecting", loseSubscriberEpoch);
  subscriber.on("end", loseSubscriberEpoch);
  subscriber.on("error", (error) => {
    logger.error("airi.realtime.gateway", error, {
      note: "subscriber_error",
    });
    loseSubscriberEpoch();
  });
  subscriber.on("ready", beginReadiness);
  if (!subscriber.isOpen) await subscriber.connect();

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });
  beginReadiness();

  const address = server.address();
  const listeningPort =
    address && typeof address === "object" ? address.port : port;
  const connectHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  let closePromise: Promise<void> | null = null;
  const close = () => {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      closing = true;
      readinessAttempt += 1;
      subscriberEpoch.markNotReady();
      await subscriber.close?.();
      for (const client of wss.clients) {
        client.terminate();
        void cleanupClient(client);
      }
      await waitForBackendOperations();
      while (pendingControls.size > 0) {
        await Promise.all(Array.from(pendingControls));
      }
      while (pendingCleanups.size > 0) {
        await Promise.all(Array.from(pendingCleanups));
      }
      backendChannels.clear();
      backendCoordinatorsByChannel.clear();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    })();
    return closePromise;
  };

  logger.info("airi.realtime.gateway", {
    note: "started",
    outcome: "listening",
  });
  return {
    port: listeningPort,
    url: `ws://${connectHost}:${listeningPort}`,
    clientsByChannel,
    channelsByClient,
    readSubscriberState: () => subscriberEpoch.read(),
    close,
  };
}

function sendFrame(socket: WebSocket, frame: unknown): void {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(frame));
  }
}

export function getTokenFromUrl(requestUrl: string | undefined): string | null {
  const url = new URL(requestUrl || "/", "http://127.0.0.1");
  return url.searchParams.get("token");
}

export function getTokenFromSubprotocol(
  header: string | string[] | undefined,
): string | null {
  const rawHeader = Array.isArray(header) ? header.join(",") : header;
  if (!rawHeader) return null;

  for (const protocol of rawHeader.split(",")) {
    const value = protocol.trim();
    if (value.startsWith(REALTIME_TOKEN_SUBPROTOCOL_PREFIX)) {
      return value.slice(REALTIME_TOKEN_SUBPROTOCOL_PREFIX.length) || null;
    }
  }

  return null;
}

export function getTokenFromRequest(
  request: Pick<http.IncomingMessage, "headers" | "url">,
): string | null {
  return (
    getTokenFromSubprotocol(request.headers["sec-websocket-protocol"]) ||
    getTokenFromUrl(request.url)
  );
}

export function getTokenTransport(
  request: Pick<http.IncomingMessage, "headers" | "url">,
): GatewayTokenTransport {
  if (getTokenFromSubprotocol(request.headers["sec-websocket-protocol"])) {
    return "subprotocol";
  }
  if (getTokenFromUrl(request.url)) {
    return "query";
  }
  return "missing";
}

function rejectUpgrade(socket: Duplex, status = 401): void {
  socket.write(
    `HTTP/1.1 ${status} Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  );
  socket.destroy();
}

function summarizeRealtimeChannels(channels: string[]) {
  let workspaceChannelCount = 0;
  let conversationChannelCount = 0;
  let unknownChannelCount = 0;

  for (const channel of channels) {
    const parsed = parseRealtimeChannelName(channel);
    if (parsed.kind === "workspace") workspaceChannelCount += 1;
    else if (parsed.kind === "conversation") conversationChannelCount += 1;
    else unknownChannelCount += 1;
  }

  return {
    channelCount: channels.length,
    workspaceChannelCount,
    conversationChannelCount,
    unknownChannelCount,
  };
}

export type RealtimeGatewayShutdownSignalSource = {
  once(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  removeListener(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
};

export async function waitForRealtimeGatewayShutdown(
  signals: RealtimeGatewayShutdownSignalSource = process,
): Promise<void> {
  await new Promise<void>((resolve) => {
    let settled = false;
    const stop = () => {
      if (settled) return;
      settled = true;
      signals.removeListener("SIGINT", stop);
      signals.removeListener("SIGTERM", stop);
      resolve();
    };
    signals.once("SIGINT", stop);
    signals.once("SIGTERM", stop);
  });
}

export async function runRealtimeGatewayServer(): Promise<void> {
  const subscriber = createRealtimeValkeyClient();
  let serverHandle: RealtimeGatewayServerHandle | null = null;
  subscriber.on("error", (error) => {
    airiWorkerLogger.error("airi.realtime.gateway", error, {
      note: "subscriber_client_error",
    });
  });
  try {
    await connectRealtimeValkeyClient(subscriber);
    const parsedPort = Number(process.env.PORT || DEFAULT_PORT);
    serverHandle = await startRealtimeGatewayServer({
      subscriber,
      verifyToken: verifyRealtimeToken,
      port:
        Number.isFinite(parsedPort) && parsedPort > 0
          ? parsedPort
          : DEFAULT_PORT,
      host: "0.0.0.0",
    });
    await waitForRealtimeGatewayShutdown();
  } finally {
    try {
      await serverHandle?.close();
    } finally {
      if (subscriber.isOpen) await subscriber.close();
    }
  }
}
