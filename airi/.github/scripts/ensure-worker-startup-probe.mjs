import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

// gcloud has no startup-probe flag for worker pools, so the probe is set on
// the pool spec with `worker-pools replace`. A rollout stops the previous
// instances once the new ones pass their startup check; the worker opens the
// probe port only when fully started, so consumers never pause on deploy.

/** Cloud Run caps a TCP startup probe at failureThreshold * periodSeconds. */
export const TCP_STARTUP_PROBE_MAX_SECONDS = 240;

const PROBE_DEFAULTS = {
  initialDelaySeconds: 0,
  timeoutSeconds: 1,
  periodSeconds: 10,
  failureThreshold: 3,
};

// Fields `describe --format=export` leaves out; `replace` takes that shape.
const OUTPUT_ONLY_METADATA = [
  "creationTimestamp",
  "generation",
  "resourceVersion",
  "selfLink",
  "uid",
];
const CLIENT_ANNOTATIONS = [
  "run.googleapis.com/client-name",
  "run.googleapis.com/client-version",
  "run.googleapis.com/operation-id",
  "serving.knative.dev/creator",
  "serving.knative.dev/lastModifier",
];

function parseArgs(argv) {
  const args = {};
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      args[key] = true;
      continue;
    }
    args[key] = next;
    index += 1;
  }
  return args;
}

function getRequiredArg(args, name) {
  const value = String(args[name] ?? "").trim();
  if (!value || args[name] === true) {
    throw new Error(`Missing required --${name}`);
  }
  return value;
}

function readBooleanFlag(value) {
  if (value === true) return true;
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function readPositiveInteger(value, name, fallback) {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`--${name} must be a positive integer; got '${value}'`);
  }
  return parsed;
}

export function buildWorkerStartupProbe(input) {
  const port = Number(input.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(
      `Startup probe port must be a TCP port; got '${input.port}'`,
    );
  }
  const periodSeconds = input.periodSeconds ?? 2;
  const failureThreshold = input.failureThreshold ?? 120;
  const timeoutSeconds = input.timeoutSeconds ?? 1;
  if (timeoutSeconds > periodSeconds) {
    throw new Error("Startup probe timeout cannot exceed its period.");
  }
  if (periodSeconds * failureThreshold > TCP_STARTUP_PROBE_MAX_SECONDS) {
    throw new Error(
      `A TCP startup probe may wait at most ${TCP_STARTUP_PROBE_MAX_SECONDS} s; ` +
        `${failureThreshold} x ${periodSeconds} s is longer.`,
    );
  }
  return {
    tcpSocket: { port },
    initialDelaySeconds: 0,
    timeoutSeconds,
    periodSeconds,
    failureThreshold,
  };
}

/** The `describe --format=json` result in the shape `replace` accepts. */
export function toReplaceableWorkerPool(described) {
  const { status: _status, ...pool } = structuredClone(described || {});
  const metadata = { ...(pool.metadata || {}) };
  for (const field of OUTPUT_ONLY_METADATA) delete metadata[field];
  if (metadata.annotations) {
    metadata.annotations = Object.fromEntries(
      Object.entries(metadata.annotations).filter(
        ([key]) => !CLIENT_ANNOTATIONS.includes(key),
      ),
    );
  }
  pool.metadata = metadata;
  return pool;
}

function normalizeProbe(probe) {
  return {
    port: Number(probe?.tcpSocket?.port ?? NaN),
    otherHandler: Boolean(probe?.httpGet || probe?.grpc),
    initialDelaySeconds:
      probe?.initialDelaySeconds ?? PROBE_DEFAULTS.initialDelaySeconds,
    timeoutSeconds: probe?.timeoutSeconds ?? PROBE_DEFAULTS.timeoutSeconds,
    periodSeconds: probe?.periodSeconds ?? PROBE_DEFAULTS.periodSeconds,
    failureThreshold:
      probe?.failureThreshold ?? PROBE_DEFAULTS.failureThreshold,
  };
}

function probesMatch(actual, desired) {
  return (
    JSON.stringify(normalizeProbe(actual)) ===
    JSON.stringify(normalizeProbe(desired))
  );
}

/**
 * Decides whether the pool spec needs the probe added, changed or removed.
 * Returns the spec to replace with, or action "unchanged".
 */
