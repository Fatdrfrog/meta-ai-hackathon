// @ts-expect-error Node types belong to the approved worker-owned test runner.
import assert from "node:assert/strict";
// @ts-expect-error Node types belong to the approved worker-owned test runner.
import { readFileSync } from "node:fs";
// @ts-expect-error Node types belong to the approved worker-owned test runner.
import { registerHooks } from "node:module";
// @ts-expect-error Node types belong to the approved worker-owned test runner.
import test from "node:test";
import {
  REALTIME_CANDIDATE_ACK_DEADLINE_MS,
  REALTIME_ROTATION_RETRY_MAX_MS,
} from "@icecore/shared/types/realtime";
import {
  MOBILE_REALTIME_SCOPE_ERROR,
  planMobileRealtimeSubscription,
  subscribeToRealtimeScope,
} from "./realtime";

const WORKSPACE_ID = "workspace_mobile";
const CONVERSATION_ID = "507f1f77bcf86cd799439011";
const SOURCE = readFileSync(new URL("./realtime.ts", import.meta.url), "utf8");
const MOCK_EXPO_CONSTANTS_URL = "mock:task-17-expo-constants";
let expoConfigLoadCount = 0;

registerHooks({
  resolve(
    specifier: string,
    context: unknown,
    nextResolve: (specifier: string, context: unknown) => unknown,
  ) {
    if (specifier === "expo-constants") {
      return { url: MOCK_EXPO_CONSTANTS_URL, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(
    url: string,
    context: unknown,
    nextLoad: (url: string, context: unknown) => unknown,
  ) {
    if (url === MOCK_EXPO_CONSTANTS_URL) {
      expoConfigLoadCount += 1;
      return {
        format: "module",
        source:
          'export default { expoConfig: { extra: { mobile: { apiBaseUrl: "https://mobile.test" } } } };',
        shortCircuit: true,
      };
    }
    return nextLoad(url, context);
  },
});

type MobileTimerTestContext = {
  mock: {
    timers: {
      enable(options: { apis: string[]; now: Date }): void;
      tick(milliseconds: number): void;
    };
  };
};

class FakeMobileWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static readonly instances: FakeMobileWebSocket[] = [];

  readonly sent: string[] = [];
  readonly url: string;
  readyState = FakeMobileWebSocket.CONNECTING;
  closeCalls = 0;
  onopen: (() => void) | null = null;
  onmessage: ((message: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeMobileWebSocket.instances.push(this);
  }

  open(): void {
    this.readyState = FakeMobileWebSocket.OPEN;
    this.onopen?.();
  }

  receive(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  send(value: string): void {
    this.sent.push(value);
  }

  close(): void {
    if (this.readyState === FakeMobileWebSocket.CLOSED) return;
    this.closeCalls += 1;
    this.readyState = FakeMobileWebSocket.CLOSED;
    this.onclose?.();
  }
}

async function flushMicrotasks(iterations = 20): Promise<void> {
  for (let index = 0; index < iterations; index += 1) {
    await Promise.resolve();
  }
}

async function flushMacrotasks(iterations = 5): Promise<void> {
  for (let index = 0; index < iterations; index += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function installFakeWebSocket(): typeof WebSocket {
  const original = globalThis.WebSocket;
  FakeMobileWebSocket.instances.length = 0;
  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    writable: true,
    value: FakeMobileWebSocket,
  });
  return original;
}

function restoreWebSocket(original: typeof WebSocket): void {
  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    writable: true,
    value: original,
  });
}

test("plans the legacy workspace token request and exact workspace channel", () => {
  assert.deepEqual(
    planMobileRealtimeSubscription({
      kind: "workspace",
      workspaceId: WORKSPACE_ID,
    }),
    {
      scope: { kind: "workspace", workspaceId: WORKSPACE_ID },
      channelName: `workspace:${WORKSPACE_ID}`,
      tokenPath: `/api/realtime/token?workspaceId=${WORKSPACE_ID}`,
    },
  );
});

test("plans the legacy exact-conversation request without broadening visibility", () => {
  assert.deepEqual(
    planMobileRealtimeSubscription({
      kind: "conversation",
      workspaceId: WORKSPACE_ID,
      conversationId: CONVERSATION_ID,
    }),
    {
      scope: {
        kind: "conversation",
        workspaceId: WORKSPACE_ID,
        conversationId: CONVERSATION_ID,
      },
      channelName: `conversation:${WORKSPACE_ID}:${CONVERSATION_ID}`,
      tokenPath:
        `/api/realtime/token?workspaceId=${WORKSPACE_ID}` +
        `&conversationId=${CONVERSATION_ID}`,
    },
  );
});

test("rejects Requests-v1 and malformed runtime scopes with one bounded error", () => {
  const invalidScopes: unknown[] = [
    { kind: "requests", workspaceId: WORKSPACE_ID },
    { kind: "other", workspaceId: WORKSPACE_ID },
    { kind: "workspace", workspaceId: "" },
    { kind: "workspace", workspaceId: "bad/workspace" },
    { kind: "conversation", workspaceId: WORKSPACE_ID },
    { kind: "conversation", workspaceId: "", conversationId: CONVERSATION_ID },
    {
      kind: "conversation",
      workspaceId: WORKSPACE_ID,
      conversationId: "conversation_mobile",
    },
    null,
  ];

  for (const scope of invalidScopes) {
    assert.throws(
      () => planMobileRealtimeSubscription(scope),
      (error: unknown) =>
        error instanceof Error && error.message === MOBILE_REALTIME_SCOPE_ERROR,
    );
  }
});

test("rejects invalid runtime subscriptions before config, fetch, URL, or WebSocket side effects", async () => {
  const originalFetch = globalThis.fetch;
  const originalURL = globalThis.URL;
  const originalURLSearchParams = globalThis.URLSearchParams;
  const originalWebSocket = installFakeWebSocket();
  const configLoadsBefore = expoConfigLoadCount;
  let fetchCount = 0;
  let urlConstructionCount = 0;
  let cleanup: (() => Promise<void>) | undefined;

  class CountingURL extends originalURL {
    constructor(url: string | URL, base?: string | URL) {
      urlConstructionCount += 1;
      super(url, base);
    }
  }

  class CountingURLSearchParams extends originalURLSearchParams {
    constructor(init?: ConstructorParameters<typeof URLSearchParams>[0]) {
      urlConstructionCount += 1;
      super(init);
    }
  }

  globalThis.fetch = (async () => {
    fetchCount += 1;
    return {
      ok: true,
      json: async () => ({
        token: "must-not-be-fetched",
        url: "https://gateway.test/socket",
        expiresAt: "2030-01-01T00:05:00.000Z",
      }),
    } as Response;
  }) as typeof fetch;
  Object.defineProperty(globalThis, "URL", {
    configurable: true,
    writable: true,
    value: CountingURL,
  });
  Object.defineProperty(globalThis, "URLSearchParams", {
    configurable: true,
    writable: true,
    value: CountingURLSearchParams,
  });

  const outcomes: string[] = [];
  try {
    for (const scope of [
      { kind: "requests", workspaceId: WORKSPACE_ID },
      { kind: "conversation", workspaceId: WORKSPACE_ID },
      { kind: "workspace", workspaceId: "bad/workspace" },
      {
        kind: "conversation",
        workspaceId: WORKSPACE_ID,
        conversationId: "conversation_mobile",
      },
    ]) {
      try {
        cleanup = await subscribeToRealtimeScope({
          scope: scope as never,
          accessToken: "mobile-access-token",
          onEvent: () => undefined,
        });
        await flushMacrotasks();
        outcomes.push("resolved");
      } catch (error) {
        outcomes.push(error instanceof Error ? error.message : "non-error");
      } finally {
        await cleanup?.();
        cleanup = undefined;
      }
    }
    await flushMacrotasks();

    assert.deepEqual(outcomes, [
      MOBILE_REALTIME_SCOPE_ERROR,
      MOBILE_REALTIME_SCOPE_ERROR,
      MOBILE_REALTIME_SCOPE_ERROR,
      MOBILE_REALTIME_SCOPE_ERROR,
    ]);
    assert.equal(expoConfigLoadCount, configLoadsBefore);
    assert.equal(fetchCount, 0);
    assert.equal(urlConstructionCount, 0);
    assert.equal(FakeMobileWebSocket.instances.length, 0);
  } finally {
    await cleanup?.();
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "URL", {
      configurable: true,
      writable: true,
      value: originalURL,
    });
    Object.defineProperty(globalThis, "URLSearchParams", {
      configurable: true,
      writable: true,
      value: originalURLSearchParams,
    });
    restoreWebSocket(originalWebSocket);
  }
});

test("retains bearer GET and query-token websocket transport", () => {
  assert.match(SOURCE, /Authorization:\s*`Bearer \$\{accessToken\}`/);
  assert.match(SOURCE, /searchParams\.set\("token", token\)/);
  assert.match(SOURCE, /\/api\/realtime\/token\?\$\{params\.toString\(\)\}/);
});

test("routes response expiry through the shared refresh planner", () => {
  assert.match(
    SOURCE,
    /planRealtimeTokenRefresh\([\s\S]*expiresAt[\s\S]*\)/,
    "300-second and 3,600-second response expiries must share one planner",
  );
});

for (const { ttlSeconds, refreshDelayMs } of [
  { ttlSeconds: 300, refreshDelayMs: 270_000 },
  { ttlSeconds: 3_600, refreshDelayMs: 3_570_000 },
]) {
  test(`retires a never-ACK ${ttlSeconds}-second candidate, retries, promotes, and disposes every timer`, async (context: MobileTimerTestContext) => {
    await import("./config");
    context.mock.timers.enable({
      apis: ["setTimeout", "Date"],
      now: new Date("2030-01-01T00:00:00.000Z"),
    });
    const originalFetch = globalThis.fetch;
    const originalWebSocket = installFakeWebSocket();
    const fetchInputs: Array<{ url: string; init?: RequestInit }> = [];
    let tokenSequence = 0;
    let cleanup: (() => Promise<void>) | undefined;
    const delivered: string[] = [];

    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      tokenSequence += 1;
      fetchInputs.push({ url: String(input), init });
      return {
        ok: true,
        json: async () => ({
          token: `mobile-token-${tokenSequence}`,
          url: "https://gateway.test/socket",
          expiresAt: new Date(Date.now() + ttlSeconds * 1_000).toISOString(),
        }),
      } as Response;
    }) as typeof fetch;

    try {
      cleanup = await subscribeToRealtimeScope({
        scope: { kind: "workspace", workspaceId: WORKSPACE_ID },
        accessToken: "mobile-access-token",
        onEvent: (_eventName, event) => delivered.push(event.eventId),
      });
      await flushMicrotasks();
      const active = FakeMobileWebSocket.instances[0];
      assert.ok(active, "initial mobile socket must connect");
      active.open();
      active.receive({
        type: "ready",
        connectionId: "mobile-active",
        expiresAt: new Date(Date.now() + ttlSeconds * 1_000).toISOString(),
      });
      active.receive({
        type: "subscribed",
        channels: [`workspace:${WORKSPACE_ID}`],
      });
      assert.deepEqual(JSON.parse(active.sent[0] || "null"), {
        type: "subscribe",
        channels: [`workspace:${WORKSPACE_ID}`],
      });

      context.mock.timers.tick(refreshDelayMs);
      await flushMicrotasks();
      const candidate = FakeMobileWebSocket.instances[1];
      assert.ok(candidate, "expiry refresh must create one candidate");
      assert.equal(active.closeCalls, 0);
      candidate.open();
      candidate.receive({
        type: "ready",
        connectionId: "mobile-candidate",
        expiresAt: new Date(Date.now() + ttlSeconds * 1_000).toISOString(),
      });
      candidate.receive({
        type: "subscribed",
        channels: [`conversation:${WORKSPACE_ID}:${CONVERSATION_ID}`],
      });
      assert.equal(active.closeCalls, 0, "wrong ACK cannot promote");
      candidate.receive({
        type: "event",
        channel: `workspace:${WORKSPACE_ID}`,
        event: {
          eventId: "mobile-candidate-before-promotion",
          version: 1,
          name: "conversation.row.changed",
          workspaceId: WORKSPACE_ID,
          conversationId: CONVERSATION_ID,
          createdAt: "2030-01-01T00:04:30.000Z",
          dedupeKey: "mobile-candidate-before-promotion",
          payload: {},
        },
      });
      active.receive({
        type: "event",
        channel: `workspace:${WORKSPACE_ID}`,
        event: {
          eventId: "mobile-active-during-candidate",
          version: 1,
          name: "conversation.row.changed",
          workspaceId: WORKSPACE_ID,
          conversationId: CONVERSATION_ID,
          createdAt: "2030-01-01T00:04:30.000Z",
          dedupeKey: "mobile-active-during-candidate",
          payload: {},
        },
      });
      assert.deepEqual(
        delivered,
        ["mobile-active-during-candidate"],
        "an unacknowledged candidate is silent while the active stays live",
      );

      context.mock.timers.tick(REALTIME_CANDIDATE_ACK_DEADLINE_MS);
      await flushMicrotasks();
      assert.equal(candidate.closeCalls, 1, "the never-ACK candidate retires");
      assert.equal(
        active.closeCalls,
        0,
        "the active survives candidate timeout",
      );
      context.mock.timers.tick(REALTIME_ROTATION_RETRY_MAX_MS);
      await flushMicrotasks();
      const replacement = FakeMobileWebSocket.instances[2];
      assert.ok(replacement, "bounded retry must create one replacement");
      replacement.open();
      replacement.receive({
        type: "ready",
        connectionId: "mobile-replacement",
        expiresAt: new Date(Date.now() + ttlSeconds * 1_000).toISOString(),
      });
      replacement.receive({
        type: "subscribed",
        channels: [`workspace:${WORKSPACE_ID}`],
      });
      assert.equal(active.closeCalls, 1);

      active.receive({
        type: "event",
        channel: `workspace:${WORKSPACE_ID}`,
        event: {
          eventId: "mobile-retired-active-event",
          version: 1,
          name: "conversation.row.changed",
          workspaceId: WORKSPACE_ID,
          conversationId: CONVERSATION_ID,
          createdAt: "2030-01-01T00:04:30.000Z",
          dedupeKey: "mobile-retired-active-event",
          payload: {},
        },
      });
      replacement.receive({
        type: "event",
        channel: `workspace:${WORKSPACE_ID}`,
        event: {
          eventId: "mobile-event-after-rotation",
          version: 1,
          name: "conversation.row.changed",
          workspaceId: WORKSPACE_ID,
          conversationId: CONVERSATION_ID,
          createdAt: "2030-01-01T00:04:30.000Z",
          dedupeKey: "mobile-event-after-rotation",
          payload: {},
        },
      });
      assert.deepEqual(
        delivered,
        ["mobile-active-during-candidate", "mobile-event-after-rotation"],
        "only the promoted candidate owns product delivery",
      );
      assert.equal(fetchInputs.length, 3);
      assert.equal(
        new Headers(fetchInputs[0]?.init?.headers).get("authorization"),
        "Bearer mobile-access-token",
      );
      assert.equal(
        fetchInputs[0]?.url,
        `https://mobile.test/api/realtime/token?workspaceId=${WORKSPACE_ID}`,
      );
      assert.equal(
        replacement.url,
        "wss://gateway.test/socket?token=mobile-token-3",
      );

      await cleanup();
      cleanup = undefined;
      assert.equal(replacement.closeCalls, 1);
      const fetchCountAfterDispose = fetchInputs.length;
      const socketCountAfterDispose = FakeMobileWebSocket.instances.length;
      context.mock.timers.tick(ttlSeconds * 3_000);
      await flushMicrotasks();
      assert.equal(fetchInputs.length, fetchCountAfterDispose);
      assert.equal(
        FakeMobileWebSocket.instances.length,
        socketCountAfterDispose,
      );
    } finally {
      await cleanup?.();
      globalThis.fetch = originalFetch;
      restoreWebSocket(originalWebSocket);
    }
  });
}

