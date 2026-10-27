#!/usr/bin/env node

// Deploys web production once the worker changes a commit contains are live.
// See apps/temporal-worker/README.md#deploy-order-web-after-worker.

import { spawnSync } from "node:child_process";
import { appendFile, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  DEPLOYMENT_ID,
  SHA,
  createApiRequest,
  createVercelRequest,
  loadVercelProject,
  promoteStagedProductionDeployment,
  requireReleaseTarget,
} from "./redeploy-vercel-production.mjs";

// The worker workflow's own push filter is the only list of worker paths.
export const WORKER_WORKFLOW_PATH = ".github/workflows/deploy-temporal-worker.yml";
const WORKER_WORKFLOW_FILE = WORKER_WORKFLOW_PATH.split("/").pop();
const GIT_INFO = "?withGitRepoInfo=true";
const MAX_CANDIDATES = 200;
const MANUAL_RECOVERY = "Manual recovery: dispatch Deploy Web with the exact 40-character `sha` (apps/temporal-worker/README.md#deploy-order-web-after-worker).";
const TITLES = {
  deployed: "Web production deployed",
  skipped: "Web production deploy skipped",
  deferred: "Web production deploy deferred until the worker rollout",
  paused: "Web production deploy paused",
  failed: "Web production deploy failed",
};

// Outcomes that intentionally leave production unchanged without failing the job.
class DeployWithheld extends Error {
  constructor(status, reason, details = []) {
    super(reason);
    this.status = status;
    this.details = details;
  }
}

// Reads on.push.paths without a YAML dependency (these scripts run before
// `pnpm install`). Layouts other than the block list used there fail loudly.
export function readWorkflowPushPaths(workflowText) {
  const lines = workflowText.replace(/\r\n?/g, "\n").split("\n");
  const indentOf = (line) => line.length - line.trimStart().length;
  const ignorable = (line) => !line.trim() || line.trimStart().startsWith("#");
  const unsupported = (detail) => new Error(`${WORKER_WORKFLOW_PATH} on.push.paths ${detail}`);
  function childBlock(key, [from, to], depth) {
    let start = from;
    while (start < to && (ignorable(lines[start]) || indentOf(lines[start]) !== depth ||
        lines[start].trim() !== `${key}:`)) start += 1;
    if (start >= to) throw unsupported("must be a block list under on: push:");
    let end = start + 1;
    while (end < to && (ignorable(lines[end]) || indentOf(lines[end]) > depth)) end += 1;
    return [start + 1, end];
  }
  const block = childBlock("paths", childBlock("push", childBlock("on", [0, lines.length], 0), 2), 4);
  const patterns = lines.slice(...block).filter((line) => !ignorable(line)).map((line) => {
    const item = line.match(/^ {6}- (.+)$/);
    if (!item) throw unsupported(`entry is not supported: ${line.trim()}`);
    return parseScalar(item[1].trim(), unsupported);
  });
  if (patterns.length === 0) throw unsupported("must not be empty");
  return patterns;
}

