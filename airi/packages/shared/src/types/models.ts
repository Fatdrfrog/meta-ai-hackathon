/**
 * Shared MongoDB model types
 * These types are used across the codebase for consistency
 */

/**
 * Classification priority levels
 */
export type ClassificationPriority = "low" | "medium" | "high" | "urgent";

/**
 * Classification sentiment
 */
export type ClassificationSentiment = "positive" | "neutral" | "negative";

/**
 * Extracted entity from conversation analysis
 * e.g., 'product', 'competitor', 'price'
 */
export interface ExtractedEntity {
  type: string; // e.g., 'product', 'competitor', 'price'
  value: string; // e.g., 'Алые розы', 'FlowerShop XYZ', '$50'
}

/**
 * Key moment identified in conversation
 * e.g., 'price_inquiry', 'objection', 'upsell_attempt'
 *
 * Note: This type represents the stored format (from MongoDB).
 * - message_ref: MongoDB ObjectId reference to the message (always present in stored data)
 * - message_index: Optional, only present during AI generation (array position before conversion)
 */
export interface KeyMoment {
  type: string; // e.g., 'price_inquiry', 'objection', 'upsell_attempt'
  message_ref: string | { toString(): string }; // Message ObjectId or string (from MongoDB)
  message_index?: number; // Only present during AI generation, not stored in MongoDB
}

/**
 * Interaction metrics calculated from conversation
 */
export interface InteractionMetrics {
  talk_ratio: number; // Соотношение речи (агент/клиент)
  agent_response_time_avg_sec: number | null; // Unknown until a human reply is observed.
  customer_question_count: number; // Количество вопросов от клиента
}

/**
 * Agent performance scorecard from AI analysis
 */
export interface AgentPerformanceScorecard {
  empathy_score: number; // Оценка эмпатии (1-10)
  clarity_score: number; // Оценка ясности ответа (1-10)
  script_adherence_score: number; // Оценка следования скрипту (1-10)
  resolution_efficiency_score: number; // Оценка эффективности решения (1-10)
  overall_comment: string; // Общий комментарий от AI
}
