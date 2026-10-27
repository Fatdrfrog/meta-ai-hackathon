import { expect, test, type Page, type Request } from "@playwright/test";
import { createAiriChatSseResponse } from "../src/lib/airi-chats/sse";
import type { AiriChatRunEvent } from "../src/lib/airi-chats/run-events";

// The /airi workspace in Chromium: the real client, its SSE parser and its
// message rendering. Playwright answers the Airi API from per-test memory and
// encodes every stream frame with the server's own SSE writer, so a change to
// the frame encoding or to the client's parsing of it fails here. The run
// events themselves are written by the spec: the stream route, the chat
// service and the provider are not exercised (that is the route + service +
// SSE integration test's job). Nothing authenticates or reaches a provider.

const WORKSPACE_ID = "browser-workspace";
const API = `/api/workspaces/${WORKSPACE_ID}`;
const THREAD_ID = "thread-browser-1";
const AT = "2026-10-07T09:00:00.000Z";

type Thread = Extract<AiriChatRunEvent, { type: "thread" }>["thread"];
type StoredMessage = {
  id: string;
  threadId: string;
  role: "user" | "assistant";
  content: string;
  metadata?: Record<string, unknown> | null;
  createdAt: string;
};

type Harness = {
  threads: Thread[];
  messages: StoredMessage[];
  streamBodies: unknown[];
  unexpected: string[];
  consoleErrors: string[];
  /** GET messages' activeRun: the run still answering in that chat. */
  activeRun: { runId: string; status: "running"; startedAt: string } | null;
  /** POST .../runs/[runId]/cancel, by run id. */
  cancelRequests: string[];
  /** GET .../runs/[runId]/stream: the resumed run's frames. */
  resumeStream?: (runId: string, harness: Harness) => Promise<string>;
};

/** Frames written by the real server helper, as the stream route sends them. */
async function encodeServerStream(events: AiriChatRunEvent[]) {
  const response = createAiriChatSseResponse(async emit => {
    for (const event of events) await emit(event);
  });
  return {
    contentType: response.headers.get("content-type") || "",
    body: await response.text(),
  };
}

/**
 * The streaming contract's partial-answer event: `text` is the whole answer so
 * far, and the final assistant_message stays authoritative.
 */
function assistantDelta(threadId: string, text: string): AiriChatRunEvent {
  return {
    type: "assistant_delta",
    threadId,
    text,
    at: AT,
  };
}

/**
 * route.fulfill hands the client the whole stream at once, so React batches
 * the streamed text away before it paints. This holds the stream response in
 * the page just before assistant_message until releaseHeldAnswer() is called,
 * so the streaming bubble can be seen.
 */
async function holdStreamAtAnswer(page: Page) {
  await page.addInitScript(() => {
    const held = window as unknown as { __airiReleaseAnswer?: () => void };
    const released = new Promise<void>(resolve => {
      held.__airiReleaseAnswer = resolve;
    });
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const response = await originalFetch(input, init);
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      if (!url.endsWith("/airi-chats/messages/stream")) return response;
      const text = await response.text();
      const cut = text.indexOf('data: {"type":"assistant_message"');
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(
            encoder.encode(cut < 0 ? text : text.slice(0, cut))
          );
          if (cut >= 0) {
            await released;
            controller.enqueue(encoder.encode(text.slice(cut)));
          }
          controller.close();
        },
      });
      return new Response(body, {
        status: response.status,
        headers: response.headers,
      });
    };
  });
}

async function releaseHeldAnswer(page: Page) {
  await page.evaluate(() =>
    (
      window as unknown as { __airiReleaseAnswer?: () => void }
    ).__airiReleaseAnswer?.()
  );
}

