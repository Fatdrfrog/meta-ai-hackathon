import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  buildConversationClassificationWakeEventId,
  CONVERSATION_CLASSIFICATION_WAKE_SCHEMA_VERSION,
} from "@icecore/temporal";
import type {
  ClaimedConversationClassification,
  ConversationClassificationWakeState,
} from "@/lib/classifier/conversation-classification-store";

import {
  startConversationClassificationPubSubConsumer,
  type ConversationClassificationConsumerDependencies,
  type ConversationClassificationConsumerRuntimeDependencies,
} from "./conversation-classification-consumer";

const NOW = new Date("2026-08-11T10:00:00.000Z");
const CONVERSATION_ID = "68a000000000000000000001";
const ENV_KEYS = [
  "CONVERSATION_CLASSIFICATION_PUBSUB_ENABLED",
  "CONVERSATION_CLASSIFICATION_PUBSUB_PROJECT_ID",
  "CONVERSATION_CLASSIFICATION_PUBSUB_SUBSCRIPTION",
  "CONVERSATION_CLASSIFICATION_PUBSUB_MAX_MESSAGES",
] as const;
const ORIGINAL_ENV = Object.fromEntries(
  ENV_KEYS.map((key) => [key, process.env[key]]),
) as Record<(typeof ENV_KEYS)[number], string | undefined>;
const ALLOWLIST_ENV = "CONVERSATION_CLASSIFICATION_WORKSPACE_ALLOWLIST";
const ORIGINAL_ALLOWLIST = process.env[ALLOWLIST_ENV];
// Every fixture conversation belongs to workspace-1; the gate tests override it.
process.env[ALLOWLIST_ENV] = "workspace-1";

