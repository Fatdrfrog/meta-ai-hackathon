#!/usr/bin/env node

import { appendFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
  appendVercelScope,
  deriveVercelProjectIdOrName,
  deriveVercelTeamSlug,
} from "./sync-vercel-runtime-env.mjs";

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const SHA = /^[a-f0-9]{40}$/;
export const DEPLOYMENT_ID = /^dpl_[a-zA-Z0-9]+$/;

// Only bounded provider error fields reach logs; bodies, headers and arbitrary
// metadata stay private. Both release credentials are removed if echoed.
function safeProviderDiagnostic(value, secrets, limit) {
  if (typeof value !== "string") return "";
  let safe = value;
  for (const secret of secrets.filter((secret) => typeof secret === "string" && secret)) {
    safe = safe.replaceAll(secret, "[REDACTED]");
  }
  return safe
    .replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g, "[REDACTED]")
    .replace(/\bhttps?:\/\/[^\s<>"']+/gi, "[URL]")
    .replace(/\bBearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/["']?\b((?:access[_-]?)?token|password|secret|api[_-]?key|authorization)["']?\s*[:=]\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;]+)/gi, "$1=[REDACTED]")
    .replace(/\b(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]+/g, "[REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[REDACTED]")
    .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "[EMAIL]")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim().slice(0, limit);
}

export function createApiRequest(fetchImpl, secrets = []) {
  return async function request(url, token, label, body, emptySuccessStatuses) {
    let response;
    try {
      response = await fetchImpl(url, {
        method: body ? "POST" : "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new Error(`${label} request failed`);
    }
    if (!response.ok) {
      let diagnostic = "";
      try {
        const provider = (await response.json())?.error;
        const redactions = [...secrets, token];
        const code = safeProviderDiagnostic(provider?.code, redactions, 80);
        const message = safeProviderDiagnostic(provider?.message, redactions, 500);
        diagnostic = [code, message].filter(Boolean).join(": ");
      } catch {
        // An HTML response or parser exception must not hide the HTTP failure.
      }
      throw new Error(`${label} failed with HTTP ${response.status}${diagnostic ? ` (${diagnostic})` : ""}`);
    }
    if (emptySuccessStatuses) {
      if (!emptySuccessStatuses.includes(response.status)) {
        throw new Error(`${label} returned unexpected HTTP ${response.status}`);
      }
      return;
    }
    try {
      return await response.json();
    } catch {
      throw new Error(`${label} returned invalid JSON`);
    }
  };
}

// The release repository, Vercel project and team, and credentials both
// production scripts require.
export function requireReleaseTarget(env) {
  const repository = env.GITHUB_REPOSITORY?.trim();
  const projectId = deriveVercelProjectIdOrName({
    projectId: env.VERCEL_PROJECT_ID,
    projectName: env.VERCEL_PROJECT_NAME,
    oidcSubjects: env.AI_GATEWAY_VERCEL_OIDC_SUBJECTS,
  });
  const scope = {
    teamId: env.VERCEL_TEAM_ID?.trim(),
    teamSlug: deriveVercelTeamSlug({
      teamSlug: env.VERCEL_TEAM_SLUG,
      oidcAudience: env.AI_GATEWAY_VERCEL_OIDC_AUDIENCE,
      oidcIssuerUrl: env.AI_GATEWAY_VERCEL_OIDC_ISSUER_URL,
    }),
  };
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository || "")) {
    throw new Error("GITHUB_REPOSITORY must identify the release repository");
  }
  if (!projectId || !(scope.teamId || scope.teamSlug)) {
    throw new Error("A configured Vercel project and team are required");
  }
  if (!env.VERCEL_TOKEN?.trim() || !env.GITHUB_TOKEN?.trim()) {
    throw new Error("Vercel and GitHub credentials are required");
  }
  return { repository, projectId, scope };
}

export function createVercelRequest({ request, token, scope, label }) {
  return (path, body, emptySuccessStatuses) => request(
    appendVercelScope(new URL(path, "https://api.vercel.com"), scope).toString(),
    token,
    label,
    body,
    emptySuccessStatuses,
  );
}

export async function loadVercelProject(vercel, projectId, scope) {
  const project = await vercel(`/v9/projects/${encodeURIComponent(projectId)}`);
  if (!project.id || !project.name ||
      (scope.teamId && project.accountId !== scope.teamId)) {
    throw new Error("Vercel project does not match the configured team");
  }
  return project;
}

// The deployment was created with automatic domain assignment disabled; `guard` runs on every poll and again
// immediately before the only request that can switch production traffic.
export async function promoteStagedProductionDeployment({
  vercel,
  projectId,
  deploymentId,
  verifyDeployment,
  guard,
  deploymentQuery = "",
  sleep = defaultSleep,
  maxAttempts = 120,
}) {
  let promotionRequested = false;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    // If superseded, leave the staged artifact unpromoted. No cancellation or
    // rollback is needed to protect the currently serving deployment.
    await guard();
    const deployment = await vercel(`/v13/deployments/${deploymentId}${deploymentQuery}`);
    verifyDeployment(deployment);
    if (!promotionRequested && deployment.autoAssignCustomDomains !== false) {
      throw new Error(`Production deployment ${deploymentId} did not confirm disabled automatic domain assignment`);
    }
    if (deployment.aliasError) {
      throw new Error(`Production deployment ${deploymentId} failed to assign its aliases`);
    }
    // BLOCKED never starts a build (account limits or policy), so it is terminal.
    if (["ERROR", "CANCELED", "BLOCKED"].includes(deployment.readyState)) {
      throw new Error(`Production deployment ${deploymentId} ended in ${deployment.readyState}`);
    }
    if (deployment.readyState === "READY") {
      if (!promotionRequested) {
        // Recheck after the final build read, immediately before the only
        // operation that can switch production traffic. These APIs cannot
        // atomically compare the guard state with Vercel's promotion request.
        await guard();
        await vercel(`/v10/projects/${encodeURIComponent(projectId)}/promote/${deploymentId}`, {}, [201, 202]);
        promotionRequested = true;
      } else if (deployment.aliasAssigned === true) {
        const currentProject = await vercel(`/v9/projects/${encodeURIComponent(projectId)}`);
        if (currentProject.targets?.production?.id === deploymentId) {
          // Detect a concurrent change during promotion instead of reporting an
          // obsolete release as successful or rolling back a newer release.
          await guard();
          return deployment;
        }
      }
    }
    if (attempt + 1 < maxAttempts) await sleep(10_000);
  }
  throw new Error(`Production deployment ${deploymentId} did not become READY with assigned aliases before timeout`);
}

// The runtime sync's env upsert cannot rebuild an existing release, so
// deployment recovery lives here.
export async function redeployVercelProduction({
  env = process.env,
  fetchImpl = globalThis.fetch,
  sleep,
  maxAttempts,
} = {}) {
  const deploymentId = env.VERCEL_REDEPLOY_ID?.trim();
  const expectedSha = env.VERCEL_REDEPLOY_EXPECTED_SHA?.trim();
  if (!DEPLOYMENT_ID.test(deploymentId || "")) {
    throw new Error("VERCEL_REDEPLOY_ID must identify an existing deployment");
  }
  if (!SHA.test(expectedSha || "")) {
    throw new Error("VERCEL_REDEPLOY_EXPECTED_SHA must be a full Git commit SHA");
  }
  const { repository, projectId, scope } = requireReleaseTarget(env);

  const request = createApiRequest(fetchImpl, [env.VERCEL_TOKEN, env.GITHUB_TOKEN]);
  const vercel = createVercelRequest({
    request,
    token: env.VERCEL_TOKEN,
    scope,
    label: "Vercel deployment recovery",
  });
  const project = await loadVercelProject(vercel, projectId, scope);
  function verifyRelease(deployment, id) {
    const meta = deployment.meta || {};
    if (deployment.id !== id ||
        (deployment.projectId || deployment.project?.id) !== project.id ||
        deployment.target !== "production" ||
        meta.githubCommitRef !== "main" ||
        meta.githubCommitSha !== expectedSha ||
        `${meta.githubCommitOrg}/${meta.githubCommitRepo}`.toLowerCase() !== repository.toLowerCase()) {
      throw new Error("Deployment must match the configured production project, repository, and exact main commit");
    }
  }
  verifyRelease(await vercel(`/v13/deployments/${deploymentId}`), deploymentId);
  async function verifyCurrentMain() {
    const main = await request(
      `https://api.github.com/repos/${repository}/git/ref/heads/main`,
      env.GITHUB_TOKEN,
      "GitHub main verification",
    );
    if (main.object?.sha !== expectedSha) {
      throw new Error("Expected deployment commit is no longer the current main commit");
    }
  }
  await verifyCurrentMain();
  const created = await vercel("/v13/deployments?forceNew=1", {
    name: project.name,
    project: project.id,
    deploymentId,
    target: "production",
    withLatestCommit: false,
    // This is the same request field used by Vercel CLI --prod --skip-domain.
    // Production environment values are retained, but the build cannot replace
    // production domains while main may advance during its build.
    autoAssignCustomDomains: false,
  });
  if (!DEPLOYMENT_ID.test(created.id || "") || created.id === deploymentId) {
    throw new Error("Vercel did not return a new deployment identifier");
  }
  console.log(`Staging production deployment ${created.id} from ${expectedSha}`);
  const deployment = await promoteStagedProductionDeployment({
    vercel,
    projectId: project.id,
    deploymentId: created.id,
    verifyDeployment: (candidate) => verifyRelease(candidate, created.id),
    guard: verifyCurrentMain,
    sleep,
    maxAttempts,
  });
  return { id: created.id, url: deployment.url, sha: expectedSha };
}

async function main() {
  const result = await redeployVercelProduction();
  console.log(`Production deployment READY: ${result.id} (${result.sha})`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY,
      `## Web production redeployed\n\n- Deployment: \`${result.id}\`\n- Commit: \`${result.sha}\`\n- Status: READY\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
