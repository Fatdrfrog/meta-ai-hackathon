/**
 * Airi conversation helpers: Mongo windows, coach RAG query shaping, daily greeting cache.
 * Reply lead stripping: {@link stripDuplicateGreetingLead} in reply/generation.
 */
export { buildQueryFromConversation } from "./coach-rag-query-from-window";
export { markGreetingSentToday } from "./daily-greeting-cache";
export { hasGreetedToday } from "./has-greeted-today";
export { stripDuplicateGreetingLead } from "@/lib/airi/reply/generation/strip-duplicate-greeting-lead";
export { isGreetingMessage } from "@/lib/airi/shared/greeting-heuristics";
