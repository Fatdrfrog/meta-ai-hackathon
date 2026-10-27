import connectDB from "@/lib/mongoose";
import { ScenarioFlowEvent } from "@/models/scenario-flow-event";
import { normalizeWhatsAppMessageId } from "@icecore/shared/lib/whatsapp/message-id";

type ScenarioFlowEventDoc = {
  workspaceId: string;
  sourceId?: string | null;
  conversationId: string;
  customerWaId?: string | null;
  evaluationId?: string | null;
  scenarioId?: string | null;
  scenarioName?: string | null;
  actionNodeId?: string | null;
  flowId: string;
  flowToken?: string | null;
  outboundMessageId?: string | null;
};

function normalizeMessageId(
  messageId: string | null | undefined
): string | null {
  const trimmed = typeof messageId === "string" ? messageId.trim() : "";
  if (!trimmed) return null;
  return normalizeWhatsAppMessageId(trimmed);
}

export async function trackScenarioFlowSent(params: {
  workspaceId: string;
  sourceId?: string | null;
  conversationId: string;
  customerWaId?: string | null;
  evaluationId?: string | null;
  scenarioId?: string | null;
  scenarioName?: string | null;
  actionNodeId?: string | null;
  flowId: string;
  flowToken?: string | null;
  outboundMessageId?: string | null;
  eventAt?: Date;
}) {
  const flowId = params.flowId.trim();
  if (!flowId) return;

  await connectDB();

  const outboundMessageId = normalizeMessageId(params.outboundMessageId);
  const doc = {
    workspaceId: params.workspaceId,
    sourceId: params.sourceId || null,
    conversationId: params.conversationId,
    customerWaId: params.customerWaId || null,
    evaluationId: params.evaluationId || null,
    scenarioId: params.scenarioId || null,
    scenarioName: params.scenarioName || null,
    actionNodeId: params.actionNodeId || null,
    flowId,
    flowToken: params.flowToken?.trim() || null,
    outboundMessageId,
    eventType: "sent" as const,
    eventAt: params.eventAt || new Date(),
  };

  await ScenarioFlowEvent.updateOne(
    {
      workspaceId: doc.workspaceId,
      outboundMessageId: doc.outboundMessageId,
      eventType: "sent",
    },
    { $setOnInsert: doc },
    { upsert: true }
  );
}

export async function trackScenarioFlowReadByMessageId(params: {
  workspaceId?: string | null;
  outboundMessageId?: string | null;
  eventAt?: Date;
}) {
  const outboundMessageId = normalizeMessageId(params.outboundMessageId);
  if (!outboundMessageId) return;

  await connectDB();

  const sentEvent = (await ScenarioFlowEvent.findOne({
    ...(params.workspaceId ? { workspaceId: params.workspaceId } : {}),
    outboundMessageId,
    eventType: "sent",
  })
    .lean()
    .exec()) as ScenarioFlowEventDoc | null;

  if (!sentEvent) return;

  await ScenarioFlowEvent.updateOne(
    {
      workspaceId: sentEvent.workspaceId,
      outboundMessageId,
      eventType: "read",
    },
    {
      $setOnInsert: {
        workspaceId: sentEvent.workspaceId,
        sourceId: sentEvent.sourceId || null,
        conversationId: sentEvent.conversationId,
        customerWaId: sentEvent.customerWaId || null,
        evaluationId: sentEvent.evaluationId || null,
        scenarioId: sentEvent.scenarioId || null,
        scenarioName: sentEvent.scenarioName || null,
        actionNodeId: sentEvent.actionNodeId || null,
        flowId: sentEvent.flowId,
        flowToken: sentEvent.flowToken || null,
        outboundMessageId,
        eventType: "read",
        eventAt: params.eventAt || new Date(),
      },
    },
    { upsert: true }
  );
}

export async function trackScenarioFlowSubmitted(params: {
  workspaceId: string;
  sourceId?: string | null;
  conversationId: string;
  customerWaId?: string | null;
  flowToken?: string | null;
  /** Provider reply context binds a submission to the actual send when tokens are reused. */
  outboundMessageId?: string | null;
  /** `nfm_reply.name` from Meta; used when no prior `sent` row matches the token. */
  flowIdHint?: string | null;
  responseJson?: string | null;
  eventAt?: Date;
}) {
  const flowToken = params.flowToken?.trim() || "";
  const boundMessageId = normalizeMessageId(params.outboundMessageId);
  if (!flowToken && !boundMessageId) return;
  const eventAt = params.eventAt || new Date();

  await connectDB();

  const sentEvent = (await ScenarioFlowEvent.findOne({
    workspaceId: params.workspaceId,
    conversationId: params.conversationId,
    ...(boundMessageId ? { outboundMessageId: boundMessageId } : { flowToken }),
    eventType: "sent",
    ...(!boundMessageId ? { eventAt: { $lte: eventAt } } : {}),
  })
    .sort({ eventAt: -1, _id: -1 })
    .lean()
    .exec()) as ScenarioFlowEventDoc | null;

  const flowIdForSubmit = sentEvent?.flowId?.trim()
    ? sentEvent.flowId.trim()
    : (params.flowIdHint || "").trim() || "whatsapp_flow";
  const outboundMessageId =
    boundMessageId || sentEvent?.outboundMessageId || null;

  await ScenarioFlowEvent.updateOne(
    {
      workspaceId: params.workspaceId,
      conversationId: params.conversationId,
      ...(outboundMessageId
        ? { outboundMessageId }
        : { flowId: flowIdForSubmit, flowToken, outboundMessageId: null }),
      eventType: "submitted",
    },
    {
      $setOnInsert: {
        workspaceId: params.workspaceId,
        sourceId: params.sourceId || sentEvent?.sourceId || null,
        conversationId: params.conversationId,
        customerWaId: params.customerWaId || sentEvent?.customerWaId || null,
        evaluationId: sentEvent?.evaluationId || null,
        scenarioId: sentEvent?.scenarioId || null,
        scenarioName: sentEvent?.scenarioName || null,
        actionNodeId: sentEvent?.actionNodeId || null,
        flowId: flowIdForSubmit,
        flowToken: flowToken || sentEvent?.flowToken || null,
        outboundMessageId,
        eventType: "submitted",
        eventAt,
        responseJson: params.responseJson || null,
      },
    },
    { upsert: true }
  );
}
