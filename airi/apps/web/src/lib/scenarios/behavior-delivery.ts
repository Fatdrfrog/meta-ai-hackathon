import ScenarioBehaviorRun from "@/models/scenario-behavior-run";
import {
  behaviorRunBlockReason,
  terminalizeBehaviorRun,
  type BehaviorRun,
} from "./behavior-runs";
import { reserveCustomerMarketingContact } from "@/lib/campaign/customer-contact-policy";

export async function findOutboundBehaviorRun(input: {
  workspaceId: string;
  conversationId: string;
  scenarioId?: string;
  sourceMessageId?: string;
  behaviorRunId?: string;
}): Promise<BehaviorRun | null> {
  const message = input.sourceMessageId || "";
  if (
    message.startsWith("customer-behavior:") ||
    (message.startsWith("scenario-timeout:") && input.behaviorRunId)
  ) {
    const id = message.startsWith("customer-behavior:")
      ? message.slice("customer-behavior:".length)
      : input.behaviorRunId!;
    if (!/^[a-f0-9]{24}$/.test(id))
      throw new Error("Invalid behavior delivery identity");
    const run = await ScenarioBehaviorRun.findOne({
      _id: id,
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      scenarioId: input.scenarioId,
    }).lean<BehaviorRun>();
    if (!run) throw new Error("Behavior delivery authority missing");
    return run;
  }
  return null;
}

export async function guardBehaviorDelivery(
  run: BehaviorRun,
  phone: string,
  deliveryKey: string
): Promise<string | null> {
  const reason = await behaviorRunBlockReason(run);
  if (reason) {
    await terminalizeBehaviorRun(run, reason);
    return reason;
  }
  const contactReason = await reserveCustomerMarketingContact({
    workspaceId: run.workspaceId,
    phone,
    deliveryKey,
    conversationId: String(run.conversationId),
    requireConsent: true,
  });
  if (contactReason) {
    await terminalizeBehaviorRun(run, contactReason);
    return contactReason;
  }
  // Final sales check after reserving contact capacity closes queue/preparation gaps.
  const finalReason = await behaviorRunBlockReason(run);
  if (finalReason) {
    await terminalizeBehaviorRun(run, finalReason);
    return finalReason;
  }
  return null;
}

export async function markBehaviorContactAttempted(run: BehaviorRun) {
  const result = await ScenarioBehaviorRun.updateOne(
    { _id: run._id, status: { $in: ["signaled", "contacted"] } },
    { $set: { status: "contacted" } }
  );
  if (result.matchedCount !== 1)
    throw new Error("Customer journey was cancelled before dispatch");
}
