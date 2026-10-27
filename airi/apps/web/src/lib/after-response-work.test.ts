const mockAfter = jest.fn((_callback: () => Promise<void>): void => {
  throw new Error("outside a request scope");
});
const mockWarn = jest.fn();

jest.mock("next/server", () => ({
  after: (callback: () => Promise<void>) => mockAfter(callback),
}));
jest.mock("@/lib/logger", () => ({
  logger: { warn: (...args: unknown[]) => mockWarn(...args) },
}));

import {
  drainPendingAfterResponseWork,
  runAfterResponse,
} from "./after-response-work";

beforeEach(() => {
  jest.clearAllMocks();
});

it("starts the work now outside a request, and the drain waits for it", async () => {
  let finish!: () => void;
  const task = jest.fn(
    () =>
      new Promise<void>(resolve => {
        finish = resolve;
      })
  );

  runAfterResponse("ai_spend_settle", task);
  expect(task).toHaveBeenCalledTimes(1);
  await expect(drainPendingAfterResponseWork(10)).resolves.toBe(false);

  finish();
  await expect(drainPendingAfterResponseWork(1_000)).resolves.toBe(true);
});

it("hands the work to after() inside a request", async () => {
  let scheduled!: () => Promise<void>;
  mockAfter.mockImplementationOnce(callback => {
    scheduled = callback;
  });
  const task = jest.fn(async () => undefined);

  runAfterResponse("ai_spend_settle", task);
  expect(task).not.toHaveBeenCalled();
  await scheduled();
  expect(task).toHaveBeenCalledTimes(1);
});

it("logs a failure by name and code, never the error text", async () => {
  runAfterResponse("ai_spend_settle", async () => {
    throw Object.assign(
      new Error("connect ECONNREFUSED https://db.example/rest?key=secret"),
      { code: "workspace_ai_policy_unavailable" }
    );
  });
  await drainPendingAfterResponseWork(1_000);

  expect(mockWarn).toHaveBeenCalledWith(
    "after_response.ai_spend_settle_failed",
    {
      errorType: "Error",
      errorCode: "workspace_ai_policy_unavailable",
    }
  );
  expect(JSON.stringify(mockWarn.mock.calls)).not.toContain("secret");
});
