import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { randomUUID } from "node:crypto";
import ts from "typescript";

const compiled = ts.transpileModule(
  readFileSync(new URL("../src/lib/analytics.ts", import.meta.url), "utf8"),
  {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  },
).outputText;

test("navigation snapshots retain one session and each queued event has its own stable identity", () => {
  let now = Date.now();
  const local = new Map();
  const sessions = new Map();
  const sent = [];
  const storage = (values) => ({
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  });
  class Clock extends Date {
    constructor(...args) {
      super(...(args.length ? args : [now]));
    }
    static now() {
      return now;
    }
  }
  for (const path of ["/", "/pricing", "/checkout"]) {
    const listeners = {};
    const window = {
      location: { pathname: path },
      screen: { width: 1440, height: 900 },
      innerWidth: 1440,
      innerHeight: 900,
      addEventListener: (name, callback) =>
        (listeners[name] ??= []).push(callback),
      setTimeout: () => 1,
    };
    window.top = window;
    window.self = window;
    const module = { exports: {} };
    vm.runInNewContext(compiled, {
      module,
      exports: module.exports,
      require: () => ({
        STORAGE_KEYS: { SESSION: "session", VISITOR_ID: "visitor" },
      }),
      window,
      document: { referrer: "", title: path, addEventListener() {} },
      navigator: { userAgent: "test", language: "en" },
      history: { pushState() {}, replaceState() {} },
      crypto: { randomUUID },
      localStorage: storage(local),
      sessionStorage: storage(sessions),
      Date: Clock,
      Intl,
      clearTimeout() {},
      fetch: async (_url, options) =>
        sent.push(...JSON.parse(options.body).events),
    });
    const analytics = new module.exports.WidgetAnalytics({
      workspaceId: "workspace",
      companyId: "company",
      clientKey: "public",
      apiUrl: "https://example.com",
      enabled: true,
    });
    analytics.start();
    const queuedIds = analytics.eventQueue.map(
      (event) => event.properties.event_id,
    );
    assert.ok(queuedIds.every((id) => typeof id === "string" && id.length > 0));
    const sentBeforeUnload = sent.length;
    now += 10_000;
    listeners.beforeunload.forEach((callback) => callback());
    assert.deepEqual(
      sent
        .slice(sentBeforeUnload, -1)
        .map((event) => event.properties.event_id),
      Array.from(queuedIds),
    );
  }
  const ends = sent.filter((event) => event.event === "widget_session_end");
  assert.equal(
    sent.filter((event) => event.event === "widget_session_start").length,
    1,
  );
  assert.equal(
    new Set(ends.map((event) => event.properties.session_id)).size,
    1,
  );
  assert.deepEqual(
    ends.map((event) => event.properties.duration_ms),
    [10_000, 20_000, 30_000],
  );
  assert.deepEqual(
    ends.map((event) => event.properties.page_count),
    [1, 2, 3],
  );
  assert.equal(
    new Set(sent.map((event) => event.properties.event_id)).size,
    sent.length,
  );
});
