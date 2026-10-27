/**
 * @jest-environment jsdom
 */

import "@testing-library/jest-dom";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type React from "react";
import { renderToString } from "react-dom/server";
import { ReadableStream } from "stream/web";
import { TextEncoder } from "util";
import { AiriChatWorkspace } from "./airi-chat-workspace";
import {
  installAiriChatWorkspaceTestGlobals,
  jsonResponse,
  sseFrame,
} from "./airi-chat-workspace-test-utils";

// Durable runs in the client (contract F): the session cache, resume on open,
// Stop, detaching on close, "Load earlier" and the single layout tree.

jest.mock("next-intl", () =>
  jest
    .requireActual("./airi-chat-workspace-test-utils")
    .createAiriChatNextIntlMock()
);

jest.mock("@/components/ui/resizable", () => {
  throw new Error("airi-chat-workspace must not load the resizable columns");
});

jest.mock("@/components/ai/airi-builder-side-panel", () =>
  jest
    .requireActual("./airi-chat-workspace-test-utils")
    .createAiriBuilderSidePanelMock()
);

// use-stick-to-bottom ships ESM only; stand in for its sticky scroller.
jest.mock("@/components/ui/conversation", () => {
  const React = jest.requireActual<typeof import("react")>("react");
  return {
    Conversation: ({
      children,
      "aria-label": ariaLabel,
    }: {
      children: React.ReactNode;
      "aria-label"?: string;
    }) =>
      React.createElement(
        "div",
        { role: "log", "aria-label": ariaLabel },
        children
      ),
    ConversationContent: ({ children }: { children: React.ReactNode }) =>
      React.createElement("div", null, children),
    ConversationScrollButton: () => null,
  };
});

jest.mock("@/components/ai/airi-builder-intl-provider", () => ({
  AiriBuilderIntlProvider: ({ children }: { children: React.ReactNode }) =>
    children,
  AiriPreviewLoadFailure: () => null,
}));

// No auth context by default (one shared cache); a test signs users in.
let mockAuth: { user: { id: string } | null; loading: boolean } | undefined;
jest.mock("@/lib/auth/auth-context", () => ({
  useOptionalAuth: () => mockAuth,
}));

const mockFetch = jest.fn();
const at = new Date("2026-10-11T09:00:00.000Z").toISOString();
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

beforeEach(() => {
  jest.clearAllMocks();
  mockAuth = undefined;
  installAiriChatWorkspaceTestGlobals(mockFetch);
});

afterEach(() => {
  cleanup();
});

function thread(id: string, title: string) {
  return { id, title, source: "manual", pinnedAt: null, updatedAt: at };
}

function message(
  id: string,
  threadId: string,
  role: "user" | "assistant",
  content: string,
  metadata: Record<string, unknown> | null = null
) {
  return { id, threadId, role, content, metadata, createdAt: at };
}

/**
 * A stream the test writes event by event. Like a real fetch body, it fails
 * with an AbortError when the request's signal aborts.
 */
function controllableStream(signal?: AbortSignal | null) {
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let closed = false;
  const body = new ReadableStream<Uint8Array>({
    start(streamController) {
      controller =
        streamController as ReadableStreamDefaultController<Uint8Array>;
    },
  });
  signal?.addEventListener("abort", () => {
    if (closed) return;
    closed = true;
    controller.error(new DOMException("Aborted", "AbortError"));
  });
  return {
    response: {
      ok: true,
      status: 200,
      headers: {
        get: (name: string) =>
          name.toLowerCase() === "content-type"
            ? "text/event-stream; charset=utf-8"
            : null,
      },
      body,
    } as unknown as Response,
    push: async (
      ...events: Array<{ type: string } & Record<string, unknown>>
    ) => {
      await act(async () => {
        for (const event of events) {
          controller.enqueue(encoder.encode(sseFrame(event.type, event)));
        }
        await new Promise(resolve => setTimeout(resolve, 0));
      });
    },
    close: async () => {
      await act(async () => {
        closed = true;
        controller.close();
        await new Promise(resolve => setTimeout(resolve, 0));
      });
    },
    get aborted() {
      return Boolean(signal?.aborted);
    },
  };
}

