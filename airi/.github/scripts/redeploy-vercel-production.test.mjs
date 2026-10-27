import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createApiRequest, redeployVercelProduction } from "./redeploy-vercel-production.mjs";

const sha = "a".repeat(40);
const env = {
  VERCEL_TOKEN: "private-vercel-token",
  GITHUB_TOKEN: "private-github-token",
  GITHUB_REPOSITORY: "owner/repo",
  VERCEL_REDEPLOY_ID: "dpl_old",
  VERCEL_REDEPLOY_EXPECTED_SHA: sha,
  VERCEL_PROJECT_ID: "prj_web",
  VERCEL_TEAM_ID: "team_production",
};
const release = {
  id: "dpl_old",
  projectId: "prj_web",
  target: "production",
  readyState: "ERROR",
  meta: {
    githubCommitRef: "main",
    githubCommitSha: sha,
    githubCommitOrg: "owner",
    githubCommitRepo: "repo",
  },
};

function fixture({ source = release, mainSha = sha, mainShas = [], finalState = "READY", buildStates = [],
  project = {}, staged = {}, promoted = {}, promotionStatus = 202, currentProductionId = "dpl_new", failure } = {}) {
  const calls = [];
  let mainReads = 0;
  let buildReads = 0;
  let promotionRequested = false;
  const fetchImpl = async (url, init) => {
    calls.push({ url, ...init });
    if (failure) return failure;
    const path = new URL(url).pathname;
    let value;
    if (path === "/v9/projects/prj_web") value = {
      id: "prj_web", name: "web", accountId: "team_production",
      targets: { production: { id: promotionRequested ? currentProductionId : "dpl_old" } }, ...project,
    };
    else if (path === "/v13/deployments/dpl_old") value = source;
    else if (path === "/repos/owner/repo/git/ref/heads/main") value = { object: { sha: mainShas[mainReads++] ?? mainSha } };
    else if (path === "/v13/deployments" && init.method === "POST") value = { id: "dpl_new" };
    else if (path === "/v13/deployments/dpl_new") value = {
      ...release, id: "dpl_new", readyState: promotionRequested ? finalState : (buildStates[buildReads++] ?? finalState),
      url: "web.vercel.app", autoAssignCustomDomains: false,
      // Staged deployments may already have automatic aliases. Production
      // success additionally requires the project's current production target.
      aliasAssigned: true, ...(promotionRequested ? promoted : staged),
    };
    else if (path === "/v10/projects/prj_web/promote/dpl_new" && init.method === "POST") {
      promotionRequested = true;
      return { ok: promotionStatus < 400, status: promotionStatus,
        json: async () => { throw new Error("Promotion success has no JSON body"); } };
    }
    else throw new Error(`Unexpected fixture request ${path}`);
    return { ok: true, json: async () => value };
  };
  return { calls, options: { env, fetchImpl, sleep: async () => {}, maxAttempts: 2 } };
}

test("stages the verified production commit and explicitly promotes only after READY and a fresh main check", async () => {
  const { calls, options } = fixture();
  assert.deepEqual(await redeployVercelProduction(options), {
    id: "dpl_new", url: "web.vercel.app", sha,
  });
  const writes = calls.filter((call) => call.method === "POST");
  assert.equal(writes.length, 2);
  assert.equal(new URL(writes[0].url).searchParams.get("forceNew"), "1");
  assert.deepEqual(JSON.parse(writes[0].body), {
    name: "web", project: "prj_web", deploymentId: "dpl_old",
    target: "production", withLatestCommit: false, autoAssignCustomDomains: false,
  });
  assert.equal(new URL(writes[1].url).pathname, "/v10/projects/prj_web/promote/dpl_new");
  assert.deepEqual(JSON.parse(writes[1].body), {});
  const promotionIndex = calls.indexOf(writes[1]);
  assert.equal(new URL(calls[promotionIndex - 1].url).hostname, "api.github.com");
  assert.equal(new URL(calls[promotionIndex - 2].url).pathname, "/v13/deployments/dpl_new");
  assert.equal(new URL(calls.at(-1).url).hostname, "api.github.com");
  for (const call of calls) {
    const url = new URL(call.url);
    assert.equal(call.headers.Authorization,
      `Bearer ${url.hostname === "api.github.com" ? env.GITHUB_TOKEN : env.VERCEL_TOKEN}`);
    if (url.hostname === "api.vercel.com") assert.equal(url.searchParams.get("teamId"), "team_production");
  }
});

