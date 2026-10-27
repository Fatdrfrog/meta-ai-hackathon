/**
 * @jest-environment jsdom
 */

import { act, renderHook } from "@testing-library/react";
import { TextDecoder, TextEncoder } from "node:util";
import type {
  RequestsRealtimeCommitAckV1,
  RequestsRealtimePresenceClientFrameV1,
} from "@icecore/shared/types/requests-realtime";
import type {
  RealtimeEventEnvelope,
  RealtimeEventName,
} from "@icecore/shared/types/realtime";
import type {
  RealtimeChannelAdapter,
  RealtimeControllerDependenciesV1,
  RealtimeControllerOptionsV1,
  RealtimeControllerV1,
  RealtimeLoadedTokenV1,
} from "./use-realtime";

Object.assign(globalThis, { TextDecoder, TextEncoder });

let mockRealtimeAuth:
  | {
      user: { id: string } | null;
      session: { access_token: string } | null;
      loading: boolean;
    }
  | undefined;
jest.mock("@/lib/auth/auth-context", () => ({
  useOptionalAuth: () => mockRealtimeAuth,
}));

const { REALTIME_CANDIDATE_ACK_DEADLINE_MS, REALTIME_ROTATION_RETRY_MAX_MS } =
  require("@icecore/shared/types/realtime") as typeof import("@icecore/shared/types/realtime");

const {
  REALTIME_CONTROL_BUFFER_MAX_BYTES,
  createRealtimeControllerV1,
  evaluateRealtimeControlCapacityV1,
  getRealtimeReconnectDelayMs,
  getRealtimeTokenRetryDelayMs,
  isRealtimeConnectionStale,
  isUsableRealtimeTokenPayload,
  parseRealtimeLoadedTokenV1,
  RealtimeTokenRequestError,
  toRealtimeTokenSubprotocol,
  toWebSocketUrl,
  useRealtime,
} = require("./use-realtime") as typeof import("./use-realtime");

describe("useRealtime reconnect policy", () => {
  it("backs off exponentially and caps reconnect delay", () => {
    expect(getRealtimeReconnectDelayMs(1)).toBe(1000);
    expect(getRealtimeReconnectDelayMs(2)).toBe(2000);
    expect(getRealtimeReconnectDelayMs(5)).toBe(15000);
    expect(getRealtimeReconnectDelayMs(20)).toBe(15000);
  });

  it("does not retry missing gateway config responses", () => {
    expect(
      getRealtimeTokenRetryDelayMs(
        new RealtimeTokenRequestError(503, "realtime_gateway_not_configured"),
        1
      )
    ).toBeNull();
  });

  it("caps auth denial retries but keeps server token failures retrying", () => {
    expect(
      getRealtimeTokenRetryDelayMs(new RealtimeTokenRequestError(401), 1)
    ).toBe(1000);
    expect(
      getRealtimeTokenRetryDelayMs(new RealtimeTokenRequestError(403), 2)
    ).toBe(2000);
    expect(
      getRealtimeTokenRetryDelayMs(new RealtimeTokenRequestError(401), 6)
    ).toBe(15000);
    expect(
      getRealtimeTokenRetryDelayMs(new RealtimeTokenRequestError(403), 7)
    ).toBeNull();
    expect(
      getRealtimeTokenRetryDelayMs(new RealtimeTokenRequestError(500), 2)
    ).toBe(2000);
    expect(
      getRealtimeTokenRetryDelayMs(new RealtimeTokenRequestError(500), 7)
    ).toBe(15000);
  });

  it("treats a missing realtime gateway URL as non-usable token payload", () => {
    expect(
      isUsableRealtimeTokenPayload({
        token: "signed-token",
        url: "",
      })
    ).toBe(false);
    expect(
      isUsableRealtimeTokenPayload({
        token: "signed-token",
        url: "https://realtime.airi.chat",
      })
    ).toBe(true);
  });

  it("detects stale websocket connections for heartbeat reconnects", () => {
    expect(isRealtimeConnectionStale(1_000, 55_000, 55_000)).toBe(false);
    expect(isRealtimeConnectionStale(1_000, 56_001, 55_000)).toBe(true);
  });
});

describe("toWebSocketUrl", () => {
  it("converts https gateway URLs to wss URLs", () => {
    expect(toWebSocketUrl("https://realtime.airi.chat")).toBe(
      "wss://realtime.airi.chat/"
    );
  });

  it("preserves wss gateway URLs and existing query params", () => {
    expect(
      toWebSocketUrl("wss://realtime.airi.chat/socket?region=europe-west1")
    ).toBe("wss://realtime.airi.chat/socket?region=europe-west1");
  });

  it("supports local ws/http gateway URLs", () => {
    expect(toWebSocketUrl("http://localhost:8080")).toBe(
      "ws://localhost:8080/"
    );
    expect(toWebSocketUrl("ws://localhost:8080/socket")).toBe(
      "ws://localhost:8080/socket"
    );
  });

  it("rejects unsupported protocols", () => {
    expect(() => toWebSocketUrl("ftp://realtime.airi.chat")).toThrow(
      "Unsupported realtime gateway protocol"
    );
  });

  it("moves realtime auth into a websocket subprotocol", () => {
    expect(toRealtimeTokenSubprotocol("signed-token")).toBe(
      "airi-realtime-token.signed-token"
    );
  });
});

const WORKSPACE_ID = "123e4567-e89b-12d3-a456-426614174000";
const CONVERSATION_ID = "507f1f77bcf86cd799439011";
const GRANT_ID = "0123456789abcdef0123456789abcdef";
const CONNECTION_ID = "123e4567-e89b-42d3-a456-426614174000";
const GATEWAY_INSTANCE_ID = "abcdefabcdefabcdefabcdefabcdefab";
const WORKSPACE_CHANNEL = `workspace:${WORKSPACE_ID}`;
const CHANNEL = `conversation:${WORKSPACE_ID}:${CONVERSATION_ID}`;
const REQUESTS_CHANNELS = [WORKSPACE_CHANNEL, CHANNEL] as const;
const LOADER_EXPIRES_AT = "2030-01-01T00:05:00.000Z";
const READY_EXPIRES_AT = "2030-01-01T00:04:00.000Z";

const LEGACY_TOKEN: RealtimeLoadedTokenV1 = Object.freeze({
  kind: "legacy",
  token: "opaque-not-a-jwt",
  url: "https://realtime.airi.chat/socket",
  expiresAt: LOADER_EXPIRES_AT,
});

const REQUESTS_TOKEN: RealtimeLoadedTokenV1 = Object.freeze({
  kind: "requests",
  token: "opaque-not-a-jwt",
  url: "https://realtime.airi.chat/socket",
  expiresAt: LOADER_EXPIRES_AT,
  workspaceId: WORKSPACE_ID,
  grantId: GRANT_ID,
});

