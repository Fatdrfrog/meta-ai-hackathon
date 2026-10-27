import {
  isAiriChatRunTerminal,
  retainTerminalAiriChatRunEvents,
  type AiriChatRunEvent,
} from "./run-events";

const at = "2026-09-20T18:00:00.000Z";

const runningStage: AiriChatRunEvent = {
  type: "stage",
  id: "generation",
  label: "Generating answer",
  status: "running",
  at,
};

const done: AiriChatRunEvent = {
  type: "done",
  thread: {
    id: "thread-1",
    title: "Saved chat",
    source: "manual",
    pinnedAt: null,
    updatedAt: at,
  },
  at,
};

describe("airi chat run events", () => {
  it("treats empty and in-flight traces as non-terminal", () => {
    expect(isAiriChatRunTerminal([])).toBe(false);
    expect(isAiriChatRunTerminal([runningStage])).toBe(false);
    expect(retainTerminalAiriChatRunEvents([runningStage])).toEqual([]);
  });

  it("treats streamed answer previews and unknown events as non-terminal", () => {
    const delta: AiriChatRunEvent = {
      type: "assistant_delta",
      threadId: "thread-1",
      text: "Partial answer",
      at,
    };
    expect(isAiriChatRunTerminal([runningStage, delta])).toBe(false);
    const fromNewerServer = {
      type: "future_event",
      at,
    } as unknown as AiriChatRunEvent;
    expect(isAiriChatRunTerminal([fromNewerServer])).toBe(false);
  });

  it("keeps complete, cancelled, and failed traces", () => {
    const answer: AiriChatRunEvent = {
      type: "assistant_message",
      at,
      message: {
        id: "answer",
        threadId: "thread-1",
        role: "assistant",
        content: "Ready",
        createdAt: at,
      },
    };
    const failed: AiriChatRunEvent = {
      type: "error",
      message: "The answer failed",
      at,
    };
    expect(isAiriChatRunTerminal([runningStage, answer])).toBe(true);
    expect(isAiriChatRunTerminal([runningStage, failed])).toBe(true);
    expect(isAiriChatRunTerminal([runningStage, done])).toBe(true);
    expect(retainTerminalAiriChatRunEvents([runningStage, answer])).toEqual([
      runningStage,
      answer,
    ]);
  });
});