for (const [when, mainShas, buildStates] of [
  ["during the build", [sha, sha, "b".repeat(40)], ["BUILDING"]],
  ["after READY, immediately before promotion", [sha, sha, "b".repeat(40)], ["READY"]],
]) {
  test(`does not promote when main advances ${when}`, async () => {
    const { calls, options } = fixture({ mainShas, buildStates });
    await assert.rejects(redeployVercelProduction(options), /no longer the current main/);
    const writes = calls.filter((call) => call.method === "POST");
    assert.equal(writes.length, 1);
    assert.equal(JSON.parse(writes[0].body).autoAssignCustomDomains, false);
  });
}

test("detects main changing during promotion instead of reporting success or undoing another release", async () => {
  const { calls, options } = fixture({ mainShas: [sha, sha, sha, "b".repeat(40)] });
  await assert.rejects(redeployVercelProduction(options), /no longer the current main/);
  assert.equal(calls.filter((call) => call.method === "POST").length, 2);
});

test("rechecks main after verifying the current production target", async () => {
  const { options } = fixture({ mainShas: [sha, sha, sha, sha, "b".repeat(40)] });
  await assert.rejects(redeployVercelProduction(options), /no longer the current main/);
});

for (const autoAssignCustomDomains of [true, undefined, "false"]) {
  test(`refuses promotion if staging was not confirmed: ${autoAssignCustomDomains}`, async () => {
    const { calls, options } = fixture({ staged: { autoAssignCustomDomains } });
    await assert.rejects(redeployVercelProduction(options), /disabled automatic domain assignment/);
    assert.equal(calls.filter((call) => call.method === "POST").length, 1);
  });
}

for (const promotionStatus of [201, 202]) {
  test(`accepts the documented empty HTTP ${promotionStatus} promotion response`, async () => {
    const { options } = fixture({ promotionStatus });
    assert.equal((await redeployVercelProduction(options)).id, "dpl_new");
  });
}

for (const promotionStatus of [200, 204, 409]) {
  test(`does not claim success for an unexpected HTTP ${promotionStatus} promotion response`, async () => {
    const { options } = fixture({ promotionStatus });
    await assert.rejects(redeployVercelProduction(options), new RegExp(`HTTP ${promotionStatus}`));
  });
}

test("does not mistake already assigned staging aliases for a successful production promotion", async () => {
  const { options } = fixture({ currentProductionId: "dpl_other" });
  await assert.rejects(redeployVercelProduction(options), /before timeout/);
});

for (const [name, source] of [
  ["another project", { ...release, projectId: "prj_other" }],
  ["preview deployment", { ...release, target: "preview" }],
  ["unexpected deployment ID", { ...release, id: "dpl_other" }],
  ["another repository", { ...release, meta: { ...release.meta, githubCommitRepo: "other" } }],
  ["another branch", { ...release, meta: { ...release.meta, githubCommitRef: "feature" } }],
  ["another commit", { ...release, meta: { ...release.meta, githubCommitSha: "b".repeat(40) } }],
  ["missing provenance", { ...release, meta: {} }],
]) {
  test(`refuses ${name} before any deployment write`, async () => {
    const { calls, options } = fixture({ source });
    await assert.rejects(redeployVercelProduction(options), /must match/);
    assert.equal(calls.some((call) => call.method === "POST"), false);
  });
}

test("refuses an older main revision before any deployment write", async () => {
  const { calls, options } = fixture({ mainSha: "b".repeat(40) });
  await assert.rejects(redeployVercelProduction(options), /no longer the current main/);
  assert.equal(calls.some((call) => call.method === "POST"), false);
});