const legacyFacadeMock: ReturnType<typeof useRealtime> = {
  channel: null,
  isConnected: false,
};
void legacyFacadeMock;

class FakeWebSocket {
  readonly url: string;
  readonly protocols: string[];
  readyState = 0;
  bufferedAmount = 0;
  readonly sent: string[] = [];
  closeCalls = 0;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  constructor(url: string, protocols: string[]) {
    this.url = url;
    this.protocols = protocols;
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }

  receive(value: unknown): void {
    this.onmessage?.({ data: JSON.stringify(value) });
  }

  send(value: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    if (this.readyState !== 1) throw new Error("socket is not open");
    this.sent.push(String(value));
  }

  close(code = 1_000, reason = ""): void {
    this.closeCalls += 1;
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }

  fail(): void {
    this.onerror?.({});
  }

  sentFrames(): unknown[] {
    return this.sent.map(value => JSON.parse(value));
  }
}

type FakeTimer = {
  callback: () => void;
  delayMs: number;
  cancelled: boolean;
};

type ControllerHarness = {
  controller: RealtimeControllerV1;
  sockets: FakeWebSocket[];
  timers: FakeTimer[];
  loadSignals: AbortSignal[];
  rawReceipts: unknown[];
  controls: unknown[];
  rotations: unknown[];
  namedEvents: RealtimeEventEnvelope[];
  channel: RealtimeChannelAdapter;
  setMonotonic(value: number): void;
  setWallNow(value: number): void;
};