type Stream = ReturnType<typeof controllableStream>;

function calls(pattern: string, method?: string) {
  return mockFetch.mock.calls.filter(
    ([url, init]) =>
      String(url).includes(pattern) &&
      (!method ||
        ((init as RequestInit | undefined)?.method ?? "GET") === method)
  );
}

function runEvent(runId: string, threadId: string, clientTurnId = "turn") {
  return { type: "run", runId, threadId, clientTurnId, status: "running", at };
}

function composer() {
  return screen.getByRole("combobox", { name: "Ask Airi" });
}

function send(text: string) {
  fireEvent.change(composer(), { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
}

describe("AiriChatWorkspace durable runs", () => {
  it("keeps the run going when the drawer closes and shows its answer on reopening", async () => {
    let stream: Stream | null = null;
    let serverAnswered = false;
    mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes("/airi-chats/sources"))
        return jsonResponse({ sources: [] });
      if (url.includes("/airi-artifacts?"))
        return jsonResponse({ artifacts: [] });
      if (url.endsWith("/airi-chats"))
        return jsonResponse({
          threads: serverAnswered ? [thread("thread-1", "Plan")] : [],
        });
      if (url.endsWith("/airi-chats/messages/stream")) {
        stream = controllableStream(init?.signal);
        return stream.response;
      }
      if (url.endsWith("/airi-chats/thread-1/messages"))
        return jsonResponse({
          messages: [
            message("user-1", "thread-1", "user", "Plan a launch"),
            message("answer-1", "thread-1", "assistant", "Here is the plan."),
          ],
          hasMore: false,
          activeRun: null,
        });
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const drawer = render(
      <AiriChatWorkspace
        workspaceId="workspace-1"
        compact
        onClose={jest.fn()}
      />
    );
    await screen.findByText("Try Airi for...");
    send("Plan a launch");
    await waitFor(() => expect(stream).not.toBeNull());
    await stream!.push(
      runEvent("run-1", "thread-1"),
      { type: "thread", thread: thread("thread-1", "Plan"), at },
      {
        type: "user_message",
        message: message("user-1", "thread-1", "user", "Plan a launch"),
        at,
      },
      {
        type: "stage",
        id: "generation",
        label: "Writing",
        status: "running",
        at,
      },
      { type: "assistant_delta", threadId: "thread-1", text: "Here is", at }
    );
    expect(
      await screen.findByTestId("airi-streaming-answer")
    ).toHaveTextContent("Here is");
    expect(screen.getByRole("button", { name: "Stop answer" })).toBeEnabled();

    // Closing the drawer unmounts the workspace: the stream detaches, the
    // run is never cancelled.
    drawer.unmount();
    expect(stream!.aborted).toBe(true);
    expect(calls("/cancel")).toHaveLength(0);

    serverAnswered = true;
    render(
      <AiriChatWorkspace
        workspaceId="workspace-1"
        compact
        onClose={jest.fn()}
      />
    );
    expect(await screen.findByText("Here is the plan.")).toBeInTheDocument();
    expect(screen.getAllByText("Plan a launch")).toHaveLength(1);
    expect(screen.queryByText("Try Airi for...")).not.toBeInTheDocument();
    expect(calls("/cancel")).toHaveLength(0);
  });

  it("attaches to a chat's active run when the chat opens and lands its answer", async () => {
    let resume: Stream | null = null;
    mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes("/airi-chats/sources"))
        return jsonResponse({ sources: [] });
      if (url.includes("/airi-artifacts?"))
        return jsonResponse({ artifacts: [] });
      if (url.endsWith("/airi-chats"))
        return jsonResponse({
          threads: [thread("thread-1", "Campaign ideas")],
        });
      if (url.endsWith("/airi-chats/thread-1/messages"))
        return jsonResponse({
          messages: [message("user-7", "thread-1", "user", "Ideas please")],
          hasMore: false,
          activeRun: { runId: "run-7", status: "running", startedAt: at },
        });
      if (url.endsWith("/airi-chats/thread-1/runs/run-7/stream")) {
        resume = controllableStream(init?.signal);
        return resume.response;
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(
      <AiriChatWorkspace
        workspaceId="workspace-1"
        compact
        onClose={jest.fn()}
      />
    );
    fireEvent.click(
      await screen.findByRole("button", { name: /Campaign ideas/ })
    );
    await waitFor(() => expect(resume).not.toBeNull());
    await resume!.push(
      runEvent("run-7", "thread-1"),
      {
        type: "user_message",
        message: message("user-7", "thread-1", "user", "Ideas please"),
        at,
      },
      {
        type: "stage",
        id: "generation",
        label: "Writing",
        status: "running",
        at,
      },
      { type: "assistant_delta", threadId: "thread-1", text: "Three ideas", at }
    );

    expect(
      await screen.findByTestId("airi-streaming-answer")
    ).toHaveTextContent("Three ideas");
    expect(screen.getByText("Writing your answer")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stop answer" })).toBeEnabled();
    expect(screen.getAllByText("Ideas please")).toHaveLength(1);

    await resume!.push(
      {
        type: "assistant_message",
        message: message(
          "answer-7",
          "thread-1",
          "assistant",
          "Three ideas: A, B, C."
        ),
        at,
      },
      {
        type: "done",
        thread: thread("thread-1", "Campaign ideas"),
        status: "completed",
        at,
      }
    );
    await resume!.close();

    expect(
      await screen.findByText("Three ideas: A, B, C.")
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId("airi-streaming-answer")
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Stop answer" })
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Send message" })
    ).toBeInTheDocument();
    expect(screen.getAllByText("Ideas please")).toHaveLength(1);
    expect(calls("/runs/run-7/stream")).toHaveLength(1);
  });

  it("stops a run from the composer and shows the stopped answer", async () => {
    let stream: Stream | null = null;
    mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes("/airi-chats/sources"))
        return jsonResponse({ sources: [] });
      if (url.includes("/airi-artifacts?"))
        return jsonResponse({ artifacts: [] });
      if (url.endsWith("/airi-chats")) return jsonResponse({ threads: [] });
      if (url.endsWith("/airi-chats/messages/stream")) {
        stream = controllableStream(init?.signal);
        return stream.response;
      }
      if (url.endsWith("/airi-chats/thread-1/runs/run-1/cancel"))
        return {
          ok: true,
          status: 202,
          headers: new Headers(),
          json: async () => ({ runId: "run-1", status: "running" }),
        } as Response;
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(
      <AiriChatWorkspace
        workspaceId="workspace-1"
        compact
        onClose={jest.fn()}
      />
    );
    await screen.findByText("Try Airi for...");
    send("Write a long report");
    await waitFor(() => expect(stream).not.toBeNull());
    await stream!.push(
      runEvent("run-1", "thread-1"),
      { type: "thread", thread: thread("thread-1", "Report"), at },
      {
        type: "user_message",
        message: message("user-1", "thread-1", "user", "Write a long report"),
        at,
      },
      { type: "assistant_delta", threadId: "thread-1", text: "Section one", at }
    );

    const stop = await screen.findByRole("button", { name: "Stop answer" });
    stop.focus();
    expect(stop).toHaveFocus();
    fireEvent.click(stop);

    await waitFor(() =>
      expect(calls("/runs/run-1/cancel", "POST")).toHaveLength(1)
    );
    expect(
      screen.getByRole("button", { name: "Stopping the answer" })
    ).toBeDisabled();
    // Stop never just drops the stream: the run saves what it wrote.
    expect(stream!.aborted).toBe(false);

    await stream!.push(
      {
        type: "assistant_message",
        message: message("answer-1", "thread-1", "assistant", "Section one", {
          cancelled: true,
          partial: true,
          errorCode: "airi_run_cancelled",
        }),
        at,
      },
      {
        type: "done",
        thread: thread("thread-1", "Report"),
        status: "cancelled",
        at,
      }
    );
    await stream!.close();

    expect(await screen.findByTestId("airi-answer-stopped")).toHaveTextContent(
      "Stopped"
    );
    expect(screen.getByText("Section one")).toBeInTheDocument();
    expect(screen.getByText("Request stopped")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Send message" })
    ).toBeInTheDocument();
    expect(composer()).toBeEnabled();
  });

  it("sends Stop once the run has an id and keeps the composer text when nothing was saved", async () => {
    let stream: Stream | null = null;
    mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes("/airi-chats/sources"))
        return jsonResponse({ sources: [] });
      if (url.includes("/airi-artifacts?"))
        return jsonResponse({ artifacts: [] });
      if (url.endsWith("/airi-chats"))
        return jsonResponse({ threads: [thread("thread-1", "Existing")] });
      if (url.endsWith("/airi-chats/thread-1/messages"))
        return jsonResponse({ messages: [], hasMore: false, activeRun: null });
      if (url.endsWith("/airi-chats/thread-1/messages/stream")) {
        stream = controllableStream(init?.signal);
        return stream.response;
      }
      if (url.endsWith("/runs/run-2/cancel"))
        return jsonResponse({ runId: "run-2", status: "running" });
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(
      <AiriChatWorkspace
        workspaceId="workspace-1"
        compact
        onClose={jest.fn()}
      />
    );
    fireEvent.click(await screen.findByRole("button", { name: /Existing/ }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Send message" })
      ).toBeInTheDocument()
    );
    await waitFor(() => expect(calls("/thread-1/messages")).toHaveLength(1));
    send("Never mind");
    await waitFor(() => expect(stream).not.toBeNull());

    // Stop before the run's first event: the cancel waits for its id.
    fireEvent.click(screen.getByRole("button", { name: "Stop answer" }));
    expect(calls("/cancel")).toHaveLength(0);
    await stream!.push(runEvent("run-2", "thread-1"));
    await waitFor(() =>
      expect(calls("/runs/run-2/cancel", "POST")).toHaveLength(1)
    );

    await stream!.push({
      type: "done",
      thread: thread("thread-1", "Existing"),
      status: "cancelled",
      at,
    });
    await stream!.close();

    await waitFor(() => expect(composer()).toBeEnabled());
    expect(composer()).toHaveValue("Never mind");
    expect(
      screen.queryByText("Never mind", { selector: "p" })
    ).not.toBeInTheDocument();
    expect(screen.getByText("Request stopped")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("says so and keeps the run going when Stop fails", async () => {
    let stream: Stream | null = null;
    mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes("/airi-chats/sources"))
        return jsonResponse({ sources: [] });
      if (url.includes("/airi-artifacts?"))
        return jsonResponse({ artifacts: [] });
      if (url.endsWith("/airi-chats")) return jsonResponse({ threads: [] });
      if (url.endsWith("/airi-chats/messages/stream")) {
        stream = controllableStream(init?.signal);
        return stream.response;
      }
      if (url.endsWith("/cancel"))
        return {
          ok: false,
          status: 500,
          headers: new Headers(),
          json: async () => ({ error: "Internal error" }),
        } as Response;
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(
      <AiriChatWorkspace
        workspaceId="workspace-1"
        compact
        onClose={jest.fn()}
      />
    );
    await screen.findByText("Try Airi for...");
    send("Draft an email");
    await waitFor(() => expect(stream).not.toBeNull());
    await stream!.push(runEvent("run-3", "thread-1"), {
      type: "thread",
      thread: thread("thread-1", "Email"),
      at,
    });
    fireEvent.click(await screen.findByRole("button", { name: "Stop answer" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not stop the answer. Try again."
    );
    expect(screen.getByRole("button", { name: "Stop answer" })).toBeEnabled();
    expect(stream!.aborted).toBe(false);
  });

  it("sends a client turn id and shows the question once, also after a dropped stream", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    let first: Stream | null = null;
    let resume: Stream | null = null;
    mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes("/airi-chats/sources"))
        return jsonResponse({ sources: [] });
      if (url.includes("/airi-artifacts?"))
        return jsonResponse({ artifacts: [] });
      if (url.endsWith("/airi-chats")) return jsonResponse({ threads: [] });
      if (url.endsWith("/airi-chats/messages/stream")) {
        bodies.push(JSON.parse(String(init?.body)));
        first = controllableStream(init?.signal);
        return first.response;
      }
      if (url.endsWith("/airi-chats/thread-1/runs/run-4/stream")) {
        resume = controllableStream(init?.signal);
        return resume.response;
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(
      <AiriChatWorkspace
        workspaceId="workspace-1"
        compact
        onClose={jest.fn()}
      />
    );
    await screen.findByText("Try Airi for...");
    send("What changed?");
    await waitFor(() => expect(first).not.toBeNull());
    expect(bodies).toHaveLength(1);
    expect(bodies[0].clientTurnId).toEqual(expect.stringMatching(UUID));

    // The optimistic question shows at once...
    expect(
      screen.getAllByText("What changed?", { selector: "p" })
    ).toHaveLength(1);
    await first!.push(
      runEvent("run-4", "thread-1", String(bodies[0].clientTurnId)),
      { type: "thread", thread: thread("thread-1", "Changes"), at },
      {
        type: "user_message",
        message: message("user-4", "thread-1", "user", "What changed?"),
        at,
      }
    );
    // ...and the saved one replaces it.
    expect(
      screen.getAllByText("What changed?", { selector: "p" })
    ).toHaveLength(1);

    // The connection drops before the run ends: the client follows the run.
    await first!.close();
    await waitFor(() => expect(resume).not.toBeNull());
    await resume!.push(
      runEvent("run-4", "thread-1", String(bodies[0].clientTurnId)),
      {
        type: "user_message",
        message: message("user-4", "thread-1", "user", "What changed?"),
        at,
      },
      {
        type: "assistant_message",
        message: message(
          "answer-4",
          "thread-1",
          "assistant",
          "Two things changed."
        ),
        at,
      },
      {
        type: "done",
        thread: thread("thread-1", "Changes"),
        status: "completed",
        at,
      }
    );
    await resume!.close();

    expect(await screen.findByText("Two things changed.")).toBeInTheDocument();
    expect(
      screen.getAllByText("What changed?", { selector: "p" })
    ).toHaveLength(1);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(bodies).toHaveLength(1);
  });

  it("shows the chat's running answer when a second send meets it", async () => {
    let resume: Stream | null = null;
    let answered = false;
    mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes("/airi-chats/sources"))
        return jsonResponse({ sources: [] });
      if (url.includes("/airi-artifacts?"))
        return jsonResponse({ artifacts: [] });
      if (url.endsWith("/airi-chats"))
        return jsonResponse({ threads: [thread("thread-1", "Busy chat")] });
      if (url.endsWith("/airi-chats/thread-1/messages"))
        return jsonResponse({
          messages: answered
            ? [
                message("user-9", "thread-1", "user", "First question"),
                message("answer-9", "thread-1", "assistant", "First answer."),
              ]
            : [],
          hasMore: false,
          activeRun: null,
        });
      if (url.endsWith("/airi-chats/thread-1/messages/stream"))
        return {
          ok: false,
          status: 409,
          headers: new Headers(),
          json: async () => ({
            error: "Airi is still answering in this chat.",
            code: "airi_run_active",
            runId: "run-9",
          }),
        } as Response;
      if (url.endsWith("/airi-chats/thread-1/runs/run-9/stream")) {
        resume = controllableStream(init?.signal);
        return resume.response;
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(
      <AiriChatWorkspace
        workspaceId="workspace-1"
        compact
        onClose={jest.fn()}
      />
    );
    fireEvent.click(await screen.findByRole("button", { name: /Busy chat/ }));
    await waitFor(() => expect(calls("/thread-1/messages")).toHaveLength(1));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Send message" })
      ).toBeInTheDocument()
    );
    send("Another question");

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Airi is still answering in this chat. Wait for the answer or stop it."
    );
    await waitFor(() => expect(resume).not.toBeNull());
    expect(composer()).toHaveValue("Another question");
    expect(
      screen.queryByText("Another question", { selector: "p" })
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Stop answer" })
    ).toBeInTheDocument();

    // The run it attached to ends: the "still answering" note goes.
    answered = true;
    await resume!.push(
      runEvent("run-9", "thread-1"),
      {
        type: "user_message",
        message: message("user-9", "thread-1", "user", "First question"),
        at,
      },
      {
        type: "assistant_message",
        message: message("answer-9", "thread-1", "assistant", "First answer."),
        at,
      },
      {
        type: "done",
        thread: thread("thread-1", "Busy chat"),
        status: "completed",
        at,
      }
    );
    await resume!.close();
    expect(await screen.findByText("First answer.")).toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Send message" })
      ).toBeInTheDocument()
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(composer()).toHaveValue("Another question");
  });

  it("shows a question once after the drawer closed mid-run and a send meets that run", async () => {
    let first: Stream | null = null;
    let resume: Stream | null = null;
    let messageReads = 0;
    let resolveReopenRead: (() => void) | null = null;
    const page = (withRun: boolean) =>
      jsonResponse({
        messages: [
          message("user-0", "thread-1", "user", "Earlier question"),
          message("answer-0", "thread-1", "assistant", "Earlier answer."),
          ...(withRun
            ? [
                message("user-1", "thread-1", "user", "Question one"),
                message("answer-1", "thread-1", "assistant", "Answer one."),
              ]
            : []),
        ],
        hasMore: false,
        activeRun: null,
      });
    mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes("/airi-chats/sources"))
        return jsonResponse({ sources: [] });
      if (url.includes("/airi-artifacts?"))
        return jsonResponse({ artifacts: [] });
      if (url.endsWith("/airi-chats"))
        return jsonResponse({ threads: [thread("thread-1", "Launch")] });
      if (url.endsWith("/airi-chats/thread-1/messages")) {
        messageReads += 1;
        if (messageReads === 1) return page(false);
        if (messageReads === 2) {
          // The reopened drawer's read is slow.
          return new Promise(resolve => {
            resolveReopenRead = () => resolve(page(true));
          });
        }
        return page(true);
      }
      if (url.endsWith("/airi-chats/thread-1/messages/stream")) {
        if (!first) {
          first = controllableStream(init?.signal);
          return first.response;
        }
        return {
          ok: false,
          status: 409,
          headers: new Headers(),
          json: async () => ({ code: "airi_run_active", runId: "run-1" }),
        } as Response;
      }
      if (url.endsWith("/airi-chats/thread-1/runs/run-1/stream")) {
        resume = controllableStream(init?.signal);
        return resume.response;
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const drawer = render(
      <AiriChatWorkspace
        workspaceId="workspace-1"
        compact
        onClose={jest.fn()}
      />
    );
    fireEvent.click(await screen.findByRole("button", { name: /Launch/ }));
    expect(await screen.findByText("Earlier answer.")).toBeInTheDocument();
    send("Question one");
    await waitFor(() => expect(first).not.toBeNull());
    await first!.push(runEvent("run-1", "thread-1"));
    // Closed before Airi saved the question.
    drawer.unmount();

    render(
      <AiriChatWorkspace
        workspaceId="workspace-1"
        compact
        onClose={jest.fn()}
      />
    );
    expect(await screen.findByText("Earlier answer.")).toBeInTheDocument();
    await waitFor(() => expect(resolveReopenRead).not.toBeNull());
    send("Question two");
    await waitFor(() => expect(resume).not.toBeNull());
    await resume!.push(
      runEvent("run-1", "thread-1"),
      {
        type: "user_message",
        message: message("user-1", "thread-1", "user", "Question one"),
        at,
      },
      {
        type: "assistant_message",
        message: message("answer-1", "thread-1", "assistant", "Answer one."),
        at,
      },
      {
        type: "done",
        thread: thread("thread-1", "Launch"),
        status: "completed",
        at,
      }
    );
    await resume!.close();
    await act(async () => {
      resolveReopenRead!();
      await new Promise(resolve => setTimeout(resolve, 0));
    });

    expect(await screen.findByText("Answer one.")).toBeInTheDocument();
    expect(screen.getAllByText("Question one", { selector: "p" })).toHaveLength(
      1
    );
  });

  it("never shows another user's chats after a sign-out and sign-in in the same tab", async () => {
    let stream: Stream | null = null;
    let signedInUser = "user-a";
    mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes("/airi-chats/sources"))
        return jsonResponse({ sources: [] });
      if (url.includes("/airi-artifacts?"))
        return jsonResponse({ artifacts: [] });
      if (url.endsWith("/airi-chats"))
        return signedInUser === "user-a"
          ? jsonResponse({ threads: [thread("thread-a", "Private plan")] })
          : new Promise(() => undefined);
      if (url.endsWith("/airi-chats/thread-a/messages"))
        return signedInUser === "user-a"
          ? jsonResponse({
              messages: [
                message("user-a1", "thread-a", "user", "Private question"),
              ],
              hasMore: false,
              activeRun: null,
            })
          : new Promise(() => undefined);
      if (url.endsWith("/airi-chats/thread-a/messages/stream")) {
        stream = controllableStream(init?.signal);
        return stream.response;
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    mockAuth = { user: { id: "user-a" }, loading: false };
    const first = render(
      <AiriChatWorkspace
        workspaceId="workspace-1"
        compact
        onClose={jest.fn()}
      />
    );
    fireEvent.click(
      await screen.findByRole("button", { name: /Private plan/ })
    );
    expect(await screen.findByText("Private question")).toBeInTheDocument();
    send("Another private question");
    await waitFor(() => expect(stream).not.toBeNull());
    // The drawer closes while the run answers: the chat would reopen.
    await stream!.push(runEvent("run-a", "thread-a"));
    first.unmount();

    signedInUser = "user-b";
    mockAuth = { user: { id: "user-b" }, loading: false };
    render(
      <AiriChatWorkspace
        workspaceId="workspace-1"
        compact
        onClose={jest.fn()}
      />
    );
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    expect(screen.queryByText("Private question")).not.toBeInTheDocument();
    expect(screen.queryByText("Private plan")).not.toBeInTheDocument();
    // User B never even asks for user A's chat.
    expect(calls("/thread-a/messages", "GET")).toHaveLength(1);
  });
});

