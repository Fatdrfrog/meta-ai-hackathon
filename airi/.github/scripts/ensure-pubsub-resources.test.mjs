import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import * as pubSubResources from "./ensure-pubsub-resources.mjs";

import {
  buildDeadLetterIamFailureMessage,
  buildPubSubDeadLetterIamCommands,
  buildPubSubEnsureCommands,
  buildPubSubPublisherIamCommands,
  buildPubSubSubscriberIamCommands,
  buildSubscriberIamFailureMessage,
  buildPublisherIamFailureMessage,
  parsePubSubIamCommand,
  pubSubIamBindingExistsInPolicy,
} from "./ensure-pubsub-resources.mjs";

const topologyInput = {
  projectId: "project-1",
  topic: "main-topic",
  subscription: "main-subscription",
  dlqTopic: "dlq-topic",
  dlqSubscription: "dlq-subscription",
};

const exactTopology = {
  topic: {
    name: "projects/project-1/topics/main-topic",
  },
  dlqTopic: {
    name: "projects/project-1/topics/dlq-topic",
  },
  subscription: {
    name: "projects/project-1/subscriptions/main-subscription",
    topic: "projects/project-1/topics/main-topic",
    enableMessageOrdering: true,
    enableExactlyOnceDelivery: true,
    deadLetterPolicy: {
      deadLetterTopic: "projects/project-1/topics/dlq-topic",
      maxDeliveryAttempts: 10,
    },
  },
  dlqSubscription: {
    name: "projects/project-1/subscriptions/dlq-subscription",
    topic: "projects/project-1/topics/dlq-topic",
  },
};

test("builds the Pub/Sub topology commands shared by webhook and OTP delivery", () => {
  const commands = buildPubSubEnsureCommands({
    projectId: "project-1",
    topic: "main-topic",
    subscription: "main-subscription",
    dlqTopic: "dlq-topic",
    dlqSubscription: "dlq-subscription",
  });

  assert.deepEqual(commands, [
    {
      describe: [
        "pubsub",
        "topics",
        "describe",
        "main-topic",
        "--project=project-1",
      ],
      create: [
        "pubsub",
        "topics",
        "create",
        "main-topic",
        "--project=project-1",
      ],
    },
    {
      describe: [
        "pubsub",
        "topics",
        "describe",
        "dlq-topic",
        "--project=project-1",
      ],
      create: [
        "pubsub",
        "topics",
        "create",
        "dlq-topic",
        "--project=project-1",
      ],
    },
    {
      describe: [
        "pubsub",
        "subscriptions",
        "describe",
        "dlq-subscription",
        "--project=project-1",
      ],
      create: [
        "pubsub",
        "subscriptions",
        "create",
        "dlq-subscription",
        "--project=project-1",
        "--topic=dlq-topic",
      ],
    },
    {
      describe: [
        "pubsub",
        "subscriptions",
        "describe",
        "main-subscription",
        "--project=project-1",
      ],
      create: [
        "pubsub",
        "subscriptions",
        "create",
        "main-subscription",
        "--project=project-1",
        "--topic=main-topic",
        "--enable-message-ordering",
        "--enable-exactly-once-delivery",
        "--dead-letter-topic=dlq-topic",
        "--max-delivery-attempts=10",
      ],
    },
  ]);
});

test("adds message retention only to the main subscription create command when requested", () => {
  const commands = buildPubSubEnsureCommands({
    ...topologyInput,
    messageRetentionDuration: "31d",
  });

  assert.deepEqual(commands[3].create, [
    "pubsub",
    "subscriptions",
    "create",
    "main-subscription",
    "--project=project-1",
    "--topic=main-topic",
    "--enable-message-ordering",
    "--enable-exactly-once-delivery",
    "--dead-letter-topic=dlq-topic",
    "--max-delivery-attempts=10",
    "--message-retention-duration=31d",
  ]);
  assert.equal(
    commands
      .slice(0, 3)
      .flatMap((command) => command.create)
      .some((argument) => argument.startsWith("--message-retention-duration")),
    false,
  );
});

test("creates only the main subscription without expiry when requested", () => {
  const commands = buildPubSubEnsureCommands({
    ...topologyInput,
    neverExpire: true,
  });

  assert.equal(commands[3].create.at(-1), "--expiration-period=never");
  assert.equal(
    commands
      .slice(0, 3)
      .flatMap((command) => command.create)
      .some((argument) => argument.startsWith("--expiration-period")),
    false,
  );
  assert.equal(
    buildPubSubEnsureCommands(topologyInput)[3].create.some((argument) =>
      argument.startsWith("--expiration-period"),
    ),
    false,
  );
});

