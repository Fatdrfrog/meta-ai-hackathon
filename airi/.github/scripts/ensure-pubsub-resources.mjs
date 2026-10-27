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
    if (key in args) {
      args[key] = Array.isArray(args[key])
        ? [...args[key], next]
        : [args[key], next];
    } else {
      args[key] = next;
    }
    index += 1;
  }
  return args;
}

function getRequiredArg(args, name) {
  const rawValue = Array.isArray(args[name]) ? args[name].at(-1) : args[name];
  const value = String(rawValue || "").trim();
  if (!value) {
    throw new Error(`Missing required --${name}`);
  }
  return value;
}

function getArgValues(args, name) {
  const rawValue = args[name];
  return (Array.isArray(rawValue) ? rawValue : [rawValue])
    .map((value) => String(value || "").trim())
    .filter(Boolean);
}

function readBooleanFlag(value) {
  if (value === true) return true;
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function readMessageRetentionDuration(input) {
  const value = String(input?.messageRetentionDuration || "").trim();
  if (!value) return "";

  normalizeMessageRetentionDuration(value);
  return value;
}

function normalizeMessageRetentionDuration(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (!normalized) return "";
  if (normalized === "default") return "604800s";

  const match = /^(\d+)([smhd]?)$/.exec(normalized);
  if (!match) {
    throw new Error(
      "Pub/Sub message retention duration must use INTEGER[s|m|h|d].",
    );
  }

  const unitSeconds = { "": 1, s: 1, m: 60, h: 3600, d: 86400 };
  return `${Number(match[1]) * unitSeconds[match[2]]}s`;
}

// Exactly-once stays the default; latency-sensitive lanes opt out explicitly.
function readExactlyOnceDelivery(input) {
  return input?.exactlyOnceDelivery !== false;
}

// Ordering stays the default; an unordered lane must keep order in the app.
function readMessageOrdering(input) {
  return input?.messageOrdering !== false;
}

function readAckDeadlineSeconds(input) {
  const value = input?.ackDeadlineSeconds;
  if (value === undefined || value === null || value === "") return null;
  const seconds = Number(value);
  if (!Number.isInteger(seconds) || seconds < 10 || seconds > 600) {
    throw new Error(
      "Pub/Sub ack deadline must be an integer from 10 to 600 seconds.",
    );
  }
  return seconds;
}

function exactlyOnceDeliveryFlag(input) {
  return readExactlyOnceDelivery(input)
    ? "--enable-exactly-once-delivery"
    : "--no-enable-exactly-once-delivery";
}

export function buildPubSubEnsureCommands(input) {
  const messageRetentionDuration = readMessageRetentionDuration(input);
  const ackDeadlineSeconds = readAckDeadlineSeconds(input);
  return [
    {
      describe: [
        "pubsub",
        "topics",
        "describe",
        input.topic,
        `--project=${input.projectId}`,
      ],
      create: [
        "pubsub",
        "topics",
        "create",
        input.topic,
        `--project=${input.projectId}`,
      ],
    },
    {
      describe: [
        "pubsub",
        "topics",
        "describe",
        input.dlqTopic,
        `--project=${input.projectId}`,
      ],
      create: [
        "pubsub",
        "topics",
        "create",
        input.dlqTopic,
        `--project=${input.projectId}`,
      ],
    },
    {
      describe: [
        "pubsub",
        "subscriptions",
        "describe",
        input.dlqSubscription,
        `--project=${input.projectId}`,
      ],
      create: [
        "pubsub",
        "subscriptions",
        "create",
        input.dlqSubscription,
        `--project=${input.projectId}`,
        `--topic=${input.dlqTopic}`,
      ],
    },
    {
      describe: [
        "pubsub",
        "subscriptions",
        "describe",
        input.subscription,
        `--project=${input.projectId}`,
      ],
      create: [
        "pubsub",
        "subscriptions",
        "create",
        input.subscription,
        `--project=${input.projectId}`,
        `--topic=${input.topic}`,
        ...(readMessageOrdering(input) ? ["--enable-message-ordering"] : []),
        ...(readExactlyOnceDelivery(input)
          ? ["--enable-exactly-once-delivery"]
          : []),
        `--dead-letter-topic=${input.dlqTopic}`,
        "--max-delivery-attempts=10",
        ...(ackDeadlineSeconds ? [`--ack-deadline=${ackDeadlineSeconds}`] : []),
        ...(messageRetentionDuration
          ? [`--message-retention-duration=${messageRetentionDuration}`]
          : []),
        ...(input?.neverExpire ? ["--expiration-period=never"] : []),
      ],
    },
  ];
}

export function buildPubSubServiceAgentEmail(projectNumber) {
  const value = String(projectNumber || "").trim();
  if (!value) {
    throw new Error(
      "Missing Google Cloud project number for Pub/Sub service agent.",
    );
  }
  return `service-${value}@gcp-sa-pubsub.iam.gserviceaccount.com`;
}

export function buildPubSubDeadLetterIamCommands(input) {
  const serviceAgent = buildPubSubServiceAgentEmail(input.projectNumber);
  const member = `serviceAccount:${serviceAgent}`;
  return [
    [
      "pubsub",
      "topics",
      "add-iam-policy-binding",
      input.dlqTopic,
      `--project=${input.projectId}`,
      `--member=${member}`,
      "--role=roles/pubsub.publisher",
    ],
    [
      "pubsub",
      "subscriptions",
      "add-iam-policy-binding",
      input.subscription,
      `--project=${input.projectId}`,
      `--member=${member}`,
      "--role=roles/pubsub.subscriber",
    ],
  ];
}

export function buildPubSubSubscriberIamCommands(input) {
  const serviceAccount = String(input.serviceAccount || "").trim();
  if (!serviceAccount) return [];
  const member = serviceAccount.startsWith("serviceAccount:")
    ? serviceAccount
    : `serviceAccount:${serviceAccount}`;
  return [
    [
      "pubsub",
      "subscriptions",
      "add-iam-policy-binding",
      input.subscription,
      `--project=${input.projectId}`,
      `--member=${member}`,
      "--role=roles/pubsub.subscriber",
    ],
  ];
}

export function buildPubSubPublisherIamCommands(input) {
  const serviceAccounts = [
    ...(Array.isArray(input.serviceAccounts) ? input.serviceAccounts : []),
    input.serviceAccount,
  ]
    .map((value) => String(value || "").trim())
    .filter(Boolean);

  return [...new Set(serviceAccounts)].map((serviceAccount) => {
    const member = serviceAccount.startsWith("serviceAccount:")
      ? serviceAccount
      : `serviceAccount:${serviceAccount}`;
    return [
      "pubsub",
      "topics",
      "add-iam-policy-binding",
      input.topic,
      `--project=${input.projectId}`,
      `--member=${member}`,
      "--role=roles/pubsub.publisher",
    ];
  });
}

function readField(value, camelCaseName, snakeCaseName) {
  if (value?.[camelCaseName] !== undefined) return value[camelCaseName];
  return value?.[snakeCaseName];
}

// The REST/gcloud representation may omit a false protobuf scalar.
function hasMessageOrdering(subscription) {
  return (
    readField(
      subscription,
      "enableMessageOrdering",
      "enable_message_ordering",
    ) === true
  );
}

function hasExactlyOnceDelivery(subscription) {
  return (
    readField(
      subscription,
      "enableExactlyOnceDelivery",
      "enable_exactly_once_delivery",
    ) === true
  );
}

function hasAckDeadlineDrift(input, subscription) {
  const expected = readAckDeadlineSeconds(input);
  return (
    expected !== null &&
    Number(
      readField(subscription, "ackDeadlineSeconds", "ack_deadline_seconds"),
    ) !== expected
  );
}

// gcloud omits the TTL (or the whole policy) for a subscription that never expires.
function hasPersistentExpirationPolicy(subscription) {
  const policy = readField(
    subscription,
    "expirationPolicy",
    "expiration_policy",
  );
  return !String(readField(policy, "ttl", "ttl") || "").trim();
}

export function validatePubSubTopology(input, actual) {
  const expectedTopic = `projects/${input.projectId}/topics/${input.topic}`;
  const expectedDlqTopic = `projects/${input.projectId}/topics/${input.dlqTopic}`;
  const expectedSubscription = `projects/${input.projectId}/subscriptions/${input.subscription}`;
  const expectedDlqSubscription = `projects/${input.projectId}/subscriptions/${input.dlqSubscription}`;
  const deadLetterPolicy = readField(
    actual?.subscription,
    "deadLetterPolicy",
    "dead_letter_policy",
  );
  const expectedMessageRetentionDuration = readMessageRetentionDuration(input);
  const errors = [];

  if (actual?.topic?.name !== expectedTopic) {
    errors.push(`main topic must be ${expectedTopic}`);
  }
  if (actual?.dlqTopic?.name !== expectedDlqTopic) {
    errors.push(`DLQ topic must be ${expectedDlqTopic}`);
  }
  if (actual?.subscription?.name !== expectedSubscription) {
    errors.push(`main subscription must be ${expectedSubscription}`);
  }
  if (actual?.dlqSubscription?.name !== expectedDlqSubscription) {
    errors.push(`DLQ subscription must be ${expectedDlqSubscription}`);
  }
  if (actual?.subscription?.topic !== expectedTopic) {
    errors.push(`main subscription topic must be ${expectedTopic}`);
  }
  if (actual?.dlqSubscription?.topic !== expectedDlqTopic) {
    errors.push(`DLQ subscription topic must be ${expectedDlqTopic}`);
  }
  if (hasMessageOrdering(actual?.subscription) !== readMessageOrdering(input)) {
    errors.push(
      `main subscription message ordering must be ${readMessageOrdering(input) ? "enabled" : "disabled"}`,
    );
  }
  if (
    hasExactlyOnceDelivery(actual?.subscription) !==
    readExactlyOnceDelivery(input)
  ) {
    errors.push(
      `main subscription exactly-once delivery must be ${readExactlyOnceDelivery(input) ? "enabled" : "disabled"}`,
    );
  }
  if (hasAckDeadlineDrift(input, actual?.subscription)) {
    errors.push(
      `main subscription ack deadline must be ${readAckDeadlineSeconds(input)}s`,
    );
  }
  if (
    readField(deadLetterPolicy, "deadLetterTopic", "dead_letter_topic") !==
    expectedDlqTopic
  ) {
    errors.push(
      `main subscription dead-letter topic must be ${expectedDlqTopic}`,
    );
  }
  if (
    Number(
      readField(
        deadLetterPolicy,
        "maxDeliveryAttempts",
        "max_delivery_attempts",
      ),
    ) !== 10
  ) {
    errors.push("main subscription max delivery attempts must be 10");
  }
  if (
    expectedMessageRetentionDuration &&
    normalizeMessageRetentionDuration(
      readField(
        actual?.subscription,
        "messageRetentionDuration",
        "message_retention_duration",
      ),
    ) !== normalizeMessageRetentionDuration(expectedMessageRetentionDuration)
  ) {
    errors.push(
      `main subscription message retention duration must be ${expectedMessageRetentionDuration}`,
    );
  }
  if (
    input.neverExpire &&
    !hasPersistentExpirationPolicy(actual?.subscription)
  ) {
    errors.push("main subscription must never expire");
  }

  return errors;
}

export function buildPubSubMessageRetentionUpdateCommand(
  input,
  actualSubscription,
) {
  const expected = readMessageRetentionDuration(input);
  if (!expected) return null;

  const actual = readField(
    actualSubscription,
    "messageRetentionDuration",
    "message_retention_duration",
  );
  if (
    normalizeMessageRetentionDuration(actual) ===
    normalizeMessageRetentionDuration(expected)
  ) {
    return null;
  }

  return [
    "pubsub",
    "subscriptions",
    "update",
    input.subscription,
    `--project=${input.projectId}`,
    `--message-retention-duration=${expected}`,
  ];
}

export function buildPubSubDeliveryUpdateCommand(input, actualSubscription) {
  const flags = [];
  if (
    hasExactlyOnceDelivery(actualSubscription) !==
    readExactlyOnceDelivery(input)
  ) {
    flags.push(exactlyOnceDeliveryFlag(input));
  }
  if (hasAckDeadlineDrift(input, actualSubscription)) {
    flags.push(`--ack-deadline=${readAckDeadlineSeconds(input)}`);
  }
  if (flags.length === 0) return null;

  return [
    "pubsub",
    "subscriptions",
    "update",
    input.subscription,
    `--project=${input.projectId}`,
    ...flags,
  ];
}

export function buildPubSubExpirationUpdateCommand(input, actualSubscription) {
  if (!input.neverExpire || hasPersistentExpirationPolicy(actualSubscription)) {
    return null;
  }

  return [
    "pubsub",
    "subscriptions",
    "update",
    input.subscription,
    `--project=${input.projectId}`,
    "--expiration-period=never",
  ];
}

function formatGcloudCommand(command) {
  return `gcloud ${command.join(" ")}`;
}

export function buildPubSubTopologyRemediation(input, actual) {
  const expectedTopic = `projects/${input.projectId}/topics/${input.topic}`;
  const expectedDlqTopic = `projects/${input.projectId}/topics/${input.dlqTopic}`;
  const messageRetentionDuration = readMessageRetentionDuration(input);
  const ensureCommands = buildPubSubEnsureCommands(input);
  const subscription = actual?.subscription;
  const dlqSubscription = actual?.dlqSubscription;
  const deadLetterPolicy = readField(
    subscription,
    "deadLetterPolicy",
    "dead_letter_policy",
  );
  const messageOrderingDrift =
    Boolean(subscription) &&
    hasMessageOrdering(subscription) !== readMessageOrdering(input);
  const sourceTopicDrift =
    Boolean(subscription) && subscription.topic !== expectedTopic;
  const mainSubscriptionRequiresRecreate =
    messageOrderingDrift || sourceTopicDrift;
  const messageRetentionUpdate = buildPubSubMessageRetentionUpdateCommand(
    input,
    subscription,
  );
  const expirationUpdate = buildPubSubExpirationUpdateCommand(
    input,
    subscription,
  );
  const ackDeadlineSeconds = readAckDeadlineSeconds(input);
  const mutableSubscriptionDrift =
    Boolean(subscription) &&
    (Boolean(buildPubSubDeliveryUpdateCommand(input, subscription)) ||
      readField(deadLetterPolicy, "deadLetterTopic", "dead_letter_topic") !==
        expectedDlqTopic ||
      Number(
        readField(
          deadLetterPolicy,
          "maxDeliveryAttempts",
          "max_delivery_attempts",
        ),
      ) !== 10 ||
      Boolean(messageRetentionUpdate) ||
      Boolean(expirationUpdate));
  const guidance = [
    "This verifier does not run remediation commands. Review the affected production resource and obtain approval before running any command below.",
  ];

  if (actual?.topic?.name !== expectedTopic) {
    guidance.push(
      "Create or restore the expected main topic:",
      formatGcloudCommand(ensureCommands[0].create),
    );
  }
  if (actual?.dlqTopic?.name !== expectedDlqTopic) {
    guidance.push(
      "Create or restore the expected DLQ topic:",
      formatGcloudCommand(ensureCommands[1].create),
    );
  }
  if (mutableSubscriptionDrift && !mainSubscriptionRequiresRecreate) {
    guidance.push(
      "Apply only the reviewed mutable main-subscription settings:",
      formatGcloudCommand([
        "pubsub",
        "subscriptions",
        "update",
        input.subscription,
        `--project=${input.projectId}`,
        exactlyOnceDeliveryFlag(input),
        `--dead-letter-topic=${input.dlqTopic}`,
        "--max-delivery-attempts=10",
        ...(ackDeadlineSeconds ? [`--ack-deadline=${ackDeadlineSeconds}`] : []),
        ...(messageRetentionDuration
          ? [`--message-retention-duration=${messageRetentionDuration}`]
          : []),
        ...(input.neverExpire ? ["--expiration-period=never"] : []),
      ]),
    );
  }
  if (mainSubscriptionRequiresRecreate) {
    const recreateReasons = [];
    if (sourceTopicDrift) {
      recreateReasons.push("The main subscription source topic is immutable.");
    }
    if (messageOrderingDrift) {
      recreateReasons.push(
        "Message ordering is a creation-time setting and requires recreation.",
      );
    }
    guidance.push(
      recreateReasons.join(" "),
      "Obtain explicit production approval and drain or preserve pending messages before recreating the main subscription:",
      formatGcloudCommand([
        "pubsub",
        "subscriptions",
        "delete",
        input.subscription,
        `--project=${input.projectId}`,
      ]),
      formatGcloudCommand(ensureCommands[3].create),
    );
  }
  if (dlqSubscription && dlqSubscription.topic !== expectedDlqTopic) {
    guidance.push(
      "The DLQ subscription source topic is immutable. Obtain explicit production approval and drain or preserve pending messages before recreating it:",
      formatGcloudCommand([
        "pubsub",
        "subscriptions",
        "delete",
        input.dlqSubscription,
        `--project=${input.projectId}`,
      ]),
      formatGcloudCommand(ensureCommands[2].create),
    );
  }

  return guidance.join("\n");
}

export function assertPubSubTopology(input, actual) {
  const errors = validatePubSubTopology(input, actual);
  if (errors.length > 0) {
    throw new Error(
      [
        `Pub/Sub topology verification failed:\n- ${errors.join("\n- ")}`,
        buildPubSubTopologyRemediation(input, actual),
      ].join("\n\n"),
    );
  }
}

export function buildDeadLetterIamFailureMessage(failedCommand, commands) {
  const manualCommands = commands
    .map((command) => `gcloud ${command.join(" ")}`)
    .join("\n");

  return [
    `Failed to grant Pub/Sub dead-letter IAM binding: ${failedCommand.join(" ")}`,
    "The authenticated deployer must be allowed to read and update IAM policies on the Pub/Sub DLQ topic and worker subscription.",
    "Required permissions include pubsub.topics.getIamPolicy, pubsub.topics.setIamPolicy, pubsub.subscriptions.getIamPolicy, and pubsub.subscriptions.setIamPolicy.",
    "Either grant the deployer a role such as roles/pubsub.admin/custom equivalent, or run these one-time commands as a project owner/IAM admin:",
    manualCommands,
    "After the bindings exist, set the matching GitHub variable to skip this deploy-time IAM mutation if the deployer should not manage IAM.",
  ].join("\n");
}

export function buildSubscriberIamFailureMessage(failedCommand, commands) {
  const manualCommands = commands
    .map((command) => `gcloud ${command.join(" ")}`)
    .join("\n");

  return [
    `Failed to grant Pub/Sub subscriber IAM binding: ${failedCommand.join(" ")}`,
    "The worker runtime service account must be allowed to consume the worker subscription.",
    "Required permissions include pubsub.subscriptions.getIamPolicy and pubsub.subscriptions.setIamPolicy.",
    "Either grant the deployer a role such as roles/pubsub.admin/custom equivalent, or run these one-time commands as a project owner/IAM admin:",
    manualCommands,
    "After the bindings exist, set --skip-subscriber-iam or PUBSUB_SKIP_SUBSCRIBER_IAM=1 if the deployer should not manage IAM.",
  ].join("\n");
}

export function buildPublisherIamFailureMessage(failedCommand, commands) {
  const manualCommands = commands
    .map((command) => `gcloud ${command.join(" ")}`)
    .join("\n");

  return [
    `Failed to grant Pub/Sub publisher IAM binding: ${failedCommand.join(" ")}`,
    "The web/runtime service account must be allowed to publish to the Pub/Sub topic.",
    "Required permissions include pubsub.topics.getIamPolicy and pubsub.topics.setIamPolicy.",
    "Either grant the deployer a role such as roles/pubsub.admin/custom equivalent, or run these one-time commands as a project owner/IAM admin:",
    manualCommands,
    "After the bindings exist, set --skip-publisher-iam or PUBSUB_SKIP_PUBLISHER_IAM=1 if the deployer should not manage IAM.",
  ].join("\n");
}

export function parsePubSubIamCommand(command) {
  const resourceType = command[1];
  const resourceName = command[3];
  const projectId = command
    .find((part) => part.startsWith("--project="))
    ?.slice("--project=".length);
  const member = command
    .find((part) => part.startsWith("--member="))
    ?.slice("--member=".length);
  const role = command
    .find((part) => part.startsWith("--role="))
    ?.slice("--role=".length);

  if (
    command[0] !== "pubsub" ||
    command[2] !== "add-iam-policy-binding" ||
    (resourceType !== "topics" && resourceType !== "subscriptions") ||
    !resourceName ||
    !projectId ||
    !member ||
    !role
  ) {
    throw new Error(`Invalid Pub/Sub IAM command: ${command.join(" ")}`);
  }

  return { member, projectId, resourceName, resourceType, role };
}

export function pubSubIamBindingExistsInPolicy(policy, command) {
  const { member, role } = parsePubSubIamCommand(command);
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

function runGcloud(args, options = {}) {
  const invocation = resolveGcloudInvocation(args);
  return spawnSync(invocation.command, invocation.args, {
    encoding: "utf8",
    stdio: options.silent ? "ignore" : "inherit",
    shell: false,
  });
}

function ensureResource(command) {
  const describe = runGcloud(command.describe, { silent: true });
  if (describe.status === 0) return;

  const create = runGcloud(command.create);
  if (create.status !== 0) {
    throw new Error(
      `Failed to create Pub/Sub resource: ${command.create.join(" ")}`,
    );
  }
}

function readPubSubResource(command) {
  const invocation = resolveGcloudInvocation([
    ...command.describe,
    "--format=json",
  ]);
  const result = spawnSync(invocation.command, invocation.args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
  });

  if (result.status !== 0 || result.error) {
    const stderr = String(result.stderr || result.error?.message || "").trim();
    throw new Error(
      `Failed to describe Pub/Sub resource: ${command.describe.join(" ")}` +
        (stderr ? `: ${stderr}` : ""),
    );
  }

  try {
    return JSON.parse(result.stdout || "{}");
  } catch (error) {
    throw new Error(
      `Pub/Sub resource describe returned invalid JSON for ${command.describe.join(" ")}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Read existing metadata only; does not create resources, update retention or grant IAM. */
export function readPubSubTopology(input) {
  const commands = buildPubSubEnsureCommands(input);
  return {
    topic: readPubSubResource(commands[0]),
    dlqTopic: readPubSubResource(commands[1]),
    dlqSubscription: readPubSubResource(commands[2]),
    subscription: readPubSubResource(commands[3]),
  };
}

function resolveProjectNumber(projectId) {
  const invocation = resolveGcloudInvocation([
    "projects",
    "describe",
    projectId,
    "--format=value(projectNumber)",
  ]);
  const result = spawnSync(invocation.command, invocation.args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
  });

  if (result.status !== 0) {
    const stderr = String(result.stderr || "").trim();
    throw new Error(
      `Failed to resolve Google Cloud project number for ${projectId}` +
        (stderr ? `: ${stderr}` : ""),
    );
  }

  const projectNumber = String(result.stdout || "").trim();
  if (!projectNumber) {
    throw new Error(
      `Google Cloud project ${projectId} did not return a project number.`,
    );
  }
  return projectNumber;
}

function readPubSubIamPolicy(command) {
  const { projectId, resourceName, resourceType } =
    parsePubSubIamCommand(command);
  const invocation = resolveGcloudInvocation([
    "pubsub",
    resourceType,
    "get-iam-policy",
    resourceName,
    `--project=${projectId}`,
    "--format=json",
  ]);
  const result = spawnSync(invocation.command, invocation.args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
  });

  if (result.status !== 0 || result.error) {
    const stderr = String(result.stderr || result.error?.message || "").trim();
    throw new Error(
      `Failed to read Pub/Sub IAM policy for ${resourceType}/${resourceName}` +
        (stderr ? `: ${stderr}` : ""),
    );
  }

  try {
    return JSON.parse(result.stdout || "{}");
  } catch (error) {
    throw new Error(
      `Pub/Sub IAM policy returned invalid JSON for ${resourceType}/${resourceName}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function grantIamBindings(commands, options = {}) {
  if (commands.length === 0) return;
  const readPolicy = options.readPolicy || readPubSubIamPolicy;
  const runCommand = options.runCommand || runGcloud;

  if (options.skip) {
    for (const command of commands) {
      const policy = readPolicy(command);
      if (!pubSubIamBindingExistsInPolicy(policy, command)) {
        const { member, resourceName, resourceType, role } =
          parsePubSubIamCommand(command);
        throw new Error(
          `Cannot skip ${options.label || "Pub/Sub"} IAM management: missing unconditioned ${role} binding for ${member} on ${resourceType}/${resourceName}.`,
        );
      }
    }
    console.info(
      `${options.label || "Pub/Sub"} IAM mutation skipped after verifying ${commands.length} unconditioned binding(s).`,
    );
    return;
  }

  for (const command of commands) {
    const { member, projectId, resourceName, resourceType, role } =
      parsePubSubIamCommand(command);
    const policy = readPolicy(command);
    if (pubSubIamBindingExistsInPolicy(policy, command)) {
      console.info(
        `Pub/Sub IAM binding already exists; skipping mutation for ${member} ${role} on ${resourceType}/${resourceName}.`,
      );
      continue;
    }

    const result = runCommand(command);
    if (result.status !== 0 || result.error) {
      throw new Error(options.failureMessage(command, commands));
    }

    const updatedPolicy = readPolicy(command);
    if (!pubSubIamBindingExistsInPolicy(updatedPolicy, command)) {
      throw new Error(
        `Pub/Sub IAM mutation did not produce an unconditioned ${role} binding for ${member} on ${projectId}/${resourceType}/${resourceName}.`,
      );
    }
  }
}

function main() {
  const args = parseArgs(process.argv);
  const projectId = getRequiredArg(args, "project");
  const topic = getRequiredArg(args, "topic");
  const subscription = getRequiredArg(args, "subscription");
  const dlqTopic = getRequiredArg(args, "dlq-topic");
  const dlqSubscription = getRequiredArg(args, "dlq-subscription");
  const messageRetentionDuration = String(
    args["message-retention-duration"] || "",
  ).trim();
  const topologyInput = {
    projectId,
    topic,
    subscription,
    dlqTopic,
    dlqSubscription,
    messageRetentionDuration,
    neverExpire: readBooleanFlag(args["never-expire"]),
    exactlyOnceDelivery: !readBooleanFlag(
      args["disable-exactly-once-delivery"],
    ),
    messageOrdering: !readBooleanFlag(args["disable-message-ordering"]),
    ackDeadlineSeconds: String(args["ack-deadline-seconds"] || "").trim(),
  };
  readAckDeadlineSeconds(topologyInput);
  const commands = buildPubSubEnsureCommands(topologyInput);
  const skipSetup =
    readBooleanFlag(args["skip-setup"]) ||
    readBooleanFlag(process.env.PUBSUB_SKIP_SETUP);

  if (!skipSetup) {
    for (const command of commands) {
      ensureResource(command);
    }
  }

  const actualTopology = readPubSubTopology(topologyInput);

  if (!skipSetup) {
    const retentionUpdate = buildPubSubMessageRetentionUpdateCommand(
      topologyInput,
      actualTopology.subscription,
    );
    if (retentionUpdate) {
      const update = runGcloud(retentionUpdate);
      if (update.status !== 0 || update.error) {
        throw new Error(
          `Failed to update Pub/Sub message retention: ${retentionUpdate.join(" ")}`,
        );
      }
      actualTopology.subscription = readPubSubResource(commands[3]);
    }
    const deliveryUpdate = buildPubSubDeliveryUpdateCommand(
      topologyInput,
      actualTopology.subscription,
    );
    if (deliveryUpdate) {
      const update = runGcloud(deliveryUpdate);
      if (update.status !== 0 || update.error) {
        throw new Error(
          `Failed to update Pub/Sub delivery settings: ${deliveryUpdate.join(" ")}`,
        );
      }
      actualTopology.subscription = readPubSubResource(commands[3]);
    }
    const expirationUpdate = buildPubSubExpirationUpdateCommand(
      topologyInput,
      actualTopology.subscription,
    );
    if (expirationUpdate) {
      const update = runGcloud(expirationUpdate);
      if (update.status !== 0 || update.error) {
        throw new Error(
          `Failed to update Pub/Sub subscription expiration: ${expirationUpdate.join(" ")}`,
        );
      }
      actualTopology.subscription = readPubSubResource(commands[3]);
    }
  }

  assertPubSubTopology(topologyInput, actualTopology);

  grantIamBindings(
    buildPubSubDeadLetterIamCommands({
      projectId,
      projectNumber: resolveProjectNumber(projectId),
      subscription,
      dlqTopic,
    }),
    {
      label: "Pub/Sub dead-letter",
      skip:
        readBooleanFlag(args["skip-dead-letter-iam"]) ||
        readBooleanFlag(process.env.PUBSUB_SKIP_DEAD_LETTER_IAM),
      failureMessage: buildDeadLetterIamFailureMessage,
    },
  );

  grantIamBindings(
    buildPubSubSubscriberIamCommands({
      projectId,
      subscription,
      serviceAccount:
        args["subscriber-service-account"] ||
        process.env.PUBSUB_SUBSCRIBER_SERVICE_ACCOUNT,
    }),
    {
      label: "Pub/Sub subscriber",
      skip:
        readBooleanFlag(args["skip-subscriber-iam"]) ||
        readBooleanFlag(process.env.PUBSUB_SKIP_SUBSCRIBER_IAM),
      failureMessage: buildSubscriberIamFailureMessage,
    },
  );

  grantIamBindings(
    buildPubSubPublisherIamCommands({
      projectId,
      topic,
      serviceAccounts: [
        ...getArgValues(args, "publisher-service-account"),
        ...String(process.env.PUBSUB_PUBLISHER_SERVICE_ACCOUNT || "")
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean),
      ],
    }),
    {
      label: "Pub/Sub publisher",
      skip:
        readBooleanFlag(args["skip-publisher-iam"]) ||
        readBooleanFlag(process.env.PUBSUB_SKIP_PUBLISHER_IAM),
      failureMessage: buildPublisherIamFailureMessage,
    },
  );
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
