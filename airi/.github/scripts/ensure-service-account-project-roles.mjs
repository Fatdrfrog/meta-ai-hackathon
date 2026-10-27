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
    const existing = args[key];
    if (existing === undefined) {
      args[key] = next;
    } else if (Array.isArray(existing)) {
      existing.push(next);
    } else {
      args[key] = [existing, next];
    }
    index += 1;
  }
  return args;
}

function getRequiredArg(args, name) {
  const value = String(args[name] || "").trim();
  if (!value) {
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

function toList(value) {
  const values = Array.isArray(value) ? value : [value];
  return values
    .flatMap((item) => String(item || "").split(","))
    .map((item) => item.trim())
    .filter(Boolean);
}

export function normalizeServiceAccountMember(serviceAccount) {
  const value = String(serviceAccount || "").trim();
  if (!value) {
    throw new Error("Missing service account email.");
  }
  return value.startsWith("serviceAccount:")
    ? value
    : `serviceAccount:${value}`;
}

export function buildProjectRoleIamCommands(input) {
  const projectId = String(input.projectId || "").trim();
  if (!projectId) {
    throw new Error("Missing Google Cloud project id.");
  }

  const member = normalizeServiceAccountMember(input.serviceAccount);
  const roles = [...new Set(toList(input.roles))];
  if (roles.length === 0) {
    throw new Error("At least one IAM role is required.");
  }

  return roles.map((role) => [
    "projects",
    "add-iam-policy-binding",
    projectId,
    `--member=${member}`,
    `--role=${role}`,
    "--condition=None",
  ]);
}

export function buildProjectRoleIamFailureMessage(failedCommand, commands) {
  const manualCommands = commands
    .map((command) => `gcloud ${command.join(" ")}`)
    .join("\n");

  return [
    `Failed to grant project IAM binding: ${failedCommand.join(" ")}`,
    "The runtime service account must have the project-level role required by the Google API it calls.",
    "Required deployer permissions include resourcemanager.projects.getIamPolicy and resourcemanager.projects.setIamPolicy.",
    "Either grant the deployer a project IAM admin/custom equivalent, or run these commands as a project IAM admin:",
    manualCommands,
    "After the bindings exist, pass --skip-iam or set GCP_SKIP_PROJECT_IAM_BINDINGS=1 if the deployer should not manage project IAM.",
  ].join("\n");
}

export function parseProjectRoleIamCommand(command) {
  const projectId = command[2];
  const member = command
    .find((part) => part.startsWith("--member="))
    ?.slice("--member=".length);
  const role = command
    .find((part) => part.startsWith("--role="))
    ?.slice("--role=".length);

  if (!projectId || !member || !role) {
    throw new Error(`Invalid project IAM command: ${command.join(" ")}`);
  }

  return { projectId, member, role };
}

export function projectRoleBindingExistsInPolicy(policy, command) {
  const { member, role } = parseProjectRoleIamCommand(command);
  return Boolean(
    policy?.bindings?.some(
      (binding) =>
        binding?.role === role &&
        !binding.condition &&
        Array.isArray(binding.members) &&
        binding.members.includes(member),
    ),
  );
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

function runGcloud(args) {
  const invocation = resolveGcloudInvocation(args);
  return spawnSync(invocation.command, invocation.args, {
    encoding: "utf8",
    stdio: "inherit",
    shell: false,
  });
}

function readProjectIamPolicy(projectId) {
  const invocation = resolveGcloudInvocation([
    "projects",
    "get-iam-policy",
    projectId,
    "--format=json",
  ]);
  const result = spawnSync(invocation.command, invocation.args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
  });

  if (result.status !== 0 || result.error) {
    return null;
  }

  return JSON.parse(result.stdout);
}

function grantIamBindings(commands, options = {}) {
  if (commands.length === 0) return;
  if (options.skip) {
    console.warn(
      [
        "Skipping project IAM binding management by request.",
        "This is safe only if these bindings already exist:",
        ...commands.map((command) => `gcloud ${command.join(" ")}`),
      ].join("\n"),
    );
    return;
  }

  const policyByProject = new Map();

  for (const command of commands) {
    const { projectId, member, role } = parseProjectRoleIamCommand(command);
    if (!policyByProject.has(projectId)) {
      policyByProject.set(projectId, readProjectIamPolicy(projectId));
    }

    const policy = policyByProject.get(projectId);
    if (projectRoleBindingExistsInPolicy(policy, command)) {
      console.info(
        `Project IAM binding already exists; skipping mutation for ${member} ${role}.`,
      );
      continue;
    }

    const result = runGcloud(command);
    if (result.error) {
      throw new Error(`Failed to run gcloud: ${result.error.message}`);
    }
    if (result.status !== 0) {
      throw new Error(buildProjectRoleIamFailureMessage(command, commands));
    }
  }
}

function main() {
  const args = parseArgs(process.argv);
  const commands = buildProjectRoleIamCommands({
    projectId: getRequiredArg(args, "project"),
    serviceAccount:
      args["service-account"] || process.env.GCP_RUNTIME_SERVICE_ACCOUNT,
    roles: args.role || process.env.GCP_PROJECT_IAM_ROLES,
  });

  grantIamBindings(commands, {
    skip:
      readBooleanFlag(args["skip-iam"]) ||
      readBooleanFlag(process.env.GCP_SKIP_PROJECT_IAM_BINDINGS),
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
