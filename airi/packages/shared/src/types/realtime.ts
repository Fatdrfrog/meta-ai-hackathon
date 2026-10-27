import { isRecord } from "../lib/value-utils";

export const REALTIME_EVENT_VERSION = 1 as const;

export const REALTIME_DASHBOARD_CLIENT_CONTRACT_V1 = "dashboard-v1" as const;
export const REALTIME_CLIENT_CONTRACT_HEADER =
  "x-airi-realtime-client-contract" as const;
export const REALTIME_LEGACY_MISSING_CLIENT_CONTRACT =
  "legacy-missing" as const;
export const REALTIME_TOKEN_REFRESH_LEAD_MS = 30_000;
export const REALTIME_CANDIDATE_ACK_DEADLINE_MS = 10_000;
export const REALTIME_ROTATION_PRE_EXPIRY_HEADROOM_MS = 5_000;
export const REALTIME_ROTATION_RETRY_MIN_MS = 7_500;
export const REALTIME_ROTATION_RETRY_MAX_MS = 15_000;

export type RealtimeClientContractTelemetryLabel =
  | typeof REALTIME_DASHBOARD_CLIENT_CONTRACT_V1
  | "requests-v1"
  | typeof REALTIME_LEGACY_MISSING_CLIENT_CONTRACT;

export type RealtimeTokenRefreshPlan =
  | Readonly<{ kind: "scheduled"; delayMs: number }>
  | Readonly<{ kind: "invalid" }>;

export function classifyRealtimeClientContract(
  value: unknown,
): RealtimeClientContractTelemetryLabel {
  if (
    value === REALTIME_DASHBOARD_CLIENT_CONTRACT_V1 ||
    value === "requests-v1"
  ) {
    return value;
  }

  return REALTIME_LEGACY_MISSING_CLIENT_CONTRACT;
}

function parseExactRealtimeExpiry(expiresAt: unknown): number | null {
  if (typeof expiresAt !== "string") return null;
  const expiresAtMs = Date.parse(expiresAt);
  if (
    !Number.isFinite(expiresAtMs) ||
    new Date(expiresAtMs).toISOString() !== expiresAt
  ) {
    return null;
  }
  return expiresAtMs;
}

export function planRealtimeTokenRefresh(
  expiresAt: unknown,
  nowMs: number,
): RealtimeTokenRefreshPlan {
  if (!Number.isFinite(nowMs)) {
    return { kind: "invalid" };
  }

  const expiresAtMs = parseExactRealtimeExpiry(expiresAt);
  if (expiresAtMs === null) return { kind: "invalid" };

  const delayMs = expiresAtMs - nowMs - REALTIME_TOKEN_REFRESH_LEAD_MS;
  if (!Number.isFinite(delayMs)) {
    return { kind: "invalid" };
  }

  return { kind: "scheduled", delayMs: Math.max(0, delayMs) };
}

export function planRealtimeCandidateAckDeadline(
  activeExpiresAt: unknown,
  nowMs: number,
): RealtimeTokenRefreshPlan {
  if (!Number.isFinite(nowMs)) return { kind: "invalid" };
  const activeExpiresAtMs = parseExactRealtimeExpiry(activeExpiresAt);
  if (activeExpiresAtMs === null) return { kind: "invalid" };
  const availableMs =
    activeExpiresAtMs - nowMs - REALTIME_ROTATION_PRE_EXPIRY_HEADROOM_MS;
  if (!Number.isFinite(availableMs)) return { kind: "invalid" };
  return {
    kind: "scheduled",
    delayMs: Math.max(
      0,
      Math.min(REALTIME_CANDIDATE_ACK_DEADLINE_MS, availableMs),
    ),
  };
}

export function planRealtimeRotationRetry(
  activeExpiresAt: unknown,
  nowMs: number,
  jitterUnit: number,
): RealtimeTokenRefreshPlan {
  if (
    !Number.isFinite(nowMs) ||
    !Number.isFinite(jitterUnit) ||
    jitterUnit < 0 ||
    jitterUnit > 1
  ) {
    return { kind: "invalid" };
  }
  const activeExpiresAtMs = parseExactRealtimeExpiry(activeExpiresAt);
  if (activeExpiresAtMs === null) return { kind: "invalid" };
  const availableMs =
    activeExpiresAtMs - nowMs - REALTIME_ROTATION_PRE_EXPIRY_HEADROOM_MS;
  if (!Number.isFinite(availableMs) || availableMs <= 0) {
    return { kind: "invalid" };
  }
  const jitteredDelayMs = Math.floor(
    REALTIME_ROTATION_RETRY_MIN_MS +
      (REALTIME_ROTATION_RETRY_MAX_MS - REALTIME_ROTATION_RETRY_MIN_MS) *
        jitterUnit,
  );
  return {
    kind: "scheduled",
    delayMs: Math.min(availableMs, jitteredDelayMs),
  };
}

export const REALTIME_EVENT_NAMES = [
  "conversation.row.changed",
  "conversation.message.created",
  "conversation.message.updated",
  "conversation.call.updated",
  "conversation.read.changed",
  "conversation.note.changed",
  "airi.typing",
  "airi.suggestion",
  "airi.suppressed",
  "airi.handoff",
  "alert.created",
  "widget.csat.changed",
  "crm.board.changed",
  "campaign.delivery.changed",
] as const;

export * from "./requests-realtime";

export type RealtimeEventName = (typeof REALTIME_EVENT_NAMES)[number];

export type RealtimeEventPayload = Record<string, unknown>;