test("keeps the candidate deadline authoritative across active-close never-ACK and exact-ACK branches", async (context: MobileTimerTestContext) => {
  await import("./config");
  context.mock.timers.enable({
    apis: ["setTimeout", "Date"],
    now: new Date("2030-01-01T00:00:00.000Z"),
  });
  const originalFetch = globalThis.fetch;
  const originalWebSocket = installFakeWebSocket();
  let cleanup: (() => Promise<void>) | undefined;

  try {
    for (const branch of ["never-ack", "exact-ack"] as const) {
      FakeMobileWebSocket.instances.length = 0;
      let tokenSequence = 0;
      globalThis.fetch = (async () => {
        tokenSequence += 1;
        return {
          ok: true,
          json: async () => ({
            token: `${branch}-token-${tokenSequence}`,
            url: "https://gateway.test/socket",
            expiresAt: new Date(Date.now() + 300_000).toISOString(),
          }),
        } as Response;
      }) as typeof fetch;

      cleanup = await subscribeToRealtimeScope({
        scope: { kind: "workspace", workspaceId: WORKSPACE_ID },
        accessToken: "mobile-access-token",
        onEvent: () => undefined,
      });
      await flushMicrotasks();
      const active = FakeMobileWebSocket.instances[0];
      assert.ok(active);
      active.open();
      active.receive({
        type: "ready",
        connectionId: `${branch}-active`,
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
      });
      active.receive({
        type: "subscribed",
        channels: [`workspace:${WORKSPACE_ID}`],
      });

      context.mock.timers.tick(270_000);
      await flushMicrotasks();
      const candidate = FakeMobileWebSocket.instances[1];
      assert.ok(candidate);
      candidate.open();
      candidate.receive({
        type: "ready",
        connectionId: `${branch}-candidate`,
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
      });
      active.close();

      if (branch === "exact-ack") {
        candidate.receive({
          type: "subscribed",
          channels: [`workspace:${WORKSPACE_ID}`],
        });
        context.mock.timers.tick(
          REALTIME_CANDIDATE_ACK_DEADLINE_MS + REALTIME_ROTATION_RETRY_MAX_MS,
        );
        await flushMicrotasks();
        assert.equal(tokenSequence, 2);
        assert.equal(FakeMobileWebSocket.instances.length, 2);
        assert.equal(candidate.closeCalls, 0);
      } else {
        context.mock.timers.tick(REALTIME_CANDIDATE_ACK_DEADLINE_MS);
        await flushMicrotasks();
        assert.equal(candidate.closeCalls, 1);
        context.mock.timers.tick(REALTIME_ROTATION_RETRY_MAX_MS);
        await flushMicrotasks();
        assert.equal(tokenSequence, 3);
        assert.equal(FakeMobileWebSocket.instances.length, 3);
      }

      await cleanup();
      cleanup = undefined;
    }
  } finally {
    await cleanup?.();
    globalThis.fetch = originalFetch;
    restoreWebSocket(originalWebSocket);
  }
});

