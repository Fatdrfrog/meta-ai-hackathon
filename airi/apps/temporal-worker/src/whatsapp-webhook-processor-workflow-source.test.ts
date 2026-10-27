import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const source = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "workflows",
    "whatsapp-webhook-processor.ts",
  ),
  "utf8",
);

test("keeps processing later webhook signals after an event exhausts retries", () => {
  assert.match(
    source,
    /try\s*{[\s\S]*?await processEventActivity\(event\);[\s\S]*?}\s*catch\s*\(error\)\s*{[\s\S]*?seen\.delete\(event\.eventId\);[\s\S]*?log\.warn/,
  );
});

test("continues as new only after the queued webhook batch is drained", () => {
  const loopBody = source.match(
    /while\s*\(\s*queue\.length\s*>\s*0\s*\)\s*{([\s\S]*?)\r?\n    }\r?\n\r?\n    if\s*\(\s*processedThisRun\s*>=\s*MAX_EVENTS_PER_RUN\s*\)/,
  )?.[1];

  assert.ok(loopBody, "webhook processor queue loop is present");
  assert.doesNotMatch(loopBody, /continueAsNew/);
  assert.doesNotMatch(source, /processedCount\s*%\s*MAX_EVENTS_PER_RUN/);
});

test("uses auto-upgrade worker versioning so deploys do not strand active webhook processors", () => {
  assert.match(
    source,
    /setWorkflowOptions\(\s*\{\s*versioningBehavior:\s*"AUTO_UPGRADE"\s*\},\s*whatsappWebhookProcessorWorkflow\s*,?\s*\)/,
  );
  assert.doesNotMatch(
    source,
    /setWorkflowOptions\(\s*\{\s*versioningBehavior:\s*"PINNED"\s*\},\s*whatsappWebhookProcessorWorkflow\s*,?\s*\)/,
  );
});

test("sets a schedule-to-close timeout so activity tasks cannot block the webhook queue forever", () => {
  assert.match(source, /scheduleToCloseTimeout:\s*"10 minutes"/);
});