export function planWorkerStartupProbe(pool, input) {
  const containers = pool?.spec?.template?.spec?.containers;
  if (!Array.isArray(containers) || containers.length !== 1) {
    throw new Error(
      `Expected exactly one worker container; found ${Array.isArray(containers) ? containers.length : "none"}.`,
    );
  }
  const current = containers[0].startupProbe;
  if (!input.enabled) {
    if (!current) return { action: "unchanged", pool };
    const next = structuredClone(pool);
    delete next.spec.template.spec.containers[0].startupProbe;
    return { action: "removed", pool: next };
  }
  if (current && probesMatch(current, input.probe)) {
    return { action: "unchanged", pool };
  }
  const next = structuredClone(pool);
  next.spec.template.spec.containers[0].startupProbe = input.probe;
  return { action: current ? "updated" : "added", pool: next };
}

export function buildWorkerPoolCommands(input) {
  return {
    describe: [
      "beta",
      "run",
      "worker-pools",
      "describe",
      input.workerPool,
      `--project=${input.projectId}`,
      `--region=${input.region}`,
      "--format=json",
    ],
    // `replace` takes no --region flag; it reads the run/region property
    // (and the spec's location label). Its request validates the spec before
    // anything changes. No --dry-run: gcloud 574.0.0 then polls an operation
    // that does not exist, forever, even with --async.
    replace: (file) => [
      "beta",
      "run",
      "worker-pools",
      "replace",
      file,
      `--project=${input.projectId}`,
    ],
    replaceEnv: {
      CLOUDSDK_RUN_REGION: input.region,
      // gcloud's debug log records the parsed spec, env values included.
      CLOUDSDK_CORE_DISABLE_FILE_LOGGING: "True",
    },
  };
}

function resolveGcloudInvocation(args) {
  if (process.platform !== "win32") {
    return { command: "gcloud", args };
  }

  const where = spawnSync("where.exe", ["gcloud.ps1"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    shell: false,
  });
  const launcher = String(where.stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (!launcher) {
    return { command: "gcloud", args };
  }

  return {
    command: "powershell.exe",
    args: [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      launcher,
      ...args,
    ],
  };
}

function runGcloud(args, options = {}) {
  const invocation = resolveGcloudInvocation(args);
  const result = spawnSync(invocation.command, invocation.args, {
    encoding: "utf8",
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    shell: false,
    env: options.env ? { ...process.env, ...options.env } : process.env,
  });
  if (result.status !== 0 || result.error) {
    const stderr = String(result.stderr || result.error?.message || "").trim();
    throw new Error(
      `gcloud ${args.slice(0, 4).join(" ")} failed` +
        (stderr ? `: ${stderr}` : ""),
    );
  }
  return result.stdout;
}

/** Reads the pool, then adds, updates or removes the probe when it drifted. */
export function ensureWorkerStartupProbe(input, options = {}) {
  const gcloud = options.runGcloud || runGcloud;
  const log = options.log || console.log;
  const commands = buildWorkerPoolCommands(input);
  const described = JSON.parse(
    gcloud(commands.describe, { capture: true }) || "{}",
  );
  const pool = toReplaceableWorkerPool(described);
  const location = pool.metadata?.labels?.["cloud.googleapis.com/location"];
  if (location && location !== input.region) {
    throw new Error(
      `Worker pool '${input.workerPool}' is in ${location}, not ${input.region}.`,
    );
  }
  const plan = planWorkerStartupProbe(pool, {
    enabled: input.enabled,
    probe: input.probe,
  });
  log(
    `Worker pool '${input.workerPool}' startup probe: ${plan.action}` +
      (input.enabled ? ` (tcp ${input.probe.tcpSocket.port})` : " (disabled)"),
  );
  if (plan.action === "unchanged") return plan.action;

  // The spec carries env values and secret references; keep it off the log,
  // and in RUNNER_TEMP, which Actions empties even if this step is killed.
  const directory = mkdtempSync(
    path.join(process.env.RUNNER_TEMP || os.tmpdir(), "worker-pool-"),
  );
  const file = path.join(directory, "worker-pool.json");
  try {
    writeFileSync(file, JSON.stringify(plan.pool), { mode: 0o600 });
    gcloud(commands.replace(file), { env: commands.replaceEnv });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  return plan.action;
}

function main() {
  const args = parseArgs(process.argv);
  ensureWorkerStartupProbe({
    projectId: getRequiredArg(args, "project"),
    region: getRequiredArg(args, "region"),
    workerPool: getRequiredArg(args, "worker-pool"),
    enabled: readBooleanFlag(args.enabled),
    probe: buildWorkerStartupProbe({
      port: getRequiredArg(args, "port"),
      periodSeconds: readPositiveInteger(
        args["period-seconds"],
        "period-seconds",
        2,
      ),
      failureThreshold: readPositiveInteger(
        args["failure-threshold"],
        "failure-threshold",
        120,
      ),
      timeoutSeconds: readPositiveInteger(
        args["timeout-seconds"],
        "timeout-seconds",
        1,
      ),
    }),
  });
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
