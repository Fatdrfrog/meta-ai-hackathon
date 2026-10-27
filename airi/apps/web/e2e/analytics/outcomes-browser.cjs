/* eslint-disable @typescript-eslint/no-require-imports -- Standalone Node CommonJS QA runner. */
// Actual component browser QA; start e2e/analytics/harness/server.mjs first.
const { chromium } = require("@playwright/test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const base = process.env.ANALYTICS_QA_URL || "http://127.0.0.1:3015";
const output =
  process.env.ANALYTICS_QA_OUTPUT ||
  path.resolve("test-results/analytics-outcomes");
const {
  keys,
  at,
  sourceId,
  health,
  counts,
  cohort,
  fixtures,
  requestedWindow,
  responseFixture,
  isExpectedApiResourceError,
} = require("./fixtures.cjs");
function labelsFor(locale) {
  return JSON.parse(
    fs.readFileSync(
      path.resolve(`messages/analytics/${locale}/page.json`),
      "utf8"
    )
  ).AnalyticsOutcomes;
}

const defaultIds = ["acquisition", "attention", "delivery"];
const clone = value => JSON.parse(JSON.stringify(value));
const normalized = value => value.replace(/\s/g, "");
function boardLabelsFor(locale) {
  return JSON.parse(
    fs.readFileSync(path.resolve(`messages/panel/${locale}/page.json`), "utf8")
  ).DashboardClientPage.board;
}
function boardState(ids = defaultIds) {
  return {
    version: 1,
    activeViewId: "starter",
    views: [
      {
        id: "starter",
        name: "Overview",
        templateId: "starter",
        cards: [{ id: "total", width: 1, height: 1 }],
      },
    ],
    outcomes: {
      cards: ids.map(id => ({
        id,
        width: ["attention", "delivery"].includes(id) ? 2 : 4,
        height: 1,
      })),
    },
  };
}
const fullHistory = {
  state: "streaming",
  history: "since_activation",
  firstObservedAt: "2020-01-01T00:00:00Z",
  historyGapAt: null,
  snapshotRecovery: "complete",
  snapshotScanned: 0,
  resumePersistedAt: at,
};
function readyAcquisition(fields = {}) {
  return {
    ...clone(fixtures.acquisition),
    coverage: {
      ...fixtures.acquisition.coverage,
      qualificationHistory: fullHistory,
    },
    cohorts: [{ ...clone(cohort), pendingObservation: 0 }],
    ...fields,
  };
}
function readyDashboard() {
  const value = clone(fixtures.dashboard);
  Object.assign(value.advertisement.metaInsights.topAds[0], {
    destination: "whatsapp",
    destinationUpdatedAt: "2020-01-01T00:00:00Z",
  });
  return value;
}
function report(page, id) {
  return page.locator(`#outcomes-${id}-report`);
}
async function waitReport(page, id) {
  await report(page, id).waitFor();
  await page.waitForFunction(
    id =>
      document
        .getElementById(`outcomes-${id}-report`)
        ?.getAttribute("aria-busy") === "false",
    id
  );
}
async function cards(page) {
  return page
    .locator("[data-card-id]")
    .evaluateAll(rows => rows.map(row => row.dataset.cardId));
}
async function expectCards(page, ids) {
  try {
    await page.waitForFunction(
      ids =>
        JSON.stringify(
          [...document.querySelectorAll("[data-card-id]")].map(
            row => row.dataset.cardId
          )
        ) === JSON.stringify(ids),
      ids
    );
  } catch (failure) {
    await capture(page, "failure-card-order");
    console.error(
      JSON.stringify({
        expected: ids,
        actual: await cards(page),
        buttons: await page.getByRole("button").allTextContents(),
      })
    );
    throw failure;
  }
  assert.deepEqual(await cards(page), ids);
}
async function openDetails(page, id, text) {
  const summary = report(page, id)
    .locator("summary")
    .filter({ hasText: text })
    .first();
  await summary.waitFor();
  if (!(await summary.evaluate(node => node.parentElement.open)))
    await summary.click();
}
async function openAllDetails(page, id) {
  const summaries = report(page, id).locator("summary");
  for (let index = 0; index < (await summaries.count()); index++) {
    const summary = summaries.nth(index);
    if (
      (await summary.isVisible()) &&
      !(await summary.evaluate(node => node.parentElement.open))
    )
      await summary.click();
  }
}
async function columnValue(page, id, label, row = 0, tableIndex = 0) {
  const table = report(page, id)
    .getByRole("table")
    .filter({
      has: page.getByRole("columnheader", { name: label, exact: true }),
    })
    .nth(tableIndex);
  const headers = await table.getByRole("columnheader").allTextContents(),
    column = headers.indexOf(label);
  assert(
    column >= 0,
    `Missing ${id} column ${JSON.stringify(label)} in ${JSON.stringify(headers)}`
  );
  return table
    .locator("tbody tr")
    .nth(row)
    .locator("td")
    .nth(column)
    .innerText();
}
async function assertRatio(page, labels, expected) {
  await waitReport(page, "acquisition");
  await openDetails(page, "acquisition", labels.workspace.entryDetails);
  assert.equal(
    normalized(await columnValue(page, "acquisition", labels.qualifiedToPaid)),
    normalized(expected)
  );
}
async function assertColumnHeaders(page) {
  const tables = page.getByRole("table");
  for (let index = 0; index < (await tables.count()); index++) {
    const table = tables.nth(index);
    if (!(await table.locator("tbody tr").count())) continue;
    const headers = table.locator("thead th");
    assert((await headers.count()) > 0, "Report tables have named headings");
    assert.equal(
      await table.getByRole("columnheader").count(),
      await headers.count(),
      "Every report heading exposes columnheader"
    );
  }
}
async function assertPageHealth(page, errors, name) {
  assert.equal(
    await page.title(),
    "Analytics dashboards QA",
    `${name}: harness identity`
  );
  assert.equal(
    await page.getByRole("navigation").count(),
    1,
    `${name}: exactly one Analytics navigation`
  );
  assert.equal(
    await page.locator("[data-analytics-content]").count(),
    1,
    `${name}: exactly one content shell`
  );
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth + 1
    ),
    false,
    `${name}: page overflow`
  );
  const nestedScrollers = await page.evaluate(() =>
    [...document.querySelectorAll("[data-outcomes-report] *")]
      .filter(node => {
        const style = getComputedStyle(node),
          rect = node.getBoundingClientRect();
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          ["auto", "scroll"].includes(style.overflowY) &&
          node.scrollHeight > node.clientHeight + 2
        );
      })
      .map(node => ({ tag: node.tagName, className: node.className }))
  );
  assert.deepEqual(
    nestedScrollers,
    [],
    `${name}: report cards must grow inside the shell scroller`
  );
  assert.equal(
    await page.locator("svg.lucide").count(),
    0,
    `${name}: icon-free controls`
  );
  assert.equal(
    await page
      .locator("vite-error-overlay, [data-nextjs-dialog-overlay]")
      .count(),
    0,
    `${name}: framework error overlay`
  );
  assert.deepEqual(errors, [], `${name}: console/runtime errors`);
}
async function capture(page, name) {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: path.join(output, `${name}.png`),
    fullPage: true,
    animations: "disabled",
  });
}
async function scenario(browser, options = {}) {
  const {
    width = 1440,
    dark = false,
    locale = "en",
    overrides = {},
    pendingKey,
    failureKey,
    failureRefreshOnly = false,
    readFailures = [],
    putFailures = [],
    initialState = null,
    initialRevision = initialState ? 1 : null,
  } = options;
  const page = await browser.newPage({
    viewport: { width, height: 844 },
    timezoneId: "UTC",
    colorScheme: dark ? "dark" : "light",
  });
  const labels = labelsFor(locale),
    common = boardLabelsFor(locale),
    errors = [],
    requests = [],
    expectedNetworkErrors = [];
  const controls = {
    failing: Boolean(failureKey),
    readFailures: [...readFailures],
    putFailures: [...putFailures],
    state: clone(initialState),
    revision: initialRevision,
    conflictState: boardState(["delivery", "acquisition", "attention"]),
  };
  let release;
  const pending = new Promise(resolve => {
    release = resolve;
  });
  page.setDefaultTimeout(12000);
  page.setDefaultNavigationTimeout(60000);
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => {
    if (message.type() !== "error") return;
    const value = message.text();
    if (isExpectedApiResourceError(value, message.location().url, requests))
      expectedNetworkErrors.push(value);
    else
      errors.push(`${value} (${message.location().url || "unknown resource"})`);
  });
  await page.addInitScript(
    value =>
      document.addEventListener("DOMContentLoaded", () =>
        document.documentElement.classList.toggle("dark", value)
      ),
    dark
  );
  // Every API is intercepted. Unknown endpoints fail QA rather than reach a real service.
  await page.route("**/api/**", async route => {
    const request = route.request(),
      url = new URL(request.url()),
      key = url.pathname.split("/").pop(),
      method = request.method();
    assert(
      [
        "acquisition",
        "chat-leakage",
        "whatsapp",
        "service-lifecycle",
        "policy",
        "dashboard",
        "dashboards",
      ].includes(key),
      `Unexpected API ${method} ${url.href}`
    );
    assert(
      url.pathname === "/api/dashboard" ||
        url.pathname.startsWith("/api/workspaces/qa-workspace/analytics/"),
      `Unexpected workspace API ${url.href}`
    );
    if (key === pendingKey) await pending;
    let status =
        controls.failing &&
        key === failureKey &&
        (!failureRefreshOnly || url.searchParams.get("refresh") === "1")
          ? 503
          : 200,
      json;
    if (key === "dashboards") {
      if (method === "GET") status = controls.readFailures.shift() || 200;
      else {
        assert.equal(method, "PUT");
        const body = request.postDataJSON();
        assert.equal(
          body.revision,
          controls.revision,
          "Save sends the last observed revision"
        );
        assert.equal(body.state.version, 1);
        assert(
          body.state.views.some(view => view.id === body.state.activeViewId)
        );
        const ids = body.state.outcomes.cards.map(card => card.id);
        assert.equal(
          new Set(ids).size,
          ids.length,
          "Saved report IDs are unique"
        );
        assert(
          ids.every(id => keys.includes(id)),
          "Only seven canonical report IDs may be saved"
        );
        status = controls.putFailures.shift() || 200;
        if (status === 409) {
          controls.state = clone(controls.conflictState);
          controls.revision = (controls.revision || 0) + 1;
        } else if (status === 200) {
          controls.state = clone(body.state);
          controls.revision = (controls.revision || 0) + 1;
        }
      }
      json =
        status === 200
          ? { state: clone(controls.state), revision: controls.revision }
          : { error: "preferences_unavailable" };
    } else {
      assert.equal(method, "GET", `Read-only fixture API ${key}`);
      json =
        status === 200
          ? responseFixture(key, url, overrides)
          : { error: "analytics_unavailable" };
    }
    requests.push({
      key,
      method,
      status,
      url: url.href,
      body: method === "PUT" ? request.postDataJSON() : null,
    });
    await route.fulfill({ status, json });
  });
  await page.goto(`${base}/?view=outcomes&locale=${locale}`, {
    waitUntil: "domcontentloaded",
  });
  await page
    .getByRole("heading", { name: labels.title, exact: true })
    .waitFor();
  return {
    page,
    labels,
    common,
    controls,
    errors,
    requests,
    expectedNetworkErrors,
    release,
    recover: () => {
      controls.failing = false;
    },
  };
}
async function waitDefault(test) {
  await expectCards(test.page, defaultIds);
  for (const id of defaultIds) await waitReport(test.page, id);
  await test.page
    .getByRole("button", { name: test.labels.workspace.edit, exact: true })
    .waitFor();
}
async function edit(test) {
  await test.page.waitForFunction(
    label =>
      [...document.querySelectorAll("button")].some(
        button => button.textContent.trim() === label && !button.disabled
      ),
    test.labels.workspace.edit
  );
  await test.page
    .getByRole("button", { name: test.labels.workspace.edit, exact: true })
    .click();
  await test.page
    .getByRole("button", { name: test.labels.workspace.save, exact: true })
    .waitFor();
}
async function addReports(test, ids) {
  await test.page
    .getByRole("button", { name: test.labels.workspace.add, exact: true })
    .click();
  const dialog = test.page.getByRole("dialog", {
    name: test.labels.workspace.libraryTitle,
    exact: true,
  });
  for (const id of ids)
    await dialog
      .getByRole("button", { name: test.labels.tabs[id], exact: true })
      .click();
  await dialog
    .getByRole("button", {
      name: test.labels.workspace.libraryClose,
      exact: true,
    })
    .click();
}
async function settings(test, id) {
  try {
    const expanded = test.page.locator(
      '[data-card-settings][data-state="open"]'
    );
    while (await expanded.count()) await expanded.first().click();
    await test.page.waitForFunction(
      () =>
        document.querySelectorAll('[role="dialog"][data-state]').length === 0
    );
    await test.page
      .locator(`[data-card-id="${id}"] [data-card-settings]`)
      .click();
    await test.page
      .getByRole("dialog", {
        name: `${test.common.cardSettings}: ${test.labels.tabs[id]}`,
        exact: true,
      })
      .waitFor();
  } catch (failure) {
    await capture(test.page, `failure-card-settings-${id}`);
    console.error(
      JSON.stringify({
        cards: await cards(test.page),
        buttons: await test.page.getByRole("button").allTextContents(),
        errors: test.errors,
      })
    );
    throw failure;
  }
}
async function assertKeyboardFocus(page, target) {
  await target.focus();
  await target.press("Tab");
  await page.keyboard.press("Shift+Tab");
  assert.equal(
    await target.evaluate(
      node =>
        node === document.activeElement &&
        node.matches(":focus-visible") &&
        (getComputedStyle(node).boxShadow !== "none" ||
          getComputedStyle(node).outlineStyle !== "none")
    ),
    true,
    "Keyboard focus has a visible ring"
  );
}
async function save(test) {
  const response = test.page.waitForResponse(
    response =>
      response.request().method() === "PUT" &&
      response.url().endsWith("/analytics/dashboards")
  );
  await test.page
    .getByRole("button", { name: test.labels.workspace.save, exact: true })
    .click();
  return (await response).status();
}
async function metricValue(page, id, label) {
  return report(page, id)
    .locator("dt")
    .filter({ hasText: label })
    .first()
    .locator("..")
    .locator("dd")
    .innerText();
}
async function runMatrix(browser) {
  const verified = [];
  for (const locale of ["en", "ru", "kz"])
    for (const width of [1440, 375])
      for (const dark of [false, true]) {
        const name = `${locale}-${width}-${dark ? "dark" : "light"}`,
          test = await scenario(browser, { locale, width, dark });
        try {
          await waitDefault(test);
          assert.equal(
            await report(test.page, "acquisition").getByRole("table").count(),
            0,
            "Financial detail table is closed by default"
          );
          assert.equal(
            await report(test.page, "delivery").getByRole("table").count(),
            0,
            "Delivery tables are closed by default"
          );
          assert.equal(
            await metricValue(test.page, "acquisition", test.labels.entries),
            "5"
          );
          const firstValue = await report(test.page, "acquisition")
            .locator("dd")
            .first()
            .boundingBox();
          assert(
            firstValue && firstValue.y + firstValue.height < 844,
            "Real metric values are above the fold"
          );
          assert.equal(
            test.requests.some(request => request.key === "service-lifecycle"),
            false,
            "Optional service history is fetched only after adding health"
          );
          await assertPageHealth(test.page, test.errors, name);
          await capture(test.page, `outcomes-default-${name}`);
          verified.push(`default/${name}`);
          await edit(test);
          await addReports(test, ["templates", "health", "flows", "retention"]);
          await expectCards(test.page, [
            ...defaultIds,
            "templates",
            "health",
            "flows",
            "retention",
          ]);
          for (const id of keys) {
            await waitReport(test.page, id);
            await openAllDetails(test.page, id);
          }
          await assertRatio(test.page, test.labels, "—");
          await assertColumnHeaders(test.page);
          for (const label of [
            test.labels.read,
            test.labels.uniqueClicked,
            test.labels.costPerDelivered,
          ])
            assert.equal(await columnValue(test.page, "templates", label), "—");
          assert(
            (await report(test.page, "templates")
              .getByText(test.labels.provider.activation_required, {
                exact: false,
              })
              .count()) > 0
          );
          await assertPageHealth(test.page, test.errors, `${name}/expanded`);
          await capture(test.page, `outcomes-expanded-${name}`);
          const before = await cards(test.page);
          assert.equal(await save(test), 200);
          await test.page
            .getByRole("button", {
              name: test.labels.workspace.edit,
              exact: true,
            })
            .waitFor();
          await test.page.reload({ waitUntil: "domcontentloaded" });
          await expectCards(test.page, before);
          for (const id of keys) await waitReport(test.page, id);
          assert.equal(test.controls.revision, 1);
          assert.equal(
            test.requests.filter(request => request.method === "PUT").length,
            1
          );
          await assertPageHealth(test.page, test.errors, `${name}/saved`);
          verified.push(`expanded-saved/${name}`);
          console.log(`Passed workspace matrix: ${name}`);
        } finally {
          test.release();
          await test.page.close();
        }
      }
  return verified;
}
async function runLayoutInteractions(browser) {
  const verified = [];
  for (const { width, dark } of [
    { width: 1440, dark: false },
    { width: 375, dark: true },
  ]) {
    const name = `${width}-${dark ? "dark" : "light"}`,
      test = await scenario(browser, { width, dark });
    try {
      await waitDefault(test);
      await edit(test);
      await settings(test, "acquisition");
      await test.page
        .getByRole("button", { name: test.common.later, exact: true })
        .click();
      await test.page.keyboard.press("Escape");
      await expectCards(test.page, ["attention", "acquisition", "delivery"]);
      const move = test.page.getByRole("button", {
        name: `${test.common.move}: ${test.labels.tabs.attention}`,
        exact: true,
      });
      await move.focus();
      await move.press("Space");
      await test.page
        .getByText(
          test.common.dragStarted.replace("{card}", test.labels.tabs.attention),
          { exact: true }
        )
        .waitFor();
      await move.press("ArrowDown");
      await test.page
        .getByText(
          test.common.dragPosition
            .replace("{card}", test.labels.tabs.attention)
            .replace("{position}", "2"),
          { exact: true }
        )
        .waitFor();
      await move.press("Space");
      await expectCards(test.page, ["acquisition", "attention", "delivery"]);
      await settings(test, "acquisition");
      await test.page
        .getByRole("combobox", { name: test.common.width, exact: true })
        .selectOption("2");
      await test.page
        .getByRole("combobox", { name: test.common.height, exact: true })
        .selectOption("2");
      await test.page.keyboard.press("Escape");
      await capture(test.page, `outcomes-editing-${name}`);
      if (width === 1440) {
        const handle = test.page.getByRole("button", {
          name: `${test.common.move}: ${test.labels.tabs.acquisition}`,
          exact: true,
        });
        await handle.scrollIntoViewIfNeeded();
        const from = await handle.boundingBox(),
          to = await test.page
            .locator('[data-card-id="attention"]')
            .boundingBox();
        assert(from && to);
        await test.page.mouse.move(
          from.x + from.width / 2,
          from.y + from.height / 2
        );
        await test.page.mouse.down();
        await test.page.mouse.move(
          from.x + from.width / 2 + 12,
          from.y + from.height / 2,
          { steps: 3 }
        );
        await test.page.mouse.move(to.x + to.width / 2, to.y + 20, {
          steps: 12,
        });
        await test.page.mouse.up();
        await expectCards(test.page, ["attention", "acquisition", "delivery"]);
        verified.push(`pointer-drag/${name}`);
      }
      await settings(test, "delivery");
      await test.page
        .getByRole("button", { name: test.common.remove, exact: true })
        .click();
      await test.page.keyboard.press("Escape");
      assert.equal((await cards(test.page)).includes("delivery"), false);
      await addReports(test, ["templates"]);
      const savedIds = await cards(test.page);
      assert.equal(await save(test), 200);
      assert.deepEqual(
        test.controls.state.outcomes.cards.find(
          card => card.id === "acquisition"
        ),
        { id: "acquisition", width: 2, height: 2 }
      );
      await test.page.reload({ waitUntil: "domcontentloaded" });
      await expectCards(test.page, savedIds);
      await edit(test);
      await settings(test, "acquisition");
      await test.page
        .getByRole("button", { name: test.common.remove, exact: true })
        .click();
      await test.page.keyboard.press("Escape");
      await test.page
        .getByRole("button", {
          name: test.labels.workspace.cancel,
          exact: true,
        })
        .click();
      await expectCards(test.page, savedIds);
      assert.equal(
        test.requests.filter(request => request.method === "PUT").length,
        1,
        "Cancel never writes preferences"
      );
      await assertPageHealth(
        test.page,
        test.errors,
        `${name}/layout-interactions`
      );
      await capture(test.page, `outcomes-layout-${name}`);
      verified.push(
        `buttons-keyboard-resize-hide-add-save-reload-cancel/${name}`
      );
    } finally {
      test.release();
      await test.page.close();
    }
  }
  return verified;
}
async function runPreferenceFailures(browser) {
  const verified = [],
    test = await scenario(browser, { readFailures: [503] });
  try {
    await waitDefault(test);
    await test.page
      .getByRole("alert")
      .filter({ hasText: test.common.loadFailed })
      .waitFor();
    assert.equal(
      await test.page
        .getByRole("button", { name: test.labels.workspace.edit, exact: true })
        .isDisabled(),
      true
    );
    assert.equal(
      await metricValue(test.page, "acquisition", test.labels.entries),
      "5",
      "Default reports remain readable after preference failure"
    );
    assert.equal(
      test.requests.some(request => request.method === "PUT"),
      false
    );
    await test.page
      .getByRole("button", { name: test.common.retry, exact: true })
      .click();
    await edit(test);
    await settings(test, "delivery");
    await test.page
      .getByRole("button", { name: test.common.remove, exact: true })
      .click();
    await test.page.keyboard.press("Escape");
    test.controls.putFailures.push(503);
    assert.equal(await save(test), 503);
    await test.page
      .getByRole("alert")
      .filter({ hasText: test.common.saveFailed })
      .waitFor();
    await expectCards(test.page, ["acquisition", "attention"]);
    assert.equal(await save(test), 200);
    await test.page
      .getByRole("button", { name: test.labels.workspace.edit, exact: true })
      .waitFor();
    verified.push("preference-read-and-save-failure-retry");
    await edit(test);
    await addReports(test, ["templates"]);
    const draftIds = await cards(test.page);
    test.controls.putFailures.push(409);
    assert.equal(await save(test), 409);
    await test.page
      .getByRole("alert")
      .filter({ hasText: test.common.conflict })
      .waitFor();
    assert.equal(
      await test.page
        .getByRole("button", { name: test.labels.workspace.save, exact: true })
        .isDisabled(),
      true
    );
    test.controls.readFailures.push(500);
    await test.page
      .getByRole("button", { name: test.common.reload, exact: true })
      .click();
    await test.page
      .getByRole("alert")
      .filter({ hasText: test.common.reloadFailed })
      .waitFor();
    await expectCards(test.page, draftIds);
    assert.equal(
      await test.page
        .getByRole("button", { name: test.labels.workspace.save, exact: true })
        .isDisabled(),
      true,
      "Failed reload preserves the conflict fence"
    );
    await test.page
      .getByRole("button", { name: test.common.reload, exact: true })
      .click();
    await expectCards(test.page, ["delivery", "acquisition", "attention"]);
    await test.page
      .getByRole("button", { name: test.labels.workspace.edit, exact: true })
      .waitFor();
    assert.equal(
      test.requests.filter(
        request => request.method === "PUT" && request.status === 409
      ).length,
      1
    );
    await assertPageHealth(
      test.page,
      test.errors,
      "preference-conflict-reload"
    );
    await capture(test.page, "outcomes-preference-conflict-recovered");
    verified.push(
      "conflict-keeps-draft-failed-reload-keeps-fence-successful-reload-restores-saved"
    );
  } finally {
    test.release();
    await test.page.close();
  }
  return verified;
}
async function runNumericalEdges(browser) {
  const verified = [];
  for (const { width, dark } of [
    { width: 1440, dark: false },
    { width: 375, dark: true },
  ]) {
    const name = `${width}-${dark ? "dark" : "light"}`;
    const check = async (label, options, action) => {
      const test = await scenario(browser, { width, dark, ...options });
      try {
        await action(test);
        await assertPageHealth(test.page, test.errors, `${label}/${name}`);
        await capture(test.page, `outcomes-${label}-${name}`);
        verified.push(`${label}/${name}`);
      } finally {
        test.release();
        await test.page.close();
      }
    };
    await check("loading", { pendingKey: "acquisition" }, async test => {
      await report(test.page, "acquisition")
        .locator(".animate-pulse")
        .first()
        .waitFor();
      assert.equal(
        await report(test.page, "acquisition").getAttribute("aria-busy"),
        "true"
      );
      assert.equal(
        await report(test.page, "acquisition").getByRole("table").count(),
        0
      );
      test.release();
      await waitReport(test.page, "acquisition");
      await assertRatio(test.page, test.labels, "—");
    });
    await check(
      "empty",
      {
        initialState: boardState(keys),
        overrides: {
          acquisition: readyAcquisition({
            cohorts: [],
            flows: [],
            retention: [],
            retentionMissingIdentity: 0,
          }),
          "chat-leakage": {
            ...fixtures["chat-leakage"],
            counts: Object.fromEntries(
              Object.keys(counts).map(key => [key, 0])
            ),
            groups: [],
            audience: [],
            audienceTotal: 0,
            audienceTruncated: false,
          },
        },
      },
      async test => {
        for (const id of keys) await waitReport(test.page, id);
        assert.equal(
          await metricValue(test.page, "acquisition", test.labels.entries),
          "0"
        );
        await openDetails(
          test.page,
          "acquisition",
          test.labels.workspace.entryDetails
        );
        await openDetails(
          test.page,
          "attention",
          test.labels.workspace.leadDetails
        );
        await report(test.page, "acquisition")
          .getByRole("heading", { name: test.labels.empty, exact: true })
          .waitFor();
        await report(test.page, "attention")
          .getByRole("heading", {
            name: test.labels.emptyAttention,
            exact: true,
          })
          .waitFor();
        for (const id of ["flows", "retention"])
          await report(test.page, id)
            .getByRole("heading", { name: test.labels.empty, exact: true })
            .waitFor();
      }
    );
    await check(
      "report-error-retry",
      { failureKey: "acquisition" },
      async test => {
        await report(test.page, "acquisition").getByRole("alert").waitFor();
        test.recover();
        const retry = report(test.page, "acquisition").getByRole("button", {
          name: test.labels.refresh,
          exact: true,
        });
        await assertKeyboardFocus(test.page, retry);
        await retry.press("Enter");
        await waitReport(test.page, "acquisition");
        await assertRatio(test.page, test.labels, "—");
        await openDetails(
          test.page,
          "attention",
          test.labels.workspace.leadDetails
        );
        assert.equal(
          await report(test.page, "acquisition").getByRole("alert").count(),
          0
        );
        assert(
          test.requests.some(
            request => request.key === "acquisition" && request.status === 503
          )
        );
      }
    );
    await check(
      "partial-observed-counts",
      {
        initialState: boardState(keys),
        overrides: {
          acquisition: {
            ...readyAcquisition(),
            coverage: {
              ...fixtures.acquisition.coverage,
              status: "backfilling",
              truncated: true,
            },
            cohorts: [
              {
                ...cohort,
                engaged: 0,
                qualified: 0,
                qualifiedPaid: 0,
                booked: 0,
                pendingObservation: 0,
              },
            ],
          },
          "chat-leakage": {
            ...fixtures["chat-leakage"],
            status: "partial",
            truncated: true,
            groups: fixtures["chat-leakage"].groups.map(group => ({
              ...group,
              counts: { ...group.counts, stalled: 0 },
            })),
            audience: [],
            audienceTotal: 2,
            audienceTruncated: true,
          },
          whatsapp: {
            ...fixtures.whatsapp,
            limitations: {
              ...fixtures.whatsapp.limitations,
              sourcesTruncated: true,
              providerAccountsTruncated: true,
            },
          },
          "service-lifecycle": {
            ...fixtures["service-lifecycle"],
            groupsTruncated: true,
          },
        },
      },
      async test => {
        for (const id of keys) await waitReport(test.page, id);
        assert.equal(
          await metricValue(test.page, "acquisition", test.labels.entries),
          "5"
        );
        for (const label of [
          test.labels.engaged,
          test.labels.qualified,
          test.labels.booked,
          test.labels.pending,
        ])
          assert.equal(await metricValue(test.page, "acquisition", label), "—");
        await assertRatio(test.page, test.labels, "—");
        await openDetails(
          test.page,
          "attention",
          test.labels.workspace.leadDetails
        );
        assert.equal(
          await columnValue(test.page, "attention", test.labels.needsReply),
          String(counts.needsReply),
          "Recorded positive lead-group counts stay visible under partial coverage"
        );
        assert.equal(
          await columnValue(test.page, "attention", test.labels.stalled),
          "—",
          "Partial lead-group zero counts remain unknown"
        );
        await report(test.page, "attention")
          .getByRole("heading", {
            name: test.labels.workspace.audienceUnavailable,
            exact: true,
          })
          .waitFor();
        assert.equal(
          await report(test.page, "attention")
            .getByText(test.labels.emptyAttention, { exact: true })
            .count(),
          0
        );
        for (const id of ["acquisition", "attention", "delivery", "health"])
          assert(
            (await report(test.page, id)
              .getByRole("status")
              .filter({ hasText: test.labels.truncated })
              .count()) > 0
          );
        await openAllDetails(test.page, "health");
        assert(
          (await report(test.page, "health")
            .getByText(test.labels.lifecycleState.history_gap, { exact: false })
            .count()) > 0
        );
      }
    );
    await check(
      "mature-comparable-and-filtered",
      {
        overrides: {
          acquisition: readyAcquisition(),
          dashboard: readyDashboard(),
          policy: { ...fixtures.policy, canEdit: true },
        },
      },
      async test => {
        await waitDefault(test);
        await assertRatio(test.page, test.labels, "50%");
        assert.equal(
          normalized(
            await columnValue(
              test.page,
              "acquisition",
              test.labels.costQualified
            )
          ),
          normalized(
            new Intl.NumberFormat("en", {
              style: "currency",
              currency: "USD",
            }).format(25)
          )
        );
        assert.equal(
          normalized(
            await columnValue(test.page, "acquisition", test.labels.roas)
          ),
          "1.4×"
        );
        const observation = test.labels.workspace.observation.replace(
          "{days}",
          "30"
        );
        await test.page
          .locator("summary")
          .filter({ hasText: observation })
          .click();
        const toggle = test.page.getByRole("checkbox", {
          name: test.labels.matureCohorts,
          exact: true,
        });
        await assertKeyboardFocus(
          test.page,
          test.page.getByRole("combobox", {
            name: test.labels.observation,
            exact: true,
          })
        );
        await assertKeyboardFocus(test.page, toggle);
        await toggle.check();
        await waitReport(test.page, "acquisition");
        assert.notEqual(
          await toggle.evaluate(input => getComputedStyle(input).accentColor),
          "auto"
        );
        const request = test.requests
            .filter(request => request.key === "acquisition")
            .at(-1),
          range = requestedWindow(new URL(request.url));
        assert(
          Date.parse(range.end) <= Date.now() - 30 * 86400000,
          "Mature dates finish the observation horizon"
        );
        assert(
          test.requests.some(
            request =>
              request.key === "dashboard" &&
              requestedWindow(new URL(request.url)).from === range.from &&
              requestedWindow(new URL(request.url)).to === range.to
          )
        );
        await test.page
          .getByRole("combobox", { name: test.labels.source, exact: true })
          .selectOption(sourceId);
        await waitReport(test.page, "acquisition");
        await assertRatio(test.page, test.labels, "50%");
        assert.equal(
          await columnValue(
            test.page,
            "acquisition",
            test.labels.costQualified
          ),
          "—",
          "Phone scope cannot inherit account ad efficiency"
        );
        await test.page
          .getByRole("combobox", {
            name: test.labels.workspace.period,
            exact: true,
          })
          .selectOption("7");
        await waitReport(test.page, "acquisition");
        assert.equal(
          new URL(
            test.requests
              .filter(request => request.key === "acquisition")
              .at(-1).url
          ).searchParams.get("days"),
          "7"
        );
        assert.equal(
          await test.page
            .getByRole("combobox", { name: test.labels.source, exact: true })
            .evaluate(select => select.selectedOptions[0].textContent),
          health.sourceName,
          "Changing period preserves the selected source label"
        );
        await openDetails(
          test.page,
          "acquisition",
          test.labels.workspace.measurement
        );
        await openDetails(test.page, "acquisition", test.labels.qualification);
        await assertKeyboardFocus(
          test.page,
          report(test.page, "acquisition").getByRole("checkbox", {
            name: "Qualified",
            exact: true,
          })
        );
      }
    );
    await check(
      "null-values-and-currencies",
      {
        initialState: boardState(keys),
        overrides: {
          acquisition: readyAcquisition({
            cohorts: [
              {
                ...cohort,
                pendingObservation: 0,
                currencies: [
                  {
                    ...cohort.currencies[0],
                    netRevenue: null,
                    grossRevenue: null,
                    unknownValues: 1,
                  },
                  { ...cohort.currencies[0], currency: "KZT", netRevenue: 200 },
                ],
              },
            ],
          }),
          whatsapp: {
            ...fixtures.whatsapp,
            delivery: {
              ...fixtures.whatsapp.delivery,
              medianDeliverySeconds: null,
              p95DeliverySeconds: null,
            },
          },
        },
      },
      async test => {
        for (const id of keys) {
          await waitReport(test.page, id);
          await openAllDetails(test.page, id);
        }
        assert.equal(
          await columnValue(test.page, "acquisition", test.labels.netRevenue),
          "—"
        );
        assert.equal(
          await report(test.page, "acquisition")
            .locator("dt")
            .filter({ hasText: test.labels.netRevenue })
            .count(),
          2,
          "Currencies have separate revenue summaries"
        );
        for (const label of [
          test.labels.read,
          test.labels.uniqueClicked,
          test.labels.costPerDelivered,
        ])
          assert.equal(await columnValue(test.page, "templates", label), "—");
        for (const label of [test.labels.medianSeconds, test.labels.p95Seconds])
          assert.equal(await columnValue(test.page, "delivery", label), "—");
        await assertColumnHeaders(test.page);
      }
    );
    await check(
      "provider-missing",
      {
        initialState: boardState(keys),
        overrides: {
          whatsapp: {
            ...fixtures.whatsapp,
            health: [],
            templates: [],
            templateLifecycle: [],
          },
        },
      },
      async test => {
        for (const id of ["templates", "health"]) {
          await waitReport(test.page, id);
          await report(test.page, id)
            .getByRole("heading", {
              name: test.labels.provider.not_connected,
              exact: true,
            })
            .waitFor();
        }
      }
    );
    await check(
      "provider-disconnected",
      {
        initialState: boardState(keys),
        overrides: {
          whatsapp: {
            ...fixtures.whatsapp,
            health: [
              {
                ...health,
                accountStatus: "disconnected",
                webhookStatus: "unknown",
                verificationFreshness: "unknown",
                lastVerifiedAt: null,
                history: [],
              },
            ],
            templates: [
              {
                ...fixtures.whatsapp.templates[0],
                templateStatus: "not_connected",
                fetchedAt: null,
                templates: [],
              },
            ],
          },
        },
      },
      async test => {
        for (const id of ["templates", "health"]) {
          await waitReport(test.page, id);
          await openAllDetails(test.page, id);
        }
        await report(test.page, "health")
          .getByRole("cell", {
            name: test.labels.accountHealth.disconnected,
            exact: true,
          })
          .waitFor();
        assert(
          (await report(test.page, "templates")
            .getByText(test.labels.provider.not_connected, { exact: false })
            .count()) > 0
        );
      }
    );
    await check(
      "provider-refresh-failure-isolation",
      {
        initialState: boardState([...defaultIds, "health"]),
        failureKey: "whatsapp",
        failureRefreshOnly: true,
      },
      async test => {
        for (const id of [...defaultIds, "health"])
          await waitReport(test.page, id);
        assert.equal(
          await test.page.locator("[data-card-settings]").count(),
          0
        );
        const knownMetrics = [
          ["acquisition", test.labels.entries, String(cohort.entries)],
          ["attention", test.labels.needsReply, String(counts.needsReply)],
          [
            "delivery",
            test.labels.accepted,
            String(fixtures.whatsapp.delivery.accepted),
          ],
        ];
        const assertKnownMetrics = async stage => {
          for (const [id, label, expected] of knownMetrics)
            assert.equal(
              await metricValue(test.page, id, label),
              expected,
              `${id} stays readable ${stage}`
            );
        };
        await assertKnownMetrics("before refresh");
        assert.equal(await test.page.getByRole("alert").count(), 0);
        const previous = test.requests
          .filter(request => request.key === "service-lifecycle")
          .at(-1);
        assert(previous, "Service history is loaded before refresh");
        const end = Date.parse(new URL(previous.url).searchParams.get("end"));
        const before = test.requests.length;
        const refresh = test.page.getByRole("button", {
          name: test.labels.refresh,
          exact: true,
        });
        await Promise.all([
          ...["acquisition", "chat-leakage", "dashboard"].map(key =>
            test.page.waitForResponse(
              response =>
                new URL(response.url()).pathname.endsWith(`/${key}`) &&
                response.status() === 200
            )
          ),
          test.page.waitForResponse(response => {
            const url = new URL(response.url());
            return (
              url.pathname.endsWith("/whatsapp") &&
              url.searchParams.get("refresh") === "1" &&
              response.status() === 503
            );
          }),
          test.page.waitForResponse(response => {
            const url = new URL(response.url());
            return (
              url.pathname.endsWith("/service-lifecycle") &&
              Date.parse(url.searchParams.get("end")) > end
            );
          }),
          refresh.click(),
        ]);
        const refreshed = test.requests.slice(before);
        for (const key of ["acquisition", "chat-leakage", "dashboard"])
          assert(
            refreshed.some(
              request => request.key === key && request.status === 200
            ),
            `${key} refresh continues after the provider failure`
          );
        const alert = test.page.getByRole("alert").filter({
          hasText: test.labels.workspace.refreshFailed,
        });
        await alert.waitFor();
        await refresh.waitFor();
        assert.equal(await refresh.isEnabled(), true, "Refresh remains usable");
        await assertKnownMetrics("after the provider refresh failure");
        await capture(
          test.page,
          `outcomes-provider-refresh-isolation-failed-${name}`
        );
        test.recover();
        await Promise.all([
          test.page.waitForResponse(response => {
            const url = new URL(response.url());
            return (
              url.pathname.endsWith("/whatsapp") &&
              url.searchParams.get("refresh") === "1" &&
              response.status() === 200
            );
          }),
          refresh.click(),
        ]);
        await refresh.waitFor();
        assert.equal(await refresh.isEnabled(), true);
        await alert.waitFor({ state: "hidden" });
        for (const id of [...defaultIds, "health"])
          await waitReport(test.page, id);
        await assertKnownMetrics("after recovery");
      }
    );
    await check(
      "null-segment-and-service-refresh",
      { initialState: boardState(keys) },
      async test => {
        for (const id of keys) {
          await waitReport(test.page, id);
          await openAllDetails(test.page, id);
        }
        await report(test.page, "attention")
          .getByRole("button", { name: test.labels.viewSegment, exact: true })
          .click();
        await waitReport(test.page, "attention");
        assert(
          test.requests.some(
            request =>
              request.key === "chat-leakage" &&
              new URL(request.url).searchParams.get("sourceIds") ===
                "__none__" &&
              new URL(request.url).searchParams.get("ownerIds") ===
                "__none__" &&
              new URL(request.url).searchParams.get("adIds") === "ad1"
          )
        );
        await test.page
          .getByRole("combobox", { name: test.labels.source, exact: true })
          .selectOption(sourceId);
        await waitReport(test.page, "health");
        const previous = test.requests
          .filter(
            request =>
              request.key === "service-lifecycle" &&
              new URL(request.url).searchParams.get("sourceId") === sourceId
          )
          .at(-1);
        assert(previous, "Source selection scopes service history");
        const end = Date.parse(new URL(previous.url).searchParams.get("end"));
        await Promise.all([
          test.page.waitForResponse(response => {
            const url = new URL(response.url());
            return (
              url.pathname.endsWith("/service-lifecycle") &&
              Date.parse(url.searchParams.get("end")) > end
            );
          }),
          test.page
            .getByRole("button", { name: test.labels.refresh, exact: true })
            .first()
            .click(),
        ]);
        assert(
          test.requests.some(
            request =>
              request.key === "whatsapp" &&
              new URL(request.url).searchParams.get("refresh") === "1"
          )
        );
        const selectedAttention = test.requests
          .filter(request => request.key === "chat-leakage")
          .at(-1);
        assert.equal(
          new URL(selectedAttention.url).searchParams.has("adIds"),
          false,
          "Changing source clears the previous null segment"
        );
        await test.page
          .getByRole("combobox", { name: test.labels.source, exact: true })
          .selectOption("");
        await waitReport(test.page, "attention");
        assert.equal(
          await report(test.page, "attention")
            .getByRole("button", {
              name: test.labels.clearSegment,
              exact: true,
            })
            .count(),
          0,
          "Returning to All sources does not restore an old drilled segment"
        );
      }
    );
  }
  return verified;
}
async function main() {
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  try {
    if (process.env.ANALYTICS_QA_DEMO_CHECK === "1") {
      const page = await browser.newPage({
        viewport: { width: 1440, height: 844 },
        timezoneId: "Asia/Qyzylorda",
      });
      const errors = [];
      page.on("pageerror", failure => errors.push(failure.message));
      page.on("console", message => {
        if (message.type() === "error") errors.push(message.text());
      });
      try {
        await page.goto(`${base}/?view=outcomes&locale=en`, {
          waitUntil: "domcontentloaded",
          timeout: 60000,
        });
        for (const id of defaultIds) await waitReport(page, id);
        await expectCards(page, defaultIds);
        assert.equal(
          await metricValue(page, "acquisition", labelsFor("en").entries),
          "5"
        );
        await assertPageHealth(page, errors, "direct-demo-no-interception");
        await capture(page, "outcomes-direct-demo-en-1440");
        console.log(`Direct fixture demo passed: ${base}`);
      } finally {
        await page.close();
      }
      return;
    }
    for (const width of [1440, 375]) {
      const test = await scenario(browser, { width });
      try {
        await waitDefault(test);
        await assertPageHealth(test.page, test.errors, `preview/${width}`);
        await capture(test.page, `outcomes-preview-en-${width}`);
        console.log(
          `Preview ready: ${path.join(output, `outcomes-preview-en-${width}.png`)}`
        );
      } finally {
        test.release();
        await test.page.close();
      }
    }
    if (process.env.ANALYTICS_QA_PREVIEW === "1") return;
    const group = process.env.ANALYTICS_QA_GROUP || "all";
    const groups = {
      matrix: runMatrix,
      layout: runLayoutInteractions,
      preferences: runPreferenceFailures,
      edges: runNumericalEdges,
    };
    assert(
      group === "all" || Object.hasOwn(groups, group),
      `Unknown QA group ${group}`
    );
    const checks = [];
    for (const [name, run] of Object.entries(groups))
      if (group === "all" || group === name)
        checks.push(...(await run(browser)));
    const result = {
      status: "passed",
      group,
      checks: checks.length,
      states: checks,
      generatedAt: new Date().toISOString(),
      base,
      dataSource:
        "Mocked API responses; actual production components in the local render harness",
      structuralRouteProof:
        "src/features/panel/analytics/route-composition.test.tsx",
      widths: [1440, 375],
      locales: ["en", "ru", "kz"],
      themes: ["light", "dark"],
      output,
    };
    fs.writeFileSync(
      path.join(
        output,
        group === "all" ? "results.json" : `results-${group}.json`
      ),
      JSON.stringify(result, null, 2)
    );
    console.log(JSON.stringify(result));
  } finally {
    await browser.close();
  }
}
main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