test.after(() => {
  for (const key of ENV_KEYS) {
    const value = ORIGINAL_ENV[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  if (ORIGINAL_ALLOWLIST === undefined) {
    delete process.env[ALLOWLIST_ENV];
  } else {
    process.env[ALLOWLIST_ENV] = ORIGINAL_ALLOWLIST;
  }
});

async function withAllowlist(
  value: string | undefined,
  run: () => Promise<void>,
): Promise<void> {
  if (value === undefined) {
    delete process.env[ALLOWLIST_ENV];
  } else {
    process.env[ALLOWLIST_ENV] = value;
  }
  try {
    await run();
  } finally {
    process.env[ALLOWLIST_ENV] = "workspace-1";
  }
}

type TestMessage = {
  id: string;
  data: Buffer;
  ack: () => void;
  nack: () => void;
};

type TestFixture = ReturnType<typeof createFixture>;

class FakeSubscription extends EventEmitter {
  constructor(private readonly actions: string[]) {
    super();
  }

  override removeListener(
    eventName: string | symbol,
    listener: (...args: unknown[]) => void,
  ): this {
    this.actions.push(`remove:${String(eventName)}`);
    return super.removeListener(eventName, listener);
  }

  async close(): Promise<void> {
    this.actions.push("close");
  }
}

function validWake(overrides: Record<string, unknown> = {}) {
  const requestedRevision =
    typeof overrides.requestedRevision === "number"
      ? overrides.requestedRevision
      : 4;
  const generation =
    typeof overrides.generation === "number" ? overrides.generation : 2;
  const conversationId =
    typeof overrides.conversationId === "string"
      ? overrides.conversationId
      : CONVERSATION_ID;
  return {
    schemaVersion: CONVERSATION_CLASSIFICATION_WAKE_SCHEMA_VERSION,
    eventId: buildConversationClassificationWakeEventId({
      conversationId,
      requestedRevision,
      generation,
    }),
    conversationId,
    requestedRevision,
    generation,
    requestedAt: "2026-08-11T09:59:00.000Z",
    ...overrides,
  };
}

function wakeState(
  overrides: {
    classificationRevision?: number;
    isClassified?: boolean;
    classificationMeta?: {
      sourceRevision: number | null;
      analysisRevisionId: string | null;
    } | null;
    state?: Partial<ConversationClassificationWakeState["state"]>;
  } = {},
): ConversationClassificationWakeState {
  const classificationRevision = overrides.classificationRevision ?? 4;
  const status = overrides.state?.status ?? "pending";
  const ready = status === "ready";
  return {
    conversationId: CONVERSATION_ID,
    workspaceId: "workspace-1",
    classificationRevision,
    isClassified: overrides.isClassified ?? ready,
    classificationMeta:
      overrides.classificationMeta === undefined
        ? ready
          ? {
              sourceRevision: classificationRevision,
              analysisRevisionId: "analysis-revision-4",
            }
          : null
        : overrides.classificationMeta,
    state: {
      contractVersion: 2,
      status,
      requestedRevision: classificationRevision,
      processingRevision: null,
      appliedRevision: ready ? classificationRevision : null,
      generation: 2,
      fence: 0,
      requestedAt: new Date("2026-08-11T09:59:00.000Z"),
      nextAttemptAt:
        status === "pending" || status === "blocked"
          ? new Date("2026-08-11T09:59:30.000Z")
          : null,
      lease: null,
      ...overrides.state,
    },
  };
}

function claimedClassification(): ClaimedConversationClassification {
  return {
    conversationId: CONVERSATION_ID,
    workspaceId: "workspace-1",
    revision: 4,
    generation: 2,
    attemptCount: 1,
    requestedAt: new Date("2026-08-11T09:59:00.000Z"),
    ownerToken: "owner-current",
    fence: 4,
    expiresAt: new Date("2026-08-11T10:10:00.000Z"),
  };
}

function messageFrom(
  value: unknown,
  actions: string[],
  id = "pubsub-message-1",
): TestMessage {
  const raw = typeof value === "string" ? value : JSON.stringify(value);
  return {
    id,
    data: Buffer.from(raw),
    ack: () => actions.push(`ack:${id}`),
    nack: () => actions.push(`nack:${id}`),
  };
}

function createFixture(
  input: {
    readState?: () => Promise<unknown>;
    connectDB?: () => Promise<unknown>;
  } = {},
) {
  const actions: string[] = [];
  const subscription = new FakeSubscription(actions);
  const subscriptionInputs: unknown[] = [];
  const logs: Array<{
    level: "info" | "error";
    name: string;
    error: unknown;
    context: Record<string, unknown>;
  }> = [];
  const runtime = {
    connectDB:
      input.connectDB ??
      (async () => {
        actions.push("connect");
      }),
    readConversationClassificationWakeState:
      input.readState ??
      (async () => {
        actions.push("read");
        return null;
      }),
    recoverExpiredSupersededConversationClassificationLease: async () => {
      actions.push("recover");
      return "changed";
    },
    supabaseAdmin: {},
    ensureCompanyClassificationCapacity: async () => {
      actions.push("capacity");
      return { allowed: true };
    },
    markConversationClassificationBlocked: async () => {
      actions.push("block");
      return true;
    },
    claimConversationClassification: async () => {
      actions.push("claim");
      return null;
    },
    executeConversationClassification: async () => {
      actions.push("execute");
      return { status: "stale" };
    },
    dispatchConversationClassificationEffects: async () => {
      actions.push("dispatch");
      return { status: "completed" };
    },
    classificationCapacityLimitCode: "company_classification_limit_exceeded",
    classificationCapacityRecheckMs: 15 * 60 * 1_000,
  } as unknown as ConversationClassificationConsumerRuntimeDependencies;
  const dependencies = {
    createPubSubSubscription: (subscriptionInput: unknown) => {
      subscriptionInputs.push(subscriptionInput);
      return { projectId: "classification-project", subscription };
    },
    loadRuntimeDependencies: async () => {
      actions.push("loadRuntime");
      return runtime;
    },
    now: () => new Date(NOW),
    logger: {
      info: (name: string, context: Record<string, unknown>) => {
        logs.push({ level: "info", name, error: undefined, context });
      },
      error: (
        name: string,
        error: unknown,
        context: Record<string, unknown>,
      ) => {
        logs.push({ level: "error", name, error, context });
      },
    },
  } as unknown as ConversationClassificationConsumerDependencies;
  return {
    actions,
    dependencies,
    logs,
    runtime,
    subscription,
    subscriptionInputs,
  };
}

async function emitAndStop(
  fixture: TestFixture,
  message: TestMessage,
): Promise<void> {
  const stop = await startConversationClassificationPubSubConsumer(
    fixture.dependencies,
  );
  fixture.subscription.emit("message", message);
  await stop();
}

function setReadStates(
  fixture: TestFixture,
  values: Array<ConversationClassificationWakeState | null | Error>,
): void {
  fixture.runtime.readConversationClassificationWakeState = async () => {
    fixture.actions.push("read");
    const value = values.shift();
    if (value instanceof Error) throw value;
    return value ?? null;
  };
}

function assertDisposition(
  fixture: TestFixture,
  expected: "ack" | "nack",
  messageId = "pubsub-message-1",
): void {
  assert.equal(
    fixture.actions.filter((action) => action === `${expected}:${messageId}`)
      .length,
    1,
  );
  const other = expected === "ack" ? "nack" : "ack";
  assert.equal(
    fixture.actions.some((action) => action === `${other}:${messageId}`),
    false,
  );
}

test("defaults disabled without creating or loading a subscription", async () => {
  for (const key of ENV_KEYS) delete process.env[key];
  const fixture = createFixture();

  const stop = await startConversationClassificationPubSubConsumer(
    fixture.dependencies,
  );
  await stop();

  assert.deepEqual(fixture.subscriptionInputs, []);
  assert.deepEqual(fixture.actions, []);
  assert.equal(fixture.logs.length, 1);
  assert.equal(fixture.logs[0]?.context.note, "disabled");
});

test("uses the exact project, subscription override, and flow-control contract", async () => {
  process.env.CONVERSATION_CLASSIFICATION_PUBSUB_ENABLED = "true";
  process.env.CONVERSATION_CLASSIFICATION_PUBSUB_SUBSCRIPTION =
    "  classification-worker-custom  ";
  process.env.CONVERSATION_CLASSIFICATION_PUBSUB_MAX_MESSAGES = "25";
  const fixture = createFixture();

  const stop = await startConversationClassificationPubSubConsumer(
    fixture.dependencies,
  );
  await stop();

  assert.deepEqual(fixture.subscriptionInputs, [
    {
      projectIdEnvName: "CONVERSATION_CLASSIFICATION_PUBSUB_PROJECT_ID",
      subscriptionName: "classification-worker-custom",
      maxMessagesEnvName: "CONVERSATION_CLASSIFICATION_PUBSUB_MAX_MESSAGES",
      defaultMaxMessages: 10,
    },
  ]);
});

test("uses the shared subscription default when the override is absent", async () => {
  process.env.CONVERSATION_CLASSIFICATION_PUBSUB_ENABLED = "1";
  delete process.env.CONVERSATION_CLASSIFICATION_PUBSUB_SUBSCRIPTION;
  delete process.env.CONVERSATION_CLASSIFICATION_PUBSUB_MAX_MESSAGES;
  const fixture = createFixture();

  const stop = await startConversationClassificationPubSubConsumer(
    fixture.dependencies,
  );
  await stop();

  assert.deepEqual(fixture.subscriptionInputs, [
    {
      projectIdEnvName: "CONVERSATION_CLASSIFICATION_PUBSUB_PROJECT_ID",
      subscriptionName: "icecore-conversation-classification-events-worker",
      maxMessagesEnvName: "CONVERSATION_CLASSIFICATION_PUBSUB_MAX_MESSAGES",
      defaultMaxMessages: 10,
    },
  ]);
});

test("nacks every malformed wake without touching Mongo", async (t) => {
  process.env.CONVERSATION_CLASSIFICATION_PUBSUB_ENABLED = "true";
  const invalidMessages: Array<[string, unknown]> = [
    ["json", "{"],
    ["schema", { ...validWake(), schemaVersion: 99 }],
    ["event-id", { ...validWake(), eventId: "forged" }],
    ["date", { ...validWake(), requestedAt: "not-a-date" }],
    ["conversation-id", { ...validWake(), conversationId: " bad " }],
    ["revision", { ...validWake(), requestedRevision: 0 }],
    ["generation", { ...validWake(), generation: 0 }],
  ];

  for (const [name, payload] of invalidMessages) {
    await t.test(name, async () => {
      const fixture = createFixture();
      await emitAndStop(
        fixture,
        messageFrom(payload, fixture.actions, `invalid-${name}`),
      );

      assert.equal(
        fixture.actions.filter((action) => action === `nack:invalid-${name}`)
          .length,
        1,
      );
      assert.equal(
        fixture.actions.some((action) => action === `ack:invalid-${name}`),
        false,
      );
      assert.equal(fixture.actions.includes("connect"), false);
      assert.equal(
        fixture.logs.filter((entry) => entry.level === "error").length,
        1,
      );
    });
  }
});

test("connects before the authoritative read and acks a deleted conversation", async () => {
  process.env.CONVERSATION_CLASSIFICATION_PUBSUB_ENABLED = "true";
  const fixture = createFixture();

  await emitAndStop(fixture, messageFrom(validWake(), fixture.actions));

  assert.ok(fixture.actions.indexOf("connect") >= 0);
  assert.ok(
    fixture.actions.indexOf("connect") < fixture.actions.indexOf("read"),
  );
  assert.equal(
    fixture.actions.filter((action) => action === "ack:pubsub-message-1")
      .length,
    1,
  );
  assert.equal(
    fixture.actions.some((action) => action === "nack:pubsub-message-1"),
    false,
  );
});

test("samples the durable decision time only after connect and authoritative read", async () => {
  process.env.CONVERSATION_CLASSIFICATION_PUBSUB_ENABLED = "true";
  const fixture = createFixture();
  setReadStates(fixture, [
    wakeState({
      state: {
        status: "pending",
        nextAttemptAt: new Date("2026-08-11T09:59:59.999Z"),
      },
    }),
  ]);
  fixture.dependencies.now = () => {
    fixture.actions.push("now");
    return new Date(NOW);
  };
  fixture.runtime.claimConversationClassification = async () =>
    claimedClassification();

  await emitAndStop(fixture, messageFrom(validWake(), fixture.actions));

  assertDisposition(fixture, "ack");
  assert.ok(
    fixture.actions.indexOf("connect") < fixture.actions.indexOf("read"),
  );
  assert.ok(fixture.actions.indexOf("read") < fixture.actions.indexOf("now"));
});

test("nacks connect and authoritative-read failures without fabricating deletion", async (t) => {
  process.env.CONVERSATION_CLASSIFICATION_PUBSUB_ENABLED = "true";

  await t.test("connect failure", async () => {
    const fixture = createFixture({
      connectDB: async () => {
        fixture.actions.push("connect");
        throw new Error("mongo unavailable");
      },
    });
    await emitAndStop(fixture, messageFrom(validWake(), fixture.actions));
    assertDisposition(fixture, "nack");
    assert.equal(fixture.actions.includes("read"), false);
  });

  await t.test("strict read failure", async () => {
    const fixture = createFixture();
    setReadStates(fixture, [new Error("invalid v2 wake state")]);
    await emitAndStop(fixture, messageFrom(validWake(), fixture.actions));
    assertDisposition(fixture, "nack");
  });
});

test("acks lower durable identities and nacks future or crossed identities", async (t) => {
  process.env.CONVERSATION_CLASSIFICATION_PUBSUB_ENABLED = "true";
  const cases: Array<{
    name: string;
    event: ReturnType<typeof validWake>;
    state: ConversationClassificationWakeState;
    disposition: "ack" | "nack";
  }> = [
    {
      name: "older revision",
      event: validWake({ requestedRevision: 3 }),
      state: wakeState(),
      disposition: "ack",
    },
    {
      name: "older generation",
      event: validWake({ generation: 1 }),
      state: wakeState(),
      disposition: "ack",
    },
    {
      name: "future revision",
      event: validWake({ requestedRevision: 5 }),
      state: wakeState(),
      disposition: "nack",
    },
    {
      name: "future generation",
      event: validWake({ generation: 3 }),
      state: wakeState(),
      disposition: "nack",
    },
    {
      name: "future revision crossed with older generation",
      event: validWake({ requestedRevision: 5, generation: 1 }),
      state: wakeState(),
      disposition: "nack",
    },
    {
      name: "older revision crossed with future generation",
      event: validWake({ requestedRevision: 3, generation: 3 }),
      state: wakeState(),
      disposition: "nack",
    },
  ];

  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const fixture = createFixture();
      setReadStates(fixture, [entry.state]);
      await emitAndStop(fixture, messageFrom(entry.event, fixture.actions));
      assertDisposition(fixture, entry.disposition);
      assert.equal(fixture.actions.includes("capacity"), false);
      assert.equal(fixture.actions.includes("claim"), false);
    });
  }
});

