import {
  behaviorDueAt,
  behaviorPresetEventType,
  isScenarioBehaviorConfig,
  matchesPurchaseSegment,
  type CustomerBehaviorEventType,
  type ScenarioBehaviorConfig,
  type ScenarioNodeData,
} from "@icecore/scenario-contracts";
import { Scenario } from "@/models/scenario";
import CustomerEvent from "@/models/customer-event";
import ScenarioBehaviorRun from "@/models/scenario-behavior-run";
import { Conversation } from "@/models/conversation";
import { loadCustomerPurchaseFacts } from "@/lib/customers/purchase-facts";
import { isMongoDuplicateKeyError } from "@/lib/mongo-errors";
import { Types } from "mongoose";

export type BehaviorRun = {
  _id: Types.ObjectId;
  workspaceId: string;
  customerId: Types.ObjectId;
  conversationId: Types.ObjectId;
  sourceId: string;
  scenarioId: Types.ObjectId;
  triggerNodeId: string;
  scenarioUpdatedAt: Date;
  eventId: Types.ObjectId;
  eventType: CustomerBehaviorEventType;
  referenceId: string;
  occurredAt: Date;
  dueAt: Date;
  expiresAt: Date;
  config: ScenarioBehaviorConfig;
  status: string;
  reason?: string;
  attempts: number;
};
type EventRow = {
  _id: Types.ObjectId;
  workspaceId: string;
  customerId: Types.ObjectId;
  conversationId: Types.ObjectId;
  occurredAt: Date;
  type: string;
  behaviorAdmissionCursor?: string;
  payload: {
    conversionId?: string;
    conversionType?: string;
    conversionValue?: number;
    currency?: string;
    behavior?: {
      sourceId: string;
      eventType: CustomerBehaviorEventType;
      referenceId: string;
      dueAt?: string;
    };
  };
};
type ScenarioRow = {
  _id: Types.ObjectId;
  updatedAt: Date;
  createdAt: Date;
  nodes: { id: string; data: ScenarioNodeData }[];
};
const ACTIVE_RUNS = ["pending", "signaled", "contacted"];

export async function terminalizeBehaviorRun(run: BehaviorRun, reason: string) {
  await ScenarioBehaviorRun.updateOne(
    {
      _id: run._id,
      workspaceId: run.workspaceId,
      status: { $in: ACTIVE_RUNS },
    },
    {
      $set: {
        status:
          reason === "converted" || reason === "event_superseded"
            ? "cancelled"
            : "skipped",
        reason,
      },
    }
  );
}

export async function admitCustomerBehaviorEvents(input: {
  limit: number;
  deadlineAtMs: number;
}) {
  const events = await CustomerEvent.find({
    behaviorAdmissionStatus: "pending",
    behaviorAdmissionNextAt: { $lte: new Date() },
  })
    .sort({ behaviorAdmissionNextAt: 1, _id: 1 })
    .limit(input.limit)
    .lean<EventRow[]>();
  let failures = 0;
  for (const event of events) {
    if (Date.now() >= input.deadlineAtMs) break;
    try {
      const claim = await CustomerEvent.updateOne(
        {
          _id: event._id,
          behaviorAdmissionStatus: "pending",
          behaviorAdmissionNextAt: { $lte: new Date() },
        },
        { $set: { behaviorAdmissionNextAt: new Date(Date.now() + 60_000) } }
      );
      if (claim.modifiedCount !== 1) continue;
      const behavior = event.payload.behavior;
      const isPurchase =
        event.type === "conversion_recorded" &&
        event.payload.conversionType === "sale" &&
        Number.isFinite(event.payload.conversionValue) &&
        Number(event.payload.conversionValue) > 0 &&
        /^[A-Z]{3}$/.test(event.payload.currency || "");
      const eventType = isPurchase ? "purchase_completed" : behavior?.eventType;
      if (isPurchase) {
        await ScenarioBehaviorRun.updateMany(
          {
            workspaceId: event.workspaceId,
            customerId: event.customerId,
            eventId: { $ne: event._id },
            occurredAt: { $lte: event.occurredAt },
            status: { $in: ACTIVE_RUNS },
          },
          { $set: { status: "cancelled", reason: "converted" } }
        );
      }
      const conversation = eventType
        ? await Conversation.findOne({
            _id: event.conversationId,
            workspaceId: event.workspaceId,
            customerId: event.customerId,
            channel: "whatsapp",
            ...(behavior ? { sourceId: behavior.sourceId } : {}),
          })
            .select("sourceId")
            .lean<{ sourceId?: string }>()
        : null;
      const scenarios = conversation?.sourceId
        ? await Scenario.find({
            workspaceId: event.workspaceId,
            status: "active",
            mode: "conversation",
            deletedAt: null,
            "nodes.data.triggerConfig.entryPointType": "customer_behavior",
            createdAt: { $lte: event.occurredAt },
            ...(event.behaviorAdmissionCursor
              ? {
                  _id: {
                    $gt: new Types.ObjectId(event.behaviorAdmissionCursor),
                  },
                }
              : {}),
          })
            .sort({ _id: 1 })
            .limit(51)
            .select("nodes updatedAt createdAt")
            .lean<ScenarioRow[]>()
        : [];
      let processed = 0;
      for (const scenario of scenarios.slice(0, 50)) {
        if (Date.now() >= input.deadlineAtMs) break;
        for (const node of scenario.nodes) {
          const trigger = node.data.triggerConfig;
          if (
            node.data.kind !== "trigger" ||
            trigger?.entryPointType !== "customer_behavior" ||
            trigger.enabled === false ||
            !isScenarioBehaviorConfig(trigger.behavior) ||
            behaviorPresetEventType(trigger.behavior.preset) !== eventType
          )
            continue;
          const dueAt = behaviorDueAt(
            trigger.behavior,
            event.occurredAt.toISOString(),
            behavior?.dueAt
          );
          if (!dueAt) continue;
          try {
            await ScenarioBehaviorRun.updateOne(
              {
                workspaceId: event.workspaceId,
                customerId: event.customerId,
                scenarioId: scenario._id,
                triggerNodeId: node.id,
                eventId: event._id,
              },
              {
                $setOnInsert: {
                  conversationId: event.conversationId,
                  sourceId: conversation!.sourceId,
                  scenarioUpdatedAt: scenario.updatedAt,
                  eventType,
                  referenceId:
                    behavior?.referenceId || event.payload.conversionId,
                  occurredAt: event.occurredAt,
                  dueAt,
                  nextAttemptAt: dueAt,
                  expiresAt: new Date(dueAt.getTime() + 7 * 86_400_000),
                  config: trigger.behavior,
                  status: "pending",
                  attempts: 0,
                },
              },
              { upsert: true }
            );
          } catch (error) {
            if (!isMongoDuplicateKeyError(error)) throw error;
          }
        }
        processed++;
      }
      // Bounded fanout resumes from a stable scenario ID, never a whole-tenant scan.
      await CustomerEvent.updateOne(
        {
          _id: event._id,
          behaviorAdmissionCursor: event.behaviorAdmissionCursor ?? {
            $exists: false,
          },
        },
        scenarios.length > processed
          ? {
              $set: {
                ...(processed
                  ? {
                      behaviorAdmissionCursor: String(
                        scenarios[processed - 1]!._id
                      ),
                    }
                  : {}),
                behaviorAdmissionNextAt: new Date(),
              },
            }
          : { $set: { behaviorAdmissionStatus: "completed" } }
      );
    } catch {
      failures++;
    }
  }
  if (failures)
    throw new Error(`Customer journey admission will retry ${failures} events`);
}