test("builds IAM commands required for Pub/Sub dead-letter forwarding", () => {
  const commands = buildPubSubDeadLetterIamCommands({
    projectId: "project-1",
    projectNumber: "123456789",
    subscription: "main-subscription",
    dlqTopic: "dlq-topic",
  });

  assert.deepEqual(commands, [
    [
      "pubsub",
      "topics",
      "add-iam-policy-binding",
      "dlq-topic",
      "--project=project-1",
      "--member=serviceAccount:service-123456789@gcp-sa-pubsub.iam.gserviceaccount.com",
      "--role=roles/pubsub.publisher",
    ],
    [
      "pubsub",
      "subscriptions",
      "add-iam-policy-binding",
      "main-subscription",
      "--project=project-1",
      "--member=serviceAccount:service-123456789@gcp-sa-pubsub.iam.gserviceaccount.com",
      "--role=roles/pubsub.subscriber",
    ],
  ]);
});

test("builds IAM commands required for runtime subscription consumption", () => {
  const commands = buildPubSubSubscriberIamCommands({
    projectId: "project-1",
    subscription: "main-subscription",
    serviceAccount: "worker@project-1.iam.gserviceaccount.com",
  });

  assert.deepEqual(commands, [
    [
      "pubsub",
      "subscriptions",
      "add-iam-policy-binding",
      "main-subscription",
      "--project=project-1",
      "--member=serviceAccount:worker@project-1.iam.gserviceaccount.com",
      "--role=roles/pubsub.subscriber",
    ],
  ]);
});

test("builds IAM commands required for web runtime publishing", () => {
  const commands = buildPubSubPublisherIamCommands({
    projectId: "project-1",
    topic: "main-topic",
    serviceAccount: "web@project-1.iam.gserviceaccount.com",
  });

  assert.deepEqual(commands, [
    [
      "pubsub",
      "topics",
      "add-iam-policy-binding",
      "main-topic",
      "--project=project-1",
      "--member=serviceAccount:web@project-1.iam.gserviceaccount.com",
      "--role=roles/pubsub.publisher",
    ],
  ]);
});

test("builds one explicit topic publisher binding for each runtime identity", () => {
  const commands = buildPubSubPublisherIamCommands({
    projectId: "project-1",
    topic: "main-topic",
    serviceAccounts: [
      "web@project-1.iam.gserviceaccount.com",
      "worker@project-1.iam.gserviceaccount.com",
    ],
  });

  assert.deepEqual(commands, [
    [
      "pubsub",
      "topics",
      "add-iam-policy-binding",
      "main-topic",
      "--project=project-1",
      "--member=serviceAccount:web@project-1.iam.gserviceaccount.com",
      "--role=roles/pubsub.publisher",
    ],
    [
      "pubsub",
      "topics",
      "add-iam-policy-binding",
      "main-topic",
      "--project=project-1",
      "--member=serviceAccount:worker@project-1.iam.gserviceaccount.com",
      "--role=roles/pubsub.publisher",
    ],
  ]);
});

test("skips runtime publisher IAM commands without a service account", () => {
  assert.deepEqual(
    buildPubSubPublisherIamCommands({
      projectId: "project-1",
      topic: "main-topic",
      serviceAccount: "",
    }),
    [],
  );
});

test("skips runtime subscriber IAM commands without a service account", () => {
  assert.deepEqual(
    buildPubSubSubscriberIamCommands({
      projectId: "project-1",
      subscription: "main-subscription",
      serviceAccount: "",
    }),
    [],
  );
});

test("explains missing permissions when dead-letter IAM binding fails", () => {
  const commands = buildPubSubDeadLetterIamCommands({
    projectId: "project-1",
    projectNumber: "123456789",
    subscription: "main-subscription",
    dlqTopic: "dlq-topic",
  });

  const message = buildDeadLetterIamFailureMessage(commands[0], commands);

  assert.match(message, /pubsub\.topics\.getIamPolicy/);
  assert.match(message, /pubsub\.subscriptions\.setIamPolicy/);
  assert.match(
    message,
    /gcloud pubsub topics add-iam-policy-binding dlq-topic --project=project-1/,
  );
  assert.match(
    message,
    /gcloud pubsub subscriptions add-iam-policy-binding main-subscription --project=project-1/,
  );
});

