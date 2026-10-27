import assert from "node:assert/strict";
import { test } from "node:test";
import { resolvePostActionQuietPeriodDueAt } from "./scenario-post-action-conditions";

test("quiet-period deadlines start at the wait and move after later conversation activity", () => {
  const waitStartedAt = new Date("2026-09-20T10:00:00Z");
  assert.equal(
    resolvePostActionQuietPeriodDueAt({
      waitStartedAt,
      timeoutMinutes: 10,
    }).toISOString(),
    "2026-09-20T10:10:00.000Z",
  );
  assert.equal(
    resolvePostActionQuietPeriodDueAt({
      waitStartedAt,
      latestActivityAt: new Date("2026-09-20T10:05:00Z"),
      timeoutMinutes: 10,
    }).toISOString(),
    "2026-09-20T10:15:00.000Z",
  );
  assert.equal(
    resolvePostActionQuietPeriodDueAt({
      waitStartedAt,
      latestActivityAt: null,
      timeoutMinutes: 10,
    }).toISOString(),
    "2026-09-20T10:10:00.000Z",
  );
  assert.equal(
    resolvePostActionQuietPeriodDueAt({
      waitStartedAt,
      latestActivityAt: new Date("2026-09-20T09:00:00Z"),
      timeoutMinutes: 10,
    }).toISOString(),
    "2026-09-20T10:10:00.000Z",
  );
  assert.equal(waitStartedAt.toISOString(), "2026-09-20T10:00:00.000Z");
});