test("refuses a project from another team", async () => {
  const { calls, options } = fixture({ project: { accountId: "team_other" } });
  await assert.rejects(redeployVercelProduction(options), /configured team/);
  assert.equal(calls.length, 1);
});

for (const [key, value] of [
  ["VERCEL_REDEPLOY_ID", "../wrong"], ["VERCEL_REDEPLOY_EXPECTED_SHA", "main"],
  ["GITHUB_REPOSITORY", "https://example.org/repo"], ["VERCEL_TEAM_ID", ""],
  ["VERCEL_PROJECT_ID", ""], ["VERCEL_TOKEN", ""], ["GITHUB_TOKEN", ""],
]) {
  test(`rejects invalid ${key} without network requests`, async () => {
    const { calls, options } = fixture();
    await assert.rejects(redeployVercelProduction({ ...options, env: { ...env, [key]: value } }));
    assert.equal(calls.length, 0);
  });
}

for (const state of ["ERROR", "CANCELED", "BLOCKED", "BUILDING"]) {
  test(`does not report ${state} as a successful deployment`, async () => {
    const { options, calls } = fixture({ finalState: state });
    await assert.rejects(redeployVercelProduction(options),
      state === "BUILDING" ? /before timeout/ : new RegExp(`ended in ${state}`));
    assert.equal(calls.filter((call) => call.method === "POST").length, 1);
  });
}

for (const promoted of [
  { aliasAssigned: false },
  { aliasAssigned: undefined },
  { aliasAssigned: "false" },
  { aliasError: { message: "provider-private-detail" } },
]) {
  test(`does not claim production success without assigned aliases: ${JSON.stringify(promoted)}`, async () => {
    const { options } = fixture({ promoted });
    await assert.rejects(redeployVercelProduction(options), (error) => {
      assert.match(error.message, /aliases/);
      assert.doesNotMatch(error.message, /provider-private-detail/);
      return true;
    });
  });
}

test("does not expose provider response bodies or malformed JSON in errors", async () => {
  for (const failure of [
    { ok: false, status: 403, json: async () => ({ token: env.VERCEL_TOKEN }) },
    { ok: true, json: async () => { throw new Error(env.VERCEL_TOKEN); } },
  ]) {
    const { options } = fixture({ failure });
    await assert.rejects(redeployVercelProduction(options), (error) => {
      assert.doesNotMatch(error.message, /private-vercel-token/);
      return true;
    });
  }
});

test("provider diagnostics are bounded single-line fields with credentials and contact details removed", async () => {
  const request = createApiRequest(async () => ({
    ok: false, status: 400,
    json: async () => ({ error: {
      code: "invalid_request",
      message: `Invalid source\nAuthorization: Bearer other-secret token=another-secret user@example.com ${env.VERCEL_TOKEN} ${"detail ".repeat(200)}`,
      request: { token: "unreported-secret" },
    } }),
  }));
  await assert.rejects(request("https://api.vercel.com/v13/deployments", env.VERCEL_TOKEN, "Vercel"), (error) => {
    assert.match(error.message, /HTTP 400.*invalid_request.*Invalid source/);
    assert.doesNotMatch(error.message, /private-vercel-token|other-secret|another-secret|user@example\.com|unreported-secret|[\r\n]/);
    assert.ok(error.message.length < 650);
    return true;
  });
});

test("unreadable provider error bodies retain the HTTP failure without leaking parser errors", async () => {
  const request = createApiRequest(async () => ({
    ok: false, status: 400,
    json: async () => { throw new Error(env.VERCEL_TOKEN); },
  }));
  await assert.rejects(request("https://api.vercel.com/v13/deployments", env.VERCEL_TOKEN, "Vercel"), (error) => {
    assert.match(error.message, /HTTP 400/);
    assert.doesNotMatch(error.message, /private-vercel-token/);
    return true;
  });
});