test("acks future backoff, live owners, and terminal classification states", async (t) => {
  process.env.CONVERSATION_CLASSIFICATION_PUBSUB_ENABLED = "true";
  const liveLease = {
    ownerToken: "owner-live",
    claimedAt: new Date("2026-08-11T09:55:00.000Z"),
    expiresAt: new Date("2026-08-11T10:05:00.000Z"),
  };
  const cases: Array<[string, ConversationClassificationWakeState]> = [
    [
      "pending backoff",
      wakeState({
        state: {
          status: "pending",
          nextAttemptAt: new Date("2026-08-11T10:01:00.000Z"),
        },
      }),
    ],
    [
      "blocked backoff",
      wakeState({
        state: {
          status: "blocked",
          nextAttemptAt: new Date("2026-08-11T10:01:00.000Z"),
        },
      }),
    ],
    [
      "live current processing",
      wakeState({
        state: {
          status: "processing",
          processingRevision: 4,
          fence: 3,
          nextAttemptAt: null,
          lease: liveLease,
        },
      }),
    ],
    [
      "live superseded processing",
      wakeState({
        state: {
          status: "processing",
          processingRevision: 3,
          fence: 3,
          nextAttemptAt: new Date("2026-08-11T09:59:00.000Z"),
          lease: liveLease,
        },
      }),
    ],
    ["review required", wakeState({ state: { status: "review_required" } })],
    ["failed", wakeState({ state: { status: "failed" } })],
    ["not applicable", wakeState({ state: { status: "not_applicable" } })],
  ];

  for (const [name, state] of cases) {
    await t.test(name, async () => {
      const fixture = createFixture();
      setReadStates(fixture, [state]);
      await emitAndStop(fixture, messageFrom(validWake(), fixture.actions));
      assertDisposition(fixture, "ack");
      assert.equal(fixture.actions.includes("capacity"), false);
      assert.equal(fixture.actions.includes("claim"), false);
    });
  }
});

test("nacks impossible processing identities without recovery or claim", async (t) => {
  process.env.CONVERSATION_CLASSIFICATION_PUBSUB_ENABLED = "true";
  const cases: Array<[string, ConversationClassificationWakeState]> = [
    [
      "processing revision ahead of requested",
      wakeState({
        state: {
          status: "processing",
          processingRevision: 5,
          fence: 3,
          lease: {
            ownerToken: "owner-corrupt",
            claimedAt: new Date("2026-08-11T09:50:00.000Z"),
            expiresAt: new Date("2026-08-11T09:55:00.000Z"),
          },
        },
      }),
    ],
    [
      "processing lease missing",
      wakeState({
        state: {
          status: "processing",
          processingRevision: 4,
          fence: 3,
          lease: null,
        },
      }),
    ],
  ];

  for (const [name, state] of cases) {
    await t.test(name, async () => {
      const fixture = createFixture();
      setReadStates(fixture, [state]);
      fixture.runtime.recoverExpiredSupersededConversationClassificationLease =
        async () => {
          fixture.actions.push("recover");
          return "changed";
        };
      await emitAndStop(fixture, messageFrom(validWake(), fixture.actions));
      assertDisposition(fixture, "nack");
      assert.equal(fixture.actions.includes("recover"), false);
      assert.equal(fixture.actions.includes("claim"), false);
    });
  }
});

