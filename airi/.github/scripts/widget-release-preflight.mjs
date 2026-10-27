#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import { createApiRequest, createVercelRequest, DEPLOYMENT_ID, SHA } from "./redeploy-vercel-production.mjs";

export async function inspectWidgetRelease({ env = process.env, fetchImpl = fetch } = {}) {
  const projectId = env.VERCEL_WIDGET_PROJECT_ID?.trim();
  const teamId = env.VERCEL_TEAM_ID?.trim();
  const repository = env.GITHUB_REPOSITORY?.trim();
  const token = env.VERCEL_TOKEN?.trim();
  if (!/^prj_[a-zA-Z0-9]+$/.test(projectId ?? "") ||
      !/^team_[a-zA-Z0-9]+$/.test(teamId ?? "") ||
      !/^[\w.-]+\/[\w.-]+$/.test(repository ?? "") || !token) {
    throw new Error("Widget project, team, repository and Vercel credential are required");
  }
  const vercel = createVercelRequest({
    request: createApiRequest(fetchImpl, [token]), token,
    scope: { teamId }, label: "Widget release preflight",
  });
  const project = await vercel(`/v9/projects/${encodeURIComponent(projectId)}`);
  const link = project.link;
  if (project.id !== projectId || project.accountId !== teamId || !project.name ||
      link?.type !== "github" ||
      `${link.org}/${link.repo}`.toLowerCase() !== repository.toLowerCase()) {
    throw new Error("Widget project does not match the configured account and repository");
  }
  if (typeof project.autoAssignCustomDomains !== "boolean") {
    throw new Error("Vercel did not report an explicit automatic domain assignment setting");
  }
  const deploymentId = project.targets?.production?.id;
  if (!DEPLOYMENT_ID.test(deploymentId ?? "")) {
    throw new Error("Widget project has no verified current production deployment");
  }
  const deployment = await vercel(`/v13/deployments/${deploymentId}?withGitRepoInfo=true`);
  const sha = deployment.meta?.githubCommitSha ?? deployment.gitSource?.sha;
  if (deployment.id !== deploymentId ||
      (deployment.projectId ?? deployment.project?.id) !== projectId ||
      deployment.target !== "production" || !SHA.test(sha ?? "")) {
    throw new Error("Widget production deployment identity could not be verified");
  }
  return {
    accountId: project.accountId,
    project: { id: project.id, name: project.name },
    repository: { type: link.type, owner: link.org, name: link.repo, id: link.repoId ?? null },
    autoAssignCustomDomains: project.autoAssignCustomDomains,
    production: {
      id: deployment.id, sha,
      ref: deployment.meta?.githubCommitRef ?? deployment.gitSource?.ref ?? null,
      state: deployment.readyState ?? null,
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  inspectWidgetRelease().then(
    (result) => console.log(JSON.stringify(result, null, 2)),
    (error) => { console.error(error.message); process.exitCode = 1; },
  );
}
