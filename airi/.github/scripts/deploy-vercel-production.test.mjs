import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import {
  WORKER_WORKFLOW_PATH,
  compileWorkflowPathFilter,
  deployVercelProduction,
  formatDeploySummary,
  readWorkflowPushPaths,
} from "./deploy-vercel-production.mjs";

const repoRoot = new URL("../../", import.meta.url);
const readRepoFile = (path) => readFileSync(new URL(path, repoRoot), "utf8").replace(/\r\n?/g, "\n");

// Throwaway main history with a real transitive workspace dependency graph.
const repoDir = mkdtempSync(join(tmpdir(), "deploy-web-"));
after(() => rmSync(repoDir, { recursive: true, force: true }));
function git(...args) {
  const result = spawnSync("git", [
    "-c", "user.name=Deploy Test", "-c", "user.email=deploy@example.com",
    "-c", "commit.gpgsign=false", "-c", "core.autocrlf=false", ...args,
  ], { cwd: repoDir, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
function commit(message, files) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(repoDir, path)), { recursive: true });
    writeFileSync(join(repoDir, path), content);
  }
  git("add", "--all");
  git("commit", "--quiet", "--no-verify", "-m", message);
  return git("rev-parse", "HEAD");
}
git("init", "--quiet", "--initial-branch=main");
const c = {};
c.base = commit("base", {
  [WORKER_WORKFLOW_PATH]: [
    "name: Deploy Temporal Worker", "", "on:", "  push:", "    branches:", "      - main", "    paths:",
    '      - "worker/**"', "      # Shared runtime ships in the worker image.", "      - 'packages/shared/**'",
    "      - package.json", "  workflow_dispatch:", "",
  ].join("\n"),
  "apps/web/package.json": JSON.stringify({ name: "@fixture/web", dependencies: { "@fixture/shared": "workspace:*" } }),
  "pnpm-workspace.yaml": "packages:\n  - 'apps/*'\n  - 'packages/*'\n",
  "packages/shared/package.json": JSON.stringify({ name: "@fixture/shared", dependencies: { "@fixture/leaf": "workspace:*" } }),
  "packages/leaf/package.json": JSON.stringify({ name: "@fixture/leaf" }),
  "packages/unused/package.json": JSON.stringify({ name: "@fixture/unused" }),
  "apps/web/page.txt": "0", "worker/job.txt": "0", "docs/guide.md": "0",
});
c.web1 = commit("web only", { "apps/web/page.txt": "1" });
c.worker2 = commit("worker and editor", { "worker/job.txt": "2", "apps/web/page.txt": "2" });
c.web3 = commit("web only after worker", { "apps/web/page.txt": "3" });
c.docs4 = commit("docs only", { "docs/guide.md": "4" });
c.shared5 = commit("shared runtime", { "packages/shared/lib.txt": "5" });
git("checkout", "--quiet", "-b", "feature");
c.feature = commit("feature web", { "apps/web/feature.txt": "f" });
git("checkout", "--quiet", "main");
git("merge", "--quiet", "--no-ff", "--no-verify", "-m", "Merge pull request from feature", "feature");
c.merge6 = git("rev-parse", "HEAD");
c.workerOnly = commit("worker only", { "worker/job.txt": "worker-only" });
c.widgetOnly = commit("widget only", { "apps/widget/src/widget.ts": "widget" });
c.mobileOnly = commit("mobile only", { "apps/mobile/src/mobile.ts": "mobile" });
c.docsOnly = commit("docs only after web release", { "docs/guide.md": "latest" });
c.unused = commit("unrelated workspace package", { "packages/unused/src/index.ts": "unused" });
c.leaf = commit("transitive web dependency", { "packages/leaf/src/index.ts": "leaf" });
c.lockfile = commit("root lockfile", { "pnpm-lock.yaml": "lockfile" });
c.customWorkspaceInput = commit("custom workspace input", { "backend/deep/entry.ts": "custom-input" });
c.publicTemplateBindings = commit("bundled public template bindings", {
  "docs/integrations/public-whatsapp-template-demos/delivery-bindings-186.json": "[]",
});
c.publicTemplateReceipt = commit("public template receipt only", {
  "docs/integrations/public-whatsapp-template-demos/submission-summary.json": "{}",
});
c.unmerged = git("commit-tree", `${c.base}^{tree}`, "-p", c.base, "-m", "never merged");

const baseEnv = {
  GITHUB_REPOSITORY: "owner/repo",
  VERCEL_TOKEN: "private-vercel-token",
  GITHUB_TOKEN: "private-github-token",
  VERCEL_PROJECT_ID: "prj_web",
  VERCEL_TEAM_ID: "team_production",
};
const pushEnv = (sha) => ({ ...baseEnv, GITHUB_EVENT_NAME: "push", GITHUB_SHA: sha });
const workerEnv = (workerSha, head, conclusion = "success", event = "push") => ({
  ...baseEnv,
  GITHUB_EVENT_NAME: "workflow_run",
  GITHUB_SHA: head,
  WORKER_RUN_HEAD_SHA: workerSha,
  WORKER_RUN_CONCLUSION: conclusion,
  WORKER_RUN_EVENT: event,
  WORKER_RUN_URL: "https://github.com/owner/repo/actions/runs/7",
});
const dispatchEnv = (sha) => ({ ...baseEnv, GITHUB_EVENT_NAME: "workflow_dispatch", WEB_DEPLOY_SHA: sha });
const workerRun = (sha, extra = {}) => ({
  event: "push", head_branch: "main", status: "completed", conclusion: "success", head_sha: sha,
  run_started_at: "2026-09-27T10:00:00Z", html_url: "https://github.com/owner/repo/actions/runs/1", ...extra,
});
const vercelDeployment = (id, sha, extra = {}) => ({
  id, projectId: "prj_web", target: "production", readyState: "READY",
  meta: { githubCommitSha: sha, githubCommitRef: "main", githubCommitOrg: "owner", githubCommitRepo: "repo" },
  ...extra,
});

