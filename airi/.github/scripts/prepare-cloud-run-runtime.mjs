import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const DEFAULT_RUNTIMES = ["worker", "gateway", "otpWorker", "otpApi"];

export function resolveRealtimeDispatcherInstanceCount(env) {
  const value = String(env.GCP_REALTIME_DISPATCHER_INSTANCES || "1").trim();
  const count = Number(value);
  if (!/^(0|[1-9][0-9]*)$/.test(value) || !Number.isSafeInteger(count)) {
    throw new Error(
      "GCP_REALTIME_DISPATCHER_INSTANCES must be a nonnegative safe integer",
    );
  }
  if (
    count === 0 &&
    String(env.REALTIME_DISPATCHER_ENABLED || "")
      .trim()
      .toLowerCase() !== "true"
  ) {
    throw new Error(
      "Retiring the standalone dispatcher requires REALTIME_DISPATCHER_ENABLED=true",
    );
  }
  return count;
}

export function deriveRequestsProjectionRuntime(metadata) {
  if (metadata?.state === "disabled") {
    return { writerEnabled: false, realtimeEnabled: false };
  }
  if (metadata?.state === "shadow") {
    return { writerEnabled: true, realtimeEnabled: false };
  }
  if (metadata?.state === "live") {
    return { writerEnabled: true, realtimeEnabled: true };
  }
  throw new Error("Requests read-model metadata state is invalid");
}

function parseArgs(argv) {
  const args = {
    manifest: ".github/cloud-run/runtime-manifest.json",
    outDir: process.env.RUNNER_TEMP
      ? path.join(process.env.RUNNER_TEMP, "cloud-run-config")
      : path.join(process.cwd(), ".cloud-run-config"),
    skipSecretSync: process.env.CLOUD_RUN_SKIP_SECRET_SYNC === "1",
    runtimes: [],
  };

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--manifest") {
      args.manifest = argv[index + 1];
      index += 1;
      continue;
    }

    if (arg === "--out-dir") {
      args.outDir = argv[index + 1];
      index += 1;
      continue;
    }

    if (arg === "--skip-secret-sync") {
      args.skipSecretSync = true;
      continue;
    }

    if (arg === "--runtime") {
      args.runtimes.push(argv[index + 1]);
      index += 1;
      continue;
    }
  }

  return args;
}

