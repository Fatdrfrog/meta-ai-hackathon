import assert from "node:assert/strict";
import test from "node:test";

import {
  WHATSAPP_INTAKE_CONVERSATION_LIMIT_REASON,
  WHATSAPP_INTAKE_PLAN_CACHE_TTL_MS,
  WHATSAPP_INTAKE_TRIAL_EXPIRED_REASON,
  buildWhatsAppIntakePlanSkipBody,
  buildWhatsAppNotPlanSkippedReceiptFilter,
  buildWhatsAppPlanSkippedProcessResult,
  buildWhatsAppPlanSkippedReceiptFilter,
  createWhatsAppIntakePlanGate,
  getOrCreateWhatsAppConversationWithPlanGate,
  readWhatsAppIntakePlanSkipReason,
  readWhatsAppPlanSkippedProcessResult,
  resolveWhatsAppIntakePlanSkip,
  resolveWhatsAppNewConversationPlanSkip,
  type WhatsAppIntakeCompanyPlan,
} from "./whatsapp-intake-plan-gate";

const UNLOCKED: WhatsAppIntakeCompanyPlan = {
  trialExpired: false,
  newConversationsAllowed: true,
};
const TRIAL_EXPIRED: WhatsAppIntakeCompanyPlan = {
  trialExpired: true,
  newConversationsAllowed: false,
};
const AT_CONVERSATION_CAP: WhatsAppIntakeCompanyPlan = {
  trialExpired: false,
  newConversationsAllowed: false,
};

