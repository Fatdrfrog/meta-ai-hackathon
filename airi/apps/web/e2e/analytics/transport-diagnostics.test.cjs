/* eslint-disable @typescript-eslint/no-require-imports -- Matches the existing Node-only QA transport. */
const assert = require("node:assert/strict");
const test = require("node:test");
const {
  dashboardFixtureKey,
  fixtures,
  isExpectedApiResourceError,
  responseFixture,
} = require("./fixtures.cjs");

const providerUrl =
  "http://127.0.0.1:3021/api/workspaces/qa-workspace/analytics/whatsapp?days=30&refresh=1";
const injected = [{ url: providerUrl, status: 503 }];
const resourceError = status =>
  `Failed to load resource: the server responded with a status of ${status} (Injected error)`;

test("only the injected URL and HTTP status count as an expected resource error", () => {
  assert.equal(
    isExpectedApiResourceError(resourceError(503), providerUrl, injected),
    true
  );
  assert.equal(
    isExpectedApiResourceError(resourceError(404), providerUrl, injected),
    false
  );
  assert.equal(
    isExpectedApiResourceError(
      resourceError(503),
      providerUrl.replace("refresh=1", "refresh=0"),
      injected
    ),
    false
  );
});

test("an expected provider 503 cannot mask an unrelated resource 404 or 503", () => {
  const assetUrl = "http://127.0.0.1:3021/native-fonts/missing.woff2";
  for (const status of [404, 503]) {
    const errors = [];
    if (!isExpectedApiResourceError(resourceError(status), assetUrl, injected))
      errors.push(resourceError(status));
    assert.throws(() => assert.deepEqual(errors, []), assert.AssertionError);
  }
});

test("unknown URL and ordinary console errors remain unexpected", () => {
  assert.equal(
    isExpectedApiResourceError(resourceError(503), "", injected),
    false
  );
  assert.equal(
    isExpectedApiResourceError(
      "Application failed with 503",
      providerUrl,
      injected
    ),
    false
  );
  assert.equal(
    isExpectedApiResourceError(resourceError(503), providerUrl, []),
    false
  );
});

test("injected preference 409 and 500 match only their own request", () => {
  const preferences =
    "http://127.0.0.1:3021/api/workspaces/qa-workspace/analytics/dashboards";
  for (const status of [409, 500])
    assert.equal(
      isExpectedApiResourceError(resourceError(status), preferences, [
        { url: preferences, status },
      ]),
      true
    );
});

for (const [query, expected] of [
  ["", 30],
  ["&observationDays=", 30],
  ["&observationDays=7", 7],
  ["&observationDays=30", 30],
]) {
  test(`acquisition fixture observationDays ${query || "omitted"} returns ${expected}`, () => {
    const url = new URL(
      `http://127.0.0.1:3021/api/workspaces/qa-workspace/analytics/acquisition?from=2026-10-01&to=2026-10-02&timeZone=UTC${query}`
    );
    assert.equal(
      responseFixture("acquisition", url).window.observationDays,
      expected
    );
  });
}

test("the dashboard API fixture follows the requesting view", () => {
  const base = "http://127.0.0.1:3021/api/dashboard?workspaceId=qa-workspace";
  assert.equal(
    dashboardFixtureKey(new URL(`${base}&timezone=UTC&period=30`)),
    "dashboardOverview"
  );
  assert.equal(
    dashboardFixtureKey(
      new URL(`${base}&from=2026-10-01&to=2026-10-02&timezone=UTC`)
    ),
    "dashboard"
  );
});

test("the Dashboards fixture fills every board card and a recommendation", () => {
  const overview = responseFixture(
    "dashboardOverview",
    new URL("http://127.0.0.1:3021/api/dashboard?period=30")
  );
  assert.deepEqual(overview.stats.map(stat => stat.id).sort(), [
    "csat",
    "first_response",
    "in_progress",
    "new",
    "repeat",
    "resolved",
    "sla",
    "total",
    "ttr",
  ]);
  assert.equal(overview.dailySeries.current.length, 30);
  assert.ok(overview.topCategories.length > 0);
  assert.ok(overview.managerPerformance.length > 0);
  assert.ok(overview.conversationActivityByTime.some(row => row.count > 0));
  assert.equal(fixtures.bulk.summary.totalAccepted > 0, true);
  assert.equal(fixtures.llm.warehouse.overview.trace_count > 0, true);
  assert.deepEqual(Object.keys(fixtures.recommendation).sort(), [
    "reason",
    "templateId",
  ]);
});