function createControllerHarness(
  input: {
    tokens?: readonly RealtimeLoadedTokenV1[];
    channels?: readonly string[];
    enableLegacyRefresh?: boolean;
    random?: () => number;
  } = {}
): ControllerHarness {
  const sockets: FakeWebSocket[] = [];
  const timers: FakeTimer[] = [];
  const loadSignals: AbortSignal[] = [];
  const rawReceipts: unknown[] = [];
  const controls: unknown[] = [];
  const rotations: unknown[] = [];
  const namedEvents: RealtimeEventEnvelope[] = [];
  const handlers = new Map<
    RealtimeEventName,
    Set<(event: RealtimeEventEnvelope) => void>
  >();
  const channel: RealtimeChannelAdapter = {
    bind(eventName, handler) {
      const current = handlers.get(eventName) || new Set();
      current.add(handler);
      handlers.set(eventName, current);
    },
    unbind(eventName, handler) {
      handlers.get(eventName)?.delete(handler);
    },
  };
  channel.bind("conversation.message.created", event =>
    namedEvents.push(event)
  );
  const tokens = input.tokens || [REQUESTS_TOKEN];
  let loadIndex = 0;
  let monotonic = 100;
  let wallNow = Date.parse("2029-12-31T23:59:00.000Z");
  const options: RealtimeControllerOptionsV1 = {
    channels:
      input.channels ||
      (tokens[0]?.kind === "requests" ? REQUESTS_CHANNELS : [CHANNEL]),
    async loadToken({ signal }) {
      loadSignals.push(signal);
      const token = tokens[Math.min(loadIndex, tokens.length - 1)];
      loadIndex += 1;
      if (!token) throw new Error("missing fake token");
      return token;
    },
    onRawEvent: receipt => rawReceipts.push(receipt),
    onServerControl: receipt => controls.push(receipt),
    onRotation: event => rotations.push(event),
  };
  const createTimer = (callback: () => void, delayMs: number) => {
    const timer: FakeTimer = { callback, delayMs, cancelled: false };
    timers.push(timer);
    return timer as unknown as ReturnType<typeof setTimeout>;
  };
  const clearTimer = (handle: ReturnType<typeof setTimeout>) => {
    (handle as unknown as FakeTimer).cancelled = true;
  };
  const dependencies: RealtimeControllerDependenciesV1 = {
    createWebSocket(url, protocols) {
      const socket = new FakeWebSocket(url, protocols);
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
    monotonicNow: () => monotonic,
    wallNow: () => wallNow,
    random: input.random || (() => 0.5),
    setTimeout: createTimer,
    clearTimeout: clearTimer,
    setInterval: createTimer as RealtimeControllerDependenciesV1["setInterval"],
    clearInterval:
      clearTimer as RealtimeControllerDependenciesV1["clearInterval"],
  };
  const controller = createRealtimeControllerV1({
    options,
    channel,
    dependencies,
    enableLegacyRefresh: input.enableLegacyRefresh,
    deliverNamedEvent(event) {
      handlers.get(event.name)?.forEach(handler => handler(event));
    },
  });
  return {
    controller,
    sockets,
    timers,
    loadSignals,
    rawReceipts,
    controls,
    rotations,
    namedEvents,
    channel,
    setMonotonic: value => {
      monotonic = value;
    },
    setWallNow: value => {
      wallNow = value;
    },
  };
}

async function flushController(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

type DefaultHookHarness = {
  sockets: FakeWebSocket[];
  fetchMock: jest.Mock;
  tokenExpiries: string[];
};

function installDefaultHookHarness(ttlSeconds: number): DefaultHookHarness {
  const sockets: FakeWebSocket[] = [];
  const tokenExpiries: string[] = [];
  let tokenSequence = 0;
  class DefaultHookWebSocket extends FakeWebSocket {
    constructor(url: string, protocols: string | string[]) {
      super(url, typeof protocols === "string" ? [protocols] : protocols);
      sockets.push(this);
    }
  }
  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    writable: true,
    value: DefaultHookWebSocket,
  });
  const fetchMock = jest.fn(async () => {
    tokenSequence += 1;
    const expiresAt = new Date(Date.now() + ttlSeconds * 1_000).toISOString();
    tokenExpiries.push(expiresAt);
    return {
      ok: true,
      json: async () => ({
        token: `legacy-token-${tokenSequence}`,
        url: "https://realtime.airi.chat/socket?region=us",
        expiresAt,
      }),
    };
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return { sockets, fetchMock, tokenExpiries };
}

async function openLegacySocket(
  socket: FakeWebSocket,
  channel: string,
  expiresAt: string,
  connectionId: string
): Promise<void> {
  act(() => {
    socket.open();
    socket.receive({ type: "ready", connectionId, expiresAt });
    socket.receive({ type: "subscribed", channels: [channel] });
  });
  await act(async () => flushController());
}

async function advanceWhileKeepingLegacyAlive(
  sockets: readonly FakeWebSocket[],
  durationMs: number
): Promise<void> {
  let remaining = durationMs;
  while (remaining > 0) {
    const step = Math.min(50_000, remaining);
    act(() => jest.advanceTimersByTime(step));
    await act(async () => flushController());
    act(() => {
      sockets
        .filter(socket => socket.readyState === 1)
        .forEach(socket => socket.receive({ type: "pong" }));
    });
    remaining -= step;
  }
}

function requestsReady(expiresAt = READY_EXPIRES_AT) {
  return {
    type: "ready",
    schemaVersion: 1,
    connectionId: CONNECTION_ID,
    expiresAt,
    gatewayInstanceId: GATEWAY_INSTANCE_ID,
  } as const;
}

function requestsSubscribed(channels: readonly string[] = REQUESTS_CHANNELS) {
  return {
    type: "subscribed",
    schemaVersion: 1,
    connectionId: CONNECTION_ID,
    subscriptionEpoch: 3,
    grantId: GRANT_ID,
    channels: [...channels],
  } as const;
}

async function openInitialRequests(
  harness: ControllerHarness
): Promise<FakeWebSocket> {
  harness.controller.start();
  await flushController();
  const socket = harness.sockets[0];
  if (!socket) throw new Error("initial fake socket was not created");
  socket.open();
  socket.receive(requestsReady());
  socket.receive(requestsSubscribed());
  await flushController();
  return socket;
}

describe("Task 16 closed loader", () => {
  it("strictly freezes the closed legacy and Requests variants", () => {
    const legacy = parseRealtimeLoadedTokenV1(LEGACY_TOKEN, 1);
    const requests = parseRealtimeLoadedTokenV1(REQUESTS_TOKEN, 1);
    const legacyWithUnrelatedQuery = parseRealtimeLoadedTokenV1(
      { ...LEGACY_TOKEN, url: `${LEGACY_TOKEN.url}?region=us` },
      1
    );
    expect(legacy).toEqual(LEGACY_TOKEN);
    expect(requests).toEqual(REQUESTS_TOKEN);
    expect(legacyWithUnrelatedQuery.url).toBe(`${LEGACY_TOKEN.url}?region=us`);
    expect(Object.isFrozen(legacy)).toBe(true);
    expect(Object.isFrozen(requests)).toBe(true);
  });

  it("rejects unknown keys, kinds, protocols, identities, expiry formats, and expired results", () => {
    const invalid = [
      { ...LEGACY_TOKEN, unknown: true },
      { ...LEGACY_TOKEN, kind: "unknown" },
      { ...LEGACY_TOKEN, token: " " },
      { ...LEGACY_TOKEN, url: "ftp://realtime.airi.chat" },
      {
        ...LEGACY_TOKEN,
        url: `wss://user:${LEGACY_TOKEN.token}@realtime.airi.chat/socket`,
      },
      {
        ...LEGACY_TOKEN,
        url: `${LEGACY_TOKEN.url}?token=${encodeURIComponent(LEGACY_TOKEN.token)}`,
      },
      {
        ...LEGACY_TOKEN,
        url: `${LEGACY_TOKEN.url}?authorization=${encodeURIComponent(`Bearer ${LEGACY_TOKEN.token}`)}`,
      },
      { ...LEGACY_TOKEN, expiresAt: "2030-01-01T00:05:00Z" },
      { ...LEGACY_TOKEN, expiresAt: "1970-01-01T00:00:00.001Z" },
      { ...REQUESTS_TOKEN, workspaceId: "not-a-uuid" },
      { ...REQUESTS_TOKEN, grantId: "ABCDEF".repeat(6) },
      { ...REQUESTS_TOKEN, extraClaim: "forbidden" },
    ];
    for (const value of invalid) {
      expect(() => parseRealtimeLoadedTokenV1(value, 2)).toThrow();
    }
  });
});

describe("Task 16 generic realtime controller", () => {
  it("counts UTF-8 bytes at the exact 4096-byte control and 64-KiB buffer boundaries", () => {
    const exactControl = "é".repeat(2_048);
    const oversizedControl = `${exactControl}a`;
    expect(new TextEncoder().encode(exactControl)).toHaveLength(4_096);
    expect(new TextEncoder().encode(oversizedControl)).toHaveLength(4_097);
    expect(
      evaluateRealtimeControlCapacityV1({
        serializedFrame: exactControl,
        bufferedAmount: 0,
      })
    ).toEqual({ kind: "sendable", frameBytes: 4_096 });
    expect(
      evaluateRealtimeControlCapacityV1({
        serializedFrame: oversizedControl,
        bufferedAmount: 0,
      })
    ).toEqual({ kind: "oversize" });
    expect(
      evaluateRealtimeControlCapacityV1({
        serializedFrame: exactControl,
        bufferedAmount: REALTIME_CONTROL_BUFFER_MAX_BYTES - 4_096,
      })
    ).toEqual({ kind: "sendable", frameBytes: 4_096 });
    expect(
      evaluateRealtimeControlCapacityV1({
        serializedFrame: exactControl,
        bufferedAmount: REALTIME_CONTROL_BUFFER_MAX_BYTES - 4_096 + 1,
      })
    ).toEqual({ kind: "backpressure" });
  });

  it("keeps the legacy facade mockable and emits the unchanged legacy subscribe shape", async () => {
    expect(REALTIME_CONTROL_BUFFER_MAX_BYTES).toBe(64 * 1_024);
    const harness = createControllerHarness({ tokens: [LEGACY_TOKEN] });
    harness.controller.start();
    await flushController();
    const socket = harness.sockets[0];
    expect(socket).toBeDefined();
    socket?.open();
    expect(socket?.sentFrames()).toEqual([
      { type: "subscribe", channels: [CHANNEL] },
    ]);
    expect(socket?.url).toBe("wss://realtime.airi.chat/socket");
    expect(socket?.protocols).toEqual([
      "airi-realtime",
      "airi-realtime-token.opaque-not-a-jwt",
    ]);
  });

  it("uses only the custom loader and emits the exact Requests subscribe shape", async () => {
    const harness = createControllerHarness();
    harness.controller.start();
    await flushController();
    expect(harness.loadSignals).toHaveLength(1);
    const socket = harness.sockets[0];
    socket?.open();
    expect(socket?.sentFrames()).toEqual([
      {
        type: "subscribe",
        schemaVersion: 1,
        workspaceId: WORKSPACE_ID,
        grantId: GRANT_ID,
        channels: [...REQUESTS_CHANNELS],
      },
    ]);
    expect(socket?.url.includes("opaque-not-a-jwt")).toBe(false);
  });

  it("does not report desired channels acknowledged before the exact server ACK", async () => {
    const harness = createControllerHarness();
    harness.controller.start();
    await flushController();
    const socket = harness.sockets[0];
    socket?.open();
    socket?.receive(requestsReady());
    expect(harness.controller.getSnapshot().acknowledgedChannels).toEqual([]);
    socket?.receive(requestsSubscribed());
    expect(harness.controller.getSnapshot().acknowledgedChannels).toEqual(
      REQUESTS_CHANNELS
    );
    expect(harness.controller.getSnapshot().gatewayInstanceId).toBe(
      GATEWAY_INSTANCE_ID
    );
    expect(harness.controller.getSnapshot().effectiveExpiresAt).toBe(
      READY_EXPIRES_AT
    );
  });

  it("delivers one raw receipt before retaining the existing named handler", async () => {
    const harness = createControllerHarness();
    const socket = await openInitialRequests(harness);
    const event: RealtimeEventEnvelope = {
      eventId: "event-1",
      version: 1,
      name: "conversation.message.created",
      workspaceId: WORKSPACE_ID,
      conversationId: CONVERSATION_ID,
      createdAt: "2030-01-01T00:00:00.000Z",
      dedupeKey: "event-1",
      payload: { messageId: "507f1f77bcf86cd799439012" },
    };
    harness.setMonotonic(777);
    socket.receive({ type: "event", channel: CHANNEL, event });
    expect(harness.rawReceipts).toEqual([
      {
        channel: CHANNEL,
        event,
        receivedAtMonotonicMs: 777,
        connectionEpoch: 1,
      },
    ]);
    expect(harness.namedEvents).toEqual([event]);
  });

  it("reports strict server controls passively and sends no automatic presence, commit, or probe", async () => {
    const harness = createControllerHarness();
    const socket = await openInitialRequests(harness);
    const sentBeforePresenceAck = [...socket.sentFrames()];
    harness.setMonotonic(888);
    socket.receive({
      type: "requests_presence_ack",
      schemaVersion: 1,
      connectionId: "223e4567-e89b-42d3-a456-426614174000",
      subscriptionEpoch: 3,
      grantId: GRANT_ID,
      presenceSequence: 1,
      state: "visible-warm",
    });
    expect(harness.controls).toHaveLength(2);
    socket.receive({
      type: "requests_presence_ack",
      schemaVersion: 1,
      connectionId: CONNECTION_ID,
      subscriptionEpoch: 3,
      grantId: GRANT_ID,
      presenceSequence: 1,
      state: "visible-warm",
    });
    expect(harness.controls).toHaveLength(3);
    expect(harness.controls.at(-1)).toEqual({
      frame: {
        type: "requests_presence_ack",
        schemaVersion: 1,
        connectionId: CONNECTION_ID,
        subscriptionEpoch: 3,
        grantId: GRANT_ID,
        presenceSequence: 1,
        state: "visible-warm",
      },
      receivedAtMonotonicMs: 888,
      connectionEpoch: 1,
    });
    expect(socket.sentFrames()).toEqual(sentBeforePresenceAck);
  });

  it("sends only strict bound controls immediately with closed failure results", async () => {
    const harness = createControllerHarness();
    expect(
      harness.controller.getSnapshot().sendControlFrame(
        {
          schemaVersion: 1,
          kind: "preview",
          latencyTraceId: "0123456789abcdef0123456789abcdef",
          outcome: "displayed",
          receiptToCommitMs: 1,
        },
        1
      )
    ).toEqual({ kind: "not_ready" });
    const socket = await openInitialRequests(harness);
    const epoch = harness.controller.getSnapshot().connectionEpoch;
    expect(epoch).toBe(1);
    const presence: RequestsRealtimePresenceClientFrameV1 = {
      type: "requests_presence",
      schemaVersion: 1,
      connectionId: CONNECTION_ID,
      subscriptionEpoch: 3,
      grantId: GRANT_ID,
      presenceSequence: 1,
      state: "visible-warm",
    };
    const commit: RequestsRealtimeCommitAckV1 = {
      schemaVersion: 1,
      kind: "preview",
      latencyTraceId: "0123456789abcdef0123456789abcdef",
      outcome: "displayed",
      receiptToCommitMs: 1,
    };
    expect(
      harness.controller.getSnapshot().sendControlFrame(presence, 1)
    ).toEqual({
      kind: "sent",
    });
    expect(
      harness.controller.getSnapshot().sendControlFrame(commit, 1)
    ).toEqual({
      kind: "sent",
    });
    expect(
      harness.controller.getSnapshot().sendControlFrame(commit, 2)
    ).toEqual({
      kind: "stale_epoch",
    });
    expect(
      harness.controller
        .getSnapshot()
        .sendControlFrame(
          { ...presence, connectionId: "123e4567-e89b-42d3-a456-426614174001" },
          1
        )
    ).toEqual({ kind: "invalid" });
    expect(
      harness.controller.getSnapshot().sendControlFrame(
        {
          type: "requests_clock_probe",
          schemaVersion: 1,
        } as unknown as RequestsRealtimeCommitAckV1,
        1
      )
    ).toEqual({ kind: "invalid" });
    socket.bufferedAmount = REALTIME_CONTROL_BUFFER_MAX_BYTES;
    expect(
      harness.controller.getSnapshot().sendControlFrame(commit, 1)
    ).toEqual({
      kind: "backpressure",
    });
  });

  it("owns one replacement and promotes only after ready plus exact channel ACK", async () => {
    const harness = createControllerHarness({
      tokens: [
        REQUESTS_TOKEN,
        { ...REQUESTS_TOKEN, token: "replacement-token" },
      ],
    });
    const active = await openInitialRequests(harness);
    expect(harness.controller.getSnapshot().requestRotation("manual")).toEqual({
      kind: "started",
    });
    expect(harness.controller.getSnapshot().requestRotation("stale")).toEqual({
      kind: "in_flight",
    });
    await flushController();
    const candidate = harness.sockets[1];
    expect(candidate).toBeDefined();
    candidate?.open();
    candidate?.receive(requestsReady());
    expect(active.closeCalls).toBe(0);
    expect(harness.controller.getSnapshot().connectionEpoch).toBe(1);
    candidate?.receive(requestsSubscribed([WORKSPACE_CHANNEL]));
    expect(active.closeCalls).toBe(0);
    candidate?.receive(requestsSubscribed());
    expect(active.closeCalls).toBe(1);
    expect(harness.controller.getSnapshot().connectionEpoch).toBe(2);
    expect(harness.controller.getSnapshot().acknowledgedChannels).toEqual(
      REQUESTS_CHANNELS
    );
  });

  it("drops stale socket events and controls after replacement", async () => {
    const harness = createControllerHarness({
      tokens: [
        REQUESTS_TOKEN,
        { ...REQUESTS_TOKEN, token: "replacement-token" },
      ],
    });
    const active = await openInitialRequests(harness);
    harness.controller.getSnapshot().requestRotation("manual");
    await flushController();
    const candidate = harness.sockets[1];
    candidate?.open();
    candidate?.receive(requestsReady());
    candidate?.receive(requestsSubscribed());
    const rawCount = harness.rawReceipts.length;
    const controlCount = harness.controls.length;
    active.receive({
      type: "event",
      channel: CHANNEL,
      event: {
        eventId: "stale-event",
        version: 1,
        name: "conversation.message.created",
        workspaceId: WORKSPACE_ID,
        conversationId: CONVERSATION_ID,
        createdAt: "2030-01-01T00:00:00.000Z",
        dedupeKey: "stale-event",
        payload: {},
      },
    });
    active.receive(requestsReady());
    expect(harness.rawReceipts).toHaveLength(rawCount);
    expect(harness.controls).toHaveLength(controlCount);
  });

  it("keeps the old socket after candidate failure, aborts on dispose, and permits external retry", async () => {
    const harness = createControllerHarness({
      tokens: [
        REQUESTS_TOKEN,
        { ...REQUESTS_TOKEN, token: "failed-token" },
        { ...REQUESTS_TOKEN, token: "retry-token" },
      ],
    });
    const active = await openInitialRequests(harness);
    harness.controller.getSnapshot().requestRotation("manual");
    await flushController();
    const candidate = harness.sockets[1];
    candidate?.open();
    candidate?.fail();
    await flushController();
    expect(active.closeCalls).toBe(0);
    expect(harness.controller.getSnapshot().connectionEpoch).toBe(1);
    expect(harness.controller.getSnapshot().requestRotation("manual")).toEqual({
      kind: "started",
    });
    await flushController();
    expect(harness.sockets).toHaveLength(3);
    harness.controller.dispose();
    expect(harness.loadSignals.every(signal => signal.aborted)).toBe(true);
    expect(harness.controller.getSnapshot().requestRotation("manual")).toEqual({
      kind: "disposed",
    });
  });

  it("injects bounded jitter and preserves headroom for a late legacy rotation failure", async () => {
    const random = jest.fn(() => 1);
    const harness = createControllerHarness({
      tokens: [
        LEGACY_TOKEN,
        { ...LEGACY_TOKEN, token: "late-candidate-token" },
      ],
      enableLegacyRefresh: true,
      random,
    });
    harness.controller.start();
    await flushController();
    const active = harness.sockets[0]!;
    active.open();
    active.receive({
      type: "ready",
      connectionId: "late-active",
      expiresAt: READY_EXPIRES_AT,
    });
    active.receive({ type: "subscribed", channels: [CHANNEL] });

    const activeExpiresAtMs = Date.parse(READY_EXPIRES_AT);
    harness.setWallNow(activeExpiresAtMs - 10_000);
    expect(harness.controller.getSnapshot().requestRotation("expiry")).toEqual({
      kind: "started",
    });
    await flushController();
    const candidate = harness.sockets[1]!;
    candidate.open();
    candidate.fail();

    expect(random).toHaveBeenCalledTimes(1);
    const retry = harness.timers.at(-1)!;
    expect(retry.cancelled).toBe(false);
    expect(retry.delayMs).toBe(5_000);
    expect(retry.delayMs).toBeLessThan(
      activeExpiresAtMs - (activeExpiresAtMs - 10_000)
    );
    expect(active.closeCalls).toBe(0);

    harness.controller.dispose();
    expect(retry.cancelled).toBe(true);
  });

  it("keeps token and raw identities out of snapshots and rotation records", async () => {
    const harness = createControllerHarness();
    const socket = await openInitialRequests(harness);
    const snapshot = harness.controller.getSnapshot();
    const snapshotSerialized = JSON.stringify(snapshot);
    const rotationsSerialized = JSON.stringify(harness.rotations);
    for (const forbidden of [
      REQUESTS_TOKEN.token,
      REQUESTS_TOKEN.url,
      GRANT_ID,
    ]) {
      expect(snapshotSerialized.includes(forbidden)).toBe(false);
      expect(rotationsSerialized.includes(forbidden)).toBe(false);
    }
    for (const forbidden of [
      WORKSPACE_ID,
      CONVERSATION_ID,
      ...REQUESTS_CHANNELS,
    ]) {
      expect(rotationsSerialized.includes(forbidden)).toBe(false);
    }
    expect(socket.url.includes(REQUESTS_TOKEN.token)).toBe(false);
    expect(socket.protocols).toContain(
      `airi-realtime-token.${REQUESTS_TOKEN.token}`
    );
  });

  it("does not notify consumers when an equivalent snapshot is rebuilt", async () => {
    const harness = createControllerHarness();
    const listener = jest.fn();
    const unsubscribe = harness.controller.subscribe(listener);
    const socket = await openInitialRequests(harness);
    const connected = harness.controller.getSnapshot();
    listener.mockClear();

    for (let i = 0; i < 50; i += 1) {
      socket.receive(requestsReady());
      socket.receive(requestsSubscribed());
    }

    expect(listener).not.toHaveBeenCalled();
    expect(harness.controller.getSnapshot()).toBe(connected);

    harness.controller.dispose();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(harness.controller.getSnapshot()).not.toBe(connected);
    expect(harness.controller.getSnapshot().isConnected).toBe(false);
    unsubscribe();
  });
});

describe("Task 17 default legacy rotation", () => {
  const originalFetch = global.fetch;
  const originalWebSocket = global.WebSocket;
  const exactConversationScope = {
    kind: "conversation" as const,
    workspaceId: WORKSPACE_ID,
    conversationId: CONVERSATION_ID,
  };
  const workspaceScope = {
    kind: "workspace" as const,
    workspaceId: WORKSPACE_ID,
  };

  beforeEach(() => {
    mockRealtimeAuth = undefined;
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
  });

  afterEach(() => {
    mockRealtimeAuth = undefined;
    jest.restoreAllMocks();
    jest.clearAllTimers();
    jest.useRealTimers();
    global.fetch = originalFetch;
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      writable: true,
      value: originalWebSocket,
    });
  });

  it("loads only a legacy GET token with the exact dashboard client header", async () => {
    const harness = installDefaultHookHarness(300);
    const { unmount } = renderHook(() => useRealtime(exactConversationScope));
    await act(async () => flushController());

    expect(harness.fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = harness.fetchMock.mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toBe(
      `/api/realtime/token?workspaceId=${WORKSPACE_ID}&conversationId=${CONVERSATION_ID}`
    );
    expect(url).not.toContain("requests-token");
    expect(url).not.toContain("realtime-rows");
    expect(
      new Headers(init.headers).get("x-airi-realtime-client-contract")
    ).toBe("dashboard-v1");
    expect(harness.sockets[0]?.url).toBe(
      "wss://realtime.airi.chat/socket?region=us"
    );
    expect(harness.sockets[0]?.protocols).toEqual([
      "airi-realtime",
      "airi-realtime-token.legacy-token-1",
    ]);
    unmount();
  });

  it("shares the exact authenticated scope while keeping handlers and disposal independent", async () => {
    mockRealtimeAuth = {
      user: { id: "user-a" },
      session: { access_token: "session-a" },
      loading: false,
    };
    const harness = installDefaultHookHarness(300);
    const first = renderHook(() => useRealtime(exactConversationScope));
    const second = renderHook(() => useRealtime(exactConversationScope));
    await act(async () => flushController());
    expect(harness.fetchMock).toHaveBeenCalledTimes(1);
    expect(harness.sockets).toHaveLength(1);
    const socket = harness.sockets[0]!;
    await openLegacySocket(
      socket,
      CHANNEL,
      harness.tokenExpiries[0]!,
      "shared"
    );
    expect(first.result.current.channel).not.toBe(
      second.result.current.channel
    );
    const firstHandler = jest.fn();
    const secondHandler = jest.fn();
    first.result.current.channel!.bind(
      "conversation.message.created",
      firstHandler
    );
    second.result.current.channel!.bind(
      "conversation.message.created",
      secondHandler
    );
    const receive = () =>
      socket.receive({
        type: "event",
        channel: CHANNEL,
        event: {
          eventId: "shared-event",
          version: 1,
          name: "conversation.message.created",
          workspaceId: WORKSPACE_ID,
          conversationId: CONVERSATION_ID,
          createdAt: "2030-01-01T00:00:00.000Z",
          dedupeKey: "shared-event",
          payload: {},
        },
      });
    act(receive);
    expect(firstHandler).toHaveBeenCalledTimes(1);
    expect(secondHandler).toHaveBeenCalledTimes(1);
    const microtask = jest
      .spyOn(globalThis, "queueMicrotask")
      .mockImplementation(() => undefined);
    firstHandler.mockImplementationOnce(() => {
      throw new Error("consumer failure");
    });
    act(receive);
    expect(secondHandler).toHaveBeenCalledTimes(2);
    expect(microtask).not.toHaveBeenCalled();
    first.unmount();
    expect(socket.closeCalls).toBe(0);
    act(receive);
    expect(firstHandler).toHaveBeenCalledTimes(2);
    expect(secondHandler).toHaveBeenCalledTimes(3);
    second.unmount();
    expect(socket.closeCalls).toBe(1);
  });

  it("replaces a pooled token for the same user and keeps custom loaders isolated from auth changes", async () => {
    mockRealtimeAuth = {
      user: { id: "user-a" },
      session: { access_token: "session-a" },
      loading: false,
    };
    const harness = installDefaultHookHarness(300);
    const options: RealtimeControllerOptionsV1 = {
      channels: [WORKSPACE_CHANNEL],
      loadToken: jest.fn(async () => LEGACY_TOKEN),
    };
    const first = renderHook(() => useRealtime(workspaceScope));
    const second = renderHook(() => useRealtime(workspaceScope));
    const custom = renderHook(() => useRealtime(workspaceScope, options));
    const anotherCustom = renderHook(() =>
      useRealtime(workspaceScope, options)
    );
    await act(async () => flushController());
    expect(harness.sockets).toHaveLength(3);
    expect(options.loadToken).toHaveBeenCalledTimes(2);
    mockRealtimeAuth = {
      user: { id: "user-a" },
      session: { access_token: "session-refreshed" },
      loading: false,
    };
    first.rerender();
    second.rerender();
    custom.rerender();
    anotherCustom.rerender();
    await act(async () => flushController());
    expect(harness.fetchMock).toHaveBeenCalledTimes(2);
    expect(options.loadToken).toHaveBeenCalledTimes(2);
    expect(harness.sockets).toHaveLength(4);
    first.unmount();
    second.unmount();
    custom.unmount();
    anotherCustom.unmount();
    expect(harness.sockets.every(socket => socket.closeCalls === 1)).toBe(true);
  });

  it("separates workspace and conversation subscriptions and replaces the authenticated session", async () => {
    mockRealtimeAuth = {
      user: { id: "user-a" },
      session: { access_token: "session-a" },
      loading: false,
    };
    const harness = installDefaultHookHarness(300);
    const workspace = renderHook(() => useRealtime(workspaceScope));
    const conversation = renderHook(() => useRealtime(exactConversationScope));
    await act(async () => flushController());
    expect(harness.sockets).toHaveLength(2);
    mockRealtimeAuth = {
      user: { id: "user-b" },
      session: { access_token: "session-b" },
      loading: false,
    };
    workspace.rerender();
    conversation.rerender();
    await act(async () => flushController());
    expect(harness.sockets).toHaveLength(4);
    expect(harness.sockets[0]!.closeCalls).toBe(1);
    expect(harness.sockets[1]!.closeCalls).toBe(1);
    mockRealtimeAuth = { user: null, session: null, loading: false };
    workspace.rerender();
    conversation.rerender();
    await act(async () => flushController());
    expect(harness.fetchMock).toHaveBeenCalledTimes(4);
    expect(harness.sockets[2]!.closeCalls).toBe(1);
    expect(harness.sockets[3]!.closeCalls).toBe(1);
    expect(workspace.result.current.channel).toBeNull();
    workspace.unmount();
    conversation.unmount();
  });

  it("waits for the auth provider session and retains live delivery when the tab is hidden", async () => {
    mockRealtimeAuth = { user: null, session: null, loading: true };
    const harness = installDefaultHookHarness(300);
    const hook = renderHook(() => useRealtime(workspaceScope));
    await act(async () => flushController());
    expect(harness.fetchMock).not.toHaveBeenCalled();
    mockRealtimeAuth = {
      user: { id: "user-a" },
      session: { access_token: "session-a" },
      loading: false,
    };
    hook.rerender();
    await act(async () => flushController());
    const socket = harness.sockets[0]!;
    await openLegacySocket(
      socket,
      WORKSPACE_CHANNEL,
      harness.tokenExpiries[0]!,
      "background"
    );
    jest.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await advanceWhileKeepingLegacyAlive(harness.sockets, 65_000);
    expect(socket.closeCalls).toBe(0);
    expect(hook.result.current.isConnected).toBe(true);
    hook.unmount();
  });

  it.each(["workspace", "conversation"] as const)(
    "keeps an inline %s scope subscribed across renders",
    async kind => {
      const harness = installDefaultHookHarness(300);
      const hook = renderHook(() =>
        useRealtime(
          kind === "workspace"
            ? { kind, workspaceId: WORKSPACE_ID }
            : {
                kind,
                workspaceId: WORKSPACE_ID,
                conversationId: CONVERSATION_ID,
              }
        )
      );
      await act(async () => flushController());
      const socket = harness.sockets[0]!;
      await openLegacySocket(
        socket,
        kind === "workspace" ? WORKSPACE_CHANNEL : CHANNEL,
        harness.tokenExpiries[0]!,
        "connection-inline"
      );
      const channel = hook.result.current.channel;

      hook.rerender();
      hook.rerender();
      await act(async () => flushController());

      expect(hook.result.current.isConnected).toBe(true);
      expect(hook.result.current.channel).toBe(channel);
      expect(harness.fetchMock).toHaveBeenCalledTimes(1);
      expect(harness.sockets).toHaveLength(1);
      expect(socket.closeCalls).toBe(0);
      hook.unmount();
      expect(socket.closeCalls).toBe(1);
    }
  );

  it("keeps the same hook snapshot across equivalent controller publishes", async () => {
    const harness = installDefaultHookHarness(300);
    const hook = renderHook(() => useRealtime(exactConversationScope));
    await act(async () => flushController());
    const socket = harness.sockets[0]!;
    await openLegacySocket(
      socket,
      CHANNEL,
      harness.tokenExpiries[0]!,
      "connection-equivalent"
    );
    const channel = hook.result.current.channel;
    const connected = hook.result.current;

    await act(async () => {
      for (let i = 0; i < 50; i += 1) {
        socket.receive({ type: "subscribed", channels: [CHANNEL] });
      }
    });

    expect(hook.result.current).toBe(connected);
    expect(hook.result.current.isConnected).toBe(true);
    expect(hook.result.current.channel).toBe(channel);
    hook.unmount();
  });

  it("rotates a five-minute socket twice and promotes only after the exact ACK", async () => {
    const harness = installDefaultHookHarness(300);
    const handler = jest.fn();
    const hook = renderHook(() => useRealtime(exactConversationScope));
    await act(async () => flushController());
    const first = harness.sockets[0]!;
    await openLegacySocket(
      first,
      CHANNEL,
      harness.tokenExpiries[0]!,
      "connection-1"
    );
    hook.result.current.channel?.bind("conversation.message.created", handler);

    await advanceWhileKeepingLegacyAlive(harness.sockets, 270_000);
    expect(harness.fetchMock).toHaveBeenCalledTimes(2);
    const second = harness.sockets[1]!;
    act(() => {
      second.open();
      second.receive({
        type: "ready",
        connectionId: "connection-2",
        expiresAt: harness.tokenExpiries[1],
      });
      second.receive({ type: "subscribed", channels: [WORKSPACE_CHANNEL] });
    });
    expect(first.closeCalls).toBe(0);
    act(() => second.receive({ type: "subscribed", channels: [CHANNEL] }));
    expect(first.closeCalls).toBe(1);

    first.receive({
      type: "event",
      channel: CHANNEL,
      event: {
        eventId: "retired-event",
        version: 1,
        name: "conversation.message.created",
        workspaceId: WORKSPACE_ID,
        conversationId: CONVERSATION_ID,
        createdAt: "2030-01-01T00:04:30.000Z",
        dedupeKey: "retired-event",
        payload: {},
      },
    });
    second.receive({
      type: "event",
      channel: CHANNEL,
      event: {
        eventId: "current-event",
        version: 1,
        name: "conversation.message.created",
        workspaceId: WORKSPACE_ID,
        conversationId: CONVERSATION_ID,
        createdAt: "2030-01-01T00:04:30.000Z",
        dedupeKey: "current-event",
        payload: {},
      },
    });
    expect(handler).toHaveBeenCalledTimes(1);

    await advanceWhileKeepingLegacyAlive(harness.sockets, 270_000);
    expect(harness.fetchMock).toHaveBeenCalledTimes(3);
    const third = harness.sockets[2]!;
    await openLegacySocket(
      third,
      CHANNEL,
      harness.tokenExpiries[2]!,
      "connection-3"
    );
    expect(second.closeCalls).toBe(1);
    await advanceWhileKeepingLegacyAlive(harness.sockets, 61_000);
    expect(hook.result.current.isConnected).toBe(true);
    expect(harness.sockets).toHaveLength(3);
    hook.unmount();
  });

  it("uses the earlier gateway-ready expiry for refresh", async () => {
    const harness = installDefaultHookHarness(300);
    const hook = renderHook(() => useRealtime(exactConversationScope));
    await act(async () => flushController());
    const first = harness.sockets[0]!;
    await openLegacySocket(
      first,
      CHANNEL,
      "2030-01-01T00:04:00.000Z",
      "connection-earlier"
    );

    await advanceWhileKeepingLegacyAlive(harness.sockets, 209_999);
    expect(harness.fetchMock).toHaveBeenCalledTimes(1);
    await advanceWhileKeepingLegacyAlive(harness.sockets, 1);
    expect(harness.fetchMock).toHaveBeenCalledTimes(2);
    hook.unmount();
  });

  it("retries a failed candidate while retaining the old connection", async () => {
    const harness = installDefaultHookHarness(300);
    const hook = renderHook(() => useRealtime(exactConversationScope));
    await act(async () => flushController());
    const active = harness.sockets[0]!;
    await openLegacySocket(
      active,
      CHANNEL,
      harness.tokenExpiries[0]!,
      "connection-active"
    );
    await advanceWhileKeepingLegacyAlive(harness.sockets, 270_000);
    const candidate = harness.sockets[1]!;
    expect(candidate).toBeDefined();
    if (!candidate) return;
    act(() => {
      candidate.open();
      candidate.fail();
    });
    expect(active.closeCalls).toBe(0);

    await advanceWhileKeepingLegacyAlive(harness.sockets, 15_000);
    expect(harness.fetchMock).toHaveBeenCalledTimes(3);
    expect(active.closeCalls).toBe(0);
    expect(hook.result.current.isConnected).toBe(true);
    hook.unmount();
  });

  it("retires a never-ACK candidate, keeps active delivery, retries, and cancels on dispose", async () => {
    const harness = installDefaultHookHarness(300);
    const handler = jest.fn();
    const hook = renderHook(() => useRealtime(exactConversationScope));
    await act(async () => flushController());
    const active = harness.sockets[0]!;
    await openLegacySocket(
      active,
      CHANNEL,
      harness.tokenExpiries[0]!,
      "never-ack-active"
    );
    hook.result.current.channel?.bind("conversation.message.created", handler);

    await advanceWhileKeepingLegacyAlive(harness.sockets, 270_000);
    const candidate = harness.sockets[1]!;
    act(() => {
      candidate.open();
      candidate.receive({
        type: "ready",
        connectionId: "never-ack-candidate",
        expiresAt: harness.tokenExpiries[1],
      });
      candidate.receive({
        type: "subscribed",
        channels: [WORKSPACE_CHANNEL],
      });
      active.receive({
        type: "event",
        channel: CHANNEL,
        event: {
          eventId: "active-during-never-ack",
          version: 1,
          name: "conversation.message.created",
          workspaceId: WORKSPACE_ID,
          conversationId: CONVERSATION_ID,
          createdAt: "2030-01-01T00:04:30.000Z",
          dedupeKey: "active-during-never-ack",
          payload: {},
        },
      });
    });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(active.closeCalls).toBe(0);

    await advanceWhileKeepingLegacyAlive(
      harness.sockets,
      REALTIME_CANDIDATE_ACK_DEADLINE_MS + REALTIME_ROTATION_RETRY_MAX_MS
    );
    expect(candidate.closeCalls).toBe(1);
    expect(active.closeCalls).toBe(0);
    expect(harness.fetchMock).toHaveBeenCalledTimes(3);
    const replacement = harness.sockets[2]!;
    await openLegacySocket(
      replacement,
      CHANNEL,
      harness.tokenExpiries[2]!,
      "never-ack-replacement"
    );
    expect(active.closeCalls).toBe(1);

    replacement.receive({
      type: "event",
      channel: CHANNEL,
      event: {
        eventId: "replacement-after-never-ack",
        version: 1,
        name: "conversation.message.created",
        workspaceId: WORKSPACE_ID,
        conversationId: CONVERSATION_ID,
        createdAt: "2030-01-01T00:04:55.000Z",
        dedupeKey: "replacement-after-never-ack",
        payload: {},
      },
    });
    expect(handler).toHaveBeenCalledTimes(2);

    hook.unmount();
    const fetchCountAfterDispose = harness.fetchMock.mock.calls.length;
    const socketCountAfterDispose = harness.sockets.length;
    act(() => jest.advanceTimersByTime(1_000_000));
    await act(async () => flushController());
    expect(harness.fetchMock).toHaveBeenCalledTimes(fetchCountAfterDispose);
    expect(harness.sockets).toHaveLength(socketCountAfterDispose);
  });

  it.each(["never-ack", "exact-ack"] as const)(
    "keeps candidate ownership authoritative after active close: %s",
    async branch => {
      const harness = installDefaultHookHarness(300);
      const hook = renderHook(() => useRealtime(exactConversationScope));
      await act(async () => flushController());
      const active = harness.sockets[0]!;
      await openLegacySocket(
        active,
        CHANNEL,
        harness.tokenExpiries[0]!,
        `active-close-${branch}`
      );
      await advanceWhileKeepingLegacyAlive(harness.sockets, 270_000);
      const candidate = harness.sockets[1]!;
      act(() => {
        candidate.open();
        candidate.receive({
          type: "ready",
          connectionId: `candidate-${branch}`,
          expiresAt: harness.tokenExpiries[1],
        });
        active.close(1006, "peer_closed_during_rotation");
      });

      if (branch === "exact-ack") {
        act(() =>
          candidate.receive({ type: "subscribed", channels: [CHANNEL] })
        );
        expect(hook.result.current.isConnected).toBe(true);
        act(() =>
          jest.advanceTimersByTime(
            REALTIME_CANDIDATE_ACK_DEADLINE_MS + REALTIME_ROTATION_RETRY_MAX_MS
          )
        );
        await act(async () => flushController());
        expect(candidate.closeCalls).toBe(0);
        expect(harness.fetchMock).toHaveBeenCalledTimes(2);
      } else {
        act(() => jest.advanceTimersByTime(REALTIME_CANDIDATE_ACK_DEADLINE_MS));
        await act(async () => flushController());
        expect(candidate.closeCalls).toBe(1);
        act(() => jest.advanceTimersByTime(1_000));
        await act(async () => flushController());
        expect(harness.fetchMock).toHaveBeenCalledTimes(3);
        expect(harness.sockets).toHaveLength(3);
      }

      hook.unmount();
    }
  );

  it("uses the one-hour refresh vector without waiting for signed expiry", async () => {
    const harness = installDefaultHookHarness(3_600);
    const hook = renderHook(() => useRealtime(workspaceScope));
    await act(async () => flushController());
    await openLegacySocket(
      harness.sockets[0]!,
      WORKSPACE_CHANNEL,
      harness.tokenExpiries[0]!,
      "connection-hour"
    );

    await advanceWhileKeepingLegacyAlive(harness.sockets, 3_569_999);
    expect(harness.fetchMock).toHaveBeenCalledTimes(1);
    await advanceWhileKeepingLegacyAlive(harness.sockets, 1);
    expect(harness.fetchMock).toHaveBeenCalledTimes(2);
    hook.unmount();
  });

  it("disposes the old scope before a new exact scope can connect", async () => {
    const harness = installDefaultHookHarness(300);
    const hook = renderHook(
      ({ scope }: { scope: { kind: "workspace"; workspaceId: string } }) =>
        useRealtime(scope),
      {
        initialProps: {
          scope: { kind: "workspace" as const, workspaceId: WORKSPACE_ID },
        },
      }
    );
    await act(async () => flushController());
    const oldSocket = harness.sockets[0]!;

    hook.rerender({
      scope: { kind: "workspace", workspaceId: "workspace_replacement" },
    });
    await act(async () => flushController());

    expect(oldSocket.closeCalls).toBe(1);
    expect(harness.fetchMock).toHaveBeenCalledTimes(2);
    expect(harness.fetchMock.mock.calls[1]?.[0]).toBe(
      "/api/realtime/token?workspaceId=workspace_replacement"
    );
    hook.unmount();
  });

  it("replaces an inline conversation subscription only when its identity changes and clears it when disabled", async () => {
    const harness = installDefaultHookHarness(300);
    const hook = renderHook(
      ({ conversationId }: { conversationId: string | null }) =>
        useRealtime(
          conversationId
            ? {
                kind: "conversation",
                workspaceId: WORKSPACE_ID,
                conversationId,
              }
            : null
        ),
      { initialProps: { conversationId: CONVERSATION_ID as string | null } }
    );
    await act(async () => flushController());
    const first = harness.sockets[0]!;
    const nextConversationId = "507f1f77bcf86cd799439012";

    hook.rerender({ conversationId: nextConversationId });
    await act(async () => flushController());
    expect(first.closeCalls).toBe(1);
    expect(harness.fetchMock).toHaveBeenCalledTimes(2);
    expect(harness.fetchMock).toHaveBeenLastCalledWith(
      `/api/realtime/token?workspaceId=${WORKSPACE_ID}&conversationId=${nextConversationId}`,
      expect.any(Object)
    );

    hook.rerender({ conversationId: null });
    expect(harness.sockets[1]!.closeCalls).toBe(1);
    expect(hook.result.current).toEqual({ channel: null, isConnected: false });
    hook.rerender({ conversationId: null });
    expect(harness.fetchMock).toHaveBeenCalledTimes(2);
    hook.unmount();
  });
});
