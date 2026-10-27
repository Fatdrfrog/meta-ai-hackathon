import type { Message } from "@google-cloud/pubsub";
import { airiWorkerLogger } from "@icecore/airi-runtime/logging";
import {
  CONVERSATION_CLASSIFICATION_PUBSUB_SUBSCRIPTION_DEFAULT,
  normalizeConversationClassificationWakeData,
  type ConversationClassificationWakeData,
} from "@icecore/temporal";

import type { dispatchConversationClassificationEffects } from "@/lib/classifier/conversation-classification-effects";
import type { executeConversationClassification } from "@/lib/classifier/conversation-classification-executor";
import type {
  claimConversationClassification,
  ConversationClassificationBlockObservation,
  ConversationClassificationWakeState,
  markConversationClassificationBlocked,
  readConversationClassificationWakeState,
  recoverExpiredSupersededConversationClassificationLease,
} from "@/lib/classifier/conversation-classification-store";
import type { ensureCompanyClassificationCapacity } from "@/lib/limits/company-limits";
import type { supabaseAdmin } from "@/lib/supabase/admin";
import {
  compactEnv,
  createPubSubSubscription,
  parseEnabledFlag,
} from "./pubsub-consumer-runtime.js";
import { isValidDate } from "@icecore/shared/lib/value-utils";

export type ConversationClassificationConsumerRuntimeDependencies = {
  connectDB: () => Promise<unknown>;
  readConversationClassificationWakeState: typeof readConversationClassificationWakeState;
  recoverExpiredSupersededConversationClassificationLease: typeof recoverExpiredSupersededConversationClassificationLease;
  supabaseAdmin: typeof supabaseAdmin;
  ensureCompanyClassificationCapacity: (
    supabase: Parameters<typeof ensureCompanyClassificationCapacity>[0],
    workspaceId: Parameters<typeof ensureCompanyClassificationCapacity>[1],
  ) => Promise<{ allowed: boolean }>;
  markConversationClassificationBlocked: typeof markConversationClassificationBlocked;
  claimConversationClassification: typeof claimConversationClassification;
  executeConversationClassification: typeof executeConversationClassification;
  dispatchConversationClassificationEffects: typeof dispatchConversationClassificationEffects;
  classificationCapacityLimitCode: string;
  classificationCapacityRecheckMs: number;
};

export type ConversationClassificationConsumerDependencies = {
  createPubSubSubscription: typeof createPubSubSubscription;
  loadRuntimeDependencies: () => Promise<ConversationClassificationConsumerRuntimeDependencies>;
  now: () => Date;
  logger: Pick<typeof airiWorkerLogger, "info" | "error">;
};

type WakeDisposition = {
  disposition: "ack" | "nack";
  outcome: string;
};

type ProcessWakeStateOptions = {
  allowDueAttempt: boolean;
  allowSupersededRecovery: boolean;
};

type WorkspaceAllowlist = "all" | ReadonlySet<string>;

const LOG_NAME = "conversation.classification.pubsub.consumer";
const CAPACITY_BLOCK_REASON = "Company classification capacity is exhausted";
const WORKSPACE_ALLOWLIST_ENV =
  "CONVERSATION_CLASSIFICATION_WORKSPACE_ALLOWLIST";
const NOT_ENABLED_BLOCK_CODE = "classification_not_enabled";
const NOT_ENABLED_BLOCK_REASON =
  "Classification is not enabled for this workspace";
// A new message requeues the conversation anyway; the recheck only lets idle
// conversations pick up a later enablement without churning the backlog.
const NOT_ENABLED_RECHECK_MS = 7 * 24 * 60 * 60 * 1_000;