export type RealtimeEventEnvelope<
  TName extends RealtimeEventName = RealtimeEventName,
  TPayload extends RealtimeEventPayload = RealtimeEventPayload,
> = {
  eventId: string;
  version: typeof REALTIME_EVENT_VERSION;
  name: TName;
  workspaceId: string;
  conversationId?: string | null;
  createdAt: string;
  dedupeKey: string;
  payload: TPayload;
};

export type RealtimeScope =
  | {
      kind: "workspace";
      workspaceId: string;
    }
  | {
      kind: "conversation";
      workspaceId: string;
      conversationId: string;
    };

export type RealtimeClientFrame =
  | {
      type: "subscribe";
      channels: string[];
    }
  | {
      type: "unsubscribe";
      channels: string[];
    }
  | {
      type: "ping";
    };

export type RealtimeServerFrame =
  | {
      type: "ready";
      connectionId: string;
      expiresAt: string;
    }
  | {
      type: "subscribed" | "unsubscribed";
      channels: string[];
    }
  | {
      type: "event";
      channel: string;
      event: RealtimeEventEnvelope;
    }
  | {
      type: "pong";
    }
  | {
      type: "error";
      code: string;
      message: string;
    };

export type RealtimeTokenScope = RealtimeScope & {
  userId?: string | null;
  source?: "dashboard" | "mobile" | "widget";
  clientContract?: string;
};

export type ParsedRealtimeChannel =
  | {
      kind: "workspace";
      workspaceId: string;
      conversationId: null;
    }
  | {
      kind: "conversation";
      workspaceId: string;
      conversationId: string;
    }
  | {
      kind: "unknown";
      workspaceId: null;
      conversationId: null;
    };

const REALTIME_CHANNEL_PATTERN =
  /^(workspace:[A-Za-z0-9_-]+|conversation:[A-Za-z0-9_-]+:[A-Fa-f0-9]{24})$/;
const REALTIME_WORKSPACE_CHANNEL_PATTERN = /^workspace:([A-Za-z0-9_-]+)$/;
const REALTIME_CONVERSATION_CHANNEL_PATTERN =
  /^conversation:([A-Za-z0-9_-]+):([A-Fa-f0-9]{24})$/;

export function isRealtimeEventName(
  value: unknown,
): value is RealtimeEventName {
  return (
    typeof value === "string" &&
    (REALTIME_EVENT_NAMES as readonly string[]).includes(value)
  );
}

export function buildRealtimeChannelName(scope: RealtimeScope): string {
  if (scope.kind === "workspace") {
    return `workspace:${scope.workspaceId}`;
  }

  return `conversation:${scope.workspaceId}:${scope.conversationId}`;
}

export function parseRealtimeChannelName(
  value: unknown,
): ParsedRealtimeChannel {
  if (typeof value !== "string") {
    return { kind: "unknown", workspaceId: null, conversationId: null };
  }

  const workspaceMatch = value.match(REALTIME_WORKSPACE_CHANNEL_PATTERN);
  if (workspaceMatch?.[1]) {
    return {
      kind: "workspace",
      workspaceId: workspaceMatch[1],
      conversationId: null,
    };
  }

  const conversationMatch = value.match(REALTIME_CONVERSATION_CHANNEL_PATTERN);
  if (conversationMatch?.[1] && conversationMatch[2]) {
    return {
      kind: "conversation",
      workspaceId: conversationMatch[1],
      conversationId: conversationMatch[2],
    };
  }

  return { kind: "unknown", workspaceId: null, conversationId: null };
}

export function isRealtimeChannelName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    REALTIME_CHANNEL_PATTERN.test(value) &&
    parseRealtimeChannelName(value).kind !== "unknown"
  );
}

export function buildRealtimeEvent<
  TName extends RealtimeEventName,
  TPayload extends RealtimeEventPayload,
>(
  input: Omit<RealtimeEventEnvelope<TName, TPayload>, "version">,
): RealtimeEventEnvelope<TName, TPayload> {
  return {
    ...input,
    version: REALTIME_EVENT_VERSION,
  };
}

export function isRealtimeEventEnvelope(
  value: unknown,
): value is RealtimeEventEnvelope {
  if (!isRecord(value)) return false;
  return (
    value.version === REALTIME_EVENT_VERSION &&
    typeof value.eventId === "string" &&
    isRealtimeEventName(value.name) &&
    typeof value.workspaceId === "string" &&
    (value.conversationId == null ||
      typeof value.conversationId === "string") &&
    typeof value.createdAt === "string" &&
    typeof value.dedupeKey === "string" &&
    isRecord(value.payload)
  );
}

export function isRealtimeClientFrame(
  value: unknown,
): value is RealtimeClientFrame {
  if (!isRecord(value) || typeof value.type !== "string") return false;

  if (value.type === "ping") return true;

  if (value.type !== "subscribe" && value.type !== "unsubscribe") {
    return false;
  }

  return (
    Array.isArray(value.channels) &&
    value.channels.length > 0 &&
    value.channels.every(isRealtimeChannelName)
  );
}

export function realtimeChannelMatchesScope(
  channel: string,
  scope: RealtimeScope,
): boolean {
  if (!isRealtimeChannelName(channel)) return false;
  if (scope.kind === "workspace") {
    return channel === buildRealtimeChannelName(scope);
  }

  return channel === buildRealtimeChannelName(scope);
}

export function realtimeScopeCanSubscribe(
  channel: string,
  scope: RealtimeScope,
): boolean {
  return realtimeChannelMatchesScope(channel, scope);
}
