import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { connect as connectTcp } from "node:net";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { RealtimeTokenClaims } from "./realtime-token.js";
import { WebSocket } from "ws";

import {
  createGatewaySubscriberEpochController,
  getTokenFromRequest,
  getTokenFromSubprotocol,
  getTokenFromUrl,
  getTokenTransport,
  scheduleSignedExpiry,
  startRealtimeGatewayServer,
  waitForRealtimeGatewayShutdown,
  type GatewaySubscriber,
  type GatewayTimeoutHandle,
  type GatewayTimerScheduler,
  type RealtimeGatewayLogger,
  type RealtimeGatewayServerHandle,
} from "./realtime-gateway.js";

const WORKSPACE_ID = "123e4567-e89b-12d3-a456-426614174000";
const OTHER_WORKSPACE_ID = "123e4567-e89b-12d3-a456-426614174001";
const CONVERSATION_ID = "507f1f77bcf86cd799439011";
const SECOND_CONVERSATION_ID = "507f1f77bcf86cd799439012";
const MESSAGE_ID = "507f1f77bcf86cd799439013";
const WORKSPACE_CHANNEL = "workspace:" + WORKSPACE_ID;
const CONVERSATION_CHANNEL =
  "conversation:" + WORKSPACE_ID + ":" + CONVERSATION_ID;
const SECOND_CONVERSATION_CHANNEL =
  "conversation:" + WORKSPACE_ID + ":" + SECOND_CONVERSATION_ID;
const ISSUED_AT_SECONDS = 1_787_270_400;
const EXPIRES_AT_SECONDS = ISSUED_AT_SECONDS + 300;

const LEGACY_WORKSPACE_CLAIMS: RealtimeTokenClaims = {
  kind: "workspace",
  workspaceId: WORKSPACE_ID,
  userId: "user-1",
  source: "dashboard",
  aud: "airi-realtime",
  iat: ISSUED_AT_SECONDS,
  exp: EXPIRES_AT_SECONDS,
};

const LEGACY_CONVERSATION_CLAIMS: RealtimeTokenClaims = {
  kind: "conversation",
  workspaceId: WORKSPACE_ID,
  conversationId: CONVERSATION_ID,
  userId: "user-1",
  source: "widget",
  aud: "airi-realtime",
  iat: ISSUED_AT_SECONDS,
  exp: EXPIRES_AT_SECONDS,
};

function paddedJson(value: unknown, byteLength: number): Buffer {
  const raw = JSON.stringify(value);
  const current = Buffer.byteLength(raw, "utf8");
  assert.ok(current <= byteLength);
  return Buffer.from(raw + " ".repeat(byteLength - current), "utf8");
}

function buildProjectorV3Outer(tagged = false) {
  return {
    type: "event",
    channel: WORKSPACE_CHANNEL,
    event: {
      eventId: "requests-row:v3:source-event-1",
      version: 1,
      name: "conversation.row.changed",
      workspaceId: WORKSPACE_ID,
      conversationId: CONVERSATION_ID,
      createdAt: "2026-08-20T00:00:00.000Z",
      dedupeKey: "requests-row:v3:source-event-1",
      payload: {
        ...(tagged ? { schemaVersion: 3 } : {}),
        conversationId: CONVERSATION_ID,
        changeType: "updated",
        projectionGeneration: "42",
      },
    },
  } as const;
}

function buildOrdinaryLegacyOuter() {
  return {
    type: "event",
    channel: CONVERSATION_CHANNEL,
    event: {
      eventId: "legacy-message-event-1",
      version: 1,
      name: "conversation.message.created",
      workspaceId: WORKSPACE_ID,
      conversationId: CONVERSATION_ID,
      createdAt: "2026-08-20T00:00:00.000Z",
      dedupeKey: "legacy-message-event-1",
      payload: {
        legacyEvent: "new-message",
        conversationId: CONVERSATION_ID,
        messageId: MESSAGE_ID,
      },
    },
  } as const;
}

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(reason?: unknown): void;
};

function createDeferred<T = void>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function eventually(
  predicate: () => boolean,
  message: string,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(message);
}

type SubscriberCall = {
  channel: string;
  listener?: (message: string, channel: string) => void;
};

class FakeGatewaySubscriber extends EventEmitter {
  isOpen = false;
  isReady = false;
  emitReadyOnConnect = false;
  connectCount = 0;
  closeCount = 0;
  readonly subscribeCalls: SubscriberCall[] = [];
  readonly unsubscribeCalls: SubscriberCall[] = [];
  readonly activeChannels = new Set<string>();
  readonly activeListenersByChannel = new Map<
    string,
    Set<(message: string, channel: string) => void>
  >();
  onSubscribe?: (call: SubscriberCall, index: number) => Promise<void> | void;
  onUnsubscribe?: (call: SubscriberCall, index: number) => Promise<void> | void;
  onClose?: () => Promise<void> | void;

  async connect(): Promise<void> {
    this.connectCount += 1;
    this.isOpen = true;
    this.isReady = true;
    if (this.emitReadyOnConnect) this.emit("ready");
  }

  async subscribe(
    channel: string,
    listener: (message: string, channel: string) => void,
  ): Promise<void> {
    const call = { channel, listener };
    const index = this.subscribeCalls.push(call) - 1;
    const listeners = this.activeListenersByChannel.get(channel) || new Set();
    const alreadyRegistered = listeners.has(listener);
    listeners.add(listener);
    this.activeListenersByChannel.set(channel, listeners);
    try {
      await this.onSubscribe?.(call, index);
    } catch (error) {
      if (!alreadyRegistered) listeners.delete(listener);
      if (listeners.size === 0) this.activeListenersByChannel.delete(channel);
      throw error;
    }
    if (!this.isOpen) {
      listeners.delete(listener);
      if (listeners.size === 0) this.activeListenersByChannel.delete(channel);
      throw new Error("subscriber closed during subscribe");
    }
    this.activeChannels.add(channel);
  }

  async unsubscribe(channel: string): Promise<void> {
    const call = { channel };
    const index = this.unsubscribeCalls.push(call) - 1;
    await this.onUnsubscribe?.(call, index);
    this.activeChannels.delete(channel);
    this.activeListenersByChannel.delete(channel);
  }

  publish(channel: string, message: string): void {
    assert.equal(
      this.tryPublish(channel, message),
      true,
      "channel listener must exist",
    );
  }

  tryPublish(channel: string, message: string): boolean {
    const listeners = this.activeListenersByChannel.get(channel);
    if (!listeners?.size) return false;
    for (const listener of listeners) listener(message, channel);
    return true;
  }

  activeListenerCount(channel: string): number {
    return this.activeListenersByChannel.get(channel)?.size || 0;
  }

  subscribeCallCount(channel: string): number {
    return this.subscribeCalls.filter((call) => call.channel === channel)
      .length;
  }

  lose(event: "reconnecting" | "end" | "error"): void {
    this.isReady = false;
    if (event === "error") {
      this.emit(event, new Error("simulated subscriber failure"));
    } else {
      this.emit(event);
    }
  }

  recover(): void {
    this.isReady = true;
    this.emit("ready");
  }

  async close(): Promise<void> {
    this.closeCount += 1;
    this.isOpen = false;
    this.isReady = false;
    this.activeChannels.clear();
    for (const listeners of this.activeListenersByChannel.values()) {
      listeners.clear();
    }
    this.activeListenersByChannel.clear();
    await this.onClose?.();
  }
}

type ScheduledTimer = {
  callback: () => void;
  delayMs: number;
  cancelled: boolean;
  unrefd: boolean;
  handle: GatewayTimeoutHandle;
};

class FakeGatewayTimerScheduler implements GatewayTimerScheduler {
  readonly timers: ScheduledTimer[] = [];

  schedule(callback: () => void, delayMs: number): GatewayTimeoutHandle {
    const timer = {
      callback,
      delayMs,
      cancelled: false,
      unrefd: false,
      handle: {} as GatewayTimeoutHandle,
    };
    timer.handle = {
      unref: () => {
        timer.unrefd = true;
      },
    };
    this.timers.push(timer);
    return timer.handle;
  }

  cancel(handle: GatewayTimeoutHandle): void {
    const timer = this.timers.find((candidate) => candidate.handle === handle);
    if (timer) timer.cancelled = true;
  }

  fire(index: number, evenIfCancelled = false): void {
    const timer = this.timers[index];
    assert.ok(timer, "scheduled timer must exist");
    if (!timer.cancelled || evenIfCancelled) timer.callback();
  }
}

type GatewayLogRecord = {
  level: "info" | "warn" | "error";
  event: string;
  error?: unknown;
  metadata?: Record<string, unknown>;
};

class RecordingGatewayLogger implements RealtimeGatewayLogger {
  readonly records: GatewayLogRecord[] = [];

  info(event: string, metadata?: Record<string, unknown>): void {
    this.records.push({ level: "info", event, metadata });
  }

  warn(event: string, metadata?: Record<string, unknown>): void {
    this.records.push({ level: "warn", event, metadata });
  }

  error(
    event: string,
    error: unknown,
    metadata?: Record<string, unknown>,
  ): void {
    this.records.push({ level: "error", event, error, metadata });
  }

  notes(note: string): GatewayLogRecord[] {
    return this.records.filter((record) => record.metadata?.note === note);
  }
}

type ConnectedSocket = {
  socket: WebSocket;
  frames: unknown[];
  rawMessages: string[];
  close: Promise<{ code: number; reason: string }>;
};