async function loadProductionRuntimeDependencies(): Promise<ConversationClassificationConsumerRuntimeDependencies> {
  const [
    mongooseModule,
    store,
    limits,
    constants,
    executor,
    effects,
    supabase,
  ] = await Promise.all([
    import("@/lib/mongoose"),
    import("@/lib/classifier/conversation-classification-store"),
    import("@/lib/limits/company-limits"),
    import("@/lib/classifier/conversation-analysis-constants"),
    import("@/lib/classifier/conversation-classification-executor"),
    import("@/lib/classifier/conversation-classification-effects"),
    import("@/lib/supabase/admin"),
  ]);

  return {
    connectDB: mongooseModule.default as () => Promise<unknown>,
    readConversationClassificationWakeState:
      store.readConversationClassificationWakeState,
    recoverExpiredSupersededConversationClassificationLease:
      store.recoverExpiredSupersededConversationClassificationLease,
    supabaseAdmin: supabase.supabaseAdmin,
    ensureCompanyClassificationCapacity:
      limits.ensureCompanyClassificationCapacity,
    markConversationClassificationBlocked:
      store.markConversationClassificationBlocked,
    claimConversationClassification: store.claimConversationClassification,
    executeConversationClassification:
      executor.executeConversationClassification,
    dispatchConversationClassificationEffects:
      effects.dispatchConversationClassificationEffects,
    classificationCapacityLimitCode:
      limits.COMPANY_CLASSIFICATION_LIMIT_EXCEEDED_CODE,
    classificationCapacityRecheckMs:
      constants.CONVERSATION_CLASSIFICATION_CAPACITY_RECHECK_MS,
  };
}

const productionDependencies: ConversationClassificationConsumerDependencies =
  Object.freeze({
    createPubSubSubscription,
    loadRuntimeDependencies: loadProductionRuntimeDependencies,
    now: () => new Date(),
    logger: airiWorkerLogger,
  });

function dependencies(
  overrides: Partial<ConversationClassificationConsumerDependencies> = {},
): ConversationClassificationConsumerDependencies {
  return {
    createPubSubSubscription:
      overrides.createPubSubSubscription ??
      productionDependencies.createPubSubSubscription,
    loadRuntimeDependencies:
      overrides.loadRuntimeDependencies ??
      productionDependencies.loadRuntimeDependencies,
    now: overrides.now ?? productionDependencies.now,
    logger: overrides.logger ?? productionDependencies.logger,
  };
}