function createClock(start = 1_000_000) {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

function createWarnings() {
  const warnings: Array<[string, Record<string, unknown> | undefined]> = [];
  return {
    warnings,
    logger: {
      warn: (event: string, context?: Record<string, unknown>) => {
        warnings.push([event, context]);
      },
    },
  };
}

test("only a trial-expired company is locked out of whole-item intake", () => {
  // Paid, active-trial, null-trial and the 500-cap all read trialExpired=false
  // from company-limits; only an expired free trial skips the item.
  assert.equal(resolveWhatsAppIntakePlanSkip(UNLOCKED), null);
  assert.equal(resolveWhatsAppIntakePlanSkip(AT_CONVERSATION_CAP), null);
  assert.deepEqual(resolveWhatsAppIntakePlanSkip(TRIAL_EXPIRED), {
    reason: WHATSAPP_INTAKE_TRIAL_EXPIRED_REASON,
    message: "WhatsApp intake skipped: company plan locked",
  });
});

test("new conversations follow ensureCompanyConversationCapacity", () => {
  assert.equal(resolveWhatsAppNewConversationPlanSkip(UNLOCKED), null);
  assert.equal(
    resolveWhatsAppNewConversationPlanSkip(AT_CONVERSATION_CAP)?.reason,
    WHATSAPP_INTAKE_CONVERSATION_LIMIT_REASON,
  );
  assert.equal(
    resolveWhatsAppNewConversationPlanSkip(TRIAL_EXPIRED)?.reason,
    WHATSAPP_INTAKE_TRIAL_EXPIRED_REASON,
  );
});

test("skip bodies complete the receipt and never read as a retryable onboarding skip", () => {
  for (const plan of [TRIAL_EXPIRED, AT_CONVERSATION_CAP]) {
    const skip = resolveWhatsAppNewConversationPlanSkip(plan)!;
    const body = buildWhatsAppIntakePlanSkipBody(skip);
    assert.equal(body.status, "ok");
    assert.equal(body.reason, skip.reason);
    const text = JSON.stringify(body).toLowerCase();
    for (const retryable of [
      "source not found",
      "history skipped",
      "state_sync skipped",
    ]) {
      assert.equal(text.includes(retryable), false, retryable);
    }
  }
});

test("the receipt marker reads only plan skip reasons, and --plan-skipped selects both", () => {
  const selected = buildWhatsAppPlanSkippedReceiptFilter().planSkipReason.$in;
  for (const plan of [TRIAL_EXPIRED, AT_CONVERSATION_CAP]) {
    const skip = resolveWhatsAppNewConversationPlanSkip(plan)!;
    // Live and echo bodies, and history child bodies with an outcome.
    for (const details of [
      buildWhatsAppIntakePlanSkipBody(skip),
      { status: "ok", historyOutcome: "skipped", reason: skip.reason },
      { status: "ok", message: "echoes processed", reason: skip.reason },
    ]) {
      const reason = readWhatsAppIntakePlanSkipReason(details);
      assert.equal(reason, skip.reason);
      assert.ok(selected.includes(reason!));
    }
  }
  for (const details of [
    null,
    "company_trial_expired",
    { status: "ok", message: "echoes processed" },
    { status: "ok", reason: "source_disconnected" },
  ]) {
    assert.equal(readWhatsAppIntakePlanSkipReason(details), null);
  }
  assert.deepEqual([...selected].sort(), [
    WHATSAPP_INTAKE_CONVERSATION_LIMIT_REASON,
    WHATSAPP_INTAKE_TRIAL_EXPIRED_REASON,
  ]);
  // --fast-import selects exactly the complement, so no marked receipt can be
  // completed by an importer that bypasses the processor.
  assert.deepEqual(
    [...buildWhatsAppNotPlanSkippedReceiptFilter().planSkipReason.$nin].sort(),
    [...selected].sort(),
  );
});

test("a plan-skipped processor result is recognized and nothing else is", () => {
  const capSkip = resolveWhatsAppNewConversationPlanSkip(AT_CONVERSATION_CAP)!;
  const result = buildWhatsAppPlanSkippedProcessResult(capSkip);
  assert.equal(result.conversationId, "");
  assert.deepEqual(readWhatsAppPlanSkippedProcessResult(result), capSkip);
  assert.equal(readWhatsAppPlanSkippedProcessResult(null), null);
  assert.equal(
    readWhatsAppPlanSkippedProcessResult({
      conversationId: "conversation-1",
      processedAs: "reaction",
    }),
    null,
  );
  assert.equal(
    readWhatsAppPlanSkippedProcessResult({
      processedAs: "unsupported_skipped",
    }),
    null,
  );
});

test("the gate caches a successful plan read per workspace for the TTL", async () => {
  const clock = createClock();
  const reads: string[] = [];
  const gate = createWhatsAppIntakePlanGate({
    readPlan: async (workspaceId) => {
      reads.push(workspaceId);
      return workspaceId === "locked" ? TRIAL_EXPIRED : UNLOCKED;
    },
    now: clock.now,
  });

  assert.equal(
    (await gate.getIntakeSkip({ workspaceId: "locked", itemKind: "message" }))
      ?.reason,
    WHATSAPP_INTAKE_TRIAL_EXPIRED_REASON,
  );
  assert.equal(
    await gate.getIntakeSkip({ workspaceId: "open", itemKind: "echo" }),
    null,
  );
  clock.advance(WHATSAPP_INTAKE_PLAN_CACHE_TTL_MS - 1);
  await gate.getIntakeSkip({ workspaceId: "locked", itemKind: "message" });
  await gate.getIntakeSkip({ workspaceId: "open", itemKind: "message" });
  assert.deepEqual(reads, ["locked", "open"]);

  clock.advance(1);
  await gate.getIntakeSkip({ workspaceId: "locked", itemKind: "message" });
  assert.deepEqual(reads, ["locked", "open", "locked"]);
});

test("an upgrade is seen once the cached verdict expires", async () => {
  const clock = createClock();
  let plan = TRIAL_EXPIRED;
  const gate = createWhatsAppIntakePlanGate({
    readPlan: async () => plan,
    now: clock.now,
  });
  const input = { workspaceId: "workspace-1", itemKind: "message" as const };
  assert.ok(await gate.getIntakeSkip(input));
  plan = UNLOCKED;
  assert.ok(await gate.getIntakeSkip(input));
  clock.advance(WHATSAPP_INTAKE_PLAN_CACHE_TTL_MS);
  assert.equal(await gate.getIntakeSkip(input), null);
});

test("concurrent reads for one workspace share a single plan request", async () => {
  let reads = 0;
  let release!: () => void;
  const gate = createWhatsAppIntakePlanGate({
    readPlan: async () => {
      reads += 1;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return TRIAL_EXPIRED;
    },
  });
  const input = { workspaceId: "workspace-1", itemKind: "message" as const };
  const pending = Promise.all([
    gate.getIntakeSkip(input),
    gate.getIntakeSkip(input),
    gate.getIntakeSkip(input),
  ]);
  await new Promise((resolve) => setImmediate(resolve));
  release();
  const results = await pending;
  assert.equal(reads, 1);
  assert.ok(results.every((skip) => skip?.reason === "company_trial_expired"));
});

test("a plan read failure fails open, logs the workspace, and is not cached", async () => {
  let fail = true;
  let reads = 0;
  const { warnings, logger } = createWarnings();
  const gate = createWhatsAppIntakePlanGate({
    readPlan: async () => {
      reads += 1;
      if (fail) throw new Error("supabase unavailable");
      return TRIAL_EXPIRED;
    },
    logger,
  });
  const input = {
    workspaceId: "workspace-1",
    sourceId: "source-1",
    itemKind: "echo" as const,
  };

  assert.equal(await gate.getIntakeSkip(input), null);
  assert.equal(
    await gate.getNewConversationSkip({
      ...input,
      itemKind: "new_conversation",
    }),
    null,
  );
  assert.equal(warnings.length, 2);
  assert.equal(warnings[0]![0], "whatsapp.intake_plan_gate.read_failed");
  assert.deepEqual(
    {
      workspaceId: warnings[0]![1]?.workspaceId,
      sourceId: warnings[0]![1]?.sourceId,
      itemKind: warnings[0]![1]?.itemKind,
      failurePolicy: warnings[0]![1]?.failurePolicy,
    },
    {
      workspaceId: "workspace-1",
      sourceId: "source-1",
      itemKind: "echo",
      failurePolicy: "fail_open",
    },
  );

  fail = false;
  assert.equal(
    (await gate.getIntakeSkip(input))?.reason,
    "company_trial_expired",
  );
  assert.equal(reads, 3);
});

test("new-conversation checks read fresh until a refusal is cached", async () => {
  const clock = createClock();
  let plan = UNLOCKED;
  let reads = 0;
  const gate = createWhatsAppIntakePlanGate({
    readPlan: async () => {
      reads += 1;
      return plan;
    },
    now: clock.now,
  });
  const input = {
    workspaceId: "workspace-1",
    itemKind: "new_conversation" as const,
  };

  assert.equal(await gate.getNewConversationSkip(input), null);
  assert.equal(await gate.getNewConversationSkip(input), null);
  assert.equal(reads, 2, "an allowed create never trusts a cached count");

  plan = AT_CONVERSATION_CAP;
  assert.equal(
    (await gate.getNewConversationSkip(input))?.reason,
    WHATSAPP_INTAKE_CONVERSATION_LIMIT_REASON,
  );
  assert.equal(
    (await gate.getNewConversationSkip(input))?.reason,
    WHATSAPP_INTAKE_CONVERSATION_LIMIT_REASON,
  );
  assert.equal(reads, 3, "a cached refusal is reused within the TTL");
  // The cap alone never locks whole-item intake.
  assert.equal(
    await gate.getIntakeSkip({ ...input, itemKind: "message" }),
    null,
  );
  assert.equal(reads, 3);
});

test("the plan cache stays bounded", async () => {
  const reads: string[] = [];
  const gate = createWhatsAppIntakePlanGate({
    readPlan: async (workspaceId) => {
      reads.push(workspaceId);
      return UNLOCKED;
    },
    maxEntries: 2,
  });
  for (const workspaceId of ["a", "b", "c", "a"]) {
    await gate.getIntakeSkip({ workspaceId, itemKind: "message" });
  }
  assert.deepEqual(reads, ["a", "b", "c", "a"]);
});

test("conversation create gate: an existing owner is appended without a plan read", async () => {
  let planReads = 0;
  let creates = 0;
  const result = await getOrCreateWhatsAppConversationWithPlanGate({
    workspaceId: "workspace-1",
    sourceId: "source-1",
    itemKind: "new_conversation",
    getNewConversationSkip: async () => {
      planReads += 1;
      return resolveWhatsAppNewConversationPlanSkip(AT_CONVERSATION_CAP);
    },
    getOrCreate: async () => ({
      conversation: { _id: "existing" },
      created: false,
    }),
    create: async () => {
      creates += 1;
      return { _id: "new" };
    },
  });
  assert.deepEqual(result, {
    owner: { conversation: { _id: "existing" }, created: false },
    skip: null,
  });
  assert.equal(planReads, 0);
  assert.equal(creates, 0);
});

test("conversation create gate: a refused create returns a typed skip and creates nothing", async () => {
  for (const plan of [AT_CONVERSATION_CAP, TRIAL_EXPIRED]) {
    let creates = 0;
    const result = await getOrCreateWhatsAppConversationWithPlanGate({
      workspaceId: "workspace-1",
      sourceId: "source-1",
      itemKind: "history_message",
      getNewConversationSkip: async (input) => {
        assert.deepEqual(input, {
          workspaceId: "workspace-1",
          sourceId: "source-1",
          itemKind: "history_message",
        });
        return resolveWhatsAppNewConversationPlanSkip(plan);
      },
      // Mirrors the ownership helper: a null create yields a null owner.
      getOrCreate: async (create) => {
        const conversation = await create("key", ["key"]);
        return conversation ? { conversation, created: true } : null;
      },
      create: async () => {
        creates += 1;
        return { _id: "new" };
      },
    });
    assert.equal(result.owner, null);
    assert.equal(
      result.skip?.reason,
      resolveWhatsAppNewConversationPlanSkip(plan)?.reason,
    );
    assert.equal(creates, 0);
  }
});

test("conversation create gate: an allowed or ungated create proceeds", async () => {
  for (const getNewConversationSkip of [async () => null, undefined]) {
    const result = await getOrCreateWhatsAppConversationWithPlanGate({
      workspaceId: "workspace-1",
      sourceId: "source-1",
      itemKind: "new_conversation",
      getNewConversationSkip,
      getOrCreate: async (create) => {
        const conversation = await create("key", ["key"]);
        return conversation ? { conversation, created: true } : null;
      },
      create: async (ownershipKey) => ({ _id: ownershipKey }),
    });
    assert.deepEqual(result, {
      owner: { conversation: { _id: "key" }, created: true },
      skip: null,
    });
  }
});

test("conversation create gate: a missing owner without a plan skip still fails loudly", async () => {
  await assert.rejects(
    getOrCreateWhatsAppConversationWithPlanGate({
      workspaceId: "workspace-1",
      sourceId: "source-1",
      itemKind: "new_conversation",
      getNewConversationSkip: async () => null,
      getOrCreate: async () => null,
      create: async () => ({ _id: "new" }),
    }),
    /owner was not created/,
  );
});