test("explains missing permissions when subscriber IAM binding fails", () => {
  const commands = buildPubSubSubscriberIamCommands({
    projectId: "project-1",
    subscription: "main-subscription",
    serviceAccount: "worker@project-1.iam.gserviceaccount.com",
  });

  const message = buildSubscriberIamFailureMessage(commands[0], commands);

  assert.match(message, /pubsub\.subscriptions\.getIamPolicy/);
  assert.match(
    message,
    /gcloud pubsub subscriptions add-iam-policy-binding main-subscription --project=project-1/,
  );
});

test("explains missing permissions when publisher IAM binding fails", () => {
  const commands = buildPubSubPublisherIamCommands({
    projectId: "project-1",
    topic: "main-topic",
    serviceAccount: "web@project-1.iam.gserviceaccount.com",
  });

  const message = buildPublisherIamFailureMessage(commands[0], commands);

  assert.match(message, /pubsub\.topics\.getIamPolicy/);
  assert.match(message, /pubsub\.topics\.setIamPolicy/);
  assert.match(
    message,
    /gcloud pubsub topics add-iam-policy-binding main-topic --project=project-1/,
  );
});

test("deploy workflow grants realtime publisher IAM to the web runtime service account", () => {
  const workflow = readFileSync(
    new URL("../workflows/deploy-temporal-worker.yml", import.meta.url),
    "utf8",
  );
  const start = workflow.indexOf("realtime_pubsub_args=(");
  const end = workflow.indexOf(
    'node .github/scripts/ensure-pubsub-resources.mjs "${realtime_pubsub_args[@]}"',
    start,
  );
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);

  const realtimeBlock = workflow.slice(start, end);
  assert.match(realtimeBlock, /PUBSUB_PUBLISHER_SERVICE_ACCOUNT/);
  assert.match(realtimeBlock, /--publisher-service-account/);
});

test("detects existing unconditioned Pub/Sub IAM bindings", () => {
  const [command] = buildPubSubPublisherIamCommands({
    projectId: "project-1",
    topic: "main-topic",
    serviceAccount: "web@project-1.iam.gserviceaccount.com",
  });

  assert.deepEqual(parsePubSubIamCommand(command), {
    member: "serviceAccount:web@project-1.iam.gserviceaccount.com",
    projectId: "project-1",
    resourceName: "main-topic",
    resourceType: "topics",
    role: "roles/pubsub.publisher",
  });
  assert.equal(
    pubSubIamBindingExistsInPolicy(
      {
        bindings: [
          {
            role: "roles/pubsub.publisher",
            members: ["serviceAccount:web@project-1.iam.gserviceaccount.com"],
          },
        ],
      },
      command,
    ),
    true,
  );
});

test("does not treat conditional Pub/Sub IAM bindings as deploy-ready", () => {
  const [command] = buildPubSubSubscriberIamCommands({
    projectId: "project-1",
    subscription: "main-subscription",
    serviceAccount: "worker@project-1.iam.gserviceaccount.com",
  });

  assert.equal(
    pubSubIamBindingExistsInPolicy(
      {
        bindings: [
          {
            role: "roles/pubsub.subscriber",
            members: [
              "serviceAccount:worker@project-1.iam.gserviceaccount.com",
            ],
            condition: {
              title: "temporary",
              expression: "request.time < timestamp('2026-01-01T00:00:00Z')",
            },
          },
        ],
      },
      command,
    ),
    false,
  );
});

test("accepts the exact Pub/Sub topology including snake-case gcloud fields", () => {
  assert.equal(
    typeof pubSubResources.validatePubSubTopology,
    "function",
    "validatePubSubTopology must be exported",
  );
  assert.equal(
    typeof pubSubResources.assertPubSubTopology,
    "function",
    "assertPubSubTopology must be exported",
  );

  assert.deepEqual(
    pubSubResources.validatePubSubTopology(topologyInput, exactTopology),
    [],
  );
  assert.doesNotThrow(() =>
    pubSubResources.assertPubSubTopology(topologyInput, {
      ...exactTopology,
      subscription: {
        ...exactTopology.subscription,
        enableMessageOrdering: undefined,
        enableExactlyOnceDelivery: undefined,
        deadLetterPolicy: undefined,
        enable_message_ordering: true,
        enable_exactly_once_delivery: true,
        dead_letter_policy: {
          dead_letter_topic: "projects/project-1/topics/dlq-topic",
          max_delivery_attempts: 10,
        },
      },
    }),
  );
});

