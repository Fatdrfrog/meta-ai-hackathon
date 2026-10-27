import { throwIfCancelled } from "@/lib/ai/cancellation";
import {
  AIRI_LONG_DRAFT_AI_TIMEOUT_MS,
  AIRI_TURN_BUDGET_MS,
  AIRI_TURN_SAVE_RESERVE_MS,
  AiriTurnDeadlineExceededError,
  createAiriTurnDeadline,
} from "./deadline";

function clock(start = 1_000_000) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("createAiriTurnDeadline", () => {
  it("budgets 280 s per turn and keeps a save reserve out of the steps", () => {
    const time = clock();
    const deadline = createAiriTurnDeadline({ now: time.now });

    expect(AIRI_TURN_BUDGET_MS).toBe(280_000);
    // The route's maxDuration (300 s) must stay above the whole budget.
    expect(AIRI_TURN_BUDGET_MS).toBeLessThan(300_000);
    expect(deadline.deadlineAt).toBe(time.now() + AIRI_TURN_BUDGET_MS);
    expect(deadline.workDeadlineAt).toBe(
      time.now() + AIRI_TURN_BUDGET_MS - AIRI_TURN_SAVE_RESERVE_MS
    );
    expect(deadline.remainingMs()).toBe(
      AIRI_TURN_BUDGET_MS - AIRI_TURN_SAVE_RESERVE_MS
    );
  });

  it("gives a step its own cap while the turn has time left", () => {
    const time = clock();
    const deadline = createAiriTurnDeadline({ now: time.now });

    expect(deadline.stepTimeoutMs(AIRI_LONG_DRAFT_AI_TIMEOUT_MS)).toBe(
      AIRI_LONG_DRAFT_AI_TIMEOUT_MS
    );
  });

  it("shortens a step to what is left of the turn", () => {
    const time = clock();
    const deadline = createAiriTurnDeadline({
      budgetMs: 100_000,
      saveReserveMs: 10_000,
      now: time.now,
    });
    time.advance(70_000);

    // 90 s of work time, 70 s used: a 60 s step gets the last 20 s.
    expect(deadline.remainingMs()).toBe(20_000);
    expect(deadline.stepTimeoutMs(60_000)).toBe(20_000);
    expect(deadline.stepTimeoutMs(5_000)).toBe(5_000);
  });

  it("refuses to start a step that could not finish before the save reserve", () => {
    const time = clock();
    const deadline = createAiriTurnDeadline({
      budgetMs: 100_000,
      saveReserveMs: 10_000,
      now: time.now,
    });
    time.advance(89_500);

    expect(() => deadline.stepTimeoutMs(60_000)).toThrow(
      AiriTurnDeadlineExceededError
    );
    // The save reserve is still there for the failure reply.
    expect(deadline.deadlineAt - time.now()).toBe(10_500);
  });

  it("is a failure, not a cancellation, when the turn runs out of time", () => {
    const error = new AiriTurnDeadlineExceededError();

    expect(error.name).not.toBe("AbortError");
    expect(error.name).not.toBe("TimeoutError");
    expect(() => throwIfCancelled(undefined, error)).not.toThrow();
    expect(error.code).toBe("airi_turn_deadline_exceeded");
  });
});