async function openWorkspace(
  page: Page,
  stream: (request: Request, harness: Harness) => Promise<string>,
  options: {
    /** The header drawer (mounted only while open) instead of /airi. */
    drawer?: boolean;
    resumeStream?: Harness["resumeStream"];
  } = {}
): Promise<Harness> {
  const harness: Harness = {
    threads: [],
    messages: [],
    streamBodies: [],
    unexpected: [],
    consoleErrors: [],
    activeRun: null,
    cancelRequests: [],
    resumeStream: options.resumeStream,
  };
  page.on("console", message => {
    if (message.type() === "error") harness.consoleErrors.push(message.text());
  });
  page.on("pageerror", error => harness.consoleErrors.push(error.message));

  await page.route(`**${API}/**`, async route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.slice(API.length);
    const method = request.method();
    const json = (body: unknown) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(body),
      });

    if (method === "GET" && path === "/airi-chats") {
      return json({ threads: harness.threads });
    }
    if (method === "GET" && path === "/airi-chats/sources") {
      return json({ sources: [] });
    }
    if (method === "GET" && path === "/airi-artifacts") {
      return json({ artifacts: [] });
    }
    if (method === "GET" && path === "/assets/generate/wan") {
      return json({ configured: false, temporalConfigured: false });
    }
    const threadMessages = path.match(/^\/airi-chats\/([^/]+)\/messages$/);
    if (method === "GET" && threadMessages) {
      return json({
        messages: harness.messages.filter(
          message => message.threadId === threadMessages[1]
        ),
        hasMore: false,
        activeRun: harness.activeRun,
      });
    }
    const runRoute = path.match(
      /^\/airi-chats\/([^/]+)\/runs\/([^/]+)\/(stream|cancel)$/
    );
    if (method === "POST" && runRoute?.[3] === "cancel") {
      harness.cancelRequests.push(runRoute[2]);
      return route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify({ runId: runRoute[2], status: "running" }),
      });
    }
    if (
      method === "GET" &&
      runRoute?.[3] === "stream" &&
      harness.resumeStream
    ) {
      return route.fulfill({
        status: 200,
        headers: {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
        },
        body: await harness.resumeStream(runRoute[2], harness),
      });
    }
    if (method === "POST" && path === "/airi-chats/messages/stream") {
      harness.streamBodies.push(request.postDataJSON());
      return route.fulfill({
        status: 200,
        headers: {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
        },
        body: await stream(request, harness),
      });
    }

    harness.unexpected.push(`${method} ${path}`);
    return json({});
  });

  await page.goto(
    options.drawer
      ? "/airi-chat-browser.html?drawer=1"
      : "/airi-chat-browser.html"
  );
  if (options.drawer) await openDrawer(page);
  await expect(composer(page)).toBeEditable();
  return harness;
}

async function openDrawer(page: Page) {
  await page.getByRole("button", { name: "Open Airi chat" }).click();
  await expect(drawer(page)).toBeVisible();
}

function drawer(page: Page) {
  return page.getByRole("complementary", { name: "Airi drawer" });
}

function composer(page: Page) {
  return page.getByRole("combobox", { name: "Ask Airi" });
}

/** Text the reader can see (hidden panels, such as a closed builder, aside). */
function shown(page: Page, text: string) {
  return page
    .locator("main")
    .getByText(text, { exact: true })
    .filter({ visible: true });
}

function persist(harness: Harness, message: StoredMessage) {
  harness.messages.push(message);
  return message;
}

test("streams a new chat's answer and keeps only the final message", async ({
  page,
}) => {
  const question = "How do I connect WhatsApp to Airi?";
  const answer =
    "Open Integrations, choose WhatsApp and follow the Meta sign-in steps.";
  const thread: Thread = {
    id: THREAD_ID,
    title: "Connect WhatsApp",
    source: "manual",
    updatedAt: AT,
  };

  await holdStreamAtAnswer(page);
  const harness = await openWorkspace(page, async (request, state) => {
    const { content } = request.postDataJSON() as { content: string };
    state.threads = [thread];
    const userMessage = persist(state, {
      id: "message-user-1",
      threadId: THREAD_ID,
      role: "user",
      content,
      metadata: null,
      createdAt: AT,
    });
    const assistantMessage = persist(state, {
      id: "message-assistant-1",
      threadId: THREAD_ID,
      role: "assistant",
      content: answer,
      metadata: null,
      createdAt: AT,
    });
    const stream = await encodeServerStream([
      { type: "thread", thread, at: AT },
      {
        type: "user_message",
        message: { ...userMessage, role: "user" },
        at: AT,
      },
      {
        type: "stage",
        id: "general_answer",
        label: "Writing the answer",
        status: "running",
        at: AT,
      },
      assistantDelta(THREAD_ID, "Open Integrations"),
      assistantDelta(THREAD_ID, "Open Integrations, choose WhatsApp"),
      {
        type: "stage",
        id: "general_answer",
        label: "Writing the answer",
        status: "complete",
        at: AT,
      },
      {
        type: "assistant_message",
        message: { ...assistantMessage, role: "assistant" },
        at: AT,
      },
      { type: "done", thread, at: AT },
    ]);
    expect(stream.contentType).toContain("text/event-stream");
    expect(stream.body).toContain(
      `data: ${JSON.stringify(assistantDelta(THREAD_ID, "Open Integrations"))}\n\n`
    );
    return stream.body;
  });

  await composer(page).fill(question);
  await composer(page).press("Enter");

  // The latest streamed text shows before the final message arrives.
  const streaming = page
    .getByTestId("airi-streaming-answer")
    .filter({ visible: true });
  await expect(streaming).toHaveText("Open Integrations, choose WhatsApp");
  await expect(shown(page, answer)).toHaveCount(0);
  await releaseHeldAnswer(page);

  await expect(streaming).toHaveCount(0);
  await expect(shown(page, answer)).toHaveCount(1);
  await expect(shown(page, question)).toHaveCount(1);
  // The final message replaces any partial text; no partial copy remains.
  await expect(
    page.getByText("Open Integrations, choose WhatsApp", { exact: true })
  ).toHaveCount(0);
  await expect(composer(page)).toHaveValue("");
  await expect(composer(page)).toBeEditable();
  await expect(
    page.getByRole("button", { name: /Connect WhatsApp/ })
  ).toBeVisible();

  expect(harness.streamBodies).toEqual([
    expect.objectContaining({ content: question, source: "manual" }),
  ]);
  expect(harness.unexpected).toEqual([]);
  expect(harness.consoleErrors).toEqual([]);
});