test("keeps one replacement token load across active loss, timeout, promotion, and disposal", async (context: MobileTimerTestContext) => {
  await import("./config");
  context.mock.timers.enable({
    apis: ["setTimeout", "Date"],
    now: new Date("2030-01-01T00:00:00.000Z"),
  });
  const originalFetch = globalThis.fetch;
  const originalWebSocket = installFakeWebSocket();
  let cleanup: (() => Promise<void>) | undefined;

  const tokenResponse = (sequence: number): Response =>
    ({
      ok: true,
      json: async () => ({
        token: `deferred-token-${sequence}`,
        url: "https://gateway.test/socket",
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
      }),
    }) as Response;

  try {
    for (const branch of ["never-ack", "exact-ack", "dispose"] as const) {
      FakeMobileWebSocket.instances.length = 0;
      const replacementToken = createDeferred<Response>();
      const fetchSignals: Array<AbortSignal | null | undefined> = [];
      let tokenSequence = 0;
      globalThis.fetch = (async (
        _input: RequestInfo | URL,
        init?: RequestInit,
      ) => {
        tokenSequence += 1;
        fetchSignals.push(init?.signal);
        if (tokenSequence === 2) return replacementToken.promise;
        return tokenResponse(tokenSequence);
      }) as typeof fetch;

      cleanup = await subscribeToRealtimeScope({
        scope: { kind: "workspace", workspaceId: WORKSPACE_ID },
        accessToken: "mobile-access-token",
        onEvent: () => undefined,
      });
      await flushMicrotasks();
      const active = FakeMobileWebSocket.instances[0];
      assert.ok(active);
      active.open();
      active.receive({
        type: "ready",
        connectionId: `${branch}-active`,
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
      });
      active.receive({
        type: "subscribed",
        channels: [`workspace:${WORKSPACE_ID}`],
      });

      context.mock.timers.tick(270_000);
      await flushMicrotasks();
      assert.equal(tokenSequence, 2, "refresh owns one pending token request");
      assert.equal(FakeMobileWebSocket.instances.length, 1);

      active.close();
      context.mock.timers.tick(1_000);
      await flushMicrotasks();
      assert.equal(
        tokenSequence,
        2,
        "active loss must join the replacement load instead of starting P2",
      );
      assert.equal(
        FakeMobileWebSocket.instances.length,
        1,
        "no socket candidate exists before the owned token load resolves",
      );

      if (branch === "dispose") {
        await cleanup();
        cleanup = undefined;
        assert.equal(fetchSignals[1]?.aborted, true);
        replacementToken.resolve(tokenResponse(2));
        await flushMicrotasks();
        context.mock.timers.tick(
          REALTIME_CANDIDATE_ACK_DEADLINE_MS + REALTIME_ROTATION_RETRY_MAX_MS,
        );
        await flushMicrotasks();
        assert.equal(tokenSequence, 2);
        assert.equal(FakeMobileWebSocket.instances.length, 1);
        continue;
      }

      replacementToken.resolve(tokenResponse(2));
      await flushMicrotasks();
      const candidate = FakeMobileWebSocket.instances[1];
      assert.ok(candidate, "the owned replacement load creates one candidate");
      assert.equal(tokenSequence, 2);
      candidate.open();
      candidate.receive({
        type: "ready",
        connectionId: `${branch}-candidate`,
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
      });

      if (branch === "exact-ack") {
        candidate.receive({
          type: "subscribed",
          channels: [`workspace:${WORKSPACE_ID}`],
        });
        context.mock.timers.tick(
          REALTIME_CANDIDATE_ACK_DEADLINE_MS + REALTIME_ROTATION_RETRY_MAX_MS,
        );
        await flushMicrotasks();
        assert.equal(tokenSequence, 2);
        assert.equal(FakeMobileWebSocket.instances.length, 2);
        assert.equal(candidate.closeCalls, 0);
      } else {
        context.mock.timers.tick(REALTIME_CANDIDATE_ACK_DEADLINE_MS);
        await flushMicrotasks();
        assert.equal(candidate.closeCalls, 1);
        context.mock.timers.tick(REALTIME_ROTATION_RETRY_MAX_MS);
        await flushMicrotasks();
        assert.equal(tokenSequence, 3);
        assert.equal(FakeMobileWebSocket.instances.length, 3);
      }

      await cleanup();
      cleanup = undefined;
    }
  } finally {
    await cleanup?.();
    globalThis.fetch = originalFetch;
    restoreWebSocket(originalWebSocket);
  }
});