test("verifies optional message retention using gcloud's normalized duration", () => {
  const retentionInput = {
    ...topologyInput,
    messageRetentionDuration: "31d",
  };

  assert.deepEqual(
    pubSubResources.validatePubSubTopology(retentionInput, {
      ...exactTopology,
      subscription: {
        ...exactTopology.subscription,
        messageRetentionDuration: "2678400s",
      },
    }),
    [],
  );
  assert.match(
    pubSubResources
      .validatePubSubTopology(retentionInput, {
        ...exactTopology,
        subscription: {
          ...exactTopology.subscription,
          message_retention_duration: "604800s",
        },
      })
      .join("\n"),
    /message retention duration.*31d/i,
  );
});

test("builds a bounded message-retention update only when the configured value drifts", () => {
  assert.equal(
    typeof pubSubResources.buildPubSubMessageRetentionUpdateCommand,
    "function",
    "buildPubSubMessageRetentionUpdateCommand must be exported",
  );
  const retentionInput = {
    ...topologyInput,
    messageRetentionDuration: "31d",
  };

  assert.deepEqual(
    pubSubResources.buildPubSubMessageRetentionUpdateCommand(retentionInput, {
      ...exactTopology.subscription,
      messageRetentionDuration: "604800s",
    }),
    [
      "pubsub",
      "subscriptions",
      "update",
      "main-subscription",
      "--project=project-1",
      "--message-retention-duration=31d",
    ],
  );
  assert.equal(
    pubSubResources.buildPubSubMessageRetentionUpdateCommand(retentionInput, {
      ...exactTopology.subscription,
      messageRetentionDuration: "2678400s",
    }),
    null,
  );
  assert.equal(
    pubSubResources.buildPubSubMessageRetentionUpdateCommand(topologyInput, {
      ...exactTopology.subscription,
      messageRetentionDuration: "604800s",
    }),
    null,
  );
});

test("verifies a requested non-expiring main subscription", () => {
  const neverExpireInput = { ...topologyInput, neverExpire: true };

  assert.deepEqual(
    pubSubResources.validatePubSubTopology(neverExpireInput, exactTopology),
    [],
  );
  assert.deepEqual(
    pubSubResources.validatePubSubTopology(neverExpireInput, {
      ...exactTopology,
      subscription: { ...exactTopology.subscription, expirationPolicy: {} },
    }),
    [],
  );
  assert.match(
    pubSubResources
      .validatePubSubTopology(neverExpireInput, {
        ...exactTopology,
        subscription: {
          ...exactTopology.subscription,
          expiration_policy: { ttl: "2678400s" },
        },
      })
      .join("\n"),
    /main subscription must never expire/,
  );
  assert.deepEqual(
    pubSubResources.validatePubSubTopology(topologyInput, {
      ...exactTopology,
      subscription: {
        ...exactTopology.subscription,
        expirationPolicy: { ttl: "2678400s" },
      },
    }),
    [],
  );
});

test("builds an expiration update only for a requested non-expiring subscription with a TTL", () => {
  const neverExpireInput = { ...topologyInput, neverExpire: true };
  const expiringSubscription = {
    ...exactTopology.subscription,
    expirationPolicy: { ttl: "2678400s" },
  };

  assert.deepEqual(
    pubSubResources.buildPubSubExpirationUpdateCommand(
      neverExpireInput,
      expiringSubscription,
    ),
    [
      "pubsub",
      "subscriptions",
      "update",
      "main-subscription",
      "--project=project-1",
      "--expiration-period=never",
    ],
  );
  assert.equal(
    pubSubResources.buildPubSubExpirationUpdateCommand(
      neverExpireInput,
      exactTopology.subscription,
    ),
    null,
  );
  assert.equal(
    pubSubResources.buildPubSubExpirationUpdateCommand(
      topologyInput,
      expiringSubscription,
    ),
    null,
  );
  assert.throws(
    () =>
      pubSubResources.assertPubSubTopology(neverExpireInput, {
        ...exactTopology,
        subscription: expiringSubscription,
      }),
    /subscriptions update main-subscription --project=project-1 --enable-exactly-once-delivery --dead-letter-topic=dlq-topic --max-delivery-attempts=10 --expiration-period=never/,
  );
});

const latencyInput = {
  ...topologyInput,
  exactlyOnceDelivery: false,
  ackDeadlineSeconds: 20,
};

const latencySubscription = {
  ...exactTopology.subscription,
  enableExactlyOnceDelivery: undefined,
  ackDeadlineSeconds: 20,
};

