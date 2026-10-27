import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import test from "node:test";

const repoRoot = new URL("../../", import.meta.url);

// Formats of live credentials that must be revoked if they ever reach git.
// Each pattern is specific enough that a match is a real key, not a fixture.
const CREDENTIAL_PATTERNS = [
  ["Supabase personal access token", /\bsbp_[0-9a-f]{40}\b/],
  ["Stripe live key", /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}/],
  [
    "GitHub token",
    /\b(?:ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9]{36}\b|\bgithub_pat_[A-Za-z0-9_]{50,}/,
  ],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["Anthropic API key", /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ["OpenAI API key", /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}/],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["Slack token", /\bxox[baprs]-[A-Za-z0-9-]{10,}/],
];

const JWT = /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g;
const BINARY_FILE = /\.(?:png|jpe?g|gif|webp|ico|mp4|webm|woff2?|ttf|otf|pdf|zip|gz)$/i;
const MAX_FILE_BYTES = 5 * 1024 * 1024;

function isServiceRoleJwt(token) {
  try {
    const payload = JSON.parse(
      Buffer.from(token.split(".")[1], "base64url").toString("utf8"),
    );
    return payload?.role === "service_role";
  } catch {
    return false;
  }
}

// Names the credential kind and location only, so a failure never prints the key.
export function findCredentials(text) {
  const findings = [];
  text.split(/\r?\n/).forEach((line, index) => {
    for (const [kind, pattern] of CREDENTIAL_PATTERNS) {
      if (pattern.test(line)) findings.push({ line: index + 1, kind });
    }
    for (const [token] of line.matchAll(JWT)) {
      if (isServiceRoleJwt(token)) {
        findings.push({ line: index + 1, kind: "Supabase service_role JWT" });
      }
    }
  });
  return findings;
}

function trackedFiles() {
  return execFileSync("git", ["ls-files", "-z"], {
    cwd: repoRoot,
    maxBuffer: 256 * 1024 * 1024,
  })
    .toString("utf8")
    .split("\0")
    .filter(path => path && !BINARY_FILE.test(path) && path !== "pnpm-lock.yaml");
}

test("tracked files contain no live credentials", () => {
  const findings = [];
  for (const path of trackedFiles()) {
    const file = new URL(path, repoRoot);
    let size;
    try {
      size = statSync(file).size;
    } catch {
      continue; // deleted in the working tree
    }
    if (size > MAX_FILE_BYTES) continue;
    for (const { line, kind } of findCredentials(readFileSync(file, "utf8"))) {
      findings.push(`${path}:${line} (${kind})`);
    }
  }
  assert.deepEqual(
    findings,
    [],
    "Revoke each credential first; removing it from git does not remove it from history. Then read it from the environment instead.",
  );
});

// Samples are built at runtime so this file never contains a key-shaped literal.
test("credential patterns recognise the leaked formats", () => {
  const supabaseToken = `sbp_${"0123456789abcdef".repeat(3).slice(0, 40)}`;
  assert.deepEqual(findCredentials(`"SUPABASE_ACCESS_TOKEN": "${supabaseToken}"`), [
    { line: 1, kind: "Supabase personal access token" },
  ]);

  const encode = value => Buffer.from(JSON.stringify(value)).toString("base64url");
  const jwt = role =>
    `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ role, iss: "supabase" })}.${"s".repeat(43)}`;
  assert.deepEqual(findCredentials(`key=${jwt("service_role")}`), [
    { line: 1, kind: "Supabase service_role JWT" },
  ]);
  assert.deepEqual(findCredentials(`key=${jwt("anon")}`), []);

  assert.deepEqual(
    findCredentials('"SUPABASE_ACCESS_TOKEN": "${env:SUPABASE_ACCESS_TOKEN}"'),
    [],
  );
});