test("recovers an exact expired superseded lease, rereads, then claims current due work", async () => {
  process.env.CONVERSATION_CLASSIFICATION_PUBSUB_ENABLED = "true";
  const expiredLease = {
    ownerToken: "owner-expired",
    claimedAt: new Date("2026-08-11T09:40:00.000Z"),
    expiresAt: new Date("2026-08-11T09:50:00.000Z"),
  };
  const fixture = createFixture();
  setReadStates(fixture, [
    wakeState({
      state: {
        status: "processing",
        processingRevision: 3,
        fence: 7,
        nextAttemptAt: new Date("2026-08-11T09:59:00.000Z"),
        lease: expiredLease,
      },
    }),
    wakeState(),
  ]);
  let recoveryInput: unknown;
  fixture.runtime.recoverExpiredSupersededConversationClassificationLease =
    async (input) => {
      fixture.actions.push("recover");
      recoveryInput = input;
      return "recovered";
    };
  fixture.runtime.ensureCompanyClassificationCapacity = async () => {
    fixture.actions.push("capacity");
    return { allowed: true };
  };
  fixture.runtime.claimConversationClassification = async () => {
    fixture.actions.push("claim");
    return claimedClassification();
  };
  fixture.runtime.executeConversationClassification = async () => {
    fixture.actions.push("execute");
    return { status: "stale" };
  };

  await emitAndStop(fixture, messageFrom(validWake(), fixture.actions));

  assertDisposition(fixture, "ack");
  assert.equal(fixture.actions.filter((action) => action === "read").length, 2);
  assert.deepEqual(recoveryInput, {
    observed: {
      conversationId: CONVERSATION_ID,
      requestedRevision: 4,
      generation: 2,
      processingRevision: 3,
      ownerToken: "owner-expired",
      fence: 7,
      expiresAt: expiredLease.expiresAt,
    },
    recoveredAt: NOW,
  });
  assert.ok(
    fixture.actions.indexOf("recover") < fixture.actions.lastIndexOf("read"),
  );
  assert.ok(
    fixture.actions.lastIndexOf("read") < fixture.actions.indexOf("capacity"),
  );
  assert.ok(
    fixture.actions.indexOf("capacity") < fixture.actions.indexOf("claim"),
  );
});

test("rereads an expired superseded recovery race and acks the new live owner", async () => {
  process.env.CONVERSATION_CLASSIFICATION_PUBSUB_ENABLED = "true";
  const fixture = createFixture();
  setReadStates(fixture, [
    wakeState({
      state: {
        status: "processing",
        processingRevision: 3,
        fence: 7,
        lease: {
          ownerToken: "owner-expired",
          claimedAt: new Date("2026-08-11T09:40:00.000Z"),
          expiresAt: new Date("2026-08-11T09:50:00.000Z"),
        },
      },
    }),
    wakeState({
      state: {
        status: "processing",
        processingRevision: 4,
        fence: 8,
        lease: {
          ownerToken: "owner-race-winner",
          claimedAt: new Date("2026-08-11T09:59:59.000Z"),
          expiresAt: new Date("2026-08-11T10:09:59.000Z"),
        },
      },
    }),
  ]);
  fixture.runtime.recoverExpiredSupersededConversationClassificationLease =
    async () => {
      fixture.actions.push("recover");
      return "changed";
    };

  await emitAndStop(fixture, messageFrom(validWake(), fixture.actions));

  assertDisposition(fixture, "ack");
  assert.equal(fixture.actions.filter((action) => action === "read").length, 2);
  assert.equal(fixture.actions.includes("capacity"), false);
  assert.equal(fixture.actions.includes("claim"), false);
});

test("resamples time after a recovery reread before classifying a newly expired owner", async () => {
  process.env.CONVERSATION_CLASSIFICATION_PUBSUB_ENABLED = "true";
  const fixture = createFixture();
  setReadStates(fixture, [
    wakeState({
      state: {
        status: "processing",
        processingRevision: 3,
        fence: 7,
        lease: {
          ownerToken: "owner-expired",
          claimedAt: new Date("2026-08-11T09:40:00.000Z"),
          expiresAt: new Date("2026-08-11T09:50:00.000Z"),
        },
      },
    }),
    wakeState({
      state: {
        status: "processing",
        processingRevision: 4,
        fence: 8,
        lease: {
          ownerToken: "owner-crossed-expiry",
          claimedAt: new Date("2026-08-11T09:59:59.000Z"),
          expiresAt: new Date("2026-08-11T10:00:30.000Z"),
        },
      },
    }),
  ]);
  const times = [
    new Date("2026-08-11T10:00:00.000Z"),
    new Date("2026-08-11T10:01:00.000Z"),
  ];
  fixture.dependencies.now = () => {
    fixture.actions.push("now");
    return times.shift() ?? new Date("2026-08-11T10:01:00.000Z");
  };
  fixture.runtime.recoverExpiredSupersededConversationClassificationLease =
    async () => "changed";
  fixture.runtime.claimConversationClassification = async () => {
    fixture.actions.push("claim");
    return claimedClassification();
  };

  await emitAndStop(fixture, messageFrom(validWake(), fixture.actions));

  assertDisposition(fixture, "ack");
  assert.equal(fixture.actions.filter((action) => action === "now").length, 2);
  assert.ok(
    fixture.actions.lastIndexOf("read") < fixture.actions.lastIndexOf("now"),
  );
  assert.equal(fixture.actions.includes("capacity"), true);
  assert.equal(fixture.actions.includes("claim"), true);
});

test("nacks impossible recovery responses instead of looping", async (t) => {
  process.env.CONVERSATION_CLASSIFICATION_PUBSUB_ENABLED = "true";
  for (const recoveryResult of ["not_superseded", "not_expired"] as const) {
    await t.test(recoveryResult, async () => {
      const fixture = createFixture();
      setReadStates(fixture, [
        wakeState({
          state: {
            status: "processing",
            processingRevision: 3,
            fence: 7,
            lease: {
              ownerToken: "owner-expired",
              claimedAt: new Date("2026-08-11T09:40:00.000Z"),
              expiresAt: new Date("2026-08-11T09:50:00.000Z"),
            },
          },
        }),
      ]);
      fixture.runtime.recoverExpiredSupersededConversationClassificationLease =
        async () => recoveryResult;
      await emitAndStop(fixture, messageFrom(validWake(), fixture.actions));
      assertDisposition(fixture, "nack");
      assert.equal(
        fixture.actions.filter((action) => action === "read").length,
        1,
      );
    });
  }
});