test("creates a latency lane without exactly-once and with its ack deadline", () => {
  assert.deepEqual(buildPubSubEnsureCommands(latencyInput)[3].create, [
    "pubsub",
    "subscriptions",
    "create",
    "main-subscription",
    "--project=project-1",
    "--topic=main-topic",
    "--enable-message-ordering",
    "--dead-letter-topic=dlq-topic",
    "--max-delivery-attempts=10",
    "--ack-deadline=20",
  ]);
  assert.ok(
    buildPubSubEnsureCommands(topologyInput)[3].create.includes(
      "--enable-exactly-once-delivery",
    ),
  );
  assert.equal(
    buildPubSubEnsureCommands(topologyInput)[3].create.some((argument) =>
      argument.startsWith("--ack-deadline"),
    ),
    false,
  );
});

test("verifies the declared exactly-once and ack-deadline settings", () => {
  for (const subscription of [
    latencySubscription,
    { ...latencySubscription, enableExactlyOnceDelivery: false },
    {
      ...latencySubscription,
      ackDeadlineSeconds: undefined,
      ack_deadline_seconds: 20,
      enable_exactly_once_delivery: false,
    },
  ]) {
    assert.deepEqual(
      pubSubResources.validatePubSubTopology(latencyInput, {
        ...exactTopology,
        subscription,
      }),
      [],
    );
  }

  const drift = pubSubResources
    .validatePubSubTopology(latencyInput, {
      ...exactTopology,
      subscription: { ...exactTopology.subscription, ackDeadlineSeconds: 60 },
    })
    .join("\n");
  assert.match(drift, /exactly-once delivery must be disabled/);
  assert.match(drift, /ack deadline must be 20s/);

  assert.deepEqual(
    pubSubResources.validatePubSubTopology(topologyInput, {
      ...exactTopology,
      subscription: { ...exactTopology.subscription, ackDeadlineSeconds: 60 },
    }),
    [],
  );
  assert.match(
    pubSubResources
      .validatePubSubTopology(topologyInput, {
        ...exactTopology,
        subscription: latencySubscription,
      })
      .join("\n"),
    /exactly-once delivery must be enabled/,
  );
});

test("builds a delivery update only for declared delivery drift", () => {
  assert.deepEqual(
    pubSubResources.buildPubSubDeliveryUpdateCommand(latencyInput, {
      ...exactTopology.subscription,
      ackDeadlineSeconds: 60,
    }),
    [
      "pubsub",
      "subscriptions",
      "update",
      "main-subscription",
      "--project=project-1",
      "--no-enable-exactly-once-delivery",
      "--ack-deadline=20",
    ],
  );
  assert.deepEqual(
    pubSubResources.buildPubSubDeliveryUpdateCommand(latencyInput, {
      ...latencySubscription,
      ackDeadlineSeconds: 60,
    }),
    [
      "pubsub",
      "subscriptions",
      "update",
      "main-subscription",
      "--project=project-1",
      "--ack-deadline=20",
    ],
  );
  assert.deepEqual(
    pubSubResources.buildPubSubDeliveryUpdateCommand(
      topologyInput,
      latencySubscription,
    ),
    [
      "pubsub",
      "subscriptions",
      "update",
      "main-subscription",
      "--project=project-1",
      "--enable-exactly-once-delivery",
    ],
  );
  assert.equal(
    pubSubResources.buildPubSubDeliveryUpdateCommand(
      latencyInput,
      latencySubscription,
    ),
    null,
  );
  assert.equal(
    pubSubResources.buildPubSubDeliveryUpdateCommand(
      topologyInput,
      exactTopology.subscription,
    ),
    null,
  );
});

test("rejects ack deadlines Pub/Sub does not accept", () => {
  for (const ackDeadlineSeconds of [5, 601, 12.5, "soon"]) {
    assert.throws(
      () => buildPubSubEnsureCommands({ ...topologyInput, ackDeadlineSeconds }),
      /ack deadline must be an integer from 10 to 600 seconds/,
      String(ackDeadlineSeconds),
    );
  }
});

test("reports the declared delivery settings in mutable-drift remediation", () => {
  assert.throws(
    () =>
      pubSubResources.assertPubSubTopology(latencyInput, {
        ...exactTopology,
        subscription: { ...exactTopology.subscription, ackDeadlineSeconds: 60 },
      }),
    (error) => {
      assert.ok(
        error.message.includes(
          "gcloud pubsub subscriptions update main-subscription --project=project-1 --no-enable-exactly-once-delivery --dead-letter-topic=dlq-topic --max-delivery-attempts=10 --ack-deadline=20",
        ),
      );
      return true;
    },
  );
});

