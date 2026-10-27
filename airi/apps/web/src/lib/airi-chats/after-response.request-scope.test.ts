/**
 * Uses Next's real after() and AfterContext (no next/server mock) to pin the
 * claim in after-response.ts: an after() call made from inside an SSE body,
 * after the route handler has returned, is still in the request's scope.
 * If a Next upgrade changes that, this fails instead of the turn's title,
 * thread save, analytics and quota silently running inline.
 */
jest.mock("@/lib/logger", () => ({
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}));

import { AfterContext } from "next/dist/server/after/after-context";
import { workAsyncStorage } from "next/dist/server/app-render/work-async-storage.external";
import { workUnitAsyncStorage } from "next/dist/server/app-render/work-unit-async-storage.external";
import { scheduleAiriChatAfterResponse } from "./after-response";
import { createAiriChatSseResponse } from "./sse";

it("queues bookkeeping scheduled from an SSE body until the response closes", async () => {
  const closeListeners: Array<() => void> = [];
  const waitedOn: Array<Promise<unknown>> = [];
  const afterContext = new AfterContext({
    waitUntil: promise => {
      waitedOn.push(promise);
    },
    onClose: callback => {
      closeListeners.push(callback);
    },
    onTaskError: undefined,
  });
  // Only the fields after() and AfterContext read; the route module builds
  // the full stores (createWorkStore / createRequestStoreForAPI).
  const workStore = { afterContext } as never;
  const requestStore = { type: "request", phase: "action" } as never;
  const task = jest.fn().mockResolvedValue(undefined);

  // What app-route/module.js does: run the handler inside both stores.
  const response = workUnitAsyncStorage.run(requestStore, () =>
    workAsyncStorage.run(workStore, () =>
      createAiriChatSseResponse(async emit => {
        // A later async continuation, as in a real turn.
        await new Promise(resolve => setTimeout(resolve, 0));
        await emit({
          type: "done",
          thread: {
            id: "thread-1",
            title: "Hello",
            source: "manual",
            updatedAt: "2026-10-08T00:00:00.000Z",
          },
          at: "2026-10-08T00:00:00.000Z",
        });
        scheduleAiriChatAfterResponse("turn_bookkeeping", task);
      })
    )
  );

  // The handler has returned; the body finishes on its own.
  await expect(response.text()).resolves.toContain("event: done");
  // Queued by after() (not the inline fallback) and covered by waitUntil.
  expect(task).not.toHaveBeenCalled();
  expect(waitedOn).toHaveLength(1);

  for (const close of closeListeners) close();
  await Promise.all(waitedOn);
  expect(task).toHaveBeenCalledTimes(1);
});
