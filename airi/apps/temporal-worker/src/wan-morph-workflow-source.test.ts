import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("registers Wan morph workflow and media activities", async () => {
  const [workflowsIndex, worker, workflow, activity] = await Promise.all([
    readFile(new URL("./workflows/index.ts", import.meta.url), "utf8"),
    readFile(new URL("./worker.ts", import.meta.url), "utf8"),
    readFile(new URL("./workflows/wan-morph.ts", import.meta.url), "utf8"),
    readFile(new URL("./activities/wan-morph.ts", import.meta.url), "utf8"),
  ]);

  assert.match(workflowsIndex, /wanMorphWorkflow/);
  assert.match(worker, /WAN_MORPH_PROCESS_ACTIVITY/);
  assert.match(worker, /wanMorphProcessActivity/);
  assert.match(workflow, /wanMorphWorkflow/);
  assert.match(activity, /submitWanFirstLastI2V/);
  assert.match(activity, /first_last_frame/);
});
