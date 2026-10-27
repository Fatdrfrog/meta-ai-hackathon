export { LANGUAGE_INSTRUCTIONS } from "@/lib/airi/shared/language-policy";

export const WORD_COUNT_THRESHOLD = 5_000;
export const MESSAGE_COUNT_THRESHOLD = 100;
export const RECENT_MESSAGES_WITH_SUMMARY = 10;
export const RECENT_MESSAGES_WITHOUT_SUMMARY = 30;
export const CATEGORY_CHANGE_CONFIDENCE_FLOOR = 0.8;
export const CONVERSATION_CLASSIFICATION_CAPACITY_RECHECK_MS = 15 * 60 * 1000;

export const CLASSIFICATION_OUTPUT_LIMITS = Object.freeze({
  summaryLength: 220,
  actionLength: 220,
  tagCount: 5,
  tagLength: 64,
  entityCount: 20,
  entityValueLength: 256,
  keyMomentCount: 20,
  scorecardCommentLength: 500,
  repairReasonLength: 240,
} as const);