async function connectSocket(
  url: string,
  token: string,
  transport: "subprotocol" | "query" = "subprotocol",
): Promise<ConnectedSocket> {
  const target =
    transport === "query" ? `${url}/?token=${encodeURIComponent(token)}` : url;
  const socket = new WebSocket(
    target,
    transport === "subprotocol" ? [`airi-realtime-token.${token}`] : undefined,
  );
  const frames: unknown[] = [];
  const rawMessages: string[] = [];
  socket.on("message", (data) => {
    const raw = data.toString("utf8");
    rawMessages.push(raw);
    frames.push(JSON.parse(raw) as unknown);
  });
  const close = new Promise<{ code: number; reason: string }>((resolve) => {
    socket.once("close", (code, reason) => {
      resolve({ code, reason: reason.toString("utf8") });
    });
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
    socket.once("unexpected-response", (_request, response) => {
      reject(new Error(`unexpected upgrade response ${response.statusCode}`));
    });
  });
  return { socket, frames, rawMessages, close };
}

async function expectUpgradeStatus(
  url: string,
  token: string,
  expectedStatus: number,
): Promise<void> {
  const socket = new WebSocket(`${url}/?token=${encodeURIComponent(token)}`);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => reject(new Error("upgrade unexpectedly opened")));
    socket.once("error", () => undefined);
    socket.once("unexpected-response", (_request, response) => {
      response.resume();
      try {
        assert.equal(response.statusCode, expectedStatus);
        resolve();
      } catch (error) {
        reject(error);
      }
    });
  });
}

function readServerCloseCode(data: Buffer): number | null {
  let offset = 0;
  while (offset + 2 <= data.length) {
    const first = data[offset];
    const second = data[offset + 1];
    let payloadLength = second & 0x7f;
    let headerLength = 2;
    if (payloadLength === 126) {
      if (offset + 4 > data.length) return null;
      payloadLength = data.readUInt16BE(offset + 2);
      headerLength = 4;
    } else if (payloadLength === 127) {
      if (offset + 10 > data.length) return null;
      const length = data.readBigUInt64BE(offset + 2);
      if (length > BigInt(Number.MAX_SAFE_INTEGER)) return null;
      payloadLength = Number(length);
      headerLength = 10;
    }
    if (offset + headerLength + payloadLength > data.length) return null;
    if ((first & 0x0f) === 0x08) {
      return payloadLength >= 2
        ? data.readUInt16BE(offset + headerLength)
        : 1005;
    }
    offset += headerLength + payloadLength;
  }
  return null;
}

