import { appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

function parseArgs(argv) {
  const args = {};
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
      continue;
    }
    args[key] = next;
    index += 1;
  }
  return args;
}

function requiredArg(args, name) {
  const value = String(args[name] || "").trim();
  if (!value) {
    throw new Error(`Missing required --${name}`);
  }
  return value;
}

export function readBooleanFlag(value) {
  if (value === true) return true;
  const normalized = String(value || "").trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

export function buildNetworkUri(projectId, network) {
  const value = String(network || "").trim();
  if (value.startsWith("projects/")) return value;
  return `projects/${projectId}/global/networks/${value || "default"}`;
}

export function buildPscAutoConnectionsArg(projectId, networkUri) {
  return `network=${networkUri},projectId=${projectId}`;
}

export function buildDescribeCommand({ projectId, location, instance, format }) {
  const command = [
    "memorystore",
    "instances",
    "describe",
    instance,
    `--project=${projectId}`,
    `--location=${location}`,
  ];
  if (format) command.push(`--format=${format}`);
  return command;
}

export function buildCreateCommand({
  projectId,
  location,
  instance,
  pscAutoConnections,
}) {
  return [
    "memorystore",
    "instances",
    "create",
    instance,
    `--project=${projectId}`,
    `--location=${location}`,
    `--psc-auto-connections=${pscAutoConnections}`,
    "--mode=cluster-disabled",
    // Realtime pub/sub fanout fits the smallest SLA-eligible, cluster-disabled tier.
    // Routine deploys only resolve the existing instance; bootstrap owns creation.
    "--node-type=custom-pico",
    "--shard-count=1",
    "--replica-count=0",
  ];
}

export function classifyGcloudError(stderr) {
  const text = String(stderr || "");
  if (
    text.includes("SERVICE_DISABLED") ||
    text.includes("has not been used in project") ||
    text.includes("is disabled")
  ) {
    return "service_disabled";
  }
  if (text.includes("NOT_FOUND") || text.includes("Resource not found")) {
    return "not_found";
  }
  if (text.includes("PERMISSION_DENIED")) {
    return "permission_denied";
  }
  return "unknown";
}

export function buildServiceDisabledMessage(projectId) {
  return [
    "Memorystore API is disabled for this project.",
    `Enable it once before deploying: gcloud services enable memorystore.googleapis.com networkconnectivity.googleapis.com --project=${projectId}`,
    "Do this from an owner/IAM-admin account, or set GCP_ENABLE_REQUIRED_APIS=true only if the GitHub deployer is allowed to enable Google Cloud services.",
  ].join("\n");
}

export function buildMissingInstanceMessage({ instance, location }) {
  return [
    `Memorystore Valkey instance '${instance}' was not found in '${location}'.`,
    "Normal deploy does not create billable infra by default.",
    "Create the instance manually/bootstrap it, or set GCP_VALKEY_CREATE_IF_MISSING=true for an explicit infra bootstrap run.",
  ].join("\n");
}

export function extractEndpoint(instance) {
  const candidates = [
    ...(instance?.endpoints || []).flatMap((endpoint) => [
      ...(endpoint?.connections || []).map(
        (connection) => connection?.pscAutoConnection,
      ),
      ...(endpoint?.discoveryEndpoints || []),
    ]),
    ...(instance?.discoveryEndpoints || []),
  ];

  for (const candidate of candidates) {
    const host = candidate?.ipAddress || candidate?.address;
    if (host) {
      return {
        host,
        port: String(candidate?.port || 6379),
      };
    }
  }

  return null;
}

function runGcloud(args) {
  return spawnSync("gcloud", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
  });
}

function commandText(args) {
  return `gcloud ${args.join(" ")}`;
}

function throwGcloudError(prefix, args, result) {
  const stderr = String(result.stderr || "").trim();
  throw new Error(`${prefix}: ${commandText(args)}${stderr ? `\n${stderr}` : ""}`);
}

async function waitForActive({ projectId, location, instance, maxAttempts }) {
  let lastJson = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const command = buildDescribeCommand({
      projectId,
      location,
      instance,
      format: "json",
    });
    const result = runGcloud(command);
    if (result.status !== 0) {
      throwGcloudError("Failed to describe Memorystore Valkey instance", command, result);
    }

    const json = JSON.parse(result.stdout || "{}");
    lastJson = json;
    if (json.state === "ACTIVE") {
      return json;
    }

    await new Promise((resolve) => setTimeout(resolve, 10_000));
  }

  throw new Error(
    `Memorystore Valkey instance '${instance}' did not become ACTIVE. Last state: ${lastJson?.state || "unknown"}`,
  );
}

function writeOutputs(outputPath, outputs) {
  const lines = Object.entries(outputs)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  if (outputPath) {
    appendFileSync(outputPath, `${lines}\n`);
    return;
  }
  console.log(lines);
}

async function main() {
  const args = parseArgs(process.argv);
  const projectId = requiredArg(args, "project");
  const location = requiredArg(args, "location");
  const instance = requiredArg(args, "instance");
  const network = requiredArg(args, "network");
  const createIfMissing = readBooleanFlag(args["create-if-missing"]);
  const maxAttempts = Number.parseInt(String(args["max-attempts"] || "90"), 10);

  const describeCommand = buildDescribeCommand({
    projectId,
    location,
    instance,
    format: "json",
  });
  const describe = runGcloud(describeCommand);
  let instanceJson = null;

  if (describe.status === 0) {
    instanceJson = JSON.parse(describe.stdout || "{}");
  } else {
    const kind = classifyGcloudError(describe.stderr);
    if (kind === "service_disabled") {
      throw new Error(buildServiceDisabledMessage(projectId));
    }
    if (kind !== "not_found") {
      throwGcloudError(
        "Failed to describe Memorystore Valkey instance",
        describeCommand,
        describe,
      );
    }
    if (!createIfMissing) {
      throw new Error(buildMissingInstanceMessage({ instance, location }));
    }

    const networkUri = buildNetworkUri(projectId, network);
    const createCommand = buildCreateCommand({
      projectId,
      location,
      instance,
      pscAutoConnections: buildPscAutoConnectionsArg(projectId, networkUri),
    });
    console.log(
      `Creating Memorystore Valkey instance '${instance}' in '${location}' on network '${networkUri}'.`,
    );
    const create = runGcloud(createCommand);
    if (create.status !== 0) {
      const kind = classifyGcloudError(create.stderr);
      if (kind === "service_disabled") {
        throw new Error(buildServiceDisabledMessage(projectId));
      }
      throwGcloudError(
        "Failed to create Memorystore Valkey. If this is the first private service in the project, create a service connection policy for the network and rerun",
        createCommand,
        create,
      );
    }

    instanceJson = await waitForActive({
      projectId,
      location,
      instance,
      maxAttempts,
    });
  }

  if (instanceJson.state !== "ACTIVE") {
    instanceJson = await waitForActive({
      projectId,
      location,
      instance,
      maxAttempts,
    });
  }

  const endpoint = extractEndpoint(instanceJson);
  if (!endpoint) {
    throw new Error(
      `Could not resolve a Memorystore Valkey endpoint for '${instance}'.\n${JSON.stringify(instanceJson, null, 2)}`,
    );
  }

  writeOutputs(args["github-output"], {
    instance,
    location,
    network,
    host: endpoint.host,
    port: endpoint.port,
  });
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
