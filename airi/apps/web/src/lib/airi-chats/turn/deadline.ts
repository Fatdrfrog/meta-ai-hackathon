/**
 * One wall-clock deadline per Airi chat turn. Every step that has a timeout
 * (classifier, retrieval legs, generation and draft calls) takes it from
 * here, capped by what is left of the turn, so no step outlives the turn and
 * the save reserve is always left for persisting the reply.
 */

import { createInferenceDeadline } from "@/lib/ai/inference-deadline";

/** Whole-turn budget; the route's maxDuration (300 s) leaves headroom. */
export const AIRI_TURN_BUDGET_MS = 280_000;
/** Kept back from the steps for saving the reply (or the failure reply). */
export const AIRI_TURN_SAVE_RESERVE_MS = 10_000;
/** The chat facade's own default timeout, now explicit per step. */
export const AIRI_TURN_DEFAULT_STEP_TIMEOUT_MS = 30_000;

// Draft builders run on the heavy tier (Sonnet, thinking on) and return long
// JSON. One deadline covers retries and the Gemini fallback, which only gets
// ~35% of it after a non-final Claude attempt; size it so that share stays
// near the 30 s these calls had on Gemini alone.
export const AIRI_SHORT_DRAFT_AI_TIMEOUT_MS = 60_000;
export const AIRI_LONG_DRAFT_AI_TIMEOUT_MS = 90_000;

/** Below this a step is not started: it could not finish in time. */
export const AIRI_TURN_MIN_STEP_TIMEOUT_MS = 1_000;

/**
 * The turn ran out of time before a step could start. Not a cancellation
 * (its name is neither AbortError nor TimeoutError): the turn saves its
 * failure reply instead of dropping the user's message.
 */
export class AiriTurnDeadlineExceededError extends Error {
  readonly code = "airi_turn_deadline_exceeded";

  constructor() {
    super("Airi chat turn ran out of time");
    this.name = "AiriTurnDeadlineExceededError";
  }
}

export type AiriTurnDeadline = {
  /** When the whole turn, save reserve included, must be finished. */
  readonly deadlineAt: number;
  /** When the steps must be finished; the reserve follows. */
  readonly workDeadlineAt: number;
  /** Time left for steps (the save reserve excluded). */
  remainingMs: () => number;
  /**
   * A step's timeout: its own cap, shortened to what is left of the turn.
   * Throws AiriTurnDeadlineExceededError when too little is left to start.
   */
  stepTimeoutMs: (capMs: number) => number;
};

export function createAiriTurnDeadline(
  options: {
    budgetMs?: number;
    saveReserveMs?: number;
    now?: () => number;
  } = {}
): AiriTurnDeadline {
  const budgetMs = options.budgetMs ?? AIRI_TURN_BUDGET_MS;
  const saveReserveMs = Math.min(
    options.saveReserveMs ?? AIRI_TURN_SAVE_RESERVE_MS,
    budgetMs
  );
  const now = options.now ?? Date.now;
  const startedAt = now();
  const work = createInferenceDeadline(budgetMs - saveReserveMs, now);
  return {
    deadlineAt: startedAt + budgetMs,
    workDeadlineAt: work.deadlineAt,
    remainingMs: work.remainingMs,
    stepTimeoutMs: capMs => {
      const timeoutMs = work.nextTimeoutMs(
        capMs,
        AIRI_TURN_MIN_STEP_TIMEOUT_MS
      );
      if (timeoutMs === null) throw new AiriTurnDeadlineExceededError();
      return timeoutMs;
    },
  };
}
