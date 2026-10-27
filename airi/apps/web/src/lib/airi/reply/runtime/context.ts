import type { ScenarioTriggerEventKind } from "@icecore/scenario-contracts";
import type { ConversationCustomerLanguageSource } from "@icecore/shared/types/conversation";
import type { Channel } from "@/types/models";
import { airiReplyLogger } from "./reply-logging";
import { readDate } from "@icecore/shared/lib/value-utils";

export const MAX_WIDGET_RAG_CONTEXT_CHARS = 2000;
export const PRE_RUNTIME_CONTEXT_TIMEOUT_MS = 4_000;
const AUTO_REPLY_STAGE_WARN_MS = 8_000;

export type AutoReplyDiagnosticsContext = {
  workspaceId: string;
  conversationId: string;
  messageId: string;
  channel: Channel;
  triggerEventKind?: ScenarioTriggerEventKind;
  quickReplyPayload?: string | null;
};

export type LeanConversationBotState = {
  airi_bot_enabled?: boolean | null;
  airi_scenarios_enabled?: boolean | null;
  airi_enabled?: boolean | null;
  preferred_language?: string | null;
  airi_last_customer_language?: string | null;
  airi_last_customer_language_at?: Date | string | null;
  airi_last_customer_language_source?: ConversationCustomerLanguageSource | null;
  sourceId?: string | null;
  airi_scenario_state?: unknown;
  airi_pending_generative_execution?: unknown;
  airi_handoff_active?: boolean | null;
  airi_handoff_started_at?: Date | string | null;
  airi_handoff_restore_bot_enabled?: boolean | null;
  airi_handoff_source?:
    | "scenario_contains"
    | "scenario_timeout"
    | "manual"
    | null;
  airi_handoff_reason?: string | null;
  airi_last_suppressed_reason?: string | null;
} | null;

export async function runAutoReplyStage<T>(params: {
  label: string;
  diagnostics: AutoReplyDiagnosticsContext;
  meta?: Record<string, unknown>;
  action: () => Promise<T>;
}): Promise<T> {
  const startedAt = Date.now();
  const baseContext = {
    stage: params.label,
    ...params.diagnostics,
    ...(params.meta || {}),
  };

  const warningTimer = setTimeout(() => {
    airiReplyLogger.info("airi.reply.stage", {
      ...baseContext,
      outcome: "slow",
      durationMs: Date.now() - startedAt,
    });
  }, AUTO_REPLY_STAGE_WARN_MS);

  try {
    return await params.action();
  } catch (error) {
    airiReplyLogger.error("airi.reply.stage", error, {
      ...baseContext,
      outcome: "failed",
      durationMs: Date.now() - startedAt,
    });
    throw error;
  } finally {
    clearTimeout(warningTimer);
  }
}

export async function withTimeoutFallback<T>(params: {
  label: string;
  promise: Promise<T>;
  timeoutMs: number;
  fallback: T;
}): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  const timeoutPromise = new Promise<T>(resolve => {
    timer = setTimeout(() => {
      airiReplyLogger.info("airi.reply.timeout_fallback", {
        stage: params.label,
        outcome: "timeout_fallback",
        timeoutMs: params.timeoutMs,
      });
      resolve(params.fallback);
    }, params.timeoutMs);
  });

  try {
    return await Promise.race([params.promise, timeoutPromise]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

export function normalizeDateIso(value: unknown): string | null {
  return readDate(value)?.toISOString() ?? null;
}

export function normalizeWidgetRagContext(value: unknown): string {
  if (typeof value !== "string") return "";

  const normalized = value
    .replace(/\u0000/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (!normalized) return "";
  return normalized.slice(0, MAX_WIDGET_RAG_CONTEXT_CHARS);
}
