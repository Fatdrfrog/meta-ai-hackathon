import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const workerRoot = path.resolve(import.meta.dirname);
const repoRoot = path.resolve(workerRoot, "../../..");

test("propagates submission failures to the Temporal retry boundary", () => {
  const mediaOwnerSource = fs.readFileSync(
    path.join(
      repoRoot,
      "apps/web/src/lib/classifier/conversation-media-analysis.ts",
    ),
    "utf8",
  );
  const activitySource = fs.readFileSync(
    path.join(workerRoot, "activities/conversation-media-analysis.ts"),
    "utf8",
  );

  assert.match(mediaOwnerSource, /const submission = await input\.submit\(/);
  assert.doesNotMatch(mediaOwnerSource, /isElevenLabsSttTransientError/);
  assert.match(
    activitySource,
    /if \(isElevenLabsSttTransientError\(error\)\) \{[\s\S]*?throw error;[\s\S]*?\}/,
  );
});
