import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("registers wan avatar workflow and media activities", async () => {
  const [workflowsIndex, worker, workflow, activity] = await Promise.all([
    readFile(new URL("./workflows/index.ts", import.meta.url), "utf8"),
    readFile(new URL("./worker.ts", import.meta.url), "utf8"),
    readFile(new URL("./workflows/wan-avatar.ts", import.meta.url), "utf8"),
    readFile(new URL("./activities/wan-avatar.ts", import.meta.url), "utf8"),
  ]);

  assert.match(workflowsIndex, /wanAvatarWorkflow/);
  assert.match(worker, /WAN_AVATAR_PROCESS_ACTIVITY/);
  assert.match(worker, /wanAvatarProcessActivity/);
  assert.match(workflow, /wanAvatarWorkflow/);
  assert.match(activity, /pollWanS2VTask/);
  assert.doesNotMatch(activity, /submitWanS2V|submitElevenLabsTextToSpeech/);
});