function fixture({
  productionSha, workerSha, workerRuns = workerSha ? [workerRun(workerSha)] : [], staleWorkerRuns, staleReads = 0, project = {},
  productionState = "READY", states = ["BUILDING", "READY"], staged = {}, failures = {},
  productionMovesTo, movedState = "READY", pinOnReady,
} = {}) {
  const calls = [];
  const deployments = new Map([["dpl_prod", vercelDeployment("dpl_prod", productionSha, { readyState: productionState })]]);
  let productionId = "dpl_prod";
  let pinned = false;
  let promoted = false;
  let reads = 0;
  let workerListReads = 0;
  const reply = (value) => ({ ok: true, status: 200, json: async () => value });
  const fetchImpl = async (url, init = {}) => {
    const method = init.method ?? "GET";
    calls.push({ ...init, url, method });
    const { hostname, pathname } = new URL(url);
    if (failures[`${method} ${pathname}`]) return failures[`${method} ${pathname}`];
    if (hostname === "api.github.com") {
      if (pathname === "/repos/owner/repo/actions/workflows/deploy-temporal-worker.yml/runs") {
        // Like GitHub, newest first and paged; the first reads may come from a stale replica.
        const query = new URL(url).searchParams;
        const page = Number(query.get("page") || 1);
        if (page === 1) workerListReads += 1;
        const listed = workerListReads <= staleReads ? staleWorkerRuns : workerRuns;
        const perPage = Number(query.get("per_page") || 30);
        return reply({ workflow_runs: listed.slice((page - 1) * perPage, page * perPage) });
      }
    } else if (pathname === "/v9/projects/prj_web") {
      return reply({
        id: "prj_web", name: "web", accountId: "team_production", autoAssignCustomDomains: true,
        targets: { production: { id: productionId } }, ...project, ...(pinned ? pinOnReady : {}),
      });
    } else if (pathname === "/v13/deployments" && method === "POST") {
      deployments.set("dpl_new", vercelDeployment("dpl_new", JSON.parse(init.body).gitSource.sha, { url: "web-new.vercel.app" }));
      return reply({ id: "dpl_new" });
    } else if (pathname === "/v13/deployments/dpl_new") {
      const readyState = states[Math.min(reads++, states.length - 1)];
      if (readyState === "READY" && !promoted) {
        pinned = Boolean(pinOnReady);
        if (productionMovesTo) {
          deployments.set("dpl_moved", vercelDeployment("dpl_moved", productionMovesTo, { readyState: movedState }));
          productionId = "dpl_moved";
        }
      }
      return reply({ ...deployments.get("dpl_new"), readyState, autoAssignCustomDomains: false, aliasAssigned: promoted, ...staged });
    } else if (pathname.startsWith("/v13/deployments/") && deployments.has(pathname.split("/").pop())) {
      return reply(deployments.get(pathname.split("/").pop()));
    } else if (pathname === "/v10/projects/prj_web/promote/dpl_new" && method === "POST") {
      promoted = true;
      productionId = "dpl_new";
      return { ok: true, status: 202, json: async () => { throw new Error("Promotion has no JSON body"); } };
    }
    throw new Error(`Unexpected fixture request ${method} ${url}`);
  };
  return {
    calls,
    posts: () => calls.filter((call) => call.method === "POST").map((call) => new URL(call.url).pathname),
    githubCalls: () => calls.filter((call) => new URL(call.url).hostname === "api.github.com"),
    options: { fetchImpl, cwd: repoDir, sleep: async () => {}, maxAttempts: 4 },
  };
}
const deploy = (env, setup) => deployVercelProduction({ env, ...setup.options });

test("GitHub filter pattern semantics match the documented cheat sheet", () => {
  for (const [pattern, matches, misses] of [
    ["*", ["README.md", "server.rb"], ["docs/README.md"]],
    ["*.jsx?", ["page.js", "page.jsx"], ["page.jsxx", "src/page.js"]],
    ["**", ["all/the/files.md"], []],
    ["*.js", ["app.js", "index.js"], ["js/index.js"]],
    ["**.js", ["index.js", "js/index.js", "src/js/app.js"], ["index.ts"]],
    ["docs/*", ["docs/README.md", "docs/file.txt"], ["docs/mona/octocat.txt"]],
    ["docs/**", ["docs/README.md", "docs/mona/octocat.txt"], ["README.md", "src/docs/a.md"]],
    ["docs/**/*.md", ["docs/README.md", "docs/mona/hello-world.md", "docs/a/b/c.md"], ["docs/a.txt"]],
    ["**/docs/**", ["docs/hello.md", "dir/docs/my-file.txt", "space/docs/plan/space.doc"], ["documents/x.md"]],
    ["**/README.md", ["README.md", "js/README.md"], ["README.mdx"]],
    ["**/*src/**", ["a/src/app.js", "my-src/code/js/app.js"], ["source/a.js"]],
    ["**/migrate-*.sql", ["migrate-10909.sql", "db/migrate-v1.0.sql", "db/sept/migrate-v1.sql"], ["db/migrate.sql"]],
    ["v[12].js", ["v1.js", "v2.js"], ["v3.js"]],
    ["apps/web/package.json", ["apps/web/package.json"], ["apps/web/package.jsonx", "package.json"]],
  ]) {
    const matchesPath = compileWorkflowPathFilter([pattern]);
    for (const path of matches) assert.equal(matchesPath(path), true, `${pattern} should match ${path}`);
    for (const path of misses) assert.equal(matchesPath(path), false, `${pattern} should not match ${path}`);
  }
  const ordered = compileWorkflowPathFilter(["*.md", "!README.md", "docs/**", "!docs/**/*.md", "docs/keep.md"]);
  assert.equal(ordered("hello.md"), true);
  assert.equal(ordered("README.md"), false);
  assert.equal(ordered("docs/guide.md"), false);
  assert.equal(ordered("docs/keep.md"), true);
  assert.equal(ordered("docs/image.png"), true);
});

