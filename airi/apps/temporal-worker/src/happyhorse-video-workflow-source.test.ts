import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("registers HappyHorse video workflow and media activities", async () => {
  const [workflowsIndex, worker, workflow, activity] = await Promise.all([
    readFile(new URL("./workflows/index.ts", import.meta.url), "utf8"),
    readFile(new URL("./worker.ts", import.meta.url), "utf8"),
    readFile(
      new URL("./workflows/happyhorse-video.ts", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("./activities/happyhorse-video.ts", import.meta.url),
      "utf8",
    ),
  ]);

  assert.match(workflowsIndex, /happyHorseVideoWorkflow/);
  assert.match(worker, /HAPPYHORSE_VIDEO_PROCESS_ACTIVITY/);
  assert.match(worker, /happyHorseVideoProcessActivity/);
  assert.match(workflow, /happyHorseVideoWorkflow/);
  assert.match(activity, /submitHappyHorseT2V/);
  assert.match(activity, /submitHappyHorseI2V/);
  assert.match(activity, /submitHappyHorseR2V/);
  assert.match(activity, /reference_to_video/);
});