test("checks capacity immediately before claiming each exact due state", async (t) => {
  process.env.CONVERSATION_CLASSIFICATION_PUBSUB_ENABLED = "true";
  const expiredLease = {
    ownerToken: "owner-expired-current",
    claimedAt: new Date("2026-08-11T09:40:00.000Z"),
    expiresAt: new Date("2026-08-11T09:50:00.000Z"),
  };
  const cases: Array<[string, ConversationClassificationWakeState]> = [
    ["pending", wakeState()],
    ["blocked", wakeState({ state: { status: "blocked" } })],
    [
      "expired current processing",
      wakeState({
        state: {
          status: "processing",
          processingRevision: 4,
          fence: 5,
          nextAttemptAt: null,
          lease: expiredLease,
        },
      }),
    ],
  ];

  for (const [name, state] of cases) {
    await t.test(name, async () => {
      const fixture = createFixture();
      setReadStates(fixture, [state]);
      const supabaseAdmin = fixture.runtime.supabaseAdmin;
      fixture.runtime.ensureCompanyClassificationCapacity = async (
        supabase,
        workspaceId,
      ) => {
        assert.equal(supabase, supabaseAdmin);
        fixture.actions.push(`capacity:${workspaceId}`);
        return { allowed: true };
      };
      fixture.runtime.claimConversationClassification = async (input) => {
        fixture.actions.push(`claim:${String(input.conversationId)}`);
        return claimedClassification();
      };
      fixture.runtime.executeConversationClassification = async () => {
        fixture.actions.push("execute");
        return { status: "stale" };
      };

      await emitAndStop(fixture, messageFrom(validWake(), fixture.actions));

      assertDisposition(fixture, "ack");
      assert.ok(
        fixture.actions.indexOf("capacity:workspace-1") <
          fixture.actions.indexOf(`claim:${CONVERSATION_ID}`),
      );
      assert.equal(
        fixture.actions.indexOf(`claim:${CONVERSATION_ID}`),
        fixture.actions.indexOf("capacity:workspace-1") + 1,
      );
      assert.ok(
        fixture.actions.indexOf(`claim:${CONVERSATION_ID}`) <
          fixture.actions.indexOf("execute"),
      );
    });
  }
});

test("nacks capacity outages without blocking or claiming", async () => {
  process.env.CONVERSATION_CLASSIFICATION_PUBSUB_ENABLED = "true";
  const fixture = createFixture();
  setReadStates(fixture, [wakeState()]);
  fixture.runtime.ensureCompanyClassificationCapacity = async () => {
    fixture.actions.push("capacity");
    throw new Error("supabase unavailable");
  };
  fixture.runtime.markConversationClassificationBlocked = async () => {
    fixture.actions.push("block");
    return true;
  };
  fixture.runtime.claimConversationClassification = async () => {
    fixture.actions.push("claim");
    return claimedClassification();
  };

  await emitAndStop(fixture, messageFrom(validWake(), fixture.actions));

  assertDisposition(fixture, "nack");
  assert.equal(fixture.actions.includes("block"), false);
  assert.equal(fixture.actions.includes("claim"), false);
});

test("acks a capacity denial only after the exact due block CAS persists", async () => {
  process.env.CONVERSATION_CLASSIFICATION_PUBSUB_ENABLED = "true";
  const fixture = createFixture();
  setReadStates(fixture, [wakeState()]);
  let blockInput: unknown;
  fixture.runtime.ensureCompanyClassificationCapacity = async () => ({
    allowed: false,
  });
  fixture.runtime.markConversationClassificationBlocked = async (input) => {
    fixture.actions.push("block");
    blockInput = input;
    return true;
  };
  fixture.runtime.claimConversationClassification = async () => {
    fixture.actions.push("claim");
    return claimedClassification();
  };

  await emitAndStop(fixture, messageFrom(validWake(), fixture.actions));

  assertDisposition(fixture, "ack");
  assert.deepEqual(blockInput, {
    observation: {
      kind: "due",
      conversationId: CONVERSATION_ID,
      revision: 4,
    },
    code: "company_classification_limit_exceeded",
    reason: "Company classification capacity is exhausted",
    recheckAt: new Date("2026-08-11T10:15:00.000Z"),
  });
  assert.equal(fixture.actions.includes("claim"), false);
});

test("uses the exact expired lease observation when capacity is denied", async () => {
  process.env.CONVERSATION_CLASSIFICATION_PUBSUB_ENABLED = "true";
  const lease = {
    ownerToken: "owner-expired-current",
    claimedAt: new Date("2026-08-11T09:40:00.000Z"),
    expiresAt: new Date("2026-08-11T09:50:00.000Z"),
  };
  const fixture = createFixture();
  setReadStates(fixture, [
    wakeState({
      state: {
        status: "processing",
        processingRevision: 4,
        fence: 5,
        lease,
      },
    }),
  ]);
  fixture.runtime.ensureCompanyClassificationCapacity = async () => ({
    allowed: false,
  });
  let blockInput: unknown;
  fixture.runtime.markConversationClassificationBlocked = async (input) => {
    blockInput = input;
    return true;
  };

  await emitAndStop(fixture, messageFrom(validWake(), fixture.actions));

  assertDisposition(fixture, "ack");
  assert.deepEqual(blockInput, {
    observation: {
      kind: "expired_processing",
      lease: {
        conversationId: CONVERSATION_ID,
        revision: 4,
        ownerToken: lease.ownerToken,
        fence: 5,
        expiresAt: lease.expiresAt,
      },
    },
    code: "company_classification_limit_exceeded",
    reason: "Company classification capacity is exhausted",
    recheckAt: new Date("2026-08-11T10:15:00.000Z"),
  });
});