function parseScalar(text, unsupported) {
  const doubleQuoted = text.match(/^"((?:[^"\\]|\\.)*)"(?:\s+#.*)?$/);
  if (doubleQuoted) {
    try {
      return JSON.parse(`"${doubleQuoted[1]}"`);
    } catch {
      throw unsupported(`entry is not supported: ${text}`);
    }
  }
  const singleQuoted = text.match(/^'((?:[^']|'')*)'(?:\s+#.*)?$/);
  if (singleQuoted) return singleQuoted[1].replaceAll("''", "'");
  // Plain scalars; YAML indicators such as ! * & [ must be quoted anyway.
  const plain = text.match(/^([\w./][^\s#]*)(?:\s+#.*)?$/);
  if (plain) return plain[1];
  throw unsupported(`entry is not supported: ${text}`);
}

// GitHub filter pattern semantics: * never matches "/", ** matches anything and
// "**/" may match no directory, ? and + repeat the preceding character, []
// holds alphanumerics or ranges, and a later matching "!" pattern excludes.
export function compileWorkflowPathFilter(patterns) {
  const rules = patterns.map((raw) => {
    const negated = raw.startsWith("!");
    return { negated, regex: globToRegExp(negated ? raw.slice(1) : raw, raw) };
  });
  if (!rules.some((rule) => !rule.negated)) {
    throw new Error("Workflow path filters need at least one positive pattern");
  }
  return (path) => rules.reduce(
    (matched, rule) => (rule.regex.test(path) ? !rule.negated : matched),
    false,
  );
}

function globToRegExp(pattern, raw) {
  const unsupported = () => new Error(`Unsupported workflow path filter pattern: ${raw}`);
  if (!pattern || pattern.startsWith("/")) throw unsupported();
  let source = "";
  let repeatable = false;
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "*") {
      const double = pattern[index + 1] === "*";
      if (double && (index === 0 || pattern[index - 1] === "/") && pattern[index + 2] === "/") {
        source += "(?:.*/)?";
        index += 2;
      } else if (double) {
        source += ".*";
        index += 1;
      } else {
        source += "[^/]*";
      }
      repeatable = false;
    } else if (char === "?" || char === "+") {
      if (!repeatable) throw unsupported();
      source += char;
      repeatable = false;
    } else if (char === "[") {
      const close = pattern.indexOf("]", index + 1);
      const body = close < 0 ? "" : pattern.slice(index + 1, close);
      if (!/^(?:[A-Za-z0-9](?:-[A-Za-z0-9])?)+$/.test(body)) throw unsupported();
      source += `[${body}]`;
      index = close;
      repeatable = true;
    } else {
      if (char === "\\") {
        index += 1;
        if (index >= pattern.length) throw unsupported();
      }
      source += pattern[index].replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
      repeatable = true;
    }
  }
  return new RegExp(`^${source}$`);
}

// Read-only git queries against the checked-out history. Lazy fetches stay
// off: the checkout is a blob-less clone without persisted credentials.
function createGit({ cwd }) {
  function run(args, okStatuses = [0]) {
    const result = spawnSync("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_NO_LAZY_FETCH: "1" },
    });
    if (result.error || !okStatuses.includes(result.status)) {
      throw new Error(`git ${args[0]} failed${result.status == null ? "" : ` with exit code ${result.status}`}`);
    }
    return result;
  }
  return {
    hasCommit: (sha) => run(["cat-file", "-e", `${sha}^{commit}`], [0, 1, 128]).status === 0,
    isAncestor: (ancestor, descendant) =>
      run(["merge-base", "--is-ancestor", ancestor, descendant], [0, 1]).status === 0,
    changedFiles: (from, to) =>
      run(["diff", "--name-only", "--no-renames", "-z", from, to]).stdout.split("\0").filter(Boolean),
    firstParentCommits: (head, exclude, max) =>
      run(["rev-list", "--first-parent", `--max-count=${max}`, head, ...(exclude ? [`^${exclude}`] : [])])
        .stdout.split("\n").filter(Boolean),
  };
}

