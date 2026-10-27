import type { AiriConversationProjection } from "@icecore/temporal";

export type TimerConversationRecord = {
  _id?: unknown;
  workspaceId?: string;
  channel?: string;
  sourceId?: string | null;
  chat?: unknown;
  user?: unknown;
  business_connection_id?: string | null;
  preferred_language?: string | null;
  updatedAt?: Date | string | null;
  external_thread?: {
    provider?: string;
    type?: string;
    threadId?: string;
  } | null;
  airi_context_memory?: {
    currentGoal?: string | null;
    preferredLanguage?: string | null;
  } | null;
  airi_scenario_state?: {
    lockedScenarioId?: string | null;
    lockedScenarioName?: string | null;
    currentActionNodeId?: string | null;
    currentPathNodeIds?: string[] | null;
    currentBranchNodeIds?: string[] | null;
    pendingConditionNodeId?: string | null;
    pendingSourceActionNodeId?: string | null;
    pendingLinkedConditionId?: string | null;
    pendingStartedAt?: Date | string | null;
    pendingLastOutboundMessageId?: string | null;
    /** Shared locations the scenario decided, read through the contracts. */
    routedLocations?: unknown;
  } | null;
  airi_handoff_active?: boolean;
  airi_handoff_source?: string | null;
  airi_handoff_reason?: string | null;
  airi_handoff_started_at?: Date | string | null;
  airi_scenarios_enabled?: boolean | null;
  airi_bot_enabled?: boolean | null;
  airi_enabled?: boolean | null;
};

export type ScenarioRecord = {
  _id?: unknown;
  name?: unknown;
  nodes?: unknown;
  edges?: unknown;
  updatedAt?: Date | string | null;
};

export type TimerContext = {
  conversation: TimerConversationRecord;
  projection: AiriConversationProjection;
};
