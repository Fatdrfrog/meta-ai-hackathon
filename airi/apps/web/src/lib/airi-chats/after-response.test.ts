const mockAfter = jest.fn();
const mockLoggerError = jest.fn();

jest.mock("next/server", () => ({
  after: (task: () => Promise<void>) => mockAfter(task),
}));
jest.mock("@/lib/logger", () => ({
  logger: {
    error: (...args: unknown[]) => mockLoggerError(...args),
    warn: jest.fn(),
    info: jest.fn(),
  },
}));

import { AsyncLocalStorage } from "node:async_hooks";
import {
  runInAiriChatRunTaskScope,
  scheduleAiriChatAfterResponse,
} from "./after-response";

const flush = () => new Promise(resolve => setImmediate(resolve));

describe("scheduleAiriChatAfterResponse", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("hands the task to after() inside a request scope and does not run it inline", async () => {
    const queued: Array<() => Promise<void>> = [];
    mockAfter.mockImplementation(task => {
      queued.push(task);
    });
    const task = jest.fn().mockResolvedValue(undefined);

    scheduleAiriChatAfterResponse("quota", task, { workspaceId: "w1" });
    await flush();

    expect(mockAfter).toHaveBeenCalledTimes(1);
    expect(task).not.toHaveBeenCalled();
    await queued[0]!();
    expect(task).toHaveBeenCalledTimes(1);
  });

  it("runs the task at once when after() is unavailable outside a request scope", async () => {
    mockAfter.mockImplementation(() => {
      throw new Error("`after` was called outside a request scope.");
    });
    const task = jest.fn().mockResolvedValue(undefined);

    scheduleAiriChatAfterResponse("quota", task);

    // Started synchronously by the fallback, not deferred.
    expect(task).toHaveBeenCalledTimes(1);
    await flush();
    expect(mockLoggerError).not.toHaveBeenCalled();
  });

  it("logs a failing fallback task instead of rejecting", async () => {
    mockAfter.mockImplementation(() => {
      throw new Error("`after()` will not work correctly");
    });
    const failure = new Error("quota write failed");
    const unhandled = jest.fn();
    process.on("unhandledRejection", unhandled);
    try {
      expect(() =>
        scheduleAiriChatAfterResponse(
          "studio_chat_quota",
          () => Promise.reject(failure),
          { workspaceId: "w1", threadId: "t1" }
        )
      ).not.toThrow();
      await flush();
      expect(mockLoggerError).toHaveBeenCalledWith(
        "airi_chat.after_response.studio_chat_quota_failed",
        failure,
        { workspaceId: "w1", threadId: "t1" }
      );
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("carries the caller's async context into a deferred task", async () => {
    const queued: Array<() => Promise<void>> = [];
    mockAfter.mockImplementation(task => {
      queued.push(task);
    });
    const scope = new AsyncLocalStorage<string>();
    let seen: string | undefined;

    scope.run("workspace-action", () =>
      scheduleAiriChatAfterResponse("title", async () => {
        seen = scope.getStore();
      })
    );
    // Run later, from outside the scope, as Next does after the response.
    await queued[0]!();

    expect(seen).toBe("workspace-action");
  });

  it("inside a durable run starts the task at once and tracks it for the run's keep-alive", async () => {
    let finish = () => {};
    const task = jest.fn(
      () =>
        new Promise<void>(resolve => {
          finish = resolve;
        })
    );
    const tasks = new Set<Promise<void>>();

    // The run's request may be long closed: after() is not used.
    await runInAiriChatRunTaskScope(tasks, async () => {
      await flush();
      scheduleAiriChatAfterResponse("title", task, { workspaceId: "w1" });
    });

    expect(mockAfter).not.toHaveBeenCalled();
    expect(task).toHaveBeenCalledTimes(1);
    expect(tasks.size).toBe(1);
    finish();
    await Promise.allSettled([...tasks]);
    await flush();
    expect(tasks.size).toBe(0);
  });
});