test("unsupported filter patterns and workflow layouts fail loudly instead of misrouting", () => {
  for (const pattern of ["", "/abs/**", "*+", "**?", "file[a_b].js", "file[].js", "unterminated[ab", "trailing\\"]) {
    assert.throws(() => compileWorkflowPathFilter([pattern]), /Unsupported workflow path filter pattern/, pattern);
  }
  assert.throws(() => compileWorkflowPathFilter(["!docs/**"]), /positive pattern/);
  assert.deepEqual(readWorkflowPushPaths([
    "on:", "  push:", "    branches: [main]", "    paths:", "      # comment", '      - "a/**" # trailing comment',
    "      - 'it''s/**'", "      - plain/file.json", "", "  workflow_dispatch:",
  ].join("\r\n")), ["a/**", "it's/**", "plain/file.json"]);
  for (const layout of [
    ["on:", "  push:", "    paths: [\"a/**\"]"],
    ["on:", "  push:", "    branches:", "      - main"],
    ["on:", "  push:", "    paths:", "  workflow_dispatch:"],
    ["on:", "  push:", "    paths:", "      - *.js"],
    ["on:", "  push:", "    paths:", "      - key: value"],
    ["on:", "  pull_request:", "    paths:", '      - "a/**"'],
  ]) {
    assert.throws(() => readWorkflowPushPaths(layout.join("\n")), /on\.push\.paths/, layout.join(" / "));
  }
});

test("worker paths come from the worker workflow's push filter", () => {
  const worker = readRepoFile(WORKER_WORKFLOW_PATH);
  const pushTrigger = worker.match(/\n  push:\n[\s\S]*?(?=\n  workflow_dispatch:)/)[0];
  const listed = [...pushTrigger.matchAll(/^ {6}- "([^"]+)"$/gm)].map((match) => match[1]);
  assert.ok(listed.length > 0);
  assert.deepEqual(readWorkflowPushPaths(worker), listed);
  // Every real pattern compiles and matches a path built from it. Deploy Web runs
  // this file before each deploy, so it must not freeze today's list.
  const isWorkerPath = compileWorkflowPathFilter(listed);
  for (const pattern of listed.filter((entry) => !/^!|[?+[\]\\]/.test(entry))) {
    const example = pattern.replace(/\*\*$/, "nested/file.ts").replaceAll("**/", "").replaceAll("*", "file");
    assert.equal(isWorkerPath(example), true, `${pattern} should match ${example}`);
  }
});

