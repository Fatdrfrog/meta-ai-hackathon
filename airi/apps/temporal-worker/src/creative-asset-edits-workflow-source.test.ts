import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("creative asset edits allow two-hour media renders to finish and retry", async () => {
  const source = await readFile(
    new URL("./workflows/creative-asset-edits.ts", import.meta.url),
    "utf8",
  );

  assert.match(source, /startToCloseTimeout:\s*"10800s"/);
  assert.match(source, /scheduleToCloseTimeout:\s*"32400s"/);
  assert.match(source, /heartbeatTimeout:\s*"5m"/);
  assert.match(source, /maximumAttempts:\s*3/);
});
