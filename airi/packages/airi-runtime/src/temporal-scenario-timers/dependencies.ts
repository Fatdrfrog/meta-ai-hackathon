import type {
  AiriConversationPaymentConfirmedEvent,
  AiriConversationExternalEventResult,
  AiriConversationTimerDescriptor,
  AiriConversationTurnSignal,
} from "@icecore/temporal";
import type { GenerativeAIResultHandlerDependencies } from "./external-events/generative-ai-result";
import type { ScenarioRuntimeDependencies } from "../scenario-runtime-dependencies";
import type { ScenarioOutboundCheckpoint } from "../scenario-state";
import type { ScenarioRecord, TimerConversationRecord } from "./types";

/** Host effects used by timer decisions. Each invocation receives its own host. */
export type AiriScenarioTimerDependencies = Pick<
  ScenarioRuntimeDependencies<unknown>,
  "completeLockedScenarioAndPersist" | "findLatestInboundLocation"
> & {
  connectDB: () => Promise<unknown>;
  loadConversation: (
    conversationId: string,
  ) => Promise<TimerConversationRecord | null>;
  /** The reply runtime's scenario toggle for this conversation, workspace default included. */
  resolveScenariosEnabled: (
    conversation: TimerConversationRecord,
  ) => Promise<boolean>;
  loadScenario: (scope: {
    workspaceId: string;
    scenarioId: string;
  }) => Promise<ScenarioRecord | null>;
  findLatestMessageAfter: (input: {
    conversationId: string;
    after: Date;
  }) => Promise<{ date?: Date | string | null } | null>;
  findTextMessagesAfter: (input: {
    conversationId: string;
    after: Date;
    limit: number;
  }) => Promise<Array<{ text?: unknown }>>;
  findPendingOutbound: (input: {
    messageId: string;
    workspaceId: string;
    conversationId: string;
    scenarioId: string;
    sourceActionNodeId: string | null;
  }) => Promise<ScenarioOutboundCheckpoint | null>;
  buildTimerTurnSignal: (input: {
    timer: AiriConversationTimerDescriptor;
    conversation: TimerConversationRecord;
    channel: string;
    messageId: string;
    followUpInstruction?: string | null;
  }) => Promise<AiriConversationTurnSignal | null>;
  generativeAIResult: GenerativeAIResultHandlerDependencies;
  handleConfirmedPaymentEvent?: (
    event: AiriConversationPaymentConfirmedEvent,
  ) => Promise<AiriConversationExternalEventResult>;
};