test("shows a failed run's error and keeps the composer usable", async ({
  page,
}) => {
  const failure = "Airi is busy right now. Try again in a minute.";
  const thread: Thread = {
    id: THREAD_ID,
    title: "New chat",
    source: "manual",
    updatedAt: AT,
  };

  const harness = await openWorkspace(page, async (request, state) => {
    const { content } = request.postDataJSON() as { content: string };
    state.threads = [thread];
    const userMessage = persist(state, {
      id: "message-user-1",
      threadId: THREAD_ID,
      role: "user",
      content,
      metadata: null,
      createdAt: AT,
    });
    return (
      await encodeServerStream([
        { type: "thread", thread, at: AT },
        {
          type: "user_message",
          message: { ...userMessage, role: "user" },
          at: AT,
        },
        { type: "error", message: failure, persisted: true, at: AT },
      ])
    ).body;
  });

  await composer(page).fill("Summarize yesterday's chats");
  await composer(page).press("Enter");

  await expect(
    page.getByRole("alert").filter({ hasText: failure, visible: true })
  ).toHaveCount(1);
  await expect(composer(page)).toBeEditable();
  expect(harness.streamBodies).toHaveLength(1);
  expect(harness.unexpected).toEqual([]);
  expect(harness.consoleErrors).toEqual([]);
});

const RUN_ID = "run-browser-1";

function runStarted(threadId: string): AiriChatRunEvent {
  return {
    type: "run",
    runId: RUN_ID,
    threadId,
    clientTurnId: "00000000-0000-4000-8000-000000000000",
    status: "running",
    at: AT,
  };
}

