import "server-only";
import type { AiriTurnPreparationClaim } from "@icecore/airi-runtime";
import type { AiriScenarioRuntimeConfig } from "@icecore/airi-runtime/scenario-runtime-types";
import {
  readAiriDeliveryConversationId,
  readAiriDeliveryWorkspaceId,
} from "@icecore/airi-runtime/delivery-gates";
import { asRecord } from "@icecore/shared/lib/value-utils";
import { createHash, randomUUID } from "node:crypto";
import {
  getAiriConversationTurnKey,
  toAiriConversationTurnReference,
  type AiriConversationTurnDisposition,
  type AiriConversationTurnProcessResult,
  type AiriConversationTurnReference,
} from "@icecore/temporal";
import connectDB from "@/lib/mongoose";
import { isMongoDuplicateKeyError } from "@/lib/mongo-errors";
import AiriTurnContext from "@/models/airi-turn-context";

type PreparationState =
  | "preparing"
  | "retryable"
  | "prepared"
  | "outcome_unknown"
  | "terminal";
type Owner = {
  turnDisposition?: {
    status: AiriConversationTurnDisposition["status"];
    updatedAt?: string;
  };
  turnPreparation?: {
    status: PreparationState;
    attemptToken: string;
    result?: AiriConversationTurnProcessResult;
  };
};
type DispatchOwner = {
  messageId?: string | null;
  temporalDispatch?: {
    state: string;
    attemptToken: string;
    claimedAt?: Date | null;
    terminalCode?: string | null;
  } | null;
};

function identity(turn: AiriConversationTurnReference) {
  if (!turn.workspaceId || !turn.conversationId || !turn.messageId)
    throw new Error(
      "Airi turn execution requires workspace, conversation, and message ids"
    );
  const turnContextId =
    turn.turnContextId ||
    `airi-execution:${createHash("sha256")
      .update(
        JSON.stringify([
          turn.workspaceId,
          turn.conversationId,
          getAiriConversationTurnKey(turn),
          turn.channel || null,
          turn.sourceId || null,
          turn.triggerEventKind || null,
          turn.scenarioOverrideId || null,
        ])
      )
      .digest("hex")}`;
  return {
    turnContextId,
    workspaceId: turn.workspaceId,
    conversationId: turn.conversationId,
    messageId: turn.messageId,
  };
}

function ownerFilter(claim: AiriTurnPreparationClaim) {
  return {
    turnContextId: claim.turnContextId,
    workspaceId: claim.workspaceId,
    conversationId: claim.conversationId,
    messageId: claim.messageId,
    "turnPreparation.status": "preparing",
    "turnPreparation.attemptToken": claim.attemptToken,
  };
}

function readCheckpoint(
  owner: Owner | null,
  messageId: string
): AiriConversationTurnProcessResult | null {
  const preparation = owner?.turnPreparation;
  const result = preparation?.result;
  if (
    (preparation?.status !== "prepared" &&
      preparation?.status !== "terminal") ||
    !result ||
    result.messageId !== messageId ||
    typeof result.completedAt !== "string" ||
    !result.outcome ||
    !["completed", "response", "failed"].includes(
      result.outcome.executionStatus
    )
  )
    return null;
  if (
    result.pendingDelivery &&
    (!result.pendingDelivery.deliveryKey ||
      !result.pendingDelivery.reservedMessageId ||
      !result.pendingDelivery.context ||
      typeof result.pendingDelivery.context !== "object")
  )
    return null;
  return result;
}

export async function claimAiriTurnPreparation(
  turn: AiriConversationTurnReference
): Promise<
  | AiriTurnPreparationClaim
  | { status: "prepared"; result: AiriConversationTurnProcessResult }
  | { status: "outcome_unknown" | "terminal" }