test("deploy workflow turns exactly-once off only for the WhatsApp ingest and realtime lanes", () => {
  const workflow = readFileSync(
    new URL("../workflows/deploy-temporal-worker.yml", import.meta.url),
    "utf8",
  );
  const argsBlock = (name) => {
    const start = workflow.search(new RegExp(`(^|\\s)${name}=\\(`, "m"));
    const end = workflow.indexOf(
      `node .github/scripts/ensure-pubsub-resources.mjs "\${${name}[@]}"`,
      start,
    );
    assert.ok(start !== -1 && end !== -1, name);
    return workflow.slice(start, end);
  };

  for (const name of [
    "webhook_pubsub_args",
    "fast_webhook_pubsub_args",
    "fast_lane_pubsub_args",
    "realtime_pubsub_args",
  ]) {
    const block = argsBlock(name);
    assert.match(block, /--disable-exactly-once-delivery/, name);
    assert.match(block, /--ack-deadline-seconds 20/, name);
  }
  for (const name of [
    "call_pubsub_args",
    "otp_pubsub_args",
    "usage_pubsub_args",
    "classification_pubsub_args",
  ]) {
    const block = argsBlock(name);
    assert.doesNotMatch(block, /--disable-exactly-once-delivery/, name);
    assert.doesNotMatch(block, /--ack-deadline-seconds/, name);
  }
});

test("rejects every material Pub/Sub topology drift", () => {
  assert.equal(
    typeof pubSubResources.assertPubSubTopology,
    "function",
    "assertPubSubTopology must be exported",
  );

  const cases = [
    {
      name: "missing main topic",
      actual: { ...exactTopology, topic: null },
      expected: /main topic/i,
    },
    {
      name: "wrong DLQ topic",
      actual: {
        ...exactTopology,
        dlqTopic: { name: "projects/project-1/topics/other-dlq" },
      },
      expected: /DLQ topic/i,
    },
    {
      name: "wrong main subscription topic",
      actual: {
        ...exactTopology,
        subscription: {
          ...exactTopology.subscription,
          topic: "projects/project-1/topics/other-topic",
        },
      },
      expected: /main subscription topic/i,
    },
    {
      name: "wrong DLQ subscription topic",
      actual: {
        ...exactTopology,
        dlqSubscription: {
          ...exactTopology.dlqSubscription,
          topic: "projects/project-1/topics/other-dlq",
        },
      },
      expected: /DLQ subscription topic/i,
    },
    {
      name: "ordering disabled",
      actual: {
        ...exactTopology,
        subscription: {
          ...exactTopology.subscription,
          enableMessageOrdering: false,
        },
      },
      expected: /message ordering/i,
    },
    {
      name: "exactly-once disabled",
      actual: {
        ...exactTopology,
        subscription: {
          ...exactTopology.subscription,
          enableExactlyOnceDelivery: false,
        },
      },
      expected: /exactly-once/i,
    },
    {
      name: "wrong dead-letter topic",
      actual: {
        ...exactTopology,
        subscription: {
          ...exactTopology.subscription,
          deadLetterPolicy: {
            ...exactTopology.subscription.deadLetterPolicy,
            deadLetterTopic: "projects/project-1/topics/other-dlq",
          },
        },
      },
      expected: /dead-letter topic/i,
    },
    {
      name: "wrong max delivery attempts",
      actual: {
        ...exactTopology,
        subscription: {
          ...exactTopology.subscription,
          deadLetterPolicy: {
            ...exactTopology.subscription.deadLetterPolicy,
            maxDeliveryAttempts: 5,
          },
        },
      },
      expected: /max delivery attempts/i,
    },
  ];

  for (const fixture of cases) {
    assert.throws(
      () => pubSubResources.assertPubSubTopology(topologyInput, fixture.actual),
      fixture.expected,
      fixture.name,
    );
  }
});

test("reports a bounded update command for mutable subscription drift", () => {
  assert.throws(
    () =>
      pubSubResources.assertPubSubTopology(topologyInput, {
        ...exactTopology,
        subscription: {
          ...exactTopology.subscription,
          enableExactlyOnceDelivery: false,
          deadLetterPolicy: {
            deadLetterTopic: "projects/project-1/topics/other-dlq",
            maxDeliveryAttempts: 5,
          },
        },
      }),
    (error) => {
      assert.match(error.message, /does not run remediation commands/i);
      assert.match(
        error.message,
        /gcloud pubsub subscriptions update main-subscription --project=project-1 --enable-exactly-once-delivery --dead-letter-topic=dlq-topic --max-delivery-attempts=10/,
      );
      assert.doesNotMatch(
        error.message,
        /subscriptions update[^\n]*--enable-message-ordering/,
      );
      return true;
    },
  );
});