test("carries one rotation attempt through queued retry and retained-active loss", async (context: MobileTimerTestContext) => {
  await import("./config");
  context.mock.timers.enable({
    apis: ["setTimeout", "Date"],
    now: new Date("2030-01-01T00:00:00.000Z"),
  });
  const originalFetch = globalThis.fetch;
  const originalWebSocket = installFakeWebSocket();
  const originalRandom = Math.random;
  let cleanup: (() => Promise<void>) | undefined;
  let tokenSequence = 0;
  Math.random = () => 0;
  globalThis.fetch = (async () => {
    tokenSequence += 1;
    return {
      ok: true,
      json: async () => ({
        token: `queued-retry-token-${tokenSequence}`,
        url: "https://gateway.test/socket",
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
      }),
    } as Response;
  }) as typeof fetch;

  try {
    cleanup = await subscribeToRealtimeScope({
      scope: { kind: "workspace", workspaceId: WORKSPACE_ID },
      accessToken: "mobile-access-token",
      onEvent: () => undefined,
    });
    await flushMicrotasks();
    const active = FakeMobileWebSocket.instances[0];
    assert.ok(active);
    active.open();
    active.receive({
      type: "ready",
      connectionId: "queued-retry-active",
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    });
    active.receive({
      type: "subscribed",
      channels: [`workspace:${WORKSPACE_ID}`],
    });

    context.mock.timers.tick(270_000);
    await flushMicrotasks();
    const firstCandidate = FakeMobileWebSocket.instances[1];
    assert.ok(firstCandidate);
    firstCandidate.open();
    firstCandidate.receive({
      type: "ready",
      connectionId: "queued-retry-first-candidate",
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    });
    context.mock.timers.tick(REALTIME_CANDIDATE_ACK_DEADLINE_MS);
    await flushMicrotasks();
    assert.equal(firstCandidate.closeCalls, 1);

    context.mock.timers.tick(1_000);
    active.close();
    context.mock.timers.tick(6_500);
    await flushMicrotasks();
    const retryCandidate = FakeMobileWebSocket.instances[2];
    assert.ok(retryCandidate, "the queued retry creates one candidate");
    assert.equal(tokenSequence, 3);
    retryCandidate.open();
    retryCandidate.receive({
      type: "ready",
      connectionId: "queued-retry-second-candidate",
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    });

    context.mock.timers.tick(7_500);
    await flushMicrotasks();
    assert.equal(
      retryCandidate.closeCalls,
      1,
      "active loss during retry delay must not erase replacement intent",
    );

    context.mock.timers.tick(1_000);
    await flushMicrotasks();
    const ordinary = FakeMobileWebSocket.instances[3];
    assert.ok(ordinary, "exhausted headroom hands off to one ordinary load");
    assert.equal(tokenSequence, 4);
    assert.equal(FakeMobileWebSocket.instances.length, 4);
    ordinary.open();
    ordinary.receive({
      type: "ready",
      connectionId: "queued-retry-ordinary",
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    });
    context.mock.timers.tick(1);
    assert.equal(
      ordinary.closeCalls,
      0,
      "fresh generation must drop the exhausted old-active deadline",
    );
    ordinary.receive({
      type: "subscribed",
      channels: [`workspace:${WORKSPACE_ID}`],
    });
    context.mock.timers.tick(REALTIME_ROTATION_RETRY_MAX_MS);
    await flushMicrotasks();
    assert.equal(
      tokenSequence,
      4,
      "handoff must not duplicate the ordinary load",
    );
    assert.equal(ordinary.closeCalls, 0);
  } finally {
    await cleanup?.();
    Math.random = originalRandom;
    globalThis.fetch = originalFetch;
    restoreWebSocket(originalWebSocket);
  }
});