> {
  await connectDB();
  const scope = identity(turn);
  const attemptToken = randomUUID();
  let claimed: Owner | null = null;
  try {
    claimed = await AiriTurnContext.findOneAndUpdate(
      {
        ...scope,
        "turnDisposition.status": {
          $nin: ["terminal", "superseded", "completed", "outcome_unknown"],
        },
        $or: [
          { turnPreparation: { $exists: false } },
          { "turnPreparation.status": "retryable" },
        ],
      },
      {
        $setOnInsert: {
          ...scope,
          channel: turn.channel || null,
          sourceId: turn.sourceId || null,
        },
        $set: {
          expiresAt: null,
          turnPreparation: {
            status: "preparing",
            attemptToken,
            startedAt: new Date(),
            completedAt: null,
            error: null,
          },
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: false }
    )
      .select("+turnPreparation turnDisposition")
      .lean<Owner | null>();
  } catch (error) {
    if (!isMongoDuplicateKeyError(error)) throw error;
  }
  if (claimed?.turnPreparation?.attemptToken === attemptToken)
    return { status: "claimed", ...scope, attemptToken };
  const existing = await AiriTurnContext.findOne(scope)
    .select("+turnPreparation turnDisposition")
    .lean<Owner | null>();
  if (
    ["terminal", "superseded", "completed"].includes(
      existing?.turnDisposition?.status || ""
    )
  )
    return { status: "terminal" };
  if (existing?.turnDisposition?.status === "outcome_unknown")
    return { status: "outcome_unknown" };
  const checkpoint = readCheckpoint(existing, scope.messageId);
  if (checkpoint) return { status: "prepared", result: checkpoint };
  if (existing?.turnPreparation?.status === "terminal")
    return { status: "terminal" };
  if (!existing)
    throw new Error("Airi turn preparation owner could not be read");
  return { status: "outcome_unknown" };
}

export async function completeAiriTurnPreparation(
  claim: AiriTurnPreparationClaim,
  result: AiriConversationTurnProcessResult
): Promise<void> {
  const outcomeFailed =
    result.outcome.executionStatus === "failed" ||
    (result.outcome.responseStatus !== null &&
      result.outcome.responseStatus >= 400);
  const update = await AiriTurnContext.updateOne(ownerFilter(claim), {
    $set: {
      "turnPreparation.status": outcomeFailed ? "terminal" : "prepared",
      "turnPreparation.result": JSON.parse(JSON.stringify(result)),
      "turnPreparation.completedAt": new Date(),
    },
  });
  if (update.matchedCount !== 1)
    throw new Error(
      "Airi turn preparation ownership changed before checkpoint persistence"
    );
}

export async function failAiriTurnPreparation(
  claim: AiriTurnPreparationClaim,
  error: string,
  safeToRetry: boolean
): Promise<void> {
  const update = await AiriTurnContext.updateOne(ownerFilter(claim), {
    $set: {
      "turnPreparation.status": safeToRetry ? "retryable" : "outcome_unknown",
      "turnPreparation.error": error,
      "turnPreparation.completedAt": new Date(),
      expiresAt: null,
    },
  });
  if (update.matchedCount !== 1)
    throw new Error(
      "Airi turn preparation ownership changed before failure persistence"
    );
}

export async function recordAiriConversationTurnDisposition(
  receipt: AiriConversationTurnDisposition
): Promise<void> {
  await connectDB();
  const scope = identity(receipt.turn);
  // Await compensation before the workflow can prepare its queued next turn.
  // A failed write must retry this activity, not leave a final receipt behind.
  await releaseCancelledInitialAdmission(receipt, scope);
  const terminal = ["terminal", "completed", "superseded"].includes(
    receipt.status
  );
  const safeReceipt: AiriConversationTurnDisposition = {
    turn: toAiriConversationTurnReference(receipt.turn),
    status: receipt.status,
    stage: receipt.stage,
    attempt: receipt.attempt,
    updatedAt: receipt.updatedAt,
    error: receipt.error,
    nextAttemptAt: receipt.nextAttemptAt,
    ...(receipt.supersededByMessageId
      ? { supersededByMessageId: receipt.supersededByMessageId }
      : {}),
  };
  try {
    await AiriTurnContext.updateOne(
      {
        ...scope,
        $or: [
          { turnDisposition: { $exists: false } },
          { "turnDisposition.updatedAt": { $lte: receipt.updatedAt } },
        ],
      },
      {
        $setOnInsert: {
          ...scope,
          channel: receipt.turn.channel || null,
          sourceId: receipt.turn.sourceId || null,
        },
        $set: {
          turnDisposition: safeReceipt,
          expiresAt: terminal
            ? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
            : null,
        },
      },
      { upsert: true, setDefaultsOnInsert: false }
    );
  } catch (error) {
    if (!isMongoDuplicateKeyError(error)) throw error;
    // A delayed activity completion must not overwrite a more recent receipt.
    if (!(await AiriTurnContext.findOne(scope).lean())) throw error;
  }
  if (terminal && receipt.turn.messageId.startsWith("customer-behavior:")) {
    const runId = receipt.turn.messageId.slice("customer-behavior:".length);
    if (/^[a-f0-9]{24}$/.test(runId)) {
      const { default: ScenarioBehaviorRun } = await import(
        "@/models/scenario-behavior-run"
      );
      await ScenarioBehaviorRun.updateOne(
        {
          _id: runId,
          workspaceId: receipt.turn.workspaceId,
          conversationId: receipt.turn.conversationId,
          status: "signaled",
        },
        { $set: { status: "skipped", reason: `turn_${receipt.status}` } }
      );
    }
  }
}

async function releaseCancelledInitialAdmission(
  receipt: AiriConversationTurnDisposition,
  scope: ReturnType<typeof identity>
): Promise<void> {
  if (
    receipt.stage !== "delivery" ||
    (receipt.status !== "terminal" && receipt.status !== "superseded")
  )
    return;
  const owner = await AiriTurnContext.findOne(scope)
    .select("+turnPreparation turnDisposition")
    .lean<Owner | null>();
  if (
    owner?.turnDisposition?.status === "completed" ||
    owner?.turnDisposition?.status === "outcome_unknown" ||
    (owner?.turnDisposition?.updatedAt &&
      owner.turnDisposition.updatedAt > receipt.updatedAt)
  )
    return;
  const delivery = readCheckpoint(owner, scope.messageId)?.pendingDelivery;
  if (
    !delivery ||
    readAiriDeliveryConversationId(delivery) !== scope.conversationId ||
    readAiriDeliveryWorkspaceId(delivery) !== scope.workspaceId ||
    delivery.context.sourceMessageId !== scope.messageId
  )
    return;
  const origin = asRecord(delivery.context.scenarioOrigin);
  const effects = (delivery.postDeliveryEffects || []).filter(
    effect => effect.kind === "complete_scenario_after_dispatch"
  );
  if (effects.length !== 1) return;
  const payload = effects[0].payload;
  const runtime = asRecord(payload.scenarioRuntime);
  if (
    payload.conversationId !== scope.conversationId ||
    payload.lastMessageId !== delivery.reservedMessageId ||
    !origin.scenarioId ||
    !origin.actionNodeId ||
    runtime.scenarioId !== origin.scenarioId ||
    runtime.selectedActionNodeId !== origin.actionNodeId
  )
    return;

  // Service messages can select strict dispatch at the transport edge without
  // an explicit checkpoint policy. The exact durable owner below proves that
  // no provider attempt happened; an optional request hint cannot prove it.
  const { default: Message, buildTemporalDeliveryKeyFilter } = await import(
    "@/models/message"
  );
  const deliveryFilter = {
    _id: delivery.reservedMessageId,
    ...buildTemporalDeliveryKeyFilter(delivery.deliveryKey),
    "temporalDispatch.version": 1,
    "temporalDispatch.deliveryKey": delivery.deliveryKey,
  };
  let dispatchOwner = await Message.findOne(deliveryFilter)
    .select("+temporalDispatch")
    .lean<DispatchOwner | null>();
  const dispatch = dispatchOwner?.temporalDispatch;
  if (!dispatch?.attemptToken || dispatchOwner?.messageId || dispatch.claimedAt)
    return;
  if (receipt.status === "superseded" && dispatch.state === "reserved") {
    // Compete with the same CAS used immediately before provider POST. Once
    // dispatching wins, admission cannot be refunded even if its result is lost.
    dispatchOwner = await Message.findOneAndUpdate(
      {
        ...deliveryFilter,
        "temporalDispatch.state": "reserved",
        "temporalDispatch.attemptToken": dispatch.attemptToken,
      },
      {
        $set: {
          "temporalDispatch.state": "not_attempted",
          "temporalDispatch.terminalCode": "superseded",
          "temporalDispatch.finishedAt": new Date(),
        },
      },
      { new: true }
    )
      .select("+temporalDispatch")
      .lean<DispatchOwner | null>();
  }
  const cancelled = dispatchOwner?.temporalDispatch;
  if (
    cancelled?.state !== "not_attempted" ||
    (cancelled.terminalCode !== "newer_inbound" &&
      !(
        receipt.status === "superseded" &&
        cancelled.terminalCode === "superseded"
      ))
  )
    return;

  const { releaseUnsentInitialScenarioAdmission } = await import(
    "@/lib/airi/reply/runtime/auto-reply-scenario-state"
  );
  await releaseUnsentInitialScenarioAdmission({
    workspaceId: scope.workspaceId,
    conversationId: scope.conversationId,
    sourceMessageId: scope.messageId,
    scenarioRuntime: runtime as unknown as AiriScenarioRuntimeConfig,
    baseState: payload.baseState,
    capturedConversation: asRecord(delivery.context.conversation),
  });
}
