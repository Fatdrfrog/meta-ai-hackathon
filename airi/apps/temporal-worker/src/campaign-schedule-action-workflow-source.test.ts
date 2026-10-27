import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const source = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "workflows",
    "campaign-schedule-action.ts",
  ),
  "utf8",
);
const activitySource = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "activities",
    "campaign-schedule-action.ts",
  ),
  "utf8",
);

test("campaign schedule action workflow propagates exact scheduled occurrence", () => {
  assert.match(source, /workflowInfo\(\)/);
  assert.match(source, /TEMPORAL_SCHEDULED_START_TIME_SEARCH_ATTRIBUTE/);
  assert.match(source, /info\.searchAttributes/);
  assert.match(
    source,
    /actionRunStartedAt:\s*info\.runStartTime\.toISOString\(\)/,
  );
  assert.match(
    source,
    /actionFirstExecutionRunId:\s*info\.firstExecutionRunId/,
  );
  assert.match(source, /buildCampaignNodeScheduledOccurrenceWorkflowId/);
  assert.match(source, /scheduledFor:\s*claim\.scheduledFor/);
  assert.match(source, /CAMPAIGN_SCHEDULE_ACTION_COMPLETE_ACTIVITY/);
});

test("campaign schedule action resolver refuses workflow-id-only matches", () => {
  assert.match(activitySource, /if \(scheduledFor\)/);
  assert.match(
    activitySource,
    /normalizeDate\(input\.actionRunStartedAt\) \|\| new Date\(\)/,
  );
  assert.match(
    activitySource,
    /firstExecutionRunId === input\.actionFirstExecutionRunId/,
  );
  assert.doesNotMatch(
    activitySource,
    /workflow\.workflowId === input\.actionWorkflowId/,
  );
});
