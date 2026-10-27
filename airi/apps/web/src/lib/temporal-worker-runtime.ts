/**
 * Deliberate server-only boundary consumed by the Temporal worker.
 *
 * The worker reaches web-owned persistence (the realtime outbox replay, the
 * Requests projection runtime and the LLM analytics drain at shutdown) through
 * this one module instead of opening another cross-workspace import path.
 */
export { replayRealtimeOutboxBatch } from "@/lib/realtime/outbox-replay";
export { startProductionRequestsProjectionRuntime } from "@/lib/requests-projection/activation";
export { drainPendingLlmAnalyticsEvents } from "@/lib/llm-analytics/events";
