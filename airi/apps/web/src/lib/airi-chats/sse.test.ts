jest.mock("@/lib/logger", () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn() },
}));

import { AiriChatSelectedSourceError } from "./errors";
import {
  AIRI_CHAT_SSE_PING_INTERVAL_MS,
  createAiriChatSseResponse,
} from "./sse";

const at = "2026-10-07T00:00:00.000Z";

describe("Airi chat stream framing", () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it("sends a comment ping every 15 s while a run is open and stops after it ends", async () => {
    jest.useFakeTimers();
    expect(AIRI_CHAT_SSE_PING_INTERVAL_MS).toBe(15_000);
    let finish!: () => void;
    const response = createAiriChatSseResponse(
      () =>
        new Promise<void>(resolve => {
          finish = resolve;
        })
    );
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    jest.advanceTimersByTime(AIRI_CHAT_SSE_PING_INTERVAL_MS);
    const first = await reader.read();
    expect(decoder.decode(first.value)).toBe(": ping\n\n");
    finish();
    await jest.runOnlyPendingTimersAsync();
    const end = await reader.read();
    expect(end.done).toBe(true);
    expect(jest.getTimerCount()).toBe(0);
  });

  it("never emits an error after the assistant message", async () => {
    const response = createAiriChatSseResponse(async emit => {
      await emit({
        type: "assistant_message",
        message: {
          id: "answer-1",
          threadId: "thread-1",
          role: "assistant",
          content: "Ready",
          createdAt: at,
        },
        at,
      });
      throw new Error("bookkeeping failed");
    });
    const text = await response.text();
    expect(text).toContain("event: assistant_message");
    expect(text).not.toContain("event: error");
  });

  it("still reports an error when no answer was emitted, without its internals", async () => {
    const response = createAiriChatSseResponse(async () => {
      throw new Error("generation failed at 10.0.0.5:27017");
    });
    const text = await response.text();
    expect(text).toContain("event: error");
    const data = JSON.parse(text.split("data: ")[1]!.split("\n")[0]!);
    expect(data).toMatchObject({
      type: "error",
      message: "Failed to send Airi message",
      code: "airi_chat_failed",
      status: 500,
      persisted: false,
    });
    expect(text).not.toContain("10.0.0.5");
  });

  it("reports an inner deadline as a logged timeout, not a cancellation", async () => {
    const { logger } = jest.requireMock("@/lib/logger");
    const request = new AbortController();
    const response = createAiriChatSseResponse(
      async () => {
        throw new DOMException("The operation timed out", "TimeoutError");
      },
      { signal: request.signal }
    );
    const text = await response.text();
    const data = JSON.parse(text.split("data: ")[1]!.split("\n")[0]!);
    expect(data).toMatchObject({ code: "timed_out", status: 504 });
    expect(data.message).not.toBe("Request cancelled");
    expect(logger.error).toHaveBeenCalledWith(
      "airi_chat.stream_failed",
      expect.objectContaining({ name: "TimeoutError" }),
      { code: "timed_out" }
    );
  });

  it("keeps a typed error's safe message and code", async () => {
    const response = createAiriChatSseResponse(async () => {
      throw new AiriChatSelectedSourceError(
        "Selected source is unavailable: Canva"
      );
    });
    const text = await response.text();
    const data = JSON.parse(text.split("data: ")[1]!.split("\n")[0]!);
    expect(data).toMatchObject({
      message: "Selected source is unavailable: Canva",
      code: "selected_source_unavailable",
      status: 400,
    });
  });

  it("serializes assistant_delta previews like any other event", async () => {
    const response = createAiriChatSseResponse(async emit => {
      await emit({
        type: "assistant_delta",
        threadId: "thread-1",
        text: "Hello wor",
        at,
      });
    });
    const text = await response.text();
    expect(text).toContain("event: assistant_delta\n");
    const data = JSON.parse(text.split("data: ")[1]!.split("\n")[0]!);
    expect(data).toMatchObject({ threadId: "thread-1", text: "Hello wor" });
  });
});

describe("Airi chat stream cancellation", () => {
  it("closes the response immediately when HTTP aborts before work settles", async () => {
    const request = new AbortController();
    let finish!: () => void;
    let activeSignal: AbortSignal | undefined;
    const response = createAiriChatSseResponse(
      async (_emit, signal) => {
        activeSignal = signal;
        await new Promise<void>(resolve => {
          finish = resolve;
        });
      },
      { signal: request.signal }
    );
    const reader = response.body!.getReader();
    let closed = false;
    const reading = reader.read().then(value => {
      closed = value.done;
    });
    try {
      request.abort();
      await Promise.resolve();
      expect(activeSignal?.aborted).toBe(true);
      expect(closed).toBe(true);
    } finally {
      finish();
      await reading;
    }
  });

  it("cancels the active operation when the response reader disconnects", async () => {
    let activeSignal: AbortSignal | undefined;
    let finish!: () => void;
    const response = createAiriChatSseResponse(async (_emit, signal) => {
      activeSignal = signal;
      await new Promise<void>(resolve => {
        finish = resolve;
      });
    });
    await response.body!.cancel();
    expect(activeSignal?.aborted).toBe(true);
    finish();
  });

  it("does not start work when the HTTP request is already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const run = jest.fn().mockResolvedValue(undefined);
    const response = createAiriChatSseResponse(run, {
      signal: controller.signal,
    });
    await expect(response.text()).resolves.toBe("");
    expect(run).not.toHaveBeenCalled();
  });
});