describe("AiriChatWorkspace message pages", () => {
  it("loads earlier messages above the newest page", async () => {
    let failOlder = true;
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes("/airi-chats/sources"))
        return jsonResponse({ sources: [] });
      if (url.includes("/airi-artifacts?"))
        return jsonResponse({ artifacts: [] });
      if (url.endsWith("/airi-chats"))
        return jsonResponse({ threads: [thread("thread-1", "Long chat")] });
      if (url.endsWith("/airi-chats/thread-1/messages"))
        return jsonResponse({
          messages: [
            message("m3", "thread-1", "user", "Third message"),
            message("m4", "thread-1", "assistant", "Fourth message"),
          ],
          hasMore: true,
          activeRun: null,
        });
      if (url.includes("/airi-chats/thread-1/messages?")) {
        const query = new URL(url, "http://localhost").searchParams;
        expect(query.get("before")).toBe("m3");
        expect(query.get("limit")).toBe("50");
        if (failOlder) {
          return {
            ok: false,
            status: 503,
            headers: new Headers(),
            json: async () => ({ error: "Unavailable" }),
          } as Response;
        }
        return jsonResponse({
          messages: [
            message("m1", "thread-1", "user", "First message"),
            message("m2", "thread-1", "assistant", "Second message"),
          ],
          hasMore: false,
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(
      <AiriChatWorkspace
        workspaceId="workspace-1"
        compact
        onClose={jest.fn()}
      />
    );
    fireEvent.click(await screen.findByRole("button", { name: /Long chat/ }));
    expect(await screen.findByText("Fourth message")).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "Load earlier messages" })
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Earlier messages did not load. Try again."
    );

    failOlder = false;
    fireEvent.click(
      screen.getByRole("button", { name: "Load earlier messages" })
    );
    expect(await screen.findByText("First message")).toBeInTheDocument();
    const log = screen.getByRole("log", { name: "Airi conversation" });
    const order = [
      "First message",
      "Second message",
      "Third message",
      "Fourth message",
    ].map(text => within(log).getByText(text));
    for (let index = 1; index < order.length; index += 1) {
      expect(
        order[index - 1].compareDocumentPosition(order[index]) &
          Node.DOCUMENT_POSITION_FOLLOWING
      ).toBeTruthy();
    }
    expect(
      screen.queryByRole("button", { name: "Load earlier messages" })
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("AiriChatWorkspace layout", () => {
  function mockLayout(mobile: boolean) {
    window.matchMedia = jest.fn().mockImplementation((query: string) => ({
      matches: mobile && query.includes("max-width"),
      media: query,
      onchange: null,
      addListener: jest.fn(),
      removeListener: jest.fn(),
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
      dispatchEvent: jest.fn(),
    }));
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes("/airi-chats/sources"))
        return jsonResponse({ sources: [] });
      if (url.endsWith("/airi-chats"))
        return jsonResponse({ threads: [thread("thread-1", "Kept chat")] });
      throw new Error(`Unexpected fetch: ${url}`);
    });
  }

  it("server-renders both layouts so a phone's first paint is not blank", () => {
    mockLayout(true);
    const html = renderToString(
      <AiriChatWorkspace workspaceId="workspace-1" />
    );
    // The phone's header and composer are in the markup (CSS shows them).
    expect(html).toContain('aria-label="Back to chats"');
    expect(html).toContain('aria-label="Ask Airi"');
    expect(html).toContain("hidden min-w-0 flex-1 lg:block");
  });

  it("renders only the mobile tree on a phone", async () => {
    mockLayout(true);
    render(<AiriChatWorkspace workspaceId="workspace-1" />);
    expect(await screen.findAllByText("Kept chat")).toHaveLength(1);
    expect(screen.getAllByRole("combobox", { name: "Ask Airi" })).toHaveLength(
      1
    );
    expect(
      screen.getByRole("button", { name: "Back to chats" })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "New Airi chat" })
    ).not.toBeInTheDocument();
  });

  it("renders only the desktop columns on a wide screen", async () => {
    mockLayout(false);
    render(<AiriChatWorkspace workspaceId="workspace-1" />);
    expect(await screen.findAllByText("Kept chat")).toHaveLength(1);
    expect(screen.getAllByRole("combobox", { name: "Ask Airi" })).toHaveLength(
      1
    );
    expect(
      screen.getByRole("button", { name: "New Airi chat" })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Back to chats" })
    ).not.toBeInTheDocument();
  });
});
