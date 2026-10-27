import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const readSource = (path) =>
  readFileSync(new URL(path, import.meta.url), "utf8");

const evaluateTypeScriptModule = (path, requireModule) => {
  const sourceUrl = new URL(path, import.meta.url);
  const compiled = ts.transpileModule(readFileSync(sourceUrl, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: sourceUrl.pathname,
  }).outputText;
  const loaded = { exports: {} };
  const evaluate = new Function(
    "require",
    "module",
    "exports",
    `${compiled}\n//# sourceURL=${sourceUrl.href}`,
  );
  evaluate(requireModule, loaded, loaded.exports);
  return loaded.exports;
};

const loadRealtimeModule = () => {
  const sharedRealtime = evaluateTypeScriptModule(
    "../../../packages/shared/src/types/realtime.ts",
    (specifier) => {
      if (specifier === "./requests-realtime") return {};
      if (specifier === "../lib/value-utils") {
        return evaluateTypeScriptModule(
          "../../../packages/shared/src/lib/value-utils.ts",
          (nested) => {
            throw new Error(`Unexpected shared value-utils import: ${nested}`);
          },
        );
      }
      throw new Error(`Unexpected shared realtime import: ${specifier}`);
    },
  );
  return evaluateTypeScriptModule("../src/lib/realtime.ts", (specifier) => {
    if (specifier === "@icecore/shared/types/realtime") {
      return sharedRealtime;
    }
    throw new Error(`Unexpected widget realtime import: ${specifier}`);
  });
};

test("message retries retain one client identity and original request body", async (t) => {
  const storage = evaluateTypeScriptModule(
    "../src/lib/storage.ts",
    (specifier) => {
      throw new Error(`Unexpected widget storage import: ${specifier}`);
    },
  );
  const { WidgetAPI } = evaluateTypeScriptModule(
    "../src/lib/api.ts",
    (specifier) => {
      if (specifier === "./storage") {
        return {
          ...storage,
          getVisitorToken: () => "visitor-token",
          getVisitorId: () => "visitor-1",
          STORAGE_KEYS: { VISITOR_TOKEN: "visitor-token" },
        };
      }
      throw new Error(`Unexpected widget API import: ${specifier}`);
    },
  );
  const requests = [];
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    requests.push(JSON.parse(options.body));
    if (requests.length === 1) throw new TypeError("response lost");
    if (requests.length === 2) return Response.json({}, { status: 503 });
    return Response.json({ success: true, conversationId: "conversation-1" });
  });
  const api = new WidgetAPI("https://example.com/api/widget", { baseDelay: 0 });
  const request = { clientKey: "key-1", text: "Hello" };
  await api.sendMessage(request);

  assert.equal(requests.length, 3);
  assert.match(requests[0].clientMessageId, /^[a-zA-Z0-9_-]{1,128}$/);
  assert.equal(requests[0].metadata.customerId, "visitor-1");
  assert.deepEqual(requests[1], requests[0]);
  assert.deepEqual(requests[2], requests[0]);
  assert.deepEqual(request, { clientKey: "key-1", text: "Hello" });

  await api.sendMessage(request);
  assert.notEqual(requests[3].clientMessageId, requests[0].clientMessageId);
  await api.sendMessage({ ...request, clientMessageId: "retained-send-1" });
  assert.equal(requests[4].clientMessageId, "retained-send-1");
});