test("keeps captured old-active headroom for a late deferred mobile token", async (context: MobileTimerTestContext) => {
  await import("./config");
  context.mock.timers.enable({
    apis: ["setTimeout", "Date"],
    now: new Date("2030-01-01T00:00:00.000Z"),
  });
  const originalFetch = globalThis.fetch;
  const originalWebSocket = installFakeWebSocket();
  const deferredToken = createDeferred<Response>();
  let cleanup: (() => Promise<void>) | undefined;
  let tokenSequence = 0;
  globalThis.fetch = (async () => {
    tokenSequence += 1;
    if (tokenSequence === 2) return deferredToken.promise;
    return {
      ok: true,
      json: async () => ({
        token: `headroom-token-${tokenSequence}`,
        url: "https://gateway.test/socket",
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
      }),
    } as Response;
  }) as typeof fetch;

  try {
    cleanup = await subscribeToRealtimeScope({
      scope: { kind: "workspace", workspaceId: WORKSPACE_ID },
      accessToken: "mobile-access-token",
      onEvent: () => undefined,
    });
    await flushMicrotasks();
    const active = FakeMobileWebSocket.instances[0];
    assert.ok(active);
    active.open();
    active.receive({
      type: "ready",
      connectionId: "headroom-active",
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    });
    active.receive({
      type: "subscribed",
      channels: [`workspace:${WORKSPACE_ID}`],
    });

    context.mock.timers.tick(270_000);
    await flushMicrotasks();
    assert.equal(tokenSequence, 2);
    context.mock.timers.tick(24_000);
    active.close();
    deferredToken.resolve({
      ok: true,
      json: async () => ({
        token: "headroom-token-2",
        url: "https://gateway.test/socket",
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
      }),
    } as Response);
    await flushMicrotasks();
    const candidate = FakeMobileWebSocket.instances[1];
    assert.ok(candidate);
    candidate.open();
    candidate.receive({
      type: "ready",
      connectionId: "headroom-candidate",
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    });

    context.mock.timers.tick(999);
    assert.equal(candidate.closeCalls, 0);
    context.mock.timers.tick(1);
    await flushMicrotasks();
    assert.equal(
      candidate.closeCalls,
      1,
      "late response must retain the old active's five-second headroom",
    );
  } finally {
    await cleanup?.();
    globalThis.fetch = originalFetch;
    restoreWebSocket(originalWebSocket);
  }
});

test("contains no Requests endpoint, capability, presence, or commit control", () => {
  for (const forbidden of [
    "/api/realtime/requests-" + "token",
    "/api/requests/realtime-" + "rows",
    'kind: "requests"',
    'kind:"requests"',
    "requests-" + "v1",
    "request.message.preview",
    "request.window.changed",
    "requests_presence",
    "requests_commit",
  ]) {
    assert.equal(SOURCE.includes(forbidden), false, forbidden);
  }
});
