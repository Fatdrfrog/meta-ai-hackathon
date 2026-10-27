import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const source = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "workflows",
    "higgsfield-assets.ts",
  ),
  "utf8",
);

test("Higgsfield asset workflow waits for webhook signals before final storage", () => {
  assert.match(source, /defineSignal/);
  assert.match(source, /HIGGSFIELD_GENERATION_WEBHOOK_SIGNAL/);
  assert.match(source, /condition\(/);
  assert.match(source, /HIGGSFIELD_POLL_STATUS_ACTIVITY/);
  assert.match(source, /higgsfieldPollStatusActivity/);
  assert.match(source, /catch\s*\(\s*pollError\s*\)/);
  assert.match(source, /status_poll_failed/);
  assert.match(source, /function failureMessage/);
  assert.match(source, /cause/);
  assert.match(source, /const startedAt = Date\.now\(\)/);
  assert.match(source, /Date\.now\(\) - startedAt/);
  assert.match(source, /MAX_QUEUED_WEBHOOK_SIGNALS/);
  assert.doesNotMatch(source, /elapsedMs \+= waitMs/);
  assert.match(source, /higgsfieldProcessWebhookActivity/);
  assert.doesNotMatch(source, /downloadAndStoreCreativeAsset/);
});
