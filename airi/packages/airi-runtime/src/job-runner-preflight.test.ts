import assert from "node:assert/strict";
import test from "node:test";
import {
  AiriTurnPreparationNotStartedError,
  runAiriTurnPreflight,
} from "./job-runner-preflight";

test("preflight preserves read failures as preparation-not-started errors", async () => {
  const cause = new Error("database unavailable");
  await assert.rejects(
    runAiriTurnPreflight(async () => {
      throw cause;
    }),
    (error) =>
      error instanceof AiriTurnPreparationNotStartedError &&
      error.cause === cause,
  );
});

test("preflight returns hydrated values without wrapping subsequent runtime failures", async () => {
  assert.equal(await runAiriTurnPreflight(async () => "hydrated"), "hydrated");
  const runtimeError = new Error("mutation outcome uncertain");
  await assert.rejects(
    (async () => {
      await runAiriTurnPreflight(async () => "hydrated");
      throw runtimeError;
    })(),
    (error) =>
      error === runtimeError &&
      !(error instanceof AiriTurnPreparationNotStartedError),
  );
});