test("reports approval-gated recreation for message-ordering drift", () => {
  assert.throws(
    () =>
      pubSubResources.assertPubSubTopology(topologyInput, {
        ...exactTopology,
        subscription: {
          ...exactTopology.subscription,
          enableMessageOrdering: false,
        },
      }),
    (error) => {
      assert.match(error.message, /message ordering.*recreat/i);
      assert.match(error.message, /drain or preserve pending messages/i);
      assert.ok(
        error.message.includes(
          "gcloud pubsub subscriptions delete main-subscription --project=project-1",
        ),
      );
      assert.ok(
        error.message.includes(
          "gcloud pubsub subscriptions create main-subscription --project=project-1 --topic=main-topic --enable-message-ordering --enable-exactly-once-delivery --dead-letter-topic=dlq-topic --max-delivery-attempts=10",
        ),
      );
      assert.doesNotMatch(
        error.message,
        /subscriptions update[^\n]*--enable-message-ordering/,
      );
      return true;
    },
  );
});

test("reports approval-gated recreate commands for immutable source-topic drift", () => {
  for (const [name, actual, commands] of [
    [
      "main subscription",
      {
        ...exactTopology,
        subscription: {
          ...exactTopology.subscription,
          topic: "projects/project-1/topics/other-topic",
        },
      },
      [
        "gcloud pubsub subscriptions delete main-subscription --project=project-1",
        "gcloud pubsub subscriptions create main-subscription --project=project-1 --topic=main-topic --enable-message-ordering --enable-exactly-once-delivery --dead-letter-topic=dlq-topic --max-delivery-attempts=10",
      ],
    ],
    [
      "DLQ subscription",
      {
        ...exactTopology,
        dlqSubscription: {
          ...exactTopology.dlqSubscription,
          topic: "projects/project-1/topics/other-dlq",
        },
      },
      [
        "gcloud pubsub subscriptions delete dlq-subscription --project=project-1",
        "gcloud pubsub subscriptions create dlq-subscription --project=project-1 --topic=dlq-topic",
      ],
    ],
  ]) {
    assert.throws(
      () => pubSubResources.assertPubSubTopology(topologyInput, actual),
      (error) => {
        assert.match(error.message, /source topic is immutable/i, name);
        assert.match(
          error.message,
          /drain or preserve pending messages/i,
          name,
        );
        for (const command of commands) {
          assert.ok(error.message.includes(command), `${name}: ${command}`);
        }
        return true;
      },
    );
  }
});

test("IAM skip verifies every unconditioned binding without mutating", () => {
  assert.equal(
    typeof pubSubResources.grantIamBindings,
    "function",
    "grantIamBindings must be exported",
  );
  const commands = buildPubSubPublisherIamCommands({
    projectId: "project-1",
    topic: "main-topic",
    serviceAccounts: [
      "web@project-1.iam.gserviceaccount.com",
      "worker@project-1.iam.gserviceaccount.com",
    ],
  });
  let mutations = 0;

  assert.doesNotThrow(() =>
    pubSubResources.grantIamBindings(commands, {
      skip: true,
      label: "classification publisher",
      readPolicy: () => ({
        bindings: [
          {
            role: "roles/pubsub.publisher",
            members: [
              "serviceAccount:web@project-1.iam.gserviceaccount.com",
              "serviceAccount:worker@project-1.iam.gserviceaccount.com",
            ],
          },
        ],
      }),
      runCommand: () => {
        mutations += 1;
        return { status: 0 };
      },
    }),
  );
  assert.equal(mutations, 0);
});

test("IAM skip fails closed on missing, conditional, or unreadable bindings", () => {
  assert.equal(
    typeof pubSubResources.grantIamBindings,
    "function",
    "grantIamBindings must be exported",
  );
  const [command] = buildPubSubSubscriberIamCommands({
    projectId: "project-1",
    subscription: "main-subscription",
    serviceAccount: "worker@project-1.iam.gserviceaccount.com",
  });
  const conditionalPolicy = {
    bindings: [
      {
        role: "roles/pubsub.subscriber",
        members: ["serviceAccount:worker@project-1.iam.gserviceaccount.com"],
        condition: { title: "temporary", expression: "request.time < now" },
      },
    ],
  };

  for (const [name, readPolicy, expected] of [
    ["missing", () => ({ bindings: [] }), /missing unconditioned/i],
    ["conditional", () => conditionalPolicy, /missing unconditioned/i],
    [
      "unreadable",
      () => {
        throw new Error("policy read denied");
      },
      /policy read denied/i,
    ],
  ]) {
    assert.throws(
      () =>
        pubSubResources.grantIamBindings([command], {
          skip: true,
          label: `classification ${name}`,
          readPolicy,
          runCommand: () => {
            throw new Error("skip mode must not mutate");
          },
        }),
      expected,
      name,
    );
  }
});

