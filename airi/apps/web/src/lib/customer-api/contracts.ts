/** Customer-facing capabilities that have production event producers. */
export const CUSTOMER_WEBHOOK_EVENTS = [
  "message.received",
  "message.sent",
  "message.status_updated",
  "conversation.resolved",
  "conversation.reopened",
  "classification.completed",
  "csat.submitted",
  "csat.low",
] as const;

export type CustomerWebhookEvent = (typeof CUSTOMER_WEBHOOK_EVENTS)[number];

export type CustomerApiPermissions = {
  read: boolean;
  write: boolean;
  conversations: boolean;
  analytics: boolean;
};

export type ApiKeySummary = {
  id: string;
  name: string;
  key_prefix: string;
  permissions: CustomerApiPermissions;
  is_active: boolean;
  expires_at: string | null;
  last_used_at: string | null;
  created_at: string;
  rate_limit_per_minute: number;
};

export type WebhookSummary = {
  id: string;
  url: string;
  events: CustomerWebhookEvent[];
  description: string | null;
  is_active: boolean;
  created_at: string;
  last_triggered_at: string | null;
};

export type WebhookDeliverySummary = {
  id: string;
  event_type: string;
  response_status: number | null;
  error_message: string | null;
  attempt_number: number;
  delivered_at: string | null;
  created_at: string;
  next_retry_at: string | null;
};
