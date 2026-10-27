import assert from "node:assert/strict";
import test from "node:test";
import { inspectWidgetRelease } from "./widget-release-preflight.mjs";

const env = {
  VERCEL_TOKEN: "private-token",
  VERCEL_WIDGET_PROJECT_ID: "prj_widget",
  VERCEL_TEAM_ID: "team_owner",
  GITHUB_REPOSITORY: "owner/repo",
};
const sha = "a".repeat(40);

function fixture({ project = {}, deployment = {} } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, ...init });
    assert.equal(init.method, "GET", "preflight must never write");
    assert.equal(init.body, undefined);
    const parsed = new URL(url);
    assert.equal(parsed.origin, "https://api.vercel.com");
    assert.equal(parsed.searchParams.get("teamId"), "team_owner");
    if (parsed.pathname === "/v9/projects/prj_widget") return Response.json({
      id: "prj_widget", name: "widget", accountId: "team_owner",
      autoAssignCustomDomains: false,
      link: { type: "github", org: "owner", repo: "repo", repoId: 123 },
      targets: { production: { id: "dpl_current" } },
      env: [{ value: "private-environment-value" }],
      ...project,
    });
    assert.equal(parsed.pathname, "/v13/deployments/dpl_current");
    return Response.json({
      id: "dpl_current", projectId: "prj_widget", target: "production",
      readyState: "READY", meta: { githubCommitSha: sha, githubCommitRef: "main", private: "hidden" },
      ...deployment,
    });
  };
  return { calls, options: { env, fetchImpl } };
}

for (const autoAssignCustomDomains of [false, true]) {
  test(`reports the exact ${autoAssignCustomDomains} setting without changing it or exposing unrelated fields`, async () => {
    const { options, calls } = fixture({ project: { autoAssignCustomDomains } });
    assert.deepEqual(await inspectWidgetRelease(options), {
      accountId: "team_owner", project: { id: "prj_widget", name: "widget" },
      repository: { type: "github", owner: "owner", name: "repo", id: 123 },
      autoAssignCustomDomains,
      production: { id: "dpl_current", sha, ref: "main", state: "READY" },
    });
    assert.equal(calls.length, 2);
  });
}

for (const [name, project] of [
  ["wrong project", { id: "prj_other" }],
  ["wrong account", { accountId: "team_other" }],
  ["wrong repository", { link: { type: "github", org: "other", repo: "repo" } }],
  ["missing setting", { autoAssignCustomDomains: undefined }],
  ["non-boolean setting", { autoAssignCustomDomains: "false" }],
  ["missing production", { targets: {} }],
]) {
  test(`refuses an unverified baseline: ${name}`, async () => {
    const { options, calls } = fixture({ project });
    await assert.rejects(inspectWidgetRelease(options));
    assert.equal(calls.length, 1);
  });
}

for (const deployment of [
  { id: "dpl_other" }, { projectId: "prj_other" }, { target: "preview" },
  { meta: { githubCommitSha: "unknown", githubCommitRef: "main" } },
]) {
  test(`refuses mismatched production identity: ${JSON.stringify(deployment)}`, async () => {
    const { options } = fixture({ deployment });
    await assert.rejects(inspectWidgetRelease(options), /production deployment/);
  });
}

test("validates configuration before contacting Vercel", async () => {
  for (const key of Object.keys(env)) {
    const { options, calls } = fixture();
    options.env = { ...env, [key]: "" };
    await assert.rejects(inspectWidgetRelease(options));
    assert.equal(calls.length, 0);
  }
});