/** Unset or empty enables no workspace; `*` enables every workspace. */
function readWorkspaceAllowlist(): WorkspaceAllowlist {
  const entries = (compactEnv(WORKSPACE_ALLOWLIST_ENV) ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  return entries.includes("*") ? "all" : new Set(entries);
}

function isWorkspaceAllowed(
  allowlist: WorkspaceAllowlist,
  workspaceId: string,
): boolean {
  return allowlist === "all" || allowlist.has(workspaceId.toLowerCase());
}

function parseMessage(message: Message): ConversationClassificationWakeData {
  return normalizeConversationClassificationWakeData(
    JSON.parse(message.data.toString("utf8")),
  );
}

function ack(outcome: string): WakeDisposition {
  return { disposition: "ack", outcome };
}

function nack(outcome: string): WakeDisposition {
  return { disposition: "nack", outcome };
}

function hasValidProcessingIdentity(
  state: ConversationClassificationWakeState,
): state is ConversationClassificationWakeState & {
  state: ConversationClassificationWakeState["state"] & {
    processingRevision: number;
    lease: NonNullable<ConversationClassificationWakeState["state"]["lease"]>;
  };
} {
  const processingRevision = state.state.processingRevision;
  const lease = state.state.lease;
  return (
    Number.isSafeInteger(processingRevision) &&
    (processingRevision as number) >= 1 &&
    Number.isSafeInteger(state.state.fence) &&
    state.state.fence >= 1 &&
    lease !== null &&
    typeof lease.ownerToken === "string" &&
    lease.ownerToken.length > 0 &&
    lease.ownerToken === lease.ownerToken.trim() &&
    isValidDate(lease.claimedAt) &&
    isValidDate(lease.expiresAt) &&
    lease.claimedAt.getTime() <= lease.expiresAt.getTime()
  );
}

function currentReadyAnalysisId(
  state: ConversationClassificationWakeState,
): string | null {
  const analysisRevisionId =
    state.classificationMeta?.analysisRevisionId ?? null;
  return state.isClassified === true &&
    state.state.appliedRevision === state.classificationRevision &&
    state.classificationMeta?.sourceRevision === state.classificationRevision &&
    typeof analysisRevisionId === "string" &&
    analysisRevisionId.length > 0 &&
    analysisRevisionId === analysisRevisionId.trim()
    ? analysisRevisionId
    : null;
}

async function dispatchEffects(
  analysisRevisionId: string,
  runtime: ConversationClassificationConsumerRuntimeDependencies,
): Promise<WakeDisposition> {
  const result = await runtime.dispatchConversationClassificationEffects({
    analysisRevisionId,
  });
  switch (result.status) {
    case "completed":
    case "retry_scheduled":
    case "superseded":
    case "lease_lost":
      return ack(`effects_${result.status}`);
    default: {
      const exhaustive: never = result;
      throw new Error(
        `Unexpected classification effects outcome: ${String(exhaustive)}`,
      );
    }
  }
}

async function executeClaim(
  claim: NonNullable<
    Awaited<
      ReturnType<
        ConversationClassificationConsumerRuntimeDependencies["claimConversationClassification"]
      >
    >
  >,
  runtime: ConversationClassificationConsumerRuntimeDependencies,
): Promise<WakeDisposition> {
  const result = await runtime.executeConversationClassification(claim);
  switch (result.status) {
    case "ready":
      if (
        typeof result.analysisRevisionId !== "string" ||
        result.analysisRevisionId.length === 0 ||
        result.analysisRevisionId !== result.analysisRevisionId.trim()
      ) {
        throw new Error("Ready classification result has invalid analysis id");
      }
      return dispatchEffects(result.analysisRevisionId, runtime);
    case "review_required":
    case "retry_scheduled":
    case "failed":
    case "media_deferred":
    case "stale":
      return ack(`classification_${result.status}`);
    default: {
      const exhaustive: never = result;
      throw new Error(
        `Unexpected classification executor outcome: ${String(exhaustive)}`,
      );
    }
  }
}

async function rereadAfterRace(input: {
  event: ConversationClassificationWakeData;
  runtime: ConversationClassificationConsumerRuntimeDependencies;
  clock: () => Date;
  allowlist: WorkspaceAllowlist;
}): Promise<WakeDisposition> {
  const state = await input.runtime.readConversationClassificationWakeState(
    input.event.conversationId,
  );
  if (!state) return ack("deleted_after_race");
  const now = input.clock();
  return processWakeState({
    ...input,
    state,
    now,
    options: {
      allowDueAttempt: false,
      allowSupersededRecovery: false,
    },
  });
}

type DueClassificationInput = {
  event: ConversationClassificationWakeData;
  state: ConversationClassificationWakeState;
  observation: ConversationClassificationBlockObservation;
  runtime: ConversationClassificationConsumerRuntimeDependencies;
  now: Date;
  clock: () => Date;
  allowlist: WorkspaceAllowlist;
};

async function blockDueClassification(
  input: DueClassificationInput,
  block: { code: string; reason: string; recheckMs: number; outcome: string },
): Promise<WakeDisposition> {
  const blocked = await input.runtime.markConversationClassificationBlocked({
    observation: input.observation,
    code: block.code,
    reason: block.reason,
    recheckAt: new Date(input.now.getTime() + block.recheckMs),
  });
  if (blocked) return ack(block.outcome);
  return rereadAfterRace(input);
}

async function attemptDueClassification(
  input: DueClassificationInput,
): Promise<WakeDisposition> {
  if (!isWorkspaceAllowed(input.allowlist, input.state.workspaceId)) {
    return blockDueClassification(input, {
      code: NOT_ENABLED_BLOCK_CODE,
      reason: NOT_ENABLED_BLOCK_REASON,
      recheckMs: NOT_ENABLED_RECHECK_MS,
      outcome: "not_enabled_blocked",
    });
  }

  const capacity = await input.runtime.ensureCompanyClassificationCapacity(
    input.runtime.supabaseAdmin,
    input.state.workspaceId,
  );
  if (!capacity || typeof capacity.allowed !== "boolean") {
    throw new Error("Classification capacity result is invalid");
  }

  if (!capacity.allowed) {
    return blockDueClassification(input, {
      code: input.runtime.classificationCapacityLimitCode,
      reason: CAPACITY_BLOCK_REASON,
      recheckMs: input.runtime.classificationCapacityRecheckMs,
      outcome: "capacity_blocked",
    });
  }

  const claim = await input.runtime.claimConversationClassification({
    conversationId: input.event.conversationId,
  });
  if (!claim) return rereadAfterRace(input);
  return executeClaim(claim, input.runtime);
}

async function processWakeState(input: {
  event: ConversationClassificationWakeData;
  state: ConversationClassificationWakeState;
  runtime: ConversationClassificationConsumerRuntimeDependencies;
  now: Date;
  clock: () => Date;
  allowlist: WorkspaceAllowlist;
  options: ProcessWakeStateOptions;
}): Promise<WakeDisposition> {
  const { event, state, runtime, now, clock, allowlist, options } = input;
  if (
    state.conversationId !== event.conversationId ||
    state.state.contractVersion !== 2 ||
    state.state.requestedRevision !== state.classificationRevision
  ) {
    return nack("corrupt_authoritative_identity");
  }

  const revisionFuture = event.requestedRevision > state.classificationRevision;
  const generationFuture = event.generation > state.state.generation;
  if (revisionFuture || generationFuture) {
    return nack("future_or_crossed_identity");
  }
  if (
    event.requestedRevision < state.classificationRevision ||
    event.generation < state.state.generation
  ) {
    return ack("stale_identity");
  }

  switch (state.state.status) {
    case "pending":
    case "blocked": {
      if (!isValidDate(state.state.nextAttemptAt)) {
        return nack("corrupt_due_time");
      }
      if (state.state.nextAttemptAt.getTime() > now.getTime()) {
        return ack("future_backoff");
      }
      if (!options.allowDueAttempt) return nack("unchanged_due_race");
      return attemptDueClassification({
        event,
        state,
        observation: {
          kind: "due",
          conversationId: event.conversationId,
          revision: event.requestedRevision,
        },
        runtime,
        now,
        clock,
        allowlist,
      });
    }
    case "processing": {
      if (!hasValidProcessingIdentity(state)) {
        return nack("corrupt_processing_identity");
      }
      if (state.state.processingRevision > event.requestedRevision) {
        return nack("processing_revision_ahead");
      }
      if (state.state.lease.expiresAt.getTime() > now.getTime()) {
        return ack("live_processing_duplicate");
      }
      if (state.state.processingRevision < event.requestedRevision) {
        if (!options.allowSupersededRecovery) {
          return nack("unchanged_expired_superseded_race");
        }
        const recovery =
          await runtime.recoverExpiredSupersededConversationClassificationLease(
            {
              observed: {
                conversationId: event.conversationId,
                requestedRevision: event.requestedRevision,
                generation: event.generation,
                processingRevision: state.state.processingRevision,
                ownerToken: state.state.lease.ownerToken,
                fence: state.state.fence,
                expiresAt: state.state.lease.expiresAt,
              },
              recoveredAt: now,
            },
          );
        if (recovery !== "recovered" && recovery !== "changed") {
          return nack(`invalid_recovery_${recovery}`);
        }
        const recoveredState =
          await runtime.readConversationClassificationWakeState(
            event.conversationId,
          );
        if (!recoveredState) return ack("deleted_after_recovery");
        const recoveredNow = clock();
        return processWakeState({
          event,
          state: recoveredState,
          runtime,
          now: recoveredNow,
          clock,
          allowlist,
          options: {
            allowDueAttempt: true,
            allowSupersededRecovery: false,
          },
        });
      }
      if (!options.allowDueAttempt) return nack("unchanged_due_race");
      return attemptDueClassification({
        event,
        state,
        observation: {
          kind: "expired_processing",
          lease: {
            conversationId: event.conversationId,
            revision: event.requestedRevision,
            ownerToken: state.state.lease.ownerToken,
            fence: state.state.fence,
            expiresAt: state.state.lease.expiresAt,
          },
        },
        runtime,
        now,
        clock,
        allowlist,
      });
    }
    case "ready": {
      const analysisRevisionId = currentReadyAnalysisId(state);
      return analysisRevisionId
        ? dispatchEffects(analysisRevisionId, runtime)
        : nack("corrupt_ready_projection");
    }
    case "review_required":
    case "failed":
    case "not_applicable":
      return ack(`terminal_${state.state.status}`);
    default: {
      const exhaustive: never = state.state.status;
      return nack(`unknown_state_${String(exhaustive)}`);
    }
  }
}

async function processWake(input: {
  event: ConversationClassificationWakeData;
  runtime: ConversationClassificationConsumerRuntimeDependencies;
  now: () => Date;
  allowlist: WorkspaceAllowlist;
}): Promise<WakeDisposition> {
  await input.runtime.connectDB();
  const state = await input.runtime.readConversationClassificationWakeState(
    input.event.conversationId,
  );
  if (!state) return ack("deleted");
  return processWakeState({
    event: input.event,
    runtime: input.runtime,
    state,
    now: input.now(),
    clock: input.now,
    allowlist: input.allowlist,
    options: {
      allowDueAttempt: true,
      allowSupersededRecovery: true,
    },
  });
}

function messageLogContext(input: {
  message: Message;
  event: ConversationClassificationWakeData | null;
  disposition: WakeDisposition;
  durationMs: number;
  errorCategory: string | null;
}): Record<string, unknown> {
  return {
    note:
      input.disposition.disposition === "ack"
        ? "message_acked"
        : "message_nacked",
    outcome: input.disposition.outcome,
    messageId: input.message.id || null,
    eventId: input.event?.eventId ?? null,
    conversationId: input.event?.conversationId ?? null,
    requestedRevision: input.event?.requestedRevision ?? null,
    generation: input.event?.generation ?? null,
    errorCategory: input.errorCategory,
    durationMs: input.durationMs,
  };
}

export async function startConversationClassificationPubSubConsumer(
  overrides: Partial<ConversationClassificationConsumerDependencies> = {},
): Promise<() => Promise<void>> {
  const deps = dependencies(overrides);
  if (
    !parseEnabledFlag(process.env.CONVERSATION_CLASSIFICATION_PUBSUB_ENABLED)
  ) {
    deps.logger.info(LOG_NAME, { note: "disabled" });
    return async () => undefined;
  }

  const subscriptionName =
    compactEnv("CONVERSATION_CLASSIFICATION_PUBSUB_SUBSCRIPTION") ||
    CONVERSATION_CLASSIFICATION_PUBSUB_SUBSCRIPTION_DEFAULT;
  const allowlist = readWorkspaceAllowlist();
  const { projectId, subscription } = deps.createPubSubSubscription({
    projectIdEnvName: "CONVERSATION_CLASSIFICATION_PUBSUB_PROJECT_ID",
    subscriptionName,
    maxMessagesEnvName: "CONVERSATION_CLASSIFICATION_PUBSUB_MAX_MESSAGES",
    defaultMaxMessages: 10,
  });
  const inFlight = new Set<Promise<void>>();
  let stopping = false;
  let stopPromise: Promise<void> | null = null;

  const handleMessage = async (message: Message): Promise<void> => {
    const startedAt = Date.now();
    let event: ConversationClassificationWakeData | null = null;
    let disposition: WakeDisposition;
    let errorCategory: string | null = null;
    try {
      event = parseMessage(message);
      const runtime = await deps.loadRuntimeDependencies();
      disposition = await processWake({
        event,
        runtime,
        now: deps.now,
        allowlist,
      });
      if (disposition.disposition === "nack") {
        errorCategory = "consumer_invariant_rejected";
      }
    } catch {
      disposition = nack("processing_failed");
      errorCategory = "consumer_processing_failed";
    }

    if (disposition.disposition === "ack") {
      message.ack();
    } else {
      message.nack();
    }

    const context = messageLogContext({
      message,
      event,
      disposition,
      durationMs: Date.now() - startedAt,
      errorCategory,
    });
    if (disposition.disposition === "ack") {
      deps.logger.info(LOG_NAME, context);
    } else {
      deps.logger.error(LOG_NAME, undefined, context);
    }
  };

  const onMessage = (message: Message) => {
    if (stopping) {
      message.nack();
      deps.logger.info(LOG_NAME, {
        note: "stopping_nack",
        messageId: message.id || null,
      });
      return;
    }
    const handler = Promise.resolve().then(() => handleMessage(message));
    inFlight.add(handler);
    void handler
      .finally(() => {
        inFlight.delete(handler);
      })
      .catch(() => undefined);
  };

  const onError = (_error: Error) => {
    deps.logger.error(LOG_NAME, undefined, {
      note: "subscription_error",
      subscription: subscriptionName,
      errorCategory: "subscription_error",
    });
  };

  subscription.on("message", onMessage);
  subscription.on("error", onError);
  deps.logger.info(LOG_NAME, {
    note: "started",
    projectId: projectId || null,
    subscription: subscriptionName,
    workspaceAllowlist: allowlist === "all" ? "all" : allowlist.size,
  });

  return () => {
    if (stopPromise) return stopPromise;
    stopping = true;
    subscription.removeListener("message", onMessage);
    subscription.removeListener("error", onError);
    stopPromise = (async () => {
      await Promise.allSettled([...inFlight]);
      await subscription.close();
    })();
    return stopPromise;
  };
}