test("keeps answering after the drawer closes and shows the answer on reopening", async ({
  page,
}) => {
  const question = "Which campaign performed best?";
  const answer = "The spring sale had the most replies.";
  const thread: Thread = {
    id: THREAD_ID,
    title: "Best campaign",
    source: "global",
    updatedAt: AT,
  };
  const userMessage: StoredMessage = {
    id: "message-user-1",
    threadId: THREAD_ID,
    role: "user",
    content: question,
    metadata: null,
    createdAt: AT,
  };
  const assistantMessage: StoredMessage = {
    id: "message-assistant-1",
    threadId: THREAD_ID,
    role: "assistant",
    content: answer,
    metadata: null,
    createdAt: AT,
  };
  const writing = (status: "running" | "complete"): AiriChatRunEvent => ({
    type: "stage",
    id: "generation",
    label: "Writing the answer",
    status,
    at: AT,
  });

  // The first stream stops before the answer: the drawer closes mid-run.
  await holdStreamAtAnswer(page);
  const harness = await openWorkspace(
    page,
    async (_request, state) => {
      state.threads = [thread];
      persist(state, userMessage);
      return (
        await encodeServerStream([
          runStarted(THREAD_ID),
          { type: "thread", thread, at: AT },
          {
            type: "user_message",
            message: { ...userMessage, role: "user" },
            at: AT,
          },
          writing("running"),
          assistantDelta(THREAD_ID, "The spring sale"),
          {
            type: "assistant_message",
            message: { ...assistantMessage, role: "assistant" },
            at: AT,
          },
          { type: "done", thread, status: "completed", at: AT },
        ])
      ).body;
    },
    {
      drawer: true,
      // The run kept going on the server; reopening follows it to the end.
      resumeStream: async (runId, state) => {
        expect(runId).toBe(RUN_ID);
        persist(state, assistantMessage);
        state.activeRun = null;
        return (
          await encodeServerStream([
            runStarted(THREAD_ID),
            {
              type: "user_message",
              message: { ...userMessage, role: "user" },
              at: AT,
            },
            writing("running"),
            assistantDelta(THREAD_ID, "The spring sale had"),
            writing("complete"),
            {
              type: "assistant_message",
              message: { ...assistantMessage, role: "assistant" },
              at: AT,
            },
            { type: "done", thread, status: "completed", at: AT },
          ])
        ).body;
      },
    }
  );

  await composer(page).fill(question);
  await composer(page).press("Enter");
  const streaming = page
    .getByTestId("airi-streaming-answer")
    .filter({ visible: true });
  await expect(streaming).toHaveText("The spring sale");
  await expect(page.getByRole("button", { name: "Stop answer" })).toBeVisible();

  // Closing the drawer unmounts the chat; the run is not cancelled.
  harness.activeRun = { runId: RUN_ID, status: "running", startedAt: AT };
  await page.getByRole("button", { name: "Close Airi sidebar" }).click();
  await expect(drawer(page)).toHaveCount(0);
  expect(harness.cancelRequests).toEqual([]);

  // Reopening returns to that chat, follows the run and shows its answer.
  await openDrawer(page);
  await expect(shown(page, answer)).toHaveCount(1);
  await expect(shown(page, question)).toHaveCount(1);
  await expect(streaming).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Send message" })
  ).toBeVisible();
  await expect(composer(page)).toBeEditable();
  expect(harness.cancelRequests).toEqual([]);
  expect(harness.streamBodies).toEqual([
    expect.objectContaining({
      content: question,
      clientTurnId: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
      ),
    }),
  ]);
  expect(harness.unexpected).toEqual([]);
  expect(harness.consoleErrors).toEqual([]);
});

test("stops a running answer from the composer and shows it as stopped", async ({
  page,
}) => {
  const question = "Write a long market report";
  const partial = "Section one: the market grew.";
  const thread: Thread = {
    id: THREAD_ID,
    title: "Market report",
    source: "manual",
    updatedAt: AT,
  };

  // The stream holds before the (stopped) answer until the cancel arrives.
  await holdStreamAtAnswer(page);
  const harness = await openWorkspace(page, async (request, state) => {
    const { content } = request.postDataJSON() as { content: string };
    state.threads = [thread];
    const userMessage = persist(state, {
      id: "message-user-1",
      threadId: THREAD_ID,
      role: "user",
      content,
      metadata: null,
      createdAt: AT,
    });
    const stopped = persist(state, {
      id: "message-assistant-1",
      threadId: THREAD_ID,
      role: "assistant",
      content: partial,
      metadata: {
        cancelled: true,
        partial: true,
        errorCode: "airi_run_cancelled",
      },
      createdAt: AT,
    });
    return (
      await encodeServerStream([
        runStarted(THREAD_ID),
        { type: "thread", thread, at: AT },
        {
          type: "user_message",
          message: { ...userMessage, role: "user" },
          at: AT,
        },
        {
          type: "stage",
          id: "generation",
          label: "Writing the answer",
          status: "running",
          at: AT,
        },
        assistantDelta(THREAD_ID, partial),
        {
          type: "assistant_message",
          message: { ...stopped, role: "assistant" },
          at: AT,
        },
        { type: "done", thread, status: "cancelled", at: AT },
      ])
    ).body;
  });

  await composer(page).fill(question);
  await composer(page).press("Enter");
  await expect(
    page.getByTestId("airi-streaming-answer").filter({ visible: true })
  ).toHaveText(partial);

  const stop = page.getByRole("button", { name: "Stop answer" });
  await stop.focus();
  await page.keyboard.press("Enter");
  await expect.poll(() => harness.cancelRequests).toEqual([RUN_ID]);
  await expect(
    page.getByRole("button", { name: "Stopping the answer" })
  ).toBeDisabled();

  await releaseHeldAnswer(page);
  await expect(
    page.getByTestId("airi-answer-stopped").filter({ visible: true })
  ).toHaveText("Stopped");
  await expect(shown(page, partial)).toHaveCount(1);
  await expect(shown(page, "Request stopped")).toHaveCount(1);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Send message" })
  ).toBeVisible();
  await expect(composer(page)).toBeEditable();
  expect(harness.unexpected).toEqual([]);
  expect(harness.consoleErrors).toEqual([]);
});