function normalizeRuntimes(values) {
  const requested = values
    .flatMap((value) => String(value || "").split(","))
    .map((value) => value.trim())
    .filter(Boolean);

  return requested.length > 0 ? requested : DEFAULT_RUNTIMES;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function isMissingEnvValue(value) {
  return value === undefined || value === null || value === "";
}

function normalizeEntry(rawEntry) {
  if (typeof rawEntry === "string") {
    return {
      name: rawEntry,
      source: rawEntry,
      secretId: rawEntry,
      optional: false,
      referenceWhenSkippingSync: false,
    };
  }

  return {
    name: rawEntry.name,
    source: rawEntry.source || rawEntry.name,
    secretId: rawEntry.secretId || rawEntry.name,
    optional: Boolean(rawEntry.optional),
    referenceWhenSkippingSync: Boolean(rawEntry.referenceWhenSkippingSync),
  };
}

function getRuntimeSection(manifest, runtimeKey) {
  const section = manifest[runtimeKey];
  if (!section || typeof section !== "object") {
    throw new Error(`Missing runtime section: ${runtimeKey}`);
  }
  return section;
}

function getRuntimeEntries(manifest, runtimeKey, entryKey) {
  return (getRuntimeSection(manifest, runtimeKey)[entryKey] || []).map(
    normalizeEntry,
  );
}

function getRuntimeFixedVars(manifest, runtimeKey) {
  const fixedVars = {
    ...(getRuntimeSection(manifest, runtimeKey).fixedVars || {}),
  };
  if (runtimeKey === "worker") {
    const metadata = getRuntimeSection(
      manifest,
      runtimeKey,
    ).requestsReadModelMetadata;
    if (!metadata) return fixedVars;
    const flags = deriveRequestsProjectionRuntime(metadata);
    fixedVars.REQUESTS_PROJECTION_WRITER_ENABLED = String(flags.writerEnabled);
    fixedVars.REQUESTS_PROJECTION_REALTIME_ENABLED = String(
      flags.realtimeEnabled,
    );
  }
  return fixedVars;
}

function assertUniqueEntries(entries, runtimeKey, entryKey) {
  const seen = new Set();

  for (const entry of entries) {
    if (seen.has(entry.name)) {
      throw new Error(
        `Duplicate ${entryKey} entry "${entry.name}" in runtime "${runtimeKey}"`,
      );
    }

    seen.add(entry.name);
  }
}

function assertRuntimeDoesNotShadowFixedVars(fixedVars, entries, runtimeKey) {
  for (const entry of entries) {
    if (Object.prototype.hasOwnProperty.call(fixedVars, entry.name)) {
      throw new Error(
        `Runtime "${runtimeKey}" defines ${entry.name} in both fixedVars and env entries`,
      );
    }
  }
}

function getRequiredEnv(name) {
  const value = process.env[name];
  if (isMissingEnvValue(value)) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function resolveEntryValue(entry) {
  const value = process.env[entry.source];
  if (isMissingEnvValue(value)) {
    if (entry.optional) {
      return null;
    }
    throw new Error(
      `Missing required runtime value for ${entry.name} from ${entry.source}`,
    );
  }
  return value;
}

function assertElevenLabsSttWebhookPair(runtimes) {
  if (
    !runtimes.some((runtime) => runtime === "worker" || runtime === "mediaApi")
  ) {
    return;
  }

  const hasWebhookId = !isMissingEnvValue(
    process.env.ELEVENLABS_STT_WEBHOOK_ID,
  );
  const hasWebhookSecret = !isMissingEnvValue(
    process.env.ELEVENLABS_STT_WEBHOOK_SECRET,
  );
  if (hasWebhookId !== hasWebhookSecret) {
    throw new Error(
      "ELEVENLABS_STT_WEBHOOK_ID and ELEVENLABS_STT_WEBHOOK_SECRET must be configured together",
    );
  }
}

function shouldReferenceSecret(entry, { skipSecretSync }) {
  const value = process.env[entry.source];
  if (!isMissingEnvValue(value)) {
    return true;
  }

  if (skipSecretSync && (!entry.optional || entry.referenceWhenSkippingSync)) {
    return true;
  }

  if (entry.optional) {
    return false;
  }

  resolveEntryValue(entry);
  return true;
}

function encodeEnvValue(value) {
  return String(value).replace(/\r?\n/g, "\\n");
}

function writeEnvFile(filePath, fixedVars, envEntries) {
  const lines = [];

  for (const [name, value] of Object.entries(fixedVars)) {
    lines.push(`${name}=${encodeEnvValue(value)}`);
  }

  for (const entry of envEntries) {
    const value = resolveEntryValue(entry);
    if (value === null) continue;
    lines.push(`${entry.name}=${encodeEnvValue(value)}`);
  }

  fs.writeFileSync(filePath, `${lines.join("\n")}\n`, "utf8");
}

function writeSecretsFile(filePath, secretEntries, options) {
  const lines = [];

  for (const entry of secretEntries) {
    if (!shouldReferenceSecret(entry, options)) continue;
    lines.push(`${entry.name}|${entry.source}|${entry.secretId}`);
  }

  fs.writeFileSync(filePath, `${lines.join("\n")}\n`, "utf8");
}

function runGcloud(args, options = {}) {
  const result = spawnSync("gcloud", args, {
    encoding: "utf8",
    ...options,
  });

  if (result.status !== 0) {
    const stderr = result.stderr?.trim();
    const stdout = result.stdout?.trim();
    throw new Error(
      `gcloud ${args.join(" ")} failed` +
        (stderr ? `: ${stderr}` : stdout ? `: ${stdout}` : ""),
    );
  }

  return result;
}

function formatSecretSyncError(args, detail) {
  const joinedArgs = args.join(" ");
  const guidance = [
    `gcloud ${joinedArgs} failed`,
    detail,
    "To continue, choose one of these paths:",
    "1. Grant the GitHub deployer service account Secret Manager admin permissions so the workflow can create/update secrets.",
    "2. Precreate the required secrets in Google Secret Manager and set GitHub repo variable CLOUD_RUN_SKIP_SECRET_SYNC=1 so the workflow only references existing secrets.",
  ]
    .filter(Boolean)
    .join(" ");

  return guidance;
}

function ensureSecretExists(projectId, secretId) {
  const describe = spawnSync(
    "gcloud",
    ["secrets", "describe", secretId, `--project=${projectId}`],
    { encoding: "utf8", stdio: "ignore" },
  );

  if (describe.status === 0) {
    return;
  }

  const args = [
    "secrets",
    "create",
    secretId,
    `--project=${projectId}`,
    "--replication-policy=automatic",
    "--labels=managed-by=github-actions,managed-component=cloud-run",
  ];

  const result = spawnSync("gcloud", args, {
    encoding: "utf8",
  });

  if (result.status !== 0) {
    const stderr = result.stderr?.trim();
    const stdout = result.stdout?.trim();
    throw new Error(
      formatSecretSyncError(args, stderr ? `Details: ${stderr}` : stdout),
    );
  }
}

export function secretValuesEqual(currentValue, nextValue) {
  return String(currentValue ?? "") === String(nextValue ?? "");
}

export function selectSecretVersionsToDestroy(enabledVersionIds) {
  const versions = [...enabledVersionIds]
    .map((value) => String(value || "").trim())
    .filter((value) => /^\d+$/.test(value))
    .map((value) => Number.parseInt(value, 10))
    .filter((value) => Number.isFinite(value))
    .sort((left, right) => right - left);

  if (versions.length <= 1) {
    return [];
  }

  return versions.slice(1).map(String);
}

function accessLatestSecretValue(projectId, secretId) {
  const args = [
    "secrets",
    "versions",
    "access",
    "latest",
    `--secret=${secretId}`,
    `--project=${projectId}`,
  ];
  const result = spawnSync("gcloud", args, {
    encoding: "utf8",
  });

  if (result.status === 0) {
    return { ok: true, value: result.stdout ?? "" };
  }

  const detail = `${result.stderr || ""}\n${result.stdout || ""}`;
  if (/NOT_FOUND|could not find|No versions|has no versions/i.test(detail)) {
    return { ok: false, value: null };
  }

  throw new Error(
    formatSecretSyncError(
      args,
      detail.trim() ? `Details: ${detail.trim()}` : "",
    ),
  );
}

function listEnabledSecretVersionIds(projectId, secretId) {
  const args = [
    "secrets",
    "versions",
    "list",
    secretId,
    `--project=${projectId}`,
    "--filter=state=enabled",
    "--format=value(name)",
  ];
  const result = spawnSync("gcloud", args, {
    encoding: "utf8",
  });

  if (result.status !== 0) {
    const stderr = result.stderr?.trim();
    const stdout = result.stdout?.trim();
    throw new Error(
      formatSecretSyncError(args, stderr ? `Details: ${stderr}` : stdout),
    );
  }

  return String(result.stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function destroySecretVersion(projectId, secretId, versionId) {
  const args = [
    "secrets",
    "versions",
    "destroy",
    versionId,
    `--secret=${secretId}`,
    `--project=${projectId}`,
    "--quiet",
  ];
  const result = spawnSync("gcloud", args, {
    encoding: "utf8",
  });

  if (result.status !== 0) {
    const detail = `${result.stderr || ""}\n${result.stdout || ""}`;
    if (/already DESTROYED|NOT_FOUND|does not exist/i.test(detail)) {
      return;
    }
    throw new Error(
      formatSecretSyncError(
        args,
        detail.trim() ? `Details: ${detail.trim()}` : "",
      ),
    );
  }
}

function pruneOldSecretVersions(projectId, secretId) {
  const enabled = listEnabledSecretVersionIds(projectId, secretId);
  const toDestroy = selectSecretVersionsToDestroy(enabled);
  for (const versionId of toDestroy) {
    destroySecretVersion(projectId, secretId, versionId);
  }
  return toDestroy.length;
}

function addSecretVersion(projectId, secretId, value) {
  const args = [
    "secrets",
    "versions",
    "add",
    secretId,
    `--project=${projectId}`,
    "--data-file=-",
  ];

  const result = spawnSync("gcloud", args, {
    encoding: "utf8",
    input: value,
  });

  if (result.status !== 0) {
    const stderr = result.stderr?.trim();
    const stdout = result.stdout?.trim();
    throw new Error(
      formatSecretSyncError(args, stderr ? `Details: ${stderr}` : stdout),
    );
  }
}

function syncSecretVersion(projectId, secretId, value) {
  const latest = accessLatestSecretValue(projectId, secretId);
  if (latest.ok && secretValuesEqual(latest.value, value)) {
    const pruned = pruneOldSecretVersions(projectId, secretId);
    if (pruned > 0) {
      console.log(
        `Secret ${secretId}: unchanged; destroyed ${pruned} old enabled version(s)`,
      );
    } else {
      console.log(`Secret ${secretId}: unchanged; skipped version add`);
    }
    return { added: false, pruned };
  }

  addSecretVersion(projectId, secretId, value);
  const pruned = pruneOldSecretVersions(projectId, secretId);
  console.log(
    `Secret ${secretId}: added version; destroyed ${pruned} old enabled version(s)`,
  );
  return { added: true, pruned };
}

function syncSecrets(projectId, runtimeEntries) {
  const seenSecretIds = new Set();

  for (const entry of runtimeEntries) {
    const value = resolveEntryValue(entry);
    if (value === null || seenSecretIds.has(entry.secretId)) {
      continue;
    }

    ensureSecretExists(projectId, entry.secretId);
    syncSecretVersion(projectId, entry.secretId, value);
    seenSecretIds.add(entry.secretId);
  }
}

function toSetSecretsArg(secretEntries, options) {
  return secretEntries
    .filter((entry) => shouldReferenceSecret(entry, options))
    .map((entry) => `${entry.name}=${entry.secretId}:latest`)
    .join(",");
}

function writeMetadataFile(filePath, payload) {
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf8");
}

function main() {
  const args = parseArgs(process.argv);
  const manifest = readJson(args.manifest);
  const outDir = path.resolve(args.outDir);
  const projectId = getRequiredEnv("GCP_PROJECT_ID");

  ensureDir(outDir);

  const runtimes = normalizeRuntimes(args.runtimes);
  assertElevenLabsSttWebhookPair(runtimes);
  const metadata = {};
  const allSecretEntries = [];

  for (const runtimeKey of runtimes) {
    const fixedVars = getRuntimeFixedVars(manifest, runtimeKey);
    const envEntries = getRuntimeEntries(manifest, runtimeKey, "vars");
    const secretEntries = getRuntimeEntries(manifest, runtimeKey, "secrets");

    assertUniqueEntries(envEntries, runtimeKey, "vars");
    assertUniqueEntries(secretEntries, runtimeKey, "secrets");
    assertRuntimeDoesNotShadowFixedVars(fixedVars, envEntries, runtimeKey);

    const envFile = path.join(outDir, `${runtimeKey}.env`);
    const secretsFile = path.join(outDir, `${runtimeKey}.secrets`);

    writeEnvFile(envFile, fixedVars, envEntries);
    writeSecretsFile(secretsFile, secretEntries, {
      skipSecretSync: args.skipSecretSync,
    });

    metadata[runtimeKey] = {
      envFile,
      secretsFile,
      envNames: [
        ...Object.keys(fixedVars),
        ...envEntries.map((entry) => entry.name),
      ],
      secretNames: secretEntries.map((entry) => entry.name),
      setSecretsArg: toSetSecretsArg(secretEntries, {
        skipSecretSync: args.skipSecretSync,
      }),
    };

    allSecretEntries.push(...secretEntries);
  }

  if (!args.skipSecretSync) {
    syncSecrets(projectId, allSecretEntries);
  }

  const metadataFile = path.join(outDir, "metadata.json");
  writeMetadataFile(metadataFile, metadata);

  console.log(
    JSON.stringify(
      {
        outDir,
        metadataFile,
        workerEnvFile: metadata.worker?.envFile,
        gatewayEnvFile: metadata.gateway?.envFile,
        otpWorkerEnvFile: metadata.otpWorker?.envFile,
        otpApiEnvFile: metadata.otpApi?.envFile,
        realtimeGatewayEnvFile: metadata.realtimeGateway?.envFile,
        realtimeDispatcherEnvFile: metadata.realtimeDispatcher?.envFile,
      },
      null,
      2,
    ),
  );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main();
}