// The build consumes web and its transitive workspace dependencies. Derive the
// ownership graph from manifests rather than maintaining a second package list.
async function readWebBuildPathFilter(cwd) {
  let roots;
  try {
    const lines = (await readFile(join(cwd, "pnpm-workspace.yaml"), "utf8"))
      .replace(/\r\n?/g, "\n").split("\n");
    const start = lines.findIndex((line) => /^packages:\s*(?:#.*)?$/.test(line));
    if (start < 0) throw new Error("Workspace package list is missing");
    const entries = [];
    for (const line of lines.slice(start + 1)) {
      if (!line.trim() || line.trimStart().startsWith("#")) continue;
      if (!/^\s/.test(line)) break;
      const item = line.match(/^ {2}- (.+)$/);
      if (!item) throw new Error("Unsupported workspace package list");
      entries.push(parseScalar(item[1].trim(), () => new Error("Unsupported workspace pattern")));
    }
    if (!entries.length || entries.some((pattern) => !/^[\w.-]+\/\*$/.test(pattern))) {
      throw new Error("Unsupported workspace pattern");
    }
    roots = [...new Set(entries.map((pattern) => pattern.slice(0, -2)))];
  } catch {
    // Preserve deployment correctness if workspace membership later adopts
    // nested/negative globs that this dependency-free reader cannot prove.
    console.log("Workspace membership is not supported by build-input detection; all changes require a web build.");
    return () => true;
  }
  const packages = new Map();
  for (const parent of roots) {
    let entries;
    try {
      entries = await readdir(join(cwd, parent), { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    for (const entry of entries.filter((entry) => entry.isDirectory())) {
      const directory = `${parent}/${entry.name}`;
      let manifest;
      try {
        manifest = JSON.parse(await readFile(join(cwd, directory, "package.json"), "utf8"));
      } catch (error) {
        if (error.code === "ENOENT") continue;
        throw new Error(`Cannot read workspace manifest ${directory}/package.json`);
      }
      if (!manifest.name || packages.has(manifest.name)) {
        throw new Error(`Workspace package name is missing or duplicated in ${directory}/package.json`);
      }
      packages.set(manifest.name, { directory, manifest });
    }
  }
  const web = [...packages.values()].find((entry) => entry.directory === "apps/web");
  if (!web) throw new Error("apps/web/package.json is required to determine web build inputs");
  const directories = new Set();
  function visit(entry) {
    if (directories.has(entry.directory)) return;
    directories.add(entry.directory);
    const dependencies = {
      ...entry.manifest.dependencies, ...entry.manifest.devDependencies,
      ...entry.manifest.optionalDependencies, ...entry.manifest.peerDependencies,
    };
    for (const [name, version] of Object.entries(dependencies)) {
      if (typeof version !== "string" || !version.startsWith("workspace:")) continue;
      const dependency = packages.get(name);
      if (!dependency) throw new Error(`Workspace dependency ${name} is missing for ${entry.directory}`);
      visit(dependency);
    }
  }
  visit(web);
  const isOwnedPath = compileWorkflowPathFilter([
    ...[...directories].map((directory) => `${directory}/**`),
    // Web prebuild validates the production Supabase contract.
    ".github/scripts/verify-supabase-campaign-contract.mjs",
    // The public demo manifest is statically imported outside workspace packages.
    "docs/integrations/public-whatsapp-template-demos/delivery-bindings-186.json",
    "supabase/**", "patches/**",
  ]);
  const rootDocumentation = new Set(["AGENTS.md", "README.md", "CONTRIBUTING.md", "LICENSE"]);
  return (file) => isOwnedPath(file) || (!file.includes("/") && !rootDocumentation.has(file));
}

function hasWebBuildChanges(git, production, sha, isWebPath) {
  if (!production) return true;
  // A bounded candidate may precede checkout HEAD. If later manifests change
  // ownership, the current graph cannot prove that an older input is unrelated.
  if (git.changedFiles(sha, "HEAD").some((file) =>
    file.endsWith("/package.json") || file === "pnpm-workspace.yaml")) return true;
  return git.changedFiles(production.sha, sha).some(isWebPath);
}

// Worker-path files that differ between the rolled-out worker and a web commit,
// using the same two-dot diff GitHub uses for push path filters. An empty list
// means the web commit needs nothing the live worker lacks; null means the
// histories are unrelated, so nothing can be proven.
function workerChangesSince(git, workerSha, commit, isWorkerPath) {
  if (git.isAncestor(commit, workerSha)) return [];
  if (!git.isAncestor(workerSha, commit)) return null;
  return git.changedFiles(workerSha, commit).filter(isWorkerPath);
}

// Newest first-parent commit of `upperBound`, strictly newer than production,
// whose worker-path changes are all rolled out.
function findNewestDeployableCommit({ git, upperBound, production, workerSha, isWorkerPath }) {
  let pending = null;
  for (const commit of git.firstParentCommits(upperBound, production?.sha, MAX_CANDIDATES)) {
    if (production?.sha && !git.isAncestor(production.sha, commit)) break;
    const workerFiles = workerChangesSince(git, workerSha, commit, isWorkerPath);
    if (workerFiles?.length === 0) return { sha: commit, pending };
    pending ??= { sha: commit, workerFiles: workerFiles ?? [], unrelated: workerFiles === null };
  }
  return { sha: null, pending };
}

function compareWithProduction(git, sha, production) {
  if (!production) return "newer";
  if (production.sha === sha) return production.readyState === "READY" ? "same" : "recoverable";
  if (!production.sha || !git.hasCommit(production.sha)) return "unknown";
  if (git.isAncestor(production.sha, sha)) return "newer";
  return git.isAncestor(sha, production.sha) ? "older" : "unrelated";
}

function requireNewerThanProduction(git, sha, production) {
  const position = compareWithProduction(git, sha, production);
  if (position === "newer" || position === "recoverable") return;
  if (position === "same") {
    throw new DeployWithheld("skipped", `Production already serves \`${sha}\` (${production.id}); nothing to deploy.`);
  }
  if (position === "older") {
    throw new DeployWithheld("skipped",
      `Production target is newer commit \`${production.sha}\` (${production.id}); \`${sha}\` is older and was not deployed.`);
  }
  throw new Error(`Cannot order ${sha} against production deployment ${production.id} ` +
    `(commit ${production.sha ?? "unknown"} is not on main's history); promote a main deployment in Vercel first`);
}

// After an Instant Rollback Vercel stops assigning production domains, and a
// promotion would undo that rollback, so CI leaves production alone.
function describeProductionPin(project) {
  if (project.autoAssignCustomDomains === false) {
    return "Vercel's automatic production domain assignment is off (Instant Rollback or manual staging)";
  }
  const last = project.lastAliasRequest;
  if (last?.type === "rollback" && last.toDeploymentId &&
      last.toDeploymentId === project.targets?.production?.id) {
    return `production is pinned by an Instant Rollback to ${last.toDeploymentId}`;
  }
  return null;
}

function deploymentSha(deployment) {
  const sha = deployment?.meta?.githubCommitSha ?? deployment?.gitSource?.sha;
  return SHA.test(sha ?? "") ? sha : null;
}

async function readDeploymentAt(vercel, id) {
  if (!DEPLOYMENT_ID.test(id ?? "")) {
    throw new Error("Vercel reported an invalid production deployment identifier");
  }
  const deployment = await vercel(`/v13/deployments/${id}${GIT_INFO}`);
  const { readyState } = deployment;
  if (!["READY", "CANCELED", "ERROR"].includes(readyState)) {
    throw new Error(`Vercel production target ${id} is not READY or a recoverable failed deployment`);
  }
  // Failed targets retain their commit as an ordering floor. Only READY proves
  // that the target serves production; exact-commit recovery must rebuild it.
  return { id, sha: deploymentSha(deployment), readyState };
}

// GitHub can answer the run list from a replica that is days behind: on
// 2026-10-05 repeated identical requests returned anywhere from 72 to 588
// runs, so a web-only push was deferred behind a worker that was already
// live. Queries filtered by branch or event were stale far more often than
// unfiltered ones, so the list is fetched unfiltered and runs are checked
// here. A push that changes worker paths normally starts a worker run, so
// until the list shows a finished run at or after the newest worker-path
// commit it is read again before the deploy trusts it.
const WORKER_RUNS_PAGE_SIZE = 100;
const WORKER_RUNS_MAX_PAGES = 5;
const WORKER_RUNS_RETRY_DELAYS_MS = [5_000, 10_000, 20_000];
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Newest first-parent commit of `head` that itself changes worker paths.
function findNewestWorkerPathCommit(git, head, isWorkerPath) {
  for (const commit of git.firstParentCommits(head, null, MAX_CANDIDATES)) {
    if (!git.hasCommit(`${commit}^`)) return null;
    if (git.changedFiles(`${commit}^`, commit).some(isWorkerPath)) return commit;
  }
  return null;
}

async function listMainPushWorkerRuns(request, token, repository) {
  const runs = [];
  for (let page = 1; page <= WORKER_RUNS_MAX_PAGES; page += 1) {
    const url = new URL(`https://api.github.com/repos/${repository}/actions/workflows/${WORKER_WORKFLOW_FILE}/runs`);
    for (const [key, value] of Object.entries({
      per_page: String(WORKER_RUNS_PAGE_SIZE), page: String(page), exclude_pull_requests: "true",
    })) url.searchParams.set(key, value);
    const body = await request(url.toString(), token, "GitHub worker rollout lookup");
    const listed = Array.isArray(body?.workflow_runs) ? body.workflow_runs : [];
    runs.push(...listed.filter((run) =>
      run?.event === "push" && run.head_branch === "main" && SHA.test(run.head_sha ?? "")));
    if (listed.length < WORKER_RUNS_PAGE_SIZE || runs.some((run) => run.conclusion === "success")) break;
  }
  return runs;
}

async function findLatestWorkerRollout(request, token, repository, { git, newestWorkerCommit, sleep }) {
  const coversNewestWorkerCommit = (run) =>
    git.hasCommit(run.head_sha) && git.isAncestor(newestWorkerCommit, run.head_sha);
  const successful = [];
  let settled = !newestWorkerCommit;
  let unfinishedStatus = null;
  let attempts = 0;
  for (;;) {
    attempts += 1;
    const runs = await listMainPushWorkerRuns(request, token, repository);
    successful.push(...runs.filter((run) => run.conclusion === "success"));
    if (!settled) {
      const covering = runs.filter(coversNewestWorkerCommit);
      settled = covering.some((run) => run.status === "completed");
      if (!settled && covering.length) unfinishedStatus = covering[0].status || "unfinished";
    }
    if (settled || attempts > WORKER_RUNS_RETRY_DELAYS_MS.length) break;
    await sleep(WORKER_RUNS_RETRY_DELAYS_MS[attempts - 1]);
  }
  if (successful.length === 0) {
    throw new Error("No successful push-triggered Deploy Temporal Worker run was found, so the rolled-out worker commit is unknown");
  }
  // Runs are serialized, so the latest start is the live worker; re-runs reset it.
  const startedAt = (run) => Date.parse(run.run_started_at ?? run.created_at) || 0;
  const latest = successful.reduce((best, run) => (startedAt(run) > startedAt(best) ? run : best));
  const note = settled
    ? null
    : unfinishedStatus
      ? `The worker run for \`${newestWorkerCommit}\` was still listed as ${unfinishedStatus} after ${attempts} reads.`
      : `GitHub's run list showed no worker run for \`${newestWorkerCommit}\` after ${attempts} reads: the list may be stale, or that push started no worker run. If that rollout already succeeded, use manual recovery.`;
  return { sha: latest.head_sha, url: latest.html_url, note };
}

function verifyStagedDeployment(deployment, { id, projectId, sha, repository }) {
  const meta = deployment.meta ?? {};
  const source = deployment.gitSource ?? {};
  const reportedSha = deploymentSha(deployment);
  const ref = meta.githubCommitRef ?? source.ref;
  const org = meta.githubCommitOrg ?? source.org;
  const repo = meta.githubCommitRepo ?? source.repo;
  // Provenance may still be filling in while building, but never differ, and
  // the exact commit must be confirmed before READY can lead to promotion.
  if (deployment.id !== id ||
      (deployment.projectId || deployment.project?.id) !== projectId ||
      deployment.target !== "production" ||
      (reportedSha ? reportedSha !== sha : deployment.readyState === "READY") ||
      (ref != null && ref !== "main") ||
      (org != null && repo != null && `${org}/${repo}`.toLowerCase() !== repository.toLowerCase())) {
    throw new Error("Deployment must match the configured production project, repository, and exact main commit");
  }
}

async function stageAndPromote({ vercel, git, project, production, sha, repository, repositoryId, sleep, maxAttempts }) {
  const [org, repo] = repository.split("/");
  if (repositoryId && project.link &&
      (project.link.type !== "github" ||
        (project.link.repoId != null && String(project.link.repoId) !== repositoryId))) {
    throw new Error("Vercel project Git link does not match the GitHub repository ID");
  }
  const created = await vercel("/v13/deployments?forceNew=1", {
    name: project.name,
    project: project.id,
    target: "production",
    // GitHub Actions provides a stable repository ID across owner transfers.
    // Both variants are supported by Vercel; explicit local callers retain the
    // owner/name variant when no trusted Actions ID is available.
    gitSource: repositoryId
      ? { type: "github", repoId: repositoryId, ref: "main", sha }
      : { type: "github", org, repo, ref: "main", sha },
    // Staged exactly like manual recovery: only the guarded promotion below may
    // switch production traffic, never Vercel's automatic domain assignment.
    autoAssignCustomDomains: false,
  });
  if (!DEPLOYMENT_ID.test(created.id ?? "") || created.id === production?.id) {
    throw new Error("Vercel did not return a new deployment identifier");
  }
  console.log(`Staging production deployment ${created.id} for ${sha}`);
  async function guard() {
    const current = await vercel(`/v9/projects/${encodeURIComponent(project.id)}`);
    const pin = describeProductionPin(current);
    if (pin) {
      throw new DeployWithheld("paused", `Promotion withheld because ${pin}; \`${created.id}\` stays staged.`);
    }
    const currentId = current.targets?.production?.id;
    if (!currentId || currentId === created.id || currentId === production?.id) return;
    // Production changed during the build (for example a manual promotion).
    const moved = await readDeploymentAt(vercel, currentId);
    const position = compareWithProduction(git, sha, moved);
    if (position !== "newer" && position !== "recoverable") {
      throw new DeployWithheld("skipped",
        `Production moved to \`${moved.sha ?? moved.id}\` during the build; \`${created.id}\` stays staged and \`${sha}\` was not promoted.`);
    }
  }
  const deployment = await promoteStagedProductionDeployment({
    vercel,
    projectId: project.id,
    deploymentId: created.id,
    verifyDeployment: (candidate) =>
      verifyStagedDeployment(candidate, { id: created.id, projectId: project.id, sha, repository }),
    guard,
    deploymentQuery: GIT_INFO,
    sleep,
    maxAttempts,
  });
  return { id: created.id, url: deployment.url };
}

function formatFiles(files) {
  const shown = files.slice(0, 10).map((file) => `\`${file}\``).join(", ");
  return files.length > 10 ? `${shown} (+${files.length - 10} more)` : shown;
}

function describeWorkerRun(worker) {
  return `\`${worker.sha}\`${worker.url ? ` (${worker.url})` : ""}`;
}

export async function deployVercelProduction({
  env = process.env,
  fetchImpl = globalThis.fetch,
  cwd = process.cwd(),
  sleep,
  maxAttempts = 180,
} = {}) {
  const git = createGit({ cwd });
  const event = env.GITHUB_EVENT_NAME?.trim();
  const workerRun = { sha: env.WORKER_RUN_HEAD_SHA?.trim(), url: env.WORKER_RUN_URL?.trim() };
  if (event === "workflow_run") {
    // The workflow only runs this after a successful push-triggered rollout.
    if (env.WORKER_RUN_EVENT?.trim() !== "push" || env.WORKER_RUN_CONCLUSION?.trim() !== "success") {
      throw new Error("Deploy Web only follows successful push-triggered worker runs");
    }
    if (!SHA.test(workerRun.sha ?? "")) throw new Error("WORKER_RUN_HEAD_SHA must be a full Git commit SHA");
  } else if (event !== "push" && event !== "workflow_dispatch") {
    throw new Error(`Deploy Web does not handle the ${event || "unknown"} event`);
  }

  const { repository, projectId, scope } = requireReleaseTarget(env);
  const repositoryId = env.GITHUB_REPOSITORY_ID?.trim();
  if (repositoryId && !/^[1-9]\d*$/.test(repositoryId)) {
    throw new Error("GITHUB_REPOSITORY_ID must be a numeric GitHub repository ID");
  }
  const requestedSha = env.WEB_DEPLOY_SHA?.trim();
  const upperBound = env.GITHUB_SHA?.trim();
  if (event === "workflow_dispatch") {
    if (!SHA.test(requestedSha ?? "")) throw new Error("The sha input must be a full 40-character commit SHA");
    if (!git.hasCommit(requestedSha) || !git.isAncestor(requestedSha, "HEAD")) {
      throw new Error(`${requestedSha} is not a commit on main`);
    }
  } else if (!SHA.test(upperBound ?? "") || !git.hasCommit(upperBound)) {
    throw new Error("GITHUB_SHA must be a checked-out commit");
  }

  const request = createApiRequest(fetchImpl, [env.VERCEL_TOKEN, env.GITHUB_TOKEN]);
  const vercel = createVercelRequest({ request, token: env.VERCEL_TOKEN, scope, label: "Vercel production deploy" });
  try {
    const project = await loadVercelProject(vercel, projectId, scope);
    const pin = describeProductionPin(project);
    if (pin) {
      throw new DeployWithheld("paused", `CI does not promote while ${pin}.`, [
        "Undo the rollback in Vercel (Undo Rollback, or promote the deployment you want); CI resumes on the next push, worker rollout, or Deploy Web dispatch.",
      ]);
    }
    const production = project.targets?.production?.id
      ? await readDeploymentAt(vercel, project.targets.production.id)
      : null;
    const servingProduction = production?.readyState === "READY" ? production : null;
    console.log(servingProduction
      ? `Production serves ${production.sha ?? "an unknown commit"} (${production.id})`
      : production
        ? `Production target ${production.id} ended in ${production.readyState}; retaining its commit ordering boundary`
        : "Production serves nothing yet");

    let sha = requestedSha;
    const details = [];
    let isWebPath;
    if (event === "workflow_dispatch") {
      requireNewerThanProduction(git, sha, production);
      details.push("Trigger: manual dispatch (the worker rollout check is bypassed).");
    } else {
      requireNewerThanProduction(git, upperBound, production);
      // A successful worker rollout synchronizes Vercel build env. Source
      // diffs cannot prove its freshness, so only pushes may skip a rebuild.
      if (event === "push") {
        isWebPath = await readWebBuildPathFilter(cwd);
        if (!hasWebBuildChanges(git, servingProduction, upperBound, isWebPath)) {
          throw new DeployWithheld("skipped", `No web build inputs changed since production \`${production.sha}\`; \`${upperBound}\` does not require a web rebuild.`);
        }
      }
      const isWorkerPath = compileWorkflowPathFilter(
        readWorkflowPushPaths(await readFile(join(cwd, WORKER_WORKFLOW_PATH), "utf8")),
      );
      const worker = event === "push"
        ? await findLatestWorkerRollout(request, env.GITHUB_TOKEN, repository, {
          git, newestWorkerCommit: findNewestWorkerPathCommit(git, upperBound, isWorkerPath), sleep: sleep ?? defaultSleep,
        })
        : workerRun;
      if (!git.hasCommit(worker.sha)) {
        throw new Error(`Rolled-out worker commit ${worker.sha} is not in the checked-out main history`);
      }
      console.log(`Latest successful worker rollout: ${worker.sha}${worker.url ? ` (${worker.url})` : ""}`);
      const found = findNewestDeployableCommit({
        git, upperBound, production: servingProduction, workerSha: worker.sha, isWorkerPath,
      });
      if (!found.sha) {
        // upperBound is newer than production, so at least one commit was checked.
        const { pending } = found;
        throw new DeployWithheld("deferred", pending.unrelated
          ? `\`${pending.sha}\` is not a descendant of the rolled-out worker commit, so its worker compatibility is unproven.`
          : `\`${pending.sha}\` contains worker-path changes that are not rolled out yet.`, [
          `Latest successful worker rollout: ${describeWorkerRun(worker)}.`,
          ...(pending.workerFiles.length ? [`Worker-path changes still pending: ${formatFiles(pending.workerFiles)}.`] : []),
          ...(worker.note ? [worker.note] : []),
          "Deploy Web runs again when Deploy Temporal Worker completes and then deploys the newest commit whose worker changes are live.",
          MANUAL_RECOVERY,
        ]);
      }
      sha = found.sha;
      requireNewerThanProduction(git, sha, production);
      details.push(event === "push"
        ? `Trigger: push of \`${upperBound}\`; latest successful worker rollout ${describeWorkerRun(worker)}.`
        : `Trigger: successful Deploy Temporal Worker for ${describeWorkerRun(worker)}.`);
      if (sha !== upperBound) {
        details.push(`Newer commits up to \`${upperBound}\` wait for their own worker rollout.`);
        if (worker.note) details.push(worker.note);
      }
      if (event === "workflow_run") {
        details.push("The worker rollout synchronized Vercel build environment values; a new deployment applies them even when web source inputs are unchanged.");
        if (sha !== worker.sha) {
          details.push(`Rolled forward from \`${worker.sha}\`: the commits after it change no worker paths.`);
        }
      }
      if (event === "push" && !hasWebBuildChanges(git, servingProduction, sha, isWebPath)) {
        throw new DeployWithheld("skipped", `No web build inputs changed in covered commit \`${sha}\`; production remains on \`${production.sha}\`.`, details);
      }
    }
    console.log(`Deploying ${sha} to web production`);
    const deployment = await stageAndPromote({
      vercel, git, project, production, sha, repository, repositoryId, sleep, maxAttempts,
    });
    return {
      status: "deployed",
      reason: `Deployed \`${sha}\` as \`${deployment.id}\`${deployment.url ? ` (https://${deployment.url})` : ""}.`,
      sha,
      deploymentId: deployment.id,
      details: [...details, `Replaced production ${production ? `\`${production.sha ?? production.id}\`` : "(none)"}.`],
    };
  } catch (error) {
    if (error instanceof DeployWithheld) {
      return { status: error.status, reason: error.message, details: error.details };
    }
    throw error;
  }
}

export function formatDeploySummary(result) {
  const lines = [`## ${TITLES[result.status]}`, "", `- ${result.reason}`];
  for (const detail of result.details ?? []) lines.push(`- ${detail}`);
  return `${lines.join("\n")}\n`;
}

function escapeCommandData(value) {
  return String(value).replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
}

async function main() {
  let result;
  try {
    result = await deployVercelProduction();
  } catch (error) {
    result = {
      status: "failed",
      reason: error instanceof Error ? error.message : String(error),
      details: [MANUAL_RECOVERY],
    };
    process.exitCode = 1;
  }
  const level = { failed: "error", paused: "warning" }[result.status] ?? "notice";
  console.log(`::${level} title=${TITLES[result.status]}::${escapeCommandData(result.reason)}`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY, formatDeploySummary(result));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