test("parks every due state of a workspace off the allowlist before capacity", async (t) => {
  process.env.CONVERSATION_CLASSIFICATION_PUBSUB_ENABLED = "true";
  const expiredLease = {
    ownerToken: "owner-expired-current",
    claimedAt: new Date("2026-08-11T09:40:00.000Z"),
    expiresAt: new Date("2026-08-11T09:50:00.000Z"),
  };
  const cases: Array<[string, ConversationClassificationWakeState, unknown]> = [
    [
      "pending",
      wakeState(),
      { kind: "due", conversationId: CONVERSATION_ID, revision: 4 },
    ],
    [
      "capacity blocked",
      wakeState({ state: { status: "blocked" } }),
      { kind: "due", conversationId: CONVERSATION_ID, revision: 4 },
    ],
    [
      "expired current processing",
      wakeState({
        state: {
          status: "processing",
          processingRevision: 4,
          fence: 5,
          nextAttemptAt: null,
          lease: expiredLease,
        },
      }),
      {
        kind: "expired_processing",
        lease: {
          conversationId: CONVERSATION_ID,
          revision: 4,
          ownerToken: expiredLease.ownerToken,
          fence: 5,
          expiresAt: expiredLease.expiresAt,
        },
      },
    ],
  ];

  for (const [name, state, observation] of cases) {
    await t.test(name, () =>
      withAllowlist(" other-workspace , another ", async () => {
        const fixture = createFixture();
        setReadStates(fixture, [state]);
        let blockInput: unknown;
        fixture.runtime.markConversationClassificationBlocked = async (
          input,
        ) => {
          fixture.actions.push("block");
          blockInput = input;
          return true;
        };

        await emitAndStop(fixture, messageFrom(validWake(), fixture.actions));

        assertDisposition(fixture, "ack");
        assert.deepEqual(blockInput, {
          observation,
          code: "classification_not_enabled",
          reason: "Classification is not enabled for this workspace",
          recheckAt: new Date("2026-08-18T10:00:00.000Z"),
        });
        assert.equal(fixture.actions.includes("capacity"), false);
        assert.equal(fixture.actions.includes("claim"), false);
        assert.equal(fixture.actions.includes("execute"), false);
        assert.equal(
          fixture.logs.find((entry) => entry.context.note === "message_acked")
            ?.context.outcome,
          "not_enabled_blocked",
        );
      }),
    );
  }
});

test("enables no workspace when the allowlist is unset or blank", async (t) => {
  process.env.CONVERSATION_CLASSIFICATION_PUBSUB_ENABLED = "true";
  for (const [name, value] of [
    ["unset", undefined],
    ["blank", " , "],
  ] as const) {
    await t.test(name, () =>
      withAllowlist(value, async () => {
        const fixture = createFixture();
        setReadStates(fixture, [wakeState()]);

        await emitAndStop(fixture, messageFrom(validWake(), fixture.actions));

        assertDisposition(fixture, "ack");
        assert.equal(fixture.actions.includes("block"), true);
        assert.equal(fixture.actions.includes("capacity"), false);
        assert.equal(fixture.actions.includes("claim"), false);
        assert.equal(
          fixture.logs.find((entry) => entry.context.note === "started")
            ?.context.workspaceAllowlist,
          0,
        );
      }),
    );
  }
});

test("classifies allowlisted workspaces, case-insensitively or by wildcard", async (t) => {
  process.env.CONVERSATION_CLASSIFICATION_PUBSUB_ENABLED = "true";
  for (const [name, value, logged] of [
    ["listed among others", "other, WORKSPACE-1 ", 2],
    ["wildcard", "*", "all"],
  ] as const) {
    await t.test(name, () =>
      withAllowlist(value, async () => {
        const fixture = createFixture();
        setReadStates(fixture, [wakeState()]);
        fixture.runtime.claimConversationClassification = async () => {
          fixture.actions.push("claim");
          return claimedClassification();
        };

        await emitAndStop(fixture, messageFrom(validWake(), fixture.actions));

        assertDisposition(fixture, "ack");
        assert.equal(fixture.actions.includes("block"), false);
        assert.ok(
          fixture.actions.indexOf("capacity") <
            fixture.actions.indexOf("claim"),
        );
        assert.ok(fixture.actions.includes("execute"));
        assert.equal(
          fixture.logs.find((entry) => entry.context.note === "started")
            ?.context.workspaceAllowlist,
          logged,
        );
      }),
    );
  }
});

test("rereads a lost not-enabled block CAS instead of acking unchanged work", () =>
  withAllowlist("other-workspace", async () => {
    process.env.CONVERSATION_CLASSIFICATION_PUBSUB_ENABLED = "true";
    const fixture = createFixture();
    setReadStates(fixture, [wakeState(), wakeState()]);
    fixture.runtime.markConversationClassificationBlocked = async () => false;

    await emitAndStop(fixture, messageFrom(validWake(), fixture.actions));

    assertDisposition(fixture, "nack");
    assert.equal(
      fixture.actions.filter((action) => action === "read").length,
      2,
    );
    assert.equal(fixture.actions.includes("capacity"), false);
  }));

test("rereads a lost capacity-block CAS and classifies the resulting state", async (t) => {
  process.env.CONVERSATION_CLASSIFICATION_PUBSUB_ENABLED = "true";
  const cases: Array<{
    name: string;
    next: ConversationClassificationWakeState;
    disposition: "ack" | "nack";
  }> = [
    {
      name: "newer durable identity makes the event stale",
      next: wakeState({
        classificationRevision: 5,
        state: { generation: 3 },
      }),
      disposition: "ack",
    },
    {
      name: "new live owner is benign",
      next: wakeState({
        state: {
          status: "processing",
          processingRevision: 4,
          fence: 4,
          lease: {
            ownerToken: "block-race-winner",
            claimedAt: new Date("2026-08-11T09:59:59.000Z"),
            expiresAt: new Date("2026-08-11T10:09:59.000Z"),
          },
        },
      }),
      disposition: "ack",
    },
    {
      name: "future due is benign",
      next: wakeState({
        state: {
          status: "blocked",
          nextAttemptAt: new Date("2026-08-11T10:01:00.000Z"),
        },
      }),
      disposition: "ack",
    },
    {
      name: "terminal state is benign",
      next: wakeState({ state: { status: "review_required" } }),
      disposition: "ack",
    },
    {
      name: "unchanged due invariant is not benign",
      next: wakeState(),
      disposition: "nack",
    },
  ];

  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const fixture = createFixture();
      setReadStates(fixture, [wakeState(), entry.next]);
      fixture.runtime.ensureCompanyClassificationCapacity = async () => ({
        allowed: false,
      });
      fixture.runtime.markConversationClassificationBlocked = async () => false;
      await emitAndStop(fixture, messageFrom(validWake(), fixture.actions));
      assertDisposition(fixture, entry.disposition);
      assert.equal(
        fixture.actions.filter((action) => action === "read").length,
        2,
      );
    });
  }
});

test("resamples time after a lost block CAS so newly due work is not acked", async () => {
  process.env.CONVERSATION_CLASSIFICATION_PUBSUB_ENABLED = "true";
  const fixture = createFixture();
  setReadStates(fixture, [
    wakeState(),
    wakeState({
      state: {
        status: "blocked",
        nextAttemptAt: new Date("2026-08-11T10:00:30.000Z"),
      },
    }),
  ]);
  const times = [
    new Date("2026-08-11T10:00:00.000Z"),
    new Date("2026-08-11T10:01:00.000Z"),
  ];
  fixture.dependencies.now = () => {
    fixture.actions.push("now");
    return times.shift() ?? new Date("2026-08-11T10:01:00.000Z");
  };
  fixture.runtime.ensureCompanyClassificationCapacity = async () => ({
    allowed: false,
  });
  fixture.runtime.markConversationClassificationBlocked = async () => false;

  await emitAndStop(fixture, messageFrom(validWake(), fixture.actions));

  assertDisposition(fixture, "nack");
  assert.equal(fixture.actions.filter((action) => action === "now").length, 2);
  assert.ok(
    fixture.actions.lastIndexOf("read") < fixture.actions.lastIndexOf("now"),
  );
});

