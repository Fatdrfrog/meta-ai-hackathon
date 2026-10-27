import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const DEFAULT_ATTEMPTS = 5;
const DEFAULT_BASE_DELAY_MS = 2_000;
const DEFAULT_MAX_DELAY_MS = 15_000;
const MAX_ATTEMPTS = 10;

const RETRYABLE_ERROR_MARKERS = [
  "unable to retrieve identity pool subject token",
  "upstream connect error",
  "disconnect/reset before headers",
  "reset reason: overflow",
  "connection reset",
  "socket hang up",
  "econnreset",
  "unavailable",
  "deadline exceeded",
  "temporarily unavailable",
  "http 429",
  "http 500",
  "http 502",
  "http 503",
  "http 504",
];

function parsePositiveInteger(
  value,
  fallback,
  maximum = Number.MAX_SAFE_INTEGER,
) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, maximum);
}

function normalizeCommandError(result) {
  const stderr = String(result?.stderr || "").trim();
  const errorMessage = result?.error?.message
    ? String(result.error.message).trim()
    : "";
  return (
    stderr || errorMessage || `gcloud exited with status ${result?.status}`
  );
}

function runGcloudAccessTokenProbe() {
  return spawnSync("gcloud", ["auth", "print-access-token", "--quiet"], {
    encoding: "utf8",
    windowsHide: true,
  });
}

function runGcloud(args) {
  return spawnSync("gcloud", args, { encoding: "utf8", windowsHide: true });
}

function hashIdentity(value) {
  return createHash("sha256").update(String(value)).digest("hex").slice(0, 16);
}

function sleep(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function defaultLog(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

export function isRetryableGcloudAuthError(error) {
  const normalized = String(error || "").toLowerCase();
  return RETRYABLE_ERROR_MARKERS.some((marker) => normalized.includes(marker));
}

export async function verifyGcloudAuth(options = {}) {
  const attempts = parsePositiveInteger(
    options.attempts ?? process.env.GCLOUD_AUTH_RETRY_ATTEMPTS,
    DEFAULT_ATTEMPTS,
    MAX_ATTEMPTS,
  );
  const baseDelayMs = parsePositiveInteger(
    options.baseDelayMs ?? process.env.GCLOUD_AUTH_RETRY_BASE_DELAY_MS,
    DEFAULT_BASE_DELAY_MS,
  );
  const maxDelayMs = parsePositiveInteger(
    options.maxDelayMs ?? process.env.GCLOUD_AUTH_RETRY_MAX_DELAY_MS,
    DEFAULT_MAX_DELAY_MS,
  );
  const run = options.run || runGcloudAccessTokenProbe;
  const wait = options.wait || sleep;
  const log = options.log || defaultLog;
  const expectedAccount = options.expectedAccount ?? process.env.GCP_EXPECTED_ACTIVE_ACCOUNT;
  const expectedProject = options.expectedProject ?? process.env.GCP_EXPECTED_PROJECT;
  const startedAt = Date.now();
  const event = {
    timestamp: new Date(startedAt).toISOString(),
    event: "gcloud.auth.probe",
    service: "deploy-temporal-worker",
    githubRunId: process.env.GITHUB_RUN_ID || null,
    githubRunAttempt: process.env.GITHUB_RUN_ATTEMPT || null,
    commitSha: process.env.GITHUB_SHA || null,
    attemptsConfigured: attempts,
    attemptsUsed: 0,
    retryCount: 0,
    retryDelaysMs: [],
    outcome: "error",
    errorCategory: null,
  };

  try {
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      event.attemptsUsed = attempt;
      const result = run();
      if (result?.status === 0) {
        if (expectedAccount || expectedProject) {
          const accounts = options.runAccounts || (() => runGcloud(["auth", "list", "--filter=status:ACTIVE", "--format=value(account)"]));
          const accountResult = accounts();
          const activeAccounts = String(accountResult?.stdout || "").trim().split(/\r?\n/).filter(Boolean);
          if (expectedAccount && (activeAccounts.length !== 1 || activeAccounts[0] !== expectedAccount)) throw new Error("gcloud active account mismatch");
          const project = options.runProject || (() => runGcloud(["config", "get-value", "project"]));
          const projectResult = project();
          if (expectedProject && String(projectResult?.stdout || "").trim() !== expectedProject) throw new Error("gcloud project mismatch");
          event.identityHash = hashIdentity(`${activeAccounts[0] || ""}:${String(projectResult?.stdout || "").trim()}`);
        }
        event.outcome = "success";
        return { attemptsUsed: attempt };
      }

      const commandError = normalizeCommandError(result);
      const retryable = isRetryableGcloudAuthError(commandError);
      event.errorCategory = retryable ? "transient" : "permanent";

      if (!retryable) {
        throw new Error(`gcloud authentication probe failed: ${commandError}`);
      }
      if (attempt === attempts) {
        throw new Error(
          `gcloud authentication probe failed after ${attempts} attempts: ${commandError}`,
        );
      }

      const delayMs = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
      event.retryCount += 1;
      event.retryDelaysMs.push(delayMs);
      await wait(delayMs);
    }

    throw new Error("gcloud authentication probe exhausted unexpectedly");
  } finally {
    event.durationMs = Date.now() - startedAt;
    log(event);
  }
}

async function main() {
  await verifyGcloudAuth();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
