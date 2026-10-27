import { readDate as date } from "@icecore/shared/lib/value-utils";

export const SERVICE_RESOLUTION_KINDS = [
  "manager",
  "customer_csat",
  "timeout",
  "unknown",
] as const;
export type ServiceResolutionKind = (typeof SERVICE_RESOLUTION_KINDS)[number];
export { customerCsatResolutionFields } from "@icecore/shared/lib/conversation-service-resolution";
export class ConversationLifecycleWriteConflictError extends Error {
  constructor() {
    super("Conversation lifecycle changed concurrently; retry the transition");
    this.name = "ConversationLifecycleWriteConflictError";
  }
}
// By name too: the worker can load web modules through more than one loader.
export function isConversationLifecycleWriteConflict(error: unknown) {
  return (
    error instanceof ConversationLifecycleWriteConflictError ||
    (error instanceof Error &&
      error.name === "ConversationLifecycleWriteConflictError")
  );
}
/** Re-runs a whole query write; the model hook re-reads and re-fences each attempt. */
export async function retryConversationLifecycleWrite<T>(
  write: () => PromiseLike<T>,
  attempts = 3
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await write();
    } catch (error) {
      if (attempt >= attempts || !isConversationLifecycleWriteConflict(error))
        throw error;
    }
  }
}
export type ServiceLifecycleKind =
  | "opened"
  | "resolved"
  | "reopened"
  | "timeout_closed"
  | "closed_unknown"
  | "status_changed"
  | "handoff_started"
  | "handoff_ended";
export type ServiceLifecycleSnapshot = {
  _id?: unknown;
  workspaceId?: string;
  customerId?: unknown;
  sourceId?: string | null;
  channel?: string | null;
  status?: string | null;
  first_inbound_at?: Date | string | null;
  updatedAt?: Date | string | null;
  airi_handoff_active?: boolean | null;
  airi_handoff_started_at?: Date | string | null;
  csat_timeout_closed?: boolean | null;
  service_episode_started_at?: Date | string | null;
  service_closed_at?: Date | string | null;
  service_resolved_at?: Date | string | null;
  service_resolution_kind?: string | null;
  service_lifecycle_revision?: number | null;
};
export type ServiceLifecycleEnvelope = {
  contractVersion: 1;
  eventId: string;
  revision: number;
  occurredAt: Date;
  workspaceId: string;
  conversationId: string;
  customerId: string | null;
  sourceId: string | null;
  channel: string | null;
  kinds: ServiceLifecycleKind[];
  previousStatus: string | null;
  status: string;
  previousHandoffActive: boolean;
  handoffActive: boolean;
  episodeStartedAt: Date | null;
  closedAt: Date | null;
  resolvedAt: Date | null;
  resolutionKind: ServiceResolutionKind | null;
  handoffStartedAt?: Date | null;
};
export type ServiceLifecycleTransition = {
  service_episode_started_at: Date | null;
  service_closed_at: Date | null;
  service_resolved_at: Date | null;
  service_resolution_kind: ServiceResolutionKind | null;
  service_lifecycle_revision: number;
  service_lifecycle_event: ServiceLifecycleEnvelope;
  service_lifecycle_event_key: string;
  csat_timeout_closed: boolean;
};
function id(value: unknown): string | null {
  return value == null ? null : String(value);
}

/** A scalar source payload retains its full value in updateDescription. */
export function decodeServiceLifecycleEnvelope(
  value: unknown
): ServiceLifecycleEnvelope | null {
  if (value == null) return null;
  const parsed: unknown = typeof value === "string" ? JSON.parse(value) : value;
  if (!parsed || typeof parsed !== "object")
    throw new Error("Invalid lifecycle envelope");
  const row = parsed as ServiceLifecycleEnvelope;
  const occurredAt = date(row.occurredAt);
  if (
    row.contractVersion !== 1 ||
    !row.eventId ||
    !row.workspaceId ||
    !row.conversationId ||
    !Number.isInteger(row.revision) ||
    row.revision < 1 ||
    !Array.isArray(row.kinds) ||
    !row.kinds.length ||
    !occurredAt
  )
    throw new Error("Invalid lifecycle envelope");
  return {
    ...row,
    occurredAt,
    episodeStartedAt: date(row.episodeStartedAt),
    closedAt: date(row.closedAt),
    resolvedAt: date(row.resolvedAt),
    handoffStartedAt: date(row.handoffStartedAt),
  };
}