test("rereads a lost claim CAS and separates benign races from unchanged due work", async (t) => {
  process.env.CONVERSATION_CLASSIFICATION_PUBSUB_ENABLED = "true";
  const cases: Array<{
    name: string;
    next: ConversationClassificationWakeState;
    disposition: "ack" | "nack";
  }> = [
    {
      name: "newer durable identity is benign",
      next: wakeState({
        classificationRevision: 5,
        state: { generation: 3 },
      }),
      disposition: "ack",
    },
    {
      name: "new live owner is benign",
      next: wakeState({
        state: {
          status: "processing",
          processingRevision: 4,
          fence: 4,
          lease: {
            ownerToken: "claim-race-winner",
            claimedAt: new Date("2026-08-11T09:59:59.000Z"),
            expiresAt: new Date("2026-08-11T10:09:59.000Z"),
          },
        },
      }),
      disposition: "ack",
    },
    {
      name: "future due is benign",
      next: wakeState({
        state: {
          status: "pending",
          nextAttemptAt: new Date("2026-08-11T10:01:00.000Z"),
        },
      }),
      disposition: "ack",
    },
    {
      name: "terminal state is benign",
      next: wakeState({ state: { status: "failed" } }),
      disposition: "ack",
    },
    {
      name: "same due state must retry delivery",
      next: wakeState(),
      disposition: "nack",
    },
  ];

  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const fixture = createFixture();
      setReadStates(fixture, [wakeState(), entry.next]);
      fixture.runtime.ensureCompanyClassificationCapacity = async () => ({
        allowed: true,
      });
      fixture.runtime.claimConversationClassification = async () => null;
      await emitAndStop(fixture, messageFrom(validWake(), fixture.actions));
      assertDisposition(fixture, entry.disposition);
      assert.equal(
        fixture.actions.filter((action) => action === "read").length,
        2,
      );
    });
  }
});

test("dispatches exact current-ready duplicates and acks every persisted outcome", async (t) => {
  process.env.CONVERSATION_CLASSIFICATION_PUBSUB_ENABLED = "true";
  const outcomes = [
    { status: "completed" },
    {
      status: "retry_scheduled",
      nextAttemptAt: new Date("2026-08-11T10:01:00.000Z"),
    },
    { status: "superseded" },
    { status: "lease_lost" },
  ] as const;

  for (const outcome of outcomes) {
    await t.test(outcome.status, async () => {
      const fixture = createFixture();
      setReadStates(fixture, [wakeState({ state: { status: "ready" } })]);
      let dispatchInput: unknown;
      fixture.runtime.dispatchConversationClassificationEffects = async (
        input,
      ) => {
        fixture.actions.push("dispatch");
        dispatchInput = input;
        return outcome;
      };
      await emitAndStop(fixture, messageFrom(validWake(), fixture.actions));
      assertDisposition(fixture, "ack");
      assert.deepEqual(dispatchInput, {
        analysisRevisionId: "analysis-revision-4",
      });
      assert.equal(fixture.actions.includes("capacity"), false);
      assert.equal(fixture.actions.includes("claim"), false);
      assert.equal(fixture.actions.includes("execute"), false);
    });
  }
});

test("nacks ready projection corruption without dispatching effects", async (t) => {
  process.env.CONVERSATION_CLASSIFICATION_PUBSUB_ENABLED = "true";
  const cases: Array<[string, ConversationClassificationWakeState]> = [
    [
      "classification flag",
      wakeState({ state: { status: "ready" }, isClassified: false }),
    ],
    [
      "missing metadata",
      wakeState({ state: { status: "ready" }, classificationMeta: null }),
    ],
    [
      "source revision",
      wakeState({
        state: { status: "ready" },
        classificationMeta: {
          sourceRevision: 3,
          analysisRevisionId: "analysis-revision-4",
        },
      }),
    ],
    [
      "analysis identity",
      wakeState({
        state: { status: "ready" },
        classificationMeta: {
          sourceRevision: 4,
          analysisRevisionId: null,
        },
      }),
    ],
    [
      "applied revision",
      wakeState({
        state: { status: "ready", appliedRevision: 3 },
      }),
    ],
  ];

  for (const [name, state] of cases) {
    await t.test(name, async () => {
      const fixture = createFixture();
      setReadStates(fixture, [state]);
      await emitAndStop(fixture, messageFrom(validWake(), fixture.actions));
      assertDisposition(fixture, "nack");
      assert.equal(fixture.actions.includes("dispatch"), false);
      assert.equal(fixture.actions.includes("capacity"), false);
      assert.equal(fixture.actions.includes("claim"), false);
    });
  }
});

test("acks every durable non-ready executor result without dispatching effects", async (t) => {
  process.env.CONVERSATION_CLASSIFICATION_PUBSUB_ENABLED = "true";
  const outcomes = [
    { status: "review_required" },
    {
      status: "retry_scheduled",
      nextAttemptAt: new Date("2026-08-11T10:01:00.000Z"),
    },
    { status: "failed" },
    {
      status: "media_deferred",
      recheckAt: new Date("2026-08-11T10:05:00.000Z"),
    },
    { status: "stale" },
  ] as const;

  for (const outcome of outcomes) {
    await t.test(outcome.status, async () => {
      const fixture = createFixture();
      setReadStates(fixture, [wakeState()]);
      fixture.runtime.claimConversationClassification = async () => {
        fixture.actions.push("claim");
        return claimedClassification();
      };
      fixture.runtime.executeConversationClassification = async () => {
        fixture.actions.push("execute");
        return outcome;
      };
      await emitAndStop(fixture, messageFrom(validWake(), fixture.actions));
      assertDisposition(fixture, "ack");
      assert.equal(fixture.actions.includes("dispatch"), false);
    });
  }
});

test("dispatches only the analysis identity returned by a ready executor", async () => {
  process.env.CONVERSATION_CLASSIFICATION_PUBSUB_ENABLED = "true";
  const fixture = createFixture();
  setReadStates(fixture, [wakeState()]);
  fixture.runtime.claimConversationClassification = async () =>
    claimedClassification();
  fixture.runtime.executeConversationClassification = async () => ({
    status: "ready",
    analysisRevisionId: "analysis-from-executor",
  });
  let dispatchInput: unknown;
  fixture.runtime.dispatchConversationClassificationEffects = async (input) => {
    dispatchInput = input;
    return { status: "completed" };
  };

  await emitAndStop(fixture, messageFrom(validWake(), fixture.actions));

  assertDisposition(fixture, "ack");
  assert.deepEqual(dispatchInput, {
    analysisRevisionId: "analysis-from-executor",
  });
});