test("quoted provider message credential keys do not leak credentials unrelated to release tokens", async () => {
  const request = createApiRequest(async () => ({
    ok: false, status: 400,
    json: async () => ({ error: {
      code: "invalid_request",
      message: 'Invalid options: {"token":"fixture-sensitive-value","password":"fixture-sensitive-password"}',
    } }),
  }));
  await assert.rejects(request("https://api.vercel.com/v13/deployments", env.VERCEL_TOKEN, "Vercel"), (error) => {
    assert.match(error.message, /HTTP 400.*invalid_request.*Invalid options/);
    assert.doesNotMatch(error.message, /fixture-sensitive-/);
    return true;
  });
});

test("provider diagnostics redact URL authentication and signed credentials", async () => {
  const request = createApiRequest(async () => ({
    ok: false, status: 400,
    json: async () => ({ error: {
      code: "invalid_request",
      message: "Invalid source https://fixture-user:fixture-password@api.example.test/repo?signature=fixture-query-secret eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmaXh0dXJlIn0.fixture-signed-secret",
    } }),
  }));
  await assert.rejects(request("https://api.vercel.com/v13/deployments", env.VERCEL_TOKEN, "Vercel"), (error) => {
    assert.match(error.message, /HTTP 400.*invalid_request.*Invalid source/);
    assert.doesNotMatch(error.message, /fixture-user|fixture-password|fixture-query-secret|fixture-signed-secret/);
    return true;
  });
});

test("manual web recovery skips worker deployment and keeps inputs out of shell commands", async () => {
  const workflow = (await readFile(new URL("../workflows/deploy-temporal-worker.yml", import.meta.url), "utf8")).replace(/\r\n?/g, "\n");
  const webJob = workflow.split("  redeploy_web:\n")[1].split("  deploy:\n")[0];
  const workerCondition = workflow.match(/  deploy:\n    if: \$\{\{ (.+) \}\}/)[1];
  function evaluate(condition, event, action, ref = "refs/heads/main") {
    return Function(`return ${condition
      .replaceAll("github.event_name", JSON.stringify(event))
      .replaceAll("github.ref", JSON.stringify(ref))
      .replaceAll("inputs.requests_rollout_action", JSON.stringify(action))}`)();
  }
  const webCondition = webJob.match(/if: \$\{\{ (.+) \}\}/)[1];
  for (const ref of ["refs/heads/feature", "refs/tags/release", "refs/pull/233/merge"]) {
    assert.equal(evaluate(webCondition, "workflow_dispatch", "redeploy_web", ref), false);
  }
  assert.match(webJob, /uses: actions\/checkout@v6\n\s+with:\n\s+ref: main\n\s+persist-credentials: false/);
  for (const [event, action, web, worker] of [
    ["workflow_dispatch", "redeploy_web", true, false],
    ["workflow_dispatch", "deploy_or_bootstrap", false, true],
    ["workflow_dispatch", "transition_sequence", false, false],
    ["workflow_dispatch", "capture_pre_b_baseline", false, false],
    ["push", "", false, true],
  ]) {
    assert.equal(evaluate(webCondition, event, action), web);
    assert.equal(evaluate(workerCondition, event, action), worker);
  }
  assert.doesNotMatch(webJob, /run:.*inputs\./);
  assert.match(webJob, /VERCEL_REDEPLOY_ID: \$\{\{ inputs.web_deployment_id \}\}/);
  assert.match(webJob, /VERCEL_TOKEN: \$\{\{ secrets.VERCEL_TOKEN \}\}/);
  assert.doesNotMatch(webJob, /id-token: write|gcloud|worker test/);
  const workerJob = workflow.split("  deploy:\n")[1];
  const contractCheck = workerJob.split("      - name: Validate Temporal deployment contracts\n")[1].split("\n      - name:")[0];
  assert.match(contractCheck.replace(/\s+/g, " "), /node --test .*\.github\/scripts\/redeploy-vercel-production\.test\.mjs/);
});