/** One envelope is written with the source change; change streams retain its exact value. */
export function buildServiceLifecycleTransition({
  before,
  after,
  now,
  eventId,
  resolutionKind,
}: {
  before: ServiceLifecycleSnapshot | null;
  after: ServiceLifecycleSnapshot;
  now: Date;
  eventId: string;
  resolutionKind?: ServiceResolutionKind | null;
}): ServiceLifecycleTransition | null {
  const previousStatus = before?.status ?? null,
    status = after.status ?? "open";
  const previousHandoffActive = before?.airi_handoff_active === true,
    handoffActive = after.airi_handoff_active === true;
  if (
    before &&
    status === previousStatus &&
    handoffActive === previousHandoffActive
  )
    return null;
  const kinds: ServiceLifecycleKind[] = [];
  let episodeStartedAt =
    date(before?.service_episode_started_at) ?? date(after.first_inbound_at);
  let closedAt = date(before?.service_closed_at),
    resolvedAt = date(before?.service_resolved_at);
  let kind = SERVICE_RESOLUTION_KINDS.includes(
    before?.service_resolution_kind as ServiceResolutionKind
  )
    ? (before?.service_resolution_kind as ServiceResolutionKind)
    : null;
  let timeoutClosed = after.csat_timeout_closed === true;
  if (!before && status !== "closed") kinds.push("opened");
  if (status === "closed" && previousStatus !== "closed") {
    kind = timeoutClosed ? "timeout" : (resolutionKind ?? "unknown");
    closedAt = now;
    resolvedAt = kind === "manager" || kind === "customer_csat" ? now : null;
    kinds.push(
      kind === "timeout"
        ? "timeout_closed"
        : resolvedAt
          ? "resolved"
          : "closed_unknown"
    );
  } else if (previousStatus === "closed" && status !== "closed") {
    episodeStartedAt = now;
    closedAt = null;
    resolvedAt = null;
    kind = null;
    timeoutClosed = false;
    kinds.push("reopened");
  } else if (before && status !== previousStatus) kinds.push("status_changed");
  if (handoffActive !== previousHandoffActive)
    kinds.push(handoffActive ? "handoff_started" : "handoff_ended");
  const revision = Math.max(0, before?.service_lifecycle_revision ?? 0) + 1;
  return {
    service_episode_started_at: episodeStartedAt,
    service_closed_at: closedAt,
    service_resolved_at: resolvedAt,
    service_resolution_kind: kind,
    csat_timeout_closed: timeoutClosed,
    service_lifecycle_revision: revision,
    service_lifecycle_event_key: `${after.workspaceId}:${eventId}`,
    service_lifecycle_event: {
      contractVersion: 1,
      eventId,
      revision,
      occurredAt: now,
      workspaceId: after.workspaceId ?? "",
      conversationId: String(after._id),
      customerId: id(after.customerId),
      sourceId: after.sourceId ?? null,
      channel: after.channel ?? null,
      kinds,
      previousStatus,
      status,
      previousHandoffActive,
      handoffActive,
      episodeStartedAt,
      closedAt,
      resolvedAt,
      resolutionKind: kind,
      handoffStartedAt: handoffActive
        ? (date(after.airi_handoff_started_at) ?? now)
        : previousHandoffActive
          ? date(before?.airi_handoff_started_at)
          : null,
    },
  };
}
