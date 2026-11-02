import assert from "node:assert/strict";
import test from "node:test";

import { importSpendPort } from "./product-video-import";

const IMPORT = "6ae43246b2009b6f5799236e";

/** The web's import spend, recording the AI action each call is booked to. */
function recordingSpend() {
  const calls: string[] = [];
  const spend: Parameters<typeof importSpendPort>[0] = {
    async allowance(workspaceId) {
      calls.push(`allowance ${workspaceId}`);
      return {
        includedActions: 500,
        remainingActions: 12,
        spendLimitReached: false,
        spendRemainingMicros: 335_000,
        trialEnded: false,
      };
    },
    async reserve(input) {
      calls.push(`reserve ${input.actionId} ${input.operationId}`);
      return {
        workspaceId: input.workspaceId,
        actionId: input.actionId,
        operationId: input.operationId,
        maxCostMicros: input.maxCostMicros,
      };
    },
    async settle(reservation, actualCostMicros) {
      calls.push(`settle ${reservation.actionId} ${actualCostMicros}`);
    },
  };
  return { spend, calls };
}

test("books an attempt's read steps to an action of its own, and a photo to one for its whole run", async () => {
  const { spend, calls } = recordingSpend();
  const port = (runId: string, attempt: number) =>
    importSpendPort(spend, {
      workspaceId: "w1",
      importId: IMPORT,
      runId,
      attempt,
    });
  const photo = { kind: "photo", productId: "p1", optionIndex: 2 } as const;

  await port("run-a", 1).reserve(
    { kind: "read" },
    "inventory:attempt-1",
    "meta",
    1,
  );
  await port("run-a", 2).reserve(
    { kind: "read" },
    "inventory:attempt-2",
    "meta",
    1,
  );
  await port("run-a", 1).reserve(photo, "photo:attempt-1", "meta", 1);
  await port("run-a", 2).reserve(photo, "photo:attempt-2", "meta", 1);
  await port("run-b", 1).reserve(photo, "photo:attempt-1", "meta", 1);

  assert.deepEqual(calls, [
    // A retry reads the video in a new action,
    `reserve product-video-import:${IMPORT}:read:run-a:1 inventory:attempt-1`,
    `reserve product-video-import:${IMPORT}:read:run-a:2 inventory:attempt-2`,
    // while a photo's attempts share one, until a later run.
    `reserve product-video-import:${IMPORT}:photo:p1:2:run-a photo:attempt-1`,
    `reserve product-video-import:${IMPORT}:photo:p1:2:run-a photo:attempt-2`,
    `reserve product-video-import:${IMPORT}:photo:p1:2:run-b photo:attempt-1`,
  ]);
});

test("checks the workspace's allowance and settles each reservation where it was made", async () => {
  const { spend, calls } = recordingSpend();
  const port = importSpendPort(spend, {
    workspaceId: "w1",
    importId: IMPORT,
    runId: "run-a",
    attempt: 1,
  });

  assert.deepEqual(await port.allowance(), {
    includedActions: 500,
    remainingActions: 12,
    spendLimitReached: false,
    spendRemainingMicros: 335_000,
    trialEnded: false,
  });
  const reservation = await port.reserve(
    { kind: "read" },
    "transcription:attempt-1",
    "elevenlabs",
    3_667,
  );
  await port.settle(reservation, 1_834);

  assert.deepEqual(calls.slice(-1), [
    `settle product-video-import:${IMPORT}:read:run-a:1 1834`,
  ]);
  assert.equal(calls[0], "allowance w1");
});