test("Deploy Web triggers, job guard and concurrency", () => {
  const workflow = readRepoFile(".github/workflows/deploy-web.yml");
  const workerName = readRepoFile(WORKER_WORKFLOW_PATH).match(/^name: (.+)$/m)[1];
  const pushTrigger = workflow.match(/\n  push:\n([\s\S]*?)(?=\n  [\w-]+:\n)/)[1];
  assert.match(pushTrigger, /^ {4}branches:\n {6}- main$/m);
  // Every main push reaches the owner that compares its diff with production.
  assert.doesNotMatch(pushTrigger, /^\s*paths(?:-ignore)?:/m);
  assert.match(workflow, new RegExp(
    `\\n  workflow_run:\\n    workflows:\\n      - ${workerName}\\n    types:\\n      - completed\\n    branches:\\n      - main\\n`));
  assert.match(workflow, /\n  workflow_dispatch:\n    inputs:\n      sha:\n/);
  const deploy = workflow.split("\njobs:\n")[1];
  assert.match(deploy, /^ {2}deploy:\n/);
  const runs = ({ event, workerEvent = "", conclusion = "", ref = "refs/heads/main" }) =>
    Function(`return ${deploy.match(/^ {4}if: \$\{\{ (.+) \}\}$/m)[1]
      .replaceAll("github.event.workflow_run.event", JSON.stringify(workerEvent))
      .replaceAll("github.event.workflow_run.conclusion", JSON.stringify(conclusion))
      .replaceAll("github.event_name", JSON.stringify(event))
      .replaceAll("github.ref", JSON.stringify(ref))}`)();
  for (const [trigger, expected] of [
    [{ event: "push" }, true],
    [{ event: "workflow_run", workerEvent: "push", conclusion: "success" }, true],
    [{ event: "workflow_run", workerEvent: "push", conclusion: "failure" }, false],
    [{ event: "workflow_run", workerEvent: "push", conclusion: "cancelled" }, false],
    [{ event: "workflow_run", workerEvent: "workflow_dispatch", conclusion: "success" }, false],
    [{ event: "workflow_dispatch" }, true],
    [{ event: "workflow_dispatch", ref: "refs/heads/feature" }, false],
  ]) {
    assert.equal(runs(trigger), expected, JSON.stringify(trigger));
  }
  assert.match(deploy, /^ {4}concurrency:\n {6}group: deploy-web-prod\n {6}cancel-in-progress: false$/m);
  // Event data and secrets reach the script only through env, never shell text.
  assert.doesNotMatch(workflow, /run:.*\$\{\{/);
  assert.match(deploy, /VERCEL_TOKEN: \$\{\{ secrets\.VERCEL_TOKEN \}\}/);
  assert.match(deploy, /WEB_DEPLOY_SHA: \$\{\{ inputs\.sha \}\}/);
  assert.match(deploy, /runs-on: ubuntu-latest/);
  assert.match(deploy, /actions: read/);
  assert.match(deploy, /fetch-depth: 0\n\s+filter: blob:none\n\s+persist-credentials: false/);
});

test("redeploy_web and the worker failure report stay wired to Deploy Web", () => {
  const worker = readRepoFile(WORKER_WORKFLOW_PATH);
  const recoveryJob = worker.split("  redeploy_web:\n")[1].split("  deploy:\n")[0];
  assert.match(recoveryJob, /\n    concurrency:\n      group: deploy-web-prod\n      cancel-in-progress: false\n/);
  const withheld = worker.match(/- name: Report web deploy withheld\n[\s\S]*$/)[0];
  assert.match(withheld, /if: \$\{\{ github\.event_name == 'push' && \(failure\(\) \|\| cancelled\(\)\) \}\}/);
});

test("Vercel skips automatic main deploys for web", () => {
  const web = JSON.parse(readRepoFile("apps/web/vercel.json")).git.deploymentEnabled;
  assert.equal(web.main, false);
  // A branch matching any true rule still deploys, so no rule may be true.
  assert.deepEqual(Object.values(web).filter((enabled) => enabled !== false), []);
});

test("deploys a web-only push immediately when the live worker already covers it", async () => {
  const setup = fixture({ productionSha: c.base, workerSha: c.base });
  const result = await deploy(pushEnv(c.web1), setup);
  assert.equal(result.status, "deployed");
  assert.equal(result.sha, c.web1);
  assert.equal(result.deploymentId, "dpl_new");
  assert.deepEqual(setup.posts(), ["/v13/deployments", "/v10/projects/prj_web/promote/dpl_new"]);
  const writes = setup.calls.filter((call) => call.method === "POST");
  assert.equal(new URL(writes[0].url).searchParams.get("forceNew"), "1");
  assert.deepEqual(JSON.parse(writes[0].body), {
    name: "web", project: "prj_web", target: "production",
    gitSource: { type: "github", org: "owner", repo: "repo", ref: "main", sha: c.web1 },
    autoAssignCustomDomains: false,
  });
  // Promotion follows a READY read and a fresh production guard.
  const promotion = setup.calls.indexOf(writes[1]);
  assert.equal(new URL(setup.calls[promotion - 1].url).pathname, "/v9/projects/prj_web");
  assert.equal(new URL(setup.calls[promotion - 2].url).pathname, "/v13/deployments/dpl_new");
  for (const call of setup.calls) {
    const url = new URL(call.url);
    const github = url.hostname === "api.github.com";
    assert.equal(call.headers.Authorization, `Bearer ${github ? baseEnv.GITHUB_TOKEN : baseEnv.VERCEL_TOKEN}`);
    if (!github) assert.equal(url.searchParams.get("teamId"), "team_production");
  }
  assert.match(formatDeploySummary(result), /^## Web production deployed\n/);
});

test("stages the exact commit by stable GitHub repository ID despite a stale linked owner label", async () => {
  const setup = fixture({
    productionSha: c.base, workerSha: c.base,
    project: { link: { type: "github", repoId: 123456789, org: "previous-owner", repo: "repo" } },
  });
  const result = await deploy({ ...pushEnv(c.web1), GITHUB_REPOSITORY_ID: "123456789" }, setup);
  assert.equal(result.status, "deployed");
  const created = setup.calls.find((call) => call.method === "POST");
  assert.deepEqual(JSON.parse(created.body).gitSource, {
    type: "github", repoId: "123456789", ref: "main", sha: c.web1,
  });
  assert.equal(JSON.parse(created.body).autoAssignCustomDomains, false);
});

test("a linked repository ID mismatch refuses deployment before staging", async () => {
  const setup = fixture({
    productionSha: c.base, workerSha: c.base,
    project: { link: { type: "github", repoId: 987654321, org: "owner", repo: "repo" } },
  });
  await assert.rejects(deploy({ ...pushEnv(c.web1), GITHUB_REPOSITORY_ID: "123456789" }, setup), /repository ID/i);
  assert.deepEqual(setup.posts(), []);
});

test("invalid repository ID values refuse deployment before staging", async () => {
  for (const repositoryId of ["abc", "0", "1.5", "-1"]) {
    const setup = fixture({ productionSha: c.base, workerSha: c.base });
    await assert.rejects(deploy({ ...pushEnv(c.web1), GITHUB_REPOSITORY_ID: repositoryId }, setup), /repository ID/i);
    assert.deepEqual(setup.posts(), []);
  }
});

for (const [name, productionSha, sha] of [
  ["worker", c.merge6, c.workerOnly],
  ["widget", c.workerOnly, c.widgetOnly],
  ["mobile", c.widgetOnly, c.mobileOnly],
  ["documentation", c.mobileOnly, c.docsOnly],
  ["unrelated workspace package", c.docsOnly, c.unused],
]) {
  test(`skips an automatic ${name}-only release without rebuilding web`, async () => {
    const setup = fixture({ productionSha, workerSha: c.base });
    const result = await deploy(pushEnv(sha), setup);
    assert.equal(result.status, "skipped");
    assert.match(result.reason, /no web build inputs/i);
    assert.deepEqual(setup.posts(), []);
    assert.deepEqual(setup.githubCalls(), []);
  });
}

for (const [name, head] of [["exact worker commit", c.workerOnly], ["later covered commit", c.docsOnly]]) {
  test(`a worker-only completion rebuilds ${name} to materialize synchronized Vercel build env`, async () => {
    const setup = fixture({ productionSha: c.merge6 });
    const result = await deploy(workerEnv(c.workerOnly, head), setup);
    assert.equal(result.status, "deployed");
    assert.equal(result.sha, head);
    assert.match(result.details.join("\n"), /synchronized Vercel build environment/i);
    assert.deepEqual(setup.posts(), ["/v13/deployments", "/v10/projects/prj_web/promote/dpl_new"]);
    assert.equal(JSON.parse(setup.calls.find((call) => call.method === "POST").body).gitSource.sha, head);
  });
}

test("deploys changes to a transitive web workspace dependency", async () => {
  const setup = fixture({ productionSha: c.unused, workerSha: c.leaf });
  const result = await deploy(pushEnv(c.leaf), setup);
  assert.equal(result.status, "deployed");
  assert.equal(result.sha, c.leaf);
});

test("deploys root lockfile changes conservatively", async () => {
  const setup = fixture({ productionSha: c.leaf, workerSha: c.lockfile });
  assert.equal((await deploy(pushEnv(c.lockfile), setup)).status, "deployed");
});

test("deploys a binding-only update to the bundled public template manifest", async () => {
  const setup = fixture({
    productionSha: c.customWorkspaceInput,
    workerSha: c.publicTemplateBindings,
  });
  const result = await deploy(pushEnv(c.publicTemplateBindings), setup);
  assert.equal(result.status, "deployed");
  assert.equal(result.sha, c.publicTemplateBindings);
  assert.deepEqual(setup.posts(), ["/v13/deployments", "/v10/projects/prj_web/promote/dpl_new"]);
});

test("keeps a neighboring public template receipt-only update documentation-only", async () => {
  const setup = fixture({ productionSha: c.publicTemplateBindings });
  const result = await deploy(pushEnv(c.publicTemplateReceipt), setup);
  assert.equal(result.status, "skipped");
  assert.match(result.reason, /no web build inputs/i);
  assert.deepEqual(setup.posts(), []);
  assert.deepEqual(setup.githubCalls(), []);
});

test("manual recovery can deploy a docs-only commit when a rebuild is requested", async () => {
  const setup = fixture({ productionSha: c.mobileOnly });
  const result = await deploy(dispatchEnv(c.docsOnly), setup);
  assert.equal(result.status, "deployed");
  assert.equal(result.sha, c.docsOnly);
});

test("unknown workspace glob layouts conservatively rebuild rather than misclassify new inputs", async () => {
  const workspaceFile = join(repoDir, "pnpm-workspace.yaml");
  const original = readFileSync(workspaceFile, "utf8");
  try {
    writeFileSync(workspaceFile, `${original}  - 'backend/**'\n`);
    const setup = fixture({ productionSha: c.lockfile, workerSha: c.customWorkspaceInput });
    const result = await deploy(pushEnv(c.customWorkspaceInput), setup);
    assert.equal(result.status, "deployed");
  } finally {
    writeFileSync(workspaceFile, original);
  }
});

test("defers a push that changes worker paths until its worker rollout", async () => {
  const setup = fixture({ productionSha: c.web1, workerSha: c.web1 });
  const result = await deploy(pushEnv(c.worker2), setup);
  assert.equal(result.status, "deferred");
  assert.deepEqual(setup.posts(), []);
  assert.match(formatDeploySummary(result), /`worker\/job\.txt`/);
});

test("defers a web-only push while an earlier worker rollout is still pending", async () => {
  // web3 touches no worker path but contains worker2's unreleased worker change.
  const setup = fixture({ productionSha: c.web1, workerSha: c.web1 });
  const result = await deploy(pushEnv(c.web3), setup);
  assert.equal(result.status, "deferred");
  assert.match(result.reason, new RegExp(c.web3));
  assert.match(formatDeploySummary(result), /`worker\/job\.txt`[\s\S]*Deploy Temporal Worker completes/);
  assert.deepEqual(setup.posts(), []);
});

test("uses the most recently started successful worker rollout, including re-runs", async () => {
  const runs = [
    workerRun(c.worker2, { run_started_at: "2026-09-27T10:00:00Z" }),
    workerRun(c.web1, { run_started_at: "2026-09-27T11:00:00Z" }),
    workerRun(c.docs4, { head_branch: "feature", run_started_at: "2026-09-27T12:00:00Z" }),
    workerRun(c.docs4, { event: "workflow_dispatch", run_started_at: "2026-09-27T12:00:00Z" }),
    workerRun(c.docs4, { conclusion: "failure", run_started_at: "2026-09-27T12:00:00Z" }),
    workerRun(c.docs4, { status: "in_progress", conclusion: null, run_started_at: "2026-09-27T13:00:00Z" }),
  ];
  const setup = fixture({ productionSha: c.web1, workerRuns: runs });
  assert.equal((await deploy(pushEnv(c.web3), setup)).status, "deferred");
  const [lookup] = setup.githubCalls();
  const query = new URL(lookup.url).searchParams;
  // Branch and event filters were served stale far more often, so runs are filtered here.
  assert.deepEqual([query.get("branch"), query.get("event"), query.get("status")], [null, null, null]);
});

test("reads the run list again while it lacks the newest worker-path commit", async () => {
  // 2026-10-05: a replica served a list two days old, so a web-only push
  // waited for a worker rollout that had already succeeded.
  const setup = fixture({
    productionSha: c.web1,
    workerRuns: [workerRun(c.worker2, { run_started_at: "2026-09-27T11:00:00Z" }), workerRun(c.web1)],
    staleWorkerRuns: [workerRun(c.web1)],
    staleReads: 1,
  });
  const waits = [];
  const result = await deployVercelProduction({
    env: pushEnv(c.web3), ...setup.options, sleep: async (ms) => { waits.push(ms); },
  });
  assert.equal(result.status, "deployed");
  assert.equal(result.sha, c.web3);
  assert.equal(setup.githubCalls().length, 2);
  assert.deepEqual(waits.slice(0, 1), [5_000]);
});

test("defers while the newest worker run is still going, without calling the list stale", async () => {
  const setup = fixture({
    productionSha: c.web1,
    workerRuns: [
      workerRun(c.worker2, { status: "in_progress", conclusion: null, run_started_at: new Date().toISOString() }),
      workerRun(c.web1),
    ],
  });
  const result = await deploy(pushEnv(c.web3), setup);
  assert.equal(result.status, "deferred");
  assert.equal(setup.githubCalls().length, 4);
  assert.match(formatDeploySummary(result), /still listed as in_progress after 4 reads/);
  assert.doesNotMatch(formatDeploySummary(result), /may be stale/);
});

test("rereads a list that still shows a finished worker run as running", async () => {
  // A replica minutes behind can show the rollout running after it succeeded.
  const setup = fixture({
    productionSha: c.web1,
    workerRuns: [workerRun(c.worker2, { run_started_at: "2026-09-27T11:00:00Z" }), workerRun(c.web1)],
    staleWorkerRuns: [
      workerRun(c.worker2, { status: "in_progress", conclusion: null, run_started_at: new Date().toISOString() }),
      workerRun(c.web1),
    ],
    staleReads: 1,
  });
  const result = await deploy(pushEnv(c.web3), setup);
  assert.equal(result.status, "deployed");
  assert.equal(setup.githubCalls().length, 2);
});

test("says the run list may be stale when rereading never shows the worker run", async () => {
  const setup = fixture({ productionSha: c.web1, workerSha: c.web1 });
  const result = await deploy(pushEnv(c.web3), setup);
  assert.equal(result.status, "deferred");
  assert.equal(setup.githubCalls().length, 4);
  assert.match(formatDeploySummary(result), /after 4 reads: the list may be stale[\s\S]*Manual recovery/);
});

test("notes a possibly stale list when it deploys an older commit", async () => {
  const setup = fixture({ productionSha: c.base, workerSha: c.web1 });
  const result = await deploy(pushEnv(c.web3), setup);
  assert.equal(result.status, "deployed");
  assert.equal(result.sha, c.web1);
  assert.match(formatDeploySummary(result), /wait for their own worker rollout[\s\S]*the list may be stale/);
});

test("pages past newer runs that didn't succeed", async () => {
  const unfinished = Array.from({ length: 100 }, (_, index) =>
    workerRun(c.docs4, { conclusion: index % 2 ? "cancelled" : "failure", run_started_at: "2026-09-28T10:00:00Z" }));
  const setup = fixture({ productionSha: c.web1, workerRuns: [...unfinished, workerRun(c.worker2)] });
  const result = await deploy(pushEnv(c.web3), setup);
  assert.equal(result.status, "deployed");
  assert.deepEqual(setup.githubCalls().map((call) => new URL(call.url).searchParams.get("page")), ["1", "2"]);
});

test("deploys the worker's exact commit after its rollout succeeds", async () => {
  const setup = fixture({ productionSha: c.web1 });
  const result = await deploy(workerEnv(c.worker2, c.worker2), setup);
  assert.equal(result.status, "deployed");
  assert.equal(result.sha, c.worker2);
  assert.deepEqual(setup.githubCalls(), []);
});

test("rolls forward over later commits without worker changes", async () => {
  const forward = fixture({ productionSha: c.web1 });
  const rolled = await deploy(workerEnv(c.worker2, c.docs4), forward);
  assert.equal(rolled.sha, c.docs4);
  assert.match(formatDeploySummary(rolled), /Rolled forward from `[a-f0-9]{40}`/);
  const bounded = await deploy(workerEnv(c.worker2, c.shared5), fixture({ productionSha: c.web1 }));
  assert.equal(bounded.sha, c.docs4);
  assert.match(formatDeploySummary(bounded), /wait for their own worker rollout/);
  // Merge commits are followed along main's first-parent history.
  const merged = await deploy(workerEnv(c.shared5, c.merge6), fixture({ productionSha: c.docs4 }));
  assert.equal(merged.sha, c.merge6);
});

test("skips when production already serves the target commit", async () => {
  const setup = fixture({ productionSha: c.web3, workerSha: c.web3 });
  const result = await deploy(pushEnv(c.web3), setup);
  assert.equal(result.status, "skipped");
  assert.match(result.reason, /already serves/);
  assert.deepEqual(setup.posts(), []);
  assert.deepEqual(setup.githubCalls(), []);
});

for (const productionState of ["CANCELED", "ERROR"]) {
  test(`recovers the exact commit when the production target is ${productionState}`, async () => {
    for (const env of [pushEnv(c.web3), workerEnv(c.web3, c.web3), dispatchEnv(c.web3)]) {
      const setup = fixture({ productionSha: c.web3, productionState, workerSha: c.web3 });
      const result = await deploy(env, setup);
      assert.equal(result.status, "deployed", env.GITHUB_EVENT_NAME);
      assert.equal(result.sha, c.web3);
      assert.equal(result.deploymentId, "dpl_new");
      assert.deepEqual(setup.posts(), ["/v13/deployments", "/v10/projects/prj_web/promote/dpl_new"]);
    }
  });
}

test("refuses deployment when the production target is blocked, still building or has unknown readiness", async () => {
  for (const productionState of ["BLOCKED", "QUEUED", "INITIALIZING", "BUILDING", "UNKNOWN", null]) {
    const setup = fixture({ productionSha: c.web3, productionState, workerSha: c.web3 });
    await assert.rejects(deploy(pushEnv(c.web3), setup), /production target.*not READY/i);
    assert.deepEqual(setup.posts(), []);
  }
});

test("a canceled or failed production target preserves the commit ordering boundary", async () => {
  for (const productionState of ["CANCELED", "ERROR"]) {
    for (const env of [pushEnv(c.web1), workerEnv(c.worker2, c.worker2), dispatchEnv(c.web1)]) {
      const setup = fixture({ productionSha: c.web3, productionState, workerSha: c.web3 });
      const result = await deploy(env, setup);
      assert.equal(result.status, "skipped");
      assert.deepEqual(setup.posts(), []);
    }
    const offMain = fixture({ productionSha: c.unmerged, productionState, workerSha: c.base });
    await assert.rejects(deploy(dispatchEnv(c.web1), offMain), /Cannot order/);
    assert.deepEqual(offMain.posts(), []);
  }
});

test("a canceled production target cannot recover an older worker-covered candidate", async () => {
  const setup = fixture({ productionSha: c.web3, productionState: "CANCELED", workerSha: c.web1 });
  const result = await deploy(pushEnv(c.shared5), setup);
  assert.equal(result.status, "skipped");
  assert.deepEqual(setup.posts(), []);
});

test("never replaces a newer production commit with an older one", async () => {
  for (const env of [pushEnv(c.web1), workerEnv(c.worker2, c.worker2), dispatchEnv(c.web1)]) {
    const setup = fixture({ productionSha: c.web3, workerSha: c.web3 });
    const result = await deploy(env, setup);
    assert.equal(result.status, "skipped", env.GITHUB_EVENT_NAME);
    assert.match(result.reason, /is older and was not deployed/);
    assert.deepEqual(setup.posts(), []);
  }
});

test("manual dispatch deploys one exact main commit without the worker gate", async () => {
  const setup = fixture({ productionSha: c.web1 });
  const result = await deploy(dispatchEnv(c.worker2), setup);
  assert.equal(result.status, "deployed");
  assert.equal(result.sha, c.worker2);
  assert.equal(JSON.parse(setup.calls.find((call) => call.method === "POST").body).gitSource.sha, c.worker2);
  assert.deepEqual(setup.githubCalls(), []);
});

test("rejects invalid input before any request", async () => {
  for (const [env, message] of [
    [dispatchEnv("main"), /full 40-character/],
    [dispatchEnv(c.unmerged), /not a commit on main/],
    [dispatchEnv("1".repeat(40)), /not a commit on main/],
    [{ ...pushEnv(c.web1), GITHUB_SHA: "HEAD" }, /GITHUB_SHA/],
    [{ ...pushEnv(c.web1), VERCEL_TOKEN: "" }, /credentials/],
    [{ ...pushEnv(c.web1), GITHUB_TOKEN: "" }, /credentials/],
    [{ ...pushEnv(c.web1), VERCEL_TEAM_ID: "" }, /project and team/],
    [{ ...pushEnv(c.web1), VERCEL_PROJECT_ID: "" }, /project and team/],
    [{ ...pushEnv(c.web1), GITHUB_REPOSITORY: "https://example.org/repo" }, /GITHUB_REPOSITORY/],
    [{ ...pushEnv(c.web1), GITHUB_EVENT_NAME: "pull_request" }, /does not handle/],
    [{ ...workerEnv("abc", c.web1) }, /WORKER_RUN_HEAD_SHA/],
    [workerEnv(c.worker2, c.worker2, "failure"), /only follows successful push-triggered/],
    [workerEnv(c.worker2, c.worker2, "success", "workflow_dispatch"), /only follows successful push-triggered/],
  ]) {
    const setup = fixture({ productionSha: c.base, workerSha: c.base });
    await assert.rejects(deploy(env, setup), message);
    assert.deepEqual(setup.calls, []);
  }
});

test("reports provider errors without leaking credentials or response bodies", async () => {
  const failure = { ok: false, status: 500, json: async () => ({ token: baseEnv.VERCEL_TOKEN }) };
  const setup = fixture({ productionSha: c.base, workerSha: c.base, failures: { "POST /v13/deployments": failure } });
  await assert.rejects(deploy(pushEnv(c.web1), setup), (error) => {
    assert.match(error.message, /Vercel production deploy failed with HTTP 500/);
    assert.doesNotMatch(error.message, /private-/);
    return true;
  });
  const github = fixture({
    productionSha: c.base,
    failures: { "GET /repos/owner/repo/actions/workflows/deploy-temporal-worker.yml/runs": { ok: false, status: 403 } },
  });
  await assert.rejects(deploy(pushEnv(c.web1), github), /GitHub worker rollout lookup failed with HTTP 403/);
  assert.deepEqual(github.posts(), []);
});

test("HTTP 400 diagnostics retain provider code and safe message while redacting both credentials", async () => {
  const setup = fixture({
    productionSha: c.base, workerSha: c.base,
    failures: { "POST /v13/deployments": {
      ok: false, status: 400,
      json: async () => ({ error: {
        code: "invalid_git_source",
        message: `The repository could not be retrieved. ${baseEnv.VERCEL_TOKEN} ${baseEnv.GITHUB_TOKEN}`,
        token: "unreported-private-response-field",
      } }),
    } },
  });
  await assert.rejects(deploy(pushEnv(c.web1), setup), (error) => {
    assert.match(error.message, /HTTP 400.*invalid_git_source.*The repository could not be retrieved/);
    assert.doesNotMatch(error.message, /private-/);
    return true;
  });
  assert.deepEqual(setup.posts(), ["/v13/deployments"]);
});

for (const state of ["ERROR", "CANCELED", "BLOCKED"]) {
  test(`fails when the production build ends in ${state} and never promotes it`, async () => {
    const setup = fixture({ productionSha: c.base, workerSha: c.base, states: ["QUEUED", state] });
    await assert.rejects(deploy(pushEnv(c.web1), setup), new RegExp(`ended in ${state}`));
    assert.deepEqual(setup.posts(), ["/v13/deployments"]);
  });
}

test("fails with a clear timeout when the build never becomes READY", async () => {
  const setup = fixture({ productionSha: c.base, workerSha: c.base, states: ["BUILDING"] });
  await assert.rejects(deploy(pushEnv(c.web1), setup), /did not become READY with assigned aliases before timeout/);
  assert.deepEqual(setup.posts(), ["/v13/deployments"]);
});

test("leaves the build staged when production moves to the same or a newer commit during it", async () => {
  for (const moved of [c.web1, c.web3]) {
    const setup = fixture({ productionSha: c.base, workerSha: c.base, productionMovesTo: moved });
    const result = await deploy(pushEnv(c.web1), setup);
    assert.equal(result.status, "skipped");
    assert.match(result.reason, /during the build/);
    assert.deepEqual(setup.posts(), ["/v13/deployments"]);
  }
});

for (const movedState of ["CANCELED", "ERROR"]) {
  test(`recovers when the production target moves to the same ${movedState} commit during the build`, async () => {
    const setup = fixture({
      productionSha: c.base, workerSha: c.base, productionMovesTo: c.web1, movedState,
    });
    const result = await deploy(pushEnv(c.web1), setup);
    assert.equal(result.status, "deployed");
    assert.equal(result.sha, c.web1);
    assert.deepEqual(setup.posts(), ["/v13/deployments", "/v10/projects/prj_web/promote/dpl_new"]);
  });
}

test("a failed production target movement cannot promote an older or unrelated commit", async () => {
  for (const movedState of ["CANCELED", "ERROR"]) {
    for (const productionMovesTo of [c.web3, c.unmerged]) {
      const setup = fixture({ productionSha: c.base, workerSha: c.base, productionMovesTo, movedState });
      assert.equal((await deploy(pushEnv(c.web1), setup)).status, "skipped");
      assert.deepEqual(setup.posts(), ["/v13/deployments"]);
    }
  }
});

test("a blocked or building target movement leaves the new artifact unpromoted", async () => {
  for (const movedState of ["BLOCKED", "BUILDING", "UNKNOWN"]) {
    const setup = fixture({ productionSha: c.base, workerSha: c.base, productionMovesTo: c.web1, movedState });
    await assert.rejects(deploy(pushEnv(c.web1), setup), /production target.*not READY/i);
    assert.deepEqual(setup.posts(), ["/v13/deployments"]);
  }
});

test("a canceled production target never overrides an explicit rollback or staging pin", async () => {
  for (const project of [
    { autoAssignCustomDomains: false },
    { lastAliasRequest: { type: "rollback", toDeploymentId: "dpl_prod", jobStatus: "succeeded" } },
  ]) {
    const setup = fixture({ productionSha: c.web1, productionState: "CANCELED", workerSha: c.base, project });
    const result = await deploy(pushEnv(c.web1), setup);
    assert.equal(result.status, "paused");
    assert.deepEqual(setup.posts(), []);
  }
  const duringBuild = fixture({
    productionSha: c.base, workerSha: c.base, productionMovesTo: c.web3, movedState: "CANCELED",
    pinOnReady: { autoAssignCustomDomains: false },
  });
  assert.equal((await deploy(pushEnv(c.web1), duringBuild)).status, "paused");
  assert.deepEqual(duringBuild.posts(), ["/v13/deployments"]);
});

test("never promotes while production is pinned by an Instant Rollback", async () => {
  for (const project of [
    { autoAssignCustomDomains: false },
    { lastAliasRequest: { type: "rollback", toDeploymentId: "dpl_prod", jobStatus: "succeeded" } },
  ]) {
    const setup = fixture({ productionSha: c.base, workerSha: c.base, project });
    const result = await deploy(pushEnv(c.web1), setup);
    assert.equal(result.status, "paused");
    assert.match(formatDeploySummary(result), /Undo the rollback in Vercel/);
    assert.deepEqual(setup.posts(), []);
  }
  const duringBuild = fixture({ productionSha: c.base, workerSha: c.base, pinOnReady: { autoAssignCustomDomains: false } });
  const result = await deploy(pushEnv(c.web1), duringBuild);
  assert.equal(result.status, "paused");
  assert.deepEqual(duringBuild.posts(), ["/v13/deployments"]);
  // A finished promote clears the pin; only rollbacks to current production count.
  const promotedBefore = fixture({
    productionSha: c.base, workerSha: c.base,
    project: { lastAliasRequest: { type: "rollback", toDeploymentId: "dpl_older" } },
  });
  assert.equal((await deploy(pushEnv(c.web1), promotedBefore)).status, "deployed");
});

test("refuses to promote a build whose provenance is not the exact target commit", async () => {
  for (const staged of [
    { meta: { githubCommitSha: c.web3, githubCommitRef: "main" } },
    { meta: { githubCommitRef: "main" } },
    { meta: { githubCommitSha: c.web1, githubCommitRef: "feature" } },
    { meta: { githubCommitSha: c.web1, githubCommitOrg: "other", githubCommitRepo: "repo" } },
    { projectId: "prj_other" },
    { target: "preview" },
  ]) {
    const setup = fixture({ productionSha: c.base, workerSha: c.base, staged });
    await assert.rejects(deploy(pushEnv(c.web1), setup), /must match/, JSON.stringify(staged));
    assert.deepEqual(setup.posts(), ["/v13/deployments"]);
  }
  // Vercel may report the commit through gitSource instead of meta.
  const gitSourceOnly = fixture({
    productionSha: c.base, workerSha: c.base,
    staged: { meta: {}, gitSource: { type: "github", org: "owner", repo: "repo", ref: "main", sha: c.web1 } },
  });
  assert.equal((await deploy(pushEnv(c.web1), gitSourceOnly)).status, "deployed");
});

test("fails when production or the worker commit is off main's history", async () => {
  for (const [setup, message] of [
    [fixture({ productionSha: undefined, workerSha: c.base }), /Cannot order/],
    [fixture({ productionSha: c.unmerged, workerSha: c.base }), /Cannot order/],
    [fixture({ productionSha: "2".repeat(40), workerSha: c.base }), /Cannot order/],
    [fixture({ productionSha: c.base, workerRuns: [] }), /No successful push-triggered Deploy Temporal Worker run/],
    [fixture({ productionSha: c.base, workerSha: "3".repeat(40) }), /not in the checked-out main history/],
  ]) {
    await assert.rejects(deploy(pushEnv(c.web1), setup), message);
    assert.deepEqual(setup.posts(), []);
  }
});
