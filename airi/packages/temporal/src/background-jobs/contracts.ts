export const AIRI_COACH_WORKFLOW = "airiCoachWorkflow";
export const AIRI_COACH_WORKFLOW_CONTRACT_VERSION = 1;
export const AIRI_COACH_ACTIVITY = "airiCoachActivity";

export const WIDGET_CSAT_WORKFLOW = "widgetCsatWorkflow";
export const WIDGET_CSAT_WORKFLOW_CONTRACT_VERSION = 1;
export const WIDGET_CSAT_REQUEST_ACTIVITY = "widgetCsatRequestActivity";
export const WIDGET_CSAT_TIMEOUT_ACTIVITY = "widgetCsatTimeoutActivity";

export const WIDGET_CSAT_REQUEST_DELAY_MS = 5 * 60 * 1000;
export const WIDGET_CSAT_TIMEOUT_DELAY_MS = 24 * 60 * 60 * 1000;

export type AiriCoachJobInput = {
  contractVersion: number;
  workspaceId: string;
  conversationId: string;
  messageId: string;
  agentId?: string | null;
};

export type AiriCoachJobResult = {
  ok: boolean;
  skipped?: boolean;
  reason?: string;
  tipCount?: number;
  suggestionId?: string | null;
};

export type WidgetCsatWorkflowInput = {
  contractVersion: number;
  workspaceId: string;
  conversationId: string;
  startedAt?: string | null;
  requestDelayMs?: number | null;
  timeoutDelayMs?: number | null;
};

export type WidgetCsatActivityInput = {
  contractVersion: number;
  workspaceId: string;
  conversationId: string;
};

export type WidgetCsatActivityResult = {
  ok: boolean;
  skipped?: boolean;
  reason?: string;
  messageId?: string | null;
  forceClosed?: boolean;
};

export type WidgetCsatWorkflowResult = {
  conversationId: string;
  request: WidgetCsatActivityResult;
  timeout: WidgetCsatActivityResult;
};

export function sanitizeBackgroundWorkflowIdPart(value: string): string {
  const sanitized = String(value || "")
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  return sanitized || "unknown";
}

export function buildAiriCoachWorkflowId(params: {
  workspaceId: string;
  conversationId: string;
  messageId: string;
}): string {
  return [
    "airi-coach",
    sanitizeBackgroundWorkflowIdPart(params.workspaceId),
    sanitizeBackgroundWorkflowIdPart(params.conversationId),
    sanitizeBackgroundWorkflowIdPart(params.messageId),
  ].join(":");
}

export function buildWidgetCsatWorkflowId(params: {
  workspaceId: string;
  conversationId: string;
  startedAt?: string | null;
}): string {
  return [
    "widget-csat",
    sanitizeBackgroundWorkflowIdPart(params.workspaceId),
    sanitizeBackgroundWorkflowIdPart(params.conversationId),
    sanitizeBackgroundWorkflowIdPart(params.startedAt || "current"),
  ].join(":");
}
