import { normalizeStageForPersistence } from "@/lib/crm/stages";
import type { mongo } from "mongoose";

export type CustomerStageActor = {
  type: "system" | "manager" | "ai" | "backfill";
  userId?: string | null;
  label?: string | null;
};
export type CustomerStageEnvelope = {
  contractVersion: 1;
  eventId: string;
  revision: number;
  occurredAt: Date;
  workspaceId: string;
  customerId: string;
  conversationId: string | null;
  previousStage: string | null;
  stage: string | null;
  actor: CustomerStageActor;
  source: string;
};
export type CustomerStageSnapshot = {
  _id?: unknown;
  workspaceId?: string;
  primaryConversationId?: unknown;
  currentFunnelStage?: string | null;
  crm_stage_revision?: number;
};
export type CustomerStageWriteContext = {
  actor?: CustomerStageActor;
  source?: string;
};
export type CustomerStageQueryOptions = mongo.UpdateOptions & {
  customerStageContext: CustomerStageWriteContext;
};
export function customerStageQueryOptions(
  context: CustomerStageWriteContext
): CustomerStageQueryOptions {
  return { customerStageContext: context };
}
export class CustomerStageWriteConflictError extends Error {
  constructor() {
    super("Customer stage changed concurrently; retry the write");
    this.name = "CustomerStageWriteConflictError";
  }
}

export function buildCustomerStageTransition({
  before,
  after,
  eventId,
  now,
  context,
}: {
  before: CustomerStageSnapshot | null;
  after: CustomerStageSnapshot;
  eventId: string;
  now: Date;
  context?: CustomerStageWriteContext;
}) {
  const previousStage = normalizeStageForPersistence(
    before?.currentFunnelStage
  );
  const stage = normalizeStageForPersistence(after.currentFunnelStage);
  if (previousStage === stage || !after.workspaceId || !after._id) return null;
  const envelope: CustomerStageEnvelope = {
    contractVersion: 1,
    eventId,
    revision: (before?.crm_stage_revision ?? 0) + 1,
    occurredAt: now,
    workspaceId: after.workspaceId,
    customerId: String(after._id),
    conversationId: after.primaryConversationId
      ? String(after.primaryConversationId)
      : null,
    previousStage,
    stage,
    actor: context?.actor ?? { type: "system", userId: null, label: null },
    source: context?.source ?? "customer_write",
  };
  return {
    crm_stage_revision: envelope.revision,
    crm_stage_event: envelope,
    crm_stage_event_key: `${envelope.workspaceId}:${eventId}`,
  };
}

export function decodeCustomerStageEnvelope(
  value: unknown
): CustomerStageEnvelope | null {
  if (value == null) return null;
  let row: Partial<CustomerStageEnvelope>;
  try {
    row = (
      typeof value === "string" ? JSON.parse(value) : value
    ) as Partial<CustomerStageEnvelope>;
  } catch {
    throw new Error("Invalid customer stage envelope");
  }
  if (
    !row ||
    row.contractVersion !== 1 ||
    typeof row.eventId !== "string" ||
    typeof row.workspaceId !== "string" ||
    typeof row.customerId !== "string" ||
    !Number.isInteger(row.revision) ||
    (row.revision ?? 0) < 1 ||
    !(row.stage === null || typeof row.stage === "string") ||
    !(row.previousStage === null || typeof row.previousStage === "string") ||
    typeof row.source !== "string" ||
    !row.actor ||
    !["manager", "system", "ai", "backfill"].includes(row.actor.type)
  )
    throw new Error("Invalid customer stage envelope");
  const occurredAt = new Date(row.occurredAt as Date);
  if (!Number.isFinite(occurredAt.getTime()))
    throw new Error("Invalid customer stage envelope");
  return { ...row, occurredAt } as CustomerStageEnvelope;
}