const unorderedInput = {
  ...topologyInput,
  messageOrdering: false,
  exactlyOnceDelivery: false,
  ackDeadlineSeconds: 20,
};

const unorderedSubscription = {
  ...exactTopology.subscription,
  enableMessageOrdering: undefined,
  enableExactlyOnceDelivery: undefined,
  ackDeadlineSeconds: 20,
};

test("creates an unordered lane without message ordering", () => {
  const create = buildPubSubEnsureCommands(unorderedInput)[3].create;
  assert.equal(create.includes("--enable-message-ordering"), false);
  assert.ok(
    buildPubSubEnsureCommands(topologyInput)[3].create.includes(
      "--enable-message-ordering",
    ),
  );
});

test("verifies the declared message ordering in both directions", () => {
  for (const subscription of [
    unorderedSubscription,
    { ...unorderedSubscription, enableMessageOrdering: false },
    {
      ...unorderedSubscription,
      enableMessageOrdering: undefined,
      enable_message_ordering: false,
    },
  ]) {
    assert.deepEqual(
      pubSubResources.validatePubSubTopology(unorderedInput, {
        ...exactTopology,
        subscription,
      }),
      [],
    );
  }
  assert.match(
    pubSubResources
      .validatePubSubTopology(unorderedInput, {
        ...exactTopology,
        subscription: { ...unorderedSubscription, enableMessageOrdering: true },
      })
      .join("\n"),
    /message ordering must be disabled/,
  );
  assert.match(
    pubSubResources
      .validatePubSubTopology(topologyInput, {
        ...exactTopology,
        subscription: {
          ...exactTopology.subscription,
          enableMessageOrdering: false,
        },
      })
      .join("\n"),
    /message ordering must be enabled/,
  );
});

test("reports approval-gated recreation when an unordered lane is ordered", () => {
  assert.throws(
    () =>
      pubSubResources.assertPubSubTopology(unorderedInput, {
        ...exactTopology,
        subscription: { ...unorderedSubscription, enableMessageOrdering: true },
      }),
    (error) => {
      assert.match(error.message, /message ordering.*recreat/i);
      assert.ok(
        error.message.includes(
          "gcloud pubsub subscriptions create main-subscription --project=project-1 --topic=main-topic --dead-letter-topic=dlq-topic --max-delivery-attempts=10 --ack-deadline=20",
        ),
      );
      return true;
    },
  );
});

test("deploy workflow adds an unordered fast-lane copy of the fast topic", () => {
  const workflow = readFileSync(
    new URL("../workflows/deploy-temporal-worker.yml", import.meta.url),
    "utf8",
  );
  const start = workflow.indexOf("fast_lane_pubsub_args=(");
  const end = workflow.indexOf(
    'node .github/scripts/ensure-pubsub-resources.mjs "${fast_lane_pubsub_args[@]}"',
    start,
  );
  assert.ok(start !== -1 && end !== -1);
  const block = workflow.slice(start, end);
  for (const expected of [
    /--topic "\$\{WHATSAPP_FAST_WEBHOOK_PUBSUB_TOPIC:-icecore-whatsapp-fast-events\}"/,
    /icecore-whatsapp-fast-events-unordered-worker/,
    /--dlq-topic "\$\{WHATSAPP_FAST_WEBHOOK_PUBSUB_DLQ_TOPIC:-icecore-whatsapp-fast-events-dlq\}"/,
    /--disable-message-ordering/,
    /--disable-exactly-once-delivery/,
    /--ack-deadline-seconds 20/,
    /--message-retention-duration 10m/,
    /--subscriber-service-account/,
  ]) {
    assert.match(block, expected);
  }
  assert.equal(
    (workflow.match(/--disable-message-ordering/g) || []).length,
    1,
    "only the fast lane's copy may drop ordering",
  );
  assert.match(
    workflow,
    /WHATSAPP_FAST_LANE_PUBSUB_ENABLED: \$\{\{ vars\.WHATSAPP_FAST_LANE_PUBSUB_ENABLED \|\| 'false' \}\}/,
  );
});