/** Repeated before entry and provider dispatch. SQL facts close projection delays. */
export async function behaviorRunBlockReason(
  run: BehaviorRun,
  now = new Date()
): Promise<string | null> {
  if (!ACTIVE_RUNS.includes(run.status))
    return run.reason || "journey_terminal";
  if (now < run.dueAt) return "journey_not_due";
  if (run.status !== "contacted" && now > run.expiresAt)
    return "journey_expired";
  const scenario = await Scenario.findOne({
    _id: run.scenarioId,
    workspaceId: run.workspaceId,
    status: "active",
    deletedAt: null,
  })
    .select("nodes updatedAt")
    .lean<ScenarioRow>();
  const trigger = scenario?.nodes.find(node => node.id === run.triggerNodeId)
    ?.data.triggerConfig;
  if (
    !scenario ||
    new Date(scenario.updatedAt).getTime() !==
      new Date(run.scenarioUpdatedAt).getTime() ||
    trigger?.entryPointType !== "customer_behavior" ||
    trigger.enabled === false
  )
    return "scenario_changed";
  const conversation = await Conversation.findOne({
    _id: run.conversationId,
    workspaceId: run.workspaceId,
    customerId: run.customerId,
    sourceId: run.sourceId,
    channel: "whatsapp",
  })
    .select("airi_handoff_active")
    .lean<{ airi_handoff_active?: boolean }>();
  if (!conversation) return "source_or_customer_changed";
  if (conversation.airi_handoff_active) return "manual_handoff_active";
  if (run.referenceId.startsWith("website-cart:")) {
    const { websiteCartBlockReason } = await import("@/lib/commerce/cart-journeys");
    const cartReason = await websiteCartBlockReason(run);
    if (cartReason) return cartReason;
  }
  const event = await CustomerEvent.findOne({
    _id: run.eventId,
    workspaceId: run.workspaceId,
  }).lean<EventRow>();
  if (!event) return "event_unavailable";
  if (run.eventType !== "purchase_completed") {
    const latest = await CustomerEvent.findOne({
      workspaceId: run.workspaceId,
      customerId: run.customerId,
      "payload.behavior.sourceId": run.sourceId,
      "payload.behavior.referenceId": run.referenceId,
      "payload.behavior.eventType": {
        $in: run.eventType.startsWith("checkout") || run.eventType === "cart_updated"
          ? ["cart_updated", "checkout_started", "checkout_closed"]
          : run.eventType.startsWith("renewal")
            ? ["renewal_scheduled", "renewal_completed"]
            : ["service_scheduled", "service_completed"],
      },
    })
      .sort({ occurredAt: -1, _id: -1 })
      .select("_id")
      .lean<{ _id: unknown }>();
    if (String(latest?._id) !== String(run.eventId)) return "event_superseded";
  }
  const facts = await loadCustomerPurchaseFacts({
    workspaceId: run.workspaceId,
    customerId: String(run.customerId),
    after: run.occurredAt,
    excludeConversionId: event.payload.conversionId,
  });
  if (facts.convertedSince) return "converted";
  if (run.eventType === "purchase_completed" && facts.purchaseCount === 0)
    return "purchase_unavailable";
  if (run.config.preset === "second_purchase" && facts.purchaseCount !== 1)
    return "not_first_purchase";
  if (!matchesPurchaseSegment(run.config.purchaseSegment || {}, facts, now))
    return "purchase_segment_changed";
  return null;
}