async function sendInvalidUtf8CloseReason(
  gatewayUrl: string,
  token: string,
): Promise<number> {
  const url = new URL(gatewayUrl);
  const socket = connectTcp({
    host: url.hostname,
    port: Number(url.port),
  });
  let received = Buffer.alloc(0);
  const onData = (chunk: Buffer) => {
    received = Buffer.concat([received, chunk]);
  };
  socket.on("data", onData);
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    socket.write(
      [
        `GET /?token=${encodeURIComponent(token)} HTTP/1.1`,
        `Host: ${url.host}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
        "Sec-WebSocket-Version: 13",
        "",
        "",
      ].join("\r\n"),
    );
    await eventually(
      () => received.includes(Buffer.from("\r\n\r\n")),
      "raw websocket handshake did not complete",
    );
    const headerEnd = received.indexOf(Buffer.from("\r\n\r\n")) + 4;
    received = received.subarray(headerEnd);

    const payload = Buffer.from([0x03, 0xe8, 0xc3, 0x28]);
    const mask = Buffer.from([0x11, 0x22, 0x33, 0x44]);
    const masked = Buffer.from(
      payload.map((value, index) => value ^ mask[index % mask.length]),
    );
    socket.write(Buffer.concat([Buffer.from([0x88, 0x84]), mask, masked]));
    await eventually(
      () => readServerCloseCode(received) !== null,
      "server did not answer an invalid close reason",
    );
    return readServerCloseCode(received) as number;
  } finally {
    socket.destroy();
  }
}

function sendJson(socket: WebSocket, value: unknown): void {
  socket.send(JSON.stringify(value));
}

async function waitForFrame(
  connected: ConnectedSocket,
  predicate: (frame: unknown) => boolean,
  message: string,
): Promise<unknown> {
  await eventually(() => connected.frames.some(predicate), message);
  return connected.frames.find(predicate);
}

function isFrameType(value: unknown, type: string): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    (value as { type?: unknown }).type === type
  );
}

function waitForFrameType(
  connected: ConnectedSocket,
  type: string,
  message: string,
): Promise<unknown> {
  return waitForFrame(connected, (frame) => isFrameType(frame, type), message);
}

const SERVER_ERROR_FRAME = {
  type: "error",
  code: "server_error",
  message: "Realtime frame failed",
};

const FORBIDDEN_CHANNEL_FRAME = {
  type: "error",
  code: "forbidden_channel",
  message: "One or more channels are outside token scope",
};

type GatewayHarness = {
  server: RealtimeGatewayServerHandle;
  subscriber: FakeGatewaySubscriber;
  logger: RecordingGatewayLogger;
  timers: FakeGatewayTimerScheduler;
};

type GatewayHarnessOptions = {
  subscriber?: FakeGatewaySubscriber;
  logger?: RecordingGatewayLogger;
  timers?: FakeGatewayTimerScheduler;
  claimsByToken?: ReadonlyMap<string, RealtimeTokenClaims>;
};

async function startGatewayHarness(
  options: GatewayHarnessOptions = {},
): Promise<GatewayHarness> {
  const subscriber = options.subscriber || new FakeGatewaySubscriber();
  const logger = options.logger || new RecordingGatewayLogger();
  const timers = options.timers || new FakeGatewayTimerScheduler();
  const claimsByToken =
    options.claimsByToken ||
    new Map<string, RealtimeTokenClaims>([
      ["workspace-token", LEGACY_WORKSPACE_CLAIMS],
      [
        "conversation-token",
        {
          kind: "conversation",
          workspaceId: WORKSPACE_ID,
          conversationId: CONVERSATION_ID,
          userId: "user-1",
          source: "mobile",
          aud: "airi-realtime",
          iat: ISSUED_AT_SECONDS,
          exp: EXPIRES_AT_SECONDS,
        },
      ],
      ["widget-token", LEGACY_CONVERSATION_CLAIMS],
    ]);
  const server = await startRealtimeGatewayServer({
    subscriber: subscriber as GatewaySubscriber,
    verifyToken: (token) => {
      const claims = claimsByToken.get(token);
      if (!claims) throw new Error("raw verifier error for " + token);
      return claims;
    },
    logger,
    host: "127.0.0.1",
    port: 0,
    now: () => ISSUED_AT_SECONDS * 1_000,
    timerScheduler: timers,
  });
  return { server, subscriber, logger, timers };
}

async function closeHarness(
  harness: GatewayHarness | undefined,
  sockets: ConnectedSocket[] = [],
): Promise<void> {
  for (const connected of sockets) {
    if (
      connected.socket.readyState === WebSocket.OPEN ||
      connected.socket.readyState === WebSocket.CONNECTING
    ) {
      connected.socket.terminate();
    }
  }
  await harness?.server.close();
}

// Starts a harness for one test and, even when the test throws, closes every
// socket the test pushed and then the server. Tests that must release their
// own gates first keep an explicit try/finally.
async function withGateway(
  options: GatewayHarnessOptions,
  run: (harness: GatewayHarness, sockets: ConnectedSocket[]) => Promise<void>,
): Promise<void> {
  let harness: GatewayHarness | undefined;
  const sockets: ConnectedSocket[] = [];
  try {
    harness = await startGatewayHarness(options);
    await run(harness, sockets);
  } finally {
    await closeHarness(harness, sockets);
  }
}

// Connects, registers the socket for cleanup, then waits for its ready frame.
async function connectReady(
  harness: GatewayHarness,
  sockets: ConnectedSocket[],
  token: string,
  readyMessage: string,
  transport?: "subprotocol" | "query",
): Promise<ConnectedSocket> {
  const connected = await connectSocket(harness.server.url, token, transport);
  sockets.push(connected);
  await waitForFrameType(connected, "ready", readyMessage);
  return connected;
}

// Connects a socket and waits until the gateway acknowledges its subscription.
async function connectSubscribed(
  harness: GatewayHarness,
  sockets: ConnectedSocket[],
  token: string,
  channels: string[],
): Promise<ConnectedSocket> {
  const connected = await connectReady(
    harness,
    sockets,
    token,
    `${token} socket was not ready`,
    "query",
  );
  sendJson(connected.socket, { type: "subscribe", channels });
  await waitForFrameType(
    connected,
    "subscribed",
    `${token} subscription was not acknowledged`,
  );
  return connected;
}

function readyzUrl(harness: GatewayHarness): string {
  return harness.server.url.replace(/^ws:/, "http:") + "/readyz";
}

async function waitForReadyEpoch(
  harness: GatewayHarness,
  epoch: number,
): Promise<void> {
  await eventually(
    () =>
      harness.server.readSubscriberState().readiness === "ready" &&
      harness.server.readSubscriberState().epoch === epoch,
    `subscriber did not reach ready epoch ${epoch}`,
  );
}

test("extracts realtime token from websocket subprotocol", () => {
  assert.equal(
    getTokenFromSubprotocol("airi-realtime, airi-realtime-token.signed-token"),
    "signed-token",
  );
});

test("prefers websocket subprotocol token over legacy query token", () => {
  assert.equal(
    getTokenFromRequest({
      headers: {
        "sec-websocket-protocol":
          "airi-realtime, airi-realtime-token.subprotocol-token",
      },
      url: "/?token=query-token",
    }),
    "subprotocol-token",
  );
});

test("keeps accepting legacy realtime token query param", () => {
  assert.equal(getTokenFromUrl("/?token=query-token"), "query-token");
  assert.equal(
    getTokenFromRequest({
      headers: {},
      url: "/?token=query-token",
    }),
    "query-token",
  );
});

test("classifies realtime token transport for gateway logs", () => {
  assert.equal(
    getTokenTransport({
      headers: {
        "sec-websocket-protocol":
          "airi-realtime, airi-realtime-token.subprotocol-token",
      },
      url: "/?token=query-token",
    }),
    "subprotocol",
  );
  assert.equal(
    getTokenTransport({
      headers: {},
      url: "/?token=query-token",
    }),
    "query",
  );
  assert.equal(
    getTokenTransport({
      headers: {},
      url: "/",
    }),
    "missing",
  );
});

test("derives the socket expiry timer from the signed exp", () => {
  const scheduler = new FakeGatewayTimerScheduler();
  const closes: Array<{ code: number; reason: string }> = [];
  const cleanup = scheduleSignedExpiry(
    {
      close: (code, reason) => {
        closes.push({ code: code ?? 0, reason: reason?.toString() || "" });
      },
    },
    EXPIRES_AT_SECONDS,
    {
      now: () => ISSUED_AT_SECONDS * 1_000,
      timerScheduler: scheduler,
    },
  );

  assert.equal(closes.length, 0);
  assert.equal(scheduler.timers.length, 1);
  assert.equal(
    scheduler.timers[0]?.delayMs,
    (EXPIRES_AT_SECONDS - ISSUED_AT_SECONDS) * 1_000,
  );
  assert.equal(scheduler.timers[0]?.unrefd, true);
  scheduler.fire(0);
  assert.deepEqual(closes, [{ code: 1008, reason: "token_expired" }]);

  cleanup();
  cleanup();
  scheduler.fire(0, true);
  assert.equal(closes.length, 1, "expiry raced cleanup");
});

test("normal close cancels signed expiry without a late close effect", () => {
  const scheduler = new FakeGatewayTimerScheduler();
  const closes: unknown[] = [];
  const cleanup = scheduleSignedExpiry(
    {
      close: (...args) => {
        closes.push(args);
      },
    },
    EXPIRES_AT_SECONDS,
    {
      now: () => ISSUED_AT_SECONDS * 1_000,
      timerScheduler: scheduler,
    },
  );
  cleanup();
  assert.equal(scheduler.timers[0]?.cancelled, true);
  scheduler.fire(0, true);
  assert.equal(closes.length, 0);
});

test("establishes monotonic subscriber epochs", () => {
  const controller = createGatewaySubscriberEpochController();

  assert.deepEqual(controller.read(), { readiness: "not_ready", epoch: 0 });
  assert.deepEqual(controller.markReady(), { readiness: "ready", epoch: 1 });
  assert.deepEqual(controller.markReady(), { readiness: "ready", epoch: 1 });
  assert.deepEqual(controller.markNotReady(), {
    readiness: "not_ready",
    epoch: 1,
  });
  assert.deepEqual(controller.markNotReady(), {
    readiness: "not_ready",
    epoch: 1,
  });
  assert.deepEqual(controller.markReady(), { readiness: "ready", epoch: 2 });
});

test("reports readyz from subscriber readiness while sockets keep connecting", async () => {
  await withGateway({}, async (harness, sockets) => {
    await waitForReadyEpoch(harness, 1);
    const ready = await fetch(readyzUrl(harness));
    assert.equal(ready.status, 200);
    assert.deepEqual(await ready.json(), {
      ok: true,
      subscriberReady: true,
      channels: 0,
      clients: 0,
    });

    harness.subscriber.lose("reconnecting");
    assert.deepEqual(harness.server.readSubscriberState(), {
      readiness: "not_ready",
      epoch: 1,
    });
    assert.equal((await fetch(readyzUrl(harness))).status, 503);
    assert.equal(
      (await fetch(readyzUrl(harness).replace(/readyz$/, "healthz"))).status,
      200,
    );
    await connectReady(
      harness,
      sockets,
      "workspace-token",
      "socket admission was gated by subscriber readiness",
      "query",
    );

    harness.subscriber.recover();
    await waitForReadyEpoch(harness, 2);
    assert.equal((await fetch(readyzUrl(harness))).status, 200);
  });
});

test("coalesces repeated ready signals into one recovery re-subscribe", async () => {
  const gate = createDeferred<void>();
  let harness: GatewayHarness | undefined;
  const sockets: ConnectedSocket[] = [];
  try {
    harness = await startGatewayHarness();
    await connectSubscribed(harness, sockets, "conversation-token", [
      CONVERSATION_CHANNEL,
    ]);
    harness.subscriber.onSubscribe = async () => gate.promise;

    harness.subscriber.lose("reconnecting");
    harness.subscriber.recover();
    harness.subscriber.recover();
    await eventually(
      () => harness?.subscriber.subscribeCallCount(CONVERSATION_CHANNEL) === 2,
      "recovery re-subscribe did not start",
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(
      harness.subscriber.subscribeCallCount(CONVERSATION_CHANNEL),
      2,
    );

    gate.resolve(undefined);
    await waitForReadyEpoch(harness, 2);
    assert.equal(
      harness.subscriber.subscribeCallCount(CONVERSATION_CHANNEL),
      2,
    );
  } finally {
    gate.resolve(undefined);
    await closeHarness(harness, sockets);
  }
});

test("logs only bounded passive client contracts on live open and close paths", async () => {
  const logger = new RecordingGatewayLogger();
  const claimsByToken = new Map<string, RealtimeTokenClaims>([
    ["legacy-missing-token", LEGACY_WORKSPACE_CLAIMS],
    [
      "dashboard-v1-token",
      { ...LEGACY_WORKSPACE_CLAIMS, clientContract: "dashboard-v1" },
    ],
    [
      "unknown-contract-token",
      {
        ...LEGACY_WORKSPACE_CLAIMS,
        clientContract: "future-contract-raw-sentinel",
      },
    ],
    [
      "retired-requests-contract-token",
      { ...LEGACY_WORKSPACE_CLAIMS, clientContract: "requests-v1" },
    ],
    [
      "mobile-token",
      {
        ...LEGACY_CONVERSATION_CLAIMS,
        source: "mobile",
      },
    ],
    ["widget-token", LEGACY_CONVERSATION_CLAIMS],
  ]);
  await withGateway({ logger, claimsByToken }, async (harness, sockets) => {
    sockets.push(
      await connectSocket(harness.server.url, "legacy-missing-token"),
      await connectSocket(harness.server.url, "dashboard-v1-token"),
      await connectSocket(harness.server.url, "unknown-contract-token"),
      await connectSocket(
        harness.server.url,
        "retired-requests-contract-token",
      ),
      await connectSocket(harness.server.url, "mobile-token", "query"),
      await connectSocket(harness.server.url, "widget-token", "query"),
    );
    for (const connected of sockets) {
      await waitForFrameType(
        connected,
        "ready",
        "labeled socket did not reach ready",
      );
      connected.socket.close(1000, "test_complete");
    }
    await Promise.all(sockets.map((connected) => connected.close));
    await eventually(
      () => logger.notes("connection_closed").length === sockets.length,
      "labeled connection summaries did not close",
    );

    const project = (note: "connection_opened" | "connection_closed") =>
      logger
        .notes(note)
        .map((record) => ({
          scopeKind: record.metadata?.scopeKind,
          tokenSource: record.metadata?.tokenSource,
          tokenTransport: record.metadata?.tokenTransport,
          clientContract: record.metadata?.clientContract,
        }))
        .sort((left, right) =>
          JSON.stringify(left).localeCompare(JSON.stringify(right)),
        );
    const dashboardWorkspace = {
      scopeKind: "workspace",
      tokenSource: "dashboard",
      tokenTransport: "subprotocol",
    };
    const expected = [
      { ...dashboardWorkspace, clientContract: "legacy-missing" },
      { ...dashboardWorkspace, clientContract: "dashboard-v1" },
      { ...dashboardWorkspace, clientContract: "legacy-missing" },
      { ...dashboardWorkspace, clientContract: "legacy-missing" },
      {
        scopeKind: "conversation",
        tokenSource: "mobile",
        tokenTransport: "query",
        clientContract: "legacy-missing",
      },
      {
        scopeKind: "conversation",
        tokenSource: "widget",
        tokenTransport: "query",
        clientContract: "legacy-missing",
      },
    ].sort((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right)),
    );

    assert.deepEqual(project("connection_opened"), expected);
    assert.deepEqual(project("connection_closed"), expected);
    assert.equal(
      JSON.stringify(logger.records).includes("future-contract-raw-sentinel"),
      false,
    );
  });
});

test("keeps unverified claims and unknown token sources out of connection logs", async () => {
  const logger = new RecordingGatewayLogger();
  const rawSource = "future-source-raw-sentinel";
  const invalidToken = "invalid-token-raw-sentinel";
  const claimsByToken = new Map<string, RealtimeTokenClaims>([
    [
      "unknown-source-token",
      {
        ...LEGACY_WORKSPACE_CLAIMS,
        source: rawSource as RealtimeTokenClaims["source"],
        clientContract: "future-contract-raw-sentinel",
      },
    ],
  ]);
  await withGateway({ logger, claimsByToken }, async (harness, sockets) => {
    const connected = await connectReady(
      harness,
      sockets,
      "unknown-source-token",
      "unknown-source socket did not reach ready",
    );
    await expectUpgradeStatus(harness.server.url, invalidToken, 401);
    connected.socket.close(1000, "test_complete");
    await connected.close;
    await eventually(
      () => logger.notes("connection_closed").length > 0,
      "unknown-source close summary was not recorded",
    );

    const serialized = JSON.stringify(logger.records);
    for (const forbidden of [
      rawSource,
      invalidToken,
      "future-contract-raw-sentinel",
      "unknown-source-token",
      WORKSPACE_ID,
      CONVERSATION_ID,
      "ws://",
      "token=",
    ]) {
      assert.equal(serialized.includes(forbidden), false, forbidden);
    }
    for (const record of [
      ...logger.notes("connection_opened"),
      ...logger.notes("connection_closed"),
    ]) {
      assert.equal(record.metadata?.tokenSource, null);
      assert.equal(record.metadata?.clientContract, "legacy-missing");
    }
  });
});

test("passive labels cannot widen a workspace token to conversation channels", async () => {
  const claimsByToken = new Map<string, RealtimeTokenClaims>([
    ["missing-label-token", LEGACY_WORKSPACE_CLAIMS],
    [
      "dashboard-label-token",
      { ...LEGACY_WORKSPACE_CLAIMS, clientContract: "dashboard-v1" },
    ],
    [
      "unknown-label-token",
      { ...LEGACY_WORKSPACE_CLAIMS, clientContract: "future-contract" },
    ],
  ]);
  await withGateway({ claimsByToken }, async (harness, sockets) => {
    for (const token of claimsByToken.keys()) {
      sockets.push(await connectSocket(harness.server.url, token));
    }
    const requested = [
      WORKSPACE_CHANNEL,
      CONVERSATION_CHANNEL,
      `conversation:${OTHER_WORKSPACE_ID}:${CONVERSATION_ID}`,
    ];
    for (const connected of sockets) {
      await waitForFrameType(
        connected,
        "ready",
        "workspace label case did not reach ready",
      );
      sendJson(connected.socket, { type: "subscribe", channels: requested });
    }
    for (const connected of sockets) {
      await waitForFrameType(
        connected,
        "subscribed",
        "workspace label case did not acknowledge subscribe",
      );
    }

    assert.deepEqual(
      sockets.map((connected) =>
        connected.frames.filter(
          (frame) =>
            isFrameType(frame, "error") || isFrameType(frame, "subscribed"),
        ),
      ),
      Array.from({ length: sockets.length }, () => [
        FORBIDDEN_CHANNEL_FRAME,
        { type: "subscribed", channels: [WORKSPACE_CHANNEL] },
      ]),
    );
  });
});

test("preserves partial subscribe/unsubscribe and exact broker bytes for every scope", async () => {
  await withGateway({}, async (harness, sockets) => {
    const ordinaryRaw = ` ${JSON.stringify(buildOrdinaryLegacyOuter())} `;
    const workspaceRaw = ` ${JSON.stringify({
      ...buildOrdinaryLegacyOuter(),
      channel: WORKSPACE_CHANNEL,
    })} `;
    const cases = [
      {
        name: "workspace",
        connected: await connectSocket(
          harness.server.url,
          "workspace-token",
          "query",
        ),
        requested: [
          WORKSPACE_CHANNEL,
          CONVERSATION_CHANNEL,
          "conversation:" + OTHER_WORKSPACE_ID + ":" + CONVERSATION_ID,
        ],
        allowed: [WORKSPACE_CHANNEL],
        expectedRaw: workspaceRaw,
      },
      {
        name: "conversation",
        connected: await connectSocket(
          harness.server.url,
          "conversation-token",
          "query",
        ),
        requested: [CONVERSATION_CHANNEL, SECOND_CONVERSATION_CHANNEL],
        allowed: [CONVERSATION_CHANNEL],
        expectedRaw: ordinaryRaw,
      },
      {
        name: "widget",
        connected: await connectSocket(
          harness.server.url,
          "widget-token",
          "query",
        ),
        requested: [CONVERSATION_CHANNEL, WORKSPACE_CHANNEL],
        allowed: [CONVERSATION_CHANNEL],
        expectedRaw: ordinaryRaw,
      },
    ];
    sockets.push(...cases.map((entry) => entry.connected));
    for (const entry of cases) {
      await waitForFrameType(
        entry.connected,
        "ready",
        `${entry.name} ready was not sent`,
      );
      sendJson(entry.connected.socket, {
        type: "subscribe",
        channels: entry.requested,
      });
      await eventually(
        () =>
          entry.connected.frames.some((frame) =>
            isFrameType(frame, "subscribed"),
          ),
        `${entry.name} subscribe was not acknowledged`,
      );
      const controlFrames = entry.connected.frames.filter(
        (frame) =>
          isFrameType(frame, "error") || isFrameType(frame, "subscribed"),
      );
      assert.deepEqual(controlFrames, [
        FORBIDDEN_CHANNEL_FRAME,
        { type: "subscribed", channels: entry.allowed },
      ]);
    }

    harness.subscriber.publish(WORKSPACE_CHANNEL, workspaceRaw);
    harness.subscriber.publish(CONVERSATION_CHANNEL, ordinaryRaw);
    for (const entry of cases) {
      await eventually(
        () => entry.connected.rawMessages.includes(entry.expectedRaw),
        `${entry.name} broker bytes changed or were not delivered`,
      );
    }
    assert.equal(cases[0]?.connected.rawMessages.includes(ordinaryRaw), false);
    assert.equal(cases[1]?.connected.rawMessages.includes(workspaceRaw), false);
    assert.equal(cases[2]?.connected.rawMessages.includes(workspaceRaw), false);

    for (const entry of cases) {
      const startIndex = entry.connected.frames.length;
      sendJson(entry.connected.socket, {
        type: "unsubscribe",
        channels: entry.requested,
      });
      await eventually(
        () =>
          entry.connected.frames.some((frame) =>
            isFrameType(frame, "unsubscribed"),
          ),
        `${entry.name} unsubscribe was not acknowledged`,
      );
      const tail = entry.connected.frames
        .slice(startIndex)
        .filter(
          (frame) =>
            isFrameType(frame, "error") || isFrameType(frame, "unsubscribed"),
        );
      assert.deepEqual(tail, [
        FORBIDDEN_CHANNEL_FRAME,
        { type: "unsubscribed", channels: entry.allowed },
      ]);
    }
  });
});

test("forwards projector row changes on the wire byte for byte", async () => {
  const logger = new RecordingGatewayLogger();
  await withGateway({ logger }, async (harness, sockets) => {
    const workspace = await connectSubscribed(
      harness,
      sockets,
      "workspace-token",
      [WORKSPACE_CHANNEL],
    );
    const forwarded = JSON.stringify(buildProjectorV3Outer());
    harness.subscriber.publish(WORKSPACE_CHANNEL, forwarded);

    await eventually(
      () => workspace.rawMessages.includes(forwarded),
      "row change was not forwarded byte for byte",
    );
    assert.equal(
      workspace.frames.filter((frame) => isFrameType(frame, "event")).length,
      1,
    );
    assert.deepEqual(
      logger.notes("broker_delivery").map((record) => ({
        deliveredCount: record.metadata?.deliveredCount,
        droppedCount: record.metadata?.droppedCount,
      })),
      [{ deliveredCount: 1, droppedCount: 0 }],
    );
  });
});

test("does not subscribe or fan out a forbidden second channel", async () => {
  const subscriber = new FakeGatewaySubscriber();
  await withGateway({ subscriber }, async (harness, sockets) => {
    const workspace = await connectSubscribed(
      harness,
      sockets,
      "workspace-token",
      [WORKSPACE_CHANNEL],
    );

    sendJson(workspace.socket, {
      type: "subscribe",
      channels: [CONVERSATION_CHANNEL],
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(subscriber.subscribeCallCount(CONVERSATION_CHANNEL), 0);
    assert.deepEqual(
      workspace.frames.filter(
        (frame) =>
          isFrameType(frame, "error") || isFrameType(frame, "subscribed"),
      ),
      [
        { type: "subscribed", channels: [WORKSPACE_CHANNEL] },
        FORBIDDEN_CHANNEL_FRAME,
      ],
    );
    const forbiddenRaw = ` \r\n${JSON.stringify(buildOrdinaryLegacyOuter())}\n`;
    assert.equal(
      subscriber.tryPublish(CONVERSATION_CHANNEL, forbiddenRaw),
      false,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(workspace.rawMessages.includes(forbiddenRaw), false);
  });
});

test("does not attach or retain a socket closed during backend subscribe", async () => {
  const gate = createDeferred<void>();
  const subscriber = new FakeGatewaySubscriber();
  subscriber.onSubscribe = async () => gate.promise;
  let harness: GatewayHarness | undefined;
  const sockets: ConnectedSocket[] = [];
  try {
    harness = await startGatewayHarness({ subscriber });
    const workspace = await connectReady(
      harness,
      sockets,
      "workspace-token",
      "pending socket was not ready",
      "query",
    );
    sendJson(workspace.socket, {
      type: "subscribe",
      channels: [WORKSPACE_CHANNEL],
    });
    await eventually(
      () => subscriber.subscribeCalls.length === 1,
      "pending backend subscribe did not start",
    );

    workspace.socket.close(1000, "test_close");
    assert.deepEqual(await workspace.close, {
      code: 1000,
      reason: "test_close",
    });
    await eventually(
      () => harness?.server.channelsByClient.size === 0,
      "closed socket cleanup did not finish before subscribe release",
    );
    gate.resolve(undefined);
    await eventually(
      () => subscriber.unsubscribeCalls.length === 1,
      "stale reservation did not release the backend channel",
    );
    assert.equal(harness.server.clientsByChannel.size, 0);
    assert.equal(harness.server.channelsByClient.size, 0);
    assert.equal(subscriber.activeChannels.size, 0);
  } finally {
    gate.resolve(undefined);
    await closeHarness(harness, sockets);
  }
});

test("does not attach or retain a socket expired during backend subscribe", async () => {
  const gate = createDeferred<void>();
  const subscriber = new FakeGatewaySubscriber();
  subscriber.onSubscribe = async () => gate.promise;
  const timers = new FakeGatewayTimerScheduler();
  let harness: GatewayHarness | undefined;
  const sockets: ConnectedSocket[] = [];
  try {
    harness = await startGatewayHarness({ subscriber, timers });
    const workspace = await connectReady(
      harness,
      sockets,
      "workspace-token",
      "expiring socket was not ready",
      "query",
    );
    sendJson(workspace.socket, {
      type: "subscribe",
      channels: [WORKSPACE_CHANNEL],
    });
    await eventually(
      () => subscriber.subscribeCalls.length === 1,
      "expiring backend subscribe did not start",
    );

    timers.fire(0);
    assert.deepEqual(await workspace.close, {
      code: 1008,
      reason: "token_expired",
    });
    await eventually(
      () => harness?.server.channelsByClient.size === 0,
      "expired socket cleanup did not finish before subscribe release",
    );
    gate.resolve(undefined);
    await eventually(
      () => subscriber.unsubscribeCalls.length === 1,
      "expired reservation did not release the backend channel",
    );
    assert.equal(harness.server.clientsByChannel.size, 0);
    assert.equal(harness.server.channelsByClient.size, 0);
    assert.equal(subscriber.activeChannels.size, 0);
  } finally {
    gate.resolve(undefined);
    await closeHarness(harness, sockets);
  }
});

test("shares one in-flight backend subscription across concurrent sockets", async () => {
  const gate = createDeferred<void>();
  const subscriber = new FakeGatewaySubscriber();
  subscriber.onSubscribe = async (_call, index) => {
    if (index === 0) await gate.promise;
  };
  let harness: GatewayHarness | undefined;
  const sockets: ConnectedSocket[] = [];
  try {
    harness = await startGatewayHarness({ subscriber });
    const first = await connectReady(
      harness,
      sockets,
      "workspace-token",
      "first socket was not ready",
      "query",
    );
    const second = await connectReady(
      harness,
      sockets,
      "workspace-token",
      "second socket was not ready",
      "query",
    );

    for (const connected of [first, second]) {
      sendJson(connected.socket, {
        type: "subscribe",
        channels: [WORKSPACE_CHANNEL],
      });
    }
    await eventually(
      () => subscriber.subscribeCalls.length === 1,
      "shared backend subscribe did not start",
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(subscriber.subscribeCalls.length, 1);
    assert.equal(harness.server.clientsByChannel.size, 0);
    assert.equal(
      [...harness.server.channelsByClient.values()].every(
        (channels) => channels.size === 0,
      ),
      true,
      "in-flight waiters must remain reservations rather than confirmed members",
    );
    assert.equal(
      [...first.frames, ...second.frames].some((frame) =>
        isFrameType(frame, "subscribed"),
      ),
      false,
    );

    gate.resolve(undefined);
    await Promise.all([
      waitForFrameType(
        first,
        "subscribed",
        "first shared subscription was not acknowledged",
      ),
      waitForFrameType(
        second,
        "subscribed",
        "second shared subscription was not acknowledged",
      ),
    ]);
    assert.equal(subscriber.subscribeCalls.length, 1);
    assert.equal(
      harness.server.clientsByChannel.get(WORKSPACE_CHANNEL)?.size,
      2,
    );
  } finally {
    gate.resolve(undefined);
    await closeHarness(harness, sockets);
  }
});

test("keeps one of two pending waiters alive when the other closes", async () => {
  const gate = createDeferred<void>();
  const subscriber = new FakeGatewaySubscriber();
  subscriber.onSubscribe = async (_call, index) => {
    if (index === 0) await gate.promise;
  };
  let harness: GatewayHarness | undefined;
  const sockets: ConnectedSocket[] = [];
  try {
    harness = await startGatewayHarness({ subscriber });
    const first = await connectReady(
      harness,
      sockets,
      "workspace-token",
      "first pending waiter was not ready",
      "query",
    );
    const second = await connectReady(
      harness,
      sockets,
      "workspace-token",
      "second pending waiter was not ready",
      "query",
    );
    for (const connected of [first, second]) {
      sendJson(connected.socket, {
        type: "subscribe",
        channels: [WORKSPACE_CHANNEL],
      });
    }
    await eventually(
      () => subscriber.subscribeCalls.length === 1,
      "shared pending subscription did not start",
    );
    assert.equal(harness.server.clientsByChannel.size, 0);

    first.socket.close(1000, "test_close");
    assert.deepEqual(await first.close, {
      code: 1000,
      reason: "test_close",
    });
    gate.resolve(undefined);
    await waitForFrameType(
      second,
      "subscribed",
      "surviving pending waiter was not acknowledged",
    );
    await eventually(
      () => harness?.server.channelsByClient.size === 1,
      "closed pending waiter was not cleaned up",
    );
    assert.equal(
      harness.server.clientsByChannel.get(WORKSPACE_CHANNEL)?.size,
      1,
    );
    assert.equal(subscriber.unsubscribeCalls.length, 0);
    assert.equal(subscriber.activeChannels.has(WORKSPACE_CHANNEL), true);
  } finally {
    gate.resolve(undefined);
    await closeHarness(harness, sockets);
  }
});

test("reports one failed in-flight backend subscription to every waiting socket", async () => {
  const gate = createDeferred<void>();
  const subscriber = new FakeGatewaySubscriber();
  subscriber.onSubscribe = async (_call, index) => {
    if (index === 0) {
      await gate.promise;
      throw new Error("raw shared subscribe failure");
    }
  };
  let harness: GatewayHarness | undefined;
  const sockets: ConnectedSocket[] = [];
  try {
    harness = await startGatewayHarness({ subscriber });
    const first = await connectReady(
      harness,
      sockets,
      "workspace-token",
      "first socket was not ready",
      "query",
    );
    const second = await connectReady(
      harness,
      sockets,
      "workspace-token",
      "second socket was not ready",
      "query",
    );
    for (const connected of [first, second]) {
      sendJson(connected.socket, {
        type: "subscribe",
        channels: [WORKSPACE_CHANNEL],
      });
    }
    await eventually(
      () => subscriber.subscribeCalls.length === 1,
      "shared failing backend subscribe did not start",
    );
    gate.resolve(undefined);

    for (const connected of [first, second]) {
      await waitForFrameType(
        connected,
        "error",
        "failed subscription was not reported",
      );
    }
    assert.deepEqual(
      [...first.frames, ...second.frames].filter(
        (frame) =>
          isFrameType(frame, "error") || isFrameType(frame, "subscribed"),
      ),
      [SERVER_ERROR_FRAME, SERVER_ERROR_FRAME],
    );
    assert.equal(subscriber.subscribeCalls.length, 1);
    assert.equal(subscriber.unsubscribeCalls.length, 0);
    assert.equal(harness.server.clientsByChannel.size, 0);
    assert.equal(first.socket.readyState, WebSocket.OPEN);
    assert.equal(second.socket.readyState, WebSocket.OPEN);
    assert.deepEqual(harness.server.readSubscriberState(), {
      readiness: "ready",
      epoch: 1,
    });
  } finally {
    gate.resolve(undefined);
    await closeHarness(harness, sockets);
  }
});

test("serializes last-detach unsubscribe against a concurrent new attach", async () => {
  const unsubscribeGate = createDeferred<void>();
  const operationOrder: string[] = [];
  const subscriber = new FakeGatewaySubscriber();
  subscriber.onSubscribe = (call) => {
    operationOrder.push("subscribe:" + call.channel);
  };
  subscriber.onUnsubscribe = async (call) => {
    operationOrder.push("unsubscribe:" + call.channel);
    await unsubscribeGate.promise;
  };
  let harness: GatewayHarness | undefined;
  const sockets: ConnectedSocket[] = [];
  try {
    harness = await startGatewayHarness({ subscriber });
    const first = await connectSubscribed(
      harness,
      sockets,
      "conversation-token",
      [CONVERSATION_CHANNEL],
    );
    const second = await connectReady(
      harness,
      sockets,
      "conversation-token",
      "second socket was not ready",
      "query",
    );

    sendJson(first.socket, {
      type: "unsubscribe",
      channels: [CONVERSATION_CHANNEL],
    });
    await eventually(
      () => subscriber.unsubscribeCalls.length === 1,
      "last-detach unsubscribe did not start",
    );

    sendJson(second.socket, {
      type: "subscribe",
      channels: [CONVERSATION_CHANNEL],
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(
      second.frames.some((frame) => isFrameType(frame, "subscribed")),
      false,
    );
    assert.equal(subscriber.subscribeCallCount(CONVERSATION_CHANNEL), 1);

    unsubscribeGate.resolve(undefined);
    await waitForFrameType(
      second,
      "subscribed",
      "new attachment was not acknowledged after unsubscribe serialization",
    );
    assert.equal(subscriber.subscribeCallCount(CONVERSATION_CHANNEL), 2);
    assert.equal(subscriber.activeChannels.has(CONVERSATION_CHANNEL), true);
    assert.ok(
      operationOrder.lastIndexOf("subscribe:" + CONVERSATION_CHANNEL) >
        operationOrder.indexOf("unsubscribe:" + CONVERSATION_CHANNEL),
    );
  } finally {
    unsubscribeGate.resolve(undefined);
    await closeHarness(harness, sockets);
  }
});

test("serializes a stale unsubscribe before cross-generation attach and readiness", async () => {
  const unsubscribeGate = createDeferred<void>();
  const operationOrder: string[] = [];
  const subscriber = new FakeGatewaySubscriber();
  subscriber.onSubscribe = (call) => {
    operationOrder.push("subscribe:" + call.channel);
  };
  subscriber.onUnsubscribe = async (call) => {
    operationOrder.push("unsubscribe:" + call.channel);
    if (call.channel === CONVERSATION_CHANNEL) {
      await unsubscribeGate.promise;
    }
  };
  let harness: GatewayHarness | undefined;
  const sockets: ConnectedSocket[] = [];
  try {
    harness = await startGatewayHarness({ subscriber });
    const first = await connectSubscribed(
      harness,
      sockets,
      "conversation-token",
      [CONVERSATION_CHANNEL],
    );

    first.socket.close(1000, "test_close");
    await eventually(
      () => subscriber.unsubscribeCalls.length === 1,
      "old-generation unsubscribe did not start",
    );
    subscriber.lose("reconnecting");

    const second = await connectReady(
      harness,
      sockets,
      "conversation-token",
      "replacement socket was not ready",
      "query",
    );
    sendJson(second.socket, {
      type: "subscribe",
      channels: [CONVERSATION_CHANNEL],
    });
    subscriber.recover();
    await new Promise((resolve) => setTimeout(resolve, 20));

    const acknowledgedBeforeRelease = second.frames.some((frame) =>
      isFrameType(frame, "subscribed"),
    );
    const subscribeCallsBeforeRelease =
      subscriber.subscribeCallCount(CONVERSATION_CHANNEL);
    const readinessBeforeRelease = harness.server.readSubscriberState();

    unsubscribeGate.resolve(undefined);
    await waitForFrameType(
      second,
      "subscribed",
      "replacement subscription was not acknowledged after release",
    );
    await waitForReadyEpoch(harness, 2);

    const raw = `\n${JSON.stringify(buildOrdinaryLegacyOuter())}\r\n`;
    const published = subscriber.tryPublish(CONVERSATION_CHANNEL, raw);
    if (published) {
      await eventually(
        () => second.rawMessages.includes(raw),
        "replacement socket did not receive broker bytes",
      );
    }
    assert.deepEqual(
      {
        acknowledgedBeforeRelease,
        subscribeCallsBeforeRelease,
        readinessBeforeRelease,
        activeListenerCount:
          subscriber.activeListenerCount(CONVERSATION_CHANNEL),
        deliveredCount: second.rawMessages.filter((message) => message === raw)
          .length,
        published,
      },
      {
        acknowledgedBeforeRelease: false,
        subscribeCallsBeforeRelease: 1,
        readinessBeforeRelease: { readiness: "not_ready", epoch: 1 },
        activeListenerCount: 1,
        deliveredCount: 1,
        published: true,
      },
    );
    assert.ok(
      operationOrder.lastIndexOf("subscribe:" + CONVERSATION_CHANNEL) >
        operationOrder.indexOf("unsubscribe:" + CONVERSATION_CHANNEL),
    );
  } finally {
    unsubscribeGate.resolve(undefined);
    await closeHarness(harness, sockets);
  }
});

test("re-establishes occupied channels before recovery readiness and preserves broker bytes", async () => {
  const subscriber = new FakeGatewaySubscriber();
  await withGateway({ subscriber }, async (harness, sockets) => {
    const conversation = await connectSubscribed(
      harness,
      sockets,
      "conversation-token",
      [CONVERSATION_CHANNEL],
    );

    const beforeLossRaw = `\n${JSON.stringify(buildOrdinaryLegacyOuter())}\t`;
    subscriber.publish(CONVERSATION_CHANNEL, beforeLossRaw);
    await eventually(
      () => conversation.rawMessages.includes(beforeLossRaw),
      "broker bytes were not delivered before loss",
    );

    subscriber.lose("reconnecting");
    assert.deepEqual(harness.server.readSubscriberState(), {
      readiness: "not_ready",
      epoch: 1,
    });
    assert.equal((await fetch(readyzUrl(harness))).status, 503);
    subscriber.recover();
    await eventually(
      () => subscriber.subscribeCallCount(CONVERSATION_CHANNEL) === 2,
      "occupied channel was not re-established on recovery",
    );
    await waitForReadyEpoch(harness, 2);
    assert.equal((await fetch(readyzUrl(harness))).status, 200);
    assert.equal(conversation.socket.readyState, WebSocket.OPEN);

    const afterRecoveryRaw = ` \r\n${JSON.stringify(buildOrdinaryLegacyOuter())}\n`;
    subscriber.publish(CONVERSATION_CHANNEL, afterRecoveryRaw);
    await eventually(
      () => conversation.rawMessages.includes(afterRecoveryRaw),
      "recovered listener did not preserve broker bytes",
    );
  });
});

test("reuses one broker listener across recovery epochs and releases it after unsubscribe", async () => {
  const subscriber = new FakeGatewaySubscriber();
  await withGateway({ subscriber }, async (harness, sockets) => {
    const conversation = await connectSubscribed(
      harness,
      sockets,
      "conversation-token",
      [CONVERSATION_CHANNEL],
    );

    for (const expectedEpoch of [2, 3]) {
      subscriber.lose("reconnecting");
      subscriber.recover();
      await waitForReadyEpoch(harness, expectedEpoch);
    }
    assert.equal(subscriber.subscribeCallCount(CONVERSATION_CHANNEL), 3);
    const retainedListenerCount =
      subscriber.activeListenerCount(CONVERSATION_CHANNEL);

    const raw = `\r\n${JSON.stringify(buildOrdinaryLegacyOuter())}\t`;
    subscriber.publish(CONVERSATION_CHANNEL, raw);
    await eventually(
      () =>
        conversation.rawMessages.filter((message) => message === raw).length ===
        1,
      "recovered broker bytes were not delivered exactly once",
    );

    conversation.socket.close(1000, "test_close");
    await eventually(
      () => subscriber.unsubscribeCalls.length === 1,
      "final unsubscribe did not release the backend channel",
    );
    assert.equal(subscriber.activeListenerCount(CONVERSATION_CHANNEL), 0);
    assert.equal(retainedListenerCount, 1);
  });
});

test("keeps recovery unready after a re-subscribe failure and retries on the next ready", async () => {
  const subscriber = new FakeGatewaySubscriber();
  let failRecovery = false;
  subscriber.onSubscribe = (_call, index) => {
    if (failRecovery && index > 0) {
      throw new Error("raw recovery subscribe failure");
    }
  };
  const logger = new RecordingGatewayLogger();
  await withGateway({ subscriber, logger }, async (harness, sockets) => {
    const conversation = await connectSubscribed(
      harness,
      sockets,
      "conversation-token",
      [CONVERSATION_CHANNEL],
    );

    failRecovery = true;
    subscriber.lose("end");
    subscriber.recover();
    await eventually(
      () => subscriber.subscribeCalls.length === 2,
      "failing recovery subscribe did not run",
    );
    await eventually(
      () => logger.notes("subscriber_readiness").length === 1,
      "failed recovery was not logged",
    );
    assert.deepEqual(harness.server.readSubscriberState(), {
      readiness: "not_ready",
      epoch: 1,
    });
    assert.equal(conversation.socket.readyState, WebSocket.OPEN);
    assert.equal((await fetch(readyzUrl(harness))).status, 503);
    assert.equal(
      JSON.stringify(logger.records).includes("raw recovery subscribe failure"),
      false,
    );

    failRecovery = false;
    subscriber.recover();
    await eventually(
      () => subscriber.subscribeCalls.length === 3,
      "recovery subscribe was not retried",
    );
    await waitForReadyEpoch(harness, 2);
  });
});

test("uses ws RFC UTF-8 validation for text messages", async () => {
  await withGateway({}, async (harness, sockets) => {
    const workspace = await connectReady(
      harness,
      sockets,
      "workspace-token",
      "ready frame was not sent",
      "query",
    );
    workspace.socket.send(Buffer.from([0xc3, 0x28]), { binary: false });
    assert.equal((await workspace.close).code, 1007);
  });
});

test("uses ws RFC UTF-8 validation for invalid close reasons", async () => {
  await withGateway({}, async (harness) => {
    assert.equal(
      await sendInvalidUtf8CloseReason(harness.server.url, "workspace-token"),
      1007,
    );
  });
});

test("allows exactly 64 KiB to reach the handler and rejects larger whole or fragmented messages", async () => {
  await withGateway({}, async (harness, sockets) => {
    const exact = await connectReady(
      harness,
      sockets,
      "workspace-token",
      "exact-boundary socket was not ready",
      "query",
    );
    exact.socket.send(
      paddedJson({ type: "ping" }, 64 * 1_024).toString("utf8"),
    );
    await waitForFrameType(
      exact,
      "pong",
      "exact 64 KiB input did not reach the handler",
    );

    const oversized = await connectReady(
      harness,
      sockets,
      "workspace-token",
      "oversized socket was not ready",
      "query",
    );
    oversized.socket.send(
      paddedJson({ type: "ping" }, 64 * 1_024 + 1).toString("utf8"),
    );
    assert.equal((await oversized.close).code, 1009);

    const fragmented = await connectReady(
      harness,
      sockets,
      "workspace-token",
      "fragmented socket was not ready",
      "query",
    );
    const fragmentedRaw = paddedJson({ type: "ping" }, 64 * 1_024 + 1).toString(
      "utf8",
    );
    const splitAt = 32 * 1_024;
    fragmented.socket.send(fragmentedRaw.slice(0, splitAt), { fin: false });
    fragmented.socket.send(fragmentedRaw.slice(splitAt), { fin: true });
    assert.equal((await fragmented.close).code, 1009);
  });
});

test("schedules one signed expiry for workspace, conversation, and widget sockets", async () => {
  await withGateway({}, async (harness, sockets) => {
    sockets.push(
      await connectSocket(harness.server.url, "workspace-token", "query"),
      await connectSocket(harness.server.url, "conversation-token", "query"),
      await connectSocket(harness.server.url, "widget-token", "query"),
    );
    for (const connected of sockets) {
      const ready = await waitForFrameType(
        connected,
        "ready",
        "socket ready frame was not sent",
      );
      assert.equal(
        (ready as { expiresAt?: unknown }).expiresAt,
        new Date(EXPIRES_AT_SECONDS * 1_000).toISOString(),
      );
      assert.equal(connected.socket.readyState, WebSocket.OPEN);
    }
    assert.equal(harness.timers.timers.length, 3);
    for (const timer of harness.timers.timers) {
      assert.equal(
        timer.delayMs,
        (EXPIRES_AT_SECONDS - ISSUED_AT_SECONDS) * 1_000,
      );
      assert.equal(timer.unrefd, true);
    }

    for (let index = 0; index < harness.timers.timers.length; index += 1) {
      harness.timers.fire(index);
    }
    assert.deepEqual(
      await Promise.all(sockets.map((connected) => connected.close)),
      Array.from({ length: 3 }, () => ({
        code: 1008,
        reason: "token_expired",
      })),
    );
  });
});

test("normal close cancels expiry and removes every registry entry exactly once", async () => {
  const logger = new RecordingGatewayLogger();
  await withGateway({ logger }, async (harness, sockets) => {
    const workspace = await connectSubscribed(
      harness,
      sockets,
      "workspace-token",
      [WORKSPACE_CHANNEL],
    );
    assert.equal(harness.timers.timers.length, 1);
    workspace.socket.terminate();
    await workspace.close;
    await eventually(
      () =>
        harness.server.channelsByClient.size === 0 &&
        harness.server.clientsByChannel.size === 0 &&
        harness.subscriber.unsubscribeCalls.length === 1,
      "normal close did not finish registry and backend cleanup",
    );
    assert.equal(harness.timers.timers[0]?.cancelled, true);
    harness.timers.fire(0, true);
    harness.subscriber.lose("reconnecting");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(harness.subscriber.unsubscribeCalls.length, 1);
    assert.equal(logger.notes("connection_closed").length, 1);
  });
});

test("token expiry racing subscriber loss performs one close and one cleanup", async () => {
  const logger = new RecordingGatewayLogger();
  await withGateway({ logger }, async (harness, sockets) => {
    const workspace = await connectSubscribed(
      harness,
      sockets,
      "workspace-token",
      [WORKSPACE_CHANNEL],
    );
    let closeEvents = 0;
    workspace.socket.on("close", () => {
      closeEvents += 1;
    });
    harness.timers.fire(0);
    harness.subscriber.lose("end");
    assert.deepEqual(await workspace.close, {
      code: 1008,
      reason: "token_expired",
    });
    await eventually(
      () =>
        harness.server.channelsByClient.size === 0 &&
        harness.subscriber.unsubscribeCalls.length === 1,
      "expiry/loss race did not finish cleanup",
    );
    assert.equal(closeEvents, 1);
    assert.equal(harness.server.clientsByChannel.size, 0);
    assert.equal(logger.notes("connection_closed").length, 1);
  });
});

test("aborts the subscriber before awaiting a hung subscribe during idempotent shutdown", async () => {
  const subscribeGate = createDeferred<void>();
  const subscriber = new FakeGatewaySubscriber();
  subscriber.onSubscribe = async () => subscribeGate.promise;
  subscriber.onClose = () => {
    subscribeGate.reject(new Error("shutdown aborted pending subscribe"));
  };
  const logger = new RecordingGatewayLogger();
  let harness: GatewayHarness | undefined;
  const sockets: ConnectedSocket[] = [];
  try {
    harness = await startGatewayHarness({ subscriber, logger });
    const workspace = await connectReady(
      harness,
      sockets,
      "workspace-token",
      "shutdown subscribe socket was not ready",
      "query",
    );
    sendJson(workspace.socket, {
      type: "subscribe",
      channels: [WORKSPACE_CHANNEL],
    });
    await eventually(
      () => subscriber.subscribeCalls.length === 1,
      "hung backend subscribe did not start",
    );

    const firstClose = harness.server.close();
    const repeatedClose = harness.server.close();
    assert.equal(repeatedClose, firstClose);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const closeCountBeforeManualRelease = subscriber.closeCount;
    if (closeCountBeforeManualRelease === 0) {
      subscribeGate.reject(new Error("test released pending subscribe"));
    }
    await firstClose;

    assert.equal(closeCountBeforeManualRelease, 1);
    assert.equal(subscriber.closeCount, 1);
    assert.equal(harness.server.channelsByClient.size, 0);
    assert.equal(harness.server.clientsByChannel.size, 0);
    assert.equal(logger.notes("connection_closed").length, 1);
    assert.equal(logger.notes("client_frame_failed").length, 0);
  } finally {
    subscribeGate.reject(new Error("test cleanup pending subscribe"));
    await closeHarness(harness, sockets);
  }
});

test("aborts the subscriber before awaiting a hung unsubscribe during idempotent shutdown", async () => {
  const unsubscribeGate = createDeferred<void>();
  const subscriber = new FakeGatewaySubscriber();
  subscriber.onClose = () => {
    unsubscribeGate.reject(new Error("shutdown aborted pending unsubscribe"));
  };
  const logger = new RecordingGatewayLogger();
  let harness: GatewayHarness | undefined;
  const sockets: ConnectedSocket[] = [];
  try {
    harness = await startGatewayHarness({ subscriber, logger });
    const conversation = await connectSubscribed(
      harness,
      sockets,
      "conversation-token",
      [CONVERSATION_CHANNEL],
    );
    subscriber.onUnsubscribe = async () => unsubscribeGate.promise;
    sendJson(conversation.socket, {
      type: "unsubscribe",
      channels: [CONVERSATION_CHANNEL],
    });
    await eventually(
      () => subscriber.unsubscribeCalls.length === 1,
      "hung backend unsubscribe did not start before shutdown",
    );

    const firstClose = harness.server.close();
    const repeatedClose = harness.server.close();
    assert.equal(repeatedClose, firstClose);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const closeCountBeforeManualRelease = subscriber.closeCount;
    if (closeCountBeforeManualRelease === 0) {
      unsubscribeGate.reject(new Error("test released pending unsubscribe"));
    }
    await firstClose;

    assert.equal(closeCountBeforeManualRelease, 1);
    assert.equal(subscriber.closeCount, 1);
    assert.equal(harness.server.channelsByClient.size, 0);
    assert.equal(harness.server.clientsByChannel.size, 0);
    assert.equal(logger.notes("connection_closed").length, 1);
    assert.equal(logger.notes("backend_subscription").length, 0);
  } finally {
    unsubscribeGate.reject(new Error("test cleanup pending unsubscribe"));
    await closeHarness(harness, sockets);
  }
});

test("joins a pending subscribe before shutdown returns without late subscriber work", async () => {
  const subscribeGate = createDeferred<void>();
  const subscriber = new FakeGatewaySubscriber();
  subscriber.onSubscribe = async () => subscribeGate.promise;
  const logger = new RecordingGatewayLogger();
  let harness: GatewayHarness | undefined;
  const sockets: ConnectedSocket[] = [];
  try {
    harness = await startGatewayHarness({ subscriber, logger });
    const conversation = await connectReady(
      harness,
      sockets,
      "conversation-token",
      "shutdown socket was not ready",
      "query",
    );
    sendJson(conversation.socket, {
      type: "subscribe",
      channels: [CONVERSATION_CHANNEL],
    });
    await eventually(
      () => subscriber.subscribeCalls.length === 1,
      "pending subscribe did not start",
    );

    let closeSettled = false;
    const closePromise = harness.server.close().then(() => {
      closeSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const closeSettledBeforeManualRelease = closeSettled;
    const frameCountBeforeManualRelease = conversation.frames.length;
    subscribeGate.resolve(undefined);
    await closePromise;
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.deepEqual(
      {
        activeListenerCount:
          subscriber.activeListenerCount(CONVERSATION_CHANNEL),
        clientFrameFailureCount: logger.notes("client_frame_failed").length,
        closeCount: subscriber.closeCount,
        closeSettledBeforeManualRelease,
        connectionClosedCount: logger.notes("connection_closed").length,
        frameCountAfterRelease: conversation.frames.length,
        frameCountBeforeManualRelease,
        unsubscribeCallCount: subscriber.unsubscribeCalls.length,
      },
      {
        activeListenerCount: 0,
        clientFrameFailureCount: 0,
        closeCount: 1,
        closeSettledBeforeManualRelease: false,
        connectionClosedCount: 1,
        frameCountAfterRelease: frameCountBeforeManualRelease,
        frameCountBeforeManualRelease,
        unsubscribeCallCount: 0,
      },
    );
    assert.equal(harness.server.channelsByClient.size, 0);
    assert.equal(harness.server.clientsByChannel.size, 0);
  } finally {
    subscribeGate.resolve(undefined);
    await closeHarness(harness, sockets);
  }
});

test("rejects an upgrade after shutdown starts without frames, state, or logs", async () => {
  const closeGate = createDeferred<void>();
  const subscriber = new FakeGatewaySubscriber();
  subscriber.onClose = async () => closeGate.promise;
  const logger = new RecordingGatewayLogger();
  let harness: GatewayHarness | undefined;
  let lateSocket: WebSocket | undefined;
  try {
    harness = await startGatewayHarness({ subscriber, logger });
    const logCountBeforeClose = logger.records.length;
    let closeSettled = false;
    const closePromise = harness.server.close().then(() => {
      closeSettled = true;
    });
    await eventually(
      () => subscriber.closeCount === 1,
      "shutdown did not enter the subscriber close gate",
    );

    const frames: string[] = [];
    let opened = false;
    let responseStatus: number | undefined;
    lateSocket = new WebSocket(
      `${harness.server.url}/?token=${encodeURIComponent("workspace-token")}`,
    );
    lateSocket.on("message", (data) => frames.push(data.toString("utf8")));
    await new Promise<void>((resolve) => {
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      lateSocket?.once("open", () => {
        opened = true;
        settle();
      });
      lateSocket?.once("unexpected-response", (_request, response) => {
        responseStatus = response.statusCode;
        response.resume();
        settle();
      });
      lateSocket?.once("error", settle);
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const stateDuringClose = {
      channelsByClientSize: harness.server.channelsByClient.size,
      clientsByChannelSize: harness.server.clientsByChannel.size,
      closeSettled,
      frameCount: frames.length,
      opened,
      responseStatus,
    };

    if (
      lateSocket.readyState === WebSocket.OPEN ||
      lateSocket.readyState === WebSocket.CONNECTING
    ) {
      lateSocket.terminate();
    }
    closeGate.resolve(undefined);
    await eventually(
      () => closeSettled,
      "shutdown did not settle after close gate",
    );
    await closePromise;

    assert.deepEqual(stateDuringClose, {
      channelsByClientSize: 0,
      clientsByChannelSize: 0,
      closeSettled: false,
      frameCount: 0,
      opened: false,
      responseStatus: 503,
    });
    assert.equal(logger.records.length - logCountBeforeClose, 0);
    assert.equal(harness.server.channelsByClient.size, 0);
    assert.equal(harness.server.clientsByChannel.size, 0);
  } finally {
    closeGate.resolve(undefined);
    if (
      lateSocket?.readyState === WebSocket.OPEN ||
      lateSocket?.readyState === WebSocket.CONNECTING
    ) {
      lateSocket.terminate();
    }
    await closeHarness(harness);
  }
});

test("emits one raw-ID-free aggregate log for a broker delivery", async () => {
  const logger = new RecordingGatewayLogger();
  await withGateway({ logger }, async (harness, sockets) => {
    const first = await connectSubscribed(
      harness,
      sockets,
      "conversation-token",
      [CONVERSATION_CHANNEL],
    );
    const second = await connectSubscribed(
      harness,
      sockets,
      "conversation-token",
      [CONVERSATION_CHANNEL],
    );

    const raw = JSON.stringify(buildOrdinaryLegacyOuter());
    harness.subscriber.publish(CONVERSATION_CHANNEL, raw);
    await Promise.all([
      eventually(
        () => first.rawMessages.includes(raw),
        "first delivery was not sent",
      ),
      eventually(
        () => second.rawMessages.includes(raw),
        "second delivery was not sent",
      ),
    ]);
    await expectUpgradeStatus(harness.server.url, "leaked-invalid-token", 401);

    const deliveryLogs = logger.notes("broker_delivery");
    assert.equal(deliveryLogs.length, 1);
    assert.equal(deliveryLogs[0]?.metadata?.deliveredCount, 2);
    assert.equal(deliveryLogs[0]?.metadata?.droppedCount, 0);
    const serializedLogs = JSON.stringify(logger.records);
    for (const forbidden of [
      WORKSPACE_ID,
      CONVERSATION_ID,
      MESSAGE_ID,
      WORKSPACE_CHANNEL,
      CONVERSATION_CHANNEL,
      "conversation-token",
      "leaked-invalid-token",
      "raw verifier error",
      "legacy-message-event-1",
      "payload",
      "/?token=",
      "ws://",
    ]) {
      assert.equal(
        serializedLogs.includes(forbidden),
        false,
        `gateway logs exposed ${forbidden}`,
      );
    }
    const forbiddenMetadataKeys = new Set([
      "connectionId",
      "userId",
      "workspaceId",
      "conversationId",
      "channel",
      "eventId",
      "dedupeKey",
      "payload",
      "token",
      "url",
      "query",
      "error",
    ]);
    for (const record of logger.records) {
      for (const key of Object.keys(record.metadata || {})) {
        assert.equal(
          forbiddenMetadataKeys.has(key),
          false,
          `gateway log metadata exposed ${key}`,
        );
      }
    }
  });
});

test("keeps backend, parser, subscriber-loss, expiry, and cleanup logs raw-free", async () => {
  const logger = new RecordingGatewayLogger();
  const subscriber = new FakeGatewaySubscriber();
  let failNextSubscribe = true;
  subscriber.onSubscribe = async () => {
    if (failNextSubscribe) {
      failNextSubscribe = false;
      throw new Error("raw-backend-subscribe-secret");
    }
  };
  await withGateway({ logger, subscriber }, async (harness, sockets) => {
    const backendFailure = await connectReady(
      harness,
      sockets,
      "workspace-token",
      "backend-failure socket was not ready",
      "query",
    );
    sendJson(backendFailure.socket, {
      type: "subscribe",
      channels: [WORKSPACE_CHANNEL],
    });
    assert.deepEqual(
      await waitForFrameType(
        backendFailure,
        "error",
        "backend failure was not reported",
      ),
      SERVER_ERROR_FRAME,
    );

    const parserFailure = await connectReady(
      harness,
      sockets,
      "workspace-token",
      "parser-failure socket was not ready",
      "query",
    );
    parserFailure.socket.send("{raw-parser-frame-secret");
    assert.deepEqual(
      await waitForFrameType(
        parserFailure,
        "error",
        "parser failure was not reported",
      ),
      SERVER_ERROR_FRAME,
    );

    const subscriberLoss = await connectSubscribed(
      harness,
      sockets,
      "workspace-token",
      [WORKSPACE_CHANNEL],
    );
    subscriber.lose("reconnecting");
    subscriber.recover();
    await waitForReadyEpoch(harness, 2);

    const expiry = await connectReady(
      harness,
      sockets,
      "workspace-token",
      "expiry socket was not ready",
      "query",
    );
    harness.timers.fire(3);
    assert.deepEqual(await expiry.close, {
      code: 1008,
      reason: "token_expired",
    });
    await expectUpgradeStatus(
      harness.server.url,
      "raw-invalid-token-secret",
      401,
    );
    for (const connected of [backendFailure, parserFailure, subscriberLoss]) {
      connected.socket.close(1000, "test_complete");
    }
    await eventually(
      () => logger.notes("connection_closed").length === 4,
      "all connection_closed summaries were not awaited",
    );

    const serializedLogs = JSON.stringify(logger.records);
    for (const forbidden of [
      "raw-backend-subscribe-secret",
      "raw-parser-frame-secret",
      "raw-invalid-token-secret",
      "raw verifier error",
      WORKSPACE_ID,
      CONVERSATION_ID,
      WORKSPACE_CHANNEL,
      "workspace-token",
      "/?token=",
      "ws://",
    ]) {
      assert.equal(
        serializedLogs.includes(forbidden),
        false,
        `lifecycle logs exposed ${forbidden}`,
      );
    }
    for (const record of logger.records.filter(
      (entry) => entry.level === "error",
    )) {
      assert.equal(
        record.error instanceof Error,
        false,
        "logger.error received a raw Error object",
      );
    }
  });
});

test("keeps production and tests on one websocket server, registry owner, and subscriber client", () => {
  const source = readFileSync(
    fileURLToPath(new URL("./realtime-gateway.ts", import.meta.url)),
    "utf8",
  );
  assert.equal(source.match(/new WebSocketServer\s*\(/g)?.length, 1);
  assert.equal(source.match(/const clientsByChannel = new Map/g)?.length, 1);
  assert.equal(source.match(/const channelsByClient = new Map/g)?.length, 1);
  const productionEntrypoint = source.slice(
    source.indexOf("export async function runRealtimeGatewayServer"),
  );
  assert.equal(
    productionEntrypoint.match(/createRealtimeValkeyClient\s*\(/g)?.length,
    1,
  );
  assert.equal(productionEntrypoint.match(/const subscriber\s*=/g)?.length, 1);
  assert.match(
    productionEntrypoint,
    /serverHandle\s*=\s*await\s+startRealtimeGatewayServer/,
  );
  assert.match(productionEntrypoint, /await\s+waitForRealtimeGatewayShutdown/);
  assert.match(productionEntrypoint, /await\s+serverHandle\?\.close\(\)/);
  assert.equal(productionEntrypoint.match(/\.subscribe\s*\(/g)?.length || 0, 0);
  assert.equal(productionEntrypoint.match(/new WebSocketServer\s*\(/g), null);
  assert.equal(productionEntrypoint.match(/new Map\s*<[^>]*WebSocket/g), null);
});

test("production shutdown waiter removes both signal listeners after the first signal", async () => {
  const signals = new EventEmitter();
  const waiting = waitForRealtimeGatewayShutdown(signals);
  assert.equal(signals.listenerCount("SIGINT"), 1);
  assert.equal(signals.listenerCount("SIGTERM"), 1);

  signals.emit("SIGTERM");
  await waiting;
  assert.equal(signals.listenerCount("SIGINT"), 0);
  assert.equal(signals.listenerCount("SIGTERM"), 0);
});
