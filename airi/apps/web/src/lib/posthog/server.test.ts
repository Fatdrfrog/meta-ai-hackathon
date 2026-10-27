import type { PostHog } from "posthog-node";
import { gunzipSync } from "node:zlib";

type ServerModule = typeof import("./server");
type FlushTask = () => Promise<void>;

const originalProjectKey = process.env.POSTHOG_PROJECT_API_KEY;
let server: ServerModule;

beforeEach(async () => {
  jest.resetModules();
  process.env.POSTHOG_PROJECT_API_KEY = "phc_server_test";
  server = await import("./server");
});

afterEach(async () => {
  server.configureServerPostHogRequestFlush(null);
  await server.shutdownPostHog();
  jest.restoreAllMocks();
  if (originalProjectKey === undefined) {
    delete process.env.POSTHOG_PROJECT_API_KEY;
  } else {
    process.env.POSTHOG_PROJECT_API_KEY = originalProjectKey;
  }
});

function useLocalTransport(client: PostHog) {
  const events: Array<{ event: string; distinct_id: string }> = [];
  jest.spyOn(client, "fetch").mockImplementation(async (_url, options) => {
    const body =
      typeof options.body === "string"
        ? options.body
        : gunzipSync(Buffer.from(options.body as Uint8Array)).toString("utf8");
    const payload = JSON.parse(body) as {
      batch: Array<{ event: string; distinct_id: string }>;
    };
    events.push(...payload.batch);
    return new Response("{}", { status: 200 });
  });
  return events;
}

describe("server PostHog request delivery", () => {
  it("registers request work before asynchronous capture and identity preparation", async () => {
    const client = server.getPostHogClient()!;
    const events = useLocalTransport(client);
    const tasks: FlushTask[] = [];
    server.configureServerPostHogRequestFlush(task => tasks.push(task));

    const requestClient = server.getPostHogClient()!;
    requestClient.identify({
      distinctId: "user-1",
      properties: { role: "admin" },
    });
    requestClient.groupIdentify({
      groupType: "company",
      groupKey: "company-1",
    });
    requestClient.capture({ distinctId: "user-1", event: "sign in" });

    // The handler can now return: cleanup must already belong to this request,
    // although posthog-node has not even prepared its queued messages yet.
    expect(tasks).toHaveLength(1);
    expect(events).toEqual([]);
    await tasks[0]();
    expect(events.map(event => event.event)).toEqual([
      "$identify",
      "$groupidentify",
      "sign in",
    ]);
  });

  it("keeps the shared client usable after per-request flushing", async () => {
    const client = server.getPostHogClient()!;
    const events = useLocalTransport(client);
    client.capture({ distinctId: "user-1", event: "first request" });

    await server.flushServerPostHog();

    expect(server.getPostHogClient() === client).toBe(true);
    client.capture({ distinctId: "user-1", event: "second request" });
    await server.flushServerPostHog();
    expect(events.map(event => event.event)).toEqual([
      "first request",
      "second request",
    ]);
  });

  it("holds scheduled cleanup until the transport acknowledges the capture", async () => {
    const client = server.getPostHogClient()!;
    const tasks: FlushTask[] = [];
    let acknowledge!: () => void;
    let startTransport!: () => void;
    const started = new Promise<void>(resolve => {
      startTransport = resolve;
    });
    const response = new Promise<void>(resolve => {
      acknowledge = resolve;
    });
    jest.spyOn(client, "fetch").mockImplementation(async () => {
      startTransport();
      await response;
      return new Response("{}", { status: 200 });
    });
    server.configureServerPostHogRequestFlush(task => tasks.push(task));
    server
      .getPostHogClient()!
      .capture({ distinctId: "user-1", event: "sign in" });

    try {
      expect(tasks).toHaveLength(1);
      let completed = false;
      const cleanup = tasks[0]().then(() => {
        completed = true;
      });
      await started;
      expect(completed).toBe(false);
      acknowledge();
      await cleanup;
      expect(completed).toBe(true);
    } finally {
      acknowledge();
    }
  });

  it("preserves capture outside a Next request scope, including worker execution", async () => {
    const client = server.getPostHogClient()!;
    const events = useLocalTransport(client);
    server.configureServerPostHogRequestFlush(() => {
      throw new Error("after was called outside a request scope");
    });

    expect(() =>
      server.getPostHogClient()!.capture({
        distinctId: "airi:workspace:workspace-1",
        event: "airi_reply_operator_counter",
      })
    ).not.toThrow();
    await server.flushServerPostHog();
    expect(events.map(event => event.event)).toEqual([
      "airi_reply_operator_counter",
    ]);
  });

  it("shares request lifetime registration across instrumentation and route module graphs", async () => {
    const tasks: FlushTask[] = [];
    server.configureServerPostHogRequestFlush(task => tasks.push(task));
    jest.resetModules();
    server = await import("./server");
    const client = server.getPostHogClient()!;
    const events = useLocalTransport(client);
    client.capture({ distinctId: "user-1", event: "sign in" });

    expect(tasks).toHaveLength(1);
    await tasks[0]();
    expect(events.map(event => event.event)).toEqual(["sign in"]);
  });

  it("gives overlapping requests their own cleanup without sending events twice", async () => {
    const client = server.getPostHogClient()!;
    const events = useLocalTransport(client);
    const tasks: FlushTask[] = [];
    server.configureServerPostHogRequestFlush(task => tasks.push(task));
    server
      .getPostHogClient()!
      .capture({ distinctId: "user-1", event: "first request" });
    expect(tasks).toHaveLength(1);
    const firstCleanup = tasks[0]();

    server
      .getPostHogClient()!
      .capture({ distinctId: "user-2", event: "second request" });
    expect(tasks).toHaveLength(2);
    await Promise.all([firstCleanup, tasks[1]()]);

    expect(events.map(event => event.event)).toEqual([
      "first request",
      "second request",
    ]);
  });
});