test("history proves the visitor and stale conversations surface as not found", async (t) => {
  const storage = evaluateTypeScriptModule(
    "../src/lib/storage.ts",
    (specifier) => {
      throw new Error(`Unexpected widget storage import: ${specifier}`);
    },
  );
  const { WidgetAPI, WidgetConversationNotFoundError } =
    evaluateTypeScriptModule("../src/lib/api.ts", (specifier) => {
      if (specifier === "./storage") {
        return {
          ...storage,
          getVisitorToken: () => null,
          getVisitorId: () => "visitor-1",
          STORAGE_KEYS: { VISITOR_TOKEN: "visitor-token" },
        };
      }
      throw new Error(`Unexpected widget API import: ${specifier}`);
    });
  const calls = [];
  const responses = [
    Response.json({ success: true, messages: [{ id: "message-1" }] }),
    Response.json(
      { success: false, error: "Conversation not found" },
      { status: 404 },
    ),
    Response.json(
      { success: false, error: "Conversation not found" },
      { status: 404 },
    ),
    Response.json({ success: false, error: "Not found" }, { status: 404 }),
  ];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push({ url, options });
    return responses.shift();
  });
  const api = new WidgetAPI("https://example.com/api/widget", { baseDelay: 0 });

  const messages = await api.loadMessages("conversation-1", "key-1", "visitor-1");
  assert.deepEqual(messages, [{ id: "message-1" }]);
  assert.equal(calls[0].options.headers["X-Visitor-Id"], "visitor-1");
  assert.equal(calls[0].options.credentials, "omit");

  await assert.rejects(
    api.loadMessages("conversation-2", "key-1", "visitor-1"),
    WidgetConversationNotFoundError,
  );
  await assert.rejects(
    api.sendMessage({
      clientKey: "key-1",
      conversationId: "conversation-2",
      text: "Hello",
    }),
    WidgetConversationNotFoundError,
  );
  // Without a stored conversation, a 404 is an ordinary send failure.
  await assert.rejects(
    api.sendMessage({ clientKey: "key-1", text: "Hello" }),
    (error) =>
      !(error instanceof WidgetConversationNotFoundError) &&
      error.message === "Not found",
  );
});

test("widget shell drops a conversation the server no longer serves to this visitor", () => {
  const shell = readSource("../src/components/WidgetShell.tsx");

  assert.match(
    shell,
    /loadMessages\(\s*conversationId,\s*config\.clientKey,\s*getVisitorId\(config\.identity\),\s*\)/,
  );
  assert.match(
    shell,
    /err instanceof WidgetConversationNotFoundError\) \{\s*forgetConversation\(conversationId\);/,
  );
  assert.match(
    shell,
    /forgetConversation\(sentConversationId\);\s*sentConversationId = undefined;\s*response = await apiRef\.current\.sendMessage\(sendRequest\);/,
  );
  assert.match(
    shell,
    /error\.code === "widget_conversation_not_found"\) \{\s*forgetConversation\(conversationId\);/,
  );
});

const flushMicrotasks = async () => {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
  }
};

test("first media upload acquires an upload ticket before sending bytes and retains its retry identity", async (t) => {
  const { WidgetAPI } = evaluateTypeScriptModule("../src/lib/api.ts", (specifier) => {
    if (specifier === "./storage") return { getVisitorToken: () => null, getVisitorId: () => null, generateUUID: () => "00000000-0000-4000-8000-000000000001" };
    throw new Error(`Unexpected widget API import: ${specifier}`);
  });
  const bodies = [];
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    bodies.push(JSON.parse(options.body));
    if (bodies.length === 1) return Response.json({}, { status: 503 });
    return Response.json({ uploadToken: "scoped-ticket" });
  });
  const previous = globalThis.XMLHttpRequest;
  let sent;
  globalThis.XMLHttpRequest = class {
    upload = { addEventListener() {} };
    status = 200;
    responseText = JSON.stringify({ success: true, url: "https://storage.test/image" });
    addEventListener(event, callback) { if (event === "load") this.loaded = callback; }
    open() {} setRequestHeader() {}
    send(form) { sent = form; this.loaded(); }
  };
  t.after(() => { globalThis.XMLHttpRequest = previous; });
  const api = new WidgetAPI("https://example.com/api/widget", { baseDelay: 0 });
  const result = await api.uploadFile(new File(["bytes"], "file.png", { type: "image/png" }), "client-key");
  assert.equal(result.success, true);
  assert.equal(sent.get("uploadToken"), "scoped-ticket");
  assert.equal(sent.get("file").size, 5);
  assert.equal(bodies.length, 2);
  assert.deepEqual(bodies[1], bodies[0]);
});

const createDeferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const createRealtimeRaceHarness = (t) => {
  const now = Date.parse("2026-08-22T00:00:00.000Z");
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now });
  t.mock.method(Math, "random", () => 0);

  const originalWebSocket = globalThis.WebSocket;
  const sockets = [];
  class FakeWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;

    constructor(url) {
      this.url = url;
      this.readyState = FakeWebSocket.CONNECTING;
      this.sent = [];
      sockets.push(this);
    }

    open() {
      this.readyState = FakeWebSocket.OPEN;
      this.onopen?.();
    }

    receive(frame) {
      this.onmessage?.({ data: JSON.stringify(frame) });
    }

    send(frame) {
      this.sent.push(frame);
    }

    close() {
      if (this.readyState >= FakeWebSocket.CLOSING) return;
      this.readyState = FakeWebSocket.CLOSED;
      this.onclose?.();
    }

    serverClose() {
      this.readyState = FakeWebSocket.CLOSED;
      this.onclose?.();
    }
  }
  globalThis.WebSocket = FakeWebSocket;
  t.after(() => {
    globalThis.WebSocket = originalWebSocket;
  });

  const loads = [];
  let inFlightLoads = 0;
  let maxInFlightLoads = 0;
  const getToken = () => {
    const deferred = createDeferred();
    inFlightLoads += 1;
    maxInFlightLoads = Math.max(maxInFlightLoads, inFlightLoads);
    const promise = deferred.promise.finally(() => {
      inFlightLoads -= 1;
    });
    loads.push({ ...deferred, promise });
    return promise;
  };

  const { subscribeToConversation } = loadRealtimeModule();
  const dispose = subscribeToConversation({
    workspaceId: "workspace_1",
    conversationId: "0123456789abcdef01234567",
    getToken,
    onNewMessage() {},
  });
  assert.equal(typeof dispose, "function");

  const token = () => ({
    token: `token-${loads.length}`,
    url: "https://realtime.example/ws",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  const ready = (socket, expiresAt) => {
    socket.open();
    socket.receive({
      type: "ready",
      connectionId: `connection-${sockets.indexOf(socket)}`,
      expiresAt,
    });
  };
  const acknowledge = (socket) => {
    socket.receive({
      type: "subscribed",
      channels: ["conversation:workspace_1:0123456789abcdef01234567"],
    });
  };

  return {
    acknowledge,
    dispose,
    get inFlightLoads() {
      return inFlightLoads;
    },
    loads,
    get maxInFlightLoads() {
      return maxInFlightLoads;
    },
    now,
    ready,
    sockets,
    token,
  };
};

test("widget chat uses one ElevenLabs conversation shell owned by WidgetWindow", () => {
  const widgetWindow = readSource("../src/components/WidgetWindow.tsx");
  const messageList = readSource("../src/components/MessageList.tsx");
  const widgetShell = readSource("../src/components/WidgetShell.tsx");
  const widgetApi = readSource("../src/lib/api.ts");
  const widgetRealtime = readSource("../src/lib/realtime.ts");
  const widgetAnalytics = readSource("../src/lib/analytics.ts");
  const loader = readSource("../src/loader.ts");
  const widget = readSource("../src/widget.tsx");

  assert.match(
    widgetWindow,
    /import\s+\{\s*Conversation,\s*ConversationScrollButton\s*\}\s+from\s+['"]\.\/ui\/conversation['"];/,
    "WidgetWindow should own the ElevenLabs conversation shell and scroll button",
  );
  assert.match(
    widgetWindow,
    /<Conversation\s+[\s\S]+?className="widget-chat-view-messages"[\s\S]+?initial="instant"[\s\S]*?>/,
    "WidgetWindow should render the single chat scroll shell",
  );
  assert.match(
    widgetWindow,
    /<ConversationScrollButton\s+className="widget-conversation-scroll-button"\s*\/>/,
    "WidgetWindow should expose the panel-style scroll-to-bottom affordance",
  );

  assert.doesNotMatch(
    messageList,
    /import\s+\{\s*Conversation\b/,
    "MessageList should not import or mount a nested Conversation shell",
  );
  assert.match(
    messageList,
    /import\s+\{\s*ConversationContent,\s*ConversationEmptyState\s*\}\s+from\s+['"]\.\/ui\/conversation['"];/,
    "MessageList should reuse the panel conversation content and empty-state primitives",
  );
  assert.doesNotMatch(
    messageList,
    /<Conversation\s+className="widget-messages">/,
    "MessageList should not create a second scroll/state boundary",
  );

  assert.doesNotMatch(
    widgetShell,
    /conversationSwitcher=\{/,
    "WidgetShell should not pass freshly-created JSX through conversationSwitcher",
  );

  assert.match(
    widgetApi,
    /class WidgetRealtimeTokenError extends Error/,
    "Widget realtime token failures should carry retry metadata",
  );
  assert.match(
    widgetApi,
    /Realtime token requires an active visitor session/,
    "Widget should not call the token endpoint before a visitor session exists",
  );
  assert.match(
    widgetApi,
    /this\.code = code;/,
    "Widget realtime token errors should preserve server denial codes",
  );
  assert.match(
    widgetShell,
    /removeConversationIdEverywhere\(conversationId\)/,
    "Widget should clear stale conversation IDs after the server rejects them",
  );
  assert.match(
    widgetShell,
    /clearVisitorToken\(\)/,
    "Widget should clear invalid visitor tokens after the server rejects them",
  );
  assert.match(
    widgetRealtime,
    /status === 404/,
    "Widget realtime should not reconnect forever after auth-denied token requests",
  );
  assert.match(
    widgetAnalytics,
    /Math\.min\(\s*Date\.now\(\) - this\.sessionData\.startTime,\s*SESSION_TIMEOUT/s,
    "Widget analytics should cap session-end duration to the configured session timeout",
  );
  assert.match(
    widgetShell,
    /trackEvent\("widget_message_send"/,
    "Widget should track successful visitor message sends for PMF funnel analysis",
  );
  assert.match(
    widgetShell,
    /trackEvent\("widget_error"[\s\S]+?message_send_failed/,
    "Widget should track failed sends without sending raw message content",
  );

  assert.match(
    widget,
    /updateIdentity\(userData:/,
    "AiriWidget should expose updateIdentity for dynamic website authentication",
  );
  assert.match(
    loader,
    /widgetWindow\.AiriChat/,
    "Widget loader should expose the public AiriChat SDK alias for website owners",
  );
  assert.match(
    loader,
    /__AIRI_WIDGET_LOADED__ = false[\s\S]+__ICECORE_WIDGET_LOADED__ = false/,
    "Widget loader failures should clear both current and legacy loaded flags",
  );
});

test("widget realtime keeps exact visitor scope and query-token transport", () => {
  const realtime = readSource("../src/lib/realtime.ts");

  assert.match(
    realtime,
    /getToken:\s*\(\)\s*=>\s*Promise<TokenResponse>/,
    "the existing visitor-authorized token callback remains the only loader",
  );
  assert.match(
    realtime,
    /kind:\s*["']conversation["'][\s\S]*workspaceId:\s*params\.workspaceId[\s\S]*conversationId:\s*params\.conversationId/,
    "widget subscriptions stay on the exact conversation scope",
  );
  assert.match(
    realtime,
    /searchParams\.set\(["']token["'], token\)/,
    "widget keeps the legacy query-token websocket transport",
  );
});

test("widget realtime rotates from response expiry with active/candidate ownership", () => {
  const realtime = readSource("../src/lib/realtime.ts");

  assert.match(
    realtime,
    /type TokenResponse = \{[\s\S]*expiresAt\?:\s*string[\s\S]*\}/,
    "the visitor token response expiry must reach realtime ownership",
  );
  assert.match(
    realtime,
    /planRealtimeTokenRefresh\([\s\S]*token\.expiresAt[\s\S]*\)/,
    "widget must use the shared 30-second refresh planner",
  );
  assert.match(realtime, /activeSocket/);
  assert.match(realtime, /candidateSocket/);
  assert.match(
    realtime,
    /planRealtimeCandidateAckDeadline\([\s\S]*deadlineExpiryMs[\s\S]*\)/,
    "a replacement must have one shared ACK deadline inside active expiry",
  );
  assert.match(
    realtime,
    /planRealtimeRotationRetry\([\s\S]*activeExpiresAt[\s\S]*Math\.random\(\)[\s\S]*\)/,
    "a never-ACK replacement must retry through shared headroom policy",
  );
  assert.match(realtime, /candidateAckTimer/);
  assert.match(realtime, /refreshTimer/);
  assert.match(realtime, /if \(disposed\) return/);
  assert.match(
    realtime,
    /clearTimeout\(refreshTimer\)/,
    "dispose must own the refresh timer as well as reconnect",
  );
  assert.match(
    realtime,
    /clearTimeout\(connection\.candidateAckTimer\)/,
    "promotion, retirement, and disposal must cancel candidate ACK ownership",
  );
});

test("widget candidate ownership survives active-close never-ACK and exact-ACK branches", () => {
  const realtime = readSource("../src/lib/realtime.ts");
  const deadlineStart = realtime.indexOf(
    "connection.candidateAckTimer = setTimeout",
  );
  const deadlineEnd = realtime.indexOf("}, deadline.delayMs);", deadlineStart);
  assert.notEqual(deadlineStart, -1);
  assert.notEqual(deadlineEnd, -1);
  const deadline = realtime.slice(deadlineStart, deadlineEnd);
  assert.match(
    deadline,
    /candidateSocket !== connection/,
    "the deadline must remain keyed to the same candidate",
  );
  assert.doesNotMatch(
    deadline,
    /activeSocket !== previous|previous\.retired/,
    "old-active loss must not invalidate the candidate deadline",
  );
  assert.match(
    deadline,
    /scheduleReconnect\(connection\.rotationAttempt\)/,
    "timeout retry must retain the candidate rotation attempt",
  );

  assert.match(
    realtime,
    /type RotationAttempt = Readonly<\{[\s\S]*replacementIntent: boolean;[\s\S]*priorActiveExpiryMs: number \| null;[\s\S]*generation: number;/,
    "token loads, queued retries, and candidates must share one rotation context",
  );

  assert.match(
    realtime,
    /disposed \|\| reconnectTimer \|\| candidateSocket \|\| pendingTokenLoad/,
    "active close must defer to an existing candidate or token-load owner",
  );
  const promotion = realtime.slice(
    realtime.indexOf("const promoteIfReady"),
    realtime.indexOf("async function connect"),
  );
  assert.match(
    promotion,
    /clearReconnectTimer\(\)/,
    "exact ACK promotion must cancel reconnect inherited from old-active loss",
  );
});

test("widget realtime keeps one token-load owner across active-close races", async (t) => {
  await t.test(
    "never-ACK replacement times out before one joined reconnect",
    async (t) => {
      const harness = createRealtimeRaceHarness(t);
      const activeToken = harness.token();
      harness.loads[0].resolve(activeToken);
      await flushMicrotasks();
      assert.equal(harness.sockets.length, 1);
      harness.ready(harness.sockets[0], activeToken.expiresAt);
      harness.acknowledge(harness.sockets[0]);

      t.mock.timers.tick(30_000);
      assert.equal(harness.loads.length, 2);
      assert.equal(harness.inFlightLoads, 1);
      harness.sockets[0].serverClose();
      t.mock.timers.tick(1_000);

      assert.equal(
        harness.loads.length,
        2,
        "the old-active reconnect must join the pending replacement token load",
      );
      assert.equal(harness.maxInFlightLoads, 1);

      const replacementToken = harness.token();
      delete replacementToken.expiresAt;
      harness.loads[1].resolve(replacementToken);
      await flushMicrotasks();
      assert.equal(
        harness.sockets.length,
        2,
        "one pending replacement load must create exactly one candidate socket",
      );
      harness.sockets[1].open();

      t.mock.timers.tick(10_000);
      assert.equal(harness.sockets[1].readyState, 3);
      assert.equal(harness.loads.length, 2);
      t.mock.timers.tick(7_499);
      assert.equal(harness.loads.length, 2);
      t.mock.timers.tick(1);
      assert.equal(
        harness.loads.length,
        3,
        "the ACK timeout must hand ownership to one reconnect",
      );
      assert.equal(harness.maxInFlightLoads, 1);
      harness.dispose();
    },
  );

  await t.test(
    "exact ACK promotes once and cancels the old-active reconnect",
    async (t) => {
      const harness = createRealtimeRaceHarness(t);
      const activeToken = harness.token();
      harness.loads[0].resolve(activeToken);
      await flushMicrotasks();
      harness.ready(harness.sockets[0], activeToken.expiresAt);
      harness.acknowledge(harness.sockets[0]);

      t.mock.timers.tick(30_000);
      harness.sockets[0].serverClose();
      t.mock.timers.tick(999);
      assert.equal(harness.loads.length, 2);
      assert.equal(harness.inFlightLoads, 1);

      const replacementToken = harness.token();
      harness.loads[1].resolve(replacementToken);
      await flushMicrotasks();
      assert.equal(harness.sockets.length, 2);
      harness.ready(harness.sockets[1], replacementToken.expiresAt);
      harness.acknowledge(harness.sockets[1]);
      t.mock.timers.tick(1);

      assert.equal(harness.loads.length, 2);
      assert.equal(harness.maxInFlightLoads, 1);
      assert.equal(harness.sockets[1].readyState, 1);
      harness.dispose();
    },
  );

  await t.test(
    "queued rotation keeps replacement intent after retained active closes",
    async (t) => {
      const harness = createRealtimeRaceHarness(t);
      const activeToken = harness.token();
      harness.loads[0].resolve(activeToken);
      await flushMicrotasks();
      harness.ready(harness.sockets[0], activeToken.expiresAt);
      harness.acknowledge(harness.sockets[0]);

      t.mock.timers.tick(30_000);
      const failedCandidateToken = harness.token();
      harness.loads[1].resolve(failedCandidateToken);
      await flushMicrotasks();
      assert.equal(harness.sockets.length, 2);
      harness.sockets[1].serverClose();

      t.mock.timers.tick(1_000);
      harness.sockets[0].serverClose();
      t.mock.timers.tick(6_499);
      assert.equal(
        harness.loads.length,
        2,
        "the retained rotation must keep its original 7.5-second retry",
      );
      t.mock.timers.tick(1);
      assert.equal(harness.loads.length, 3);

      const retryToken = harness.token();
      delete retryToken.expiresAt;
      harness.loads[2].resolve(retryToken);
      await flushMicrotasks();
      assert.equal(harness.sockets.length, 3);
      harness.sockets[2].open();

      t.mock.timers.tick(10_000);
      assert.equal(
        harness.sockets[2].readyState,
        3,
        "the queued retry must retain replacement ownership and its ACK deadline",
      );
      assert.equal(harness.loads.length, 3);
      assert.equal(harness.maxInFlightLoads, 1);

      t.mock.timers.tick(7_499);
      assert.equal(harness.loads.length, 3);
      t.mock.timers.tick(1);
      assert.equal(harness.loads.length, 4);

      const exhaustedRotationToken = harness.token();
      delete exhaustedRotationToken.expiresAt;
      harness.loads[3].resolve(exhaustedRotationToken);
      await flushMicrotasks();
      assert.equal(harness.sockets.length, 4);
      harness.sockets[3].open();
      t.mock.timers.tick(0);
      assert.equal(
        harness.sockets[3].readyState,
        3,
        "the exhausted replacement generation must retire at prior headroom",
      );

      t.mock.timers.tick(999);
      assert.equal(harness.loads.length, 4);
      t.mock.timers.tick(1);
      assert.equal(
        harness.loads.length,
        5,
        "one fresh nonreplacement generation must take ordinary backoff ownership",
      );

      const freshToken = harness.token();
      harness.loads[4].resolve(freshToken);
      await flushMicrotasks();
      assert.equal(harness.sockets.length, 5);
      harness.sockets[4].open();
      t.mock.timers.tick(1);
      assert.equal(
        harness.sockets[4].readyState,
        1,
        "the fresh generation must drop the exhausted replacement deadline",
      );
      harness.ready(harness.sockets[4], freshToken.expiresAt);
      harness.acknowledge(harness.sockets[4]);
      t.mock.timers.tick(1_000);
      assert.equal(harness.loads.length, 5);
      assert.equal(harness.sockets.length, 5);
      assert.equal(harness.sockets[4].readyState, 1);
      assert.equal(harness.maxInFlightLoads, 1);

      harness.dispose();
      t.mock.timers.tick(60_000);
      assert.equal(harness.loads.length, 5);
      assert.equal(harness.sockets[4].readyState, 3);
    },
  );

  await t.test(
    "dispose cancels a pending replacement owner and reconnect",
    async (t) => {
      const harness = createRealtimeRaceHarness(t);
      const activeToken = harness.token();
      harness.loads[0].resolve(activeToken);
      await flushMicrotasks();
      harness.ready(harness.sockets[0], activeToken.expiresAt);
      harness.acknowledge(harness.sockets[0]);

      t.mock.timers.tick(30_000);
      harness.sockets[0].serverClose();
      assert.equal(harness.loads.length, 2);
      harness.dispose();
      t.mock.timers.tick(1_000);

      const replacementToken = harness.token();
      harness.loads[1].resolve(replacementToken);
      await flushMicrotasks();
      t.mock.timers.tick(60_000);

      assert.equal(harness.loads.length, 2);
      assert.equal(harness.sockets.length, 1);
      assert.equal(harness.inFlightLoads, 0);
    },
  );

  await t.test(
    "post-load setup failure releases the owner and retries once",
    async (t) => {
      t.mock.method(console, "error", () => {});
      const harness = createRealtimeRaceHarness(t);
      harness.loads[0].resolve({
        ...harness.token(),
        url: "not a realtime URL",
      });
      await flushMicrotasks();
      assert.equal(harness.loads.length, 1);
      assert.equal(harness.inFlightLoads, 0);

      t.mock.timers.tick(1_000);
      assert.equal(
        harness.loads.length,
        2,
        "URL/socket setup failure must release the owner before reconnect",
      );
      assert.equal(harness.maxInFlightLoads, 1);
      harness.dispose();
    },
  );
});
