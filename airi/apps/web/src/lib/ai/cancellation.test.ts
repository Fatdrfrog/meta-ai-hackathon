import {
  awaitWithCancellation,
  sleepWithCancellation,
  throwIfCancelled,
} from "./cancellation";

test("recognizes caller cancellation and standalone abort/deadline errors", () => {
  const controller = new AbortController();
  controller.abort();
  expect(() => throwIfCancelled(controller.signal)).toThrow();
  for (const name of ["AbortError", "TimeoutError"]) {
    const error = new DOMException("Stopped", name);
    expect(() => throwIfCancelled(undefined, error)).toThrow(error);
  }
  expect(() =>
    throwIfCancelled(undefined, new Error("ordinary failure"))
  ).not.toThrow();
});

test("stops a caller waiting for shared work without cancelling the shared promise", async () => {
  const controller = new AbortController();
  let finish!: (value: string) => void;
  const shared = new Promise<string>(resolve => {
    finish = resolve;
  });
  const waiting = awaitWithCancellation(shared, controller.signal);
  controller.abort();
  await expect(waiting).rejects.toBe(controller.signal.reason);
  finish("cached result");
  await expect(shared).resolves.toBe("cached result");
});

test("preserves ordinary fulfillment and rejection and removes the listener", async () => {
  const controller = new AbortController();
  const remove = jest.spyOn(controller.signal, "removeEventListener");
  await expect(
    awaitWithCancellation(Promise.resolve(4), controller.signal)
  ).resolves.toBe(4);
  const error = new Error("lookup failure");
  await expect(
    awaitWithCancellation(Promise.reject(error), controller.signal)
  ).rejects.toBe(error);
  expect(remove).toHaveBeenCalledTimes(2);
});

test("sleepWithCancellation resolves after the delay and rejects with the abort reason", async () => {
  await expect(sleepWithCancellation(1)).resolves.toBeUndefined();

  const controller = new AbortController();
  const remove = jest.spyOn(controller.signal, "removeEventListener");
  await expect(
    sleepWithCancellation(1, controller.signal)
  ).resolves.toBeUndefined();
  expect(remove).toHaveBeenCalledTimes(1);

  const waiting = sleepWithCancellation(60_000, controller.signal);
  const reason = new Error("caller stopped");
  controller.abort(reason);
  await expect(waiting).rejects.toBe(reason);

  // An already-aborted signal throws synchronously, as the inline copies did.
  expect(() => sleepWithCancellation(1, controller.signal)).toThrow(reason);
});
