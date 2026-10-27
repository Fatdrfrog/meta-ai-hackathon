import type { AiriAutoReplyParams } from "@icecore/airi-runtime/auto-reply";
import type { AiriConversationTurnSignal } from "@icecore/temporal";
import connectDB from "@/lib/mongoose";
import { Conversation } from "@/models/conversation";
import ScenarioBehaviorRun from "@/models/scenario-behavior-run";
import type { ConversationDocument } from "@/types/models";
import {
  behaviorRunBlockReason,
  terminalizeBehaviorRun,
  type BehaviorRun,
} from "./behavior-runs";

export const BEHAVIOR_TURN_PREFIX = "customer-behavior:";

/** Resolve the existing session's exact episode before preparing more outreach. */
export async function revalidateBehaviorScenarioSession(
  conversation: ConversationDocument
): Promise<string | null> {
  const state = conversation.airi_scenario_state;
  if (!state?.behaviorRunId || !state.lockedScenarioId) return null;
  const run = await ScenarioBehaviorRun.findOne({
    _id: state.behaviorRunId,
    workspaceId: conversation.workspaceId,
    conversationId: conversation._id,
    scenarioId: state.lockedScenarioId,
  }).lean<BehaviorRun>();
  if (!run) return "journey_unavailable";
  const reason = await behaviorRunBlockReason(run);
  if (!reason) return null;
  await terminalizeBehaviorRun(run, reason);
  const { completeLockedScenarioAndPersist } = await import(
    "@/lib/airi/reply/runtime/auto-reply-scenario-state"
  );
  const completed = await completeLockedScenarioAndPersist({
    conversationId: String(conversation._id),
    baseState: state,
    scenarioId: state.lockedScenarioId,
    scenarioName: state.lockedScenarioName || "Scenario",
    expectedBehaviorRunId: state.behaviorRunId,
  });
  if (completed.persisted) conversation.airi_scenario_state = completed.state;
  return reason;
}

export async function dispatchDueBehaviorRuns(input: {
  limit: number;
  deadlineAtMs: number;
}) {
  const runs = await ScenarioBehaviorRun.find({
    status: { $in: ["pending", "signaled"] },
    nextAttemptAt: { $lte: new Date() },
  })
    .sort({ nextAttemptAt: 1, _id: 1 })
    .limit(input.limit)
    .lean<BehaviorRun[]>();
  let failures = 0;
  for (const run of runs) {
    if (Date.now() >= input.deadlineAtMs) break;
    try {
      // Persist dispatch intent before signaling. Acceptance retries use exactly the
      // same message identity and the existing durable turn preparation fence.
      const claimed = await ScenarioBehaviorRun.updateOne(
        {
          _id: run._id,
          status: { $in: ["pending", "signaled"] },
          nextAttemptAt: { $lte: new Date() },
        },
        {
          $set: {
            status: "signaled",
            nextAttemptAt: new Date(Date.now() + 15 * 60_000),
          },
          $inc: { attempts: 1 },
        }
      );
      if (claimed.modifiedCount !== 1) continue;
      const reason = await behaviorRunBlockReason(run);
      if (reason) {
        await terminalizeBehaviorRun(run, reason);
        continue;
      }
      const { signalAiriConversationTurn } = await import(
        "@/lib/temporal/client"
      );
      await signalAiriConversationTurn({
        workspaceId: run.workspaceId,
        conversationId: String(run.conversationId),
        sourceId: run.sourceId,
        channel: "whatsapp",
        messageId: `${BEHAVIOR_TURN_PREFIX}${run._id}`,
        messageDate: run.dueAt.toISOString(),
        enqueuedAt: run.dueAt.toISOString(),
        scenarioOverrideId: String(run.scenarioId),
        triggerEventKind: "inbound_message",
      });
    } catch {
      failures++;
    }
  }
  if (failures)
    throw new Error(`Customer journey dispatch will retry ${failures} runs`);
}

/** Synthetic event hydration is server-owned; supplied payloads cannot select a journey. */
export async function hydrateCustomerBehaviorTurn(
  turn: AiriConversationTurnSignal
): Promise<AiriAutoReplyParams> {
  await connectDB();
  const id = turn.messageId.slice(BEHAVIOR_TURN_PREFIX.length);
  if (!/^[a-f0-9]{24}$/.test(id))
    throw new Error("Invalid customer behavior identity");
  const run = await ScenarioBehaviorRun.findOne({
    _id: id,
    workspaceId: turn.workspaceId,
    conversationId: turn.conversationId,
    sourceId: turn.sourceId,
  }).lean<BehaviorRun>();
  if (!run) throw new Error("Customer behavior run unavailable");
  const reason = await behaviorRunBlockReason(run);
  const conversation = await Conversation.findOne({
    _id: run.conversationId,
    workspaceId: run.workspaceId,
    sourceId: run.sourceId,
  })
    .select("-messages -embedding")
    .lean<ConversationDocument>();
  if (!conversation)
    throw new Error("Customer behavior conversation unavailable");
  await revalidateBehaviorScenarioSession(conversation);
  const locked = conversation.airi_scenario_state?.lockedScenarioId;
  const blocked = reason || (locked ? "another_scenario_active" : null);
  if (blocked) await terminalizeBehaviorRun(run, blocked);
  const { resolveChatDocument, buildChannelSpecificParams } = await import(
    "@/lib/airi/scenario/scenario-channel-utils"
  );
  const { chatDocument, chatId, chatType } =
    await resolveChatDocument(conversation);
  const channel = await buildChannelSpecificParams({
    workspaceId: run.workspaceId,
    conversation,
    chatDocument,
    channelOverride: "whatsapp",
    sourceBindingNotAfter: run.occurredAt.toISOString(),
  });
  if (!channel.ok) {
    await terminalizeBehaviorRun(run, "source_or_customer_changed");
    throw new Error("Customer behavior source unavailable");
  }
  return {
    type: "whatsapp",
    workspaceId: run.workspaceId,
    conversation,
    chatDocument,
    chatId,
    chatType,
    whatsAppInfo: channel.whatsAppInfo,
    newMessage: {
      _id: turn.messageId,
      text: "",
      date: run.dueAt,
      direction: "inbound",
      channel: "whatsapp",
      conversation: conversation._id,
      workspaceId: run.workspaceId,
    } as unknown as AiriAutoReplyParams["newMessage"],
    scenarioOverrideId: String(run.scenarioId),
    scenarioTriggerNodeId: run.triggerNodeId,
    skipTriggerMatch: true,
    proactiveTrigger: true,
    suppressGeneralAutoReply: true,
    runtimeHydrated: true,
    behaviorScenarioUpdatedAt: run.scenarioUpdatedAt.toISOString(),
    behaviorBlockedReason: blocked || undefined,
  };
}