test("nacks recovery, block, claim, executor, and dispatcher errors", async (t) => {
  process.env.CONVERSATION_CLASSIFICATION_PUBSUB_ENABLED = "true";

  await t.test("recovery", async () => {
    const fixture = createFixture();
    setReadStates(fixture, [
      wakeState({
        state: {
          status: "processing",
          processingRevision: 3,
          fence: 7,
          lease: {
            ownerToken: "owner-expired",
            claimedAt: new Date("2026-08-11T09:40:00.000Z"),
            expiresAt: new Date("2026-08-11T09:50:00.000Z"),
          },
        },
      }),
    ]);
    fixture.runtime.recoverExpiredSupersededConversationClassificationLease =
      async () => {
        throw new Error("recovery write failed");
      };
    await emitAndStop(fixture, messageFrom(validWake(), fixture.actions));
    assertDisposition(fixture, "nack");
  });

  await t.test("block", async () => {
    const fixture = createFixture();
    setReadStates(fixture, [wakeState()]);
    fixture.runtime.ensureCompanyClassificationCapacity = async () => ({
      allowed: false,
    });
    fixture.runtime.markConversationClassificationBlocked = async () => {
      throw new Error("block write failed");
    };
    await emitAndStop(fixture, messageFrom(validWake(), fixture.actions));
    assertDisposition(fixture, "nack");
  });

  await t.test("claim", async () => {
    const fixture = createFixture();
    setReadStates(fixture, [wakeState()]);
    fixture.runtime.claimConversationClassification = async () => {
      throw new Error("claim failed");
    };
    await emitAndStop(fixture, messageFrom(validWake(), fixture.actions));
    assertDisposition(fixture, "nack");
  });

  await t.test("executor", async () => {
    const fixture = createFixture();
    setReadStates(fixture, [wakeState()]);
    fixture.runtime.claimConversationClassification = async () =>
      claimedClassification();
    fixture.runtime.executeConversationClassification = async () => {
      throw new Error("executor failed");
    };
    await emitAndStop(fixture, messageFrom(validWake(), fixture.actions));
    assertDisposition(fixture, "nack");
  });

  await t.test("dispatcher", async () => {
    const fixture = createFixture();
    setReadStates(fixture, [wakeState({ state: { status: "ready" } })]);
    fixture.runtime.dispatchConversationClassificationEffects = async () => {
      throw new Error("dispatcher failed");
    };
    await emitAndStop(fixture, messageFrom(validWake(), fixture.actions));
    assertDisposition(fixture, "nack");
  });
});

test("emits one sanitized wide event for a failed message", async () => {
  process.env.CONVERSATION_CLASSIFICATION_PUBSUB_ENABLED = "true";
  const fixture = createFixture();
  const secretPayload = '{"TOP-SECRET":';

  await emitAndStop(
    fixture,
    messageFrom(secretPayload, fixture.actions, "invalid-secret"),
  );

  const messageLogs = fixture.logs.filter(
    (entry) => entry.context.messageId === "invalid-secret",
  );
  assert.equal(messageLogs.length, 1);
  assert.equal(messageLogs[0]?.level, "error");
  assert.equal(JSON.stringify(messageLogs).includes("TOP-SECRET"), false);
});

test("never passes raw operational errors to the worker logger", async () => {
  process.env.CONVERSATION_CLASSIFICATION_PUBSUB_ENABLED = "true";
  const fixture = createFixture({
    connectDB: async () => {
      throw new Error("TOP-SECRET mongo credential leaked");
    },
  });

  await emitAndStop(
    fixture,
    messageFrom(validWake(), fixture.actions, "operational-error"),
  );

  const messageLogs = fixture.logs.filter(
    (entry) => entry.context.messageId === "operational-error",
  );
  assert.equal(messageLogs.length, 1);
  assert.equal(messageLogs[0]?.error, undefined);
  assert.equal(
    messageLogs[0]?.context.errorCategory,
    "consumer_processing_failed",
  );
  assert.equal(JSON.stringify(messageLogs).includes("TOP-SECRET"), false);
});

test("records subscription errors without acknowledging a message", async () => {
  process.env.CONVERSATION_CLASSIFICATION_PUBSUB_ENABLED = "true";
  const fixture = createFixture();
  const stop = await startConversationClassificationPubSubConsumer(
    fixture.dependencies,
  );

  fixture.subscription.emit(
    "error",
    new Error("TOP-SECRET subscription credential leaked"),
  );
  await stop();

  const subscriptionLogs = fixture.logs.filter(
    (entry) => entry.context.note === "subscription_error",
  );
  assert.equal(subscriptionLogs.length, 1);
  assert.equal(subscriptionLogs[0]?.error, undefined);
  assert.equal(
    subscriptionLogs[0]?.context.errorCategory,
    "subscription_error",
  );
  assert.equal(JSON.stringify(subscriptionLogs).includes("TOP-SECRET"), false);
  assert.equal(
    fixture.actions.some(
      (action) => action.startsWith("ack:") || action.startsWith("nack:"),
    ),
    false,
  );
});

test("shutdown detaches listeners, drains tracked work, then closes", async () => {
  process.env.CONVERSATION_CLASSIFICATION_PUBSUB_ENABLED = "true";
  let releaseRead: (() => void) | undefined;
  const readGate = new Promise<void>((resolve) => {
    releaseRead = resolve;
  });
  const fixture = createFixture({
    readState: async () => {
      fixture.actions.push("read:start");
      await readGate;
      fixture.actions.push("read:end");
      return null;
    },
  });
  const stop = await startConversationClassificationPubSubConsumer(
    fixture.dependencies,
  );
  const messageListener = fixture.subscription.listeners("message")[0] as (
    message: TestMessage,
  ) => void;
  fixture.subscription.emit(
    "message",
    messageFrom(validWake(), fixture.actions),
  );

  const stopping = stop();
  assert.deepEqual(fixture.actions.slice(0, 2), [
    "remove:message",
    "remove:error",
  ]);
  assert.equal(fixture.actions.includes("close"), false);

  messageListener(
    messageFrom(validWake(), fixture.actions, "arrived-while-stopping"),
  );
  assert.equal(
    fixture.actions.filter((action) => action === "nack:arrived-while-stopping")
      .length,
    1,
  );

  releaseRead?.();
  await stopping;
  assert.ok(
    fixture.actions.indexOf("ack:pubsub-message-1") <
      fixture.actions.indexOf("close"),
  );
  assert.equal(fixture.actions.at(-1), "close");
});
